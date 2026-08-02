/**
 * 文章瀏覽計數器（Supabase）
 *
 * 設定來源：build 時由 site.config.json 注入到 window.__COUNTER__。
 * 只要 url 或 anonKey 是空的，就完全不動作，計數器維持隱藏，
 * 頁面不會出現壞掉的「–」或錯誤訊息。
 *
 * 需要的資料庫結構請見 README.md。
 */

(function () {
  'use strict';

  var cfg = window.__COUNTER__ || {};
  if (!cfg.url || !cfg.anonKey) return;   // 尚未設定 → 靜默略過

  var BASE = String(cfg.url).replace(/\/+$/, '');
  var TABLE = cfg.table || 'page_views';
  var RPC = cfg.rpc || 'increment_view';

  var HEADERS = {
    'apikey': cfg.anonKey,
    'Authorization': 'Bearer ' + cfg.anonKey,
    'Content-Type': 'application/json'
  };

  var nodes = Array.prototype.slice.call(document.querySelectorAll('.views[data-slug]'));
  if (!nodes.length) return;

  var pageSlug = document.body.getAttribute('data-page-slug');

  function show(slug, n) {
    if (typeof n !== 'number' || !isFinite(n)) return;
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

  /* 1. 為目前這一頁 +1 */
  function increment() {
    if (!pageSlug) return Promise.resolve();
    if (alreadyCounted(pageSlug)) return Promise.resolve();

    return fetch(BASE + '/rest/v1/rpc/' + RPC, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ p_slug: pageSlug })
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (n) {
      if (typeof n === 'number') show(pageSlug, n);
    }).catch(function () { /* 計數失敗不影響閱讀 */ });
  }

  /* 2. 讀回頁面上所有需要顯示的數字（首頁卡片、全站計數） */
  function refresh() {
    var slugs = nodes.map(function (el) { return el.getAttribute('data-slug'); })
                     .filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    if (!slugs.length) return;

    var list = slugs.map(function (s) { return '"' + s.replace(/"/g, '') + '"'; }).join(',');
    var url = BASE + '/rest/v1/' + TABLE + '?select=slug,views&slug=in.(' + encodeURIComponent(list) + ')';

    fetch(url, { headers: HEADERS })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (rows) {
        (rows || []).forEach(function (row) { show(row.slug, row.views); });
      })
      .catch(function () { /* 讀取失敗就維持隱藏 */ });
  }

  increment().then(refresh);
})();
