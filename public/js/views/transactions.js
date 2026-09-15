import { get, patch, post } from '../api.js';
import {
  esc, money, txnAmount, dayHeading, monthLabel, plural,
} from '../format.js';
import {
  icon, avatar, pill, amount, empty, monthSwitcher, openDrawer, categorySelect, toast, segmented,
} from '../ui.js';

const PAGE = 100;

// Filters survive month switching and re-renders; arriving through a link with
// different parameters starts them fresh.
let filters = null;

function initFilters(params, state) {
  const drilled = params.has('category') || params.has('group') || params.has('merchant') || params.has('account');
  if (params.get('month')) state.month = params.get('month');
  return {
    key: params.toString(),
    search: params.get('search') || '',
    type: params.get('type') || '',
    categoryId: params.get('category') || '',
    groupId: params.get('group') || '',
    merchantKey: params.get('merchant') || '',
    accountId: params.get('account') || '',
    review: params.get('review') === '1',
    allDates: params.get('review') === '1' || params.get('all') === '1' || (drilled && !params.get('month')),
    limit: PAGE,
    focusSearch: false,
    open: false,
  };
}

export default async function render(ctx) {
  const { view, params, state } = ctx;
  if (!filters || filters.key !== params.toString()) filters = initFilters(params, state);

  ctx.setActions(filters.allDates ? '' : monthSwitcher(state.month));

  const [groups, data] = await Promise.all([
    ctx.groups(),
    get('/transactions', {
      limit: filters.limit,
      search: filters.search,
      type: filters.type,
      categoryId: filters.categoryId,
      groupId: filters.groupId,
      merchantKey: filters.merchantKey,
      accountId: filters.accountId,
      review: filters.review ? 'true' : '',
      month: filters.allDates ? '' : state.month,
    }),
  ]);

  const byDate = new Map();
  for (const t of data.transactions) {
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date).push(t);
  }

  const group = filters.groupId && groups.find((g) => String(g.id) === filters.groupId);
  const extraFilter = group ? `Group: ${group.name}`
    : filters.merchantKey ? `Merchant: ${data.transactions[0] ? data.transactions[0].merchant : filters.merchantKey}`
      : filters.accountId ? 'One account' : '';
  const activeFilters = [filters.type, filters.categoryId, filters.review, filters.allDates, extraFilter].filter(Boolean).length;

  view.innerHTML = `
    <div class="toolbar">
      <label class="search grow">${icon('search')}
        <input type="search" name="search" placeholder="Search merchants, categories, notes" value="${esc(filters.search)}" aria-label="Search transactions" enterkeyhint="search">
      </label>
      <button class="btn only-mobile" type="button" data-toggle-filters aria-expanded="${filters.open}">${icon('filter')}Filters${activeFilters ? ` · ${activeFilters}` : ''}</button>
      <div class="toolbar-filters ${filters.open ? 'open' : ''}">
      ${segmented('type', [['', 'All'], ['spending', 'Expenses'], ['income', 'Income'], ['transfer', 'Transfers']], filters.type)}
      <select name="category" aria-label="Category">
        <option value="">All categories</option>
        ${groups.map((g) => `<optgroup label="${esc(g.name)}">${g.categories.map((c) => `
          <option value="${c.id}" ${String(c.id) === filters.categoryId ? 'selected' : ''}>${esc(`${c.emoji || ''} ${c.name}`.trim())}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <button class="toggle-chip ${filters.review ? 'active' : ''}" type="button" data-toggle="review" aria-pressed="${filters.review}">
        Needs review${state.reviewCount ? ` · ${state.reviewCount}` : ''}
      </button>
      <button class="toggle-chip ${filters.allDates ? 'active' : ''}" type="button" data-toggle="allDates" aria-pressed="${filters.allDates}">All dates</button>
      ${extraFilter ? `<span class="filter-chip">${esc(extraFilter)}<button type="button" data-clear-extra aria-label="Clear filter">${icon('x')}</button></span>` : ''}
      </div>
    </div>

    <div class="split small" style="margin:0 2px">
      <span class="muted">${plural(data.totals.count, 'transaction')}${filters.allDates ? '' : ` in ${esc(monthLabel(state.month))}`}</span>
      <span><span class="good-text strong">+${esc(money(data.totals.income))}</span> <span class="muted">in</span> · <strong>${esc(money(data.totals.expenses))}</strong> <span class="muted">out</span></span>
    </div>

    ${filters.review && data.totals.count ? `
      <div class="banner">
        ${icon('check')}
        <div class="grow">Check each category, then mark them reviewed.</div>
        <button class="btn btn-sm" type="button" data-review-all>Mark all reviewed</button>
      </div>` : ''}

    <section class="card card-flush">
      ${data.transactions.length ? [...byDate].map(([date, list]) => `
        <div class="date-head">
          <span>${esc(dayHeading(date))}</span>
        </div>
        <div class="rows">${list.map(row).join('')}</div>`).join('')
        : empty(
          filters.review ? 'All caught up' : 'No transactions',
          filters.review ? 'Nothing needs reviewing.' : 'Try another month, or clear the filters.',
        )}
    </section>

    ${data.hasMore ? '<button class="btn btn-block" type="button" data-more>Load more</button>' : ''}`;

  let debounce;
  const search = view.querySelector('input[name="search"]');
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      filters.search = search.value.trim();
      filters.limit = PAGE;
      filters.focusSearch = true;
      ctx.rerender();
    }, 300);
  });
  ctx.onCleanup(() => clearTimeout(debounce));
  ctx.afterMount(() => {
    if (!filters.focusSearch) return;
    filters.focusSearch = false;
    const input = ctx.view.querySelector('input[name="search"]');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });

  view.querySelector('select[name="category"]').addEventListener('change', (e) => {
    filters.categoryId = e.target.value;
    filters.limit = PAGE;
    ctx.rerender();
  });

  view.addEventListener('click', async (e) => {
    const filterToggle = e.target.closest('[data-toggle-filters]');
    if (filterToggle) {
      filters.open = !filters.open;
      view.querySelector('.toolbar-filters').classList.toggle('open', filters.open);
      filterToggle.setAttribute('aria-expanded', String(filters.open));
      return;
    }

    const seg = e.target.closest('[data-seg="type"]');
    if (seg) { filters.type = seg.dataset.value; filters.limit = PAGE; ctx.rerender(); return; }

    const toggle = e.target.closest('[data-toggle]');
    if (toggle) { filters[toggle.dataset.toggle] = !filters[toggle.dataset.toggle]; filters.limit = PAGE; ctx.rerender(); return; }

    if (e.target.closest('[data-clear-extra]')) {
      filters.groupId = ''; filters.merchantKey = ''; filters.accountId = '';
      ctx.rerender();
      return;
    }
    if (e.target.closest('[data-more]')) { filters.limit += PAGE; ctx.rerender(); return; }

    if (e.target.closest('[data-review-all]')) {
      try {
        const ids = data.transactions.map((t) => t.id);
        const res = await post('/transactions/review', data.hasMore ? { all: true } : { ids });
        toast(`${plural(res.updated, 'transaction')} marked reviewed`);
        await ctx.refreshBadges();
        ctx.rerender();
      } catch (err) { toast(err.message, 'bad'); }
      return;
    }

    const txn = e.target.closest('[data-txn]');
    if (txn) {
      openTransaction(ctx, Number(txn.dataset.txn), {
        onChange: async () => { await ctx.refreshBadges(); ctx.rerender(); },
      });
    }
  });
}

function row(t) {
  return `
    <button class="row txn-row ${t.needsReview ? 'needs-review' : ''}" type="button" data-txn="${t.id}">
      ${avatar(t.merchant)}
      <div class="row-main">
        <div class="row-title">${esc(t.merchant)}</div>
        <div class="row-sub only-mobile">${esc(t.categoryEmoji || '')} ${esc(t.categoryName || 'Uncategorized')}</div>
      </div>
      <div class="txn-cat only-desktop">${pill(t.categoryEmoji, t.categoryName)}</div>
      <div class="txn-acct only-desktop small muted truncate">${esc(t.accountName)}${t.accountMask ? ` ••${esc(t.accountMask)}` : ''}</div>
      <div class="row-end">
        ${amount(t.amount, t.kind)}
        ${t.excluded ? '<div class="tiny muted">Hidden</div>' : ''}
      </div>
    </button>`;
}

/** The detail panel: category, rule, notes, hide. Shared with the dashboard. */
export async function openTransaction(ctx, id, { onChange } = {}) {
  let t;
  let groups;
  try {
    [{ transaction: t }, groups] = await Promise.all([get(`/transactions/${id}`), ctx.groups()]);
  } catch (err) {
    toast(err.message, 'bad');
    return;
  }

  openDrawer({
    title: t.merchant,
    body: `
      <div class="txn-hero">
        <div class="hero-value ${t.amount > 0 && t.kind !== 'transfer' ? 'good-text' : ''}">${esc(txnAmount(t.amount))}</div>
        <div class="muted small" style="margin-top:4px">${esc(dayHeading(t.date))} · ${esc(t.accountName)}${t.accountMask ? ` ••${esc(t.accountMask)}` : ''}</div>
        ${t.needsReview ? '<div style="margin-top:8px"><span class="chip accent">Needs review</span></div>' : ''}
      </div>
      <form id="txn-form">
        <label class="field">
          <span class="field-label">Category</span>
          ${categorySelect(groups, t.categoryId)}
        </label>
        <label class="check" id="apply-row" hidden>
          <input type="checkbox" name="applyToMerchant" checked>
          <span>Always categorize <strong>${esc(t.merchant)}</strong> this way
            <span class="field-help">Also moves its other transactions and future uploads.</span></span>
        </label>
        <label class="field">
          <span class="field-label">Notes</span>
          <textarea name="notes" placeholder="Add a note">${esc(t.notes || '')}</textarea>
        </label>
        <label class="check">
          <input type="checkbox" name="excluded" ${t.excluded ? 'checked' : ''}>
          <span>Hide from budgets and reports
            <span class="field-help">For things like reimbursements you'll be paid back for.</span></span>
        </label>
        <div class="field">
          <span class="field-label">Bank description</span>
          <div class="code">${esc(t.description)}</div>
        </div>
      </form>`,
    footer: '<button class="btn btn-primary" type="button" data-save>Save</button>',
    onMount(drawer, close) {
      const form = drawer.querySelector('#txn-form');
      const select = form.querySelector('select[name="categoryId"]');
      const applyRow = drawer.querySelector('#apply-row');
      select.addEventListener('change', () => { applyRow.hidden = String(select.value) === String(t.categoryId); });

      drawer.querySelector('[data-save]').addEventListener('click', async (ev) => {
        const button = ev.currentTarget;
        const f = new FormData(form);
        const body = { needsReview: false };
        if (String(f.get('categoryId')) !== String(t.categoryId)) {
          body.categoryId = Number(f.get('categoryId'));
          body.applyToMerchant = f.get('applyToMerchant') === 'on';
        }
        const notes = String(f.get('notes') || '').trim();
        if (notes !== (t.notes || '')) body.notes = notes;
        const excluded = f.get('excluded') === 'on';
        if (excluded !== t.excluded) body.excluded = excluded;

        button.disabled = true;
        try {
          const res = await patch(`/transactions/${t.id}`, body);
          close();
          toast(res.alsoUpdated
            ? `Saved · ${plural(res.alsoUpdated, 'other transaction')} from ${t.merchant} updated`
            : 'Saved');
          if (onChange) onChange();
        } catch (err) {
          toast(err.message, 'bad');
          button.disabled = false;
        }
      });
    },
  });
}
