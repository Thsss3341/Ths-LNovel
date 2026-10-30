// Builds the search index of the fanqie plugin. fanqienovel.com only answers
// title searches from its own pages (the request needs a browser-made
// signature), so a daily workflow collects the most-read books of every main
// category from the site's library list, which needs no signature. The
// plugin downloads the result and searches it.
//
// The site stops answering a client that reads too fast, so each run reads a
// limited number of pages, one at a time, and refreshes the categories whose
// lists are oldest. The lists of the other categories are kept from earlier
// runs in fanqie-categories.json, next to the index.
//
// Usage: node scripts/fanqie-index.js [output directory]
// Environment: REQUEST_BUDGET (pages per run), BOOKS_PER_CATEGORY,
// CONCURRENCY and REQUEST_INTERVAL_MS.
import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = process.argv[2] || '.index';
const INDEX_FILE = path.join(OUTPUT_DIR, 'fanqie.json');
const STATE_FILE = path.join(OUTPUT_DIR, 'fanqie-categories.json');
const SITE = 'https://fanqienovel.com';
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const env = (name, fallback) => Number(process.env[name]) || fallback;
const REQUEST_BUDGET = env('REQUEST_BUDGET', 1200);
const BOOKS_PER_CATEGORY = env('BOOKS_PER_CATEGORY', 2000);
const CONCURRENCY = env('CONCURRENCY', 1);
const REQUEST_INTERVAL_MS = env('REQUEST_INTERVAL_MS', 1000);
// The site now and then answers with an empty body; many in a row mean it
// has stopped answering this client.
const RETRIES = 4;

// The library list draws common characters with private-use code points;
// the plugin holds the table that maps them back.
const pluginSource = fs.readFileSync(
  new URL('../plugins/chinese/fanqie.ts', import.meta.url),
  'utf8',
);
const FIRST_CODE = Number(pluginSource.match(/FIRST_CODE = (0x[0-9a-f]+)/)[1]);
const LIBRARY_CHARS = pluginSource.match(/LIBRARY_CHARS =\s*'([^']+)'/)[1];
const PRIVATE_USE = /[\ue000-\uf8ff]/;

const decode = text =>
  [...text]
    .map(char => {
      const mapped = LIBRARY_CHARS[char.charCodeAt(0) - FIRST_CODE];
      return mapped && mapped !== '?' ? mapped : char;
    })
    .join('')
    .trim();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let requests = 0;
async function fetchJson(apiPath) {
  const url = SITE + apiPath;
  for (let attempt = 1; ; attempt++) {
    await sleep(REQUEST_INTERVAL_MS);
    requests++;
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
      await sleep(5000 * 2 ** (attempt - 1));
    }
  }
}

// { updated, categories: { [id]: { name, updated, books: [[id, name, author, cover]] } } }
let state = { categories: {} };
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  console.log(
    `Read the lists of ${Object.keys(state.categories).length} categories`,
  );
} catch {
  console.log('No earlier lists; starting afresh');
}

const categories = (
  await fetchJson('/api/author/book/category_list/v0/?gender=-1')
).filter(category => category.label === '主分类');
console.log(`${categories.length} categories`);

// Categories never read come first, then the ones read longest ago.
const age = category => state.categories[category.category_id]?.updated || '';
const queue = [...categories].sort((a, b) => age(a).localeCompare(age(b)));
// Pages needed for one category: 2 of 50 books, then pages of 10.
const pagesPerCategory = 2 + Math.ceil((BOOKS_PER_CATEGORY - 100) / 10);

let blocked = false;
let undecoded = 0;
let refreshed = 0;

/** A category's most-read books, or undefined if the site stopped answering. */
async function readCategory(category) {
  const books = [];
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
      console.warn(`${category.name}: stopped at ${offset}: ${error.message}`);
      blocked = true;
      return undefined;
    }
    const list = data?.book_list || [];
    for (const book of list) {
      if (!book.book_id || !book.book_name) continue;
      const name = decode(book.book_name);
      const author = decode(book.author || '');
      if (PRIVATE_USE.test(name + author)) undecoded++;
      const cover = book.thumb_uri?.match(/novel-pic\/([^~?/]+)/)?.[1] || '';
      books.push([book.book_id, name, author, cover]);
    }
    offset += pageSize;
    if (list.length < pageSize || data.has_more === false) break;
  }
  return books;
}

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length && !blocked) {
      if (requests + pagesPerCategory * CONCURRENCY > REQUEST_BUDGET) break;
      const category = queue.shift();
      const books = await readCategory(category);
      // A list cut short is dropped; the earlier one stays.
      if (!books) continue;
      state.categories[category.category_id] = {
        name: category.name,
        updated: new Date().toISOString(),
        books,
      };
      refreshed++;
      console.log(`${category.name}: ${books.length} books`);
    }
  }),
);
console.log(`Refreshed ${refreshed} categories with ${requests} requests`);

// Characters left undecoded mean the site changed its font, and the plugin's
// table needs updating too.
const read = refreshed * BOOKS_PER_CATEGORY;
if (refreshed && undecoded > read / 100) {
  throw new Error(
    `${undecoded} books have undecoded characters: the site's font changed.`,
  );
}
if (!refreshed) {
  throw new Error('No category could be read; not publishing.');
}

// Categories the site no longer lists are dropped.
const listed = new Set(
  categories.map(category => String(category.category_id)),
);
for (const id of Object.keys(state.categories)) {
  if (!listed.has(id)) delete state.categories[id];
}
state.updated = new Date().toISOString();

// [id, name, author, cover image id], most-read first across categories:
// every category's first book, then every category's second, and so on.
const lists = Object.values(state.categories).map(category => category.books);
const longest = Math.max(...lists.map(list => list.length));
const seen = new Set();
const entries = [];
for (let place = 0; place < longest; place++) {
  for (const list of lists) {
    const book = list[place];
    if (!book || seen.has(book[0])) continue;
    seen.add(book[0]);
    entries.push(book);
  }
}

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify(state));
fs.writeFileSync(
  INDEX_FILE,
  JSON.stringify({ updated: state.updated, books: entries }),
);
console.log(
  `Wrote ${entries.length} books from ${lists.length} categories to ${INDEX_FILE}`,
);
