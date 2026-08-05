/**
 * 衛教文可讀性檢查
 *
 * 術語密度只量到「詞」的難度。這支補上「句子」與「版面」的難度：
 *
 *   長句比例   中文一句超過 40 字就開始吃力，超過 60 字多數人要回頭重讀
 *   長段比例   手機上一段超過 150 字就是一整螢幕的字牆
 *   最長無停頓 連續多少字沒有小標、清單、引言或插圖可以喘口氣
 *   書面語     「進行」「予以」「係」「藉由」這類公文腔，改成口語就好讀
 *   未解釋術語 專有名詞第一次出現時，附近有沒有白話說明
 *
 *   node scripts/check-readability.mjs [檔名…]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'content');

/* 公文腔的標記。同樣的意思用口語講會短很多，也比較像在對人說話。 */
const FORMAL = /進行|予以|加以|藉由|針對.{1,8}進行|之後|其中|係為|之一|使得|以及其|在.{1,6}方面|就.{1,6}而言/g;

function analyse(file) {
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');
  const body = raw
    .replace(/^---[\s\S]*?---/, '')
    .replace(/^## 參考文獻[\s\S]*/m, '');

  const lines = body.split('\n');

  /* 只把「一般段落」拿來算句長：標題、清單、引言、表格、巨集都不是散文 */
  const paras = [];
  const marks = [];   // 視覺停頓的位置（行號）
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    /* 圖片、清單、小標、引言都是讓眼睛喘口氣的地方。
       插圖有兩種寫法：站上的 <!--svg:--> 巨集，以及直接寫的 <figure>，兩種都要算。 */
    if (/^#{1,4} /.test(t) || /^[-*] /.test(t) || /^> /.test(t) || /^\|/.test(t) ||
        /^<!--/.test(t) || /^\d+\. /.test(t) ||
        /^<\/?(figure|img|figcaption)/.test(t)) { marks.push(i); return; }
    paras.push({ text: t, line: i });
  });

  const sentences = paras.flatMap((p) =>
    p.text.split(/(?<=[。？！])/).map((s) => s.replace(/\*\*|\[|\]\([^)]*\)/g, '').trim())
  ).filter((s) => s.replace(/\s/g, '').length > 4);

  const len = (s) => s.replace(/\s/g, '').length;
  const long40 = sentences.filter((s) => len(s) > 40).length;
  const long60 = sentences.filter((s) => len(s) > 60).length;
  const avgSent = Math.round(sentences.reduce((a, s) => a + len(s), 0) / (sentences.length || 1));

  const longPara = paras.filter((p) => len(p.text) > 150).length;

  /* 最長的一段「沒有任何視覺停頓」的連續散文 */
  let maxRun = 0, run = 0;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (!t) return;
    if (marks.includes(i)) { run = 0; return; }
    run += len(t);
    if (run > maxRun) maxRun = run;
  });

  const formal = (body.match(FORMAL) || []).length;
  const chars = body.replace(/\s/g, '').length;

  return {
    file: file.replace('.md', ''),
    chars,
    sent: sentences.length,
    avgSent,
    pct40: Math.round(long40 / (sentences.length || 1) * 100),
    long60,
    longPara,
    maxRun,
    formal: Math.round(formal / chars * 1000),
  };
}

const args = process.argv.slice(2);
const files = args.length ? args : fs.readdirSync(DIR).filter((f) => f.endsWith('.md') && !f.startsWith('_'));
const rows = files.map(analyse).sort((a, b) => b.pct40 - a.pct40);

const pad = (s, n) => {
  let w = 0;
  for (const c of s) w += /[　-鿿＀-￯]/.test(c) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
};

console.log(pad('文章', 44) + '均句長  >40字  >60字  長段  最長無停頓  書面語');
console.log('─'.repeat(92));
for (const r of rows) {
  console.log(
    pad(r.file.slice(0, 21), 44) +
    String(r.avgSent).padStart(5) +
    String(r.pct40 + '%').padStart(7) + (r.pct40 > 30 ? '⚠' : ' ') +
    String(r.long60).padStart(6) + (r.long60 > 5 ? '⚠' : ' ') +
    String(r.longPara).padStart(5) + (r.longPara > 2 ? '⚠' : ' ') +
    String(r.maxRun).padStart(10) + (r.maxRun > 400 ? '⚠' : ' ') +
    String(r.formal).padStart(7) + (r.formal > 12 ? '⚠' : ' ')
  );
}
console.log('─'.repeat(92));
console.log('建議上限：>40字 的句子佔 30%、>60字 的句子 5 句、超過 150 字的段落 2 段、');
console.log('　　　　　連續無停頓 400 字、書面語每千字 12 個');
