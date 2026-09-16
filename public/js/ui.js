// Shared UI: icons, theme, toasts, drawer, modal and small markup helpers. Any
// text that came from data goes through esc() before it reaches innerHTML.

import { esc, monthLabel, currentMonthKey, txnAmount } from './format.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// --- icons (24px grid, stroke) ----------------------------------------------

const PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  accounts: '<path d="M3 10h18M5 10V20M9.5 10V20M14.5 10V20M19 10V20M3 21h18M12 3l9 5H3z"/>',
  transactions: '<path d="M4 7h12M4 12h16M4 17h10"/>',
  cashflow: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  budget: '<circle cx="12" cy="12" r="9"/><path d="M12 3v9l6.4 6.4"/>',
  recurring: '<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5M7 21.5 3.5 18 7 14.5"/><path d="M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5"/>',
  goals: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  upload: '<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  right: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M3 7h16a2 2 0 0 1 2 2v3h-5a2 2 0 0 0 0 4h5"/><path d="M16 14h.01"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  eyeOff: '<path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-10-8-10-8a18 18 0 0 1 4.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.2M1 1l22 22"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.5-3 4.5M12 17.5h.01"/>',
  filter: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
};

export function icon(name, size) {
  const s = size ? ` width="${size}" height="${size}"` : '';
  return `<svg viewBox="0 0 24 24"${s} fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

// --- theme --------------------------------------------------------------------
// The choice is per device: a phone can stay dark while a desktop follows the
// system. theme.js applies it before first paint; this is the runtime side.

const THEME_KEY = 'bf-theme';
export const THEME_OPTIONS = [['light', 'Light'], ['dark', 'Dark'], ['system', 'Auto']];

/** 'light', 'dark' or 'system' (follow the device). */
export function themeChoice() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

export function effectiveTheme() {
  const choice = themeChoice();
  if (choice === 'light' || choice === 'dark') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(choice) {
  try {
    if (choice === 'light' || choice === 'dark') localStorage.setItem(THEME_KEY, choice);
    else localStorage.removeItem(THEME_KEY);
  } catch { /* storage blocked: the change lasts for this visit */ }
  if (window.bfApplyTheme) window.bfApplyTheme(choice);
  window.dispatchEvent(new CustomEvent('bf-themechange'));
}

// --- toast --------------------------------------------------------------------

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6000 : 3200);
}

// --- drawer (side panel on desktop, bottom sheet on mobile) -----------------

let drawerCleanup = null;

export function closeDrawer() {
  if (drawerCleanup) drawerCleanup();
}

export function openDrawer({ title, body, footer = '', onMount }) {
  closeDrawer();
  const drawer = $('#drawer');
  const scrim = $('#scrim');
  const previousFocus = document.activeElement;

  drawer.innerHTML = `
    <div class="drawer-head">
      <h2 id="drawer-title">${esc(title)}</h2>
      <button class="icon-btn" type="button" data-drawer-close aria-label="Close">${icon('x')}</button>
    </div>
    <div class="drawer-body">${body}</div>
    ${footer ? `<div class="drawer-foot">${footer}</div>` : ''}`;
  drawer.hidden = false;
  scrim.hidden = false;
  document.body.classList.add('no-scroll');
  requestAnimationFrame(() => { drawer.classList.add('open'); scrim.classList.add('open'); });

  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const close = () => {
    drawerCleanup = null;
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('no-scroll');
    setTimeout(() => { drawer.hidden = true; scrim.hidden = true; drawer.innerHTML = ''; }, 200);
    if (previousFocus && previousFocus.focus) previousFocus.focus();
  };
  drawerCleanup = close;

  drawer.querySelector('[data-drawer-close]').addEventListener('click', close);
  scrim.onclick = close;
  document.addEventListener('keydown', onKey);
  if (onMount) onMount(drawer, close);
  const first = drawer.querySelector('.drawer-body input, .drawer-body select, .drawer-body textarea, .drawer-body button');
  if (first && window.matchMedia('(min-width: 960px)').matches) first.focus();
  return close;
}

// --- modal ------------------------------------------------------------------

let modalCleanup = null;

export function closeModal() {
  if (modalCleanup) modalCleanup();
}

export function openModal({ html, dismissible = true, onMount }) {
  closeModal();
  const layer = $('#modal-layer');
  const modal = $('#modal');
  modal.innerHTML = html;
  layer.hidden = false;

  const onKey = (e) => { if (e.key === 'Escape' && dismissible) close(); };
  const onLayer = (e) => { if (e.target === layer && dismissible) close(); };
  const close = () => {
    modalCleanup = null;
    layer.hidden = true;
    modal.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    layer.removeEventListener('click', onLayer);
  };
  modalCleanup = close;
  document.addEventListener('keydown', onKey);
  layer.addEventListener('click', onLayer);
  modal.querySelectorAll('[data-modal-close]').forEach((b) => b.addEventListener('click', close));
  if (onMount) onMount(modal, close);
  return close;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      html: `
        <h2>${esc(title)}</h2>
        <p class="ink-2">${esc(message)}</p>
        <div class="modal-actions">
          <button class="btn" type="button" data-choice="no">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-choice="yes">${esc(confirmLabel)}</button>
        </div>`,
      onMount(modal, close) {
        modal.querySelectorAll('[data-choice]').forEach((b) => b.addEventListener('click', () => {
          close();
          resolve(b.dataset.choice === 'yes');
        }));
      },
    });
  });
}

// --- markup helpers -------------------------------------------------------------

export function monthSwitcher(month) {
  const atCurrent = month >= currentMonthKey();
  return `
    <div class="month-switch" role="group" aria-label="Month">
      <button class="icon-btn" type="button" data-month-step="-1" aria-label="Previous month">${icon('left')}</button>
      <span class="label">${esc(monthLabel(month))}</span>
      <button class="icon-btn" type="button" data-month-step="1" aria-label="Next month" ${atCurrent ? 'disabled' : ''}>${icon('right')}</button>
    </div>`;
}

export function segmented(name, options, value) {
  return `<div class="seg" role="tablist" aria-label="${esc(name)}">${options.map(([v, label]) => `
    <button type="button" role="tab" data-seg="${esc(name)}" data-value="${esc(v)}"
      aria-selected="${v === value}" class="${v === value ? 'active' : ''}">${esc(label)}</button>`).join('')}</div>`;
}

/** Mark one button of a segmented control as selected without re-rendering. */
export function markSegment(button) {
  const group = button.closest('.seg');
  if (!group) return;
  group.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', b === button);
    b.setAttribute('aria-selected', String(b === button));
  });
}

export function avatar(name, cls = '') {
  const letter = String(name || '?').trim().charAt(0).toUpperCase() || '?';
  return `<span class="avatar ${cls}" aria-hidden="true">${esc(letter)}</span>`;
}

export function pill(emoji, name) {
  if (!name) return '<span class="pill"><span>❓</span><span class="truncate">Uncategorized</span></span>';
  return `<span class="pill"><span aria-hidden="true">${esc(emoji || '•')}</span><span class="truncate">${esc(name)}</span></span>`;
}

export function amount(value, kind) {
  const cls = kind === 'transfer' ? 'transfer' : Number(value) > 0 ? 'income' : '';
  return `<span class="amount ${cls}">${esc(txnAmount(value))}</span>`;
}

export function meter(fraction, cls = '') {
  const w = Math.max(0, Math.min(1, Number(fraction) || 0)) * 100;
  return `<div class="meter ${cls}"><span style="width:${w.toFixed(1)}%"></span></div>`;
}

export function empty(title, body = '', action = '') {
  return `<div class="empty"><div class="empty-title">${esc(title)}</div>${body ? `<div>${esc(body)}</div>` : ''}${action}</div>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar-page date badge for list rows; the date is also given to screen readers. */
export function dateTile(iso) {
  const [, m, d] = String(iso).split('-');
  const label = `${MONTHS[Number(m) - 1]} ${Number(d)}`;
  return `<span class="date-tile"><span class="date-tile-m" aria-hidden="true">${MONTHS[Number(m) - 1]}</span><span class="date-tile-d" aria-hidden="true">${Number(d)}</span><span class="sr-only">${label}</span></span>`;
}

/** A category <select> grouped by category group. */
export function categorySelect(groups, selectedId, { name = 'categoryId', includeTransfers = true } = {}) {
  return `<select name="${esc(name)}">${groups
    .filter((g) => includeTransfers || g.kind !== 'transfer')
    .map((g) => `<optgroup label="${esc(g.name)}">${g.categories.map((c) => `
      <option value="${c.id}" ${String(c.id) === String(selectedId) ? 'selected' : ''}>${esc(`${c.emoji || ''} ${c.name}`.trim())}</option>`).join('')}
    </optgroup>`).join('')}</select>`;
}
