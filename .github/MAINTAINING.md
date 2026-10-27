# Maintaining Ths-LNovel

Notes for building, testing and publishing the plugins. The user guide is in
[README.md](../README.md); conventions for code changes are in [AGENTS.md](../AGENTS.md).

## Publishing

Every push to `main` that touches `plugins/`, `public/`, `scripts/` or `package.json` runs the
[Publish Plugins](workflows/publish-plugins.yml) workflow. It compiles the plugins, builds the
manifest and force-pushes everything to the `plugins/v<version>` branch, where the version comes
from `package.json` (currently `1.0.0`). Apps read the manifest from:

```
https://raw.githubusercontent.com/Thsss3341/Ths-LNovel/plugins/v1.0.0/.dist/plugins.min.json
```

The workflow pushes with the default `GITHUB_TOKEN`. If the push fails with a permissions error,
go to **Settings → Actions → General → Workflow permissions** and choose **Read and write
permissions**.

Bump a plugin's `version` whenever you change it; the apps only offer an update when the version
changes.

## linovelib search index

tw.linovelib.com has no search of its own, so the linovelib plugin searches a list of every novel.
The [Linovelib Search Index](workflows/linovelib-index.yml) workflow builds it with
[`scripts/linovelib-index.js`](../scripts/linovelib-index.js) from the full novel lists of
tw.linovelib.com and www.bilinovel.com (same novel IDs, Simplified Chinese titles), and
force-pushes `linovelib_tw.json` to the `index` branch.

- It runs daily at 19:23 UTC (03:23 Hong Kong time), and can be started by hand from the
  **Actions** tab.
- On pull requests that change the script or the workflow, it only builds the index, to check that
  GitHub's runners can still read both sites.
- It refuses to publish a list of fewer than 1,000 novels.
- GitHub turns off scheduled workflows after 60 days without activity in the repository. If that
  happens, re-enable the workflow in the **Actions** tab.

To build it locally:

```sh
node scripts/linovelib-index.js .index/linovelib_tw.json
```

## fanqie search index

fanqienovel.com's search API needs a signature that only its web pages make, so the fanqie plugin
searches a list of the site's most-read books instead. The
[Fanqie Search Index](workflows/fanqie-index.yml) workflow builds it with
[`scripts/fanqie-index.js`](../scripts/fanqie-index.js) from the site's library list (the 2,000
most-read books of each of the 36 main categories) and force-pushes two files to the
`index-fanqie` branch: `fanqie.json`, which the plugin downloads, and `fanqie-categories.json`,
each category's list with the time it was read.

- **It refreshes a few categories per run.** The site stops answering a client that reads too
  fast: a GitHub runner reading 4 categories at once was cut off after about 300 pages. So each run
  reads at most 1,200 pages (`REQUEST_BUDGET`), one at a time with a 1-second pause, which is about
  6 categories, starting with the ones read longest ago; the other categories keep their earlier
  lists. Every category is refreshed about once a week.
- **It stops when the site stops answering.** After a page fails 4 times in a row, the run keeps
  the categories it finished, drops the one it was reading, and publishes. A run that finishes no
  category fails without publishing.
- It runs daily at 20:41 UTC (04:41 Hong Kong time), and can be started by hand from the
  **Actions** tab. A run takes about 45 minutes.
- On pull requests that change the script or the workflow, it only reads two short categories and
  publishes nothing.
- The library list draws common characters with a scrambled font. The script reads the decoding
  table from `plugins/chinese/fanqie.ts`, and refuses to publish when more than 1% of the books it
  read still have undecoded characters: that means the site changed its font, and the plugin's
  tables need updating too.

To build the whole index locally (in about half an hour, if the site lets you read that fast):

```sh
CONCURRENCY=4 REQUEST_INTERVAL_MS=300 REQUEST_BUDGET=100000 node scripts/fanqie-index.js .index
```

The script reads and updates `.index/fanqie-categories.json`, so pushing both files of `.index` to
`index-fanqie` gives the workflow a complete starting point.

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm run dev:start      # plugin playground at http://localhost:3000
npm run lint
npm run format:check
npm run build:compile  # compile plugins into .js/
npm run check:plugin -- plugins/chinese/ixdzs8.ts   # live check against the site
```

`check:plugin` bundles a plugin and runs `popularNovels`, `searchNovels`, `parseNovel` and
`parseChapter` against the real site. It can't get past Cloudflare, so it doesn't work for
**wenku8** (Cloudflare and a login) or **novel543**; test those in the app or with requests sent
from a browser that has passed the challenge. The live-check workflow only runs when started by
hand.

## Adding a plugin

Read [docs/quickstart.md](../docs/quickstart.md) and [docs/docs.md](../docs/docs.md).

- Put the source in `plugins/<language>/` and a 96×96 icon in
  `public/static/src/<lang-code>/<plugin-id>/icon.png`.
- When rewriting a plugin from the community repository, give it its own ID (this repository uses
  a `_ths` suffix, e.g. `ixdzs8_ths`) so both can be installed side by side.
- Add the plugin to the tables and sections of both [README.md](../README.md) and
  [README.zh-CN.md](../README.zh-CN.md).

## License

MIT. The tooling is derived from
[LNReader/lnreader-plugins](https://github.com/LNReader/lnreader-plugins). See
[LICENSE](../LICENSE).
