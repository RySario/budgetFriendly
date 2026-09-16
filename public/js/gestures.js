// Touch gestures for phones: pull down at the top of a page to refresh it, and
// swipe sideways to move to the neighbouring page. A drag commits to one axis
// after a few pixels, so ordinary scrolling, horizontally scrolling strips and
// form controls behave as they always did.

import { $, icon } from './ui.js';

const LOCK = 10; // px of movement before a drag picks an axis
const PULL_MAX = 110; // furthest the page follows the finger
const PULL_TRIGGER = 70; // release past this to refresh
const PULL_HOLD = 56; // where the page rests while refreshing
const SWIPE_EDGE = 16; // leave the screen edges to the OS back gesture
const SWIPE_COMMIT = 0.28; // fraction of the width that changes page
const SWIPE_FLICK = 0.45; // px/ms; a quick flick also changes page

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function animate(el, keyframes, duration) {
  const anim = el.animate(keyframes, { duration: reducedMotion() ? 1 : duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
  return anim.finished.catch(() => { /* cancelled by a newer gesture */ });
}

/** True when the touch starts on something that owns horizontal drags itself. */
function ownsHorizontal(target, root) {
  if (target.closest('input, textarea, select, [contenteditable], [data-no-swipe]')) return true;
  for (let el = target; el && el !== root; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

/**
 * opts.enabled()    whether gestures apply right now (signed in, nothing open)
 * opts.onRefresh()  reloads the page; may return a promise
 * opts.neighbour(d) the hash one page to the left (-1) or right (1), or null
 * opts.navigate(h)  goes to that hash
 */
export function initGestures({ enabled, onRefresh, neighbour, navigate }) {
  const indicator = document.createElement('div');
  indicator.className = 'ptr';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = `<div class="ptr-disc">${icon('refresh')}</div>`;
  document.body.append(indicator);
  const disc = indicator.firstElementChild;

  let g = null; // the gesture in progress
  let refreshing = false;
  let enterFrom = 0; // side the next page slides in from after a swipe

  const content = () => $('#content');

  function setPull(distance) {
    const top = $('.topbar').getBoundingClientRect().bottom;
    const progress = Math.min(1, distance / PULL_TRIGGER);
    indicator.style.top = `${top}px`;
    indicator.style.transform = `translate(-50%, ${distance - 44}px)`;
    indicator.style.opacity = String(progress);
    disc.style.transform = `rotate(${distance * 3}deg) scale(${0.6 + 0.4 * progress})`;
    indicator.classList.toggle('armed', distance >= PULL_TRIGGER);
    content().style.transform = distance ? `translateY(${distance}px)` : '';
  }

  function settlePull(to) {
    indicator.style.transition = content().style.transition = reducedMotion() ? 'none' : 'transform 0.25s ease, opacity 0.25s ease';
    setPull(to);
    setTimeout(() => { indicator.style.transition = content().style.transition = ''; }, 260);
  }

  async function refresh() {
    refreshing = true;
    settlePull(PULL_HOLD);
    indicator.classList.add('spinning');
    const minimum = new Promise((r) => { setTimeout(r, 500); });
    try {
      await Promise.all([onRefresh(), minimum]);
    } finally {
      indicator.classList.remove('spinning', 'armed');
      settlePull(0);
      refreshing = false;
    }
  }

  function setSwipe(dx) {
    const view = content().querySelector('.view');
    if (!view) return;
    const hasNext = neighbour(dx < 0 ? 1 : -1);
    // Resist past the first and last page.
    const x = hasNext ? dx : dx / 4;
    view.style.transform = x ? `translateX(${x}px)` : '';
    view.style.opacity = x ? String(1 - Math.min(0.35, Math.abs(x) / window.innerWidth)) : '';
  }

  async function endSwipe(dx, velocity) {
    const view = content().querySelector('.view');
    if (!view) return;
    const dir = dx < 0 ? 1 : -1;
    const target = neighbour(dir);
    const width = window.innerWidth;
    const from = { transform: view.style.transform || 'none', opacity: view.style.opacity || 1 };
    view.style.transform = view.style.opacity = '';

    if (target && (Math.abs(dx) > width * SWIPE_COMMIT || Math.abs(velocity) > SWIPE_FLICK)) {
      animate(view, [from, { transform: `translateX(${-dir * width}px)`, opacity: 0 }], 180);
      enterFrom = dir;
      navigate(target);
    } else {
      animate(view, [from, { transform: 'none', opacity: 1 }], 220).then(() => {
        view.getAnimations().forEach((a) => a.cancel());
      });
    }
  }

  document.addEventListener('touchstart', (e) => {
    g = null;
    if (e.touches.length !== 1 || refreshing || !enabled()) return;
    const t = e.touches[0];
    if (!e.target.closest('#app') || e.target.closest('.tabbar')) return;
    g = {
      x: t.clientX,
      y: t.clientY,
      time: e.timeStamp,
      axis: null,
      canPull: window.scrollY <= 0,
      canSwipe: !!e.target.closest('#content')
        && t.clientX > SWIPE_EDGE && t.clientX < window.innerWidth - SWIPE_EDGE
        && !ownsHorizontal(e.target, content()),
    };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!g || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;

    if (!g.axis) {
      if (Math.abs(dx) < LOCK && Math.abs(dy) < LOCK) return;
      if (Math.abs(dy) > Math.abs(dx)) g.axis = dy > 0 && g.canPull && window.scrollY <= 0 ? 'pull' : 'none';
      else g.axis = g.canSwipe ? 'swipe' : 'none';
      if (g.axis === 'none') { g = null; return; }
      // Start from where the drag locked so the page doesn't jump.
      g.x = t.clientX;
      g.y = t.clientY;
      g.time = e.timeStamp;
      $('#chart-tooltip').hidden = true;
      return;
    }

    if (e.cancelable) e.preventDefault();
    if (g.axis === 'pull') {
      // Eases off the further it goes, like a rubber band.
      const d = Math.max(0, dy);
      setPull(PULL_MAX * (1 - Math.exp(-d / (PULL_MAX * 1.6))));
      g.pulled = d;
    } else {
      setSwipe(dx);
      g.dx = dx;
      g.velocity = dx / Math.max(1, e.timeStamp - g.time);
    }
  }, { passive: false });

  const end = () => {
    if (!g || !g.axis) { g = null; return; }
    const done = g;
    g = null;
    if (done.axis === 'pull') {
      if (indicator.classList.contains('armed')) refresh();
      else settlePull(0);
    } else {
      endSwipe(done.dx || 0, done.velocity || 0);
    }
  };
  document.addEventListener('touchend', end);
  document.addEventListener('touchcancel', end);

  return {
    /** Called once the new page is in place, to slide it in after a swipe. */
    enter(view) {
      if (!enterFrom) return;
      const offset = enterFrom * Math.min(80, window.innerWidth * 0.2);
      enterFrom = 0;
      animate(view, [{ transform: `translateX(${offset}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], 220).then(() => {
        view.getAnimations().forEach((a) => a.cancel());
      });
    },
  };
}
