# Ths-LNovel

**English** | [简体中文](README.zh-CN.md)

Chinese light novel and web novel plugins for [Nekori](https://github.com/Yuneko-dev/Nekori),
[LNReader](https://github.com/LNReader/lnreader) and other apps that run LNReader plugins:

| Plugin | Site | Highlights |
|--------|------|------------|
| **轻小说文库** (wenku8) | [wenku8.net](https://www.wenku8.net) | Japanese light novels; rankings and 完结全本 lists, chapters by volume, easy MyAnimeList (MAL) tracking |
| **嗶哩輕小說(繁體)** (linovelib) | [tw.linovelib.com](https://tw.linovelib.com) | Light novels in Traditional Chinese; chapters in the right order, title search again, easy MAL tracking |
| **爱下电子书** (ixdzs8) | [ixdzs8.com](https://ixdzs8.com) | Chinese web novels (起点 and others); the most titles, with category, status and length filters |
| **全本小说网** (quanben) | [quanben.io](https://www.quanben.io) | Chinese web novels, often complete |
| **小說543** (novel543) | [novel543.com](https://www.novel543.com) | Chinese web novels in Traditional Chinese, some further along than elsewhere |

> [!NOTE]
> This is a personal project, maintained for my own reading. Plugins may break when a site
> changes, and fixes depend on my free time. Most of the code was written with the help of AI
> (Claude Code) and tested by me on my own device.

## Contents

- [Install](#install)
- [Plugins](#plugins)
  - [轻小说文库 (wenku8)](#轻小说文库-wenku8)
  - [嗶哩輕小說(繁體) (linovelib)](#嗶哩輕小說繁體-linovelib)
  - [爱下电子书 (ixdzs8)](#爱下电子书-ixdzs8)
  - [全本小说网 (quanben)](#全本小说网-quanben)
  - [小說543 (novel543)](#小說543-novel543)
- [Tracking with MyAnimeList](#tracking-with-myanimelist)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

## Install

1. Add this repository to the app:
   - **Nekori:** go to **More → Settings → Browse → Novel extension repos**, tap **Add** and paste
     the URL below.
   - **LNReader:** go to **Browse → Repositories**, tap **Add** and paste the URL below.

   ```
   https://raw.githubusercontent.com/Thsss3341/Ths-LNovel/plugins/v1.0.0/.dist/plugins.min.json
   ```

2. Find the plugins in the app's plugin list (Chinese) and install the ones you want.
3. For **轻小说文库** and **小說543**, open the plugin once in its WebView (the globe icon) to pass
   the site's Cloudflare check. 轻小说文库 also needs you to log in there; see
   [轻小说文库 (wenku8)](#轻小说文库-wenku8).

The linovelib, ixdzs8, quanben and novel543 plugins have their own IDs, so they can be installed
next to the community repository's plugins for the same sites.

## Plugins

### 轻小说文库 (wenku8)

Japanese light novels translated into Simplified Chinese.

- **Needs a wenku8 account.** wenku8 now sends visitors who aren't logged in to its login page,
  and it sits behind Cloudflare. Open the plugin's WebView, pass the Cloudflare check, and log in
  to wenku8 there. The plugin reuses that login.
- **Browse** the site's tabs and rankings: 热门轻小说, 动画化作品, 今日更新, 新书一览, **完结全本**,
  轻小说列表, and the 排行榜, 推荐榜, 总收藏榜 and 字数排行 rankings.
- **Chapters by volume (卷)**, with illustrations.
- **Search in Simplified Chinese** (e.g. 无职转生); the site's titles are simplified. wenku8 allows
  one search every 5 seconds.
- **Easy MAL tracking.** See [Tracking with MyAnimeList](#tracking-with-myanimelist).
- **Stays under the site's rate limit.** Loading pages too fast gets you blocked for a few
  minutes (Cloudflare "Error 1015"), so the plugin spaces its requests about 3 seconds apart.
  Downloading many chapters is slow (about 20 a minute) but doesn't get blocked.
- Novels the site withdrew for copyright reasons (因版权问题) open with a note and no chapters.

### 嗶哩輕小說(繁體) (linovelib)

Light novels in Traditional Chinese.

- **Chapters in the right order.** The site shuffles the paragraphs of every chapter after the
  20th and puts them back in order only in a browser. The plugin does the same.
- **Title search works again.** The site removed its own search, so the plugin searches a list of
  every novel that is rebuilt daily. Search in Traditional or Simplified Chinese, or by author:
  `史莱姆` and `史萊姆` both find 關於我轉生變成史萊姆這檔事. A novel's URL or number (e.g.
  `https://tw.linovelib.com/novel/3095.html` or `3095`) opens it directly, including novels added
  since the last rebuild.
- **Browse** the rankings, **完結全本**, or filter the full list by **狀態** (e.g. 已經完本),
  **動畫化**, **類型** and **字數**, sorted by the chosen ranking.
- **Finds hidden chapters.** Some chapters have no link in the table of contents; the plugin
  reaches them through the chapter before.
- **Easy MAL tracking.** See [Tracking with MyAnimeList](#tracking-with-myanimelist).

### 爱下电子书 (ixdzs8)

Chinese web novels (起点 and others). Of the web novel sources here, it has the most titles.

- **Browse** 热门排行, 全本完结 and 最近更新, or a **分类**, narrowed by **状态** (连载中/已完结),
  **排序** (最新/最热) and **字数**.
- **Passes the site's own security check** by itself.
- **Unfinished chapters.** For some books, the newest chapters are only a placeholder
  (「手打中！请稍后刷新！」). These show an error instead of being saved, so try them again later.

### 全本小说网 (quanben)

Chinese web novels; fewer titles, but often complete ones.

- **Browse** the home page or a **分类**.
- **Complete chapter lists.** The site's own list skips some chapters; the plugin fills them in
  (named 第N章).
- **Retries dropped connections.** The site drops a fair share of requests, so the plugin tries
  each up to three times.

### 小說543 (novel543)

Chinese web novels in Traditional Chinese. Some books here go further than on the other sites,
e.g. 《玄幻：我！天命大反派》 by 天命反派, to about chapter 1,490.

- **Behind Cloudflare.** Open the plugin's WebView once to pass the check, and again when the
  plugin says the check has expired.
- **Searching by title** triggers a stricter Cloudflare check than browsing. If it fails, search
  with the novel's URL or its 10-digit ID instead, e.g. `0520109072`.
- **Browse** 首頁推薦 or the 書庫 by **分類**, **狀態** (連載/完結) and **頻道** (男生/女生).
- **Long chapters** span several pages on the site; the plugin joins them into one.
- Chapters the site can't show (「章節錯誤」) show an error instead of an empty page.

> [!TIP]
> The same title can be a different book on each site; check the author. For example,
> 「玄幻：我！天命大反派」 on 全本小说网 is by 罗昼, while 爱下电子书 and 小說543 have the one by 天命反派.

## Tracking with MyAnimeList

This works in **轻小说文库** and **嗶哩輕小說(繁體)**. MyAnimeList's search can't find Chinese titles, so
when you open a novel, the plugin looks it up and adds its MAL entry to the top of the description:

```
MAL：Mushoku Tensei: Isekai Ittara Honki Dasu
id:70261
日文名：無職転生 ～異世界行ったら本気だす～
英文名：Mushoku Tensei: Jobless Reincarnation
```

**To track a novel:** long-press the `id:70261` line, copy it, and paste it into the MAL tracker's
search. Searching `id:` plus a number finds exactly that entry.

**How a match is found:** the plugin searches [Bangumi](https://bgm.tv) for the novel's Chinese
title to get its original Japanese title, then searches [AniList](https://anilist.co) with that for
the MAL ID and the romaji and English titles. For linovelib, it uses the title from the site's
Simplified Chinese edition, which is how Bangumi lists novels.

- **Exact match:** the titles are identical.
- **Likely match:** the title is only similar (a different translation), and either the author
  agrees or the titles differ in only a few characters, e.g. 败北女角太多了 and Bangumi's 败犬女主太多了.
  It is marked **⚠ 非精确匹配，可能不准确** (in linovelib: **⚠ 非精確匹配，可能不準確**); check the entry
  before tracking it.
- **No match:** the description is unchanged. This happens when the translated title is too
  different from Bangumi's, or when the novel isn't on MAL.
- **Bangumi only:** if AniList has no MAL ID, the description shows `MAL：未找到` with the Japanese
  title, which you can still search MAL for.

**Good to know:**

- The first lookup takes a few seconds. Exact matches are remembered for good; likely matches and
  misses are looked up again after a week.
- Novels already in your library get the MAL lines when you refresh them (pull down on the
  novel's page).
- To turn the lookup off, open the plugin's settings and switch off **简介中显示MAL标题和ID**
  (in linovelib: **簡介中顯示MAL標題和ID**).

## Updating

New versions appear in the app's plugin list as updates. Updating a plugin keeps your library.

## Troubleshooting

**`Cloudflare 验证已过期…` / `Cloudflare 驗證已過期…`**<br>
The site's Cloudflare check has expired. Open the plugin's WebView (the globe icon); it usually
passes the check by itself. Then go back and try again.

**轻小说文库: `需要登录…`**<br>
Your wenku8 login has expired. Log in again in the plugin's WebView.

**轻小说文库: `请求过快…` or Cloudflare "Error 1015"**<br>
wenku8 blocked you for loading too fast. Wait the time shown; the plugin sends nothing until then.

**轻小说文库: `轻小说文库限制两次搜索间隔不少于 5 秒…`**<br>
wenku8 allows one search every 5 seconds. Wait a moment and search again.

**轻小说文库: a search finds nothing**<br>
Search with the Simplified Chinese title (无职转生, not 無職轉生).

**轻小说文库: "Unable to load novel" (LNReader) or a note about 因版权问题**<br>
wenku8 withdrew this novel for copyright reasons; it has no chapters.

**嗶哩輕小說: `嗶哩輕小說只回傳了部分章節內容…`**<br>
The site sent a shortened chapter, which it does for visitors it takes for bots. Open the site's
home page in the plugin's WebView, then try again.

**嗶哩輕小說: `無法下載搜尋索引…`**<br>
The search list couldn't be downloaded. Try again later, or search with the novel's URL or number.

**爱下电子书: `爱下电子书还没有这一章的内容（手打中）…`**<br>
The site hasn't filled in this chapter yet. Try again later, or read it on another site.

**爱下电子书: `爱下电子书的安全验证没有通过…`**<br>
Open the chapter in the plugin's WebView, then go back and try again.

**全本小说网: a page fails to load**<br>
The site drops connections now and then. Pull down to retry.

**小說543: `小說543 暫時沒有這一章的內容（章節錯誤）…`**<br>
The site can't show this chapter at the moment. Try again later, or read it on another site.

**小說543: title search fails with the Cloudflare message**<br>
Open the plugin's WebView and search on the site once, or search with the novel's URL or ID.

**Adding the repository fails**<br>
Check that the URL was pasted exactly as shown in [Install](#install).

**Something else doesn't work**<br>
Open an [issue](https://github.com/Thsss3341/Ths-LNovel/issues) with the plugin, the novel and
what happened.

## Credits

- Built on the tooling of the community
  [LNReader/lnreader-plugins](https://github.com/LNReader/lnreader-plugins) repository; the
  linovelib, ixdzs8, quanben and novel543 plugins are rewrites of its plugins for those sites.
- MAL titles and IDs via [Bangumi](https://bgm.tv) and [AniList](https://anilist.co).
- Not affiliated with any of the sites above, LNReader or Nekori. Licensed under the
  [MIT License](LICENSE).

Building, publishing and adding plugins are described in
[.github/MAINTAINING.md](.github/MAINTAINING.md).
