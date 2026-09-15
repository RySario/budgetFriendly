import { get, patch } from '../api.js';
import { esc, money, longDate, shortDate, relativeDay, cadenceLabel, plural } from '../format.js';
import { icon, meter, empty, openDrawer, toast, dateTile, segmented } from '../ui.js';

// The paycheck plan: what's left to spend before payday, how the recommended
// amount is worked out, and what a custom amount does to each goal. Typing a
// custom amount previews its effect without saving it.

const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

export default async function render(ctx) {
  const { view } = ctx;
  const p = await get('/plan');
  ctx.setActions(`<button class="btn btn-sm" type="button" data-edit-paycheck>${p.ready ? 'Edit paycheck' : 'Add paycheck'}</button>`);
  ctx.setHeaderHandler((e) => { if (e.target.closest('[data-edit-paycheck]')) paycheckDrawer(ctx, p); });

  if (!p.ready) {
    view.innerHTML = `
      <section class="card">${empty('Add your paycheck',
        'Your paycheck is found automatically once you have uploaded about three months of statements. Until then, enter it here to get a spending budget for each payday.',
        `<button class="btn btn-primary" type="button" data-edit-paycheck>${icon('plus')}Add paycheck</button>`)}</section>`;
    view.addEventListener('click', (e) => { if (e.target.closest('[data-edit-paycheck]')) paycheckDrawer(ctx, p); });
    return;
  }

  view.innerHTML = `
    <section class="card">
      <div class="card-head">
        <div><h2>Left to spend</h2>
          <div class="card-sub">Until payday ${esc(shortDate(p.period.nextPayday))}, ${esc(relativeDay(p.period.nextPayday))}</div></div>
        <span class="chip ${p.isCustom ? '' : 'accent'}">${p.isCustom ? 'Your budget' : 'Recommended budget'}</span>
      </div>
      ${spendSummary(p)}
    </section>
    <div class="grid grid-main">
      <div class="grid">
        ${planCard(p)}
        <section class="card card-flush" data-goal-impact>${goalsSection(p)}</section>
      </div>
      <div class="grid">
        ${dueCard(p)}
        ${billsCard(p)}
      </div>
    </div>`;

  wireChooser(ctx, view, p);
}

/** Left-to-spend figure, daily pace and meter. Shared with the dashboard card. */
export function spendSummary(p) {
  const over = p.left < 0;
  const fraction = p.budget > 0 ? p.spent / p.budget : p.spent > 0 ? 1 : 0;
  return `
    <div class="hero-value ${over ? 'bad-text' : ''}">${over ? `−${esc(money(-p.left))}` : esc(money(p.left))}</div>
    <p class="small" style="margin:4px 0 12px">${over
      ? `<span class="bad-text strong">${esc(money(-p.left))} over this paycheck's budget</span>`
      : `About <strong>${esc(money(p.perDay))} a day</strong> <span class="muted">for ${esc(plural(p.period.daysLeft, 'day'))}</span>`}</p>
    ${meter(fraction, over ? 'over' : '')}
    <div class="split small" style="margin:8px 0 0">
      <span class="muted">${esc(money(p.spent))} spent since ${esc(shortDate(p.period.start))}</span>
      <span class="muted">of ${esc(money(p.budget))}</span>
    </div>`;
}

function planCard(p) {
  const pay = p.paycheck;
  const others = pay.sources.length - 1;
  const source = pay.source === 'manual'
    ? 'Entered by you'
    : `Detected from ${esc(pay.name)}${others > 0 ? ` and ${esc(plural(others, 'other source'))}` : ''}`;

  return `
    <section class="card">
      <div class="card-head"><div><h2>Each paycheck</h2>
        <div class="card-sub">${esc(cadenceLabel(pay.cadence))} · ${source}</div></div></div>
      <div class="plan-lines">
        <div class="plan-line"><span>Paycheck</span><span class="good-text">+${esc(money(p.income))}</span></div>
        <div class="plan-line"><span>Bills <span class="muted small">${esc(plural(p.billItems.length, 'recurring bill'))}, averaged</span></span><span>−${esc(money(p.bills))}</span></div>
        <div class="plan-line"><span>Goals <span class="muted small">to finish on time</span></span><span>−${esc(money(p.goalNeed))}</span></div>
        <div class="plan-line plan-total"><span>Recommended to spend</span><span>${esc(money(p.recommended))}</span></div>
      </div>
      ${p.shortfall > 0 ? `<p class="small bad-text" style="margin-top:10px">Your goals need ${esc(money(p.shortfall))} more each paycheck than is left after bills. Move a target date later or lower a target to make the plan work.</p>` : ''}
      ${p.typical != null ? `<p class="small muted" style="margin-top:10px">Over the last three months you spent about ${esc(money(p.typical))} a paycheck, not counting bills.</p>` : ''}

      <div class="plan-choose">
        <div class="kpi-label" style="margin-bottom:8px">Your spending budget</div>
        ${segmented('budget-mode', [['recommended', 'Recommended'], ['custom', 'Custom']], p.isCustom ? 'custom' : 'recommended')}
        <label class="field" data-custom ${p.isCustom ? '' : 'hidden'} style="margin:12px 0 0">
          <span class="field-label">Spend per paycheck</span>
          <span class="money-input"><input type="text" inputmode="decimal" name="spend" value="${p.budget}"></span>
        </label>
        <div class="plan-impact" data-impact aria-live="polite">${impact(p)}</div>
        <div class="goal-actions" data-save-row hidden>
          <button class="btn btn-primary btn-sm" type="button" data-save-budget>Use this budget</button>
          <button class="btn btn-sm" type="button" data-reset>Cancel</button>
        </div>
      </div>
    </section>`;
}

const planned = (p) => p.goals.filter((g) => g.required > 0);
const isDelayed = (g) => g.projectedDate == null || g.shiftDays > 3;
const isSooner = (g) => g.projectedDate != null && g.shiftDays < -3;

/** Plain-language effect of the budget being shown (saved or previewed) on goals. */
function impact(p) {
  const parts = [];
  if (p.overPaycheck > 0) {
    parts.push(`<p class="bad-text">That's ${esc(money(p.overPaycheck))} more than your paycheck has left after bills, so it would come out of savings.</p>`);
  }
  const goals = planned(p);
  if (!goals.length) {
    parts.push('<p class="muted">No goals have a target date, so nothing is set aside for them. Add a date to a goal to include it.</p>');
    return parts.join('');
  }

  const onPlan = !p.isCustom || Math.abs(p.difference) < 0.5;
  if (onPlan) {
    parts.push(p.shortfall > 0
      ? `<p class="warn-text">Even at this budget, only ${esc(money(p.toGoals))} of the ${esc(money(p.goalNeed))} your goals need is left each paycheck, so they finish later than planned.</p>`
      : `<p class="good-text">${icon('check', 15)} Every goal stays on schedule.</p>`);
  } else if (p.difference > 0) {
    parts.push(`<p><strong>${esc(money(p.difference))} more</strong> than recommended each paycheck leaves ${esc(money(p.toGoals))} for goals instead of ${esc(money(Math.min(p.goalNeed, p.afterBills)))}.</p>`);
  } else {
    parts.push(`<p><strong>${esc(money(-p.difference))} less</strong> than recommended each paycheck puts ${esc(money(p.toGoals))} toward goals, so they finish sooner.</p>`);
  }

  const moved = goals.filter((g) => isDelayed(g) || isSooner(g));
  if (moved.length) {
    parts.push(`<ul class="plan-moves">${moved.map((g) => `<li><strong>${esc(g.name)}</strong>: ${g.projectedDate
      ? `${esc(longDate(g.projectedDate))}, ${esc(shiftLabel(Math.abs(g.shiftDays)))} ${g.shiftDays > 0 ? 'later' : 'sooner'} than ${esc(longDate(g.plannedDate))}`
      : 'stops moving forward'}</li>`).join('')}</ul>`);
  }
  return parts.join('');
}

function goalsSection(p) {
  const goals = p.goals.filter((g) => g.plan !== 'done');
  const head = `
    <div class="card-head">
      <div><h2>Goals</h2><div class="card-sub">${p.isCustom ? `At ${esc(money(p.budget))} a paycheck` : 'At the recommended budget'}</div></div>
      <button class="link-btn" type="button" data-nav="#/goals">All goals</button>
    </div>`;
  if (!goals.length) {
    return head + empty('No goals to plan for', 'Add a savings or payoff goal with a target date, and part of each paycheck will go toward it.');
  }
  return `${head}<div class="rows">${goals.map(goalRow).join('')}</div>`;
}

function goalRow(g) {
  let sub;
  let chip;
  let end = '';
  if (g.plan === 'overdue') {
    sub = `${money(g.remaining)} to go · target date ${longDate(g.targetDate)} has passed`;
    chip = `<span class="chip warn">${icon('alert')}Choose a new date</span>`;
  } else if (g.plan === 'unplanned') {
    sub = `${money(g.remaining)} to go · no target date`;
    chip = '<span class="chip">Not in the plan</span>';
  } else {
    sub = `${money(g.remaining)} to go · ${g.plan === 'dated' ? `target ${longDate(g.targetDate)}` : `${money(g.monthlyContribution)} a month`}`;
    end = `<div class="row-end"><div class="amount">${esc(money(g.contribution))}</div><div class="tiny muted">a paycheck</div></div>`;
    if (g.projectedDate == null) chip = `<span class="chip bad">${icon('alert')}Stalled</span>`;
    else if (isDelayed(g)) chip = `<span class="chip warn">${icon('clock')}${esc(shiftLabel(g.shiftDays))} later</span>`;
    else if (isSooner(g)) chip = `<span class="chip good">${esc(shiftLabel(-g.shiftDays))} sooner</span>`;
    else chip = `<span class="chip good">${icon('check')}On schedule</span>`;
  }
  return `
    <div class="row">
      <span class="emoji-tile" aria-hidden="true">${icon('goals')}</span>
      <div class="row-main">
        <div class="row-title">${esc(g.name)}</div>
        <div class="row-sub">${esc(sub)}</div>
        <div class="plan-goal-status">${chip}${g.projectedDate ? `<span class="tiny muted">Done ${esc(longDate(g.projectedDate))}</span>` : ''}</div>
      </div>
      ${end}
    </div>`;
}

function dueCard(p) {
  const stateLabel = (b) => ({ paid: 'Paid', due: 'Due today', missed: 'Not found yet' }[b.state] || relativeDay(b.date));
  return `
    <section class="card card-flush">
      <div class="card-head">
        <div><h2>Bills this pay period</h2>
          <div class="card-sub">${esc(shortDate(p.period.start))} – ${esc(shortDate(p.period.end))}</div></div>
        <strong class="num">${esc(money(p.dueBillsTotal))}</strong>
      </div>
      ${p.dueBills.length ? `<div class="rows">${p.dueBills.map((b) => `
        <div class="row">
          ${dateTile(b.date)}
          <div class="row-main">
            <div class="row-title">${esc(b.name)}</div>
            <div class="row-sub ${b.state === 'paid' ? 'good-text' : ''}">${esc(stateLabel(b))}</div>
          </div>
          <div class="row-end"><span class="amount">${esc(money(b.amount))}</span></div>
        </div>`).join('')}</div>`
        : empty('No bills due', 'No recurring bills land before your next payday.')}
    </section>`;
}

function billsCard(p) {
  if (!p.billItems.length) return '';
  const shown = p.billItems.slice(0, 8);
  const rest = p.billItems.length - shown.length;
  return `
    <section class="card card-flush">
      <div class="card-head">
        <div><h2>Set aside for bills</h2><div class="card-sub">A share of each bill, every paycheck</div></div>
        <button class="link-btn" type="button" data-nav="#/recurring">Recurring</button>
      </div>
      <div class="rows">${shown.map((b) => `
        <div class="row">
          <span class="emoji-tile" aria-hidden="true">${esc(b.emoji || '🧾')}</span>
          <div class="row-main">
            <div class="row-title">${esc(b.name)}</div>
            <div class="row-sub">${esc(money(b.amount))} ${esc(cadenceLabel(b.cadence).toLowerCase())}</div>
          </div>
          <div class="row-end"><span class="amount">${esc(money(b.perPaycheck))}</span></div>
        </div>`).join('')}
        ${rest > 0 ? `<div class="row"><div class="row-main muted small">and ${esc(plural(rest, 'more bill'))}</div></div>` : ''}
      </div>
    </section>`;
}

function shiftLabel(days) {
  if (days < 14) return plural(days, 'day');
  if (days < 60) return plural(Math.round(days / 7), 'week');
  if (days < 730) return plural(Math.round(days / 30.4375), 'month');
  return `${(days / 365.25).toFixed(1).replace(/\.0$/, '')} years`;
}

function parseAmount(raw) {
  const s = String(raw).replace(/[$,\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function wireChooser(ctx, view, p) {
  const customField = view.querySelector('[data-custom]');
  const input = view.querySelector('input[name="spend"]');
  const impactEl = view.querySelector('[data-impact]');
  const goalsEl = view.querySelector('[data-goal-impact]');
  const saveRow = view.querySelector('[data-save-row]');
  let mode = p.isCustom ? 'custom' : 'recommended';
  let timer = null;
  let seq = 0;

  const changed = () => (mode === 'custom' ? !p.isCustom || parseAmount(input.value) !== p.budget : p.isCustom);

  const preview = () => {
    clearTimeout(timer);
    const amount = mode === 'custom' ? parseAmount(input.value) : 'recommended';
    saveRow.hidden = amount === null || !changed();
    if (amount === null) return;
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const next = await get('/plan', { spend: amount });
        if (mine !== seq) return;
        impactEl.innerHTML = impact(next);
        goalsEl.innerHTML = goalsSection(next);
      } catch (err) { toast(err.message, 'bad'); }
    }, 250);
  };
  ctx.onCleanup(() => clearTimeout(timer));

  const save = async () => {
    const amount = mode === 'custom' ? parseAmount(input.value) : null;
    if (mode === 'custom' && amount === null) { toast('Enter a dollar amount.', 'bad'); return; }
    try {
      await patch('/plan', { spendingBudget: amount });
      toast(amount === null ? 'Using the recommended budget' : 'Budget saved');
      ctx.rerender();
    } catch (err) { toast(err.message, 'bad'); }
  };

  view.addEventListener('click', (e) => {
    const seg = e.target.closest('[data-seg="budget-mode"]');
    if (seg) {
      mode = seg.dataset.value;
      view.querySelectorAll('[data-seg="budget-mode"]').forEach((b) => {
        b.classList.toggle('active', b === seg);
        b.setAttribute('aria-selected', String(b === seg));
      });
      customField.hidden = mode !== 'custom';
      if (mode === 'custom') input.focus();
      preview();
      return;
    }
    if (e.target.closest('[data-reset]')) { ctx.rerender(); return; }
    if (e.target.closest('[data-save-budget]')) save();
  });
  input.addEventListener('input', preview);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (changed()) save(); }
  });
}

function paycheckDrawer(ctx, p) {
  const current = p.ready ? p.paycheck : null;
  const manual = current && current.source === 'manual';
  const cadence = current && CADENCES.includes(current.cadence) ? current.cadence : 'biweekly';
  openDrawer({
    title: current ? 'Your paycheck' : 'Add your paycheck',
    body: `
      ${current && !manual ? `<p class="small muted" style="margin:0 0 14px">Found in your statements: ${esc(money(current.amount))} ${esc(cadenceLabel(current.cadence).toLowerCase())}. Enter your own if that isn't right.</p>` : ''}
      <form id="paycheck-form">
        <label class="field"><span class="field-label">Take-home pay per paycheck</span>
          <span class="money-input"><input type="text" inputmode="decimal" name="amount" required value="${current ? current.amount : ''}"></span>
          <span class="field-help">The amount that reaches your account, after taxes and deductions.</span></label>
        <div class="field-row">
          <label class="field"><span class="field-label">How often</span>
            <select name="cadence">${CADENCES.map((c) => `<option value="${c}" ${c === cadence ? 'selected' : ''}>${esc(cadenceLabel(c))}</option>`).join('')}</select></label>
          <label class="field"><span class="field-label">Next payday</span>
            <input type="date" name="nextPayday" required value="${current ? p.period.nextPayday : ''}"></label>
        </div>
      </form>`,
    footer: `${manual ? '<button class="btn" type="button" data-use-detected>Use detected pay</button>' : ''}
      <button class="btn btn-primary" type="button" data-save>Save</button>`,
    onMount(drawer, close) {
      const send = async (paycheck, message) => {
        try {
          await patch('/plan', { paycheck });
          close();
          toast(message);
          ctx.rerender();
        } catch (err) { toast(err.message, 'bad'); }
      };
      drawer.querySelector('[data-save]').addEventListener('click', () => {
        const f = new FormData(drawer.querySelector('#paycheck-form'));
        send({
          amount: parseAmount(f.get('amount')),
          cadence: f.get('cadence'),
          nextPayday: f.get('nextPayday'),
        }, 'Paycheck saved');
      });
      const detected = drawer.querySelector('[data-use-detected]');
      if (detected) detected.addEventListener('click', () => send(null, 'Using the paycheck from your statements'));
    },
  });
}
