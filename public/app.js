/* BudgetFriendly frontend — no framework, no build step, no external requests.
   Hash routing keeps it working offline from the service-worker cache. */

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function api(path, { method = 'GET', body, raw } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(`/api${path}`, opts);
  if (res.status === 401) {
    state.user = null;
    showLogin();
    throw new Error('Not signed in.');
  }
  const data = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : null;
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return raw ? res : data;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const money = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 2,
});
const moneyCompact = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 0,
});

const fmt = {
  money: (n) => money.format(Number(n || 0)),
  moneyShort: (n) => moneyCompact.format(Number(n || 0)),
  signed(n) {
    const v = Number(n || 0);
    return `${v > 0 ? '+' : v < 0 ? '−' : ''}${money.format(Math.abs(v))}`;
  },
  percent: (n) => (n == null ? '—' : `${Math.round(Number(n))}%`),
  date(iso) {
    if (!iso) return '—';
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },
  dateLong(iso) {
    if (!iso) return '—';
    const d = new Date(`${String(iso).slice(0, 10)}T12:00:00`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  },
  month(key) {
    if (!key) return '';
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1))
      .toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  },
  monthShort(key) {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1))
      .toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  },
  cadence: (c) => ({
    weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month',
    monthly: 'Monthly', bimonthly: 'Every 2 months', quarterly: 'Quarterly',
    semiannual: 'Twice a year', annual: 'Yearly',
  }[c] || c),
  relative(iso) {
    if (!iso) return 'never';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  user: null,
  month: currentMonthKey(),
  categories: [],
  connections: [],
  badges: {},
};

const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const login = $('#login');
const content = $('#content');

// ---------------------------------------------------------------------------
// Toasts + sheet
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3600);
}

function openSheet(title, html) {
  const sheet = $('#sheet');
  $('#sheet-body').innerHTML = `
    <div class="sheet-head">
      <h2>${esc(title)}</h2>
      <button class="btn btn-ghost btn-sm" data-close-sheet>Close</button>
    </div>
    ${html}`;
  if (!sheet.open) sheet.showModal();
  return sheet;
}

function closeSheet() {
  const sheet = $('#sheet');
  if (sheet.open) sheet.close();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-close-sheet]')) closeSheet();
});
$('#sheet').addEventListener('click', (e) => {
  // Click on the backdrop area (the dialog itself, not its content) closes.
  if (e.target === $('#sheet')) closeSheet();
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V21H3z"/>',
  list: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  budget: '<path d="M3 20V9m6 11V4m6 16v-7m6 7V11"/>',
  repeat: '<path d="M4 11a7 7 0 0 1 12-4.9M20 13a7 7 0 0 1-12 4.9M16 3v4h4M8 21v-4H4"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M19 5l-2 2M7 17l-2 2"/>',
};

const ROUTES = [
  { path: 'dashboard',     label: 'Home',    icon: 'home',   title: 'Dashboard' },
  { path: 'budget',        label: 'Budget',  icon: 'budget', title: 'Monthly budget' },
  { path: 'transactions',  label: 'Activity', icon: 'list',  title: 'Transactions' },
  { path: 'subscriptions', label: 'Subs',    icon: 'repeat', title: 'Subscriptions', badge: 'subs' },
  { path: 'goals',         label: 'Goals',   icon: 'target', title: 'Goals' },
  { path: 'settings',      label: 'Settings', icon: 'gear',  title: 'Settings', desktopOnly: false },
];

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

function renderNav() {
  const active = currentRoute().path;

  $('#desktop-nav').innerHTML = ROUTES.map((r) => `
    <a href="#/${r.path}" class="${r.path === active ? 'active' : ''}">
      ${icon(r.icon)}<span>${esc(r.label === 'Home' ? 'Dashboard' : r.label === 'Subs' ? 'Subscriptions' : r.label === 'Activity' ? 'Transactions' : r.label)}</span>
      ${badgeHTML(r)}
    </a>`).join('');

  // The bottom bar holds five tabs; Settings lives in the top bar on mobile.
  $('#mobile-nav').innerHTML = ROUTES.filter((r) => r.path !== 'settings').map((r) => `
    <a href="#/${r.path}" class="${r.path === active ? 'active' : ''}">
      ${icon(r.icon)}${badgeHTML(r)}<span>${esc(r.label)}</span>
    </a>`).join('');
}

function badgeHTML(route) {
  const n = route.badge ? state.badges[route.badge] : 0;
  return n ? `<span class="tab-badge">${n > 99 ? '99+' : n}</span>` : '';
}

function currentRoute() {
  const path = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'dashboard';
  return ROUTES.find((r) => r.path === path) || ROUTES[0];
}

// ---------------------------------------------------------------------------
// Shared render helpers
// ---------------------------------------------------------------------------

function loading() {
  content.innerHTML = `
    <div class="card"><div class="skeleton" style="height:2.2rem;width:60%"></div></div>
    <div class="card">
      ${'<div class="skeleton" style="margin:.55rem 0"></div>'.repeat(5)}
    </div>`;
}

function empty(title, body, action = '') {
  return `<div class="empty"><strong>${esc(title)}</strong>${esc(body)}${action ? `<div style="margin-top:1rem">${action}</div>` : ''}</div>`;
}

function monthNav(onChangeAttr) {
  return `
    <div class="month-nav">
      <button class="btn btn-ghost btn-sm" ${onChangeAttr}="-1" aria-label="Previous month">‹</button>
      <span class="label">${esc(fmt.month(state.month))}</span>
      <button class="btn btn-ghost btn-sm" ${onChangeAttr}="1" aria-label="Next month"
        ${state.month >= currentMonthKey() ? 'disabled' : ''}>›</button>
    </div>`;
}

function progressBar(fraction, color, thin = false) {
  const pct = Math.max(0, Math.min(100, (fraction || 0) * 100));
  return `<div class="bar ${thin ? 'thin' : ''}"><span style="width:${pct}%;background:${color}"></span></div>`;
}

function categoryOptions(selectedId, { includeBlank = true, kind } = {}) {
  const list = kind ? state.categories.filter((c) => c.kind === kind) : state.categories;
  return (includeBlank ? '<option value="">— none —</option>' : '') +
    list.map((c) => `<option value="${c.id}" ${String(c.id) === String(selectedId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
}

// ---------------------------------------------------------------------------
// View: Dashboard
// ---------------------------------------------------------------------------

async function viewDashboard() {
  loading();
  const d = await api(`/budget/dashboard?month=${state.month}`);
  state.badges.subs = d.subscriptions.pendingReview;
  renderNav();

  const s = d.summary;
  const income = s.income.estimatedMonthly;
  const spent = s.spending.total;
  const left = s.spending.leftToSpend;

  const topCategories = s.categories
    .filter((c) => c.kind === 'spending' && c.spent > 0)
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 6);

  const maxSpend = Math.max(...d.trend.map((t) => Math.max(t.spent, t.received)), 1);

  content.innerHTML = `
    ${d.accounts.length === 0 ? onboardingCard() : ''}

    <section class="card hero">
      <div class="card-head">
        <h2>${esc(fmt.month(state.month))}</h2>
        ${monthNav('data-month-delta')}
      </div>

      <div>
        <div class="stat-label">Left to spend</div>
        <div class="hero-figure">
          <span class="big ${left < 0 ? 'negative' : ''}">${esc(fmt.money(left))}</span>
          <span class="muted">of ${esc(fmt.money(income))} income</span>
        </div>
        ${progressBar(income > 0 ? spent / income : 0, spent > income ? 'var(--negative)' : 'var(--accent)')}
        <div class="stat-sub" style="margin-top:.4rem">
          ${esc(fmt.money(spent))} spent · ${fmt.percent(s.progress * 100)} through the month
          ${s.spending.projected != null
            ? ` · on pace for <strong class="${s.spending.projectedOverBudget ? 'warning' : ''}">${esc(fmt.money(s.spending.projected))}</strong>`
            : ''}
        </div>
      </div>

      <div class="grid grid-3">
        <div class="stat">
          <span class="stat-label">Income</span>
          <span class="stat-value sm positive">${esc(fmt.money(income))}</span>
          <span class="stat-sub">${s.income.isOverridden ? 'set by hand' : `detected${s.income.sources.length ? ` from ${s.income.sources.length}` : ''}`}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Subscriptions</span>
          <span class="stat-value sm">${esc(fmt.money(d.subscriptions.monthlyTotal))}</span>
          <span class="stat-sub">${d.subscriptions.pendingReview ? `${d.subscriptions.pendingReview} to review` : 'per month'}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Saved</span>
          <span class="stat-value sm ${(income - spent) < 0 ? 'negative' : 'positive'}">
            ${s.spending.savingsRate == null ? '—' : fmt.percent(s.spending.savingsRate)}
          </span>
          <span class="stat-sub">${esc(fmt.money(income - spent))} this month</span>
        </div>
      </div>
    </section>

    ${d.uncategorisedCount > 0 ? `
      <section class="card">
        <div class="row" style="padding:0">
          <div class="row-main">
            <div class="row-title">${d.uncategorisedCount} uncategorised transaction${d.uncategorisedCount === 1 ? '' : 's'}</div>
            <div class="row-sub">Sorting these makes every number below sharper.</div>
          </div>
          <a class="btn btn-sm" href="#/transactions?uncategorised=1">Review</a>
        </div>
      </section>` : ''}

    <div class="grid grid-2">
      <section class="card">
        <div class="card-head">
          <h2>Where it went</h2>
          <a class="link" href="#/budget">Budget →</a>
        </div>
        ${topCategories.length ? `<div class="rows">${topCategories.map((c) => `
          <div class="row">
            <span class="dot" style="background:${esc(c.color)}"></span>
            <div class="row-main">
              <div class="row-title">${esc(c.name)}</div>
              ${c.budget != null
                ? `<div class="row-sub">${esc(fmt.money(c.spent))} of ${esc(fmt.money(c.budget))}</div>
                   ${progressBar(c.spent / c.budget, c.overBudget ? 'var(--negative)' : c.color, true)}`
                : `<div class="row-sub">${c.transactionCount} transaction${c.transactionCount === 1 ? '' : 's'} · no budget set</div>`}
            </div>
            <span class="row-amount">${esc(fmt.money(c.spent))}</span>
          </div>`).join('')}</div>`
          : empty('Nothing spent yet', 'Transactions will group here once they land.')}
      </section>

      <section class="card">
        <div class="card-head"><h2>Last 6 months</h2></div>
        <div class="spark">
          ${d.trend.map((t) => `
            <div class="spark-col" title="${esc(t.month)}: ${esc(fmt.money(t.spent))} out, ${esc(fmt.money(t.received))} in">
              <div class="spark-bar" style="height:${(t.received / maxSpend) * 100}%;background:var(--positive);opacity:.55"></div>
              <div class="spark-bar" style="height:${(t.spent / maxSpend) * 100}%;background:var(--accent)"></div>
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:4px">
          ${d.trend.map((t) => `<div class="spark-label" style="flex:1">${esc(fmt.monthShort(t.month))}</div>`).join('')}
        </div>
        <div class="chips" style="margin-top:.6rem">
          <span class="chip"><span class="dot" style="background:var(--accent)"></span>Spent</span>
          <span class="chip"><span class="dot" style="background:var(--positive);opacity:.55"></span>Received</span>
        </div>
      </section>
    </div>

    ${d.goals.length ? `
      <section class="card">
        <div class="card-head">
          <h2>Goals</h2>
          <a class="link" href="#/goals">All goals →</a>
        </div>
        <div class="rows">
          ${d.goals.slice(0, 4).map(goalRow).join('')}
        </div>
      </section>` : ''}

    <section class="card">
      <div class="card-head">
        <h2>Recent activity</h2>
        <a class="link" href="#/transactions">All →</a>
      </div>
      ${d.recentTransactions.length ? `<div class="rows">${d.recentTransactions.map((t) => `
        <div class="row">
          <span class="dot" style="background:${esc(t.category_color || '#9ca3af')}"></span>
          <div class="row-main">
            <div class="row-title">${esc(t.description)}</div>
            <div class="row-sub">${esc(fmt.date(t.posted_on))} · ${esc(t.category_name || 'Uncategorized')}</div>
          </div>
          <span class="row-amount ${t.amount > 0 ? 'positive' : ''}">${esc(fmt.signed(t.amount))}</span>
        </div>`).join('')}</div>`
        : empty('No transactions yet', 'Connect an account or upload a statement to get started.')}
    </section>

    <p class="muted" style="text-align:center">
      Last sync: ${d.lastSync
        ? `${esc(fmt.relative(d.lastSync.started_at))} · ${esc(d.lastSync.status)}${d.lastSync.imported ? ` · ${d.lastSync.imported} new` : ''}`
        : 'never'}
    </p>`;
}

function onboardingCard() {
  return `
    <section class="card">
      <div class="card-head"><h2>Get your transactions in</h2></div>
      <p class="muted">Two ways, both without handing your login to a third party:</p>
      <div class="rows">
        <div class="row">
          <div class="row-main">
            <div class="row-title">Upload a statement</div>
            <div class="row-sub">Export CSV or QFX from Golden 1 online banking. Works today, nothing stored.</div>
          </div>
        </div>
        <div class="row">
          <div class="row-main">
            <div class="row-title">Direct Connect (OFX)</div>
            <div class="row-sub">Store your credentials once, then "Sync now" pulls straight from the bank.</div>
          </div>
        </div>
      </div>
      <a class="btn btn-primary btn-block" href="#/settings" style="margin-top:.5rem">Set up a connection</a>
    </section>`;
}

function goalRow(g) {
  const color = g.kind === 'limit'
    ? (g.onPace === false ? 'var(--negative)' : 'var(--warning)')
    : 'var(--positive)';
  return `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(g.name)}
          ${g.status === 'achieved' ? '<span class="chip good">done</span>' : ''}
          ${g.onPace === false && g.status !== 'achieved' ? '<span class="chip bad">behind</span>' : ''}
          ${g.onPace === true && g.status !== 'achieved' ? '<span class="chip good">on pace</span>' : ''}
        </div>
        <div class="row-sub">
          ${esc(fmt.money(g.current))} of ${esc(fmt.money(g.target_amount))}
          ${g.target_date ? ` · by ${esc(fmt.dateLong(g.target_date))}` : ''}
          ${g.requiredMonthly ? ` · ${esc(fmt.money(g.requiredMonthly))}/mo needed` : ''}
        </div>
        ${progressBar(g.percent / 100, color, true)}
      </div>
      <span class="row-amount">${fmt.percent(g.percent)}</span>
    </div>`;
}

// ---------------------------------------------------------------------------
// View: Budget
// ---------------------------------------------------------------------------

async function viewBudget() {
  loading();
  const { summary: s } = await api(`/budget/summary?month=${state.month}`);

  const spending = s.categories.filter((c) => c.kind === 'spending');
  const incomeCats = s.categories.filter((c) => c.kind === 'income');

  content.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>${esc(fmt.month(state.month))}</h2>
        ${monthNav('data-month-delta')}
      </div>
      <div class="grid grid-3">
        <div class="stat">
          <span class="stat-label">Income</span>
          <span class="stat-value sm positive">${esc(fmt.money(s.income.estimatedMonthly))}</span>
          <span class="stat-sub">${esc(fmt.money(s.income.actualThisMonth))} received so far</span>
        </div>
        <div class="stat">
          <span class="stat-label">Budgeted</span>
          <span class="stat-value sm">${esc(fmt.money(s.spending.budgeted))}</span>
          <span class="stat-sub">across ${spending.filter((c) => c.budget != null).length} categories</span>
        </div>
        <div class="stat">
          <span class="stat-label">Left to allocate</span>
          <span class="stat-value sm ${s.spending.leftToAllocate < 0 ? 'negative' : 'positive'}">
            ${esc(fmt.money(s.spending.leftToAllocate))}
          </span>
          <span class="stat-sub">${s.spending.leftToAllocate < 0 ? 'over-committed' : 'unassigned'}</span>
        </div>
      </div>
      <div class="btn-row" style="margin-top:1rem">
        <button class="btn btn-sm" data-edit-income>Adjust income</button>
        <button class="btn btn-sm" data-new-category>New category</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Spending by category</h2>
        <span class="muted">${esc(fmt.money(s.spending.total))} total</span>
      </div>
      <div class="rows">
        ${spending.map((c) => `
          <div class="row">
            <span class="dot" style="background:${esc(c.color)}"></span>
            <div class="row-main">
              <div class="row-title">
                ${esc(c.name)}
                ${c.overBudget ? '<span class="chip bad">over</span>'
                  : c.overPace ? '<span class="chip warn">fast</span>' : ''}
              </div>
              <div class="row-sub">
                ${c.budget != null
                  ? `${esc(fmt.money(c.spent))} of ${esc(fmt.money(c.budget))} · ${esc(fmt.money(Math.abs(c.remaining)))} ${c.remaining < 0 ? 'over' : 'left'}`
                  : `${esc(fmt.money(c.spent))} spent · no budget`}
              </div>
              ${c.budget != null ? progressBar(c.spent / c.budget, c.overBudget ? 'var(--negative)' : c.color, true) : ''}
            </div>
            <div class="row-actions">
              <button class="btn btn-sm" data-edit-category="${c.id}">
                ${c.budget != null ? esc(fmt.moneyShort(c.budget)) : 'Set'}
              </button>
            </div>
          </div>`).join('')}
      </div>
    </section>

    ${incomeCats.some((c) => c.received > 0) ? `
      <section class="card">
        <div class="card-head"><h2>Money in</h2></div>
        <div class="rows">
          ${incomeCats.filter((c) => c.received > 0).map((c) => `
            <div class="row">
              <span class="dot" style="background:${esc(c.color)}"></span>
              <div class="row-main"><div class="row-title">${esc(c.name)}</div></div>
              <span class="row-amount positive">${esc(fmt.money(c.received))}</span>
            </div>`).join('')}
        </div>
      </section>` : ''}

    ${s.unbudgetedCategories.length ? `
      <section class="card">
        <div class="card-head"><h2>Unbudgeted spending</h2></div>
        <p class="muted">These categories have activity but no monthly budget.</p>
        <div class="chips">
          ${s.unbudgetedCategories.map((c) => `
            <button class="chip chip-btn" data-edit-category="${c.id}">
              ${esc(c.name)} · ${esc(fmt.moneyShort(c.spent))}
            </button>`).join('')}
        </div>
      </section>` : ''}`;
}

async function editCategorySheet(categoryId) {
  const cat = state.categories.find((c) => String(c.id) === String(categoryId));
  if (!cat) return;

  openSheet(cat.name, `
    <form id="category-form">
      <label class="field">
        <span>Monthly budget</span>
        <input type="number" name="monthlyBudget" step="0.01" min="0" inputmode="decimal"
               value="${cat.monthly_budget ?? ''}" placeholder="No budget">
      </label>
      <div class="field-row">
        <label class="field">
          <span>Name</span>
          <input type="text" name="name" value="${esc(cat.name)}" ${cat.is_system ? 'readonly' : ''} required>
        </label>
        <label class="field">
          <span>Colour</span>
          <input type="color" name="color" value="${esc(cat.color)}">
        </label>
      </div>
      <label class="field">
        <span>Type</span>
        <select name="kind" ${cat.is_system ? 'disabled' : ''}>
          ${['spending', 'income', 'transfer'].map((k) =>
            `<option value="${k}" ${k === cat.kind ? 'selected' : ''}>${k}</option>`).join('')}
        </select>
      </label>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Save</button>
        ${!cat.is_system ? `<button class="btn btn-danger" type="button" data-delete-category="${cat.id}">Delete</button>` : ''}
      </div>
    </form>`);

  $('#category-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/categories/${cat.id}`, {
        method: 'PATCH',
        body: {
          name: f.get('name'),
          color: f.get('color'),
          kind: cat.is_system ? undefined : f.get('kind'),
          monthlyBudget: f.get('monthlyBudget') === '' ? null : f.get('monthlyBudget'),
        },
      });
      closeSheet();
      toast('Category saved', 'good');
      await loadCategories();
      render();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

async function newCategorySheet() {
  openSheet('New category', `
    <form id="new-category-form">
      <label class="field">
        <span>Name</span>
        <input type="text" name="name" required placeholder="e.g. Pet care">
      </label>
      <div class="field-row">
        <label class="field">
          <span>Monthly budget</span>
          <input type="number" name="monthlyBudget" step="0.01" min="0" inputmode="decimal" placeholder="Optional">
        </label>
        <label class="field">
          <span>Colour</span>
          <input type="color" name="color" value="#2563eb">
        </label>
      </div>
      <label class="field">
        <span>Type</span>
        <select name="kind">
          <option value="spending">spending</option>
          <option value="income">income</option>
          <option value="transfer">transfer</option>
        </select>
      </label>
      <button class="btn btn-primary btn-block" type="submit">Create</button>
    </form>`);

  $('#new-category-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api('/categories', { method: 'POST', body: f });
      closeSheet();
      toast('Category created', 'good');
      await loadCategories();
      render();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

async function editIncomeSheet() {
  const { income } = await api('/income');
  openSheet('Monthly income', `
    <p class="muted">
      Detected ${esc(fmt.money(income.detected))} a month from
      ${income.sources.length} recurring deposit${income.sources.length === 1 ? '' : 's'}.
      Override it if that is wrong.
    </p>
    ${income.sources.length ? `<div class="rows" style="margin-bottom:1rem">
      ${income.sources.map((s) => `
        <div class="row">
          <div class="row-main">
            <div class="row-title">${esc(s.name)}</div>
            <div class="row-sub">${esc(fmt.money(s.amount))} · ${esc(fmt.cadence(s.cadence))}
              · next ${esc(fmt.date(s.next_expected_on))}</div>
          </div>
          <span class="row-amount">${esc(fmt.money(s.monthly_amount))}</span>
        </div>`).join('')}
    </div>` : ''}
    <form id="income-form">
      <label class="field">
        <span>Monthly income override</span>
        <input type="number" name="amount" step="0.01" min="0" inputmode="decimal"
               value="${income.manual ?? ''}" placeholder="${income.detected}">
      </label>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">Save override</button>
        <button class="btn" type="button" data-clear-override>Use detected</button>
      </div>
    </form>`);

  const save = async (amount) => {
    try {
      await api('/income/override', { method: 'PUT', body: { amount } });
      closeSheet();
      toast('Income updated', 'good');
      render();
    } catch (err) { toast(err.message, 'bad'); }
  };

  $('#income-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = new FormData(e.target).get('amount');
    save(v === '' ? null : v);
  });
  $('[data-clear-override]').addEventListener('click', () => save(null));
}

// ---------------------------------------------------------------------------
// View: Transactions
// ---------------------------------------------------------------------------

const txFilters = { search: '', categoryId: '', direction: '', uncategorised: false, offset: 0 };

async function viewTransactions() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('uncategorised')) txFilters.uncategorised = true;

  loading();
  const query = new URLSearchParams({
    month: state.month,
    limit: '100',
    offset: String(txFilters.offset),
  });
  if (txFilters.search) query.set('search', txFilters.search);
  if (txFilters.categoryId) query.set('categoryId', txFilters.categoryId);
  if (txFilters.direction) query.set('direction', txFilters.direction);
  if (txFilters.uncategorised) query.set('uncategorised', 'true');

  const { transactions, totals } = await api(`/transactions?${query}`);

  content.innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>${esc(fmt.month(state.month))}</h2>
        ${monthNav('data-month-delta')}
      </div>
      <label class="field" style="margin-bottom:.6rem">
        <input type="search" id="tx-search" placeholder="Search description or merchant"
               value="${esc(txFilters.search)}" enterkeyhint="search">
      </label>
      <div class="chips">
        <button class="chip chip-btn ${!txFilters.direction && !txFilters.uncategorised ? 'active' : ''}" data-tx-filter="all">All</button>
        <button class="chip chip-btn ${txFilters.direction === 'out' ? 'active' : ''}" data-tx-filter="out">Spending</button>
        <button class="chip chip-btn ${txFilters.direction === 'in' ? 'active' : ''}" data-tx-filter="in">Income</button>
        <button class="chip chip-btn ${txFilters.uncategorised ? 'active' : ''}" data-tx-filter="uncat">Needs a category</button>
      </div>
      <div class="grid grid-3" style="margin-top:1rem">
        <div class="stat"><span class="stat-label">Shown</span><span class="stat-value sm">${totals.count}</span></div>
        <div class="stat"><span class="stat-label">Out</span><span class="stat-value sm negative">${esc(fmt.money(totals.spent))}</span></div>
        <div class="stat"><span class="stat-label">In</span><span class="stat-value sm positive">${esc(fmt.money(totals.received))}</span></div>
      </div>
    </section>

    <section class="card">
      ${transactions.length ? `<div class="rows">${transactions.map((t) => `
        <div class="row" data-tx="${t.id}" role="button" tabindex="0">
          <span class="dot" style="background:${esc(t.category_color || '#9ca3af')}"></span>
          <div class="row-main">
            <div class="row-title">${esc(t.description)}${t.excluded ? ' <span class="chip">excluded</span>' : ''}</div>
            <div class="row-sub">
              ${esc(fmt.date(t.posted_on))} · ${esc(t.category_name || 'Uncategorized')}
              ${t.category_locked ? ' ·&nbsp;set by you' : ''}
            </div>
          </div>
          <span class="row-amount ${t.amount > 0 ? 'positive' : ''}">${esc(fmt.signed(t.amount))}</span>
        </div>`).join('')}</div>`
        : empty('Nothing here', 'Try another month or clear the filters.')}
    </section>

    ${transactions.length === 100 ? `
      <button class="btn btn-block" data-tx-more>Load more</button>` : ''}`;

  const search = $('#tx-search');
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      txFilters.search = search.value.trim();
      txFilters.offset = 0;
      viewTransactions();
    }, 300);
  });
}

async function transactionSheet(id) {
  const { transactions } = await api(`/transactions?limit=500&month=${state.month}`);
  const t = transactions.find((x) => String(x.id) === String(id));
  if (!t) return;

  openSheet(t.description, `
    <div class="grid" style="margin-bottom:1rem">
      <div class="stat">
        <span class="stat-label">${t.amount > 0 ? 'Received' : 'Spent'}</span>
        <span class="stat-value ${t.amount > 0 ? 'positive' : ''}">${esc(fmt.signed(t.amount))}</span>
        <span class="stat-sub">${esc(fmt.dateLong(t.posted_on))} · ${esc(t.account_name)}</span>
      </div>
    </div>
    <form id="tx-form">
      <label class="field">
        <span>Category</span>
        <select name="categoryId">${categoryOptions(t.category_id, { includeBlank: false })}</select>
      </label>
      <label class="field" style="display:flex;align-items:center;gap:.5rem">
        <input type="checkbox" name="excluded" ${t.excluded ? 'checked' : ''} style="width:auto">
        <span style="margin:0">Exclude from budget calculations</span>
      </label>
      <p class="muted">Merchant key: <code>${esc(t.merchant_key)}</code> — changing the category
      teaches every future charge from this merchant.</p>
      <button class="btn btn-primary btn-block" type="submit">Save</button>
    </form>`);

  $('#tx-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api(`/transactions/${t.id}`, {
        method: 'PATCH',
        body: { categoryId: Number(f.get('categoryId')) },
      });
      if (Boolean(f.get('excluded')) !== t.excluded) {
        await api(`/transactions/${t.id}`, {
          method: 'PATCH',
          body: { excluded: Boolean(f.get('excluded')) },
        });
      }
      closeSheet();
      toast('Transaction updated', 'good');
      viewTransactions();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

// ---------------------------------------------------------------------------
// View: Subscriptions
// ---------------------------------------------------------------------------

async function viewSubscriptions() {
  loading();
  const { subscriptions, totals } = await api('/subscriptions');
  state.badges.subs = subscriptions.filter((s) => s.status === 'detected').length;
  renderNav();

  const groups = {
    detected: subscriptions.filter((s) => s.status === 'detected'),
    confirmed: subscriptions.filter((s) => s.status === 'confirmed'),
    cancelled: subscriptions.filter((s) => s.status === 'cancelled'),
    dismissed: subscriptions.filter((s) => s.status === 'dismissed'),
  };

  const card = (s) => `
    <div class="row">
      <div class="row-main">
        <div class="row-title">
          ${esc(s.name)}
          ${s.confidence < 0.6 ? '<span class="chip warn">unsure</span>' : ''}
        </div>
        <div class="row-sub">
          ${esc(fmt.money(s.amount))} · ${esc(fmt.cadence(s.cadence))}
          · ${s.occurrences} charge${s.occurrences === 1 ? '' : 's'}
          ${s.next_expected_on ? ` · next ${esc(fmt.date(s.next_expected_on))}` : ''}
        </div>
      </div>
      <span class="row-amount">${esc(fmt.money(s.monthly_amount))}<span class="muted">/mo</span></span>
      <div class="row-actions">
        ${s.status === 'detected' ? `
          <button class="btn btn-sm btn-primary" data-sub-status="${s.id}" data-status="confirmed">Keep</button>
          <button class="btn btn-sm" data-sub-status="${s.id}" data-status="dismissed">Not one</button>`
        : `<button class="btn btn-sm" data-sub-detail="${s.id}">Details</button>`}
      </div>
    </div>`;

  content.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Recurring charges</h2></div>
      <div class="grid grid-3">
        <div class="stat">
          <span class="stat-label">Per month</span>
          <span class="stat-value sm">${esc(fmt.money(totals.monthly))}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Per year</span>
          <span class="stat-value sm">${esc(fmt.money(totals.annual))}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Tracked</span>
          <span class="stat-value sm">${totals.count}</span>
        </div>
      </div>
      <button class="btn btn-sm btn-block" data-redetect style="margin-top:1rem">Re-scan transactions</button>
    </section>

    ${groups.detected.length ? `
      <section class="card">
        <div class="card-head">
          <h2>Needs your call</h2>
          <span class="muted">${groups.detected.length}</span>
        </div>
        <p class="muted">These look recurring. Confirm the real ones so they count toward your budget.</p>
        <div class="rows">${groups.detected.map(card).join('')}</div>
      </section>` : ''}

    <section class="card">
      <div class="card-head"><h2>Confirmed</h2></div>
      ${groups.confirmed.length
        ? `<div class="rows">${groups.confirmed.map(card).join('')}</div>`
        : empty('None confirmed yet', 'Confirm a detected charge and it will show up here.')}
    </section>

    ${groups.cancelled.length ? `
      <section class="card">
        <div class="card-head"><h2>Looks cancelled</h2></div>
        <p class="muted">No charge has landed in a while.</p>
        <div class="rows">${groups.cancelled.map(card).join('')}</div>
      </section>` : ''}

    ${groups.dismissed.length ? `
      <section class="card">
        <div class="card-head"><h2>Dismissed</h2></div>
        <div class="rows">${groups.dismissed.map(card).join('')}</div>
      </section>` : ''}`;
}

async function subscriptionDetail(id) {
  const [{ subscriptions }, { transactions }] = await Promise.all([
    api('/subscriptions'),
    api(`/subscriptions/${id}/transactions`),
  ]);
  const s = subscriptions.find((x) => String(x.id) === String(id));
  if (!s) return;

  openSheet(s.name, `
    <div class="grid grid-3" style="margin-bottom:1rem">
      <div class="stat">
        <span class="stat-label">Each time</span>
        <span class="stat-value sm">${esc(fmt.money(s.amount))}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Cadence</span>
        <span class="stat-value sm" style="font-size:.95rem">${esc(fmt.cadence(s.cadence))}</span>
      </div>
      <div class="stat">
        <span class="stat-label">Per year</span>
        <span class="stat-value sm">${esc(fmt.money(s.monthly_amount * 12))}</span>
      </div>
    </div>
    <div class="btn-row" style="margin-bottom:1rem">
      ${['confirmed', 'dismissed', 'cancelled'].map((st) => `
        <button class="btn btn-sm ${s.status === st ? 'btn-primary' : ''}"
                data-sub-status="${s.id}" data-status="${st}">${st}</button>`).join('')}
    </div>
    <h3 style="font-size:.9rem;margin-bottom:.5rem">Charge history</h3>
    <div class="rows">
      ${transactions.map((t) => `
        <div class="row">
          <div class="row-main">
            <div class="row-title">${esc(fmt.dateLong(t.posted_on))}</div>
            <div class="row-sub">${esc(t.description)}</div>
          </div>
          <span class="row-amount">${esc(fmt.money(Math.abs(t.amount)))}</span>
        </div>`).join('')}
    </div>`);
}

// ---------------------------------------------------------------------------
// View: Goals
// ---------------------------------------------------------------------------

async function viewGoals() {
  loading();
  const { goals } = await api(`/goals?month=${state.month}`);
  const active = goals.filter((g) => g.status !== 'achieved');
  const done = goals.filter((g) => g.status === 'achieved');

  const card = (g) => `
    <section class="card">
      <div class="card-head">
        <h2>${esc(g.name)}</h2>
        <span class="chip ${g.achieved ? 'good' : g.onPace === false ? 'bad' : g.onPace ? 'good' : ''}">
          ${g.achieved ? 'achieved' : g.onPace === false ? 'behind' : g.onPace ? 'on pace' : g.kind}
        </span>
      </div>
      <div class="hero-figure">
        <span class="big">${esc(fmt.money(g.current))}</span>
        <span class="muted">of ${esc(fmt.money(g.target_amount))}</span>
      </div>
      ${progressBar(g.percent / 100, g.kind === 'limit'
        ? (g.percent > 100 ? 'var(--negative)' : 'var(--warning)')
        : 'var(--positive)')}
      <div class="stat-sub" style="margin-top:.5rem">
        ${g.kind === 'limit'
          ? `Spending cap on ${esc(g.category_name || 'a category')} · ${esc(fmt.money(g.remaining))} left this month`
          : `${esc(fmt.money(g.remaining))} to go${g.target_date ? ` by ${esc(fmt.dateLong(g.target_date))}` : ''}`}
        ${g.requiredMonthly ? ` · needs ${esc(fmt.money(g.requiredMonthly))}/mo` : ''}
      </div>
      <div class="btn-row" style="margin-top:1rem">
        ${g.kind !== 'limit' ? `<button class="btn btn-sm btn-primary" data-goal-contribute="${g.id}">Add money</button>` : ''}
        <button class="btn btn-sm" data-goal-edit="${g.id}">Edit</button>
      </div>
    </section>`;

  content.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Goals</h2></div>
      <p class="muted">Savings targets track contributions you log. Spending limits watch a category's monthly total.</p>
      <button class="btn btn-primary btn-block" data-goal-new>New goal</button>
    </section>
    ${active.length ? active.map(card).join('') : empty('No goals yet', 'Create one to start tracking progress.')}
    ${done.length ? `<h2 style="font-size:1rem;margin-top:.5rem">Achieved</h2>${done.map(card).join('')}` : ''}`;
}

function goalFormSheet(goal) {
  const g = goal || {};
  openSheet(goal ? `Edit ${g.name}` : 'New goal', `
    <form id="goal-form">
      <label class="field">
        <span>Name</span>
        <input type="text" name="name" required value="${esc(g.name || '')}" placeholder="e.g. Emergency fund">
      </label>
      <label class="field">
        <span>Type</span>
        <select name="kind" id="goal-kind">
          <option value="save" ${g.kind === 'save' ? 'selected' : ''}>Save toward a target</option>
          <option value="payoff" ${g.kind === 'payoff' ? 'selected' : ''}>Pay something off</option>
          <option value="limit" ${g.kind === 'limit' ? 'selected' : ''}>Cap spending in a category</option>
        </select>
      </label>
      <div class="field-row">
        <label class="field">
          <span>Target amount</span>
          <input type="number" name="targetAmount" step="0.01" min="0.01" inputmode="decimal"
                 required value="${g.target_amount ?? ''}">
        </label>
        <label class="field">
          <span>Target date</span>
          <input type="date" name="targetDate" value="${g.target_date ? String(g.target_date).slice(0, 10) : ''}">
        </label>
      </div>
      <label class="field" id="goal-category-field" ${g.kind === 'limit' ? '' : 'hidden'}>
        <span>Category</span>
        <select name="categoryId">${categoryOptions(g.category_id, { kind: 'spending' })}</select>
      </label>
      <label class="field" ${g.kind === 'limit' ? 'hidden' : ''}>
        <span>Starting amount</span>
        <input type="number" name="startingAmount" step="0.01" min="0" inputmode="decimal"
               value="${g.starting_amount ?? 0}">
      </label>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">${goal ? 'Save' : 'Create'}</button>
        ${goal ? `<button class="btn btn-danger" type="button" data-goal-delete="${g.id}">Delete</button>` : ''}
      </div>
    </form>`);

  $('#goal-kind').addEventListener('change', (e) => {
    $('#goal-category-field').hidden = e.target.value !== 'limit';
  });

  $('#goal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    if (!body.categoryId) delete body.categoryId;
    if (!body.targetDate) body.targetDate = null;
    try {
      if (goal) await api(`/goals/${g.id}`, { method: 'PATCH', body });
      else await api('/goals', { method: 'POST', body });
      closeSheet();
      toast(goal ? 'Goal saved' : 'Goal created', 'good');
      viewGoals();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

function contributionSheet(goalId) {
  openSheet('Add to goal', `
    <form id="contribution-form">
      <label class="field">
        <span>Amount</span>
        <input type="number" name="amount" step="0.01" required inputmode="decimal" autofocus>
      </label>
      <label class="field">
        <span>Date</span>
        <input type="date" name="occurredOn" value="${new Date().toISOString().slice(0, 10)}">
      </label>
      <label class="field">
        <span>Note</span>
        <input type="text" name="note" placeholder="Optional">
      </label>
      <button class="btn btn-primary btn-block" type="submit">Add</button>
    </form>`);

  $('#contribution-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/goals/${goalId}/contributions`, {
        method: 'POST',
        body: Object.fromEntries(new FormData(e.target)),
      });
      closeSheet();
      toast('Contribution added', 'good');
      viewGoals();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

// ---------------------------------------------------------------------------
// View: Settings
// ---------------------------------------------------------------------------

async function viewSettings() {
  loading();
  const [settings, { connections }, { runs }] = await Promise.all([
    api('/settings'),
    api('/connections'),
    api('/connections/runs'),
  ]);
  state.connections = connections;

  content.innerHTML = `
    <section class="card">
      <div class="card-head"><h2>Bank connections</h2></div>
      ${connections.length ? `<div class="rows">${connections.map((c) => {
        const adapter = settings.adapters.find((a) => a.id === c.adapter);
        return `
        <div class="row">
          <div class="row-main">
            <div class="row-title">
              ${esc(c.name)}
              <span class="chip ${c.status === 'error' ? 'bad' : 'good'}">${esc(c.status)}</span>
            </div>
            <div class="row-sub">
              ${esc(adapter ? adapter.label : c.adapter)}
              · ${c.accounts.length} account${c.accounts.length === 1 ? '' : 's'}
              · synced ${esc(fmt.relative(c.last_sync_at))}
            </div>
            ${c.last_error ? `<div class="row-sub error">${esc(c.last_error)}</div>` : ''}
          </div>
          <div class="row-actions">
            ${adapter && adapter.capabilities.upload
              ? `<button class="btn btn-sm btn-primary" data-upload="${c.id}">Upload</button>` : ''}
            ${adapter && adapter.capabilities.sync
              ? `<button class="btn btn-sm btn-primary" data-sync="${c.id}">Sync</button>` : ''}
            <button class="btn btn-sm btn-danger" data-delete-connection="${c.id}">×</button>
          </div>
        </div>`;
      }).join('')}</div>` : empty('No connections yet', 'Add one below to pull your transactions in.')}
      <button class="btn btn-block" data-new-connection style="margin-top:1rem">Add a connection</button>
    </section>

    ${connections.some((c) => c.accounts.length) ? `
      <section class="card">
        <div class="card-head"><h2>Accounts</h2></div>
        <div class="rows">
          ${connections.flatMap((c) => c.accounts).map((a) => `
            <div class="row">
              <div class="row-main">
                <div class="row-title">${esc(a.name)}</div>
                <div class="row-sub">${esc(a.type || 'account')}${a.mask ? ` ····${esc(a.mask)}` : ''}</div>
              </div>
              <span class="row-amount">${a.current_balance != null ? esc(fmt.money(a.current_balance)) : '—'}</span>
            </div>`).join('')}
        </div>
      </section>` : ''}

    <section class="card">
      <div class="card-head"><h2>Categories &amp; rules</h2></div>
      <p class="muted">${settings.counts.categories} categories. Rules match merchant names to categories automatically.</p>
      <div class="btn-row">
        <button class="btn btn-sm" data-new-category>New category</button>
        <button class="btn btn-sm" data-view-rules>Manage rules</button>
        <button class="btn btn-sm" data-reanalyze>Re-categorise everything</button>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Recent syncs</h2></div>
      ${runs.length ? `<div class="rows">${runs.slice(0, 8).map((r) => `
        <div class="row">
          <div class="row-main">
            <div class="row-title">${esc(r.connection_name || r.adapter)}
              <span class="chip ${r.status === 'error' ? 'bad' : 'good'}">${esc(r.status)}</span>
            </div>
            <div class="row-sub">${esc(fmt.relative(r.started_at))} · ${esc(r.message || '')}</div>
          </div>
        </div>`).join('')}</div>` : empty('No syncs yet', '')}
    </section>

    <section class="card">
      <div class="card-head"><h2>Environment</h2></div>
      <div class="rows">
        <div class="row">
          <div class="row-main"><div class="row-title">Credential encryption</div></div>
          <span class="chip ${settings.environment.encryptionConfigured ? 'good' : 'warn'}">
            ${settings.environment.encryptionConfigured ? 'configured' : 'ENCRYPTION_KEY missing'}
          </span>
        </div>
        <div class="row">
          <div class="row-main"><div class="row-title">OFX Direct Connect</div></div>
          <span class="chip ${settings.environment.ofxConfigured ? 'good' : 'warn'}">
            ${settings.environment.ofxConfigured ? 'configured' : 'not configured'}
          </span>
        </div>
        <div class="row">
          <div class="row-main"><div class="row-title">Transactions stored</div></div>
          <span class="row-amount">${settings.counts.transactions}</span>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Account</h2></div>
      <p class="muted">Signed in as ${esc(state.user.email)}.</p>
      <div class="btn-row">
        <button class="btn btn-sm" data-change-password>Change password</button>
        <button class="btn btn-sm" data-logout>Sign out</button>
      </div>
    </section>`;
}

function newConnectionSheet(adapters) {
  const usable = adapters.filter((a) => a.id !== 'web' || a.configured);

  openSheet('Add a connection', `
    <form id="connection-form">
      <label class="field">
        <span>How should transactions arrive?</span>
        <select name="adapter" id="adapter-select">
          ${usable.map((a) => `<option value="${a.id}">${esc(a.label)}</option>`).join('')}
        </select>
      </label>
      <p class="muted" id="adapter-help"></p>
      <label class="field">
        <span>Name</span>
        <input type="text" name="name" required value="Golden 1" placeholder="Golden 1 Credit Union">
      </label>
      <div id="credential-fields" hidden>
        <label class="field">
          <span>Online banking username</span>
          <input type="text" name="username" autocomplete="off">
        </label>
        <label class="field">
          <span>Password or Direct Connect PIN</span>
          <input type="password" name="password" autocomplete="off">
        </label>
        <p class="muted">Encrypted with ENCRYPTION_KEY before it touches the database.</p>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Add connection</button>
    </form>`);

  const select = $('#adapter-select');
  const sync = () => {
    const a = usable.find((x) => x.id === select.value);
    $('#credential-fields').hidden = !a.capabilities.needsCredentials;
    $('#adapter-help').innerHTML = `${esc(a.description)}${a.configHint ? ` <strong>${esc(a.configHint)}</strong>` : ''}`;
    for (const input of $('#credential-fields').querySelectorAll('input')) {
      input.required = a.capabilities.needsCredentials;
    }
  };
  select.addEventListener('change', sync);
  sync();

  $('#connection-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/connections', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      closeSheet();
      toast('Connection added', 'good');
      viewSettings();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

function uploadSheet(connectionId) {
  openSheet('Upload a statement', `
    <p class="muted">
      In Golden 1 online banking, open an account, choose Export / Download, and pick
      <strong>CSV</strong> or <strong>Quicken (QFX)</strong>. QFX carries the bank's own
      transaction IDs, so it de-duplicates perfectly across overlapping downloads.
    </p>
    <form id="upload-form">
      <label class="field">
        <span>Statement file</span>
        <input type="file" name="file" accept=".csv,.qfx,.ofx,.txt,text/csv" required>
      </label>
      <button class="btn btn-primary btn-block" type="submit">Import</button>
    </form>`);

  $('#upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const body = new FormData(e.target);
      const { result } = await api(`/connections/${connectionId}/upload`, { method: 'POST', body });
      closeSheet();
      toast(`${result.imported} imported, ${result.duplicates} already there`, 'good');
      viewSettings();
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false;
      btn.textContent = 'Import';
    }
  });
}

async function rulesSheet() {
  const { rules } = await api('/categories/rules/all');
  openSheet('Categorisation rules', `
    <form id="rule-form" style="margin-bottom:1rem">
      <div class="field-row">
        <label class="field">
          <span>If the description contains</span>
          <input type="text" name="pattern" required placeholder="e.g. RALEYS">
        </label>
        <label class="field">
          <span>Put it in</span>
          <select name="categoryId" required>${categoryOptions(null, { includeBlank: false })}</select>
        </label>
      </div>
      <button class="btn btn-primary btn-block" type="submit">Add rule</button>
    </form>
    <div class="rows">
      ${rules.map((r) => `
        <div class="row">
          <span class="dot" style="background:${esc(r.category_color)}"></span>
          <div class="row-main">
            <div class="row-title">${esc(r.pattern)}</div>
            <div class="row-sub">${esc(r.category_name)} · ${esc(r.match_type)}${r.auto ? ' · learned' : ''}</div>
          </div>
          <button class="btn btn-sm btn-danger" data-delete-rule="${r.id}">×</button>
        </div>`).join('')}
    </div>`);

  $('#rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { recategorised } = await api('/categories/rules', {
        method: 'POST',
        body: Object.fromEntries(new FormData(e.target)),
      });
      toast(`Rule added · ${recategorised} transactions re-sorted`, 'good');
      rulesSheet();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

function passwordSheet() {
  openSheet('Change password', `
    <form id="password-form">
      <label class="field">
        <span>Current password</span>
        <input type="password" name="currentPassword" autocomplete="current-password" required>
      </label>
      <label class="field">
        <span>New password</span>
        <input type="password" name="newPassword" autocomplete="new-password" minlength="8" required>
      </label>
      <button class="btn btn-primary btn-block" type="submit">Update</button>
    </form>`);

  $('#password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/password', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      closeSheet();
      toast('Password changed', 'good');
    } catch (err) { toast(err.message, 'bad'); }
  });
}

// ---------------------------------------------------------------------------
// Global event delegation
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const t = e.target;
  const closest = (sel) => t.closest(sel);

  const monthBtn = closest('[data-month-delta]');
  if (monthBtn) {
    state.month = shiftMonth(state.month, Number(monthBtn.dataset.monthDelta));
    txFilters.offset = 0;
    return render();
  }

  if (closest('[data-edit-income]')) return editIncomeSheet();
  if (closest('[data-new-category]')) return newCategorySheet();

  const editCat = closest('[data-edit-category]');
  if (editCat) return editCategorySheet(editCat.dataset.editCategory);

  const delCat = closest('[data-delete-category]');
  if (delCat) {
    if (!confirm('Delete this category? Its transactions move to Uncategorized.')) return;
    await api(`/categories/${delCat.dataset.deleteCategory}`, { method: 'DELETE' });
    closeSheet();
    await loadCategories();
    toast('Category deleted');
    return render();
  }

  const txFilter = closest('[data-tx-filter]');
  if (txFilter) {
    const mode = txFilter.dataset.txFilter;
    txFilters.direction = mode === 'in' || mode === 'out' ? mode : '';
    txFilters.uncategorised = mode === 'uncat';
    txFilters.offset = 0;
    return viewTransactions();
  }

  const txRow = closest('[data-tx]');
  if (txRow) return transactionSheet(txRow.dataset.tx);

  if (closest('[data-tx-more]')) {
    txFilters.offset += 100;
    return viewTransactions();
  }

  const subStatus = closest('[data-sub-status]');
  if (subStatus) {
    try {
      await api(`/subscriptions/${subStatus.dataset.subStatus}`, {
        method: 'PATCH',
        body: { status: subStatus.dataset.status },
      });
      closeSheet();
      toast('Updated', 'good');
      return viewSubscriptions();
    } catch (err) { return toast(err.message, 'bad'); }
  }

  const subDetail = closest('[data-sub-detail]');
  if (subDetail) return subscriptionDetail(subDetail.dataset.subDetail);

  if (closest('[data-redetect]')) {
    toast('Scanning…');
    await api('/subscriptions/detect', { method: 'POST' });
    toast('Scan complete', 'good');
    return viewSubscriptions();
  }

  if (closest('[data-goal-new]')) return goalFormSheet(null);

  const goalEdit = closest('[data-goal-edit]');
  if (goalEdit) {
    const { goals } = await api('/goals');
    return goalFormSheet(goals.find((g) => String(g.id) === goalEdit.dataset.goalEdit));
  }

  const goalContribute = closest('[data-goal-contribute]');
  if (goalContribute) return contributionSheet(goalContribute.dataset.goalContribute);

  const goalDelete = closest('[data-goal-delete]');
  if (goalDelete) {
    if (!confirm('Delete this goal and its contributions?')) return;
    await api(`/goals/${goalDelete.dataset.goalDelete}`, { method: 'DELETE' });
    closeSheet();
    toast('Goal deleted');
    return viewGoals();
  }

  if (closest('[data-new-connection]')) {
    const { adapters } = await api('/connections/adapters');
    return newConnectionSheet(adapters);
  }

  const upload = closest('[data-upload]');
  if (upload) return uploadSheet(upload.dataset.upload);

  const syncBtn = closest('[data-sync]');
  if (syncBtn) return doSync(syncBtn.dataset.sync);

  const delConn = closest('[data-delete-connection]');
  if (delConn) {
    if (!confirm('Remove this connection? Imported transactions stay.')) return;
    await api(`/connections/${delConn.dataset.deleteConnection}`, { method: 'DELETE' });
    toast('Connection removed');
    return viewSettings();
  }

  if (closest('[data-view-rules]')) return rulesSheet();

  const delRule = closest('[data-delete-rule]');
  if (delRule) {
    await api(`/categories/rules/${delRule.dataset.deleteRule}`, { method: 'DELETE' });
    return rulesSheet();
  }

  if (closest('[data-reanalyze]')) {
    toast('Re-categorising…');
    const r = await api('/transactions/reanalyze', { method: 'POST', body: { all: true } });
    toast(`${r.categorised} transactions re-sorted`, 'good');
    return;
  }

  if (closest('[data-change-password]')) return passwordSheet();
  if (closest('[data-logout]') || closest('#logout-btn')) return doLogout();
  if (closest('#sync-btn') || closest('#sync-btn-mobile')) return syncAll();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const row = e.target.closest('[data-tx]');
  if (row) { e.preventDefault(); transactionSheet(row.dataset.tx); }
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

async function doSync(connectionId) {
  toast('Syncing…');
  try {
    const { result } = await api(`/connections/${connectionId}/sync`, { method: 'POST' });
    toast(`${result.imported} new transaction${result.imported === 1 ? '' : 's'}`, 'good');
    render();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

async function syncAll() {
  const { connections } = await api('/connections');
  const syncable = [];
  const { adapters } = await api('/connections/adapters');
  for (const c of connections) {
    const a = adapters.find((x) => x.id === c.adapter);
    if (a && a.capabilities.sync) syncable.push(c);
  }
  if (!syncable.length) {
    toast('No connection can sync on its own — upload a statement instead.');
    location.hash = '#/settings';
    return;
  }
  for (const c of syncable) await doSync(c.id);
}

// ---------------------------------------------------------------------------
// Auth + boot
// ---------------------------------------------------------------------------

function showLogin() {
  app.hidden = true;
  login.hidden = false;
}

async function doLogout() {
  await api('/auth/logout', { method: 'POST' });
  state.user = null;
  showLogin();
}

async function loadCategories() {
  const { categories } = await api('/categories');
  state.categories = categories;
}

const VIEWS = {
  dashboard: viewDashboard,
  budget: viewBudget,
  transactions: viewTransactions,
  subscriptions: viewSubscriptions,
  goals: viewGoals,
  settings: viewSettings,
};

async function render() {
  const route = currentRoute();
  $('#view-title').textContent = route.title;
  renderNav();
  try {
    await VIEWS[route.path]();
  } catch (err) {
    if (err.message === 'Not signed in.') return;
    content.innerHTML = `<div class="card">${empty('Something went wrong', err.message)}</div>`;
  }
}

window.addEventListener('hashchange', render);

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('#login-error');
  errorEl.hidden = true;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const { user } = await api('/auth/login', {
      method: 'POST',
      body: Object.fromEntries(new FormData(e.target)),
    });
    state.user = user;
    login.hidden = true;
    app.hidden = false;
    await loadCategories();
    render();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

async function boot() {
  try {
    const { user } = await api('/auth/me');
    state.user = user;
    login.hidden = true;
    app.hidden = false;
    await loadCategories();
    await render();
  } catch {
    showLogin();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is optional */ });
  }
}

boot();
