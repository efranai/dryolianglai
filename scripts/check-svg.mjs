/**
 * 插圖版面靜態檢查
 *
 * 不開瀏覽器就能算出每個 <text> 的估計邊界，檢查兩件事：
 *   1. 有沒有超出畫布
 *   2. 同一張圖裡有沒有兩段文字疊在一起
 *
 * 字寬與行高的係數是從瀏覽器 getBBox() 實測回歸出來的：
 *   23px 的字，bbox 上緣在基準線上方 26、下緣在下方 7.4。
 * 窄螢幕時 CSS 會把字級放大（il-t 16→27），那才是最容易出事的情況，
 * 所以預設就用窄螢幕的字級檢查。
 *
 *   node scripts/check-svg.mjs [檔名…]      不給檔名就檢查全部
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG = path.join(ROOT, 'assets', 'img');

/* 窄螢幕字級（style.css 的 @media max-width:46rem）。
   il-detail 在窄螢幕會整個隱藏，所以用桌機字級另外算一輪。 */
const NARROW = { 'il-t': 27, 'il-t-sub': 23, 'il-t-val': 25, 'il-t-num': 22, 'il-t-line': 24, 'il-src': 18 };
const WIDE = { 'il-t': 16, 'il-t-sub': 13.5, 'il-t-val': 15, 'il-t-num': 14, 'il-t-line': 14, 'il-src': 11 };

const fontSize = (cls, map) => {
  for (const k of Object.keys(map)) if (cls.split(/\s+/).includes(k)) return map[k];
  return map['il-t-sub'];
};

/* 全形字約等於一個字級；半形英數約 0.55；空白更窄 */
function textWidth(s, fs) {
  let w = 0;
  for (const ch of s) {
    if (/\s/.test(ch)) w += fs * 0.25;
    else if (/[　-〿㐀-鿿＀-￯]/.test(ch)) w += fs;
    else w += fs * 0.55;
  }
  return w;
}

function boxes(svg, sizeMap, { skipDetail }) {
  const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!vb) return null;
  const W = +vb[1], H = +vb[2];
  const out = [];
  for (const m of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1], txt = m[2].replace(/&amp;/g, '&').trim();
    if (!txt) continue;
    const cls = (attrs.match(/class="([^"]*)"/) || ['', ''])[1];
    if (skipDetail && cls.includes('il-detail')) continue;
    const x = parseFloat((attrs.match(/\bx="([-\d.]+)"/) || [])[1] ?? NaN);
    const y = parseFloat((attrs.match(/\by="([-\d.]+)"/) || [])[1] ?? NaN);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    const fs = fontSize(cls, sizeMap);
    const w = textWidth(txt, fs);
    const left = cls.includes('il-anchor-mid') ? x - w / 2
               : cls.includes('il-anchor-end') ? x - w
               : x;
    out.push({ txt, x1: left, x2: left + w, y1: y - fs * 1.19, y2: y + fs * 0.33 });
  }
  return { W, H, out };
}

function check(file) {
  const svg = fs.readFileSync(path.join(IMG, file), 'utf8');
  if (!/class="illus"/.test(svg)) return [];
  const problems = [];
  for (const [label, map, opt] of [['窄螢幕', NARROW, { skipDetail: true }], ['桌機', WIDE, { skipDetail: false }]]) {
    const r = boxes(svg, map, opt);
    if (!r) continue;
    /* 浮水印那條帶是 build 時才加上的，靜態檢查時畫布還沒加高 */
    const H = r.H + 34;
    for (const b of r.out) {
      if (b.x1 < -1 || b.x2 > r.W + 1) problems.push(`${label} 溢出畫布：「${b.txt.slice(0, 18)}」`);
      if (b.y2 > H + 1) problems.push(`${label} 超出下緣：「${b.txt.slice(0, 18)}」`);
    }
    for (let i = 0; i < r.out.length; i++) {
      for (let j = i + 1; j < r.out.length; j++) {
        const a = r.out[i], b = r.out[j];
        if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) {
          problems.push(`${label} 重疊：「${a.txt.slice(0, 12)}」×「${b.txt.slice(0, 12)}」`);
        }
      }
    }
  }
  return [...new Set(problems)];
}

const args = process.argv.slice(2);
const files = args.length ? args : fs.readdirSync(IMG).filter((f) => f.endsWith('.svg'));
let bad = 0;
for (const f of files) {
  const p = check(f);
  if (p.length) { bad++; console.log(`✗ ${f}`); p.forEach((x) => console.log('    ' + x)); }
}
console.log(`\n檢查 ${files.length} 個檔案，${bad ? bad + ' 個有問題' : '全部通過'}`);
