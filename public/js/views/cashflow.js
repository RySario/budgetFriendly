import { get } from '../api.js';
import { esc, money, pct, monthLabel, monthShort } from '../format.js';
import { segmented, empty } from '../ui.js';
import { columnChart, legend } from '../charts.js';

// View state kept between visits.
let months = 12;
let kind = 'spending';
let by = 'category';
let selected = null; // 'YYYY-MM' when one month is picked
let showTable = false;

export default async function render(ctx) {
  const { view } = ctx;
  ctx.setActions(segmented('range', [['6', '6M'], ['12', '12M'], ['24', '24M']], String(months)));
  ctx.setHeaderHandler((e) => {
    const b = e.target.closest('[data-seg="range"]');
    if (!b) return;
    months = Number(b.dataset.value);
    selected = null;
    ctx.rerender();
  });

  const params = { months, by };
  if (selected) {
    const [y, m] = selected.split('-').map(Number);
    params.start = `${selected}-01`;
    params.end = `${selected}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  }
  const data = await get('/cashflow', params);
  const series = data.series;
  const selIndex = selected ? series.findIndex((s) => s.month === selected) : -1;
  const sel = selIndex >= 0 ? series[selIndex] : null;
  if (selected && !sel) selected = null;
  const scope = sel || data.totals;
  const breakdown = kind === 'income' ? data.breakdown.income : data.breakdown.spending;
  const scopeLabel = sel ? monthLabel(sel.month) : `Last ${months} months`;
  const maxItem = breakdown.items.length ? breakdown.items[0].value : 0;
  const barColor = kind === 'income' ? 'var(--series-income)' : 'var(--series-expense)';

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Income</div><div class="kpi-value">${esc(money(scope.income))}</div><div class="kpi-sub">${esc(scopeLabel)}</div></div>
      <div class="kpi"><div class="kpi-label">Expenses</div><div class="kpi-value">${esc(money(scope.expenses))}</div><div class="kpi-sub">${esc(scopeLabel)}</div></div>
      <div class="kpi"><div class="kpi-label">Saved</div><div class="kpi-value ${scope.savings < 0 ? 'bad-text' : ''}">${esc(money(scope.savings))}</div><div class="kpi-sub">${scope.savings < 0 ? 'Spent more than earned' : 'Income minus expenses'}</div></div>
      <div class="kpi"><div class="kpi-label">Savings rate</div><div class="kpi-value">${esc(pct(scope.savingsRate))}</div><div class="kpi-sub">of income kept</div></div>
    </div>

    <section class="card">
      <div class="card-head">
        <div>
          <h2>Income vs. expenses</h2>
          <div class="card-sub">${sel
            ? `Showing ${esc(monthLabel(sel.month))} · <button class="link-btn" type="button" data-clear-month>Show all months</button>`
            : 'Select a month to break it down'}</div>
        </div>
        <button class="btn btn-sm btn-quiet" type="button" data-table aria-pressed="${showTable}">${showTable ? 'Hide table' : 'Table'}</button>
      </div>
      ${legend([{ label: 'Income', color: 'var(--series-income)' }, { label: 'Expenses', color: 'var(--series-expense)' }], 'rect')}
      <div id="flow-chart"></div>
      ${showTable ? `
        <div class="table-wrap" style="margin-top:14px">
          <table class="data-table">
            <thead><tr><th>Month</th><th class="r">Income</th><th class="r">Expenses</th><th class="r">Saved</th><th class="r">Rate</th></tr></thead>
            <tbody>${[...series].reverse().map((s) => `
              <tr><td>${esc(monthLabel(s.month))}</td><td class="r">${esc(money(s.income))}</td><td class="r">${esc(money(s.expenses))}</td>
                <td class="r">${esc(money(s.savings))}</td><td class="r">${esc(pct(s.savingsRate))}</td></tr>`).join('')}</tbody>
          </table>
        </div>` : ''}
    </section>

    <section class="card card-flush">
      <div class="card-head" style="flex-wrap:wrap">
        <div>
          <h2>${kind === 'income' ? 'Income' : 'Expenses'} by ${by}</h2>
          <div class="card-sub">${esc(scopeLabel)} · ${esc(money(breakdown.total))}</div>
        </div>
        <div class="toolbar">
          ${segmented('kind', [['spending', 'Expenses'], ['income', 'Income']], kind)}
          ${segmented('by', [['category', 'Category'], ['group', 'Group'], ['merchant', 'Merchant']], by)}
        </div>
      </div>
      ${breakdown.items.length ? `<div class="bar-list">${breakdown.items.slice(0, 30).map((i) => `
        <button class="bar-row" type="button" data-drill="${esc(i.id)}">
          <span class="bar-label">${i.emoji ? `<span aria-hidden="true">${esc(i.emoji)}</span>` : ''}<span class="truncate">${esc(i.name)}</span></span>
          <span class="bar-value">${esc(money(i.value))}<span class="muted small">${esc(pct((i.value / breakdown.total) * 100))}</span></span>
          <span class="bar-track"><span style="width:${((i.value / maxItem) * 100).toFixed(1)}%;background:${barColor}"></span></span>
        </button>`).join('')}</div>`
        : empty('Nothing here', 'No transactions in this range.')}
    </section>`;

  ctx.onCleanup(columnChart(view.querySelector('#flow-chart'), {
    labels: series.map((s) => s.month),
    labelFor: (k) => monthShort(k),
    titleFor: (k) => monthLabel(k),
    series: [
      { name: 'Income', colorVar: '--series-income', values: series.map((s) => s.income) },
      { name: 'Expenses', colorVar: '--series-expense', values: series.map((s) => s.expenses) },
    ],
    selected: selIndex >= 0 ? selIndex : null,
    onSelect: (i) => {
      selected = series[i].month === selected ? null : series[i].month;
      ctx.rerender();
    },
  }));

  view.addEventListener('click', (e) => {
    const seg = e.target.closest('[data-seg]');
    if (seg && seg.dataset.seg === 'kind') { kind = seg.dataset.value; ctx.rerender(); return; }
    if (seg && seg.dataset.seg === 'by') { by = seg.dataset.value; ctx.rerender(); return; }
    if (e.target.closest('[data-clear-month]')) { selected = null; ctx.rerender(); return; }
    if (e.target.closest('[data-table]')) { showTable = !showTable; ctx.rerender(); return; }

    const drill = e.target.closest('[data-drill]');
    if (drill) {
      const id = encodeURIComponent(drill.dataset.drill);
      const key = by === 'group' ? 'group' : by === 'merchant' ? 'merchant' : 'category';
      const when = sel ? `&month=${sel.month}` : '&all=1';
      ctx.navigate(`#/transactions?${key}=${id}${when}`);
    }
  });
}
