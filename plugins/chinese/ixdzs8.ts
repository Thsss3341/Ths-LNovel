import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

// 爱下电子书 (ixdzs8.com), a web novel site that carries most 起点 titles.
// A rewrite of the community repository's ixdzs8 plugin.

// Chapter pages first answer with a short "正在进行安全验证" page holding a
// token; requesting the page with ?challenge=<token> sets a session cookie and
// redirects back to the chapter.
const CHALLENGE_MARK = '正在進行安全驗證';
const CHALLENGE_HINT =
  '爱下电子书的安全验证没有通过：请在 WebView 中打开该章节，返回后重试。';
const RETRIES = 2;
// Shown for chapters the site hasn't filled in yet. Reported as an error so
// the app doesn't keep the placeholder as the chapter.
const PLACEHOLDER_MARK = '手打中';
const PLACEHOLDER_HINT = '爱下电子书还没有这一章的内容（手打中），请稍后再试。';

type ChapterListJson = {
  rs: number;
  data?: { ctype: string; ordernum: string; title: string }[];
};

class Ixdzs8Plugin implements Plugin.PluginBase {
  id = 'ixdzs8_ths';
  name = '爱下电子书';
  icon = 'src/cn/ixdzs8_ths/icon.png';
  site = 'https://ixdzs8.com';
  version = '1.0.0';

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: { Referer: 'https://ixdzs8.com/' },
  };

  /** The site's session cookie, for clients without a cookie store. */
  private sessionCookie = '';

  private headers(extra?: Record<string, string>) {
    const headers: Record<string, string> = {
      Referer: this.site + '/',
      ...extra,
    };
    if (this.sessionCookie) headers.Cookie = this.sessionCookie;
    return headers;
  }

  private async request(url: string, init?: Parameters<typeof fetchApi>[1]) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchApi(url, init);
        if (res.status < 500 || attempt >= RETRIES) return res;
      } catch (error) {
        if (attempt >= RETRIES) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }

  private async fetchText(path: string): Promise<string> {
    const url = this.site + path;
    const res = await this.request(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`无法访问爱下电子书（HTTP ${res.status}）：${url}`);
    }
    const html = await res.text();
    if (!html.includes(CHALLENGE_MARK)) return html;
    return this.passChallenge(url, html);
  }

  private async passChallenge(url: string, page: string): Promise<string> {
    const token = page.match(/let token\s*=\s*"([^"]+)"/)?.[1];
    if (!token) throw new Error(CHALLENGE_HINT);
    const challenge =
      url + (url.includes('?') ? '&' : '?') + 'challenge=' + token;
    // Without following the redirect, the session cookie can be read and sent
    // along (the live checker has no cookie store); the app's own cookie store
    // keeps it either way.
    const res = await this.request(challenge, {
      headers: this.headers(),
      redirect: 'manual',
    });
    const cookie = (res.headers.get('set-cookie') || '').match(
      /PHPSESSID=[^;]+/,
    )?.[0];
    if (cookie) this.sessionCookie = cookie;
    let html = res.status >= 300 && res.status < 400 ? '' : await res.text();
    if (!html || html.includes(CHALLENGE_MARK)) {
      const again = await this.request(url, { headers: this.headers() });
      html = await again.text();
    }
    if (html.includes(CHALLENGE_MARK)) throw new Error(CHALLENGE_HINT);
    return html;
  }

  private parseNovelList($: CheerioAPI): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    $('li.burl').each((_, el) => {
      const item = $(el);
      const link = item.find('h3 a').first();
      const path = item.attr('data-url') || link.attr('href');
      const name = (link.attr('title') || link.text()).trim();
      if (!path || !/^\/read\/\d+\/$/.test(path) || !name) return;
      const img = item.find('.l-img img');
      novels.push({
        name,
        path,
        cover: img.attr('data-src') || img.attr('src') || defaultCover,
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
    if (showLatestNovels) {
      return this.parseNovelList(
        parseHTML(await this.fetchText(`/new/?page=${pageNo}`)),
      );
    }
    const category = filters.category.value;
    if (category === 'all') {
      return this.parseNovelList(
        parseHTML(
          await this.fetchText(`/${filters.list.value}/?page=${pageNo}`),
        ),
      );
    }
    // index-{words}-{status}-{order}-{page}.html
    const path = `/sort/${category}/index-${filters.words.value}-${filters.status.value}-${filters.order.value}-${pageNo}.html`;
    return this.parseNovelList(parseHTML(await this.fetchText(path)));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = parseHTML(await this.fetchText(novelPath));
    const info = $('div.novel');

    const intro = $('#intro').clone();
    intro.find('span.icon').remove();
    intro.find('br').replaceWith('\n');
    const summary = intro
      .text()
      .split('\n')
      .map(line => line.replace(/\u3000/g, ' ').trim())
      .filter(Boolean)
      .join('\n');

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name: info.find('.n-text h1').text().trim(),
      cover: info.find('.n-img img').attr('src') || defaultCover,
      author: info.find('a.bauthor').text().trim() || undefined,
      summary,
      genres: $('div.tags em a')
        .map((_, el) => $(el).text().trim())
        .toArray()
        .filter(Boolean)
        .join(','),
      status: info.find('.n-text span.end').length
        ? NovelStatus.Completed
        : info.find('.n-text span.lz').length
          ? NovelStatus.Ongoing
          : NovelStatus.Unknown,
      chapters: [],
    };

    const bid = $('#bid').attr('value') || novelPath.match(/\d+/)?.[0];
    if (bid) novel.chapters = await this.parseChapterList(bid);
    return novel;
  }

  private async parseChapterList(bid: string): Promise<Plugin.ChapterItem[]> {
    const res = await this.request(this.site + '/novel/clist/', {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
      body: 'bid=' + bid,
    });
    if (!res.ok) throw new Error(`无法读取目录（HTTP ${res.status}）`);
    const json: ChapterListJson = await res.json();
    if (json.rs !== 200 || !Array.isArray(json.data)) {
      throw new Error('无法读取目录：爱下电子书返回了意外的内容。');
    }
    const chapters: Plugin.ChapterItem[] = [];
    let volume = '';
    json.data.forEach(item => {
      // Entries of another type are volume headings.
      if (item.ctype !== '0') {
        volume = item.title.trim();
        return;
      }
      chapters.push({
        name: item.title.trim(),
        path: `/read/${bid}/p${item.ordernum}.html`,
        chapterNumber: Number(item.ordernum) || undefined,
        page: volume || undefined,
      });
    });
    // A single group only hides the list behind a pointless page picker.
    if (new Set(chapters.map(chapter => chapter.page)).size < 2) {
      chapters.forEach(chapter => delete chapter.page);
    }
    return chapters;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = parseHTML(await this.fetchText(chapterPath));
    const content = $('article.page-content section').first();
    if (!content.length) {
      throw new Error('找不到章节内容：请在 WebView 中打开该章节检查。');
    }
    content
      .find(
        'script, style, ins, iframe, [class*="ads"], [id*="ads"], [class*="abg"], div[align="center"]',
      )
      .remove();
    content.find('p').each((_, el) => {
      if (!$(el).text().trim() && !$(el).find('img').length) $(el).remove();
    });
    const text = content.text().trim();
    if (text.length < 40 && text.includes(PLACEHOLDER_MARK)) {
      throw new Error(PLACEHOLDER_HINT);
    }
    return (content.html() || '').trim();
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // Past the last page the site returns an empty list.
    const html = await this.fetchText(
      `/bsearch?q=${encodeURIComponent(searchTerm.trim())}&page=${pageNo}`,
    );
    return this.parseNovelList(parseHTML(html));
  }

  resolveUrl(path: string): string {
    return this.site + path;
  }

  filters = {
    list: {
      label: '榜单',
      value: 'hot',
      options: [
        { label: '热门排行', value: 'hot' },
        { label: '全本完结', value: 'end' },
        { label: '最近更新', value: 'new' },
      ],
      type: FilterTypes.Picker,
    },
    // A category replaces the list above and takes the filters below.
    category: {
      label: '分类',
      value: 'all',
      options: [
        { label: '不限（按榜单）', value: 'all' },
        { label: '玄幻奇幻', value: '1' },
        { label: '修真仙侠', value: '2' },
        { label: '都市青春', value: '3' },
        { label: '军事历史', value: '4' },
        { label: '网游竞技', value: '5' },
        { label: '科幻灵异', value: '6' },
        { label: '言情穿越', value: '7' },
        { label: '耽美同人', value: '8' },
        { label: '台言古言', value: '9' },
        { label: '武侠小说', value: '10' },
        { label: '其他小说', value: '0' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      label: '状态（分类）',
      value: '0',
      options: [
        { label: '全部', value: '0' },
        { label: '连载中', value: '1' },
        { label: '已完结', value: '2' },
      ],
      type: FilterTypes.Picker,
    },
    order: {
      label: '排序（分类）',
      value: '0',
      options: [
        { label: '最新', value: '0' },
        { label: '最热', value: '1' },
      ],
      type: FilterTypes.Picker,
    },
    words: {
      label: '字数（分类）',
      value: '0',
      options: [
        { label: '全部', value: '0' },
        { label: '30万字以下', value: '1' },
        { label: '30-50万字', value: '2' },
        { label: '50-100万字', value: '3' },
        { label: '100万字以上', value: '4' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new Ixdzs8Plugin();
