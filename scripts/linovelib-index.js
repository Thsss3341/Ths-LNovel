// Builds the search index of the linovelib_tw plugin. tw.linovelib.com has no
// search of its own any more, so a daily workflow collects every novel's ID,
// Traditional Chinese title and author from the site's full novel list
// (/wenku/), and the simplified title from www.bilinovel.com, which uses the
// same novel IDs. The plugin downloads the result and searches it.
//
// Usage: node scripts/linovelib-index.js [output.json]
import fs from 'fs';
import path from 'path';

const OUTPUT = process.argv[2] || '.index/linovelib_tw.json';
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const REQUEST_INTERVAL_MS = 1000;
const RETRIES = 3;
// Fewer novels than this means the list could not be read properly.
const MIN_NOVELS = 1000;

const listPage = page => `/wenku/lastupdate_0_0_0_0_0_0_0_${page}_0.html`;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const decode = text =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&(\w+);/g, (entity, name) => ENTITIES[name] ?? entity)
    .trim();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let lastRequest = 0;
async function fetchPage(url) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.headers.get('cf-mitigated') === 'challenge') {
        throw new Error('Cloudflare challenge');
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (error) {
      if (attempt >= RETRIES) throw new Error(`${url}: ${error.message}`);
      await sleep(5000 * attempt);
    }
  }
}

/** Every novel in a site's list: id -> { title, author }. */
async function readList(site) {
  const novels = new Map();
  let lastPage = 1;
  for (let page = 1; page <= lastPage; page++) {
    const html = await fetchPage(site + listPage(page));
    if (page === 1) {
      lastPage = Number(html.match(/_(\d+)_0\.html" class="last"/)?.[1]) || 1;
    }
    const items = html.split('<li class="book-li">').slice(1);
    for (const item of items) {
      const id = item.match(/href="\/novel\/(\d+)\.html"/)?.[1];
      // The <h4> title is shortened; the cover's alt text is not.
      const title = item.match(/<img [^>]*alt="([^"]*)"/)?.[1];
      if (!id || !title) continue;
      const author = item.match(
        /<span class="book-author">.*?<\/svg>([^<]*)</s,
      );
      novels.set(Number(id), {
        title: decode(title),
        author: author ? decode(author[1]) : '',
      });
    }
    if (page % 20 === 0 || page === lastPage) {
      console.log(`${site}: page ${page}/${lastPage}, ${novels.size} novels`);
    }
  }
  return novels;
}

const traditional = await readList('https://tw.linovelib.com');
if (traditional.size < MIN_NOVELS) {
  throw new Error(`Only ${traditional.size} novels found; not publishing.`);
}

let simplified = new Map();
try {
  simplified = await readList('https://www.bilinovel.com');
} catch (error) {
  // The index still works without simplified titles; they return tomorrow.
  console.warn(`Simplified titles unavailable: ${error.message}`);
}

// [id, Traditional title, simplified title ('' if the same), author]
const novels = [...traditional.entries()]
  .sort(([a], [b]) => a - b)
  .map(([id, { title, author }]) => {
    const other = simplified.get(id)?.title || '';
    return [id, title, other === title ? '' : other, author];
  });

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(
  OUTPUT,
  JSON.stringify({ updated: new Date().toISOString(), novels }),
);
console.log(
  `Wrote ${novels.length} novels (${simplified.size} simplified titles) to ${OUTPUT}`,
);
