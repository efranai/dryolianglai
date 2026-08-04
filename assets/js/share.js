/* 文章結尾的分享列。
   兩個需要 JS 的按鈕：
   1. 「分享…」——手機才顯示，叫出系統原生的分享選單。
      這是唯一能分享到 Instagram 的路（IG 沒有網頁版分享網址），
      順帶也涵蓋所有讀者裝置上裝過、但我們沒列出來的 App。
   2. 「複製連結」——桌機分享到 IG、或想貼到任何地方時用。
   其餘平台是純連結，沒有 JS 也能用。 */
(() => {
  /* 列印前把所有摺疊區塊展開。
     主要是為了 QR Code——收合狀態下瀏覽器不會把內容印出來；
     順帶讓「常見問題」的答案在列印時也一起出現。 */
  addEventListener('beforeprint', () => {
    document.querySelectorAll('details:not([open])').forEach((d) => {
      d.open = true;
      d.dataset.openedForPrint = '1';
    });
  });

  addEventListener('afterprint', () => {
    document.querySelectorAll('details[data-opened-for-print]').forEach((d) => {
      d.open = false;
      delete d.dataset.openedForPrint;
    });
  });

  const box = document.querySelector('.share');
  if (!box) return;

  const url = box.dataset.shareUrl;
  const title = box.dataset.shareTitle;
  const status = box.querySelector('.share__status');

  const say = (msg) => { if (status) status.textContent = msg; };

  /* --- 系統分享選單 --- */
  const native = box.querySelector('.share__btn--native');
  if (native && typeof navigator.share === 'function') {
    native.hidden = false;
    native.addEventListener('click', () => {
      /* 使用者按取消也會 reject，不需要提示 */
      navigator.share({ title, url }).catch(() => {});
    });
  }

  /* --- 複製連結 --- */
  const copy = box.querySelector('.share__btn--copy');
  if (!copy) return;

  const label = copy.querySelector('.share__copy-text');
  const defaultLabel = label ? label.textContent : '';
  let timer;

  copy.addEventListener('click', async () => {
    const ok = await writeClipboard(url);
    clearTimeout(timer);

    copy.classList.toggle('is-done', ok);
    if (label) label.textContent = ok ? '已複製' : '請長按網址列複製';
    say(ok ? '文章網址已複製到剪貼簿' : '無法自動複製，請手動複製網址');

    timer = setTimeout(() => {
      copy.classList.remove('is-done');
      if (label) label.textContent = defaultLabel;
      say('');
    }, 2400);
  });

  async function writeClipboard(text) {
    /* 需要安全連線（https 或 localhost）；不支援時退回舊做法 */
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch { /* 使用者拒絕權限或瀏覽器不支援，往下走備援 */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);   /* iOS 需要明確指定範圍 */
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
})();
