/*
 * indexnow.mjs — 部署後主動通知 Bing 有哪些網址更新了。
 *
 * 為什麼需要這個：Google 有自己的發現機制，新頁面幾天內就會來抓；Bing 沒有，
 * 新網域可以放好幾週都不理你。IndexNow 是 Bing／Yandex／Seznam 共用的通報協定，
 * 送出後通常幾小時內就會來抓。Google 不參與這個協定，所以這支只影響 Bing 那一側。
 *
 * 驗證靠 build.mjs 產生的 <金鑰>.txt——搜尋引擎抓得到那個檔，就認定這站是我們的。
 *
 * 用法：node scripts/indexnow.mjs         送出 sitemap 裡的全部網址
 *       node scripts/indexnow.mjs <url>…  只送指定的幾個
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const KEY = CONFIG.indexNowKey;

if (!KEY) {
  console.error('site.config.json 裡沒有 indexNowKey，略過。');
  process.exit(0);
}

const host = new URL(CONFIG.siteUrl).host;

/* 直接讀建置產生的 sitemap，而不是自己再走一次目錄——
   這樣送出去的網址一定跟對外公告的那份一致，不會有漏或多。 */
function urlsFromSitemap() {
  const xml = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

const urlList = process.argv.slice(2).length ? process.argv.slice(2) : urlsFromSitemap();

if (!urlList.length) {
  console.error('沒有可送出的網址。');
  process.exit(1);
}

const body = {
  host,
  key: KEY,
  keyLocation: `${CONFIG.siteUrl}/${KEY}.txt`,
  urlList,
};

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
});

/* 200 = 收下了，202 = 收下了但還在驗金鑰（第一次送幾乎都是 202，屬正常）。 */
const ok = res.status === 200 || res.status === 202;
console.log(`IndexNow：送出 ${urlList.length} 個網址 → HTTP ${res.status}${ok ? '（正常）' : ''}`);

if (!ok) {
  console.error(await res.text());
  console.error('\n422 通常是網址的網域跟 host 對不起來；403 是金鑰檔抓不到——');
  console.error(`先確認 ${CONFIG.siteUrl}/${KEY}.txt 打得開。`);
  process.exit(1);
}
