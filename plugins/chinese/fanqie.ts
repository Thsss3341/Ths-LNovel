import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { defaultCover } from '@libs/defaultCover';

// 番茄小说 (fanqienovel.com), ByteDance's free web novel platform.
//
// The site draws about 370 common characters with private-use code points
// (U+E3E8-U+E55B) and a custom font that shows the real character. Two fonts
// are in use: chapter text, rankings and search share one, the 书库 list has
// its own. The tables below give the real character for each code point,
// starting at U+E3E8; '?' marks code points the fonts don't use.
const FIRST_CODE = 0xe3e8;
const READER_CHARS =
  'D在主特家军然表场4要只v和?6别还g现儿岁??此象月3出战工相o男直失世F都平文什VO将真T那当?会立些u是十张学气大爱两命全后东性通被1它乐接而感车山公了常以何可话先pi叫轻M士w着变尔快l个说少色里安花远7难师放t报认面道S?克地度I好机U民写把万同水新没书电吃像斯5为y白几日教看但第加候作上拉住有法r事应位利你声身国问马女他Y比父xAHNsX边美对所金活回意到z从j知又内因点Q三定8Rb正或夫向德听更?得告并本q过记L让打f人就者去原满体做经K走如孩cG给使物?最笑部?员等受k行一条果动光门头见往自解成处天能于名其发总母的死手入路进心来h时力多开已许d至由很界n小与Z想代么分生口再妈望次西风种带J?实情才这?E我神格长觉间年眼无不亲关结0友信下却重己老2音字m呢明之前高PB目太e9起稜她也W用方子英每理便四数期中C外样a海们任';
const LIBRARY_CHARS =
  '体y十现快便话却月物水的放知爱万?表风理O老也p常克平几最主她s将法情o光a我呢J员太每望受教w利军已U人如变得要少斯门电m男没AK国时中走么何口小向问轻Td神下间车fG度D又大面远就写j给通起实E?它去S到道数吃们加P是无把事西多界?发新外活解孩只作前Y尔经?u心告父等Q民全这9果安?i母8r说任先和地C张战场g像cq你使?样总目x性处音头?应乐关能花l当名手4重字声力友然生代内里本回真入师象?0点R亲V种动英命ZhX做特边高有B为期自年马认出接至H正方感所明者稜F住学还分意更其n但比觉以由死家让失士L2I金叫身报听W再原山海白很见5直位第工个开岁好用都于可同3次四?日信与女笑满并部什不从或机此?了记三e些bN夫会才儿眼两美被一公来立z长对己看k许因相色后往打结格过世气7子条在书之定v拉成进带着东上想天他妈1文而路那别德6Mt行候难';

const decode = (text: string, chars: string) => {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const index = text.charCodeAt(i) - FIRST_CODE;
    const char = index >= 0 && index < chars.length ? chars[index] : '?';
    out += char === '?' ? text.charAt(i) : char;
  }
  return out;
};

const LOCKED_HINT =
  '番茄小说网页版只免费提供前几章，这一章需要番茄 SVIP：请在 WebView 中登录 SVIP 账号后重试，或在番茄小说 App 中免费阅读。';
const INDEX_HINT =
  '无法下载番茄小说的搜索书目，请稍后再试；也可以在 WebView 中搜索，再把小说网址粘贴到这里搜索。';
const NOT_FOUND_HINT =
  '搜索书目中没有这本书（书目只收录各分类最热门的书）：请在 WebView 中搜索，再把小说网址粘贴到这里搜索。';

// The site's own search needs a signature that only its web pages make. A
// daily workflow (scripts/fanqie-index.js) publishes the most-read books of
// every category from the library list, and the plugin searches that list.
const INDEX_URL =
  'https://raw.githubusercontent.com/Thsss3341/Ths-LNovel/index-fanqie/fanqie.json';
const INDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SEARCH_PAGE_SIZE = 40;
/** [book id, name, author, cover image id] */
type IndexEntry = [string, string, string, string];

const PUNCTUATION =
  /[\s~～\-－—_·・:：;；,，.。!！?？'"“”‘’「」『』《》〈〉【】[\]()（）〔〕{}<>/\\|&＆+＋=＝*×☆★♪♡、…]/g;
// Ignores case, width, spaces and punctuation.
const loose = (text: string) => {
  let value = text;
  try {
    value = value.normalize('NFKC');
  } catch {
    // Without Intl the comparison is merely a little stricter.
  }
  return value.toLowerCase().replace(PUNCTUATION, '');
};

type BookItem = {
  book_id?: string;
  bookId?: string;
  book_name?: string;
  bookName?: string;
  thumb_uri?: string;
  thumb_url?: string;
  thumbUri?: string;
};

type ApiResponse<T> = { code?: number; message?: string; data?: T };

class FanqiePlugin implements Plugin.PluginBase {
  id = 'fanqie_ths';
  name = '番茄小说';
  icon = 'src/cn/fanqie_ths/icon.png';
  // The app's WebView opens this page. The site's other pages have no search
  // box on phones; this one does.
  site = 'https://fanqienovel.com/search/%E7%95%AA%E8%8C%84';
  version = '1.1.0';

  private base = 'https://fanqienovel.com';

  private async fetchText(path: string): Promise<string> {
    const url = this.base + path;
    const res = await fetchApi(url, { headers: { Referer: this.base + '/' } });
    if (!res.ok)
      throw new Error(`无法访问番茄小说（HTTP ${res.status}）：${url}`);
    return res.text();
  }

  private async fetchJson<T>(path: string): Promise<ApiResponse<T>> {
    return JSON.parse(await this.fetchText(path));
  }

  /** The page's server-rendered state, window.__INITIAL_STATE__. */
  private async fetchState(path: string) {
    const html = await this.fetchText(path);
    const json = html.match(
      /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*\}\s*\)\s*\(\)/,
    )?.[1];
    if (!json) throw new Error('无法读取番茄小说的页面：' + this.base + path);
    return JSON.parse(json.replace(/:undefined([,}])/g, ':null$1'));
  }

  /**
   * Cover links in the site's data expire after a day; the same image is
   * served without a signature from p3-novel.byteimg.com.
   */
  private cover(uri?: string): string {
    const id = uri?.match(/novel-pic\/[^~?/]+/)?.[0];
    return id
      ? `https://p3-novel.byteimg.com/${id}~tplv-resize:225:300.image`
      : defaultCover;
  }

  private novelItems(books: BookItem[] | undefined, chars: string) {
    const novels: Plugin.NovelItem[] = [];
    (books || []).forEach(book => {
      const id = book.book_id || book.bookId;
      const name = book.book_name || book.bookName;
      if (!id || !name) return;
      novels.push({
        name: decode(name, chars),
        path: `/page/${id}`,
        cover: this.cover(book.thumb_uri || book.thumb_url || book.thumbUri),
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
    const list = showLatestNovels ? 'library' : filters.list.value;
    if (list !== 'library') {
      // Each ranking has 100 books.
      if (pageNo > 5) return [];
      const [gender, category] = filters.rank.value.split('_');
      const mold = list === 'rank_new' ? 1 : 2;
      const data = await this.fetchJson<{ book_list?: BookItem[] }>(
        `/api/rank/category/list?app_id=2503&rank_list_type=3&offset=${(pageNo - 1) * 20}&limit=20` +
          `&category_id=${category}&rank_version=&gender=${gender}&rankMold=${mold}`,
      );
      return this.novelItems(data.data?.book_list, READER_CHARS);
    }
    const query = showLatestNovels
      ? 'gender=-1&category_id=-1&creation_status=-1&word_count=-1&sort=1'
      : `gender=${filters.gender.value}&category_id=${filters.category.value}` +
        `&creation_status=${filters.status.value}&word_count=${filters.words.value}` +
        `&sort=${filters.sort.value}`;
    const data = await this.fetchJson<{ book_list?: BookItem[] }>(
      `/api/author/library/book_list/v0/?page_count=18&page_index=${pageNo - 1}&book_type=-1&${query}`,
    );
    return this.novelItems(data.data?.book_list, LIBRARY_CHARS);
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const bookId = novelPath.match(/\d+/)?.[0];
    const page = (await this.fetchState(novelPath)).page || {};

    let genres: string[] = [];
    try {
      genres = JSON.parse(page.categoryV2 || '[]').map(
        (category: { Name: string }) => category.Name,
      );
    } catch {
      // Leave the genres empty.
    }
    const summary = decode(page.abstract || '', READER_CHARS)
      .split('\n')
      .map((line: string) => line.replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''))
      .filter(Boolean)
      .join('\n');
    const status = String(page.creationStatus);

    const directory = await this.fetchJson<{
      chapterListWithVolume?: {
        itemId: string;
        title: string;
        volume_name?: string;
        firstPassTime?: string;
      }[][];
    }>(`/api/reader/directory/detail?bookId=${bookId}`);
    const volumes = directory.data?.chapterListWithVolume || [];
    const chapters: Plugin.ChapterItem[] = [];
    volumes.forEach(volume => {
      volume.forEach(chapter => {
        const time = Number(chapter.firstPassTime);
        chapters.push({
          name: decode(chapter.title, READER_CHARS),
          path: `/reader/${chapter.itemId}`,
          chapterNumber: chapters.length + 1,
          releaseTime: time ? new Date(time * 1000).toISOString() : undefined,
          page: volumes.length > 1 ? chapter.volume_name : undefined,
        });
      });
    });

    return {
      path: novelPath,
      name: decode(page.bookName || '', READER_CHARS),
      cover: this.cover(page.thumbUri || page.thumbUrl),
      author: decode(page.author || '', READER_CHARS) || undefined,
      summary,
      genres: genres.join(',') || undefined,
      status:
        status === '0'
          ? NovelStatus.Completed
          : status === '1'
            ? NovelStatus.Ongoing
            : NovelStatus.Unknown,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const chapter = (await this.fetchState(chapterPath)).reader?.chapterData;
    if (!chapter?.content) {
      throw new Error('找不到章节内容：请在 WebView 中打开该章节检查。');
    }
    const content = decode(chapter.content, READER_CHARS);
    // Without SVIP, a locked chapter has only its first few lines.
    const length = content.replace(/<[^>]*>/g, '').length;
    const words = Number(chapter.chapterWordNumber) || 0;
    if (chapter.isChapterLock && length < words * 0.6) {
      throw new Error(LOCKED_HINT);
    }
    return content;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    const term = searchTerm.trim();
    const id = await this.linkedBookId(term);
    if (id) {
      if (pageNo > 1) return [];
      const path = `/page/${id}`;
      const novel = await this.parseNovel(path);
      return [{ name: novel.name, path, cover: novel.cover }];
    }
    const start = (pageNo - 1) * SEARCH_PAGE_SIZE;
    const matches = this.matchIndex(await this.loadIndex(), term);
    if (!matches.length && pageNo === 1 && loose(term)) {
      throw new Error(NOT_FOUND_HINT);
    }
    return matches.slice(start, start + SEARCH_PAGE_SIZE).map(entry => ({
      name: entry[1],
      path: `/page/${entry[0]}`,
      cover: this.cover(entry[3] && `novel-pic/${entry[3]}`),
    }));
  }

  /**
   * The book a pasted link or number points to: a book page, a chapter, a
   * link shared from the 番茄小说 app (book_id=...), or a bare book number.
   */
  private async linkedBookId(term: string): Promise<string | undefined> {
    const id =
      term.match(/fanqienovel\.com\/page\/(\d+)/)?.[1] ||
      term.match(/book_?id=(\d+)/i)?.[1] ||
      term.match(/^\d{16,20}$/)?.[0];
    if (id) return id;
    const chapter = term.match(/fanqienovel\.com\/reader\/(\d+)/)?.[1];
    if (!chapter) return undefined;
    const state = await this.fetchState(`/reader/${chapter}`);
    return state.reader?.chapterData?.bookId || undefined;
  }

  private index?: {
    entries: IndexEntry[];
    // Names and authors as compared, worked out once per download.
    names: string[];
    authors: string[];
    loadedAt: number;
  };

  private async loadIndex() {
    if (this.index && Date.now() - this.index.loadedAt < INDEX_MAX_AGE_MS) {
      return this.index;
    }
    let entries: IndexEntry[] | undefined;
    try {
      const res = await fetchApi(INDEX_URL);
      if (res.ok) entries = (await res.json())?.books;
    } catch {
      // Reported below.
    }
    if (!Array.isArray(entries) || !entries.length) {
      // An older copy is better than none.
      if (this.index) return this.index;
      throw new Error(INDEX_HINT);
    }
    this.index = {
      entries,
      names: entries.map(entry => loose(entry[1])),
      authors: entries.map(entry => loose(entry[2])),
      loadedAt: Date.now(),
    };
    return this.index;
  }

  /**
   * Books whose name or author contains the term, ignoring spaces and
   * punctuation: exact names first, then names starting with it, then other
   * names, then authors. Each group keeps the index's most-read order.
   */
  private matchIndex(
    index: { entries: IndexEntry[]; names: string[]; authors: string[] },
    term: string,
  ) {
    const key = loose(term);
    if (!key) return [];
    const groups: IndexEntry[][] = [[], [], [], []];
    index.entries.forEach((entry, i) => {
      const name = index.names[i];
      const at = name.indexOf(key);
      if (at >= 0) groups[name === key ? 0 : at === 0 ? 1 : 2].push(entry);
      else if (index.authors[i].indexOf(key) >= 0) groups[3].push(entry);
    });
    return groups[0].concat(groups[1], groups[2], groups[3]);
  }

  resolveUrl(path: string): string {
    return this.base + path;
  }

  filters = {
    list: {
      label: '列表',
      value: 'library',
      options: [
        { label: '书库', value: 'library' },
        { label: '阅读榜', value: 'rank_read' },
        { label: '新书榜', value: 'rank_new' },
      ],
      type: FilterTypes.Picker,
    },
    // For 阅读榜 and 新书榜.
    rank: {
      label: '榜单分类',
      value: '1_1141',
      options: [
        { label: '男频·西方奇幻', value: '1_1141' },
        { label: '男频·东方仙侠', value: '1_1140' },
        { label: '男频·科幻末世', value: '1_8' },
        { label: '男频·都市日常', value: '1_261' },
        { label: '男频·都市修真', value: '1_124' },
        { label: '男频·都市高武', value: '1_1014' },
        { label: '男频·历史古代', value: '1_273' },
        { label: '男频·战神赘婿', value: '1_27' },
        { label: '男频·都市种田', value: '1_263' },
        { label: '男频·传统玄幻', value: '1_258' },
        { label: '男频·历史脑洞', value: '1_272' },
        { label: '男频·悬疑脑洞', value: '1_539' },
        { label: '男频·都市脑洞', value: '1_262' },
        { label: '男频·玄幻脑洞', value: '1_257' },
        { label: '男频·悬疑灵异', value: '1_751' },
        { label: '男频·抗战谍战', value: '1_504' },
        { label: '男频·游戏体育', value: '1_746' },
        { label: '男频·动漫衍生', value: '1_718' },
        { label: '男频·男频衍生', value: '1_1016' },
        { label: '女频·古风世情', value: '0_1139' },
        { label: '女频·科幻末世', value: '0_8' },
        { label: '女频·游戏体育', value: '0_746' },
        { label: '女频·女频衍生', value: '0_1015' },
        { label: '女频·玄幻言情', value: '0_248' },
        { label: '女频·种田', value: '0_23' },
        { label: '女频·年代', value: '0_79' },
        { label: '女频·现言脑洞', value: '0_267' },
        { label: '女频·宫斗宅斗', value: '0_246' },
        { label: '女频·悬疑脑洞', value: '0_539' },
        { label: '女频·古言脑洞', value: '0_253' },
        { label: '女频·快穿', value: '0_24' },
        { label: '女频·青春甜宠', value: '0_749' },
        { label: '女频·星光璀璨', value: '0_745' },
        { label: '女频·女频悬疑', value: '0_747' },
        { label: '女频·职场婚恋', value: '0_750' },
        { label: '女频·豪门总裁', value: '0_748' },
        { label: '女频·民国言情', value: '0_1017' },
      ],
      type: FilterTypes.Picker,
    },
    // The rest are for 书库.
    gender: {
      label: '读者',
      value: '-1',
      options: [
        { label: '全部', value: '-1' },
        { label: '男生', value: '1' },
        { label: '女生', value: '0' },
      ],
      type: FilterTypes.Picker,
    },
    category: {
      label: '分类',
      value: '-1',
      options: [
        { label: '全部', value: '-1' },
        { label: '女频悬疑', value: '747' },
        { label: '西方奇幻', value: '1141' },
        { label: '东方仙侠', value: '1140' },
        { label: '古风世情', value: '1139' },
        { label: '科幻末世', value: '8' },
        { label: '男频衍生', value: '1016' },
        { label: '女频衍生', value: '1015' },
        { label: '民国言情', value: '1017' },
        { label: '都市高武', value: '1014' },
        { label: '悬疑灵异', value: '751' },
        { label: '悬疑脑洞', value: '539' },
        { label: '抗战谍战', value: '504' },
        { label: '青春甜宠', value: '749' },
        { label: '双男主', value: '275' },
        { label: '古言脑洞', value: '253' },
        { label: '历史古代', value: '273' },
        { label: '历史脑洞', value: '272' },
        { label: '现言脑洞', value: '267' },
        { label: '都市种田', value: '263' },
        { label: '都市脑洞', value: '262' },
        { label: '都市日常', value: '261' },
        { label: '玄幻脑洞', value: '257' },
        { label: '玄幻言情', value: '248' },
        { label: '宫斗宅斗', value: '246' },
        { label: '豪门总裁', value: '748' },
        { label: '战神赘婿', value: '27' },
        { label: '动漫衍生', value: '718' },
        { label: '星光璀璨', value: '745' },
        { label: '游戏体育', value: '746' },
        { label: '职场婚恋', value: '750' },
        { label: '双女主', value: '704' },
        { label: '传统玄幻', value: '258' },
        { label: '都市修真', value: '124' },
        { label: '年代', value: '79' },
        { label: '种田', value: '23' },
        { label: '快穿', value: '24' },
      ],
      type: FilterTypes.Picker,
    },
    status: {
      label: '状态',
      value: '-1',
      options: [
        { label: '全部', value: '-1' },
        { label: '已完结', value: '0' },
        { label: '连载中', value: '1' },
      ],
      type: FilterTypes.Picker,
    },
    words: {
      label: '字数',
      value: '-1',
      options: [
        { label: '全部', value: '-1' },
        { label: '30万以下', value: '0' },
        { label: '30-50万', value: '1' },
        { label: '50-100万', value: '2' },
        { label: '100-200万', value: '3' },
        { label: '200万以上', value: '4' },
      ],
      type: FilterTypes.Picker,
    },
    sort: {
      label: '排序',
      value: '0',
      options: [
        { label: '最热', value: '0' },
        { label: '最新', value: '1' },
        { label: '字数', value: '2' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new FanqiePlugin();
