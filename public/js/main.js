// App shell: auth, routing, navigation and the upload flow. Each screen lives
// in views/ and renders into a fresh element; the previous screen stays on
// display, dimmed, until the new one is ready, so nothing flashes.

import { api, get, post, setUnauthorizedHandler } from './api.js';
import { $, icon, toast, openDrawer, closeDrawer, openModal } from './ui.js';
import { esc, currentMonthKey, shiftMonth, longDate, plural } from './format.js';

const ROUTES = {
  dashboard: { title: 'Dashboard', icon: 'dashboard', load: () => import('./views/dashboard.js') },
  accounts: { title: 'Accounts', icon: 'accounts', load: () => import('./views/accounts.js') },
  transactions: { title: 'Transactions', icon: 'transactions', load: () => import('./views/transactions.js'), badge: true },
  cashflow: { title: 'Cash Flow', icon: 'cashflow', load: () => import('./views/cashflow.js') },
  budget: { title: 'Budget', icon: 'budget', load: () => import('./views/budget.js') },
  recurring: { title: 'Recurring', icon: 'recurring', load: () => import('./views/recurring.js') },
  goals: { title: 'Goals', icon: 'goals', load: () => import('./views/goals.js') },
  settings: { title: 'Settings', icon: 'settings', load: () => import('./views/settings.js') },
};
const SIDEBAR = ['dashboard', 'accounts', 'transactions', 'cashflow', 'budget', 'recurring', 'goals'];
const TABS = ['dashboard', 'transactions', 'budget', 'recurring'];

const state = { user: null, month: currentMonthKey(), groups: null, reviewCount: 0 };

let renderSeq = 0;
let currentPath = null;
let cleanups = [];
let headerHandler = null;

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
  $('#side-nav').innerHTML = `
    ${SIDEBAR.map((p) => `
      <a class="side-link ${p === active ? 'active' : ''}" href="#/${p}" ${p === active ? 'aria-current="page"' : ''}>
        ${icon(ROUTES[p].icon)}<span>${ROUTES[p].title}</span>${badge(p)}
      </a>`).join('')}
    <div class="side-sep"></div>
    <a class="side-link ${active === 'settings' ? 'active' : ''}" href="#/settings">${icon('settings')}<span>Settings</span></a>
    <button class="side-link" type="button" data-action="logout" style="border:0;background:none;width:100%;text-align:left;cursor:pointer">${icon('logout')}<span>Sign out</span></button>`;

  const inTabs = TABS.includes(active);
  $('#tabbar').innerHTML = `
    ${TABS.map((p) => `
      <a class="tab ${p === active ? 'active' : ''}" href="#/${p}" ${p === active ? 'aria-current="page"' : ''}>
        ${icon(ROUTES[p].icon)}<span>${ROUTES[p].title}</span>${badge(p)}
      </a>`).join('')}
    <button class="tab ${inTabs ? '' : 'active'}" type="button" data-action="more">${icon('more')}<span>More</span></button>`;
}

async function refreshBadges() {
  try {
    const s = await get('/settings');
    state.reviewCount = s.counts.needs_review;
    renderNav(currentPath);
  } catch { /* badges are cosmetic */ }
}

async function render() {
  const seq = ++renderSeq;
  const { path, params } = parseHash();
  const route = ROUTES[path];
  const samePage = path === currentPath;
  currentPath = path;

  closeDrawer();
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
    rerender: render,
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
    if (after) after();
  } catch (err) {
    if (seq !== renderSeq || err.status === 401) return;
    console.error(err);
    content.innerHTML = `
      <div class="view"><section class="card"><div class="empty">
        <div class="empty-title">This page didn't load</div><div>${esc(err.message)}</div>
        <button class="btn" type="button" data-retry>Try again</button>
      </div></section></div>`;
    content.querySelector('[data-retry]').addEventListener('click', render);
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
  const link = (path, label, ic) => `
    <a class="row" href="#/${path}" style="padding-left:0;padding-right:0">
      <span class="emoji-tile">${icon(ic)}</span><div class="row-main"><div class="row-title">${label}</div></div>${icon('right')}
    </a>`;
  openDrawer({
    title: 'More',
    body: `
      <div class="rows">
        ${link('accounts', 'Accounts', 'accounts')}
        ${link('cashflow', 'Cash Flow', 'cashflow')}
        ${link('goals', 'Goals', 'goals')}
        ${link('settings', 'Settings', 'settings')}
      </div>
      <button class="btn btn-primary btn-block" type="button" data-action="upload" style="margin-top:16px">${icon('upload')}Upload statement</button>
      <button class="btn btn-quiet btn-block" type="button" data-action="logout" style="margin-top:8px">${icon('logout')}Sign out</button>`,
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
}

async function logout() {
  try { await post('/auth/logout'); } catch { /* signing out locally regardless */ }
  showLogin();
}

// --- wiring ---------------------------------------------------------------------

setUnauthorizedHandler(showLogin);

$('#side-upload').innerHTML = `${icon('upload')}Upload statement`;
$('#top-upload').innerHTML = icon('upload');

document.addEventListener('click', (e) => {
  const step = e.target.closest('[data-month-step]');
  if (step) {
    if (!step.disabled) {
      state.month = shiftMonth(state.month, Number(step.dataset.monthStep));
      render();
    }
    return;
  }
  if (e.target.closest('[data-action="upload"]')) { $('#file-input').click(); return; }
  if (e.target.closest('[data-action="logout"]')) { logout(); return; }
  if (e.target.closest('[data-action="more"]')) { openMore(); return; }
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
