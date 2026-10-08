import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { storage } from '@libs/storage';

// 嗶哩輕小說 (tw.linovelib.com), the Traditional Chinese edition of linovelib.
// The site sits behind Cloudflare. Requests reuse the in-app WebView's cookies,
// so a challenge is passed by opening the site there.
const CHALLENGE_HINT =
  'Cloudflare 驗證已過期：請在 WebView 中打開嗶哩輕小說（通常會自動通過驗證），返回後重試。';
// Clients the site takes for bots get a shortened chapter that ends with this note.
const TRUNCATED_MARK = '內容加載失敗';
const TRUNCATED_HINT =
  '嗶哩輕小說只回傳了部分章節內容：請在 WebView 中打開網站首頁，返回後重試。';
const SEARCH_HINT =
  '嗶哩輕小說已關閉站內搜尋。請輸入小說網址或編號，例如 https://tw.linovelib.com/novel/3095.html 或 3095。';

// No rate limit is documented. A small token bucket keeps chapter downloads,
// which fetch several pages per chapter, from bursting.
const REQUEST_INTERVAL_MS = 1000;
const REQUEST_BURST = 3;
// Chapters are split into pages of about 1,000 characters.
const MAX_CHAPTER_PAGES = 100;

// A chapter link the catalog hides behind javascript:cid() is stored as the
// path of the chapter before it plus this suffix, once per hidden chapter in a
// row. parseChapter follows the site's own "next chapter" link to find it.
const NEXT_SUFFIX = '#next';
const NEXT_CACHE_PREFIX = 'next:';

// The site shuffles every paragraph after the 20th and its chapterlog.js puts
// them back in the browser. This is that script's permutation: a Fisher-Yates
// shuffle driven by a linear congruential generator seeded with the chapter
// ID. Both linovelib editions use the same constants (checked October 2026).
const FIXED_PARAGRAPHS = 20;
const shuffledOrder = (count: number, chapterId: number) => {
  const order: number[] = [];
  for (let i = 0; i < count; i++) order.push(i);
  if (count <= FIXED_PARAGRAPHS) return order;
  const rest = order.slice(FIXED_PARAGRAPHS);
  let seed = chapterId * 126 + 232;
  for (let i = rest.length - 1; i > 0; i--) {
    seed = (seed * 9302 + 49397) % 233280;
    const j = Math.floor((seed / 233280) * (i + 1));
    const swap = rest[i];
    rest[i] = rest[j];
    rest[j] = swap;
  }
  return order.slice(0, FIXED_PARAGRAPHS).concat(rest);
};

type ReadParams = { chapterId: number; next: string };

class LinovelibTwPlugin implements Plugin.PluginBase {
  id = 'linovelib_tw_ths';
  name = '嗶哩輕小說(繁體)';
  icon = 'src/cn/linovelib_tw_ths/icon.png';
  site = 'https://tw.linovelib.com';
  version = '1.0.0';

  // Illustrations on img3.readpai.com answer 403 without a linovelib Referer.
  imageRequestInit: Plugin.ImageRequestInit = {
    headers: { Referer: 'https://tw.linovelib.com/' },
  };

  private tokens = REQUEST_BURST;
  private lastRefill = Date.now();
  private queue: Promise<void> = Promise.resolve();

  /** Resolves when the next page request may be sent, in call order. */
  private throttle(): Promise<void> {
    const turn = this.queue.then(async () => {
      const now = Date.now();
      this.tokens = Math.min(
        REQUEST_BURST,
        this.tokens + (now - this.lastRefill) / REQUEST_INTERVAL_MS,
      );
      this.lastRefill = now;
      if (this.tokens < 1) {
        const wait = (1 - this.tokens) * REQUEST_INTERVAL_MS;
        await new Promise(resolve => setTimeout(resolve, wait));
        this.tokens = 1;
        this.lastRefill = Date.now();
      }
      this.tokens -= 1;
    });
    this.queue = turn;
    return turn;
  }

  private async fetchPage(path: string): Promise<CheerioAPI> {
    await this.throttle();
    const res = await fetchApi(this.site + path, {
      headers: { Referer: this.site + '/' },
    });
    if (res.headers.get('cf-mitigated') === 'challenge') {
      throw new Error(CHALLENGE_HINT);
    }
    if (!res.ok) {
      throw new Error(
        `無法訪問嗶哩輕小說（HTTP ${res.status}）：請在 WebView 中打開網站檢查。`,
      );
    }
    return parseHTML(await res.text());
  }

  private parseNovelList($: CheerioAPI) {
    const novels: Plugin.NovelItem[] = [];
    $('.book-layout').each((_, el) => {
      const path = $(el).attr('href');
      if (!path || !/^\/novel\/\d+\.html$/.test(path)) return;
      const img = $(el).find('.book-cover img');
      novels.push({
        name: $(el).find('.book-title').text().trim(),
        path,
        cover: img.attr('data-src') || img.attr('src'),
      });
    });
    return novels;
  }

  async popularNovels(
    pageNo: number,
    {
      showLatestNovels,
      filters,
    }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const rank = showLatestNovels ? 'lastupdate' : filters.rank.value;
    const $ = await this.fetchPage(`/top/${rank}/${pageNo}.html`);
    return this.parseNovelList($);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = await this.fetchPage(novelPath);
    const detail = $('#bookDetailWrapper');

    const summary = $('#bookSummary content').clone();
    summary.find('br').replaceWith('\n');
    const lines = summary
      .text()
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    const alias = $('#bookSummary .bkname-body').text().trim();
    if (alias) lines.push('', '別名：' + alias);

    const meta = detail.find('.book-meta').text();
    const illustrator = detail.find('.illname a').clone();
    illustrator.find('rt').remove();

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: detail.find('.book-title').first().text().trim(),
      cover: detail.find('img.book-cover').attr('src'),
      author: detail.find('.authorname a').text().trim() || undefined,
      artist: illustrator.text().trim() || undefined,
      status: meta.includes('完結')
        ? NovelStatus.Completed
        : meta.includes('連載')
          ? NovelStatus.Ongoing
          : NovelStatus.Unknown,
      genres: detail
        .find('.tag-small.red a')
        .map((_, el) => $(el).text().trim())
        .toArray()
        .join(','),
      summary: lines.join('\n'),
      chapters: [],
    };

    const catalogPath =
      $('#btnReadBook').attr('href') ||
      novelPath.replace(/\.html$/, '/catalog');
    novel.chapters = this.parseChapterList(await this.fetchPage(catalogPath));
    return novel;
  }

  private parseChapterList($: CheerioAPI) {
    const chapters: Plugin.ChapterItem[] = [];
    let volume = '';
    let previous = '';
    $('#volumes li.chapter-li').each((_, el) => {
      const item = $(el);
      if (item.hasClass('chapter-bar')) {
        volume = item.text().trim();
        return;
      }
      if (item.hasClass('volume-cover')) return;
      const href = item.find('a.chapter-li-a').attr('href') || '';
      let path = href.match(/^\/novel\/\d+\/\d+\.html$/)?.[0];
      // Hidden link (javascript:cid(...)): reached through the previous chapter.
      if (!path && previous) path = previous + NEXT_SUFFIX;
      if (!path) return;
      previous = path;
      chapters.push({
        name: item.find('.chapter-index').text().trim(),
        path,
        page: volume,
      });
    });
    // Nekori and LNReader group chapters by `page`; a single group only hides
    // the list behind a pointless page picker.
    if (new Set(chapters.map(chapter => chapter.page)).size < 2) {
      chapters.forEach(chapter => delete chapter.page);
    }
    return chapters;
  }

  private readParams($: CheerioAPI): ReadParams {
    const script = $('script')
      .map((_, el) => $(el).html() || '')
      .toArray()
      .find(text => text.includes('ReadParams'));
    const chapterId = Number(script?.match(/chapterid:'(\d+)'/)?.[1]);
    if (!script || !chapterId) {
      throw new Error('無法讀取章節：請在 WebView 中打開該章節檢查。');
    }
    return { chapterId, next: script.match(/url_next:'([^']*)'/)?.[1] || '' };
  }

  /** The URL of the page after `params`' page if it belongs to the same chapter. */
  private nextPageOf(params: ReadParams) {
    const samePage = new RegExp('/' + params.chapterId + '_\\d+\\.html$');
    return samePage.test(params.next) ? params.next : undefined;
  }

  /** Turns a hidden chapter's path into the real one (see NEXT_SUFFIX). */
  private async resolvePath(path: string): Promise<string> {
    if (!path.endsWith(NEXT_SUFFIX)) return path;
    const cached: unknown = storage.get(NEXT_CACHE_PREFIX + path);
    if (typeof cached === 'string' && cached) return cached;
    let page = await this.resolvePath(path.slice(0, -NEXT_SUFFIX.length));
    for (let i = 0; i < MAX_CHAPTER_PAGES; i++) {
      const params = this.readParams(await this.fetchPage(page));
      const next = this.nextPageOf(params);
      if (next) {
        page = next;
        continue;
      }
      if (!/^\/novel\/\d+\/\d+\.html$/.test(params.next)) break;
      storage.set(NEXT_CACHE_PREFIX + path, params.next);
      return params.next;
    }
    throw new Error('找不到該章節：請在 WebView 中從目錄打開該章節檢查。');
  }

  /** The page's paragraphs in reading order, cleaned of ads and site notes. */
  private pageContent($: CheerioAPI, chapterId: number) {
    const content = $('#acontent');
    content.find('.cgo, center, script, ins').remove();
    content.find('img').each((_, el) => {
      const img = $(el);
      const src = img.attr('data-src') || img.attr('src');
      if (src) img.attr('src', src.replace(/^\/\//, 'https://'));
      img.removeAttr('data-src').removeClass('lazyload');
    });

    // Mirrors chapterlog.js: only non-empty <p> children take part.
    const nodes = content.contents().toArray();
    type ContentNode = (typeof nodes)[number];
    const isParagraph = (node: ContentNode) =>
      node.type === 'tag' &&
      node.name === 'p' &&
      ($(node).html() || '').replace(/\s+/g, '').length > 0;
    const paragraphs = nodes.filter(isParagraph);
    const order = shuffledOrder(paragraphs.length, chapterId);
    const restored: ContentNode[] = [];
    paragraphs.forEach((node, i) => {
      restored[order[i]] = node;
    });
    let next = 0;
    return nodes
      .map(node => $.html(isParagraph(node) ? restored[next++] : node))
      .join('');
  }

  async parseChapter(chapterPath: string): Promise<string> {
    let page: string | undefined = await this.resolvePath(chapterPath);
    let html = '';
    for (let i = 0; page && i < MAX_CHAPTER_PAGES; i++) {
      const $ = await this.fetchPage(page);
      if ($('#acontent').text().includes(TRUNCATED_MARK)) {
        throw new Error(TRUNCATED_HINT);
      }
      const params = this.readParams($);
      html += this.pageContent($, params.chapterId);
      page = this.nextPageOf(params);
    }
    return html;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const id = searchTerm.trim().match(/(?:novel\/)?(\d+)(?:\.html|\/|$)/)?.[1];
    if (!id) throw new Error(SEARCH_HINT);
    const path = `/novel/${id}.html`;
    const $ = await this.fetchPage(path);
    const name = $('#bookDetailWrapper .book-title').first().text().trim();
    if (!name) return [];
    return [
      {
        name,
        path,
        cover: $('#bookDetailWrapper img.book-cover').attr('src'),
      },
    ];
  }

  resolveUrl(path: string): string {
    return this.site + path.replace(/(#next)+$/, '');
  }

  filters = {
    rank: {
      label: '排行榜',
      value: 'monthvisit',
      options: [
        { label: '月點擊榜', value: 'monthvisit' },
        { label: '周點擊榜', value: 'weekvisit' },
        { label: '月推薦榜', value: 'monthvote' },
        { label: '周推薦榜', value: 'weekvote' },
        { label: '月鮮花榜', value: 'monthflower' },
        { label: '周鮮花榜', value: 'weekflower' },
        { label: '月雞蛋榜', value: 'monthegg' },
        { label: '周雞蛋榜', value: 'weekegg' },
        { label: '最近更新', value: 'lastupdate' },
        { label: '最新入庫', value: 'postdate' },
        { label: '收藏榜', value: 'goodnum' },
        { label: '新書榜', value: 'newhot' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new LinovelibTwPlugin();
