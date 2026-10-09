import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

// 全本小说网 (quanben.io), a web novel site. A rewrite of the community
// repository's Quanben plugin, which read chapter lists from a mirror that
// lacks some novels.

// The site resets a fair share of connections, so requests are retried.
const RETRIES = 3;

// list.html shows the first and last chapters; its 展开完整列表 button loads
// the rest from list.jsonp, whose `b` parameter is the callback name run
// through this character shuffle (the site's own "base64" function).
const SHUFFLE_CHARS =
  'PXhw7UT1B0a9kQDKZsjIASmOezxYG4CHo5Jyfg2b8FLpEvRr3WtVnlqMidu6cN';
const shuffle = (text: string) => {
  let encoded = '';
  for (let i = 0; i < text.length; i++) {
    const index = SHUFFLE_CHARS.indexOf(text.charAt(i));
    const char = index < 0 ? text.charAt(i) : SHUFFLE_CHARS[(index + 3) % 62];
    const pad = () => SHUFFLE_CHARS[Math.floor(Math.random() * 62)];
    encoded += pad() + char + pad();
  }
  return encoded;
};

class QuanbenPlugin implements Plugin.PluginBase {
  id = 'quanben_ths';
  name = '全本小说网';
  icon = 'src/cn/quanben_ths/icon.png';
  site = 'https://www.quanben.io';
  version = '1.0.0';

  private async fetchText(path: string, referer = '/'): Promise<string> {
    const url = this.site + path;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchApi(url, {
          headers: { Referer: this.site + referer },
        });
        if (res.ok) return await res.text();
        if (res.status < 500 || attempt >= RETRIES) {
          throw new Error(`无法访问全本小说网（HTTP ${res.status}）：${url}`);
        }
      } catch (error) {
        if (attempt >= RETRIES) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }

  private parseNovelList($: CheerioAPI): Plugin.NovelItem[] {
    const novels: Plugin.NovelItem[] = [];
    $('div.list2').each((_, el) => {
      const item = $(el);
      const link = item.find('h3 a').first();
      const path = link.attr('href')?.match(/^(?:\/amp)?(\/n\/[^/]+\/)$/)?.[1];
      const name = link.text().trim();
      if (!path || !name) return;
      const img = item.find('img');
      novels.push({
        name,
        path,
        cover: img.attr('src') || img.attr('data-src') || defaultCover,
      });
    });
    return novels;
  }

  async popularNovels(
    pageNo: number,
    { filters }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    const genre = filters.genre.value;
    // The home page has no further pages.
    if (genre === 'all') {
      return pageNo > 1
        ? []
        : this.parseNovelList(parseHTML(await this.fetchText('/')));
    }
    const path = pageNo > 1 ? `/c/${genre}_${pageNo}.html` : `/c/${genre}.html`;
    return this.parseNovelList(parseHTML(await this.fetchText(path)));
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const $ = parseHTML(await this.fetchText(novelPath));
    const meta = (property: string) =>
      $(`meta[property="${property}"]`).attr('content')?.trim() || '';
    const info = $('div.list2').first();

    const description = $('div.description').first().clone();
    description.find('br').replaceWith('\n');
    const summary =
      description
        .text()
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n') || meta('og:description');

    const status = meta('og:novel:status');
    return {
      path: novelPath,
      name: meta('og:novel:book_name') || info.find('h3').text().trim(),
      cover: meta('og:image') || info.find('img').attr('src') || defaultCover,
      author: meta('og:novel:author') || undefined,
      summary,
      genres: meta('og:novel:category') || undefined,
      status: status.includes('完结')
        ? NovelStatus.Completed
        : status
          ? NovelStatus.Ongoing
          : NovelStatus.Unknown,
      chapters: await this.parseChapterList(novelPath),
    };
  }

  private async parseChapterList(
    novelPath: string,
  ): Promise<Plugin.ChapterItem[]> {
    const html = await this.fetchText(novelPath + 'list.html');
    const names: Record<number, string> = {};
    const collect = (markup: string) => {
      const $ = parseHTML(markup);
      $('ul.list3 a').each((_, el) => {
        const number = $(el)
          .attr('href')
          ?.match(/\/(\d+)\.html$/)?.[1];
        if (number) names[Number(number)] = $(el).text().trim();
      });
    };
    collect(html);

    const book = html.match(/load_more\('(\d+)'\)/)?.[1];
    const callback = html.match(/var callback='([^']+)'/)?.[1];
    if (book && callback) {
      const jsonp = await this.fetchText(
        `/index.php?c=book&a=list.jsonp&callback=${callback}&book_id=${book}&b=${shuffle(callback)}`,
        // Without the list page as Referer the site answers 参数错误.
        novelPath + 'list.html',
      );
      const start = jsonp.indexOf('(');
      const end = jsonp.lastIndexOf(')');
      if (start >= 0 && end > start) {
        const data = JSON.parse(jsonp.slice(start + 1, end));
        if (typeof data?.content === 'string') collect(data.content);
      }
    }

    // Chapters are numbered 1..N. The site's own lists skip a few (list.html
    // shows 1-24, list.jsonp starts at 37), so gaps get a generic name.
    const last = Math.max(0, ...Object.keys(names).map(Number));
    const chapters: Plugin.ChapterItem[] = [];
    for (let number = 1; number <= last; number++) {
      chapters.push({
        name: names[number] || `第${number}章`,
        path: `${novelPath}${number}.html`,
        chapterNumber: number,
      });
    }
    return chapters;
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const $ = parseHTML(await this.fetchText(chapterPath));
    const content = $('#content').first();
    if (!content.length) {
      throw new Error('找不到章节内容：请在 WebView 中打开该章节检查。');
    }
    content
      .find('script, style, ins, iframe, #ad, [class*="ads"], [id*="ads"]')
      .remove();
    content.find('p').each((_, el) => {
      if (!$(el).text().trim() && !$(el).find('img').length) $(el).remove();
    });
    return (content.html() || '').trim();
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    // The site returns all matches on one page.
    if (pageNo > 1) return [];
    const html = await this.fetchText(
      `/index.php?c=book&a=search&keywords=${encodeURIComponent(searchTerm.trim())}`,
    );
    return this.parseNovelList(parseHTML(html));
  }

  resolveUrl(path: string): string {
    return this.site + path;
  }

  filters = {
    genre: {
      label: '分类',
      value: 'all',
      options: [
        { label: '首页推荐', value: 'all' },
        { label: '玄幻', value: 'xuanhuan' },
        { label: '都市', value: 'dushi' },
        { label: '言情', value: 'yanqing' },
        { label: '穿越', value: 'chuanyue' },
        { label: '青春', value: 'qingchun' },
        { label: '仙侠', value: 'xianxia' },
        { label: '灵异', value: 'lingyi' },
        { label: '悬疑', value: 'xuanyi' },
        { label: '历史', value: 'lishi' },
        { label: '军事', value: 'junshi' },
        { label: '游戏', value: 'youxi' },
        { label: '竞技', value: 'jingji' },
        { label: '科幻', value: 'kehuan' },
        { label: '职场', value: 'zhichang' },
        { label: '官场', value: 'guanchang' },
        { label: '现言', value: 'xianyan' },
        { label: '耽美', value: 'danmei' },
        { label: '其它', value: 'qita' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new QuanbenPlugin();
