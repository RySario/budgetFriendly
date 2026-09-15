import { get, patch } from '../api.js';
import {
  esc, money, monthLabel, cadenceLabel, shortDate, relativeDay, todayISO, plural,
} from '../format.js';
import { icon, monthSwitcher, segmented, empty, dateTile, toast } from '../ui.js';

let mode = 'list';
let selectedDay = null;

export default async function render(ctx) {
  const { view, state } = ctx;
  ctx.setActions(monthSwitcher(state.month));

  const r = await get('/recurring', { month: state.month });
  const bills = r.series.filter((s) => s.type === 'expense');
  const pay = r.series.filter((s) => s.type === 'income');
  const toReview = r.series.filter((s) => s.status === 'detected');
  const perMonth = (list) => list.reduce((a, s) => a + s.monthlyAmount, 0);
  if (selectedDay && !selectedDay.startsWith(state.month)) selectedDay = null;

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Bills left this month</div>
        <div class="kpi-value">${esc(money(r.totals.expense.remaining))}</div>
        <div class="kpi-sub">${esc(money(r.totals.expense.settled))} paid of ${esc(money(r.totals.expense.expected))}</div></div>
      <div class="kpi"><div class="kpi-label">Income still to come</div>
        <div class="kpi-value">${esc(money(r.totals.income.remaining))}</div>
        <div class="kpi-sub">${esc(money(r.totals.income.settled))} received of ${esc(money(r.totals.income.expected))}</div></div>
      <div class="kpi"><div class="kpi-label">Recurring bills</div>
        <div class="kpi-value">${bills.length}</div>
        <div class="kpi-sub">${esc(money(perMonth(bills)))} a month</div></div>
      <div class="kpi"><div class="kpi-label">Paychecks</div>
        <div class="kpi-value">${pay.length}</div>
        <div class="kpi-sub">${esc(money(perMonth(pay)))} a month</div></div>
    </div>

    ${toReview.length ? `
      <section class="card card-flush">
        <div class="card-head">
          <div><h2>Is this recurring?</h2><div class="card-sub">These repeat in your transactions. Confirm the real ones.</div></div>
        </div>
        <div class="rows">${toReview.map((s) => seriesRow(s, true)).join('')}</div>
      </section>` : ''}

    <section class="card card-flush">
      <div class="card-head">
        <h2>${esc(monthLabel(state.month))}</h2>
        ${segmented('mode', [['list', 'List'], ['calendar', 'Calendar']], mode)}
      </div>
      ${!r.entries.length
        ? empty('Nothing recurring this month', 'Bills and paychecks show up here once they have repeated at least three times.')
        : mode === 'calendar' ? calendar(r.entries, state.month) : `<div class="rows">${r.entries.map(entryRow).join('')}</div>`}
    </section>

    <section class="card card-flush">
      <div class="card-head"><div><h2>All recurring</h2><div class="card-sub">${plural(r.series.length, 'item')}</div></div></div>
      ${r.series.length
        ? `<div class="rows">${[...r.series].sort((a, b) => (a.type === b.type ? b.monthlyAmount - a.monthlyAmount : a.type === 'income' ? -1 : 1)).map((s) => seriesRow(s, false)).join('')}</div>`
        : empty('Nothing detected yet', 'Upload a few months of statements and repeating bills are found automatically.')}
    </section>`;

  view.addEventListener('click', async (e) => {
    const seg = e.target.closest('[data-seg="mode"]');
    if (seg) { mode = seg.dataset.value; ctx.rerender(); return; }

    const day = e.target.closest('[data-day]');
    if (day) { selectedDay = selectedDay === day.dataset.day ? null : day.dataset.day; ctx.rerender(); return; }

    const action = e.target.closest('[data-status]');
    if (action) {
      action.disabled = true;
      try {
        await patch(`/recurring/${action.dataset.type}/${action.dataset.id}`, { status: action.dataset.status });
        toast(action.dataset.status === 'confirmed' ? 'Marked as recurring' : 'Removed from recurring');
        ctx.rerender();
      } catch (err) {
        toast(err.message, 'bad');
        action.disabled = false;
      }
    }
  });
}

function stateChip(e) {
  switch (e.state) {
    case 'paid':
      return `<span class="chip good">${icon('check')}${e.type === 'income' ? 'Received' : 'Paid'} ${esc(shortDate(e.paidOn))}</span>`;
    case 'due':
      return `<span class="chip warn">${icon('clock')}Due ${esc(relativeDay(e.date))}</span>`;
    case 'missed':
      return `<span class="chip bad">${icon('alert')}Not found</span>`;
    default:
      return `<span class="chip">${esc(relativeDay(e.date))}</span>`;
  }
}

function entryRow(e) {
  const value = e.paidAmount != null ? e.paidAmount : e.amount;
  return `
    <div class="row">
      ${dateTile(e.date)}
      <div class="row-main">
        <div class="row-title">${esc(e.name)}</div>
        <div class="row-sub">${esc(cadenceLabel(e.cadence))}${e.categoryName ? ` · ${esc(e.categoryName)}` : ''}</div>
      </div>
      <div class="row-end">
        <div class="amount ${e.type === 'income' ? 'income' : ''}">${e.type === 'income' ? '+' : ''}${esc(money(value))}</div>
        ${stateChip(e)}
      </div>
    </div>`;
}

function seriesRow(s, reviewing) {
  // Confirm/decline buttons live in the review card only; the full list just
  // shows where each item stands.
  let actions;
  if (s.status === 'detected' && reviewing) {
    actions = `<button class="btn btn-sm btn-primary" type="button" data-status="confirmed" data-type="${s.type}" data-id="${s.id}">Confirm</button>
       <button class="btn btn-sm" type="button" data-status="dismissed" data-type="${s.type}" data-id="${s.id}">Not recurring</button>`;
  } else if (s.status === 'detected') {
    actions = `<span class="chip warn">${icon('clock')}Needs review</span>`;
  } else {
    actions = `<span class="chip accent">${icon('check')}Confirmed</span>
       <button class="link-btn" type="button" data-status="dismissed" data-type="${s.type}" data-id="${s.id}">Remove</button>`;
  }
  return `
    <div class="row" style="flex-wrap:wrap">
      <span class="emoji-tile" aria-hidden="true">${esc(s.categoryEmoji || (s.type === 'income' ? '💰' : '🔁'))}</span>
      <div class="row-main">
        <div class="row-title">${esc(s.name)}</div>
        <div class="row-sub">${esc(cadenceLabel(s.cadence))} · ${esc(money(s.amount))} · last ${esc(shortDate(s.lastOn))}</div>
      </div>
      <div class="row-end">
        <div class="amount ${s.type === 'income' ? 'income' : ''}">${esc(money(s.monthlyAmount))}<span class="muted small" style="font-weight:500">/mo</span></div>
      </div>
      <div class="series-actions ${reviewing ? '' : 'quiet'}">${actions}</div>
    </div>`;
}

function calendar(entries, month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const lead = new Date(y, m - 1, 1).getDay();
  const today = todayISO();
  const byDay = new Map();
  for (const e of entries) {
    if (!byDay.has(e.date)) byDay.set(e.date, []);
    byDay.get(e.date).push(e);
  }

  const cells = [];
  for (let i = 0; i < lead; i += 1) cells.push('<div class="cal-day other" aria-hidden="true"></div>');
  for (let d = 1; d <= days; d += 1) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    const list = byDay.get(iso) || [];
    cells.push(`
      <button class="cal-day ${iso === today ? 'today' : ''} ${iso === selectedDay ? 'selected' : ''}" type="button" data-day="${iso}"
        aria-label="${esc(shortDate(iso))}: ${list.length ? esc(list.map((e) => `${e.name} ${money(e.amount)} ${e.state}`).join(', ')) : 'nothing due'}">
        <span class="cal-num">${d}</span>
        <span class="cal-dots">${list.map((e) => `<span class="cal-dot ${e.state === 'paid' ? 'paid' : e.state === 'missed' ? 'missed' : ''} ${e.type === 'income' ? 'income' : ''}"></span>`).join('')}</span>
        ${list.slice(0, 3).map((e) => `<span class="cal-entry ${e.state === 'paid' ? 'paid' : ''}">${esc(e.name)} ${esc(money(e.amount, { whole: true }))}</span>`).join('')}
        ${list.length > 3 ? `<span class="tiny muted">+${list.length - 3} more</span>` : ''}
      </button>`);
  }
  while (cells.length % 7) cells.push('<div class="cal-day other" aria-hidden="true"></div>');

  const picked = selectedDay ? byDay.get(selectedDay) || [] : [];
  return `
    <div class="cal">
      ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="cal-dow">${d}</div>`).join('')}
      ${cells.join('')}
    </div>
    ${selectedDay ? `
      <div class="cal-list">
        <div class="date-head"><span>${esc(shortDate(selectedDay))}</span></div>
        ${picked.length ? `<div class="rows">${picked.map(entryRow).join('')}</div>` : empty('Nothing on this day')}
      </div>` : '<p class="small muted" style="padding:12px 18px">Select a day to see what\'s due.</p>'}`;
}
