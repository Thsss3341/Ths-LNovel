import { CheerioAPI, load as parseHTML } from 'cheerio';
import { fetchApi } from '@libs/fetch';
import { FilterTypes, Filters } from '@libs/filterInputs';
import { Plugin } from '@/types/plugin';
import { NovelStatus } from '@libs/novelStatus';
import { encode } from 'urlencode';
import { storage } from '@libs/storage';

// wenku8 serves GBK-encoded pages from behind Cloudflare, and its ranking and
// search pages require a logged-in account. Requests reuse the cookies of the
// in-app WebView, so users pass the challenge and log in there.
const CHALLENGE_HINT =
  'Cloudflare 验证已过期：请在 WebView 中打开轻小说文库（通常会自动通过验证），返回后重试。';
const LOGIN_HINT = '需要登录：请在 WebView 中登录轻小说文库后重试。';
const ACCESS_HINT = '无法读取该页面：请在 WebView 中打开轻小说文库检查。';
// Used when a 429 carries no Retry-After header.
const DEFAULT_BAN_SECONDS = 60;

// Cloudflare bans an IP for a while (error 1015) once pages load too fast:
// gaps of 1-2 s trip it after 5-6 requests, while 3 s gaps stay safe
// (measured by pywenku8api). Page requests therefore share a token bucket
// that allows a burst of 2 and then one request every 3 seconds.
const REQUEST_INTERVAL_MS = 3000;
const REQUEST_BURST = 2;

// ---------------------------------------------------------------------------
// MyAnimeList titles, ported from ths-manhua's MalTitles.kt (and ths-anime).
// MAL can't find wenku8's Chinese titles. Bangumi (bgm.tv) maps a Chinese
// title to the original Japanese one, and AniList, searched with that, returns
// the MAL ID and the romaji/English titles MAL uses. The result goes on top of
// the description: "id:12345" pasted into MAL's search finds the exact entry.
// ---------------------------------------------------------------------------

/** Plugin setting: look up MAL titles. Read at call time, so changes apply at once. */
const MAL_SETTING = 'malTitles';
const MAL_CACHE_PREFIX = 'malTitle:';
const MAL_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const MAL_LOOKUP_TIMEOUT_MS = 20000;
const MAL_LIKELY_NOTE = '⚠ 非精确匹配，可能不准确';
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
   * similar one, for titles translated differently. wenku8 gives no year, so
   * the author has to carry the match.
   */
  private async likelyViaBangumi(): Promise<MalTitle | undefined> {
    let best:
      | { subject: BangumiSubject; sameAuthor: boolean; score: number }
      | undefined;
    for (const candidate of this.candidates) {
      if (!isChinese(candidate.name)) continue;
      for (const subject of await this.bangumi(candidate.name)) {
        const score = Math.max(
          similarity(loose(candidate.name), loose(subject.name_cn)),
          similarity(loose(candidate.name), loose(subject.name)),
        );
        const sameAuthor = this.sharesAuthor(subject);
        if (!((sameAuthor && score >= 0.3) || score >= 0.75)) continue;
        if (
          !best ||
          Number(sameAuthor) > Number(best.sameAuthor) ||
          (sameAuthor === best.sameAuthor && score > best.score)
        ) {
          best = { subject, sameAuthor, score };
        }
      }
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
   * Whether wenku8's author (a Chinese or Japanese spelling, e.g. 伏濑 or 伏瀬)
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
 * Finds the MAL entry of a wenku8 novel. Results are cached in the plugin's
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
    lines.push('MAL：未找到（以下为Bangumi原名）');
  }
  if (!mal.exact) lines.push(MAL_LIKELY_NOTE);
  if (mal.native) lines.push('日文名：' + mal.native);
  if (mal.english && mal.english !== mal.romaji)
    lines.push('英文名：' + mal.english);
  return lines.join('\n');
};

class Wenku8Plugin implements Plugin.PluginBase {
  id = 'wenku8';
  name = '轻小说文库';
  icon = 'src/cn/wenku8/icon.png';
  site = 'https://www.wenku8.net';
  version = '1.2.0';

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

  /** Set after a 429 (Cloudflare error 1015); no requests go out until then. */
  private bannedUntil = 0;

  private checkBan() {
    const seconds = Math.ceil((this.bannedUntil - Date.now()) / 1000);
    if (seconds > 0) {
      throw new Error(
        `请求过快，已被轻小说文库暂时限速（Error 1015），请约 ${seconds} 秒后再试。`,
      );
    }
  }

  private async fetchPage(url: string): Promise<CheerioAPI> {
    this.checkBan();
    await this.throttle();
    this.checkBan();
    const res = await fetchApi(url, { headers: { Referer: this.site + '/' } });
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
      this.bannedUntil =
        Date.now() + (retryAfter > 0 ? retryAfter : DEFAULT_BAN_SECONDS) * 1000;
      this.checkBan();
    }
    if (res.headers.get('cf-mitigated') === 'challenge') {
      throw new Error(CHALLENGE_HINT);
    }
    if (!res.ok) {
      throw new Error(
        `无法访问轻小说文库（HTTP ${res.status}）。` + ACCESS_HINT,
      );
    }
    const body = await this.decodeGbk(res);
    // Shown instead of search results when the session is not logged in.
    if (body.includes('本站正式关闭')) throw new Error(LOGIN_HINT);
    if (body.includes('两次搜索的间隔时间')) {
      throw new Error('轻小说文库限制两次搜索间隔不少于 5 秒，请稍后再试。');
    }
    // Jieqi CMS error page: "出现错误！ 错误原因：..."
    const error = body.match(/错误原因：([^<]*)/)?.[1]?.trim();
    if (error) {
      throw new Error(error.includes('登录') ? LOGIN_HINT : error);
    }
    return parseHTML(body);
  }

  /** Decodes a GBK page the way the app's fetchText does. */
  private decodeGbk(res: Awaited<ReturnType<typeof fetchApi>>) {
    if (typeof FileReader === 'undefined') {
      // Node (the live checker) has no FileReader but decodes GBK natively.
      const { TextDecoder } = globalThis as unknown as {
        TextDecoder: new (label: string) => { decode(b: ArrayBuffer): string };
      };
      return res.arrayBuffer().then(b => new TextDecoder('gbk').decode(b));
    }
    return res.blob().then(
      blob =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsText(blob, 'gbk');
        }),
    );
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

  /** Parses the novel cards shared by toplist.php, articlelist.php and search.php. */
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
    const list = showLatestNovels
      ? 'toplist.php?sort=lastupdate'
      : filters.list.value;
    const separator = list.includes('?') ? '&' : '?';
    const $ = await this.fetchPage(
      `${this.site}/modules/article/${list}${separator}page=${pageNo}`,
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
    // Only when opening a novel: a search result page doesn't need the MAL entry.
    if (withChapters && novel.name && storage.get(MAL_SETTING) !== false) {
      try {
        const mal = await findMalTitle(novel.name, novel.author || '');
        if (mal) summaryParts.unshift(malLines(mal));
      } catch {
        // Bangumi or AniList unreachable: show the novel without the MAL lines.
      }
    }
    novel.summary = summaryParts.join('\n\n');

    if (withChapters) {
      // Nekori rejects a novel without a chapter list.
      novel.chapters = blocked ? [] : await this.parseChapterList(aid);
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
    // LNReader only splits chapters into pages when a novel has two or more;
    // otherwise it looks for page "1", so a lone volume name would hide them.
    // Nekori shows volume names as volume headers. The plugin must not define
    // parsePage: Nekori would then treat it as paged and require totalPages.
    if (new Set(chapters.map(chapter => chapter.page)).size < 2) {
      chapters.forEach(chapter => delete chapter.page);
    }
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

  pluginSettings = {
    [MAL_SETTING]: {
      value: true,
      label: '简介中显示MAL标题和ID（经Bangumi和AniList查找，方便MAL追踪）',
      type: 'Switch',
    },
  };

  filters = {
    list: {
      label: '分类',
      value: 'toplist.php?sort=allvisit',
      options: [
        // The site's navigation tabs, with the same URLs.
        { label: '热门轻小说', value: 'toplist.php?sort=allvisit' },
        { label: '动画化作品', value: 'toplist.php?sort=anime' },
        { label: '今日更新', value: 'toplist.php?sort=lastupdate' },
        { label: '新书一览', value: 'toplist.php?sort=postdate' },
        { label: '完结全本', value: 'articlelist.php?fullflag=1' },
        { label: '轻小说列表', value: 'articlelist.php' },
        // Other toplist.php rankings.
        { label: '总推荐榜', value: 'toplist.php?sort=allvote' },
        { label: '月排行榜', value: 'toplist.php?sort=monthvisit' },
        { label: '月推荐榜', value: 'toplist.php?sort=monthvote' },
        { label: '周排行榜', value: 'toplist.php?sort=weekvisit' },
        { label: '周推荐榜', value: 'toplist.php?sort=weekvote' },
        { label: '日排行榜', value: 'toplist.php?sort=dayvisit' },
        { label: '日推荐榜', value: 'toplist.php?sort=dayvote' },
        { label: '总收藏榜', value: 'toplist.php?sort=goodnum' },
        { label: '字数排行', value: 'toplist.php?sort=size' },
      ],
      type: FilterTypes.Picker,
    },
  } satisfies Filters;
}

export default new Wenku8Plugin();
