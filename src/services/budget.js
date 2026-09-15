'use strict';
const db = require('../db');
const { estimateMonthlyIncome } = require('./detect');
const { KIND_SQL, FROM_SQL } = require('./transactions');
const { round2, sum } = require('../utils/money');
const { prettyMerchant } = require('../utils/merchant');
const {
  monthRange, currentMonthKey, shiftMonth, monthProgress,
  toISODate, monthsBetween, daysBetween, addDays,
} = require('../utils/dates');

// Budget, cash flow, spending pace and goals. Amounts are net within a
// category: a refund in Shopping reduces Shopping rather than counting as
// income.

const LIVE = 't.excluded = false AND a.archived = false';

async function categoryTree(q = db) {
  const groups = await q.many(
    'SELECT id, name, kind, sort_order FROM category_groups ORDER BY sort_order, id'
  );
  const categories = await q.many(
    `SELECT c.id, c.name, c.emoji, c.kind, c.group_id, c.is_system, c.sort_order,
            COUNT(t.id)::int AS transaction_count
       FROM categories c LEFT JOIN transactions t ON t.category_id = c.id
      GROUP BY c.id
      ORDER BY c.sort_order, c.name`
  );
  return groups.map((g) => ({
    ...g,
    categories: categories.filter((c) => c.group_id === g.id),
  }));
}

/**
 * The month's budget: every category with its budget (the latest row at or
 * before this month), actual, and remaining, rolled up into groups.
 */
async function budgetMonth(monthKeyArg, q = db) {
  const month = monthKeyArg || currentMonthKey();
  const { start, end } = monthRange(month);

  const categories = await q.many(
    `SELECT c.id, c.name, c.emoji, c.kind, c.group_id, b.amount AS budget, b.month AS budget_from
       FROM categories c
       LEFT JOIN LATERAL (
         SELECT amount, month FROM budgets
          WHERE category_id = c.id AND month <= $1::date
          ORDER BY month DESC LIMIT 1
       ) b ON true
      ORDER BY c.sort_order, c.name`,
    [start]
  );
  const groups = await q.many('SELECT id, name, kind FROM category_groups ORDER BY sort_order, id');
  const actuals = await q.many(
    `SELECT t.category_id, SUM(t.amount) AS net, COUNT(*)::int AS n
       ${FROM_SQL}
      WHERE ${LIVE} AND t.posted_on BETWEEN $1 AND $2
      GROUP BY t.category_id`,
    [start, end]
  );
  const byCategory = new Map(actuals.map((r) => [r.category_id, r]));

  const rows = categories.map((c) => {
    const a = byCategory.get(c.id) || { net: 0, n: 0 };
    const net = Number(a.net) || 0;
    const actual = round2(c.kind === 'income' ? net : -net);
    const budget = c.budget == null ? null : round2(c.budget);
    return {
      id: c.id,
      name: c.name,
      emoji: c.emoji,
      kind: c.kind,
      groupId: c.group_id,
      budget,
      budgetFrom: c.budget_from,
      actual,
      remaining: budget == null ? null : round2(budget - actual),
      transactionCount: a.n,
    };
  });

  const groupRows = groups
    .map((g) => {
      const items = rows.filter((r) => r.groupId === g.id);
      const budgeted = items.filter((r) => r.budget != null);
      const budget = budgeted.length ? round2(sum(budgeted.map((r) => r.budget))) : null;
      const actual = round2(sum(items.map((r) => r.actual)));
      return {
        id: g.id,
        name: g.name,
        kind: g.kind,
        budget,
        actual,
        remaining: budget == null ? null : round2(budget - actual),
        categories: items,
      };
    })
    .filter((g) => g.categories.length && g.kind !== 'transfer');

  const of = (kind, withBudget) => rows.filter((r) => r.kind === kind && (!withBudget || r.budget != null));
  const incomeBudget = of('income', true).length ? round2(sum(of('income', true).map((r) => r.budget))) : null;
  const { detected } = await estimateMonthlyIncome(q);
  const plannedIncome = incomeBudget != null ? incomeBudget : detected;
  const expenseBudget = round2(sum(of('spending', true).map((r) => r.budget)));
  const expenseActual = round2(sum(of('spending').map((r) => r.actual)));

  return {
    month,
    range: { start, end },
    progress: round2(monthProgress(month)),
    summary: {
      income: {
        planned: plannedIncome,
        budgeted: incomeBudget,
        detected,
        actual: round2(sum(of('income').map((r) => r.actual))),
      },
      expenses: {
        budgeted: expenseBudget,
        actual: expenseActual,
        remaining: round2(expenseBudget - expenseActual),
      },
      leftToBudget: round2(plannedIncome - expenseBudget),
    },
    groups: groupRows,
  };
}

/** Set a category's budget from `month` onward; null removes that month's row. */
async function setBudget(categoryId, month, amount, q = db) {
  const start = monthRange(month).start;
  if (amount == null || amount === '') {
    await q.query('DELETE FROM budgets WHERE category_id = $1 AND month = $2', [categoryId, start]);
    return;
  }
  await q.query(
    `INSERT INTO budgets (category_id, month, amount) VALUES ($1, $2, $3)
     ON CONFLICT (category_id, month) DO UPDATE SET amount = EXCLUDED.amount, updated_at = now()`,
    [categoryId, start, round2(Number(amount))]
  );
}

/** Income, expenses and savings per month, oldest first. */
async function cashFlow({ months = 12, endMonth } = {}, q = db) {
  const last = endMonth || currentMonthKey();
  const first = shiftMonth(last, -(months - 1));
  const start = monthRange(first).start;
  const end = monthRange(last).end;

  const rows = await q.many(
    `SELECT to_char(date_trunc('month', t.posted_on), 'YYYY-MM') AS month,
            COALESCE(SUM(t.amount) FILTER (WHERE ${KIND_SQL} = 'income'), 0) AS income,
            COALESCE(-SUM(t.amount) FILTER (WHERE ${KIND_SQL} = 'spending'), 0) AS expenses
       ${FROM_SQL}
      WHERE ${LIVE} AND t.posted_on BETWEEN $1 AND $2
      GROUP BY 1`,
    [start, end]
  );
  const byMonth = new Map(rows.map((r) => [r.month, r]));

  const series = [];
  for (let i = 0; i < months; i += 1) {
    const m = shiftMonth(first, i);
    const r = byMonth.get(m) || { income: 0, expenses: 0 };
    const income = round2(r.income);
    const expenses = round2(r.expenses);
    series.push({
      month: m,
      income,
      expenses,
      savings: round2(income - expenses),
      savingsRate: income > 0 ? round2(((income - expenses) / income) * 100) : null,
    });
  }

  const income = round2(sum(series.map((s) => s.income)));
  const expenses = round2(sum(series.map((s) => s.expenses)));
  return {
    range: { start, end, first, last },
    series,
    totals: {
      income,
      expenses,
      savings: round2(income - expenses),
      savingsRate: income > 0 ? round2(((income - expenses) / income) * 100) : null,
    },
  };
}

/** Totals by category, group or merchant for income or spending in a range. */
async function breakdown({ start, end, by = 'category', kind = 'spending' }, q = db) {
  const sign = kind === 'income' ? '' : '-';
  const dims = {
    group: { select: 'g.id AS id, g.name AS name, NULL::text AS emoji', groupBy: 'g.id, g.name' },
    merchant: { select: 't.merchant_key AS id, t.merchant_key AS name, NULL::text AS emoji', groupBy: 't.merchant_key' },
    category: { select: 'c.id AS id, c.name AS name, c.emoji AS emoji', groupBy: 'c.id, c.name, c.emoji' },
  };
  const dim = dims[by] || dims.category;

  const rows = await q.many(
    `SELECT ${dim.select}, ${sign}SUM(t.amount) AS value, COUNT(*)::int AS count
       ${FROM_SQL}
      WHERE ${LIVE} AND ${KIND_SQL} = $3 AND t.posted_on BETWEEN $1 AND $2
      GROUP BY ${dim.groupBy}
      ORDER BY value DESC`,
    [start, end, kind]
  );

  const items = rows
    .map((r) => ({
      id: r.id,
      name: by === 'merchant' ? prettyMerchant(r.name) : (r.name || 'Uncategorized'),
      emoji: r.emoji,
      value: round2(r.value),
      count: r.count,
    }))
    .filter((r) => r.value > 0);
  return { by, kind, start, end, items, total: round2(sum(items.map((i) => i.value))) };
}

/** Cumulative daily spending for a month and the month before it. */
async function spendingPace(monthKeyArg, q = db) {
  const month = monthKeyArg || currentMonthKey();
  const previousMonth = shiftMonth(month, -1);
  const current = monthRange(month);
  const previous = monthRange(previousMonth);

  const rows = await q.many(
    `SELECT t.posted_on AS day, -SUM(t.amount) AS spent
       ${FROM_SQL}
      WHERE ${LIVE} AND ${KIND_SQL} = 'spending' AND t.posted_on BETWEEN $1 AND $2
      GROUP BY t.posted_on`,
    [previous.start, current.end]
  );
  const daily = new Map(rows.map((r) => [r.day, Number(r.spent) || 0]));
  const today = toISODate(new Date());

  const cumulative = (range, stopAfter) => {
    const out = [];
    let total = 0;
    const days = daysBetween(range.start, range.end) + 1;
    for (let i = 0; i < days; i += 1) {
      const date = addDays(range.start, i);
      if (stopAfter && date > stopAfter) break;
      total += daily.get(date) || 0;
      out.push({ day: i + 1, date, total: round2(total) });
    }
    return out;
  };

  return {
    month,
    previousMonth,
    daysInMonth: daysBetween(current.start, current.end) + 1,
    current: cumulative(current, today),
    previous: cumulative(previous),
  };
}

/**
 * Goal progress. `save` and `payoff` goals accrue from logged contributions;
 * `limit` goals measure a category's net spending this month against a cap.
 */
async function goalProgress(goal, month = currentMonthKey(), q = db) {
  const today = toISODate(new Date());
  const target = round2(Number(goal.target_amount));
  let current;

  if (goal.kind === 'limit' && goal.category_id) {
    const { start, end } = monthRange(month);
    const row = await q.one(
      `SELECT COALESCE(-SUM(t.amount), 0) AS spent
         FROM transactions t
        WHERE t.category_id = $1 AND t.excluded = false
          AND t.posted_on BETWEEN $2 AND $3`,
      [goal.category_id, start, end]
    );
    current = round2(Math.max(0, Number(row.spent)));
  } else {
    const row = await q.one(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM goal_contributions WHERE goal_id = $1',
      [goal.id]
    );
    current = round2(Number(goal.starting_amount) + Number(row.total));
  }

  const remaining = round2(Math.max(0, target - current));
  const percent = target > 0 ? round2(Math.min(100, (current / target) * 100)) : 0;

  let monthsRemaining = null;
  let requiredMonthly = null;
  let onPace = null;
  let paceTarget = null;

  if (goal.kind === 'limit') {
    onPace = current <= target;
  } else if (goal.target_date) {
    const targetIso = toISODate(goal.target_date);
    monthsRemaining = round2(monthsBetween(today, targetIso));
    requiredMonthly = monthsRemaining > 0 ? round2(remaining / monthsRemaining) : remaining;

    // Where even progress from creation to the target date would put you today.
    const createdIso = toISODate(goal.created_at);
    const totalMonths = monthsBetween(createdIso, targetIso);
    if (totalMonths > 0) {
      const fraction = Math.min(1, monthsBetween(createdIso, today) / totalMonths);
      const startAmount = Number(goal.starting_amount);
      paceTarget = round2(startAmount + (target - startAmount) * fraction);
      onPace = current >= paceTarget;
    }
  }

  return {
    ...goal,
    target_amount: target,
    starting_amount: round2(Number(goal.starting_amount)),
    current,
    remaining,
    percent,
    monthsRemaining,
    requiredMonthly,
    paceTarget,
    onPace,
    achieved: goal.kind === 'limit' ? current <= target : current >= target,
  };
}

async function allGoalProgress(month, q = db) {
  const goals = await q.many(
    `SELECT g.*, c.name AS category_name, c.emoji AS category_emoji
       FROM goals g LEFT JOIN categories c ON c.id = g.category_id
      WHERE g.status <> 'archived'
      ORDER BY g.status, g.target_date NULLS LAST, g.id`
  );
  const out = [];
  for (const g of goals) out.push(await goalProgress(g, month, q));
  return out;
}

module.exports = {
  categoryTree, budgetMonth, setBudget, cashFlow, breakdown, spendingPace,
  goalProgress, allGoalProgress,
};
