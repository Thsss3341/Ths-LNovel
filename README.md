# Ths-LNovel

A personal plugin repository for [LNReader](https://github.com/LNReader/lnreader) and
[Nekori](https://github.com/Yuneko-dev/Nekori), which runs LNReader plugins, built on the
tooling of the community [lnreader-plugins](https://github.com/LNReader/lnreader-plugins)
repository.

## Plugins

| Plugin | Site | Language | Source |
| --- | --- | --- | --- |
| 轻小说文库 (wenku8) | https://www.wenku8.net | Chinese | [`plugins/chinese/wenku8.ts`](plugins/chinese/wenku8.ts) |
| 嗶哩輕小說(繁體) (linovelib) | https://tw.linovelib.com | Chinese | [`plugins/chinese/linovelib_tw.ts`](plugins/chinese/linovelib_tw.ts) |
| 爱下电子书 (ixdzs8) | https://ixdzs8.com | Chinese | [`plugins/chinese/ixdzs8.ts`](plugins/chinese/ixdzs8.ts) |
| 全本小说网 (quanben) | https://www.quanben.io | Chinese | [`plugins/chinese/quanben.ts`](plugins/chinese/quanben.ts) |

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

### Web novel sites (ixdzs8, quanben)

Two sites for Chinese web novels (起点 and similar), rewritten from the community repository's
plugins with their own IDs (`ixdzs8_ths`, `quanben_ths`).

- **爱下电子书** carries the most titles. Browse its 热门排行, 全本完结 and 最近更新 lists, or pick a
  分类, which can be narrowed by 状态 (连载中/已完结), 排序 (最新/最热) and 字数. Chapter pages pass
  the site's own security check by themselves. Chapters the site hasn't filled in yet
  (「手打中！请稍后刷新！」) show an error instead of the placeholder, so try them again later.
- **全本小说网** has fewer titles but often complete ones. Browse by 分类. The site drops a fair
  share of connections, so the plugin retries each request up to three times. Its chapter list
  skips a few chapters (the site's own bug); the plugin fills them in as 第N章.
- The same title can be a different book on each site; check the author.

### MAL tracking

MyAnimeList can't find Chinese titles, so the wenku8 and linovelib plugins look each novel up when
you open it and add its MAL entry to the top of the description:

```
MAL：Mushoku Tensei: Isekai Ittara Honki Dasu
id:70261
日文名：無職転生 ～異世界行ったら本気だす～
英文名：Mushoku Tensei: Jobless Reincarnation
```

**Tracking a novel:** copy `id:70261` from the description and paste it into the MAL tracker's
search. That gives the exact entry.

**How a match is found** (the same way as in ths-manhua and ths-anime): the plugin searches
[Bangumi](https://bgm.tv) for the Chinese title (for linovelib, the simplified title from
www.bilinovel.com, which is how Bangumi lists it) to get the original Japanese title, then searches
[AniList](https://anilist.co) with that for the MAL ID and the romaji and English titles.

- **Exact match:** the titles are identical.
- **Likely match:** the title is only similar (a different translation), and either the author
  agrees or the titles differ in only a few characters (at least 70% the same, e.g. wenku8's
  败北女角太多了 and Bangumi's 败犬女主太多了). It is marked **⚠ 非精确匹配，可能不准确**; check the
  entry before tracking it. When the whole title finds nothing, the plugin also searches Bangumi
  with parts of it, since Bangumi matches whole words.
- **No match:** the description is unchanged. This happens when wenku8's translation is too
  different from Bangumi's, or when the novel isn't on MAL.
- **Bangumi only:** if AniList has no MAL ID, the description shows `MAL：未找到` with the
  Japanese title, which you can still search MAL for.

**Other notes:**
- Results are cached: exact matches for good, likely matches and misses for a week. Failed
  lookups (no network) aren't cached and are retried next time.
- Turn the lookup off with **简介中显示MAL标题和ID** (linovelib: **簡介中顯示MAL標題和ID**) in the
  plugin's settings.
- Novels already in your library get the MAL lines when you refresh them.

### linovelib (Traditional Chinese) notes

A rewrite of the community repository's `Linovelib(繁體)` plugin. It has its own ID
(`linovelib_tw_ths`), so both can be installed side by side.

- The site shuffles every paragraph after the 20th and reorders them with a script in the
  browser. The plugin applies the same reordering, so chapters read in the right order.
- Browse with the site's rankings, or **完結全本** for completed novels (like wenku8's). The
  **狀態** (e.g. 已經完本), **動畫化**, **類型** and **字數** filters select from the site's full novel
  list, sorted by the chosen ranking; 月/周雞蛋榜 and 新書榜 sort it by 最近更新 instead.
- The site has no search of its own any more (its search box opens Google), so the plugin searches
  a list of every novel instead. The [Linovelib Search Index](.github/workflows/linovelib-index.yml)
  workflow rebuilds it daily from the site's full novel list and from
  [www.bilinovel.com](https://www.bilinovel.com), the simplified edition with the same novel IDs, and
  publishes it to the `index` branch. Search matches Traditional or simplified titles and authors
  (`史莱姆` and `史萊姆` both work). A novel's URL or number, e.g.
  `https://tw.linovelib.com/novel/3095.html` or `3095`, opens that novel directly, including one
  added since the last rebuild.
- Some chapters have no link in the table of contents. The plugin finds them through the previous
  chapter's "next chapter" link, which costs a few extra requests the first time.
- Chapters are split into pages of about 1,000 characters, so a chapter takes several requests.
  Requests are spaced about a second apart.
- Clients the site takes for bots get a shortened chapter that ends with
  「內容加載失敗」. The plugin reports this instead of showing the shortened text; opening the
  site's home page in the WebView may help.
- Illustrations come from `img3.readpai.com`, which needs a linovelib `Referer`; the plugin sends
  one.

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
