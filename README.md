# Ths-LNovel

A personal plugin repository for [LNReader](https://github.com/LNReader/lnreader), built on the
tooling of the community [lnreader-plugins](https://github.com/LNReader/lnreader-plugins)
repository.

## Plugins

| Plugin | Site | Language | Source |
| --- | --- | --- | --- |
| 轻小说文库 (wenku8) | https://www.wenku8.net | Chinese | [`plugins/chinese/wenku8.ts`](plugins/chinese/wenku8.ts) |

### wenku8 notes

- wenku8.net is behind Cloudflare, and its ranking and search pages need a logged-in account.
  In LNReader, open the source's WebView (the globe icon), pass the Cloudflare check, and log in
  to wenku8 there. The plugin reuses the WebView's cookies. If you see
  `无法访问轻小说文库…`, repeat this step.
- The site allows one search every 5 seconds.
- Chapters are grouped by volume (卷). Illustrations are loaded from `pic.wenku8.com`.
- The site has withdrawn some novels for copyright reasons (因版权问题). Those novels show their
  details with a note in the summary, but they have no chapters.

## Using this repository in LNReader

Every push to `main` that touches `plugins/`, `public/`, or `scripts/` runs the
[Publish Plugins](.github/workflows/publish-plugins.yml) workflow. It builds the plugins and
force-pushes them to the `plugins/v<version>` branch, where the version comes from
`package.json` (currently `1.0.0`).

In LNReader, add this URL as a plugin repository:

```
https://raw.githubusercontent.com/Thsss3341/Ths-LNovel/plugins/v1.0.0/.dist/plugins.min.json
```

The workflow pushes with the default `GITHUB_TOKEN`. If the push fails with a permissions
error, go to **Settings → Actions → General → Workflow permissions** and choose
**Read and write permissions**.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev:start      # plugin playground at http://localhost:3000
npm run lint
npm run format:check
npm run build:compile  # compile plugins into .js/
npm run check:plugin -- plugins/chinese/wenku8.ts   # live check against the site
```

`check:plugin` can't get past wenku8's Cloudflare check and login requirement, so test this
plugin in the playground or the app. The live-check workflow runs only when started by hand.

To add another plugin, read [docs/quickstart.md](docs/quickstart.md) and
[docs/docs.md](docs/docs.md). Put the source in `plugins/<language>/` and a 96×96 icon in
`public/static/src/<lang-code>/<plugin-id>/icon.png`. Bump a plugin's `version` whenever you
change it; the app only updates installed plugins when the version changes.

## License

MIT. The tooling is derived from [LNReader/lnreader-plugins](https://github.com/LNReader/lnreader-plugins).
See [LICENSE](LICENSE).
