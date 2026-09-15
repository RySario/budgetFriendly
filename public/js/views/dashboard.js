import { get } from '../api.js';
import {
  esc, money, monthLabel, monthShort, currentMonthKey, shortDate, relativeDay, timeAgo, plural,
} from '../format.js';
import { icon, monthSwitcher, avatar, amount, meter, empty, dateTile } from '../ui.js';
import { lineChart, legend } from '../charts.js';
import { openTransaction } from './transactions.js';
import { spendSummary } from './plan.js';

export default async function render(ctx) {
  const { view, state } = ctx;
  ctx.setActions(monthSwitcher(state.month));

  const d = await get('/dashboard', { month: state.month });
  const isCurrent = state.month === currentMonthKey();
  const { current, previous, previousMonth, daysInMonth } = d.pace;
  const spent = current.length ? current[current.length - 1].total : 0;
  const compareDay = isCurrent ? Math.min(current.length, previous.length) : previous.length;
  const previousAt = compareDay ? previous[compareDay - 1].total : 0;
  const delta = spent - previousAt;
  const hasAccounts = d.accounts.accounts.length > 0;

  view.innerHTML = `
    ${hasAccounts ? '' : onboarding()}
    ${d.reviewCount ? `
      <div class="banner">
        ${icon('alert')}
        <div class="grow">${plural(d.reviewCount, 'transaction')} to review</div>
        <button class="btn btn-sm" type="button" data-nav="#/transactions?review=1">Review</button>
      </div>` : ''}

    <div class="grid grid-main">
      <div class="grid">
        ${isCurrent ? spendCard(d.plan) : ''}
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Spending</h2>
              <div class="card-sub">${isCurrent ? 'So far this month' : esc(monthLabel(state.month))}</div>
            </div>
            <button class="link-btn" type="button" data-nav="#/cashflow">Cash flow</button>
          </div>
          <div class="hero-value">${esc(money(spent))}</div>
          <p class="small" style="margin-top:4px">
            ${spent || previousAt ? `
              <span class="strong ${delta <= 0 ? 'good-text' : 'bad-text'}">${esc(money(Math.abs(delta)))} ${delta <= 0 ? 'less' : 'more'}</span>
              <span class="muted">than ${esc(monthLabel(previousMonth))}${isCurrent ? ' at this point' : ''}</span>`
              : '<span class="muted">No spending yet</span>'}
          </p>
          <div style="margin-top:16px">
            ${legend([
              { label: isCurrent ? 'This month' : esc(monthShort(state.month)), color: 'var(--accent)' },
              { label: esc(monthShort(previousMonth)), color: 'var(--series-muted)' },
            ])}
            <div id="pace-chart"></div>
          </div>
        </section>

        <section class="card card-flush">
          <div class="card-head">
            <h2>Recent transactions</h2>
            <button class="link-btn" type="button" data-nav="#/transactions">View all</button>
          </div>
          ${d.recent.length
            ? `<div class="rows">${d.recent.map(txnRow).join('')}</div>`
            : empty('No transactions yet', 'Upload a statement to see them here.')}
        </section>
      </div>

      <div class="grid">
        ${budgetCard(d.budget.summary)}
        ${upcomingCard(d.upcoming.entries)}
        ${accountsCard(d.accounts, d.lastImport)}
        ${d.goals.length ? goalsCard(d.goals) : ''}
      </div>
    </div>`;

  ctx.onCleanup(lineChart(view.querySelector('#pace-chart'), {
    series: [
      // Compared day-for-day, so a longer previous month is cut at this
      // month's last day rather than stretching the axis to a date that
      // doesn't exist ("Sep 31").
      { name: monthShort(previousMonth), colorVar: '--series-muted', emphasis: false,
        points: previous.filter((p) => p.day <= daysInMonth).map((p) => ({ x: p.day, y: p.total })) },
      { name: isCurrent ? 'This month' : monthShort(state.month), colorVar: '--accent', emphasis: true,
        points: current.map((p) => ({ x: p.day, y: p.total })) },
    ],
    xMax: daysInMonth,
    xLabel: (x, long) => (long ? `Day ${x}` : `${monthShort(state.month)} ${x}`),
  }));

  view.addEventListener('click', (e) => {
    const row = e.target.closest('[data-txn]');
    if (row) openTransaction(ctx, Number(row.dataset.txn), { onChange: () => { ctx.refreshBadges(); ctx.rerender(); } });
  });
}

function spendCard(plan) {
  if (!plan || !plan.ready) {
    return `
      <section class="card">
        <div class="card-head"><h2>Left to spend</h2></div>
        <p class="small ink-2">Add your paycheck to see how much you can spend before payday and still pay your bills and reach your goals.</p>
        <button class="btn btn-sm btn-primary" type="button" data-nav="#/plan" style="margin-top:14px">Set up paycheck plan</button>
      </section>`;
  }
  return `
    <section class="card">
      <div class="card-head">
        <div><h2>Left to spend</h2><div class="card-sub">Until payday ${esc(shortDate(plan.period.nextPayday))}</div></div>
        <button class="link-btn" type="button" data-nav="#/plan">Paycheck plan</button>
      </div>
      ${spendSummary(plan)}
      ${plan.goalsDelayed ? `<p class="small warn-text plan-note" style="margin-top:12px">${icon('clock')} ${plan.isCustom
        ? 'Your spending budget pushes a goal back.'
        : 'Your goals need more than is left after bills.'}</p>` : ''}
    </section>`;
}

function onboarding() {
  return `
    <section class="card">
      <div class="card-head"><h2>Import your first statement</h2></div>
      <ol class="steps">
        <li>Sign in to Golden 1 online banking.</li>
        <li>Open your checking account and click the download (cloud) icon.</li>
        <li>Choose <strong>OFX</strong> and the longest date range it allows.</li>
        <li>Upload the file here.</li>
      </ol>
      <button class="btn btn-primary" type="button" data-action="upload" style="margin-top:16px">${icon('upload')}Upload statement</button>
    </section>`;
}

function txnRow(t) {
  return `
    <button class="row ${t.needsReview ? 'needs-review' : ''}" type="button" data-txn="${t.id}">
      ${avatar(t.merchant)}
      <div class="row-main">
        <div class="row-title">${esc(t.merchant)}</div>
        <div class="row-sub">${esc(t.categoryEmoji || '')} ${esc(t.categoryName || 'Uncategorized')} · ${esc(shortDate(t.date))}</div>
      </div>
      <div class="row-end">${amount(t.amount, t.kind)}</div>
    </button>`;
}

function budgetCard(s) {
  const over = s.expenses.budgeted > 0 && s.expenses.actual > s.expenses.budgeted;
  return `
    <section class="card">
      <div class="card-head"><h2>Budget</h2><button class="link-btn" type="button" data-nav="#/budget">Details</button></div>
      <div class="budget-line">
        <div class="split"><span class="ink-2">Income</span>
          <span><strong>${esc(money(s.income.actual))}</strong> <span class="muted">of ${esc(money(s.income.planned))}</span></span></div>
        ${meter(s.income.planned ? s.income.actual / s.income.planned : 0, 'income')}
      </div>
      <div class="budget-line">
        <div class="split"><span class="ink-2">Expenses</span>
          <span><strong>${esc(money(s.expenses.actual))}</strong> <span class="muted">${s.expenses.budgeted ? `of ${esc(money(s.expenses.budgeted))}` : 'no budget set'}</span></span></div>
        ${meter(s.expenses.budgeted ? s.expenses.actual / s.expenses.budgeted : 0, over ? 'over' : '')}
      </div>
      ${s.expenses.budgeted
        ? `<div class="split" style="margin-top:12px;margin-bottom:0">
             <span class="ink-2">${over ? 'Over budget by' : 'Left to spend'}</span>
             <strong class="${over ? 'bad-text' : ''}">${esc(money(Math.abs(s.expenses.remaining)))}</strong>
           </div>`
        : '<button class="btn btn-sm" type="button" data-nav="#/budget" style="margin-top:14px">Set up your budget</button>'}
    </section>`;
}

function upcomingCard(entries) {
  return `
    <section class="card card-flush">
      <div class="card-head">
        <div><h2>Upcoming</h2><div class="card-sub">Next 14 days</div></div>
        <button class="link-btn" type="button" data-nav="#/recurring">Recurring</button>
      </div>
      ${entries.length ? `<div class="rows">${entries.slice(0, 6).map((e) => `
        <div class="row">
          ${dateTile(e.date)}
          <div class="row-main">
            <div class="row-title">${esc(e.name)}</div>
            <div class="row-sub">${e.state === 'due' ? 'Due ' : ''}${esc(relativeDay(e.date))}</div>
          </div>
          <div class="row-end"><span class="amount ${e.type === 'income' ? 'income' : ''}">${e.type === 'income' ? '+' : ''}${esc(money(e.amount))}</span></div>
        </div>`).join('')}</div>`
        : empty('Nothing due', 'No recurring bills or paychecks in the next two weeks.')}
    </section>`;
}

function accountsCard(a, lastImport) {
  return `
    <section class="card card-flush">
      <div class="card-head">
        <div><h2>Accounts</h2><div class="card-sub">${lastImport ? `Last upload ${esc(timeAgo(lastImport.started_at))}` : 'No uploads yet'}</div></div>
        <button class="link-btn" type="button" data-nav="#/accounts">Manage</button>
      </div>
      ${a.accounts.length ? `
        <div class="rows">
          <div class="row"><div class="row-main"><div class="row-title">Net worth</div></div>
            <div class="row-end"><span class="amount">${esc(money(a.netWorth))}</span></div></div>
          ${a.accounts.filter((x) => !x.archived).map((x) => `
            <div class="row">
              <span class="emoji-tile" aria-hidden="true">${x.type === 'credit' ? '💳' : '🏦'}</span>
              <div class="row-main">
                <div class="row-title">${esc(x.name)}</div>
                <div class="row-sub">${x.mask ? `••${esc(x.mask)}` : esc(x.type || 'Account')}</div>
              </div>
              <div class="row-end"><span class="amount">${x.balance == null ? '—' : esc(money(x.balance))}</span></div>
            </div>`).join('')}
        </div>`
        : `<div class="empty"><button class="btn btn-primary" type="button" data-action="upload">${icon('upload')}Upload statement</button></div>`}
    </section>`;
}

function goalsCard(goals) {
  return `
    <section class="card">
      <div class="card-head"><h2>Goals</h2><button class="link-btn" type="button" data-nav="#/goals">All goals</button></div>
      ${goals.slice(0, 3).map((g) => `
        <div class="budget-line">
          <div class="split"><span class="truncate strong">${esc(g.name)}</span>
            <span class="small"><strong>${esc(money(g.current))}</strong> <span class="muted">of ${esc(money(g.target_amount))}</span></span></div>
          ${meter(g.percent / 100, g.kind === 'limit' && !g.onPace ? 'over' : '')}
        </div>`).join('')}
    </section>`;
}
