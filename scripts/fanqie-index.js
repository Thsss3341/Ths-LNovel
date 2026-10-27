// Builds the search index of the fanqie plugin. fanqienovel.com only answers
// title searches from its own pages (the request needs a browser-made
// signature), so a daily workflow collects the most-read books of every main
// category from the site's library list, which needs no signature. The
// plugin downloads the result and searches it.
//
// Usage: node scripts/fanqie-index.js [output.json]
import fs from 'fs';
import path from 'path';

const OUTPUT = process.argv[2] || '.index/fanqie.json';
const SITE = 'https://fanqienovel.com';
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
// Categories are read in parallel, each with a pause between its requests.
const CONCURRENCY = 4;
const REQUEST_INTERVAL_MS = 300;
// The site now and then answers with an empty body, more often under load.
const RETRIES = 6;
// The library list gives up to 50 books per page for its first 100 books,
// and 10 per page after that.
const BOOKS_PER_CATEGORY = Number(process.env.BOOKS_PER_CATEGORY) || 2000;

// The library list draws common characters with private-use code points;
// the plugin holds the table that maps them back.
const pluginSource = fs.readFileSync(
  new URL('../plugins/chinese/fanqie.ts', import.meta.url),
  'utf8',
);
const FIRST_CODE = Number(pluginSource.match(/FIRST_CODE = (0x[0-9a-f]+)/)[1]);
const LIBRARY_CHARS = pluginSource.match(/LIBRARY_CHARS =\s*'([^']+)'/)[1];
const PRIVATE_USE = /[-]/;

const decode = text =>
  [...text]
    .map(char => {
      const mapped = LIBRARY_CHARS[char.charCodeAt(0) - FIRST_CODE];
      return mapped && mapped !== '?' ? mapped : char;
    })
    .join('')
    .trim();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(apiPath) {
  const url = SITE + apiPath;
  for (let attempt = 1; ; attempt++) {
    await sleep(REQUEST_INTERVAL_MS);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Referer: SITE + '/library' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.code !== 0) throw new Error(`code ${json.code} ${json.message}`);
      return json.data;
    } catch (error) {
      if (attempt >= RETRIES) throw new Error(`${url}: ${error.message}`);
      await sleep(Math.min(60000, 5000 * 2 ** (attempt - 1)));
    }
  }
}

const categories = (
  await fetchJson('/api/author/book/category_list/v0/?gender=-1')
).filter(category => category.label === '主分类');
console.log(`${categories.length} categories`);

// id -> [name, author, cover, place in its category's most-read list]
const books = new Map();
let undecoded = 0;
async function readCategory(category) {
  for (let offset = 0; offset < BOOKS_PER_CATEGORY; ) {
    const pageSize = offset < 100 ? 50 : 10;
    let data;
    try {
      data = await fetchJson(
        `/api/author/library/book_list/v0/?page_count=${pageSize}&page_index=${offset / pageSize}` +
          `&gender=-1&category_id=${category.category_id}&creation_status=-1` +
          `&word_count=-1&book_type=-1&sort=0`,
      );
    } catch (error) {
      // Keep what was read; the total is checked below.
      console.warn(`${category.name}: stopped at ${offset}: ${error.message}`);
      break;
    }
    const list = data?.book_list || [];
    for (const [i, book] of list.entries()) {
      if (!book.book_id || !book.book_name || books.has(book.book_id)) continue;
      const name = decode(book.book_name);
      const author = decode(book.author || '');
      if (PRIVATE_USE.test(name + author)) undecoded++;
      const cover = book.thumb_uri?.match(/novel-pic\/([^~?/]+)/)?.[1] || '';
      books.set(book.book_id, [name, author, cover, offset + i]);
    }
    offset += pageSize;
    if (list.length < pageSize || data.has_more === false) break;
  }
  console.log(`${category.name}: ${books.size} books so far`);
}

const queue = [...categories];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await readCategory(queue.shift());
  }),
);

// Fewer books than this means the list could not be read properly.
const minBooks = (categories.length * BOOKS_PER_CATEGORY) / 2;
if (books.size < minBooks) {
  throw new Error(`Only ${books.size} books found; not publishing.`);
}
// Characters left undecoded mean the site changed its font, and the plugin's
// table needs updating too.
if (undecoded > books.size / 100) {
  throw new Error(
    `${undecoded} books have undecoded characters: the site's font changed.`,
  );
}

// [id, name, author, cover image id], most-read first across categories: every category's first book, then
// every category's second, and so on.
const entries = [...books.entries()]
  .sort(([, a], [, b]) => a[3] - b[3])
  .map(([id, [name, author, cover]]) => [id, name, author, cover]);
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(
  OUTPUT,
  JSON.stringify({ updated: new Date().toISOString(), books: entries }),
);
console.log(`Wrote ${entries.length} books to ${OUTPUT}`);
