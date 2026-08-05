/* 首頁橫滑卡片列的左右箭頭。
   卡片列本來就能用觸控或滾輪橫捲，這裡只是替滑鼠使用者補一個看得見的入口——
   所以按鈕預設是 hidden，只有這支腳本跑起來、而且真的捲得動時才打開。 */
(function () {
  var rails = document.querySelectorAll('.rail');
  if (!rails.length) return;

  rails.forEach(function (rail) {
    var track = rail.querySelector('.cards--rail');
    var prev = rail.querySelector('.rail__btn--prev');
    var next = rail.querySelector('.rail__btn--next');
    if (!track || !prev || !next) return;

    /* 一次捲一張卡：量第一張卡的寬度加上間距，量不到就退回可視寬度的八成 */
    function step() {
      var card = track.querySelector('.card');
      if (!card) return Math.round(track.clientWidth * 0.8);
      var gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      return Math.round(card.getBoundingClientRect().width + gap);
    }

    function sync() {
      /* 捲不動就整組收起來，順便把漸層遮罩關掉 */
      var scrollable = track.scrollWidth - track.clientWidth > 2;
      rail.classList.toggle('rail--active', scrollable);
      if (!scrollable) {
        prev.hidden = true;
        next.hidden = true;
        rail.classList.remove('rail--start', 'rail--end');
        return;
      }
      var x = track.scrollLeft;
      var max = track.scrollWidth - track.clientWidth;
      var atStart = x <= 2;
      var atEnd = x >= max - 2;
      prev.hidden = atStart;
      next.hidden = atEnd;
      rail.classList.toggle('rail--start', atStart);
      rail.classList.toggle('rail--end', atEnd);
    }

    /* 不指定 behavior，交給 CSS 的 scroll-behavior：
       在這裡寫 behavior:'smooth' 會和卡片列的 scroll-snap 吸附打架，捲不動。

       捲完之後再補算一次狀態。正常情況下 scroll 事件就會處理，
       但按下的那顆按鈕如果剛好要隱藏（例如一路捲到底），
       晚一步更新會讓焦點停在一顆消失的按鈕上，所以不要只依賴事件。 */
    function nudge(dir) {
      track.scrollBy({ left: dir * step() });
      sync();
      setTimeout(sync, 400);
    }
    prev.addEventListener('click', function () { nudge(-1); });
    next.addEventListener('click', function () { nudge(1); });

    /* 直接呼叫，不包 requestAnimationFrame：rAF 在分頁不可見時會被節流甚至不執行，
       箭頭就會卡在錯誤的狀態。sync() 只讀幾個捲動屬性，捲動當下這些值本來就是最新的。 */
    track.addEventListener('scroll', sync, { passive: true });

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(sync).observe(track);
    } else {
      window.addEventListener('resize', sync);
    }

    sync();
  });
})();
