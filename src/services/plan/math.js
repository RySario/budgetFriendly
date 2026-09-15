'use strict';
const { round2, sum } = require('../../utils/money');
const { daysBetween, addDays } = require('../../utils/dates');

// The paycheck plan's arithmetic, kept free of the database so it can be
// tested directly. Everything is per paycheck and averaged: a monthly rent
// counts the same share against every payday, so the recommended spending
// amount doesn't swing between the paycheck that covers rent and the one
// that doesn't.

const DAYS_PER_YEAR = 365.25;
const PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };

function paychecksPerYear(cadence, intervalDays) {
  return PER_YEAR[cadence] || DAYS_PER_YEAR / Math.max(1, Number(intervalDays) || 30);
}

/** A monthly amount expressed per paycheck. */
function perPaycheck(monthly, perYear) {
  return round2((Number(monthly) * 12) / perYear);
}

/**
 * What a goal needs from each paycheck to finish on its date. Goals without a
 * date use their monthly contribution if they have one; otherwise they are
 * left out of the plan.
 */
function goalRequirement(goal, today, perYear) {
  if (goal.achieved || !(goal.remaining > 0)) return { plan: 'done', required: 0 };
  if (goal.targetDate) {
    const days = daysBetween(today, goal.targetDate);
    if (days <= 0) return { plan: 'overdue', required: 0 };
    const paychecksLeft = Math.max(1, days / (DAYS_PER_YEAR / perYear));
    return { plan: 'dated', required: round2(goal.remaining / paychecksLeft) };
  }
  if (goal.monthlyContribution > 0) {
    return { plan: 'monthly', required: perPaycheck(goal.monthlyContribution, perYear) };
  }
  return { plan: 'unplanned', required: 0 };
}

/**
 * Recommended spending per paycheck, and what a chosen spending amount does to
 * each goal. Money left after bills and spending goes to goals in proportion to
 * what each one needs, so spending $100 over the recommendation takes $100 away
 * from goals, split between them.
 *
 * spend: the amount to plan with, or null for the recommendation.
 */
function buildPlan({ income, bills, goals, today, perYear, spend = null }) {
  const periodDays = DAYS_PER_YEAR / perYear;
  const planned = goals.map((g) => ({ ...g, ...goalRequirement(g, today, perYear) }));

  const goalNeed = round2(sum(planned.map((g) => g.required)));
  const afterBills = round2(income - bills);
  const recommended = round2(Math.max(0, afterBills - goalNeed));
  const budget = spend == null ? recommended : round2(Math.max(0, spend));
  const toGoals = round2(Math.max(0, afterBills - budget));
  const ratio = goalNeed > 0 ? toGoals / goalNeed : 0;

  const items = planned.map((g) => {
    if (!g.required) return { ...g, contribution: 0, plannedDate: null, projectedDate: null, shiftDays: null };
    const finish = (perCheck) => addDays(today, Math.round((g.remaining / perCheck) * periodDays));
    const plannedDate = finish(g.required);
    const contribution = round2(g.required * ratio);
    if (contribution <= 0) {
      return { ...g, contribution: 0, plannedDate, projectedDate: null, shiftDays: null };
    }
    const projectedDate = finish(contribution);
    return { ...g, contribution, plannedDate, projectedDate, shiftDays: daysBetween(plannedDate, projectedDate) };
  });

  return {
    income: round2(income),
    bills: round2(bills),
    afterBills,
    goalNeed,
    // How far goals outrun the paycheck even with nothing spent.
    shortfall: round2(Math.max(0, goalNeed - afterBills)),
    recommended,
    budget,
    isCustom: spend != null,
    difference: round2(budget - recommended),
    toGoals,
    // Spending more than is left after bills means dipping into savings.
    overPaycheck: round2(Math.max(0, budget - afterBills)),
    periodDays: round2(periodDays),
    goals: items,
  };
}

module.exports = { paychecksPerYear, perPaycheck, goalRequirement, buildPlan, DAYS_PER_YEAR };
