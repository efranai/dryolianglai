/**
 * 瀏覽計數（前端）
 *
 * 呼叫本站的 /api/views（Cloudflare Pages Function + D1）：
 *   1. 先為目前這一頁 +1
 *   2. 再取回所有頁面的次數，填進首頁卡片、文章頁與頁尾
 *
 * 設定在 build 時由 site.config.json 注入到 window.__COUNTER__。
 * enabled 為 false 或抓不到資料時，計數器維持隱藏，
 * 頁面不會出現壞掉的「–」或錯誤訊息。
 */

(function () {
  'use strict';

  var cfg = window.__COUNTER__ || {};
  if (!cfg.enabled || !cfg.endpoint) return;

  var nodes = Array.prototype.slice.call(document.querySelectorAll('.views[data-slug]'));
  if (!nodes.length) return;

  var pageSlug = document.body.getAttribute('data-page-slug');

  function show(slug, value) {
    var n = Number(value);
    if (!isFinite(n)) return;
    nodes.forEach(function (el) {
      if (el.getAttribute('data-slug') !== slug) return;
      var out = el.querySelector('.views__n');
      if (out) out.textContent = n.toLocaleString('zh-Hant-TW');
      el.hidden = false;
    });
  }

  /* 同一個瀏覽階段內重整不重複計數 */
  function alreadyCounted(slug) {
    try {
      var key = 'viewed:' + slug;
      if (sessionStorage.getItem(key)) return true;
      sessionStorage.setItem(key, '1');
      return false;
    } catch (e) {
      return false;   // 隱私模式下 sessionStorage 可能不可用，就照常計數
    }
  }

  function increment() {
    if (!pageSlug || alreadyCounted(pageSlug)) return Promise.resolve();

    return fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: pageSlug })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.views != null) show(d.slug, d.views); })
      .catch(function () { /* 計數失敗不影響閱讀 */ });
  }

  function refresh() {
    return fetch(cfg.endpoint, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (counts) {
        if (!counts) return;
        /* 逐一走訪頁面上的計數器而非 API 回傳的鍵值：
           還沒有人看過的文章在資料庫裡沒有那一筆，要顯示 0 而不是整個藏起來，
           否則會變成有些卡片有數字、有些沒有，看起來像壞掉。 */
        nodes.forEach(function (el) {
          var slug = el.getAttribute('data-slug');
          show(slug, counts[slug] != null ? counts[slug] : 0);
        });
      })
      .catch(function () { /* 讀取失敗就維持隱藏 */ });
  }

  increment().then(refresh);
})();
