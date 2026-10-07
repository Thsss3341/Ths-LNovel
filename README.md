# Ths-LNovel

A personal plugin repository for [LNReader](https://github.com/LNReader/lnreader) and
[Nekori](https://github.com/Yuneko-dev/Nekori), which runs LNReader plugins, built on the
tooling of the community [lnreader-plugins](https://github.com/LNReader/lnreader-plugins)
repository.

## Plugins

| Plugin | Site | Language | Source |
| --- | --- | --- | --- |
| 轻小说文库 (wenku8) | https://www.wenku8.net | Chinese | [`plugins/chinese/wenku8.ts`](plugins/chinese/wenku8.ts) |

### wenku8 notes

- wenku8.net is behind Cloudflare, and its ranking and search pages need a logged-in account.
  In the app, open the source's WebView (the globe icon), pass the Cloudflare check, and log in
  to wenku8 there. The plugin reuses the WebView's cookies.
- The Cloudflare clearance expires after a while. When it does, the plugin shows
  `Cloudflare 验证已过期…`: open the WebView again (it usually passes the check by itself),
  then go back. `需要登录…` means the wenku8 login has to be renewed in the WebView.
- Loading pages too quickly gets your IP banned for a few minutes (Cloudflare "Error 1015 —
  You are being rate limited"). The plugin spaces its requests about 3 seconds apart, so
  downloading many chapters is slow (about 20 chapters a minute) but stays under the limit. If
  a ban happens anyway, the plugin shows `请求过快…` with the remaining wait and sends nothing
  until the ban has expired.
- The site allows one search every 5 seconds.
- Chapters are grouped by volume (卷). Illustrations are loaded from `pic.wenku8.com`.
- The site has withdrawn some novels for copyright reasons (因版权问题). They have no chapters.
  Nekori opens them with a note in the summary; LNReader shows "Unable to load novel".

## Using this repository in LNReader or Nekori

Every push to `main` that touches `plugins/`, `public/`, or `scripts/` runs the
[Publish Plugins](.github/workflows/publish-plugins.yml) workflow. It builds the plugins and
force-pushes them to the `plugins/v<version>` branch, where the version comes from
`package.json` (currently `1.0.0`).

In LNReader or Nekori, add this URL as a plugin repository:

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
