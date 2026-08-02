/**
 * 組出 dist/ —— 只包含實際要對外提供的靜態檔案。
 *
 * 網站在 GitHub Pages 是直接由 repo 根目錄提供服務，所以建置產物必須留在根目錄；
 * 但上傳到 Cloudflare Pages 時不該把 node_modules、Markdown 原稿與建置腳本一起送出去，
 * 因此這裡另外複製一份乾淨的輸出。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const INCLUDE = [
  'index.html',
  '404.html',
  'robots.txt',
  'sitemap.xml',
  '.nojekyll',
  'p',
  'assets',
];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

let files = 0;

function copy(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copy(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.copyFileSync(src, dest);
    files++;
  }
}

for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) {
    console.warn(`略過（不存在）：${item}`);
    continue;
  }
  copy(src, path.join(DIST, item));
}

console.log(`dist/ 組裝完成，共 ${files} 個檔案。`);
