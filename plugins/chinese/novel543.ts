import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

// 小說543 / 稷下書院 (novel543.com), a web novel site in Traditional Chinese.
// A rewrite of the community repository's Novel543 plugin. The site sits
// behind Cloudflare; requests reuse the in-app WebView's cookies, so the
// challenge is passed by opening the site there.
const CHALLENGE_HINT =
  'Cloudflare 驗證已過期：請在 WebView 中打開小說543，通過驗證後返回重試。';
const MISSING_HINT = '小說543 暫時沒有這一章的內容（章節錯誤），請稍後再試。';
// Chapters are split into pages of a few thousand characters.
const MAX_CHAPTER_PAGES = 20;
// Lines the site mixes into chapter text.
const BOILERPLATE =
  /請記住本站域名|手機版閱讀網址|novel543|稷下書院|最快更新|章節報錯|溫馨提示/i;

class Novel543Plugin implements Plugin.PluginBase {
  id = 'novel543_ths';
  name = '小說543';
  icon = 'src/cn/novel543_ths/icon.png';
  site = 'https://www.novel543.com';
  version = '1.0.0';

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: { Referer: 'https://www.novel543.com/' },
  };

  private async fetchPage(path: string): Promise<CheerioAPI> {
    const res = await fetchApi(this.site + path, {
      headers: { Referer: this.site + '/' },
    });
    if (res.headers.get('cf-mitigated') === 'challenge') {
      throw new Error(CHALLENGE_HINT);
    }
    const html = await res.text();
    if (
      (res.status === 403 || res.status === 503) &&
      /challenge-platform|請稍候|Just a moment/.test(html)
    ) {
      throw new Error(CHALLENGE_HINT);
    }
    if (!res.ok) {
      throw new Error(
        `無法訪問小說543（HTTP ${res.status}）：${this.site + path}`,
      );
    }
    return parseHTML(html);
  }

  private parseNovelList($: CheerioAPI): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    const seen: Record<string, boolean> = {};
    $('li.media').each((_, el) => {
      const item = $(el);
      const link = item.find('h3 a').first();
      const path = link.attr('href');
      const name = link.text().trim();
      if (!path || !/^\/\d+\/$/.test(path) || !name || seen[path]) return;
      seen[path] = true;
      novels.push({
        name,
        path,
        cover: item.find('.media-left img').attr('src') || defaultCover,
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
    const category = showLatestNovels ? 'all' : filters.category.value;
    // The home page's lists have no further pages.
    if (category === 'home') {
      return pageNo > 1 ? [] : this.parseNovelList(await this.fetchPage('/'));
    }
    const query = [`page=${pageNo}`];
    if (!showLatestNovels && filters.status.value) {
      query.push('end=' + filters.status.value);
    }
    if (!showLatestNovels && filters.gender.value) {
      query.push('gender=' + filters.gender.value);
    }
    const base = category === 'all' ? '/bookstack/' : `/bookstack/${category}/`;
    return this.parseNovelList(
      await this.fetchPage(`${base}?${query.join('&')}`),
    );
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = await this.fetchPage(novelPath);
    const info = $('#detail .info');
    // The tablet layout repeats the intro under a 簡介 heading.
    $('div.intro .header').remove();
    const intro = $('div.intro')
      .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
      .toArray()
      .sort((a, b) => b.length - a.length)[0];
    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: info.find('h1.title').text().trim(),
      cover: $('#detail .cover img').attr('src') || defaultCover,
      author: info.find('span.author').text().trim() || undefined,
      summary: intro,
      genres:
        info
          .find('p.meta a[href^="/bookstack/"]')
          .map((_, el) => $(el).text().trim())
          .toArray()
          .join(',') || undefined,
      status: NovelStatus.Unknown,
      chapters: [],
    };

    const list = await this.fetchPage(novelPath + 'dir');
    const chapters: Plugin.ChapterItem[] = [];
    const seen: Record<string, boolean> = {};
    // ul.all is the full list; the other list repeats the latest chapters.
    list('div.chaplist ul.all li a').each((_, el) => {
      const path = list(el).attr('href');
      const number = Number(path?.match(/_(\d+)\.html$/)?.[1]);
      if (!path || !number || seen[path]) return;
      seen[path] = true;
      chapters.push({
        name: list(el).text().trim(),
        path,
        chapterNumber: number,
      });
    });
    chapters.sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));
    novel.chapters = chapters;
    return novel;
  }

  /** The chapter text of one page as paragraphs. */
  private pageParagraphs($: CheerioAPI): string[] {
    const content = $('div.content').first();
    content
      .find('script, style, ins, iframe, .gadBlock, .adBlock, [class*="ads"]')
      .remove();
    // Some chapters have a <p> per paragraph, others one <p> with <br>s.
    const html = (content.html() || '')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
      .replace(/(<br\s*\/?>\s*)+/gi, '\n');
    return parseHTML(`<div>${html}</div>`)
      .root()
      .text()
      .split('\n')
      .map(line => line.replace(/^[\s\u00a0\u3000]+|[\s\u00a0\u3000]+$/g, ''))
      .filter(line => line && !BOILERPLATE.test(line));
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const base = chapterPath.replace(/\.html$/, '');
    const paragraphs: string[] = [];
    let page: string | undefined = chapterPath;
    for (let i = 0; page && i < MAX_CHAPTER_PAGES; i++) {
      const $ = await this.fetchPage(page);
      if ($('title').text().includes('章節錯誤')) {
        if (i === 0) throw new Error(MISSING_HINT);
        break;
      }
      paragraphs.push(...this.pageParagraphs($));
      // The next page of the same chapter is <chapter>_<n>.html.
      page = $('a[href]')
        .map((_, el) => $(el).attr('href') || '')
        .toArray()
        .find(href => href === `${base}_${i + 2}.html`);
    }
    if (!paragraphs.length) throw new Error(MISSING_HINT);
    const escape = (text: string) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return paragraphs.map(line => `<p>${escape(line)}</p>`).join('\n');
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1) return [];
    const term = searchTerm.trim();
    // A novel's URL or ID opens that novel.
    const id =
      term.match(/novel543\.com\/(\d+)/)?.[1] || term.match(/^\d{10}$/)?.[0];
    if (id) {
      const path = `/${id}/`;
      const novel = await this.parseNovel(path);
      return [{ name: novel.name, path, cover: novel.cover }];
    }
    return this.parseNovelList(
      await this.fetchPage('/search/' + encodeURIComponent(term)),
    );
  }

  resolveUrl(path: string): string {
    return this.site + path;
  }

  filters = {
    category: {
      label: '分類',
      value: 'home',
      options: [
        { label: '首頁推薦', value: 'home' },
        { label: '全部（書庫）', value: 'all' },
        { label: '玄幻', value: 'xuanhuan' },
        { label: '修真', value: 'xiuzhen' },
        { label: '都市', value: 'dushi' },
        { label: '穿越', value: 'chuanyue' },
        { label: '網遊', value: 'wangyou' },
        { label: '科幻', value: 'kehuan' },
        { label: '靈異', value: 'lingyi' },
        { label: '懸疑', value: 'xuanyi' },
        { label: '歷史', value: 'lishi' },
        { label: '軍事', value: 'junshi' },
        { label: '同人', value: 'tongren' },
        { label: '女頻', value: 'nvpin' },
        { label: '其它', value: 'other' },
      ],
      type: FilterTypes.Picker,
    },
    // These apply to the 書庫 categories, not to 首頁推薦.
    status: {
      label: '狀態',
      value: '',
      options: [
        { label: '全部', value: '' },
        { label: '連載', value: '1' },
        { label: '完結', value: '2' },
      ],
      type: FilterTypes.Picker,
    },
    gender: {
      label: '頻道',
      value: '',
      options: [
        { label: '全部', value: '' },
        { label: '男生', value: 'boy' },
        { label: '女生', value: 'girl' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new Novel543Plugin();
