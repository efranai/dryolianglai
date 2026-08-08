/**
 * Cloudflare Pages 一定會給專案一個公開的 *.pages.dev 網址，沒有辦法停用。
 * 這裡分兩種情況處理：
 *
 *   dryolianglai.pages.dev          啟用正式網域之前用的舊網址，現在沒有用途
 *                                   → 301 轉到正式網域，把連結與排名都收攏過去
 *
 *   <hash>.dryolianglai.pages.dev   每一次部署的預覽網址，審稿要用，必須留著
 *                                   → 不轉址，但加上 noindex：預覽上往往是
 *                                     還沒審過的草稿，那種東西不該進搜尋結果
 *
 * 判斷條件刻意只認 .pages.dev 結尾，不寫成「不等於正式網域」——
 * 這樣不論日後正式網域怎麼改，都不可能誤把正式站標成 noindex。
 */
const PROD_ORIGIN = 'https://med.dryolianglai.net';
const PROD_HOST = 'med.dryolianglai.net';

/* 同一份內容曾經掛在好幾個網址上，全部收攏到正式網域：
     dryolianglai.pages.dev      啟用正式網域之前用的舊網址
     dryolianglai.net（apex）    和正式站內容完全相同，白白吃掉抓取預算
     www.dryolianglai.net        目前沒有 DNS 記錄，補上之後也會走這裡
   apex 只是暫時借給 med. 用，哪天想讓它變成入口頁，把它從清單移除即可。 */
const REDIRECT_HOSTS = new Set([
  'dryolianglai.pages.dev',
  'dryolianglai.net',
  'www.dryolianglai.net',
]);

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (REDIRECT_HOSTS.has(url.hostname) && url.hostname !== PROD_HOST) {
    return Response.redirect(PROD_ORIGIN + url.pathname + url.search, 301);
  }

  const res = await context.next();
  if (!url.hostname.endsWith('.pages.dev')) return res;

  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}
