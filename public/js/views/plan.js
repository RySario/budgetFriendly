import { get, patch } from '../api.js';
import { esc, money, longDate, shortDate, relativeDay, cadenceLabel, plural } from '../format.js';
import { icon, meter, empty, openDrawer, toast, dateTile, segmented, markSegment } from '../ui.js';

// The paycheck plan: what's left to spend before payday and how that number is
// worked out. Changing the budget happens in a panel that previews what a new
// amount does to each goal before anything is saved. When no paycheck can be
// settled on, the page shows what it did find and lets you pick.

const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

export default async function render(ctx) {
  const { view } = ctx;
  const p = await get('/plan');
  ctx.setActions(`<button class="btn btn-sm" type="button" data-edit-paycheck>${icon('wallet')}${p.ready ? 'Edit paycheck' : 'Add paycheck'}</button>`);
  ctx.setHeaderHandler((e) => { if (e.target.closest('[data-edit-paycheck]')) paycheckDrawer(ctx, p); });

  view.innerHTML = p.ready ? readyView(p) : setupView(p);

  view.addEventListener('click', async (e) => {
    if (e.target.closest('[data-edit-paycheck]')) { paycheckDrawer(ctx, p); return; }
    if (e.target.closest('[data-change-budget]')) { budgetDrawer(ctx, p); return; }
    if (e.target.closest('[data-show-bills]')) { billsDrawer(p); return; }

    const use = e.target.closest('[data-use-candidate]');
    if (use) {
      paycheckDrawer(ctx, p, fromCandidate(p.diagnosis.candidates[Number(use.dataset.useCandidate)]));
      return;
    }

    const undo = e.target.closest('[data-undo-dismiss]');
    if (undo) {
      undo.disabled = true;
      try {
        await patch(`/recurring/income/${undo.dataset.undoDismiss}`, { status: 'confirmed' });
        toast('Marked as your paycheck');
        ctx.rerender();
      } catch (err) {
        toast(err.message, 'bad');
        undo.disabled = false;
      }
    }
  });
}

/** Left-to-spend figure, daily pace and meter. Shared with the dashboard card. */
export function spendSummary(p) {
  const over = p.left < 0;
  const fraction = p.budget > 0 ? p.spent / p.budget : p.spent > 0 ? 1 : 0;
  return `
    <div class="hero-value ${over ? 'bad-text' : ''}">${over ? `−${esc(money(-p.left))}` : esc(money(p.left))}</div>
    <p class="hero-sub">${over
      ? `<span class="bad-text strong">${esc(money(-p.left))} over this paycheck's budget</span>`
      : `About <strong>${esc(money(p.perDay))} a day</strong> for ${esc(plural(p.period.daysLeft, 'day'))}`}</p>
    ${meter(fraction, over ? 'over' : '')}
    <div class="split small hero-foot">
      <span class="muted">${esc(money(p.spent))} spent since ${esc(shortDate(p.period.start))}</span>
      <span class="muted">of ${esc(money(p.budget))}</span>
    </div>`;
}

// --- ready -----------------------------------------------------------------------

function readyView(p) {
  return `
    <section class="card hero-card">
      <div class="plan-hero">
        <div class="plan-hero-main">
          <div class="eyebrow">Left to spend · payday ${esc(shortDate(p.period.nextPayday))}, ${esc(relativeDay(p.period.nextPayday))}</div>
          ${spendSummary(p)}
          <div class="hero-actions">
            <button class="btn btn-primary" type="button" data-change-budget>${p.isCustom ? 'Change budget' : 'Set my own budget'}</button>
            <span class="chip ${p.isCustom ? '' : 'accent'}">${p.isCustom ? 'Your budget' : 'Recommended budget'}</span>
          </div>
        </div>
        ${breakdown(p)}
      </div>
    </section>

    <div class="grid grid-2">
      <section class="card card-flush">${goalsSection(p)}</section>
      ${dueCard(p)}
    </div>`;
}

function sourceLabel(pay) {
  if (pay.source === 'manual') {
    return pay.name && pay.name !== 'Your paycheck' ? `${pay.name}, entered by you` : 'Entered by you';
  }
  const others = pay.sources.length - 1;
  const from = `${pay.name}${others > 0 ? ` and ${plural(others, 'other')}` : ''}`;
  return pay.source === 'found' ? `Found in your deposits: ${from}` : `From ${from}`;
}

function breakdown(p) {
  return `
    <div class="plan-breakdown">
      <div class="eyebrow">Each paycheck · ${esc(cadenceLabel(p.paycheck.cadence).toLowerCase())}</div>
      <div class="plan-lines">
        <div class="plan-line">
          <span class="plan-line-label">Paycheck<span class="plan-line-sub">${esc(sourceLabel(p.paycheck))}</span></span>
          <span class="good-text">+${esc(money(p.income))}</span>
        </div>
        ${p.billItems.length ? `
          <button class="plan-line plan-line-btn" type="button" data-show-bills>
            <span class="plan-line-label">Bills<span class="plan-line-sub">${esc(plural(p.billItems.length, 'recurring bill'))}, averaged ${icon('right', 13)}</span></span>
            <span>−${esc(money(p.bills))}</span>
          </button>` : `
          <div class="plan-line">
            <span class="plan-line-label">Bills<span class="plan-line-sub">No recurring bills found</span></span>
            <span>${esc(money(0))}</span>
          </div>`}
        <div class="plan-line">
          <span class="plan-line-label">Goals<span class="plan-line-sub">${p.goalNeed ? 'To finish on time' : 'None with a target date'}</span></span>
          <span>${p.goalNeed ? '−' : ''}${esc(money(p.goalNeed))}</span>
        </div>
        <div class="plan-line plan-total"><span>Recommended to spend</span><span>${esc(money(p.recommended))}</span></div>
      </div>
      ${p.shortfall > 0 ? `<p class="plan-note bad-text">Your goals need ${esc(money(p.shortfall))} more each paycheck than is left after bills. Move a target date later or lower a target.</p>` : ''}
      ${p.typical != null ? `<p class="plan-note muted">Lately you've spent about ${esc(money(p.typical))} a paycheck, not counting bills.</p>` : ''}
    </div>`;
}

const isDelayed = (g) => g.projectedDate == null || g.shiftDays > 3;
const isSooner = (g) => g.projectedDate != null && g.shiftDays < -3;

/** Plain-language effect of the budget being shown (saved or previewed) on goals. */
function impact(p) {
  const parts = [];
  if (p.overPaycheck > 0) {
    parts.push(`<p class="bad-text">That's ${esc(money(p.overPaycheck))} more than your paycheck has left after bills, so it would come out of savings.</p>`);
  }
  const goals = p.goals.filter((g) => g.required > 0);
  if (!goals.length) {
    parts.push('<p class="muted">No goals have a target date, so nothing is set aside for them. Add a date to a goal to include it.</p>');
    return parts.join('');
  }

  if (!p.isCustom || Math.abs(p.difference) < 0.5) {
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
      <div><h2>Goals</h2><div class="card-sub">${p.isCustom ? `At your budget of ${esc(money(p.budget))}` : 'At the recommended budget'}</div></div>
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

// --- no paycheck yet ------------------------------------------------------------

function setupView(p) {
  const dx = p.diagnosis || { transactions: 0, candidates: [], dismissed: [] };
  const { candidates } = dx;
  const stale = candidates.filter((c) => c.strong && !c.active);
  const maybe = candidates.filter((c) => !(c.strong && !c.active));

  let intro;
  if (!dx.transactions) {
    intro = 'Upload a few months of statements and your paycheck is found automatically. Or enter it yourself to start now.';
  } else if (candidates.length || dx.dismissed.length) {
    intro = `We looked through ${plural(dx.transactions, 'transaction')} but couldn't confirm your paycheck on our own. Here's what we found.`;
  } else {
    intro = `We looked through ${plural(dx.transactions, 'transaction')}${dx.lastTransactionOn ? ` up to ${longDate(dx.lastTransactionOn)}` : ''} and found no deposits that repeat on a schedule. Enter your paycheck to get started.`;
  }

  return `
    <section class="card setup-card">
      <div class="setup-head">
        <span class="setup-icon" aria-hidden="true">${icon('wallet')}</span>
        <div>
          <h2>Set up your paycheck</h2>
          <p class="ink-2">${esc(intro)}</p>
        </div>
      </div>

      ${dx.dismissed.map((s) => `
        <div class="callout">
          ${icon('alert')}
          <div class="grow">You marked <strong>${esc(s.name)}</strong> (${esc(money(s.amount))} ${esc(cadenceLabel(s.cadence).toLowerCase())}) as not recurring.</div>
          <button class="btn btn-sm" type="button" data-undo-dismiss="${s.id}">It's my paycheck</button>
        </div>`).join('')}

      ${stale.map((c) => `
        <div class="callout warn">
          ${icon('clock')}
          <div class="grow"><strong>${esc(c.name)}</strong> looks like your paycheck, but the newest one uploaded arrived ${esc(longDate(c.lastSeenOn))}. Upload a recent statement to bring the plan up to date.</div>
          <div class="callout-actions">
            <button class="btn btn-sm btn-primary" type="button" data-action="upload">Upload</button>
            <button class="btn btn-sm" type="button" data-use-candidate="${candidates.indexOf(c)}">Use anyway</button>
          </div>
        </div>`).join('')}

      ${maybe.length ? `
        <h3 class="section-title">Is one of these your paycheck?</h3>
        <div class="rows">${maybe.map((c) => `
          <div class="row">
            <span class="emoji-tile" aria-hidden="true">💰</span>
            <div class="row-main">
              <div class="row-title">${esc(c.name)}</div>
              <div class="row-sub">${esc(money(c.amount))} ${esc(cadenceLabel(c.cadence).toLowerCase())} · last ${esc(shortDate(c.lastSeenOn))} · ${esc(plural(c.occurrences, 'deposit'))}</div>
              <div class="tiny muted truncate">${esc(c.description || '')}</div>
            </div>
            <button class="btn btn-sm btn-primary" type="button" data-use-candidate="${candidates.indexOf(c)}">Use this</button>
          </div>`).join('')}</div>` : ''}

      <div class="setup-foot">
        ${!dx.transactions ? `<button class="btn btn-primary" type="button" data-action="upload">${icon('upload')}Upload statement</button>` : ''}
        <button class="btn ${dx.transactions && !candidates.length ? 'btn-primary' : ''}" type="button" data-edit-paycheck>
          ${candidates.length ? 'Not listed? Enter it yourself' : 'Enter my paycheck'}</button>
      </div>
    </section>`;
}

function fromCandidate(c) {
  return {
    name: c.name,
    amount: c.amount,
    cadence: CADENCES.includes(c.cadence) ? c.cadence : 'biweekly',
    nextPayday: c.nextPayday || '',
  };
}

// --- panels ------------------------------------------------------------------------

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

function budgetDrawer(ctx, p) {
  let mode = p.isCustom ? 'custom' : 'recommended';
  let timer = null;
  let seq = 0;

  openDrawer({
    title: 'Your spending budget',
    body: `
      <p class="small ink-2" style="margin-bottom:16px">The recommended amount covers your bills and keeps every goal on schedule. Try your own amount to see what it changes before you save.</p>
      ${segmented('budget-mode', [['recommended', `Recommended · ${money(p.recommended, { whole: true })}`], ['custom', 'Custom']], mode)}
      <label class="field" data-custom ${mode === 'custom' ? '' : 'hidden'} style="margin:16px 0 0">
        <span class="field-label">Spend per paycheck</span>
        <span class="money-input"><input type="text" inputmode="decimal" name="spend" value="${p.budget}"></span>
      </label>
      <div class="plan-impact" data-impact aria-live="polite">${impact(p)}</div>`,
    footer: '<button class="btn" type="button" data-cancel>Cancel</button><button class="btn btn-primary" type="button" data-save>Save budget</button>',
    onMount(drawer, close) {
      const input = drawer.querySelector('input[name="spend"]');
      const customField = drawer.querySelector('[data-custom]');
      const impactEl = drawer.querySelector('[data-impact]');

      const preview = () => {
        clearTimeout(timer);
        const amount = mode === 'custom' ? parseAmount(input.value) : 'recommended';
        if (amount === null) return;
        timer = setTimeout(async () => {
          const mine = ++seq;
          try {
            const next = await get('/plan', { spend: amount });
            if (mine === seq) impactEl.innerHTML = impact(next);
          } catch (err) { toast(err.message, 'bad'); }
        }, 250);
      };

      const save = async () => {
        clearTimeout(timer);
        const amount = mode === 'custom' ? parseAmount(input.value) : null;
        if (mode === 'custom' && amount === null) { toast('Enter a dollar amount.', 'bad'); return; }
        try {
          await patch('/plan', { spendingBudget: amount });
          close();
          toast(amount === null ? 'Using the recommended budget' : 'Budget saved');
          ctx.rerender();
        } catch (err) { toast(err.message, 'bad'); }
      };

      // Listeners go on the panel's children: the drawer element itself is
      // reused by every panel.
      drawer.querySelector('.seg').addEventListener('click', (e) => {
        const option = e.target.closest('[data-seg="budget-mode"]');
        if (!option) return;
        markSegment(option);
        mode = option.dataset.value;
        customField.hidden = mode !== 'custom';
        // Select the amount so typing replaces it rather than appending.
        if (mode === 'custom') { input.focus(); input.select(); }
        preview();
      });
      input.addEventListener('input', preview);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      drawer.querySelector('[data-cancel]').addEventListener('click', () => { clearTimeout(timer); close(); });
      drawer.querySelector('[data-save]').addEventListener('click', save);
    },
  });
}

function billsDrawer(p) {
  openDrawer({
    title: 'Set aside for bills',
    body: `
      <p class="small ink-2" style="margin-bottom:6px">Every paycheck puts away a share of each recurring bill, so the one that covers rent is no tighter than the rest. ${esc(money(p.bills))} a paycheck in all.</p>
      <div class="rows">${p.billItems.map((b) => `
        <div class="row">
          <span class="emoji-tile" aria-hidden="true">${esc(b.emoji || '🧾')}</span>
          <div class="row-main">
            <div class="row-title">${esc(b.name)}</div>
            <div class="row-sub">${esc(money(b.amount))} ${esc(cadenceLabel(b.cadence).toLowerCase())}</div>
          </div>
          <div class="row-end"><div class="amount">${esc(money(b.perPaycheck))}</div><div class="tiny muted">a paycheck</div></div>
        </div>`).join('')}</div>`,
  });
}

function paycheckDrawer(ctx, p, prefill = null) {
  const current = p.ready ? p.paycheck : null;
  const manual = current && current.source === 'manual';
  const values = prefill || (current
    ? {
      name: manual && current.name !== 'Your paycheck' ? current.name : '',
      amount: current.amount,
      cadence: current.cadence,
      nextPayday: p.period.nextPayday,
    }
    : { name: '', amount: '', cadence: 'biweekly', nextPayday: '' });
  const cadence = CADENCES.includes(values.cadence) ? values.cadence : 'biweekly';

  let note = '';
  if (prefill) note = 'Filled in from your deposits. Check the amount and next payday, then save.';
  else if (current && !manual) note = `Found in your statements: ${money(current.amount)} ${cadenceLabel(current.cadence).toLowerCase()}. Change anything that isn't right.`;

  openDrawer({
    title: prefill ? 'Use this paycheck' : current ? 'Your paycheck' : 'Add your paycheck',
    body: `
      ${note ? `<p class="small muted" style="margin:0 0 16px">${esc(note)}</p>` : ''}
      <form id="paycheck-form">
        <label class="field"><span class="field-label">Name</span>
          <input type="text" name="name" maxlength="60" placeholder="Paycheck" value="${esc(values.name || '')}"></label>
        <label class="field"><span class="field-label">Take-home pay per paycheck</span>
          <span class="money-input"><input type="text" inputmode="decimal" name="amount" required value="${esc(values.amount)}"></span>
          <span class="field-help">The amount that reaches your account, after taxes and deductions.</span></label>
        <div class="field-row">
          <label class="field"><span class="field-label">How often</span>
            <select name="cadence">${CADENCES.map((c) => `<option value="${c}" ${c === cadence ? 'selected' : ''}>${esc(cadenceLabel(c))}</option>`).join('')}</select></label>
          <label class="field"><span class="field-label">Next payday</span>
            <input type="date" name="nextPayday" required value="${esc(values.nextPayday || '')}"></label>
        </div>
      </form>`,
    footer: `${manual && !prefill ? '<button class="btn" type="button" data-use-detected>Find it automatically</button>' : ''}
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
          name: String(f.get('name') || '').trim(),
          amount: parseAmount(f.get('amount')),
          cadence: f.get('cadence'),
          nextPayday: f.get('nextPayday'),
        }, 'Paycheck saved');
      });
      const detected = drawer.querySelector('[data-use-detected]');
      if (detected) detected.addEventListener('click', () => send(null, 'Looking for your paycheck in your statements'));
    },
  });
}
