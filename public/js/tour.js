// First-run guided tour. Each step points at a piece of the app shell — the
// upload button, a navigation item, the theme switch — with a spotlight and a
// card. A step whose target isn't on screen (the sidebar on a phone) falls back
// to the next selector in its list, or to a centred card.

import { esc } from './format.js';
import { icon } from './ui.js';

const DESKTOP = '(min-width: 960px)';

const STEPS = [
  {
    title: 'Welcome to BudgetFriendly',
    body: "Here's a one-minute look around. You can skip it now and replay it any time.",
  },
  {
    target: '[data-tour="upload"]',
    title: 'Bring in your transactions',
    body: 'Download an OFX file from Golden 1 online banking and upload it here. Overlapping dates are fine — anything already imported is skipped.',
  },
  {
    target: '[data-tour="nav-dashboard"]',
    title: 'Dashboard',
    body: "Your everyday overview: what's left to spend before payday, this month's spending, bills coming up and recent transactions.",
  },
  {
    target: '[data-tour="nav-plan"]',
    title: 'Paycheck plan',
    body: 'How much you can spend each paycheck and still pay your bills and reach your goals. Try your own amount and see how it moves each goal.',
  },
  {
    target: '[data-tour="nav-transactions"]',
    title: 'Transactions',
    body: 'New uploads arrive marked for review. Fix a category once, choose "Always categorize", and future uploads follow.',
  },
  {
    target: '[data-tour="nav-budget"]',
    title: 'Budget',
    body: 'A monthly amount for each category. It carries into later months until you change it.',
  },
  {
    target: '[data-tour="nav-goals"], [data-tour="more"]',
    title: 'Goals and more',
    body: 'Goals, recurring bills, cash flow and accounts live here.',
    mobileBody: 'Goals, recurring bills, cash flow, accounts and settings are under More.',
  },
  {
    target: '[data-tour="theme"]',
    title: 'Light or dark',
    body: 'Switch between light and dark here. Settings can also follow your device.',
  },
  {
    target: '[data-tour="help"], [data-tour="more"]',
    title: 'Replay any time',
    body: 'Open this tour again from here or from Settings.',
    mobileBody: 'Open this tour again from More or from Settings.',
  },
];

function isVisible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function findTarget(selectors) {
  if (!selectors) return null;
  for (const selector of selectors.split(',')) {
    const hit = [...document.querySelectorAll(selector.trim())].find(isVisible);
    if (hit) return hit;
  }
  return null;
}

let active = null;

/** Start the tour. onFinish runs when it's completed or dismissed. */
export function startTour({ onFinish } = {}) {
  if (active) active.end(false);

  const layer = document.createElement('div');
  layer.className = 'tour';
  layer.innerHTML = `
    <div class="tour-spot" aria-hidden="true" hidden></div>
    <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title" tabindex="-1"></div>`;
  document.body.append(layer);
  document.body.classList.add('no-scroll');

  const spot = layer.querySelector('.tour-spot');
  const card = layer.querySelector('.tour-card');
  const previousFocus = document.activeElement;
  let index = 0;
  let target = null;
  let frame = 0;

  const place = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 16;
    const gap = 14;
    const width = Math.min(360, vw - margin * 2);
    card.style.width = `${width}px`;
    const height = card.offsetHeight;

    if (!target) {
      spot.hidden = true;
      card.style.left = `${Math.round((vw - width) / 2)}px`;
      card.style.top = `${Math.round(Math.max(margin, (vh - height) / 2))}px`;
      return;
    }

    const r = target.getBoundingClientRect();
    const pad = 6;
    spot.hidden = false;
    Object.assign(spot.style, {
      left: `${r.left - pad}px`,
      top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`,
      height: `${r.height + pad * 2}px`,
    });

    let left;
    let top;
    if (r.left < vw / 3 && r.right + pad + gap + width <= vw - margin) {
      // Beside a target on the left edge, such as the sidebar.
      left = r.right + pad + gap;
      top = r.top + r.height / 2 - height / 2;
    } else if (r.bottom + pad + gap + height <= vh - margin) {
      left = r.left + r.width / 2 - width / 2;
      top = r.bottom + pad + gap;
    } else {
      left = r.left + r.width / 2 - width / 2;
      top = r.top - pad - gap - height;
    }
    card.style.left = `${Math.round(Math.min(Math.max(margin, left), vw - width - margin))}px`;
    card.style.top = `${Math.round(Math.min(Math.max(margin, top), vh - height - margin))}px`;
  };

  const show = (i) => {
    index = i;
    const step = STEPS[i];
    const desktop = window.matchMedia(DESKTOP).matches;
    const last = i === STEPS.length - 1;
    target = findTarget(step.target);
    if (target) target.scrollIntoView({ block: 'nearest' });
    layer.classList.toggle('centered', !target);

    card.innerHTML = `
      <div class="tour-top">
        <span class="tour-count">${i + 1} of ${STEPS.length}</span>
        <button class="icon-btn" type="button" data-tour-close aria-label="Close tour">${icon('x')}</button>
      </div>
      <h2 id="tour-title">${esc(step.title)}</h2>
      <p>${esc(!desktop && step.mobileBody ? step.mobileBody : step.body)}</p>
      <div class="tour-dots" aria-hidden="true">${STEPS.map((_, j) => `<span class="${j === i ? 'on' : ''}"></span>`).join('')}</div>
      <div class="tour-actions">
        ${i === 0
          ? '<button class="btn btn-quiet" type="button" data-tour-close>Skip tour</button>'
          : '<button class="btn" type="button" data-tour-back>Back</button>'}
        <button class="btn btn-primary" type="button" data-tour-next>${last ? 'Done' : i === 0 ? 'Show me around' : 'Next'}</button>
      </div>`;
    place();
    card.querySelector('[data-tour-next]').focus();
  };

  const end = (finished) => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('keydown', onKey, true);
    layer.remove();
    document.body.classList.remove('no-scroll');
    active = null;
    if (previousFocus && previousFocus.focus) previousFocus.focus();
    if (finished && onFinish) onFinish();
  };

  const next = () => (index === STEPS.length - 1 ? end(true) : show(index + 1));

  function onResize() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      target = findTarget(STEPS[index].target);
      layer.classList.toggle('centered', !target);
      place();
    });
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(true); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); return; }
    if (e.key === 'ArrowLeft' && index > 0) { e.preventDefault(); show(index - 1); return; }
    if (e.key === 'Tab') {
      // Keep focus inside the card while the tour is open.
      const buttons = [...card.querySelectorAll('button')];
      const first = buttons[0];
      const lastButton = buttons[buttons.length - 1];
      if (!card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastButton.focus(); }
      else if (!e.shiftKey && document.activeElement === lastButton) { e.preventDefault(); first.focus(); }
    }
  }

  layer.addEventListener('click', (e) => {
    if (e.target.closest('[data-tour-close]')) end(true);
    else if (e.target.closest('[data-tour-next]')) next();
    else if (e.target.closest('[data-tour-back]')) show(index - 1);
  });
  window.addEventListener('resize', onResize);
  document.addEventListener('keydown', onKey, true);

  active = { end };
  show(0);
}
