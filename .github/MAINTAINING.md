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
