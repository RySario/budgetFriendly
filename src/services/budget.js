'use strict';
const db = require('../db');
const { estimateMonthlyIncome } = require('./detect');
const { round2, sum } = require('../utils/money');
const {
  monthRange, currentMonthKey, shiftMonth, monthProgress,
  toISODate, monthsBetween,
} = require('../utils/dates');

// Everything the monthly view needs: income vs. spending by category, what is
// left to allocate, pace against budgets, and pace against goals.

async function monthlySummary(monthKeyArg) {
  const month = monthKeyArg || currentMonthKey();
  const { start, end } = monthRange(month);
  const progress = monthProgress(month);

  const categories = await db.many(
    `SELECT id, name, kind, color, monthly_budget, sort_order
       FROM categories ORDER BY sort_order, name`
  );

  const totals = await db.many(
    `SELECT t.category_id,
            SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END) AS spent,
            SUM(CASE WHEN t.amount > 0 THEN  t.amount ELSE 0 END) AS received,
            COUNT(*)::int AS txn_count
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.posted_on BETWEEN $1 AND $2
        AND t.excluded = false
        AND a.archived = false
      GROUP BY t.category_id`,
    [start, end]
  );
  const byCategory = new Map(totals.map((r) => [r.category_id, r]));

  const income = await estimateMonthlyIncome();

  const rows = categories.map((c) => {
    const t = byCategory.get(c.id) || { spent: 0, received: 0, txn_count: 0 };
    const spent = round2(Number(t.spent) || 0);
    const received = round2(Number(t.received) || 0);
    const budget = c.monthly_budget == null ? null : round2(Number(c.monthly_budget));
    const remaining = budget == null ? null : round2(budget - spent);
    // "On pace" compares spend-so-far against how far through the month we are.
    const paceTarget = budget == null ? null : round2(budget * progress);
    return {
      id: c.id,
      name: c.name,
      kind: c.kind,
      color: c.color,
      budget,
      spent,
      received,
      remaining,
      transactionCount: t.txn_count,
      percentUsed: budget ? round2((spent / budget) * 100) : null,
      paceTarget,
      overPace: paceTarget != null ? spent > paceTarget : null,
      overBudget: budget != null ? spent > budget : null,
    };
  });

  const spendingRows = rows.filter((r) => r.kind === 'spending');
  const incomeRows = rows.filter((r) => r.kind === 'income');

  const actualIncome = round2(sum(incomeRows.map((r) => r.received)));
  const totalSpent = round2(sum(spendingRows.map((r) => r.spent)));
  const totalBudgeted = round2(sum(spendingRows.map((r) => r.budget || 0)));

  const effectiveIncome = income.effective || actualIncome;
  const leftToAllocate = round2(effectiveIncome - totalBudgeted);
  const leftToSpend = round2(effectiveIncome - totalSpent);

  // Straight-line projection of this month's spend from the pace so far.
  const projectedSpend = progress > 0.05 ? round2(totalSpent / progress) : null;

  return {
    month,
    range: { start, end },
    progress: round2(progress),
    income: {
      estimatedMonthly: income.effective,
      detectedMonthly: income.detected,
      manualOverride: income.manual,
      isOverridden: income.isOverridden,
      actualThisMonth: actualIncome,
      sources: income.sources.map((s) => ({
        id: s.id,
        name: s.name,
        amount: round2(Number(s.amount)),
        cadence: s.cadence,
        monthlyAmount: round2(Number(s.monthly_amount)),
        status: s.status,
        confidence: Number(s.confidence),
        nextExpectedOn: toISODate(s.next_expected_on),
      })),
    },
    spending: {
      total: totalSpent,
      budgeted: totalBudgeted,
      leftToAllocate,
      leftToSpend,
      projected: projectedSpend,
      projectedOverBudget: projectedSpend != null && totalBudgeted > 0
        ? projectedSpend > totalBudgeted
        : null,
      savingsRate: effectiveIncome > 0
        ? round2(((effectiveIncome - totalSpent) / effectiveIncome) * 100)
        : null,
    },
    categories: rows,
    unbudgetedCategories: spendingRows.filter((r) => r.budget == null && r.spent > 0),
  };
}

/** Month-over-month totals for the trend chart. */
async function monthlyTrend(months = 6) {
  const out = [];
  let key = currentMonthKey();
  for (let i = 0; i < months; i += 1) {
    const { start, end } = monthRange(key);
    const row = await db.one(
      `SELECT COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) AS spent,
              COALESCE(SUM(CASE WHEN t.amount > 0 THEN  t.amount ELSE 0 END), 0) AS received
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.posted_on BETWEEN $1 AND $2
          AND t.excluded = false
          AND a.archived = false`,
      [start, end]
    );
    out.unshift({
      month: key,
      spent: round2(Number(row.spent)),
      received: round2(Number(row.received)),
      net: round2(Number(row.received) - Number(row.spent)),
    });
    key = shiftMonth(key, -1);
  }
  return out;
}

/**
 * Goal progress. `save` goals accrue from explicit contributions; `limit` goals
 * measure spend in a category against a ceiling.
 */
async function goalProgress(goal, month = currentMonthKey()) {
  const today = toISODate(new Date());
  const target = round2(Number(goal.target_amount));
  let current;

  if (goal.kind === 'limit' && goal.category_id) {
    const { start, end } = monthRange(month);
    const row = await db.one(
      `SELECT COALESCE(SUM(-t.amount), 0) AS spent
         FROM transactions t
        WHERE t.category_id = $1 AND t.amount < 0
          AND t.excluded = false
          AND t.posted_on BETWEEN $2 AND $3`,
      [goal.category_id, start, end]
    );
    current = round2(Number(row.spent));
  } else {
    const row = await db.one(
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

  if (goal.target_date) {
    const targetIso = toISODate(goal.target_date);
    monthsRemaining = round2(monthsBetween(today, targetIso));
    requiredMonthly = monthsRemaining > 0
      ? round2(remaining / monthsRemaining)
      : remaining;

    // Expected progress if contributions had been even from creation to target.
    const createdIso = toISODate(goal.created_at);
    const totalMonths = monthsBetween(createdIso, targetIso);
    const elapsed = monthsBetween(createdIso, today);
    if (totalMonths > 0) {
      const fraction = Math.min(1, elapsed / totalMonths);
      paceTarget = round2(Number(goal.starting_amount) + (target - Number(goal.starting_amount)) * fraction);
      onPace = goal.kind === 'limit' ? current <= paceTarget : current >= paceTarget;
    }
    if (goal.kind === 'limit') {
      onPace = current <= target;
      requiredMonthly = null;
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

async function allGoalProgress(month) {
  const goals = await db.many(
    `SELECT g.*, c.name AS category_name, c.color AS category_color
       FROM goals g LEFT JOIN categories c ON c.id = g.category_id
      WHERE g.status <> 'archived'
      ORDER BY g.status, g.target_date NULLS LAST, g.id`
  );
  return Promise.all(goals.map((g) => goalProgress(g, month)));
}

module.exports = { monthlySummary, monthlyTrend, goalProgress, allGoalProgress };
