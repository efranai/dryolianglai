/**
 * 瀏覽計數 API（Cloudflare Pages Function + D1）
 *
 *   GET  /api/views          取回所有頁面的次數 → { "slug": 123, ... }
 *   POST /api/views  {slug}  該頁 +1，回傳新的次數
 *
 * 跑在網站同一個網域下，因此不需要 CORS，也沒有第三方服務。
 */

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

/* 只允許本站會用到的字元，避免有人塞進任意鍵值把資料表灌滿 */
const SLUG_OK = /^[A-Za-z0-9_-]{1,80}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: HEADERS });

export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB
      .prepare('SELECT slug, views FROM page_views')
      .all();

    const out = {};
    for (const row of results) out[row.slug] = row.views;
    return json(out);
  } catch (err) {
    return json({ error: 'read failed' }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  let slug;
  try {
    ({ slug } = await request.json());
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  if (typeof slug !== 'string' || !SLUG_OK.test(slug)) {
    return json({ error: 'invalid slug' }, 400);
  }

  try {
    const row = await env.DB
      .prepare(
        `INSERT INTO page_views (slug, views, updated_at)
         VALUES (?1, 1, datetime('now'))
         ON CONFLICT(slug) DO UPDATE
           SET views = views + 1, updated_at = datetime('now')
         RETURNING views`
      )
      .bind(slug)
      .first();

    return json({ slug, views: row ? row.views : null });
  } catch (err) {
    return json({ error: 'write failed' }, 500);
  }
}
