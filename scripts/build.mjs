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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'content');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

/* 自繪的 SVG 插圖一律直接內嵌，而非用 <img> 外部引用，
   否則 SVG 讀不到頁面的 CSS 變數，深色模式與配色都會失效。 */
const svgCache = new Map();
function inlineSvg(relPath) {
  if (!svgCache.has(relPath)) {
    svgCache.set(relPath, fs.readFileSync(path.join(ROOT, relPath), 'utf8')
      .replace(/<\?xml[^>]*\?>\s*/, '')
      .trim());
  }
  return svgCache.get(relPath);
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
 *
 * 標記本身會被 Markdown 原樣輸出，這裡再換成對應的 HTML 標籤。
 */
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

function head({ title, description, canonical, depth, ogImage }) {
  const base = '../'.repeat(depth);
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="author" content="${esc(CONFIG.author)}">
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

function siteHeader(depth) {
  const base = '../'.repeat(depth);
  return `<header class="site-header">
  <div class="wrap site-header__inner">
    <a class="brand" href="${base}">
      <span class="brand__name">賴宥良醫師</span>
      <span class="brand__desc">質子治療・放射治療</span>
    </a>
    <nav class="site-nav">
      <a href="${base}#articles">文章</a>
      <a href="${base}about/">關於</a>
      <a class="site-nav__cta" href="${esc(CONFIG.appointmentUrl)}" target="_blank" rel="noopener noreferrer">線上掛號</a>
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

function siteFooter(depth) {
  const base = '../'.repeat(depth);
  return `<footer class="site-footer">
  <div class="wrap">
${creditsBlock()}
    <section class="disclaimer">
      <h2 class="credits__heading">免責聲明</h2>
      <p>本網站內容為一般性衛教資訊，目的在於協助民眾理解放射治療與質子治療的原則，<strong>無法取代專業醫療診斷與個別化的治療建議</strong>。任何治療決策，請與您的主治醫師充分討論後決定。</p>
    </section>
    <div class="site-footer__meta">
      <p class="site-footer__copy">© ${new Date().getFullYear()} ${esc(CONFIG.author)}．本站文字內容版權所有</p>
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

const ABOUT_NOTE = `      <p class="prose__note about__note">網站內容為一般性衛教資訊，無法取代面對面的診療。若您有具體的病情問題，請於門診與您的主治醫師討論。掛號連結將另開新視窗前往中國醫藥大學附設醫院官方系統。</p>`;

function aboutFootHtml() {
  const A = CONFIG.about;
  return `      <div class="about__foot">
        <a class="cta__btn" href="${esc(CONFIG.appointmentUrl)}" target="_blank" rel="noopener noreferrer">
          ${icon('i-calendar', 'cta__icon')}<span>${esc(A.appointmentLabel)}</span><span class="cta__arrow" aria-hidden="true">→</span>
        </a>
        <ul class="info-items">
${A.infoItems.map((it) => `          <li class="info-item">
            ${it.icon ? icon(it.icon, 'info-item__icon') : ''}
            <span class="info-item__text">${it.lines.map(esc).join('<br>')}</span>
          </li>`).join('\n')}
        </ul>
      </div>`;
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
          <a href="${esc(CONFIG.appointmentUrl)}" target="_blank" rel="noopener noreferrer">線上掛號 <span aria-hidden="true">→</span></a>
        </p>
      </div>
    </aside>`;
}

/* 首頁上的一個癌別系列區塊：標題 + 一句話 + 卡片格線 + 看全部連結 */
function seriesSection(s) {
  const limit = CONFIG.seriesCardLimit || 6;
  const shown = s.articles.slice(0, limit);
  const more = s.articles.length - shown.length;

  const body = s.articles.length
    ? `    <div class="cards cards--rail">
${shown.map((a) => articleCard(a)).join('\n')}
    </div>${more > 0 ? `\n    <p class="group-more"><a href="series/${esc(s.id)}/">還有 ${more} 篇 →</a></p>` : ''}`
    : `    <p class="group-empty">這個系列的文章正在整理中，敬請期待。</p>`;

  return `  <section class="wrap section" id="series-${esc(s.id)}" aria-labelledby="series-${esc(s.id)}-heading">
    <div class="group-head">
      <div class="group-head__text">
        <h2 class="section__heading" id="series-${esc(s.id)}-heading">${esc(s.name)}</h2>
        <p class="group-head__hook">${esc(s.hook)}</p>
      </div>
${s.articles.length ? `      <a class="group-head__go" href="series/${esc(s.id)}/">看全部 <b>${s.articles.length}</b> 篇 →</a>\n` : ''}    </div>
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
    <div class="cards cards--rail">
${cards}
    </div>
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

</main>
${siteFooter(0)}
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
    ],
  }, null, 2)}
</script>
</head>
<body data-page-slug="${esc(a.slug)}">
${siteHeader(2)}
<main id="main">
  <article class="wrap article">

    <header class="article-head">
${seriesDef ? `      <p class="article-series"><a href="../../series/${esc(seriesDef.id)}/">${esc(seriesDef.name)}</a></p>\n` : ''}${tags}      <h1 class="article-title">${esc(a.title)}</h1>
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

${heroBlock}

    <div class="prose">
${a.html}
    </div>

${authorCard('../../')}

    <nav class="pager" aria-label="文章導覽">
${nav}
    </nav>

    <p class="article-back"><a href="../../">← 回到文章列表</a></p>

  </article>
</main>
${siteFooter(2)}
</body>
</html>
`;
}

/* 系列專屬頁：/series/<id>/ */
function renderSeries(s) {
  const desc = `${s.name}衛教專區：${s.hook}。由${CONFIG.affiliation}${CONFIG.author}撰寫，以最新科學證據說明治療選擇與副作用照護，目前共 ${s.articles.length} 篇。`;

  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({
    title: `${s.name}｜${CONFIG.author}`,
    description: desc,
    canonical: `${CONFIG.siteUrl}/series/${s.id}/`,
    depth: 2,
  })}
</head>
<body data-page-slug="series-${esc(s.id)}">
${siteHeader(2)}
<main id="main">
  <section class="wrap section">
    <p class="about__eyebrow">癌別專題</p>
    <h1 class="section__heading">${esc(s.name)}</h1>
    <p class="group-head__hook">${esc(s.hook)}</p>
    <p class="section__note">共 ${s.articles.length} 篇<span class="views" data-slug="series-${esc(s.id)}" hidden>．本頁閱讀 <span class="views__n">–</span></span></p>

${s.articles.length
    ? `    <div class="cards">\n${s.articles.map((a) => articleCard(a, '../../')).join('\n')}\n    </div>`
    : `    <p class="group-empty">這個系列的文章正在整理中，敬請期待。</p>`}

    <p class="article-back"><a href="../../">← 回到首頁</a></p>
  </section>
</main>
${siteFooter(2)}
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
        award: ['中國醫藥大學附設醫院傑出優良醫師（105 年度）', '中國醫藥大學附設醫院傑出優良醫師（111 年度）'],
        medicalSpecialty: 'Oncologic',
      },
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

      <p class="article-back"><a href="../">← 回到首頁</a></p>

    </div>
  </section>

</main>
${siteFooter(1)}
</body>
</html>
`;
}

function render404() {
  return `<!doctype html>
<html lang="${CONFIG.lang}">
<head>
${head({ title: `找不到頁面｜${CONFIG.title}`, description: '找不到這個頁面', canonical: CONFIG.siteUrl + '/404.html', depth: 0 })}
</head>
<body>
${siteHeader(0)}
<main id="main">
  <section class="wrap section notfound">
    <h1 class="section__heading">找不到這個頁面</h1>
    <p class="prose">您要找的內容可能已經移動或不存在。</p>
    <p class="article-back"><a href="./">← 回到首頁</a></p>
  </section>
</main>
${siteFooter(0)}
</body>
</html>
`;
}

function renderSitemap(articles) {
  const newest = articles.reduce((m, a) => (a.updated > m ? a.updated : m), new Date(0));
  const urls = [
    { loc: CONFIG.siteUrl + '/', lastmod: isoDate(articles.length ? newest : new Date()) },
    { loc: CONFIG.siteUrl + '/about/', lastmod: isoDate(ABOUT_MTIME) },
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

const written = [];
written.push(writeFile('index.html', renderIndex(OVERVIEW)));
written.push(writeFile(path.join('about', 'index.html'), renderAbout()));

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
