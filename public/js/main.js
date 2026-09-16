// App shell: auth, routing, navigation, theme, the guided tour and the upload
// flow. Each screen lives in views/ and renders into a fresh element; the
// previous screen stays on display, dimmed, until the new one is ready, so
// nothing flashes.

import { api, get, post, patch, setUnauthorizedHandler } from './api.js';
import {
  $, icon, toast, openDrawer, closeDrawer, openModal, closeModal, segmented, markSegment,
  themeChoice, effectiveTheme, setTheme, THEME_OPTIONS,
} from './ui.js';
import { esc, currentMonthKey, shiftMonth, longDate, plural } from './format.js';
import { startTour } from './tour.js';
import { initGestures } from './gestures.js';

const ROUTES = {
  dashboard: { title: 'Dashboard', icon: 'dashboard', load: () => import('./views/dashboard.js') },
  plan: { title: 'Paycheck', icon: 'wallet', load: () => import('./views/plan.js') },
  accounts: { title: 'Accounts', icon: 'accounts', load: () => import('./views/accounts.js') },
  transactions: { title: 'Transactions', icon: 'transactions', load: () => import('./views/transactions.js'), badge: true },
  cashflow: { title: 'Cash Flow', icon: 'cashflow', load: () => import('./views/cashflow.js') },
  budget: { title: 'Budget', icon: 'budget', load: () => import('./views/budget.js') },
  recurring: { title: 'Recurring', icon: 'recurring', load: () => import('./views/recurring.js') },
  goals: { title: 'Goals', icon: 'goals', load: () => import('./views/goals.js') },
  settings: { title: 'Settings', icon: 'settings', load: () => import('./views/settings.js') },
};
// Sidebar sections: the everyday screens first, then planning, then reports.
const NAV = [
  { label: '', items: ['dashboard', 'plan', 'transactions'] },
  { label: 'Planning', items: ['budget', 'recurring', 'goals'] },
  { label: 'Insights', items: ['cashflow', 'accounts'] },
];
const TABS = ['dashboard', 'plan', 'transactions', 'budget'];
const MORE = ['recurring', 'goals', 'cashflow', 'accounts', 'settings'];
// Swiping sideways walks the pages in the order the tab bar and More sheet list them.
const SWIPE_ORDER = [...TABS, ...MORE];

const state = { user: null, month: currentMonthKey(), groups: null, reviewCount: 0, prefs: null };

let renderSeq = 0;
let currentPath = null;
let cleanups = [];
let headerHandler = null;
let gestures = null;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { path: ROUTES[path] ? path : 'dashboard', params: new URLSearchParams(query) };
}

export function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function badge(path) {
  if (!ROUTES[path].badge || !state.reviewCount) return '';
  return `<span class="badge" aria-label="${state.reviewCount} to review">${state.reviewCount > 99 ? '99+' : state.reviewCount}</span>`;
}

function renderNav(active) {
  const link = (p, cls) => {
    const on = p === active;
    return `<a class="${cls} ${on ? 'active' : ''}" href="#/${p}" data-tour="nav-${p}" ${on ? 'aria-current="page"' : ''}>
      ${icon(ROUTES[p].icon)}<span>${ROUTES[p].title}</span>${badge(p)}</a>`;
  };

  $('#side-nav').innerHTML = NAV.map((section) => `
    <div class="side-section">
      ${section.label ? `<div class="side-label">${section.label}</div>` : ''}
      ${section.items.map((p) => link(p, 'side-link')).join('')}
    </div>`).join('');
  $('#side-settings').classList.toggle('active', active === 'settings');

  const inTabs = TABS.includes(active);
  $('#tabbar').innerHTML = `
    ${TABS.map((p) => link(p, 'tab')).join('')}
    <button class="tab ${inTabs ? '' : 'active'}" type="button" data-action="more" data-tour="more">${icon('more')}<span>More</span></button>`;
}

async function refreshBadges() {
  try {
    const s = await get('/settings');
    state.reviewCount = s.counts.needs_review;
    state.prefs = s.preferences || {};
    renderNav(currentPath);
  } catch { /* badges are cosmetic */ }
}

/** opts.keepDrawer re-renders behind an open drawer, e.g. after a theme change. */
async function render(opts = {}) {
  const seq = ++renderSeq;
  const { path, params } = parseHash();
  const route = ROUTES[path];
  const samePage = path === currentPath;
  currentPath = path;

  if (!opts.keepDrawer) closeDrawer();
  document.title = `${route.title} · BudgetFriendly`;
  $('#page-title').textContent = route.title;
  renderNav(path);

  const content = $('#content');
  const previous = content.querySelector('.view');
  if (previous) previous.classList.add('loading');
  else content.innerHTML = '<div class="view"><div class="empty">Loading…</div></div>';
  if (!samePage) { $('#page-actions').innerHTML = ''; headerHandler = null; }

  const view = document.createElement('div');
  view.className = 'view';
  const pending = [];
  let actions = null;
  let handler = null;
  let after = null;

  const ctx = {
    view,
    params,
    state,
    navigate,
    rerender: () => render(),
    refreshBadges,
    setActions: (html) => { actions = html; },
    setHeaderHandler: (fn) => { handler = fn; },
    afterMount: (fn) => { after = fn; },
    onCleanup: (fn) => { if (typeof fn === 'function') pending.push(fn); },
    groups: async () => {
      if (!state.groups) state.groups = (await get('/categories')).groups;
      return state.groups;
    },
    invalidateGroups: () => { state.groups = null; },
  };

  try {
    const mod = await route.load();
    await mod.default(ctx);
    if (seq !== renderSeq) { pending.forEach((fn) => fn()); return; }

    cleanups.forEach((fn) => fn());
    cleanups = pending;
    $('#page-actions').innerHTML = actions || '';
    headerHandler = handler;
    content.replaceChildren(view);
    if (!samePage) window.scrollTo(0, 0);
    if (gestures) gestures.enter(view);
    if (after) after();
  } catch (err) {
    if (seq !== renderSeq || err.status === 401) return;
    console.error(err);
    content.innerHTML = `
      <div class="view"><section class="card"><div class="empty">
        <div class="empty-title">This page didn't load</div><div>${esc(err.message)}</div>
        <button class="btn" type="button" data-retry>Try again</button>
      </div></section></div>`;
    content.querySelector('[data-retry]').addEventListener('click', () => render());
  }
}

// --- upload -------------------------------------------------------------------

async function uploadFile(file) {
  if (!file) return;
  closeDrawer();
  openModal({
    dismissible: false,
    html: `
      <div class="modal-icon"><div class="spinner" aria-hidden="true"></div></div>
      <h2>Importing ${esc(file.name)}</h2>
      <p class="ink-2">Adding transactions, sorting them into categories and finding recurring bills.</p>`,
  });

  try {
    const form = new FormData();
    form.append('file', file);
    const { result } = await api('/import', { method: 'POST', body: form });
    state.groups = null;

    const accounts = result.accounts.map((a) => esc(a.name)).join(', ') || '—';
    openModal({
      html: `
        <div class="modal-icon good">${icon('check')}</div>
        <h2>${result.imported ? `Imported ${plural(result.imported, 'transaction')}` : 'Already up to date'}</h2>
        <p class="ink-2">${result.imported
          ? 'New transactions are marked for review so you can check their categories.'
          : 'Everything in this file was already here, so nothing was added.'}</p>
        <dl class="stat-list">
          <dt>New</dt><dd>${result.imported}</dd>
          <dt>Already here</dt><dd>${result.duplicates}</dd>
          <dt>Account</dt><dd>${accounts}</dd>
          ${result.firstOn ? `<dt>Dates</dt><dd>${esc(longDate(result.firstOn))} – ${esc(longDate(result.lastOn))}</dd>` : ''}
        </dl>
        <div class="modal-actions">
          ${result.imported
            ? '<button class="btn" type="button" data-modal-close>Close</button><button class="btn btn-primary" type="button" data-review>Review transactions</button>'
            : '<button class="btn btn-primary" type="button" data-modal-close>Done</button>'}
        </div>`,
      onMount(modal, close) {
        const review = modal.querySelector('[data-review]');
        if (review) review.addEventListener('click', () => { close(); navigate('#/transactions?review=1'); });
      },
    });
    await refreshBadges();
    render();
  } catch (err) {
    openModal({
      html: `
        <div class="modal-icon bad">${icon('alert')}</div>
        <h2>That file wasn't imported</h2>
        <p class="ink-2">${esc(err.message)}</p>
        <p class="small muted" style="margin-top:10px">In Golden 1 online banking, download transactions as <strong>OFX</strong> or <strong>Quicken (.QFX)</strong>.</p>
        <div class="modal-actions"><button class="btn btn-primary" type="button" data-modal-close>OK</button></div>`,
    });
  }
}

function openMore() {
  openDrawer({
    title: 'More',
    body: `
      <nav class="more-grid" aria-label="More pages">
        ${MORE.map((p) => `
          <a class="more-tile ${p === currentPath ? 'active' : ''}" href="#/${p}">${icon(ROUTES[p].icon)}<span>${ROUTES[p].title}</span></a>`).join('')}
      </nav>
      <div class="more-section">
        <div class="field-label">Appearance</div>
        ${segmented('theme', THEME_OPTIONS, themeChoice())}
      </div>
      <div class="more-actions">
        <button class="btn btn-primary btn-block" type="button" data-action="upload">${icon('upload')}Upload statement</button>
        <button class="btn btn-block" type="button" data-action="tour">${icon('help')}Take the tour</button>
        <button class="btn btn-quiet btn-block" type="button" data-action="logout">${icon('logout')}Sign out</button>
      </div>`,
  });
}

// --- theme and tour -------------------------------------------------------------

function updateThemeButton() {
  const dark = effectiveTheme() === 'dark';
  const button = $('#theme-toggle');
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  button.innerHTML = icon(dark ? 'sun' : 'moon');
  button.setAttribute('aria-label', label);
  button.title = label;
}

function onThemeChange() {
  updateThemeButton();
  // Charts read their colours when drawn, so redraw the page behind any drawer.
  if (state.user) render({ keepDrawer: true });
}

function runTour() {
  closeDrawer();
  closeModal();
  startTour({
    onFinish() {
      state.prefs = { ...(state.prefs || {}), tourCompletedAt: new Date().toISOString() };
      patch('/settings/preferences', { tourCompleted: true }).catch(() => { /* it offers itself again next time */ });
    },
  });
}

// --- auth ---------------------------------------------------------------------

function showLogin() {
  state.user = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  closeDrawer();
}

async function showApp(user) {
  state.user = user;
  $('#login').hidden = true;
  $('#app').hidden = false;
  await refreshBadges();
  await render();
  if (state.prefs && !state.prefs.tourCompletedAt) runTour();
}

async function logout() {
  try { await post('/auth/logout'); } catch { /* signing out locally regardless */ }
  showLogin();
}

// --- wiring ---------------------------------------------------------------------

setUnauthorizedHandler(showLogin);

$('#side-upload').innerHTML = `${icon('upload')}Upload statement`;
$('#top-upload').innerHTML = icon('upload');
$('#side-tools').innerHTML = `
  <a class="side-link" href="#/settings" id="side-settings">${icon('settings')}<span>Settings</span></a>
  <button class="side-link" type="button" data-action="tour" data-tour="help">${icon('help')}<span>Take the tour</span></button>
  <button class="side-link" type="button" data-action="logout">${icon('logout')}<span>Sign out</span></button>`;
updateThemeButton();

window.addEventListener('bf-themechange', onThemeChange);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeChoice() !== 'system') return;
  if (window.bfApplyTheme) window.bfApplyTheme('system');
  onThemeChange();
});

document.addEventListener('click', (e) => {
  const step = e.target.closest('[data-month-step]');
  if (step) {
    if (!step.disabled) {
      state.month = shiftMonth(state.month, Number(step.dataset.monthStep));
      render();
    }
    return;
  }
  const themeOption = e.target.closest('[data-seg="theme"]');
  if (themeOption) { markSegment(themeOption); setTheme(themeOption.dataset.value); return; }
  if (e.target.closest('[data-action="theme"]')) { setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark'); return; }
  if (e.target.closest('[data-action="tour"]')) { runTour(); return; }
  if (e.target.closest('[data-action="upload"]')) { $('#file-input').click(); return; }
  if (e.target.closest('[data-action="logout"]')) { logout(); return; }
  if (e.target.closest('[data-action="more"]')) { openMore(); return; }
  // The page may already be the one picked, so no hashchange closes the sheet.
  if (e.target.closest('.more-tile')) closeDrawer();
  const nav = e.target.closest('[data-nav]');
  if (nav) { e.preventDefault(); closeDrawer(); navigate(nav.dataset.nav); }
});

$('#page-actions').addEventListener('click', (e) => { if (headerHandler) headerHandler(e); });

$('#file-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  uploadFile(file);
});

// Drag a statement anywhere onto the window (desktop).
let dragDepth = 0;
const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!state.user || !hasFiles(e)) return;
  dragDepth += 1;
  $('#dropzone').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('#dropzone').hidden = true;
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  if (state.user) uploadFile(e.dataTransfer.files[0]);
});

window.addEventListener('hashchange', () => { if (state.user) render(); });

// Pull down to refresh, swipe sideways between pages (touch screens).
gestures = initGestures({
  enabled: () => !!state.user && !document.body.classList.contains('no-scroll') && $('#modal-layer').hidden,
  async onRefresh() {
    state.groups = null;
    await refreshBadges();
    await render();
  },
  neighbour(dir) {
    const i = SWIPE_ORDER.indexOf(currentPath);
    const next = i === -1 ? null : SWIPE_ORDER[i + dir];
    return next ? `#/${next}` : null;
  },
  navigate,
});
window.addEventListener('scroll', () => {
  $('.topbar').classList.toggle('scrolled', window.scrollY > 4);
}, { passive: true });

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = $('#login-error');
  const button = e.target.querySelector('button[type="submit"]');
  error.hidden = true;
  button.disabled = true;
  try {
    const { user } = await post('/auth/login', Object.fromEntries(new FormData(e.target)));
    e.target.reset();
    await showApp(user);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

(async function boot() {
  try {
    const { user } = await get('/auth/me');
    await showApp(user);
  } catch {
    showLogin();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is optional */ });
  }
  window.budgetFriendly = { toast };
}());
