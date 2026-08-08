/**
 * 靜態網站產生器
 *
 * 讀 content/*.md，輸出：
 *   index.html          首頁（文章卡片直接寫死在 HTML 裡，不靠 JS）
 *   p/<slug>/index.html 每篇文章各自的網址
 *   404.html
 *   sitemap.xml / robots.txt
 *
 * 更新日期的取得順序：
 *   1. front matter 的 updated:（手動指定，優先度最高）
 *   2. 檔案有未提交的修改 → 用今天
 *   3. git 最後一次提交該檔的時間
 *   4. 檔案 mtime
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import QRCode from 'qrcode';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'content');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

/* 給人看的網址：去掉 https:// 與結尾斜線，印在卡片或壓在圖上都比較乾淨 */
const urlText = (u) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');

/* 自繪的 SVG 插圖一律直接內嵌，而非用 <img> 外部引用，
   否則 SVG 讀不到頁面的 CSS 變數，深色模式與配色都會失效。 */
const svgCache = new Map();
function inlineSvg(relPath) {
  if (!svgCache.has(relPath)) {
    const raw = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
      .replace(/<\?xml[^>]*\?>\s*/, '')
      .trim();
    svgCache.set(relPath, stampSource(raw));
  }
  return svgCache.get(relPath);
}

/* 在插圖右下角壓上來源網址。
   圖被截圖轉貼到 LINE 群組或社團時，出處會跟著一起走——這是導流與辨識，
   不是版權主張，所以只寫網址、不寫 ©。

   做法是把 viewBox 往下加高一條空白帶再放文字，而不是疊在原本的畫面上：
   每張圖的底部構圖都不一樣，疊上去遲早會撞到圖說。加高就永遠不會撞，
   以後新畫的圖也自動適用。圖示 sprite（沒有 .illus）不處理。 */
/* 空白帶要夠高：窄螢幕時字級全部放大，有幾張圖的底部圖說本來就貼著畫布
   下緣，加高不夠會被浮水印撞到（順帶一提，那幾張圖的文字descender 原本
   就被畫布裁掉了一點，加高之後反而正常了）。 */
const SRC_STRIP = 34;

function stampSource(svg) {
  if (!/class="illus"/.test(svg)) return svg;

  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!m) return svg;

  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  const stamp = `  <text class="il-src" x="${w - 4}" y="${h + 26}">${esc(urlText(CONFIG.siteUrl))}</text>\n`;

  return svg
    .replace(m[0], `viewBox="0 0 ${w} ${h + SRC_STRIP}"`)
    .replace(/\s*<\/svg>\s*$/, `\n${stamp}</svg>`);
}

/* 在文章內文中插入自繪插圖的寫法：
     <!--svg:assets/img/xxx.svg|圖說文字-->
   （用 HTML 註解當標記，Markdown 會原樣輸出，再於這裡換成內嵌的 <figure>）*/
const SVG_TOKEN = /<!--\s*svg:\s*([^|\s]+?)\s*(?:\|\s*([\s\S]*?))?\s*-->/g;

/* 版面元件巨集。在 Markdown 裡用成對的 HTML 註解標記，中間照常寫 Markdown：
 *
 *   <!--box:重點先看-->  …清單…  <!--/box-->        重點提示框
 *   <!--cards-->                                     並排資訊卡容器
 *     <!--card:手術|需要麻醉與住院-->  …  <!--/card-->
 *   <!--/cards-->
 *   <!--faq-->                                       常見問題（可摺疊）
 *     <!--q:問題？-->  …答案…  <!--/q-->
 *   <!--/faq-->
 *   <!--secondopinion:這個決定通常會…-->            「這篇不是第二意見」提醒框
 *
 * 標記本身會被 Markdown 原樣輸出，這裡再換成對應的 HTML 標籤。
 */

/* 「這篇不是第二意見」：放在會被拿去和主治醫師爭論的文章裡。
   固定四段寫死在這裡，改一次全站同步；冒號後可帶一句該篇專屬的補充。 */
const SECOND_OPINION = (extra) =>
  `<aside class="notmine">
    <p class="notmine__title">這篇不是第二意見</p>
    <p>每個人的病情都不一樣——影像、病理、淋巴結、身體狀況、過去病史。<strong>一篇衛教文章不可能涵蓋所有情況。</strong></p>
    <p>這篇寫的是一般性的原則。<strong>您的主治醫師手上有您的完整資料，那是這篇看不到的。如果兩者不同，請以您的主治醫師為準。</strong></p>
    <p>門診能講的時間總是有限。這篇的用途是讓您<strong>先有個底</strong>，回家之後也能把沒聽進去的補起來——<strong>而不是讓您在網路上愈查愈怕。</strong></p>${
      extra ? `\n    <p class="notmine__extra">${esc(extra)}</p>` : ''}
  </aside>`;

const MACROS = [
  [/<!--\s*box:\s*([^>]*?)\s*-->/g, (_, t) => `<aside class="keybox"><p class="keybox__title">${esc(t)}</p>`],
  [/<!--\s*\/box\s*-->/g, () => '</aside>'],

  [/<!--\s*cards\s*-->/g, () => '<div class="infocards">'],
  [/<!--\s*\/cards\s*-->/g, () => '</div>'],
  [/<!--\s*card:\s*([^|>]*?)\s*(?:\|\s*([^>]*?))?\s*-->/g, (_, t, s) =>
    `<div class="infocard"><p class="infocard__head"><span class="infocard__title">${esc(t)}</span>` +
    (s ? `<span class="infocard__sub">${esc(s)}</span>` : '') + '</p>'],
  [/<!--\s*\/card\s*-->/g, () => '</div>'],

  [/<!--\s*faq\s*-->/g, () => '<div class="faq">'],
  [/<!--\s*\/faq\s*-->/g, () => '</div>'],
  [/<!--\s*q:\s*([^>]*?)\s*-->/g, (_, q) =>
    `<details class="faq__item"><summary class="faq__q">${esc(q)}</summary><div class="faq__a">`],
  [/<!--\s*\/q\s*-->/g, () => '</div></details>'],

  [/<!--\s*secondopinion:?\s*([^>]*?)\s*-->/g, (_, extra) => SECOND_OPINION(extra)],
];

function renderBody(body) {
  let html = md.render(body).replace(SVG_TOKEN, (_, src, caption) =>
    `<figure class="prose-figure prose-figure--illus">${inlineSvg(src)}` +
    (caption ? `<figcaption>${esc(caption.trim())}</figcaption>` : '') +
    `</figure>`
  );
  for (const [re, fn] of MACROS) html = html.replace(re, fn);
  return html;
}

/* CSS 與 JS 的網址帶上內容雜湊。檔案一改網址就變，
   瀏覽器與 CDN 的舊快取自動失效，不必再手動清快取或按 Ctrl+F5。 */
function assetVersion(relPath) {
  return createHash('sha1').update(fs.readFileSync(path.join(ROOT, relPath))).digest('hex').slice(0, 8);
}
const V_CSS = assetVersion('assets/css/style.css');
const V_JS = assetVersion('assets/js/counter.js');
const V_SHARE = assetVersion('assets/js/share.js');
const V_RAIL = assetVersion('assets/js/rail.js');

/* Search Console / Bing 的所有權驗證標籤，沒填就完全不輸出 */
const VERIFY_TAGS = [
  CONFIG.verification?.google && `<meta name="google-site-verification" content="${esc(CONFIG.verification.google)}">`,
  CONFIG.verification?.bing && `<meta name="msvalidate.01" content="${esc(CONFIG.verification.bing)}">`,
].filter(Boolean).map((t) => t + '\n').join('');

const BANNER = CONFIG.hero.banner;
const ORDER = Array.isArray(CONFIG.articleOrder) ? CONFIG.articleOrder : [];

/* 首頁的結構化資料：把「賴宥良」這個人、他的服務單位與這個網站綁在一起，
   讓搜尋引擎在處理人名查詢時有明確的實體訊號可用。
   文章頁的 author 會以 @id 指回同一個人。 */
const PERSON_ID = `${CONFIG.siteUrl}/#person`;

/* 同一個 Person 物件在首頁與 /about/ 各出現一次（同一個 @id），
   讓搜尋引擎不論從哪一頁進來都能認出是同一個人。 */
const personNode = () => ({
  '@type': 'Person',
  '@id': PERSON_ID,
  name: CONFIG.author.replace(/醫師$/, ''),
  alternateName: CONFIG.author,
  jobTitle: '放射腫瘤科醫師',
  url: `${CONFIG.siteUrl}/`,
  mainEntityOfPage: `${CONFIG.siteUrl}/about/`,
  image: `${CONFIG.siteUrl}/${BANNER.src}`,
  description: `${CONFIG.credential}。${CONFIG.tagline}`,
  worksFor: { '@type': 'MedicalOrganization', name: CONFIG.affiliation },
  knowsAbout: CONFIG.specialties.map((s) => s.zh),
  sameAs: [CONFIG.appointmentUrl],
});

function homeJsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      personNode(),
      {
        '@type': 'WebSite',
        '@id': `${CONFIG.siteUrl}/#website`,
        name: CONFIG.title,
        url: `${CONFIG.siteUrl}/`,
        inLanguage: CONFIG.lang,
        publisher: { '@id': PERSON_ID },
      },
    ],
  }, null, 2);
}

/* 圖示以 <symbol> 集中維護，內嵌後用 <use> 引用，避免每個圖示各發一次請求 */
const ICON_SPRITE = inlineSvg('assets/img/icons.svg');
const icon = (id, cls = 'icon') =>
  `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#${esc(id)}"/></svg>`;

/* 學經歷。只出現在 /about/，首頁不放。 */
const ABOUT_CV = (() => {
  const p = path.join(ROOT, 'content', '_about-cv.md');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split(/^## +/m).filter(Boolean).map((chunk) => {
    const nl = chunk.indexOf('\n');
    return { title: chunk.slice(0, nl).trim(), html: md.render(chunk.slice(nl).trim()) };
  });
})();

/* 「關於」區塊的內文獨立成 content/_about.md，改文字不必動程式碼。
   第一個 ## 之前的內容當導言，之後每個 ## 各自成為一張卡片。 */
function loadAbout() {
  const raw = fs.readFileSync(path.join(ROOT, 'content', '_about.md'), 'utf8');
  const chunks = raw.split(/^## +/m);
  const lead = md.render(chunks.shift().trim());
  const cards = chunks.map((chunk, i) => {
    const nl = chunk.indexOf('\n');
    return {
      title: chunk.slice(0, nl).trim(),
      html: md.render(chunk.slice(nl).trim()),
      icon: CONFIG.about.cardIcons[i] || CONFIG.about.cardIcons[0],
    };
  });
  return { lead, cards };
}

/* 社群分享縮圖：用首頁橫幅 */
const DEFAULT_OG = BANNER.src;

/* ---------- 工具 ---------- */

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
           .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const GIT_AVAILABLE = git(['rev-parse', '--is-inside-work-tree']) === 'true';

function lastModified(absPath, frontMatterUpdated, published) {
  if (frontMatterUpdated) return new Date(frontMatterUpdated);

  if (GIT_AVAILABLE) {
    const rel = path.relative(ROOT, absPath).split(path.sep).join('/');
    // 有未提交的異動 → 當作今天剛改過
    if (git(['status', '--porcelain', '--', rel])) return new Date();
    // 只有一次提交 → 從發布後就沒動過，更新日期即發布日期
    const commits = Number(git(['rev-list', '--count', 'HEAD', '--', rel]));
    if (commits <= 1) return published;
    const iso = git(['log', '-1', '--format=%cI', '--', rel]);
    if (iso) return new Date(iso);
  }
  const mtime = fs.statSync(absPath).mtime;
  return mtime > published ? mtime : published;
}

const isoDate = (d) => new Date(d).toISOString().slice(0, 10);

function twDate(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日`;
}

function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: raw.slice(m[0].length) };
}

function writeFile(relPath, contents) {
  const abs = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf8');
  return relPath;
}

/* ---------- 讀文章 ---------- */

function loadArticles() {
  if (!fs.existsSync(CONTENT_DIR)) return [];

  return fs.readdirSync(CONTENT_DIR)
    // 底線開頭的檔案是頁面區塊（例如 _about.md），不是文章
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((file) => {
      const abs = path.join(CONTENT_DIR, file);
      const { data, body } = parseFrontMatter(fs.readFileSync(abs, 'utf8'));

      const slug = data.slug || file.replace(/\.md$/, '');
      if (!data.title) throw new Error(`${file}：front matter 缺少 title`);
      if (!data.date) throw new Error(`${file}：front matter 缺少 date`);

      const published = new Date(data.date);
      const updated = lastModified(abs, data.updated, published);

      return {
        slug,
        title: data.title,
        summary: data.summary || '',
        /* 摘要（summary）給讀者看，寫在卡片與文章開頭；
           description 只給搜尋結果的摘要用，可以寫得更長、更像「這篇能回答你什麼」。沒寫就沿用摘要。 */
        description: data.description || data.summary || '',
        tags: data.tags ? data.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
        author: data.author || CONFIG.author,
        /* answer 是給趕時間的人看的一句話結論，排在標題與插圖之前。
           病人常常只想知道「所以到底要不要」，不該逼他先讀完三段才拿到答案。 */
        answer: data.answer || '',
        hero: data.hero || '',
        heroAlt: data.heroAlt || '',
        heroCaption: data.heroCaption || '',
        published,
        updated,
        wasUpdated: isoDate(updated) !== isoDate(data.date),
        html: renderBody(body),
        url: `p/${slug}/`,
        series: (data.series || '').trim(),   // 空字串＝概論區
      };
    });
}

/* 排序：order 清單有列到的照該順序排，沒列到的接在後面依最後更新時間新到舊 */
function sortByOrder(list, order = []) {
  const rank = (x) => {
    const i = order.indexOf(x.slug);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b) || b.updated - a.updated || b.published - a.published);
}

/* ---------- 版型片段 ---------- */

function head({ title, description, canonical, depth, ogImage, noindex = false, base = '../'.repeat(depth) }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e171b" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="author" content="${esc(CONFIG.author)}">
${noindex ? '<meta name="robots" content="noindex, follow">\n' : ''}
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="zh_TW">
<meta property="og:site_name" content="${esc(CONFIG.title)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(CONFIG.siteUrl + '/' + (ogImage || DEFAULT_OG))}">
<meta name="twitter:card" content="summary_large_image">
${VERIFY_TAGS}<link rel="stylesheet" href="${base}assets/css/style.css?v=${V_CSS}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎗️</text></svg>">`;
}

function siteHeader(depth, base = '../'.repeat(depth)) {
  /* 首頁的 base 是空字串，href="" 會指回「目前這一頁」而不是首頁，所以補上 ./ */
  const home = base || './';
  /* 「跳到主要內容」：平常縮成 1×1 看不見，只有鍵盤 Tab 到它才會現形。
     沒有它的話，螢幕朗讀軟體每開一篇文章都要先唸完頁首和導覽才進正文。 */
  return `<a class="skip-link" href="#main">跳到主要內容</a>
<header class="site-header">
  <div class="wrap site-header__inner">
    <a class="brand" href="${home}" aria-label="回首頁">
      ${icon('i-home', 'brand__home')}
      <span class="brand__name">賴宥良醫師</span>
      <span class="brand__desc">質子治療・放射治療</span>
    </a>
    <nav class="site-nav">
      <a href="${home}#articles">文章</a>
      <a href="${base}about/">關於我</a>
    </nav>
  </div>
</header>`;
}

function creditsBlock() {
  const items = CONFIG.credits.map((c) => `      <li>
        <span class="credit__use">${esc(c.usedFor)}：</span>
        <a href="${esc(c.titleUrl)}" rel="noopener noreferrer" target="_blank">${esc(c.title)}</a>
        by <a href="${esc(c.authorUrl)}" rel="noopener noreferrer" target="_blank">${esc(c.author)}</a>,
        授權條款 <a href="${esc(c.licenseUrl)}" rel="license noopener noreferrer" target="_blank">${esc(c.license)}</a>
        <span class="credit__mod">（${esc(c.modified)}）</span>
      </li>`).join('\n');

  return `  <section class="credits" aria-labelledby="credits-heading">
    <h2 id="credits-heading" class="credits__heading">圖片出處與授權</h2>
    <ul class="credits__list">
${items}
    </ul>
    <p class="credits__note">上列圖片皆取自 Wikimedia Commons，依其授權條款標示原作者、授權方式與是否經過修改。</p>
  </section>`;
}

function siteFooter(depth, base = '../'.repeat(depth)) {
  return `<footer class="site-footer">
  <div class="wrap">
${creditsBlock()}
    <section class="disclaimer">
      <h2 class="credits__heading">免責聲明</h2>
      <p>本網站內容為一般性衛教資訊，目的在於協助民眾理解放射治療與質子治療的原則，<strong>無法取代專業醫療診斷與個別化的治療建議</strong>。任何治療決策，請與您的主治醫師充分討論後決定。</p>
    </section>
    <div class="site-footer__meta">
      <p class="site-footer__copy">© ${new Date().getFullYear()} ${esc(CONFIG.author)}．本站文字內容版權所有．<a href="${base}terms/">內容使用規範</a></p>
      <p class="site-footer__views">首頁瀏覽次數 <span class="views" data-slug="__site__" hidden><span class="views__n">–</span></span></p>
    </div>
  </div>
</footer>
<script>window.__COUNTER__=${JSON.stringify(CONFIG.counter)};</script>
<script src="${base}assets/js/counter.js?v=${V_JS}" defer></script>`;
}

/* 卡片：直接產生 HTML 字串寫進 index.html，不經過 JSON。
   base 用於從系列頁（深兩層）連回文章。 */
function articleCard(a, base = '') {
  const tags = a.tags.length
    ? `      <ul class="card__tags">${a.tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>\n`
    : '';

  const updatedLine = a.wasUpdated
    ? `<span class="card__sep" aria-hidden="true">·</span><span class="card__updated">更新於 <time datetime="${isoDate(a.updated)}">${twDate(a.updated)}</time></span>`
    : '';

  return `      <article class="card">
        <a class="card__link" href="${base}${a.url}">
          <h3 class="card__title">${esc(a.title)}</h3>
        </a>
        <p class="card__meta">
          <time class="card__date" datetime="${isoDate(a.published)}">${twDate(a.published)}</time>
          ${updatedLine}
        </p>
        <p class="card__summary">${esc(a.summary)}</p>
${tags}        <p class="card__foot">
          <span class="card__author">${esc(a.author)}</span>
          <span class="views" data-slug="${esc(a.slug)}" hidden>閱讀 <span class="views__n">–</span></span>
        </p>
      </article>`;
}

/* 「關於」的共用片段：首頁只用 intro／lead／foot，/about/ 用全部 */
const PORTRAIT = { src: 'assets/img/portrait.jpg' };

const ABOUT_NOTE = `      <p class="prose__note about__note">網站內容為一般性衛教資訊，無法取代面對面的診療。若您有具體的病情問題，請於門診與您的主治醫師討論。</p>`;

/* 門診時間排成週次表格：病人在醫院看到的就是這個樣子，比條列好認。
   用真正的 <table>，欄列表頭有 scope，報讀軟體才唸得出「週四・下午」。
   有診的格子塗色，沒診的留空——留空比畫叉子安靜，掃視時對比也夠。 */
/* 兩個院區各給一個色票（依 legend 的順序），因為週三要跑水湳——
   那不是裝飾，是病人真的會走錯的地方。色票在深色模式會自動反轉，
   文字一律用 var(--bg)，所以淺色是白字深底、深色是深字亮底，兩邊都夠對比。 */
function clinicTableHtml() {
  const C = CONFIG.about.clinicHours;
  const tone = new Map(C.legend.map((l, i) => [l.short, `clinic__on--${'ab'[i] || 'a'}`]));
  const head = C.days.map((d) => `<th scope="col">${esc(d)}</th>`).join('');
  const body = C.rows.map((r) => `            <tr>
              <th scope="row">${esc(r.label)}</th>
${r.cells.map((cell) => `              <td class="${cell ? `clinic__on ${tone.get(cell) || ''}` : 'clinic__off'}">${esc(cell)}</td>`).join('\n')}
            </tr>`).join('\n');
  return `      <div class="clinic-card">
        <table class="clinic">
          <caption class="sr-only">門診時間表</caption>
          <thead>
            <tr><td></td>${head}</tr>
          </thead>
          <tbody>
${body}
          </tbody>
        </table>

        <ul class="clinic__legend">
${C.legend.map((l, i) => `          <li><span class="clinic__key clinic__key--${'ab'[i] || 'a'}">${esc(l.short)}</span>${esc(l.full)}</li>`).join('\n')}
        </ul>
      </div>

      <p class="clinic__note">${esc(C.note)}</p>`;
}

function aboutFootHtml() {
  const A = CONFIG.about;
  /* 看診資訊寫成一則資訊列，不做成行動呼籲按鈕：這裡是衛教網站，
     不是掛號入口。院所相關的字句集中在 CONFIG.about，換單位時只改設定檔。 */
  const clinic = `          <li class="info-item">
            ${icon('i-calendar', 'info-item__icon')}
            <span class="info-item__text"><a href="${esc(CONFIG.appointmentUrl)}" target="_blank" rel="noopener noreferrer">${esc(A.clinicLinkLabel)}</a></span>
          </li>`;
  const rest = A.infoItems.map((it) => `          <li class="info-item">
            ${it.icon ? icon(it.icon, 'info-item__icon') : ''}
            <span class="info-item__text">${it.lines.map(esc).join('<br>')}</span>
          </li>`);
  return `      <div class="about__foot">
        <ul class="info-items">
${[clinic, ...rest].join('\n')}
        </ul>
      </div>`;
}

/* 每個可分享的網址在建置時就先產生 QR Code，直接內嵌成 SVG：
   純向量，放大或列印都不會糊，讀者端也不必載入任何函式庫。
   版型函式是同步的，所以主流程會先把用得到的網址全部產好放進這個 Map。
   顏色固定黑白：反相的 QR 在不少掃描器上讀不到，所以深色模式一樣是白底。 */
const qrCache = new Map();

async function warmQr(urls) {
  for (const url of urls) {
    if (qrCache.has(url)) continue;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
    qrCache.set(url, svg.replace('<svg ', '<svg class="qr__code" role="img" aria-label="這一頁網址的 QR Code" '));
  }
}

/* 麵包屑。trail 的每一項是 { name, href, url }，最後一項是目前這頁，不給 href。
   href 供畫面上的連結用，url 是絕對網址，給結構化資料用。 */
function breadcrumb(trail) {
  const items = trail.map((c) => c.href
    ? `<li class="crumbs__item"><a href="${esc(c.href)}">${esc(c.name)}</a></li>`
    : `<li class="crumbs__item" aria-current="page"><span class="crumbs__now">${esc(c.name)}</span></li>`).join('');

  return `    <nav class="crumbs" aria-label="您在這裡">
      <ol class="crumbs__list">${items}</ol>
    </nav>`;
}

function breadcrumbJsonLd(trail) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

/* 回首頁的按鈕。文章看完之後最明顯的出口，
   左上角的站名雖然也能回首頁，但不是每位讀者都會發現。 */
function backHome(base, label = '回首頁看更多文章') {
  return `    <p class="article-back">
      <a class="backhome" href="${base}">${icon('i-home', 'backhome__icon')}<span>${esc(label)}</span></a>
    </p>`;
}

/* 文章結尾的兩個出口。
   病人多半只想先看自己的癌別，所以回系列頁排在前面、做成實心主按鈕；
   上下篇一次只看得到兩篇，系列超過三篇之後就不夠用了。 */
function articleFooterNav(base, seriesDef) {
  const toSeries = seriesDef
    ? `      <a class="backhome backhome--primary" href="${base}series/${esc(seriesDef.id)}/">${icon('i-list', 'backhome__icon')}<span>看更多${esc(seriesDef.name)}</span></a>\n`
    : '';

  return `    <p class="article-back">
${toSeries}      <a class="backhome" href="${base}">${icon('i-home', 'backhome__icon')}<span>回首頁</span></a>
    </p>`;
}

/* 分享列。
   全部走各平台的公開分享網址，不載入任何第三方 SDK——不追蹤讀者，也不會拖慢頁面。
   Instagram 沒有提供網頁分享網址（官方就是沒有這個東西），
   所以 IG 靠兩條路：手機上的「分享…」會叫出系統分享選單（裡面就有 IG），
   桌機則用「複製連結」自己貼。 */
function shareBlock({ url, title, heading = '覺得有幫助嗎？分享給需要的人', qrHint, qr = true, qrName = '', base = '' }) {
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(`${title}｜${CONFIG.author}`);

  /* [名稱, 分享網址, 修飾類別]。品牌色寫在 CSS 裡（深色模式要換一組），
     沒給類別的（X、Threads）沿用內文顏色，黑色標誌在深色底才不會看不見 */
  const targets = [
    ['LINE', `https://social-plugins.line.me/lineit/share?url=${u}`, 'line'],
    ['Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`, 'fb'],
    ['X', `https://twitter.com/intent/tweet?url=${u}&text=${t}`, ''],
    ['Threads', `https://www.threads.net/intent/post?text=${t}%20${u}`, ''],
  ];

  const links = targets.map(([name, href, mod]) =>
    `        <a class="share__btn${mod ? ` share__btn--${mod}` : ''}" href="${esc(href)}"
           target="_blank" rel="noopener noreferrer">${esc(name)}</a>`).join('\n');

  return `    <aside class="share" aria-labelledby="share-heading" data-share-url="${esc(url)}" data-share-title="${esc(title)}｜${esc(CONFIG.author)}">
      <p class="share__heading" id="share-heading">${esc(heading)}</p>
      <div class="share__row">
        <button class="share__btn share__btn--native" type="button" hidden>
          ${icon('i-share', 'share__icon')}<span>分享…</span>
        </button>
${links}
        <button class="share__btn share__btn--copy" type="button">
          ${icon('i-link', 'share__icon')}${icon('i-check', 'share__icon share__icon--done')}<span class="share__copy-text">複製連結</span>
        </button>
      </div>
      <p class="share__status" role="status" aria-live="polite"></p>
${qr ? `
      <section class="qr" aria-labelledby="qr-heading">
        <p class="qr__heading" id="qr-heading">當面分享</p>
        <div class="qr__panel">
          <div class="qr__frame">${qrCache.get(url) || ''}</div>
          <div class="qr__text">
${qrName ? `            <p class="qr__name">${esc(qrName)}</p>\n` : ''}            <p class="qr__hint">${esc(qrHint || '請對方用手機相機掃描，或直接輸入下面的網址。')}</p>
            <p class="qr__url"><a href="${esc(url)}">${esc(urlText(url))}</a></p>
            <p class="qr__more">
              <a href="${base}qr/">${icon('i-qr', 'qr__more-icon')}<span>各癌別專區的 QR Code</span><span aria-hidden="true">→</span></a>
            </p>
          </div>
        </div>
      </section>` : ''}
    </aside>`;
}


/* 文章結尾的作者卡片：讀完文章之後，讓讀者有路徑認識作者、以及掛號 */
function authorCard(base) {
  return `    <aside class="authorcard">
      <img class="authorcard__photo" src="${base}${esc(PORTRAIT.src)}" alt="${esc(CONFIG.author)}"
           width="360" height="360" loading="lazy" decoding="async">
      <div class="authorcard__body">
        <p class="authorcard__name">${esc(CONFIG.author)}</p>
        <p class="authorcard__role">${esc(CONFIG.affiliation)}</p>
        <p class="authorcard__links">
          <a href="${base}about/">認識賴宥良醫師 <span aria-hidden="true">→</span></a>
        </p>
      </div>
    </aside>`;
}

/* 卡片列尾端的「看全部」卡。手機把標題旁的 pill 收起來，改由這張卡承接，
   滑到底自然會看到，垂直方向不多佔一行。 */
function moreCard(s) {
  const label = s.articles.length > 1 ? `看全部 ${s.articles.length} 篇` : '進入專區';
  return `      <article class="card card--more">
        <a class="card__link" href="series/${esc(s.id)}/">
          <span class="card--more__label">${esc(label)}</span>
          <span class="card--more__arrow" aria-hidden="true">→</span>
        </a>
      </article>`;
}

/* 橫滑卡片列。左右各一個箭頭鈕與淡出漸層，只有真的捲得動時才由 rail.js 打開；
   沒有 JS 也還是能用觸控或滾輪橫捲。 */
function rail(inner) {
  return `    <div class="rail">
      <button class="rail__btn rail__btn--prev" type="button" aria-label="看前面的文章" hidden>
        <span aria-hidden="true">←</span>
      </button>
      <div class="cards cards--rail">
${inner}
      </div>
      <button class="rail__btn rail__btn--next" type="button" aria-label="看後面的文章" hidden>
        <span aria-hidden="true">→</span>
      </button>
    </div>`;
}

/* 首頁上的一個癌別系列區塊：標題 + 一句話 + 橫滑卡片列 + 看全部連結 */
function seriesSection(s) {
  const body = s.articles.length
    ? rail([...s.articles.map((a) => articleCard(a)), moreCard(s)].join('\n'))
    : `    <p class="group-empty">這個系列的文章正在整理中，敬請期待。</p>`;

  return `  <section class="wrap section" id="series-${esc(s.id)}" aria-labelledby="series-${esc(s.id)}-heading">
    <div class="group-head">
      <div class="group-head__text">
        <h2 class="section__heading" id="series-${esc(s.id)}-heading">${esc(s.name)}</h2>
        <p class="group-head__hook">${esc(s.hook)}</p>
      </div>
${s.articles.length ? `      <a class="group-head__go" href="series/${esc(s.id)}/">${
    /* 只有一篇時「看全部 1 篇」等於在說「點了也沒東西」，改成邀請進專區 */
    s.articles.length > 1 ? `看全部 <b>${s.articles.length}</b> 篇` : '進入專區'
  } <span aria-hidden="true">→</span></a>\n` : ''}    </div>
${body}
  </section>`;
}

/* ---------- 頁面 ---------- */

function renderIndex(articles) {
  const cards = articles.map((a) => articleCard(a)).join('\n');
  const desc = CONFIG.metaDescription || `${CONFIG.tagline}${CONFIG.subTagline}`;
  const A = CONFIG.about;
  const about = loadAbout();

  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({ title: CONFIG.title, description: desc, canonical: CONFIG.siteUrl + '/', depth: 0 })}
<script type="application/ld+json">
${homeJsonLd()}
</script>
</head>
<body data-page-slug="__site__">
${ICON_SPRITE}
${siteHeader(0)}
<main id="main">

  <section class="hero">

    <div class="hero__banner">
      <img src="${esc(BANNER.src)}" alt="${esc(BANNER.alt)}"
           width="${BANNER.width}" height="${BANNER.height}"
           fetchpriority="high" decoding="async">
    </div>

    <div class="wrap hero__inner">

      <div class="hero__text">
        <h1 class="hero__title"><span class="hero__title-main">${esc(CONFIG.title.split('｜')[0])}</span><span class="hero__title-sep">｜</span><span class="hero__title-name">${esc(CONFIG.title.split('｜')[1])}</span></h1>
        <p class="hero__org">${esc(CONFIG.affiliation)}</p>
        <p class="hero__credential">${esc(CONFIG.credential)}</p>
        <p class="hero__lead">${esc(CONFIG.tagline)}</p>
        <p class="hero__lead hero__lead--muted">${esc(CONFIG.subTagline)}</p>
      </div>

    </div>
  </section>

  <section class="wrap section" id="articles" aria-labelledby="articles-heading">
    <div class="group-head">
      <div class="group-head__text">
        <h2 class="section__heading" id="articles-heading">${esc(CONFIG.overview.heading)}</h2>
        <p class="group-head__hook">${esc(CONFIG.overview.hook)}</p>
      </div>
    </div>
${rail(cards)}
  </section>

${SERIES.map(seriesSection).join('\n\n')}

  <section class="section about" id="about" aria-labelledby="about-heading">
    <div class="wrap">

      <div class="about__intro">
        <img class="about__portrait" src="${esc(PORTRAIT.src)}" alt="${esc(CONFIG.author)}"
             width="360" height="360" loading="lazy" decoding="async">
        <div class="about__intro-text">
          <p class="about__eyebrow">${esc(A.eyebrow)}</p>
          <h2 class="section__heading" id="about-heading">${esc(A.heading)}</h2>
          <p class="about__tagline">${esc(A.tagline)}</p>
        </div>
      </div>

      <div class="about__lead">${about.lead.trim()}</div>

      <p class="about__more"><a href="about/">認識更多，看完整學經歷 <span aria-hidden="true">→</span></a></p>

${aboutFootHtml()}
${ABOUT_NOTE}

    </div>
  </section>

  <section class="wrap section section--share">
${shareBlock({
    url: `${CONFIG.siteUrl}/`,
    title: CONFIG.title,
    heading: '把整個網站分享給需要的人',
    qrHint: '掃描後會進入首頁，可以瀏覽所有癌別的衛教文章。',
    qrName: CONFIG.qr.cardName,
  })}
  </section>

</main>
${siteFooter(0)}
<script src="assets/js/share.js?v=${V_SHARE}" defer></script>
<script src="assets/js/rail.js?v=${V_RAIL}" defer></script>
</body>
</html>
`;
}

function renderArticle(a, all, seriesDef) {
  const idx = all.findIndex((x) => x.slug === a.slug);
  /* 依首頁清單的排列位置決定前後篇：上一篇＝清單中在它前面那張卡片。
     這樣不論是依閱讀順序還是依更新時間排序，動線都和讀者剛看到的一致。 */
  const prev = all[idx - 1];
  const next = all[idx + 1];
  const faq = extractFaq(a.html);

  /* .svg 走內嵌（吃得到 CSS 變數，能跟著深色模式換色）；點陣圖走一般 <img> */
  const heroMedia = a.hero
    ? (a.hero.toLowerCase().endsWith('.svg')
        ? inlineSvg(a.hero)
        : `<img src="../../${esc(a.hero)}" alt="${esc(a.heroAlt)}" decoding="async">`)
    : '';

  const heroBlock = a.hero
    ? `    <figure class="article-hero">
      ${heroMedia}
${a.heroCaption ? `      <figcaption>${esc(a.heroCaption)}</figcaption>\n` : ''}    </figure>`
    : '';

  const updatedLine = a.wasUpdated
    ? `        <span class="article-meta__sep" aria-hidden="true">·</span>
        <span>最後更新 <time datetime="${isoDate(a.updated)}">${twDate(a.updated)}</time></span>`
    : '';

  const tags = a.tags.length
    ? `      <ul class="article-tags">${a.tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>\n`
    : '';

  const nav = [
    prev ? `        <a class="pager__item pager__item--prev" href="../${esc(prev.slug)}/"><span class="pager__dir">← 上一篇</span><span class="pager__title">${esc(prev.title)}</span></a>` : '',
    next ? `        <a class="pager__item pager__item--next" href="../${esc(next.slug)}/"><span class="pager__dir">下一篇 →</span><span class="pager__title">${esc(next.title)}</span></a>` : '',
  ].filter(Boolean).join('\n');

  const trail = [
    { name: '首頁', href: '../../', url: `${CONFIG.siteUrl}/` },
    ...(seriesDef ? [{ name: seriesDef.name, href: `../../series/${seriesDef.id}/`, url: `${CONFIG.siteUrl}/series/${seriesDef.id}/` }] : []),
    { name: a.title, url: `${CONFIG.siteUrl}/${a.url}` },
  ];

  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({
    title: `${a.title}｜${CONFIG.author}`,
    description: a.description,
    canonical: `${CONFIG.siteUrl}/${a.url}`,
    depth: 2,
    ogImage: a.hero || DEFAULT_OG,
  })}
<script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'MedicalWebPage',
        '@id': `${CONFIG.siteUrl}/${a.url}#page`,
        headline: a.title,
        description: a.description,
        datePublished: isoDate(a.published),
        dateModified: isoDate(a.updated),
        author: { '@type': 'Person', '@id': PERSON_ID, name: a.author, affiliation: CONFIG.affiliation },
        inLanguage: 'zh-Hant-TW',
        mainEntityOfPage: `${CONFIG.siteUrl}/${a.url}`,
      },
      ...(faq.length ? [{
        '@type': 'FAQPage',
        '@id': `${CONFIG.siteUrl}/${a.url}#faq`,
        isPartOf: { '@id': `${CONFIG.siteUrl}/${a.url}#page` },
        inLanguage: 'zh-Hant-TW',
        mainEntity: faq,
      }] : []),
      breadcrumbJsonLd(trail),
    ],
  }, null, 2)}
</script>
</head>
<body data-page-slug="${esc(a.slug)}">
${ICON_SPRITE}
${siteHeader(2)}
<main id="main">
  <article class="wrap article">

${breadcrumb(trail)}

    <header class="article-head">
${tags}      <h1 class="article-title">${esc(a.title)}</h1>
      <p class="article-lead">${esc(a.summary)}</p>
      <p class="article-meta">
        <span class="article-meta__author"><a href="../../about/">${esc(a.author)}</a></span>
        <span class="article-meta__sep" aria-hidden="true">·</span>
        <span>發布於 <time datetime="${isoDate(a.published)}">${twDate(a.published)}</time></span>
${updatedLine}
        <span class="article-meta__sep" aria-hidden="true">·</span>
        <span class="views" data-slug="${esc(a.slug)}" hidden>閱讀 <span class="views__n">–</span></span>
      </p>
    </header>

${a.answer ? `    <aside class="tldr">
      <p class="tldr__label">一句話回答</p>
      <p class="tldr__text">${esc(a.answer)}</p>
    </aside>\n` : ''}
${heroBlock}

    <div class="prose">
${a.html}
    </div>

${shareBlock({ url: `${CONFIG.siteUrl}/${a.url}`, title: a.title, qr: false })}

${authorCard('../../')}

    <nav class="pager" aria-label="文章導覽">
${nav}
    </nav>

${articleFooterNav('../../', seriesDef)}

  </article>
</main>
${siteFooter(2)}
<script src="../../assets/js/share.js?v=${V_SHARE}" defer></script>
</body>
</html>
`;
}

/* 系列專屬頁：/series/<id>/ */
function renderSeries(s) {
  const desc = `${s.name}衛教專區：${s.hook}。由${CONFIG.affiliation}${CONFIG.author}撰寫，以最新科學證據說明治療選擇與副作用照護，目前共 ${s.articles.length} 篇。`;
  const url = `${CONFIG.siteUrl}/series/${s.id}/`;

  const trail = [
    { name: '首頁', href: '../../', url: `${CONFIG.siteUrl}/` },
    { name: s.name, url },
  ];

  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({
    title: `${s.name}｜${CONFIG.author}`,
    description: desc,
    canonical: url,
    depth: 2,
  })}
<script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${url}#page`,
        url,
        name: s.name,
        description: desc,
        inLanguage: 'zh-Hant-TW',
        isPartOf: { '@id': `${CONFIG.siteUrl}/#website` },
        about: { '@id': PERSON_ID },
      },
      breadcrumbJsonLd(trail),
    ],
  }, null, 2)}
</script>
</head>
<body data-page-slug="series-${esc(s.id)}">
${ICON_SPRITE}
${siteHeader(2)}
<main id="main">
  <section class="wrap section">
${breadcrumb(trail)}

    <p class="about__eyebrow">癌別專題</p>
    <h1 class="section__heading">${esc(s.name)}</h1>
    <p class="group-head__hook">${esc(s.hook)}</p>
    <p class="section__note">共 ${s.articles.length} 篇<span class="views" data-slug="series-${esc(s.id)}" hidden>．本頁閱讀 <span class="views__n">–</span></span></p>

${s.articles.length
    ? `    <div class="cards">\n${s.articles.map((a) => articleCard(a, '../../')).join('\n')}\n    </div>`
    : `    <p class="group-empty">這個系列的文章正在整理中，敬請期待。</p>`}

${s.articles.length ? shareBlock({
    url,
    title: s.name,
    heading: `把整個「${s.name}」系列分享給需要的人`,
    qrHint: `掃描後會直接進入這個系列，只看得到${s.name}的文章。`,
    qrName: s.name,
    base: '../../',
  }) + '\n' : ''}
${backHome('../../', '回首頁')}
  </section>
</main>
${siteFooter(2)}
<script src="../../assets/js/share.js?v=${V_SHARE}" defer></script>
</body>
</html>
`;
}

/* 從渲染後的內文把「常見問題」抓成 FAQPage 結構化資料。
   問答只在 Markdown 裡寫一次，結構化資料建置時自動同步，不會兩邊對不起來。 */
const FAQ_RE = /<summary class="faq__q">([\s\S]*?)<\/summary><div class="faq__a">([\s\S]*?)<\/div><\/details>/g;

const plainText = (s) =>
  s.replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[e]))
    .replace(/\s+/g, ' ')
    .trim();

function extractFaq(html) {
  return [...html.matchAll(FAQ_RE)].map((m) => ({
    '@type': 'Question',
    name: plainText(m[1]),
    acceptedAnswer: { '@type': 'Answer', text: plainText(m[2]) },
  }));
}

/* 關於頁的 lastmod：取兩個來源檔中較新的修改時間 */
const ABOUT_MTIME = ['_about.md', '_about-cv.md']
  .map((f) => path.join(CONTENT_DIR, f))
  .filter((p) => fs.existsSync(p))
  .reduce((m, p) => (fs.statSync(p).mtime > m ? fs.statSync(p).mtime : m), new Date(0));

/* 獨立的關於頁：/about/。首頁只放精簡版，完整學經歷放這裡。 */
function renderAbout() {
  const A = CONFIG.about;
  const about = loadAbout();
  const desc = `${A.tagline}。${CONFIG.affiliation}主治醫師賴宥良的治療理念、臨床專長、學經歷與門診掛號資訊。`;
  const trail = [
    { name: '首頁', href: '../', url: `${CONFIG.siteUrl}/` },
    { name: A.heading, url: `${CONFIG.siteUrl}/about/` },
  ];

  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({ title: `${A.heading}｜${CONFIG.title}`, description: desc, canonical: `${CONFIG.siteUrl}/about/`, depth: 1, ogImage: PORTRAIT.src })}
<script type="application/ld+json">
${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'ProfilePage',
        '@id': `${CONFIG.siteUrl}/about/#page`,
        url: `${CONFIG.siteUrl}/about/`,
        name: A.heading,
        description: desc,
        inLanguage: 'zh-Hant-TW',
        mainEntity: { '@id': PERSON_ID },
        isPartOf: { '@id': `${CONFIG.siteUrl}/#website` },
      },
      {
        ...personNode(),
        image: `${CONFIG.siteUrl}/${PORTRAIT.src}`,
        alumniOf: [
          { '@type': 'CollegeOrUniversity', name: '中國醫藥大學' },
          { '@type': 'CollegeOrUniversity', name: '高雄醫學大學' },
        ],
        award: ['中國醫藥大學附設醫院傑出優良醫師（2016）', '中國醫藥大學附設醫院傑出優良醫師（2022）'],
        medicalSpecialty: 'Oncologic',
      },
      breadcrumbJsonLd(trail),
    ],
  }, null, 2)}
</script>
</head>
<body data-page-slug="about">
${ICON_SPRITE}
${siteHeader(1)}
<main id="main">

  <section class="section about about--page" id="about" aria-labelledby="about-heading">
    <div class="wrap">

${breadcrumb(trail)}

      <div class="about__intro">
        <img class="about__portrait" src="../${esc(PORTRAIT.src)}" alt="${esc(CONFIG.author)}"
             width="360" height="360" fetchpriority="high" decoding="async">
        <div class="about__intro-text">
          <p class="about__eyebrow">${esc(A.eyebrow)}</p>
          <h1 class="section__heading" id="about-heading">${esc(A.heading)}</h1>
          <p class="about__tagline">${esc(A.tagline)}</p>
          <p class="section__note"><span class="views" data-slug="about" hidden>本頁閱讀 <span class="views__n">–</span></span></p>
        </div>
      </div>

      <div class="about__lead">${about.lead.trim()}</div>

      <div class="about__cards">
${about.cards.map((c) => `        <article class="acard">
          <h2 class="acard__title">${icon(c.icon, 'acard__icon')}<span>${esc(c.title)}</span></h2>
          <div class="acard__body">${c.html.trim()}</div>
        </article>`).join('\n')}
      </div>

      <div class="about__rule">
        <h2 class="about__rule-title">${esc(A.specialtiesHeading)}</h2>
      </div>

      <ul class="tiles">
${CONFIG.specialties.map((s) => `        <li class="tile">
          ${icon(s.icon, 'tile__icon')}
          <span class="tile__zh">${esc(s.zh)}</span>
          <span class="tile__en">${esc(s.en)}</span>
        </li>`).join('\n')}
      </ul>

      <div class="about__rule">
        <h2 class="about__rule-title">${esc(A.clinicHoursHeading)}</h2>
      </div>

${clinicTableHtml()}

      <div class="about__rule">
        <h2 class="about__rule-title">學經歷</h2>
      </div>

      <div class="cv">
${ABOUT_CV.map((sec) => `        <section class="cv__block">
          <h3 class="cv__title">${esc(sec.title)}</h3>
          <div class="cv__body">${sec.html.trim()}</div>
        </section>`).join('\n')}
      </div>

${aboutFootHtml()}
${ABOUT_NOTE}

${backHome('../', '回首頁')}

    </div>
  </section>

</main>
${siteFooter(1)}
</body>
</html>
`;
}

/* 404 頁的所有網址都用根目錄絕對路徑（/…），不用相對路徑。
   Cloudflare Pages 會在「使用者原本要求的網址」上直接送出這一頁，
   例如 /p/打錯的網址/ ——相對路徑在那個位置會全部解析錯，
   連樣式表都載不到。 */
/* 內容使用規範：/terms/
   文字的權屬乾淨（醫師自己寫的），所以明確主張；圖表則只陳述來源、
   不主張著作權——說法要前後一致，才經得起檢驗。
   這一頁要公開可索引：DMCA 申訴時，「網站已明示使用範圍」是有份量的。 */
function renderTerms() {
  const body = md.render(fs.readFileSync(path.join(CONTENT_DIR, '_terms.md'), 'utf8'));

  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({
    title: `內容使用規範｜${CONFIG.title}`,
    description: `${CONFIG.title}的著作權聲明與內容使用規範：文章文字、圖表插圖分別可以怎麼引用、分享與列印。`,
    canonical: `${CONFIG.siteUrl}/terms/`,
    depth: 1,
  })}
</head>
<body data-page-slug="terms">
${ICON_SPRITE}
${siteHeader(1)}
<main id="main">
  <article class="wrap article">

${breadcrumb([
    { name: '首頁', href: '../', url: `${CONFIG.siteUrl}/` },
    { name: '內容使用規範', url: `${CONFIG.siteUrl}/terms/` },
  ])}

    <header class="article-head">
      <h1 class="article-title">內容使用規範</h1>
      <p class="article-lead">在註明來源的前提下，歡迎引用與分享。</p>
    </header>

    <div class="prose">
${body}
    </div>

${backHome('../', '回首頁')}

  </article>
</main>
${siteFooter(1)}
</body>
</html>
`;
}

/* QR 總覽頁：/qr/
   給醫師在門診用的工具頁——一頁看完所有 QR，可以直接開畫面給病人掃，
   或用瀏覽器列印成一張 A4。刻意不放進導覽列與 sitemap，並加上 noindex：
   病人搜尋時看到一整頁 QR 只會困惑。新增癌別系列時這一頁會自動長出一張。 */
function renderQrPage() {
  const homeUrl = `${CONFIG.siteUrl}/`;
  const live = SERIES.filter((s) => s.articles.length);

  /* 排成一列一癌別，而不是 QR 方陣：讀者要在一堆 QR 裡找到自己的癌別，
     所以癌別名才是導航，必須是整列最大的字；QR 縮小反而更好掃。
     這裡刻意不列文章標題——那是轉介卡的工作，放上來只會讓整張變雜。 */
  const cards = live.map((s) => `        <li class="qrrow">
          <div class="qr__frame">${qrCache.get(`${CONFIG.siteUrl}/series/${s.id}/`) || ''}</div>
          <div class="qrrow__body">
            <p class="qrrow__name">${esc(s.name)}</p>
            <p class="qrrow__hook">${esc(s.hook)}</p>
            <a class="qrcard__sheet" href="${s.id}/">列印給這一科 →</a>
          </div>
        </li>`).join('\n');

  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({
    title: `${CONFIG.qr.pageTitle}｜${CONFIG.author}`,
    description: '門診當面分享用的 QR Code 總覽。',
    canonical: `${CONFIG.siteUrl}/qr/`,
    depth: 1,
    noindex: true,
  })}
</head>
<body data-page-slug="qr">
${ICON_SPRITE}
${siteHeader(1)}
<main id="main">
  <section class="wrap section qrsheet">

    <header class="qrsheet__head">
      <h1 class="section__heading">${esc(CONFIG.qr.pageTitle)}</h1>
      <p class="qrsheet__note">可以直接把這一頁開給對方掃，或用瀏覽器列印成一張 A4。列印時會自動去掉頁首、頁尾與這行說明。</p>
    </header>

    <figure class="qrcard qrcard--main">
      <div class="qr__frame">${qrCache.get(homeUrl) || ''}</div>
      <figcaption>
        <span class="qrcard__name">${esc(CONFIG.qr.cardName)}</span>
        <span class="qrcard__url">${esc(urlText(homeUrl))}</span>
      </figcaption>
    </figure>

    <div class="qrsheet__rule">
      <h2 class="qrsheet__rule-title">各癌別專區</h2>
    </div>

    <ul class="qrlist">
${cards}
    </ul>

${backHome('../', '回首頁')}
  </section>
</main>
${siteFooter(1)}
</body>
</html>
`;
}

/* 單一癌別的轉介卡：/qr/<series-id>/
   給對應科別的醫師放在診間——列印時一張 A4 排三張橫式卡片，剪開後
   自己留一張、其餘給轉介的病人帶走。卡片上直接列文章標題，
   不另外寫簡介：標題本來就是問句，而且改了標題卡片自動跟著改，
   不會出現「卡片承諾了網站上沒有的內容」。 */
function renderQrSheet(s) {
  const url = `${CONFIG.siteUrl}/series/${s.id}/`;
  const qr = qrCache.get(url) || '';

  /* 標題本來就是問句，而且常常一連問兩三個。卡片上只留第一個問句——
     長度剛好，而且讀起來就是病人心裡的那句話。沒有問號的就用整個標題。 */
  const firstQ = (t) => { const i = t.indexOf('？'); return i > -1 ? t.slice(0, i + 1) : t; };
  const titles = s.articles.map((a) => `            <li>${esc(firstQ(a.title))}</li>`).join('\n');

  const card = `      <article class="refcard">
        <div class="qr__frame refcard__qr">${qr}</div>
        <div class="refcard__body">
          <p class="refcard__name">${esc(s.name)}</p>
          <ul class="refcard__list">
${titles}
          </ul>
          <p class="refcard__who">${esc(CONFIG.author)}｜${esc(CONFIG.affiliation)}　${esc(urlText(CONFIG.siteUrl))}</p>
        </div>
      </article>`;

  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({
    title: `${s.name} 轉介卡｜${CONFIG.author}`,
    description: '門診轉介用的 QR 卡片。',
    canonical: `${CONFIG.siteUrl}/qr/${s.id}/`,
    depth: 2,
    noindex: true,
  })}
</head>
<body data-page-slug="qr-sheet">
${ICON_SPRITE}
${siteHeader(2)}
<main id="main">
  <section class="wrap section refsheet">

    <header class="qrsheet__head">
      <h1 class="section__heading">${esc(s.name)}　轉介卡</h1>
      <p class="qrsheet__note">列印會排成一張 A4 三張，剪開後可以自己留一張、其餘給病人帶走。也可以直接把這一頁開給對方掃。</p>
    </header>

${card}
${card}
${card}

${backHome('../', '回 QR 總覽')}
  </section>
</main>
${siteFooter(2)}
</body>
</html>
`;
}

function render404() {
  const ABS = '/';
  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({ title: `找不到頁面｜${CONFIG.title}`, description: '找不到這個頁面', canonical: CONFIG.siteUrl + '/404.html', depth: 0, base: ABS })}
</head>
<body>
${ICON_SPRITE}
${siteHeader(0, ABS)}
<main id="main">
  <section class="wrap section notfound">
    <h1 class="section__heading">找不到這個頁面</h1>
    <p class="prose">您要找的內容可能已經移動或不存在。</p>
${backHome(ABS, '回首頁')}
  </section>
</main>
${siteFooter(0, ABS)}
</body>
</html>
`;
}

function renderSitemap(articles) {
  const newest = articles.reduce((m, a) => (a.updated > m ? a.updated : m), new Date(0));
  const urls = [
    { loc: CONFIG.siteUrl + '/', lastmod: isoDate(articles.length ? newest : new Date()) },
    { loc: CONFIG.siteUrl + '/about/', lastmod: isoDate(ABOUT_MTIME) },
    { loc: CONFIG.siteUrl + '/terms/', lastmod: isoDate(fs.statSync(path.join(CONTENT_DIR, '_terms.md')).mtime) },
    ...SERIES.filter((s) => s.articles.length).map((s) => ({
      loc: `${CONFIG.siteUrl}/series/${s.id}/`,
      lastmod: isoDate(s.articles.reduce((m, a) => (a.updated > m ? a.updated : m), new Date(0))),
    })),
    ...articles.map((a) => ({ loc: `${CONFIG.siteUrl}/${a.url}`, lastmod: isoDate(a.updated) })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}
</urlset>
`;
}

/* ---------- 主流程 ---------- */

const articles = loadArticles();
if (!articles.length) {
  console.error('content/ 裡沒有任何 .md 文章');
  process.exit(1);
}

/* 分組：沒有 series 的歸概論區，其餘依 series id 歸入各癌別 */
const SERIES = (CONFIG.series || []).map((s) => ({
  ...s,
  articles: sortByOrder(articles.filter((a) => a.series === s.id), s.order || []),
}));
const OVERVIEW = sortByOrder(articles.filter((a) => !a.series), ORDER);

/* series 打錯字時要立刻知道，否則文章會靜悄悄地從網站上消失 */
const known = new Set(SERIES.map((s) => s.id));
const orphans = articles.filter((a) => a.series && !known.has(a.series));
if (orphans.length) {
  console.error('以下文章的 series 在 site.config.json 中找不到：');
  for (const a of orphans) console.error(`  ${a.slug}  series: ${a.series}`);
  process.exit(1);
}

/* 版型函式是同步的，所以在開始輸出之前先把所有 QR Code 產好。
   文章頁不放 QR（要當面分享的是整個癌別系列，不是單篇），所以不必產。 */
await warmQr([
  `${CONFIG.siteUrl}/`,
  ...SERIES.filter((s) => s.articles.length).map((s) => `${CONFIG.siteUrl}/series/${s.id}/`),
]);

const written = [];
written.push(writeFile('index.html', renderIndex(OVERVIEW)));
written.push(writeFile(path.join('about', 'index.html'), renderAbout()));
written.push(writeFile(path.join('qr', 'index.html'), renderQrPage()));

for (const s of SERIES.filter((x) => x.articles.length)) {
  written.push(writeFile(path.join('qr', s.id, 'index.html'), renderQrSheet(s)));
}
written.push(writeFile(path.join('terms', 'index.html'), renderTerms()));

for (const s of SERIES) {
  written.push(writeFile(path.join('series', s.id, 'index.html'), renderSeries(s)));
}

for (const a of articles) {
  const s = SERIES.find((x) => x.id === a.series);
  written.push(writeFile(path.join('p', a.slug, 'index.html'),
    renderArticle(a, s ? s.articles : OVERVIEW, s || null)));
}

written.push(writeFile('404.html', render404()));
written.push(writeFile('sitemap.xml', renderSitemap(articles)));
written.push(writeFile('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${CONFIG.siteUrl}/sitemap.xml\n`));

console.log(`建置完成，共 ${articles.length} 篇文章\n`);
console.log(`概論（${OVERVIEW.length} 篇）`);
OVERVIEW.forEach((a, i) => {
  console.log(`  ${i + 1}. ${isoDate(a.updated)}  /${a.url}${a.wasUpdated ? '  (已更新)' : ''}`);
});
for (const s of SERIES) {
  console.log(`\n${s.name}（${s.articles.length} 篇）  /series/${s.id}/`);
  if (!s.articles.length) console.log('  （尚無文章，首頁顯示「整理中」）');
  s.articles.forEach((a, i) => {
    console.log(`  ${i + 1}. ${isoDate(a.updated)}  /${a.url}${a.wasUpdated ? '  (已更新)' : ''}`);
  });
}
console.log('');
console.log(`\n輸出 ${written.length} 個檔案。`);
console.log(CONFIG.counter.enabled
  ? `瀏覽計數：已啟用（${CONFIG.counter.endpoint}）`
  : '瀏覽計數：已停用，計數器為隱藏狀態。');
