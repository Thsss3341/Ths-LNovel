import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchText } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { encode } from 'urlencode';

// wenku8 serves GBK-encoded pages from behind Cloudflare, and its ranking and
// search pages require a logged-in account. Requests reuse the cookies of the
// in-app WebView, so users pass the challenge and log in there once.
const ACCESS_HINT =
  '无法访问轻小说文库：请在 WebView 中打开网站，通过 Cloudflare 验证并登录后重试。' +
  '若网页提示 Error 1015（请求过快被限速），请等待几分钟后再试。';

// Cloudflare bans an IP for a while (error 1015) once pages load too fast:
// gaps of 1-2 s trip it after 5-6 requests, while 3 s gaps stay safe
// (measured by pywenku8api). Page requests therefore share a token bucket
// that allows a burst of 2 and then one request every 3 seconds.
const REQUEST_INTERVAL_MS = 3000;
const REQUEST_BURST = 2;

class Wenku8Plugin implements Plugin.PluginBase {
  id = 'wenku8';
  name = '轻小说文库';
  icon = 'src/cn/wenku8/icon.png';
  site = 'https://www.wenku8.net';
  version = '1.0.1';

  imageRequestInit: Plugin.ImageRequestInit = {
    headers: { Referer: 'https://www.wenku8.net/' },
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

  private async fetchPage(url: string): Promise<CheerioAPI> {
    await this.throttle();
    const body = await fetchText(
      url,
      { headers: { Referer: this.site + '/' } },
      'gbk',
    );
    if (!body || body.includes('本站正式关闭')) throw new Error(ACCESS_HINT);
    if (body.includes('两次搜索的间隔时间')) {
      throw new Error('轻小说文库限制两次搜索间隔不少于 5 秒，请稍后再试。');
    }
    // Jieqi CMS error page: "出现错误！ 错误原因：..."
    const error = body.match(/错误原因：([^<]*)/)?.[1]?.trim();
    if (error) {
      throw new Error(error.includes('登录') ? ACCESS_HINT : error);
    }
    return parseHTML(body);
  }

  private coverUrl(aid: string) {
    return `https://img.wenku8.com/image/${Math.floor(Number(aid) / 1000)}/${aid}/${aid}s.jpg`;
  }

  private toHttps(url: string) {
    return url.replace(
      /^http:\/\/(img|pic)\.wenku8\.com/,
      'https://$1.wenku8.com',
    );
  }

  private aidFromPath(path: string) {
    const match = path.match(/\/book\/(\d+)\.htm/);
    if (!match) throw new Error('无效的小说地址: ' + path);
    return match[1];
  }

  /** Parses the novel cards shared by toplist.php and search.php. */
  private parseNovelList($: CheerioAPI, pageNo: number): Plugin.NovelItem[] {
    const pageStats = $('#pagestats').text().split('/');
    const lastPage = parseInt(pageStats[1], 10);
    if (lastPage && pageNo > lastPage) return [];

    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();
    $('#content a[href*="/book/"]').each((_, el) => {
      const link = $(el);
      const aid = link.attr('href')?.match(/\/book\/(\d+)\.htm/)?.[1];
      if (!aid || seen.has(aid)) return;

      const card = link.closest('div[style*="width:373px"], td > div');
      const links = card.length ? card.find('a[href*="/book/"]') : link;
      const name = (
        links.filter('[title]').first().attr('title') ||
        links
          .map((_, a) => $(a).text().trim())
          .get()
          .find(Boolean) ||
        ''
      ).trim();
      if (!name) return;
      const cover = card.find('img').attr('src');

      seen.add(aid);
      novels.push({
        name,
        path: `/book/${aid}.htm`,
        cover: cover ? this.toHttps(cover) : this.coverUrl(aid),
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
    const sort = showLatestNovels ? 'lastupdate' : filters.sort.value;
    const $ = await this.fetchPage(
      `${this.site}/modules/article/toplist.php?sort=${sort}&page=${pageNo}`,
    );
    return this.parseNovelList($, pageNo);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const aid = this.aidFromPath(novelPath);
    const $ = await this.fetchPage(this.site + novelPath);
    return this.parseNovelPage($, novelPath, aid, true);
  }

  private async parseNovelPage(
    $: CheerioAPI,
    novelPath: string,
    aid: string,
    withChapters: boolean,
  ): Promise<Plugin.SourceNovel> {
    const content = $('#content');
    const info: Record<string, string> = {};
    content.find('td').each((_, el) => {
      const match = $(el)
        .text()
        .trim()
        .match(
          /^(文库分类|小说作者|文章状态|最后更新|全文长度)：\s*([\s\S]*)$/,
        );
      if (match) info[match[1]] = match[2].trim();
    });

    const novel: Plugin.SourceNovel = {
      path: novelPath,
      name:
        content.find('table').first().find('span b').first().text().trim() ||
        $('title').text().split(' - ')[0].trim(),
    };

    const cover = content.find('img[src*="/image/"]').attr('src');
    novel.cover = cover ? this.toHttps(cover) : this.coverUrl(aid);
    novel.author = info['小说作者'];

    const status = info['文章状态'] || '';
    if (status.includes('连载')) novel.status = NovelStatus.Ongoing;
    else if (status.includes('完成') || status.includes('完结'))
      novel.status = NovelStatus.Completed;

    const tags = content
      .find('span')
      .filter((_, el) => $(el).text().includes('作品Tags：'))
      .first()
      .text()
      .replace(/^.*作品Tags：/, '')
      .split(/\s+/)
      .filter(Boolean);
    novel.genres = tags.join(',');

    const summaryParts: string[] = [];
    const introSpan = content
      .find('span')
      .filter((_, el) => $(el).text().trim() === '内容简介：')
      .first()
      .nextAll('span')
      .first();
    introSpan.find('br').replaceWith('\n');
    const intro = introSpan
      .text()
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .join('\n');
    if (intro) summaryParts.push(intro);
    if (info['文库分类']) summaryParts.push('文库分类：' + info['文库分类']);
    if (info['全文长度']) summaryParts.push('全文长度：' + info['全文长度']);
    const blocked = $('body').text().includes('因版权问题');
    if (blocked) {
      summaryParts.push('因版权问题，文库不再提供该小说的在线阅读。');
    }
    novel.summary = summaryParts.join('\n\n');

    if (withChapters && !blocked) {
      novel.chapters = await this.parseChapterList(aid);
    }
    return novel;
  }

  private async parseChapterList(aid: string): Promise<Plugin.ChapterItem[]> {
    const dir = `/novel/${Math.floor(Number(aid) / 1000)}/${aid}`;
    const $ = await this.fetchPage(`${this.site}${dir}/index.htm`);

    const chapters: Plugin.ChapterItem[] = [];
    let volume = '';
    $('td.vcss, td.ccss').each((_, el) => {
      const cell = $(el);
      if (cell.hasClass('vcss')) {
        volume = cell.text().trim();
        return;
      }
      const link = cell.find('a');
      const href = link.attr('href');
      const cid =
        href?.match(/cid=(\d+)/)?.[1] || href?.match(/(\d+)\.htm/)?.[1];
      if (!cid) return;
      chapters.push({
        name: link.text().trim(),
        path: `${dir}/${cid}.htm`,
        chapterNumber: chapters.length + 1,
        page: volume || undefined,
      });
    });
    return chapters;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = await this.fetchPage(this.site + chapterPath);
    const content = $('#content');
    if (!content.length) {
      if ($('body').text().includes('因版权问题')) {
        throw new Error('因版权问题，文库不再提供该小说的在线阅读。');
      }
      throw new Error(ACCESS_HINT);
    }

    // Site promo blocks above and below the text.
    content.find('#contentdp, ul').remove();
    // Illustrations link a full-size image around a thumbnail.
    content.find('div.divimage').each((_, el) => {
      const div = $(el);
      const src = div.find('a').attr('href') || div.find('img').attr('src');
      div.replaceWith(src ? `<img src="${this.toHttps(src)}">` : '');
    });

    return content.html() || '';
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    let $: CheerioAPI;
    try {
      $ = await this.fetchPage(
        `${this.site}/modules/article/search.php?searchtype=articlename&searchkey=${encode(searchTerm, 'gbk')}&page=${pageNo}`,
      );
    } catch (e) {
      // "No results" is reported through the site's error page.
      if (e instanceof Error && /没有|找不到|不存在/.test(e.message)) return [];
      throw e;
    }

    // A search with a single match redirects straight to the novel page.
    const isNovelPage =
      $('#content td').filter((_, el) =>
        $(el).text().trim().startsWith('小说作者：'),
      ).length > 0;
    if (isNovelPage) {
      if (pageNo > 1) return [];
      const aid = $('#content')
        .find(
          'a[href*="/novel/"], a[href*="addbookcase.php"], img[src*="/image/"]',
        )
        .map((_, el) => {
          const ref = $(el).attr('href') || $(el).attr('src') || '';
          return (
            ref.match(/\/novel\/\d+\/(\d+)\//)?.[1] ||
            ref.match(/bid=(\d+)/)?.[1] ||
            ref.match(/\/image\/\d+\/(\d+)\//)?.[1]
          );
        })
        .get()[0];
      if (!aid) return [];
      const novelPath = `/book/${aid}.htm`;
      const novel = await this.parseNovelPage($, novelPath, aid, false);
      return [{ name: novel.name, path: novelPath, cover: novel.cover }];
    }

    return this.parseNovelList($, pageNo);
  }

  resolveUrl = (path: string) => this.site + path;

  filters = {
    sort: {
      label: '排行榜',
      value: 'allvisit',
      options: [
        { label: '总排行榜', value: 'allvisit' },
        { label: '总推荐榜', value: 'allvote' },
        { label: '月排行榜', value: 'monthvisit' },
        { label: '月推荐榜', value: 'monthvote' },
        { label: '周排行榜', value: 'weekvisit' },
        { label: '周推荐榜', value: 'weekvote' },
        { label: '日排行榜', value: 'dayvisit' },
        { label: '日推荐榜', value: 'dayvote' },
        { label: '总收藏榜', value: 'goodnum' },
        { label: '字数排行', value: 'size' },
        { label: '最新入库', value: 'postdate' },
        { label: '最近更新', value: 'lastupdate' },
        { label: '完结小说', value: 'fullflag' },
        { label: '动画化作品', value: 'anime' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new Wenku8Plugin();
