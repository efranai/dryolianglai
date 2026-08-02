# 台中質子治療・放射治療｜賴宥良醫師

靜態衛教網站。原始內容寫在 `content/*.md`，經由 `npm run build` 產生 HTML，
**建置後的 HTML 會一起提交進 repo**，因此 GitHub Pages 與 Cloudflare Pages 都不需要執行建置。

---

## 目錄結構

```
content/*.md        文章原始檔（Markdown，你只需要動這裡）
content/_about.md   首頁「關於賴宥良醫師」的內文（底線開頭＝不是文章，不會產生卡片）
scripts/build.mjs   產生器
site.config.json    站台設定、專業領域、掛號連結、圖片授權標示、Supabase 設定
assets/             CSS / JS / 圖片
index.html          ← 產生
p/<slug>/index.html ← 產生（每篇文章的獨立網址）
404.html sitemap.xml robots.txt  ← 產生
```

## 常見的修改位置

| 想改什麼 | 改哪裡 |
|---|---|
| 首頁五行主標文字 | `site.config.json` 的 `title` / `affiliation` / `credential` / `tagline` / `subTagline` |
| 「關於賴宥良醫師」內文 | `content/_about.md` |
| 專業領域標籤 | `site.config.json` 的 `specialties` 陣列 |
| 掛號連結 | `site.config.json` 的 `appointmentUrl`（頁首按鈕與關於區塊共用同一個值） |
| 首頁主視覺 | `assets/img/hero-doctor.jpg`，尺寸設定在 `site.config.json` 的 `hero.banner` |

## 新增一篇文章

1. 在 `content/` 新增一個 `.md` 檔，開頭放 front matter：

```markdown
---
title: 文章標題
slug: url-slug            # 網址會是 /p/url-slug/
date: 2026-08-02          # 發布日期
summary: 一到兩句摘要，會顯示在首頁卡片與搜尋結果。
tags: 質子治療, 副作用     # 逗號分隔，可省略
hero: assets/img/xxx.jpg  # 可省略；會等比例縮放，寬度不超過內文寬度
heroAlt: 圖片替代文字
heroCaption: 圖說
---

正文從這裡開始，用 Markdown 撰寫。
```

2. 執行建置：

```bash
npm run build
```

3. 提交並推送。首頁卡片會自動新增、重新排序（最新的在前）。

## 關於日期

- **發布日期**取自 front matter 的 `date`。
- **最後更新日期**依序這樣判斷：
  1. front matter 的 `updated:`（手動指定，優先）
  2. 該檔案有未提交的修改 → 用今天
  3. git 最後一次提交該檔案的時間
  4. 檔案 mtime

改過的文章，卡片會多顯示「更新於 ⋯」。
若不希望某次小修改改變顯示日期，在 front matter 手動寫 `updated: 原本的日期` 即可固定。

## 文章排序

`site.config.json` 的 `articleOrder` 決定首頁卡片順序，填 slug：

```json
"articleOrder": [
  "what-is-radiation-therapy",
  "what-is-proton-therapy",
  "who-is-suitable-for-proton-therapy",
  "side-effects-and-quality-of-life"
]
```

- 列在裡面的，照這個順序排（建議的閱讀動線）
- **沒列到的接在後面**，依最後更新時間新到舊
- 整個清單留空 `[]`，就全部回到依更新時間排序

排序寫在設定檔而不是 front matter，是為了避免調整順序時動到 `.md` 檔 ——
一旦檔案被修改，git 會認定文章有更新，顯示的更新日期就會全部跳成當天。

文章頁底部的「上一篇／下一篇」會跟著這個順序走，所以調整 `articleOrder`
等於同時調整了讀者的閱讀動線。

## 本機預覽

```bash
npm install
npm run build
npm run serve
```

## 瀏覽計數器（Supabase）

程式碼已完成，只要填入設定就會啟用；**未設定時計數器自動隱藏**，不會出現壞掉的畫面。

### 1. 在 Supabase SQL Editor 執行

```sql
create table if not exists public.page_views (
  slug  text primary key,
  views bigint not null default 0
);

alter table public.page_views enable row level security;

-- 任何人都可以讀取次數
create policy "page_views read" on public.page_views
  for select using (true);

-- 只能透過下面這個函式累加，不能直接寫入任意數字
create or replace function public.increment_view(p_slug text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare n bigint;
begin
  insert into public.page_views (slug, views)
  values (p_slug, 1)
  on conflict (slug) do update set views = page_views.views + 1
  returning views into n;
  return n;
end;
$$;

grant execute on function public.increment_view(text) to anon;
```

### 2. 填入 `site.config.json`

```json
"supabase": {
  "url": "https://xxxxxxxx.supabase.co",
  "anonKey": "eyJhbGci...",
  "table": "page_views",
  "rpc": "increment_view"
}
```

`anon` key 本來就是設計成公開嵌在前端的，不是密鑰。真正的保護來自上面的 RLS 政策。

### 3. 重新建置並推送

```bash
npm run build
```

首頁卡片、文章頁、以及頁尾的全站計數會同時生效。
同一個瀏覽階段內重整不會重複計數。

## 部署

- **GitHub Pages**：由 repo 根目錄直接提供服務（`.nojekyll` 已加入，避免 Jekyll 處理）。
- **Cloudflare Pages**：以 Git 整合連接本 repo，建置指令留空、輸出目錄設為 `/`。
  每次 push 兩邊都會自動更新。

## 圖片授權

首頁與文章使用的圖片皆取自 Wikimedia Commons，授權資訊統一維護在
`site.config.json` 的 `credits` 陣列，建置時自動輸出到每一頁的頁尾。
新增圖片請一併補上該筆授權資料。
