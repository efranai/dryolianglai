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
const LEGACY_HOST = 'dryolianglai.pages.dev';

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.hostname === LEGACY_HOST) {
    return Response.redirect(PROD_ORIGIN + url.pathname + url.search, 301);
  }

  const res = await context.next();
  if (!url.hostname.endsWith('.pages.dev')) return res;

  const out = new Response(res.body, res);
  out.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}
