import { put, get } from '../api.js';
import { esc, money, monthLabel } from '../format.js';
import { icon, monthSwitcher, meter, toast } from '../ui.js';

const collapsed = new Set();

export default async function render(ctx) {
  const { view, state } = ctx;
  ctx.setActions(monthSwitcher(state.month));

  const b = await get('/budget', { month: state.month });
  const s = b.summary;
  const income = b.groups.filter((g) => g.kind === 'income');
  const expenses = b.groups.filter((g) => g.kind === 'spending');
  const over = s.expenses.budgeted > 0 && s.expenses.actual > s.expenses.budgeted;

  view.innerHTML = `
    <div class="grid grid-3">
      <section class="card">
        <div class="kpi-label">Left to budget</div>
        <div class="hero-value ${s.leftToBudget < 0 ? 'bad-text' : ''}">${esc(money(s.leftToBudget))}</div>
        <div class="kpi-sub">${s.leftToBudget < 0
          ? 'You have budgeted more than you expect to earn.'
          : 'Expected income minus budgeted expenses.'}</div>
      </section>
      <section class="card">
        <div class="split"><span class="kpi-label">Income</span>
          <span class="small"><strong>${esc(money(s.income.actual))}</strong> <span class="muted">of ${esc(money(s.income.planned))}</span></span></div>
        ${meter(s.income.planned ? s.income.actual / s.income.planned : 0, 'income')}
        <div class="kpi-sub" style="margin-top:8px">${s.income.budgeted == null
          ? 'Expected from your detected paychecks. Enter amounts below to override.'
          : `${esc(money(Math.max(0, s.income.planned - s.income.actual)))} still to come`}</div>
      </section>
      <section class="card">
        <div class="split"><span class="kpi-label">Expenses</span>
          <span class="small"><strong>${esc(money(s.expenses.actual))}</strong> <span class="muted">of ${esc(money(s.expenses.budgeted))}</span></span></div>
        ${meter(s.expenses.budgeted ? s.expenses.actual / s.expenses.budgeted : 0, over ? 'over' : '')}
        <div class="kpi-sub" style="margin-top:8px">${!s.expenses.budgeted
          ? 'Enter a budget next to any category to start.'
          : over
            ? `<span class="bad-text strong">${esc(money(-s.expenses.remaining))} over budget</span>`
            : `${esc(money(s.expenses.remaining))} left to spend`}</div>
      </section>
    </div>

    <section class="card card-flush">${table('Income', income, true)}</section>
    <section class="card card-flush">${table('Expenses', expenses, false)}</section>
    <p class="small muted" style="margin:0 2px">A budget you enter applies to ${esc(monthLabel(state.month))} and every month after it, until you change it.</p>`;

  view.addEventListener('click', (e) => {
    const head = e.target.closest('[data-collapse]');
    if (!head) return;
    const id = Number(head.dataset.collapse);
    if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
    ctx.rerender();
  });
  view.addEventListener('keydown', (e) => {
    const head = e.target.closest('[data-collapse]');
    if (head && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); head.click(); }
    if (e.target.matches('[data-budget]') && e.key === 'Enter') e.target.blur();
  });
  view.addEventListener('change', async (e) => {
    const input = e.target.closest('[data-budget]');
    if (!input) return;
    const raw = input.value.replace(/[$,\s]/g, '');
    const amount = raw === '' ? null : Number(raw);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
      toast('Enter a dollar amount, or leave it blank for no budget.', 'bad');
      return;
    }
    try {
      await put(`/budget/${input.dataset.budget}`, { month: state.month, amount });
      ctx.rerender();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

function table(title, groups, isIncome) {
  const cols = isIncome ? ['Expected', 'Received', 'Remaining'] : ['Budget', 'Spent', 'Remaining'];
  // A section with one group of the same name doesn't need a second heading.
  const showHeads = !(groups.length === 1 && groups[0].name === title);
  return `
    <div class="budget-row" style="border-top:0">
      <h2 style="font-size:16px">${title}</h2>
      <span class="budget-cell muted small">${cols[0]}</span>
      <span class="budget-cell muted small col-actual">${cols[1]}</span>
      <span class="budget-cell muted small col-remaining">${cols[2]}</span>
    </div>
    ${groups.map((g) => {
      const isCollapsed = showHeads && collapsed.has(g.id);
      return `
        <div class="budget-group ${isCollapsed ? 'collapsed' : ''}">
          ${showHeads ? `
            <div class="budget-head" data-collapse="${g.id}" role="button" tabindex="0" aria-expanded="${!isCollapsed}">
              <span class="budget-name">${icon('down').replace('<svg', '<svg class="caret"')}<span class="truncate">${esc(g.name)}</span></span>
              <span class="budget-cell">${g.budget == null ? '<span class="muted">—</span>' : esc(money(g.budget))}</span>
              <span class="budget-cell col-actual">${esc(money(g.actual))}</span>
              <span class="budget-cell col-remaining">${remaining(g.remaining, isIncome)}</span>
            </div>` : ''}
          ${isCollapsed ? '' : g.categories.map((c) => categoryRow(c, isIncome)).join('')}
        </div>`;
    }).join('')}`;
}

function categoryRow(c, isIncome) {
  const over = !isIncome && c.budget != null && c.actual > c.budget;
  const fill = c.budget ? meter(c.actual / c.budget, over ? 'over thin' : isIncome ? 'income thin' : 'thin') : '';
  return `
    <div class="budget-row">
      <div class="budget-name">
        <span class="emoji-tile" aria-hidden="true" style="width:32px;height:32px;font-size:16px">${esc(c.emoji || '•')}</span>
        <div class="row-main">
          <div class="row-title">${esc(c.name)}</div>
          <div class="row-sub only-mobile">${isIncome ? 'Received' : 'Spent'} ${esc(money(c.actual))}${c.remaining == null ? '' : ` · ${remaining(c.remaining, isIncome, true)}`}</div>
          ${fill}
        </div>
      </div>
      <div class="budget-cell">
        <input class="budget-input" type="text" inputmode="decimal" data-budget="${c.id}"
          value="${c.budget == null ? '' : c.budget}" placeholder="—"
          aria-label="${esc(c.name)} ${isIncome ? 'expected' : 'budget'}">
      </div>
      <div class="budget-cell col-actual">${esc(money(c.actual))}</div>
      <div class="budget-cell col-remaining">${remaining(c.remaining, isIncome)}</div>
    </div>`;
}

function remaining(value, isIncome, withLeft = false) {
  if (value == null) return '<span class="muted">—</span>';
  if (value < 0) {
    return isIncome
      ? `<span class="good-text strong">${esc(money(-value))} extra</span>`
      : `<span class="bad-text strong">${esc(money(-value))} over</span>`;
  }
  return `${esc(money(value))}${withLeft ? ' left' : ''}`;
}
