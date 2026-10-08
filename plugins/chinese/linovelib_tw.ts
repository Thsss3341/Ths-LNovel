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
const INDEX_HINT =
  '無法下載搜尋索引，請稍後再試，或輸入小說網址或編號，例如 https://tw.linovelib.com/novel/3095.html 或 3095。';

// The site's own search is gone. A daily workflow (scripts/linovelib-index.js)
// publishes every novel's ID, Traditional and simplified title and author, and
// the plugin searches that list.
const INDEX_URL =
  'https://raw.githubusercontent.com/Thsss3341/Ths-LNovel/index/linovelib_tw.json';
const INDEX_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const SEARCH_PAGE_SIZE = 40;
/** [id, Traditional title, simplified title ('' if the same), author] */
type IndexEntry = [number, string, string, string];

// The simplified edition uses the same novel IDs. Its titles are the ones
// Bangumi lists, so the MAL lookup searches with them.
const SIMPLIFIED_SITE = 'https://www.bilinovel.com';

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

// ---------------------------------------------------------------------------
// MyAnimeList titles, the same lookup as in wenku8.ts (ported from ths-manhua's
// MalTitles.kt). MAL can't find Chinese titles. Bangumi (bgm.tv) maps a Chinese
// title to the original Japanese one, and AniList, searched with that, returns
// the MAL ID and the romaji/English titles MAL uses. The result goes on top of
// the description: "id:12345" pasted into MAL's search finds the exact entry.
// ---------------------------------------------------------------------------

/** Plugin setting: look up MAL titles. Read at call time, so changes apply at once. */
const MAL_SETTING = 'malTitles';
const MAL_CACHE_PREFIX = 'malTitle:';
const MAL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const MAL_LOOKUP_TIMEOUT_MS = 20000;
const MAL_LIKELY_NOTE = '⚠ 非精確匹配，可能不準確';
const MAL_USER_AGENT =
  'Thsss3341/ths-lnovel (https://github.com/Thsss3341/Ths-LNovel)';

const BANGUMI_SEARCH_URL = 'https://api.bgm.tv/v0/search/subjects?limit=10';
const BANGUMI_TYPE_BOOK = 1;
const BANGUMI_PLATFORM_NOVEL = '小说';
const BANGUMI_AUTHOR_KEYS = ['作者', '原作'];
const ANILIST_URL = 'https://graphql.anilist.co';
const ANILIST_QUERY = `query ($search: String) {
  Page(perPage: 8) {
    media(search: $search, type: MANGA, format: NOVEL) {
      idMal
      title { romaji english native }
      synonyms
    }
  }
}`;

const SUBTITLE_SEPARATOR = /[~～：:（(【[—]/;
const TRAILING_PARENTHESES = /[（(]([^（()）]*)[)）]\s*$/;
const PUNCTUATION =
  /[\s~～\-－—_·・:：;；,，.。!！?？'"“”‘’「」『』《》〈〉【】[\]()（）〔〕{}<>/\\|&＆+＋=＝*×☆★♪♡、…]/g;

type MalTitle = {
  malId?: number;
  romaji?: string;
  english?: string;
  /** The original (usually Japanese) title. */
  native?: string;
  /** False when the match rests on a similar title and the author, not identical titles. */
  exact: boolean;
};

type Candidate = { name: string; shortened: boolean };

type LikelySubject = {
  subject: BangumiSubject;
  sameAuthor: boolean;
  score: number;
};

type BangumiSubject = {
  name: string;
  name_cn: string;
  platform?: string;
  infobox?: { key: string; value: unknown }[];
};

type AniListMedia = {
  idMal: number | null;
  title: {
    romaji: string | null;
    english: string | null;
    native: string | null;
  };
  synonyms: string[] | null;
};

// Case-, width- and whitespace-insensitive.
const strict = (text?: string | null) => {
  let value = text || '';
  try {
    value = value.normalize('NFKC');
  } catch {
    // Without Intl the comparison is merely a little stricter.
  }
  return value.toLowerCase().replace(/\s+/g, '');
};

// Also ignores punctuation and symbols.
const loose = (text?: string | null) => strict(text).replace(PUNCTUATION, '');

// Han characters without kana: searched on Bangumi, whose titles are Chinese or Japanese.
const isChinese = (text: string) =>
  /[㐀-鿿]/.test(text) && !/[぀-ヿ]/.test(text);

/** Dice coefficient over character pairs, 0..1. */
const similarity = (a: string, b: string) => {
  if (!a || !b) return 0;
  const pairs = (text: string) => {
    const result: string[] = [];
    for (let i = 0; i < Math.max(1, text.length - 1); i++) {
      result.push(text.substr(i, 2));
    }
    return result;
  };
  const pairsA = pairs(a);
  const pairsB = pairs(b);
  const remaining = pairsB.slice();
  let shared = 0;
  pairsA.forEach(pair => {
    const index = remaining.indexOf(pair);
    if (index >= 0) {
      remaining.splice(index, 1);
      shared++;
    }
  });
  return (2 * shared) / (pairsA.length + pairsB.length);
};

/**
 * 1 minus the edit distance relative to the longer title, 0..1: 败北女角太多了
 * and 败犬女主太多了 differ in 2 of 7 characters, 0.71.
 */
const editSimilarity = (a: string, b: string) => {
  if (!a || !b) return 0;
  let previous: number[] = [];
  for (let j = 0; j <= b.length; j++) previous.push(j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current.push(
        Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
};

/** Thresholds for a likely match: with the same author, or on the title alone. */
const LIKELY_WITH_AUTHOR = 0.3;
const LIKELY_DICE = 0.75;
const LIKELY_EDIT = 0.7;

/** Parts of a title to search Bangumi with: its halves, then its first and last 3 characters. */
const fragments = (title: string) => {
  const text = loose(title);
  if (text.length < 5) return [];
  const half = Math.ceil(text.length / 2);
  const parts = [
    text.slice(-half),
    text.slice(0, half),
    text.slice(-3),
    text.slice(0, 3),
  ];
  return parts.filter((part, index) => parts.indexOf(part) === index);
};

/** Runs tasks one at a time, at least [intervalMs] apart, to respect an API's rate limit. */
const spaced = (intervalMs: number) => {
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      const wait = last + intervalMs - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      last = Date.now();
      return task();
    });
    queue = run.catch(() => undefined);
    return run;
  };
};

// AniList allows 30 requests a minute; Bangumi asks clients to go easy too.
const aniListQueue = spaced(2000);
const bangumiQueue = spaced(500);

const postJson = async (url: string, body: unknown) => {
  const res = await fetchApi(url, {
    method: 'POST',
    headers: {
      'User-Agent': MAL_USER_AGENT,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
};

/**
 * The title as it is, without a trailing alias in brackets, the alias itself,
 * and the part before a subtitle separator (marked as shortened, since a short
 * name can belong to another work).
 */
const malCandidates = (title: string): Candidate[] => {
  const whole = title.trim();
  const alias = whole.match(TRAILING_PARENTHESES)?.[1]?.trim();
  const main = whole.replace(TRAILING_PARENTHESES, '').trim();
  const names: Candidate[] = [whole, main, alias || ''].map(name => ({
    name,
    shortened: false,
  }));
  [main, alias || ''].forEach(name =>
    names.push({
      name: name.split(SUBTITLE_SEPARATOR)[0].trim(),
      shortened: true,
    }),
  );
  const seen: Record<string, boolean> = {};
  return names.filter(candidate => {
    const key = loose(candidate.name);
    if (key.length < 2 || seen[key]) return false;
    seen[key] = true;
    return true;
  });
};

class MalLookup {
  private keys: string[];
  private bangumiResults: Record<string, BangumiSubject[]> = {};
  private aniListResults: Record<string, AniListMedia[]> = {};

  constructor(
    private candidates: Candidate[],
    private author: string,
  ) {
    this.keys = candidates.map(candidate => loose(candidate.name));
  }

  async run(): Promise<MalTitle | undefined> {
    const exact = await this.exactViaBangumi();
    if (exact?.malId) return exact;
    const viaAniList = await this.exactViaAniList();
    if (viaAniList) return viaAniList;
    return exact || (await this.likelyViaBangumi());
  }

  /** A Bangumi novel titled exactly like one of the names, then its original title on AniList. */
  private async exactViaBangumi(): Promise<MalTitle | undefined> {
    let withoutMal: MalTitle | undefined;
    for (const candidate of this.candidates) {
      if (!isChinese(candidate.name)) continue;
      const subject = this.firstExactMatch(
        await this.bangumi(candidate.name),
        candidate.name,
      );
      if (!subject) continue;
      // A shortened name ("无职转生") can belong to another work.
      if (candidate.shortened && !this.sharesAuthor(subject)) continue;
      const media = await this.exactAniList(
        subject.name,
        this.keys.concat(loose(subject.name), loose(subject.name_cn)),
      );
      if (media) return this.toMalTitle(media, true);
      withoutMal = withoutMal || { native: subject.name, exact: true };
    }
    return withoutMal;
  }

  /** An AniList novel titled like one of the names, e.g. through a Chinese synonym. */
  private async exactViaAniList(): Promise<MalTitle | undefined> {
    for (const candidate of this.candidates) {
      if (candidate.shortened) continue;
      const media = await this.exactAniList(candidate.name, this.keys);
      if (media) return this.toMalTitle(media, true);
    }
    return undefined;
  }

  /**
   * The Bangumi novel by the same author with a similar title, or with a very
   * similar one, for titles translated differently (linovelib's 败北女角太多了 is
   * 败犬女主太多了 on Bangumi). linovelib gives no year, so the title or the
   * author has to carry the match.
   */
  private async likelyViaBangumi(): Promise<MalTitle | undefined> {
    const titles = this.candidates.filter(
      candidate => !candidate.shortened && isChinese(candidate.name),
    );
    let best: LikelySubject | undefined;
    for (const candidate of this.candidates) {
      if (!isChinese(candidate.name)) continue;
      best = this.bestLikely(
        best,
        await this.bangumi(candidate.name),
        titles.concat(candidate),
      );
    }
    // Bangumi matches whole words, so a title with a word translated
    // differently may not come up at all. Its parts usually do ("太多了").
    for (const fragment of titles.length ? fragments(titles[0].name) : []) {
      if (best) break;
      best = this.bestLikely(best, await this.bangumi(fragment), titles);
    }
    if (!best) return undefined;
    const { subject } = best;
    const media = await this.exactAniList(subject.name, [
      loose(subject.name),
      loose(subject.name_cn),
    ]);
    return media
      ? this.toMalTitle(media, false)
      : { native: subject.name, exact: false };
  }

  /** [best], or the subject among [subjects] that resembles one of [titles] more. */
  private bestLikely(
    best: LikelySubject | undefined,
    subjects: BangumiSubject[],
    titles: Candidate[],
  ) {
    for (const subject of subjects) {
      let dice = 0;
      let edit = 0;
      titles.forEach(title => {
        [subject.name_cn, subject.name].forEach(name => {
          dice = Math.max(dice, similarity(loose(title.name), loose(name)));
          edit = Math.max(edit, editSimilarity(loose(title.name), loose(name)));
        });
      });
      const score = Math.max(dice, edit);
      const sameAuthor = this.sharesAuthor(subject);
      if (
        !(
          (sameAuthor && score >= LIKELY_WITH_AUTHOR) ||
          dice >= LIKELY_DICE ||
          edit >= LIKELY_EDIT
        )
      ) {
        continue;
      }
      if (
        !best ||
        Number(sameAuthor) > Number(best.sameAuthor) ||
        (sameAuthor === best.sameAuthor && score > best.score)
      ) {
        best = { subject, sameAuthor, score };
      }
    }
    return best;
  }

  private firstExactMatch(subjects: BangumiSubject[], name: string) {
    // Strict first, so a sequel with extra symbols isn't picked over the original.
    for (const normalize of [strict, loose]) {
      const key = normalize(name);
      const match = subjects.find(
        subject =>
          key === normalize(subject.name_cn) || key === normalize(subject.name),
      );
      if (match) return match;
    }
    return undefined;
  }

  /**
   * Whether linovelib's author (a Chinese or Japanese spelling, e.g. 伏濑 or 伏瀬)
   * shares at least half its characters with one of Bangumi's authors.
   */
  private sharesAuthor(subject: BangumiSubject) {
    const ours = loose(this.author.replace(/[（(].*?[)）]/g, ''));
    if (ours.length < 2) return false;
    const values: string[] = [];
    (subject.infobox || [])
      .filter(item => BANGUMI_AUTHOR_KEYS.indexOf(item.key) >= 0)
      .forEach(item => {
        if (typeof item.value === 'string') {
          item.value.split(/[、,，/]/).forEach(value => values.push(value));
        } else if (Array.isArray(item.value)) {
          item.value.forEach(entry => {
            if (entry && typeof entry.v === 'string') values.push(entry.v);
          });
        }
      });
    return values.some(value => {
      const theirs = loose(value);
      if (theirs.length < 2) return false;
      const shared = ours
        .split('')
        .filter(char => theirs.indexOf(char) >= 0).length;
      return shared * 2 >= Math.max(ours.length, theirs.length);
    });
  }

  /** The AniList novel whose native, romaji/English or alternative title is one of [names]. */
  private async exactAniList(name: string, names: string[]) {
    const keys = names.filter(Boolean);
    const rank = (media: AniListMedia) => {
      if (keys.indexOf(loose(media.title.native)) >= 0) return 0;
      if (
        keys.indexOf(loose(media.title.romaji)) >= 0 ||
        keys.indexOf(loose(media.title.english)) >= 0
      ) {
        return 1;
      }
      if (
        (media.synonyms || []).some(
          synonym => keys.indexOf(loose(synonym)) >= 0,
        )
      ) {
        return 2;
      }
      return -1;
    };
    let best: { media: AniListMedia; rank: number } | undefined;
    for (const media of await this.aniList(name)) {
      const r = rank(media);
      if (media.idMal && r >= 0 && (!best || r < best.rank))
        best = { media, rank: r };
    }
    return best?.media;
  }

  private toMalTitle(media: AniListMedia, exact: boolean): MalTitle {
    return {
      malId: media.idMal || undefined,
      romaji: media.title.romaji || undefined,
      english: media.title.english || undefined,
      native: media.title.native || undefined,
      exact,
    };
  }

  private async bangumi(name: string) {
    if (!this.bangumiResults[name]) {
      const response = await bangumiQueue(() =>
        postJson(BANGUMI_SEARCH_URL, {
          keyword: name,
          filter: { type: [BANGUMI_TYPE_BOOK] },
        }),
      );
      this.bangumiResults[name] = (
        (response?.data || []) as BangumiSubject[]
      ).filter(subject => subject.platform === BANGUMI_PLATFORM_NOVEL);
    }
    return this.bangumiResults[name];
  }

  private async aniList(name: string) {
    if (!this.aniListResults[name]) {
      const response = await aniListQueue(() =>
        postJson(ANILIST_URL, {
          query: ANILIST_QUERY,
          variables: { search: name },
        }),
      );
      this.aniListResults[name] = (response?.data?.Page?.media ||
        []) as AniListMedia[];
    }
    return this.aniListResults[name];
  }
}

/**
 * Finds the MAL entry of a novel. Results are cached in the plugin's
 * storage: exact matches for good, likely matches and misses for a week.
 * Failed lookups aren't cached.
 */
const findMalTitle = async (
  title: string,
  author: string,
): Promise<MalTitle | undefined> => {
  const cacheKey = MAL_CACHE_PREFIX + loose(title);
  const cached = storage.get(cacheKey) as { title?: MalTitle } | undefined;
  if (cached) return cached.title;

  const result = await Promise.race([
    new MalLookup(malCandidates(title), author).run(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('MAL lookup timed out')),
        MAL_LOOKUP_TIMEOUT_MS,
      ),
    ),
  ]);
  storage.set(
    cacheKey,
    { title: result },
    result?.exact && result.malId ? undefined : Date.now() + MAL_RECHECK_MS,
  );
  return result;
};

/** The lines added to the top of the description. "id:12345" stays on a line of its own for copying. */
const malLines = (mal: MalTitle) => {
  const lines: string[] = [];
  if (mal.malId) {
    lines.push('MAL：' + (mal.romaji || mal.english || mal.native));
    lines.push('id:' + mal.malId);
  } else {
    lines.push('MAL：未找到（以下為Bangumi原名）');
  }
  if (!mal.exact) lines.push(MAL_LIKELY_NOTE);
  if (mal.native) lines.push('日文名：' + mal.native);
  if (mal.english && mal.english !== mal.romaji)
    lines.push('英文名：' + mal.english);
  return lines.join('\n');
};

type ReadParams = { chapterId: number; next: string };

/** The 排行榜 entry that lists completed novels, like wenku8's 完结全本. */
const COMPLETED_LIST = 'completed';
/** Rankings the full novel list can also sort by; the others fall back to 最近更新. */
const LIST_ORDERS = [
  'monthvisit',
  'weekvisit',
  'monthvote',
  'weekvote',
  'monthflower',
  'weekflower',
  'lastupdate',
  'postdate',
  'goodnum',
];

class LinovelibTwPlugin implements Plugin.PluginBase {
  id = 'linovelib_tw_ths';
  name = '嗶哩輕小說(繁體)';
  icon = 'src/cn/linovelib_tw_ths/icon.png';
  site = 'https://tw.linovelib.com';
  version = '1.2.0';

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
        // The full novel list shortens long titles; the cover's alt text doesn't.
        name:
          img.attr('alt')?.trim() || $(el).find('.book-title').text().trim(),
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
    if (showLatestNovels) {
      return this.parseNovelList(
        await this.fetchPage(`/top/lastupdate/${pageNo}.html`),
      );
    }
    const rank = filters.rank.value;
    const status = rank === COMPLETED_LIST ? '5' : filters.status.value;
    const anime = filters.anime.value;
    const type = filters.type.value;
    const words = filters.words.value;
    if (
      rank !== COMPLETED_LIST &&
      status === '0' &&
      anime === '0' &&
      type === '0' &&
      words === '0'
    ) {
      return this.parseNovelList(
        await this.fetchPage(`/top/${rank}/${pageNo}.html`),
      );
    }
    // The full novel list (/wenku/) takes the filters; the rankings don't.
    // Its URL is order_tag_status_anime_type_sort_subtype_words_page_update.
    const order = LIST_ORDERS.indexOf(rank) >= 0 ? rank : 'lastupdate';
    const path = `/wenku/${order}_0_${status}_${anime}_${type}_0_0_${words}_${pageNo}_0.html`;
    return this.parseNovelList(await this.fetchPage(path));
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

    if (novel.name && storage.get(MAL_SETTING) !== false) {
      try {
        const original = await this.simplifiedTitle(novelPath);
        const mal = await findMalTitle(
          original?.title || novel.name,
          original?.author || novel.author || '',
        );
        if (mal) novel.summary = malLines(mal) + '\n\n' + novel.summary;
      } catch {
        // Bangumi or AniList unreachable: show the novel without the MAL lines.
      }
    }

    const catalogPath =
      $('#btnReadBook').attr('href') ||
      novelPath.replace(/\.html$/, '/catalog');
    novel.chapters = this.parseChapterList(await this.fetchPage(catalogPath));
    return novel;
  }

  /** The novel's title and author on the simplified edition, if it has them. */
  private async simplifiedTitle(novelPath: string) {
    try {
      const res = await fetchApi(SIMPLIFIED_SITE + novelPath, {
        headers: { Referer: SIMPLIFIED_SITE + '/' },
      });
      if (!res.ok) return undefined;
      const $ = parseHTML(await res.text());
      const detail = $('#bookDetailWrapper');
      const title = detail.find('.book-title').first().text().trim();
      if (!title) return undefined;
      return { title, author: detail.find('.authorname a').text().trim() };
    } catch {
      return undefined;
    }
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
    const term = searchTerm.trim();
    // A novel's URL opens that novel.
    const linked = term.match(/novel\/(\d+)/)?.[1];
    if (linked) return pageNo > 1 ? [] : this.novelById(Number(linked));

    const results: Plugin.NovelItem[] = [];
    // A number is also tried as an ID, ahead of titles containing it ("86").
    if (pageNo === 1 && /^\d+$/.test(term)) {
      results.push(...(await this.novelById(Number(term))));
    }
    const start = (pageNo - 1) * SEARCH_PAGE_SIZE;
    this.matchIndex(await this.loadIndex(), term)
      .slice(start, start + SEARCH_PAGE_SIZE)
      .forEach(entry => {
        if (results.some(novel => novel.path === this.novelPath(entry[0]))) {
          return;
        }
        results.push({
          name: entry[1],
          path: this.novelPath(entry[0]),
          cover: this.coverUrl(entry[0]),
        });
      });
    return results;
  }

  private novelPath(id: number) {
    return `/novel/${id}.html`;
  }

  private coverUrl(id: number) {
    return `${this.site}/files/article/image/${Math.floor(id / 1000)}/${id}/${id}s.jpg`;
  }

  private async novelById(id: number): Promise<Plugin.NovelItem[]> {
    const path = this.novelPath(id);
    const $ = await this.fetchPage(path);
    const name = $('#bookDetailWrapper .book-title').first().text().trim();
    if (!name) return [];
    return [
      { name, path, cover: $('#bookDetailWrapper img.book-cover').attr('src') },
    ];
  }

  private index?: { entries: IndexEntry[]; loadedAt: number };

  private async loadIndex(): Promise<IndexEntry[]> {
    if (this.index && Date.now() - this.index.loadedAt < INDEX_MAX_AGE_MS) {
      return this.index.entries;
    }
    let entries: IndexEntry[] | undefined;
    try {
      const res = await fetchApi(INDEX_URL);
      if (res.ok) entries = (await res.json())?.novels;
    } catch {
      // Reported below.
    }
    if (!Array.isArray(entries) || !entries.length) {
      // An older copy is better than none.
      if (this.index) return this.index.entries;
      throw new Error(INDEX_HINT);
    }
    this.index = { entries, loadedAt: Date.now() };
    return entries;
  }

  /**
   * Novels whose Traditional or simplified title, or author, contains the
   * term, ignoring spaces and punctuation: exact titles first, then titles
   * starting with it, then other titles, then authors.
   */
  private matchIndex(entries: IndexEntry[], term: string) {
    const key = loose(term);
    if (!key) return [];
    const ranked: { entry: IndexEntry; rank: number }[] = [];
    entries.forEach(entry => {
      const titles = [loose(entry[1]), loose(entry[2])].filter(Boolean);
      let rank = -1;
      if (titles.some(title => title === key)) rank = 0;
      else if (titles.some(title => title.indexOf(key) === 0)) rank = 1;
      else if (titles.some(title => title.indexOf(key) >= 0)) rank = 2;
      else if (loose(entry[3]).indexOf(key) >= 0) rank = 3;
      if (rank >= 0) ranked.push({ entry, rank });
    });
    ranked.sort(
      (a, b) => a.rank - b.rank || a.entry[1].length - b.entry[1].length,
    );
    return ranked.map(item => item.entry);
  }

  resolveUrl(path: string): string {
    return this.site + path.replace(/(#next)+$/, '');
  }

  pluginSettings = {
    [MAL_SETTING]: {
      value: true,
      label: '簡介中顯示MAL標題和ID（經Bangumi和AniList查找，方便MAL追蹤）',
      type: 'Switch',
    },
  };

  filters = {
    rank: {
      label: '排行榜／排序',
      value: 'monthvisit',
      options: [
        { label: '月點擊榜', value: 'monthvisit' },
        { label: '完結全本', value: COMPLETED_LIST },
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
    // These select from the full novel list, sorted by the ranking above
    // (月/周雞蛋榜 and 新書榜 sort by 最近更新 there).
    status: {
      label: '狀態',
      value: '0',
      options: [
        { label: '不限', value: '0' },
        { label: '已經完本', value: '5' },
        { label: '新書上傳', value: '1' },
        { label: '情節展開', value: '2' },
        { label: '精彩紛呈', value: '3' },
        { label: '接近尾聲', value: '4' },
      ],
      type: FilterTypes.Picker,
    },
    anime: {
      label: '動畫化',
      value: '0',
      options: [
        { label: '不限', value: '0' },
        { label: '已動畫化', value: '1' },
        { label: '未動畫化', value: '2' },
      ],
      type: FilterTypes.Picker,
    },
    type: {
      label: '類型',
      value: '0',
      options: [
        { label: '不限', value: '0' },
        { label: '日本輕小說', value: '1' },
        { label: '華文輕小說', value: '2' },
        { label: 'Web輕小說', value: '3' },
        { label: '輕改漫畫', value: '4' },
        { label: '韓國輕小說', value: '5' },
      ],
      type: FilterTypes.Picker,
    },
    words: {
      label: '字數',
      value: '0',
      options: [
        { label: '不限', value: '0' },
        { label: '30萬以下', value: '1' },
        { label: '30-50萬', value: '2' },
        { label: '50-100萬', value: '3' },
        { label: '100-200萬', value: '4' },
        { label: '200萬以上', value: '5' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new LinovelibTwPlugin();
