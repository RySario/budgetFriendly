import { get } from '../api.js';
import {
  esc, money, monthLabel, monthShort, currentMonthKey, shortDate, relativeDay, plural,
} from '../format.js';
import { icon, monthSwitcher, avatar, amount, meter, empty, dateTile } from '../ui.js';
import { lineChart, legend } from '../charts.js';
import { openTransaction } from './transactions.js';
import { spendSummary } from './plan.js';

// The everyday overview, kept short on purpose: what's left to spend, three
// headline numbers, the month's spending pace, and what's coming up. Budgets,
// accounts and the rest are one tap away instead of stacked here.

export default async function render(ctx) {
  const { view, state } = ctx;
  ctx.setActions(monthSwitcher(state.month));

  const d = await get('/dashboard', { month: state.month });
  if (!d.accounts.accounts.length) {
    view.innerHTML = welcome();
    return;
  }

  const isCurrent = state.month === currentMonthKey();
  const { current, previous, previousMonth, daysInMonth } = d.pace;
  const spent = current.length ? current[current.length - 1].total : 0;
  const compareDay = isCurrent ? Math.min(current.length, previous.length) : previous.length;
  const previousAt = compareDay ? previous[compareDay - 1].total : 0;
  const delta = spent - previousAt;
  const visibleAccounts = d.accounts.accounts.filter((a) => !a.archived).length;

  view.innerHTML = `
    ${d.reviewCount ? `
      <div class="banner">
        ${icon('alert')}
        <div class="grow">${plural(d.reviewCount, 'new transaction')} to review</div>
        <button class="btn btn-sm" type="button" data-nav="#/transactions?review=1">Review</button>
      </div>` : ''}

    <div class="grid grid-main">
      <div class="grid">
        ${isCurrent ? spendCard(d.plan) : ''}
        <div class="tiles">
          ${tile({
            label: isCurrent ? 'Spent this month' : `Spent in ${monthShort(state.month)}`,
            value: money(spent, { whole: true }),
            sub: spent || previousAt
              ? `<span class="${delta <= 0 ? 'good-text' : 'bad-text'}">${esc(money(Math.abs(delta), { whole: true }))} ${delta <= 0 ? 'less' : 'more'}</span> than ${esc(monthShort(previousMonth))}`
              : 'Nothing yet',
            nav: '#/cashflow',
          })}
          ${budgetTile(d.budget.summary)}
          ${tile({
            label: 'Net worth',
            value: money(d.accounts.netWorth, { whole: true }),
            sub: esc(plural(visibleAccounts, 'account')),
            nav: '#/accounts',
          })}
        </div>
        <section class="card">
          <div class="card-head">
            <div>
              <h2>Spending pace</h2>
              <div class="card-sub">${isCurrent ? 'This month, day by day' : esc(monthLabel(state.month))}</div>
            </div>
            <button class="link-btn" type="button" data-nav="#/cashflow">Cash flow</button>
          </div>
          ${legend([
            { label: isCurrent ? 'This month' : esc(monthShort(state.month)), color: 'var(--accent)' },
            { label: esc(monthShort(previousMonth)), color: 'var(--series-muted)' },
          ])}
          <div id="pace-chart"></div>
        </section>
      </div>

      <div class="grid">
        ${upcomingCard(d.upcoming.entries)}
        <section class="card card-flush">
          <div class="card-head">
            <h2>Recent transactions</h2>
            <button class="link-btn" type="button" data-nav="#/transactions">View all</button>
          </div>
          ${d.recent.length
            ? `<div class="rows">${d.recent.slice(0, 5).map(txnRow).join('')}</div>`
            : empty('No transactions yet', 'Upload a statement to see them here.')}
        </section>
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
    height: 170,
  }));

  view.addEventListener('click', (e) => {
    const row = e.target.closest('[data-txn]');
    if (row) openTransaction(ctx, Number(row.dataset.txn), { onChange: () => { ctx.refreshBadges(); ctx.rerender(); } });
  });
}

function spendCard(plan) {
  if (!plan || !plan.ready) {
    return `
      <section class="card hero-card">
        <div class="eyebrow">Left to spend</div>
        <h2 class="hero-title">How much can I spend before payday?</h2>
        <p class="ink-2" style="margin-top:6px">Set up your paycheck plan to see what's safe to spend while still paying your bills and reaching your goals.</p>
        <button class="btn btn-primary" type="button" data-nav="#/plan" style="margin-top:16px">${icon('wallet')}Set up paycheck plan</button>
      </section>`;
  }
  return `
    <section class="card hero-card">
      <div class="card-head" style="margin-bottom:0">
        <div class="eyebrow">Left to spend · payday ${esc(shortDate(plan.period.nextPayday))}</div>
        <button class="link-btn" type="button" data-nav="#/plan">Paycheck plan</button>
      </div>
      ${spendSummary(plan)}
      ${plan.goalsDelayed ? `<p class="plan-note warn-text">${icon('clock', 15)} ${plan.isCustom
        ? 'Your spending budget pushes a goal back.'
        : 'Your goals need more than is left after bills.'}</p>` : ''}
    </section>`;
}

function tile({ label, value, sub, nav, tone = '' }) {
  return `
    <button class="tile" type="button" data-nav="${nav}">
      <span class="tile-label">${esc(label)}</span>
      <span class="tile-value ${tone}">${esc(value)}</span>
      <span class="tile-sub">${sub}</span>
    </button>`;
}

function budgetTile(s) {
  if (!s.expenses.budgeted) {
    return tile({ label: 'Budget', value: 'Not set', sub: 'Set one up', nav: '#/budget' });
  }
  const over = s.expenses.actual > s.expenses.budgeted;
  return tile({
    label: over ? 'Over budget' : 'Budget left',
    value: money(Math.abs(s.expenses.remaining), { whole: true }),
    sub: `of ${esc(money(s.expenses.budgeted, { whole: true }))}`,
    nav: '#/budget',
    tone: over ? 'bad-text' : '',
  });
}

function welcome() {
  return `
    <section class="card welcome">
      <span class="welcome-mark" aria-hidden="true">${icon('wallet')}</span>
      <h2>Welcome to BudgetFriendly</h2>
      <p class="ink-2">Upload a statement and the app sorts your spending, finds your paycheck and bills, and tells you how much you can spend before payday.</p>
      <ol class="steps">
        <li>In Golden 1 online banking, open your checking account and click the download icon.</li>
        <li>Choose <strong>OFX</strong> and the longest date range it offers.</li>
        <li>Upload the file here.</li>
      </ol>
      <div class="welcome-actions">
        <button class="btn btn-primary" type="button" data-action="upload">${icon('upload')}Upload statement</button>
        <button class="btn" type="button" data-action="tour">${icon('help')}Take the tour</button>
      </div>
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

function upcomingCard(entries) {
  return `
    <section class="card card-flush">
      <div class="card-head">
        <div><h2>Coming up</h2><div class="card-sub">Next 14 days</div></div>
        <button class="link-btn" type="button" data-nav="#/recurring">Recurring</button>
      </div>
      ${entries.length ? `<div class="rows">${entries.slice(0, 5).map((e) => `
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
