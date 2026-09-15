import { get, post, patch, del } from '../api.js';
import { esc, money, longDate, todayISO } from '../format.js';
import { icon, meter, empty, openDrawer, toast, confirmDialog } from '../ui.js';

export default async function render(ctx) {
  const { view, state } = ctx;
  ctx.setActions(`<button class="btn btn-primary btn-sm" type="button" data-new-goal>${icon('plus')}New goal</button>`);

  const [{ goals }, groups] = await Promise.all([get('/goals', { month: state.month }), ctx.groups()]);
  ctx.setHeaderHandler((e) => { if (e.target.closest('[data-new-goal]')) goalDrawer(ctx, groups, null); });

  view.innerHTML = goals.length
    ? `<div class="grid grid-2">${goals.map(card).join('')}</div>`
    : `<section class="card">${empty('No goals yet', 'Save toward something, or put a monthly cap on a category.',
      `<button class="btn btn-primary" type="button" data-new-goal>${icon('plus')}New goal</button>`)}</section>`;

  view.addEventListener('click', (e) => {
    if (e.target.closest('[data-new-goal]')) { goalDrawer(ctx, groups, null); return; }
    const edit = e.target.closest('[data-edit-goal]');
    if (edit) { goalDrawer(ctx, groups, goals.find((g) => g.id === Number(edit.dataset.editGoal))); return; }
    const add = e.target.closest('[data-add-money]');
    if (add) contributionDrawer(ctx, goals.find((g) => g.id === Number(add.dataset.addMoney)));
  });
}

function card(g) {
  const limit = g.kind === 'limit';
  const status = g.status === 'achieved' || (!limit && g.achieved)
    ? `<span class="chip good">${icon('check')}Done</span>`
    : limit
      ? (g.onPace ? '<span class="chip">Under the cap</span>' : `<span class="chip bad">${icon('alert')}Over the cap</span>`)
      : g.onPace === false ? `<span class="chip warn">${icon('clock')}Behind</span>`
        : g.onPace ? `<span class="chip good">${icon('check')}On track</span>` : '';
  return `
    <section class="card">
      <div class="card-head">
        <div class="truncate"><h2 class="truncate">${esc(g.name)}</h2>
          <div class="card-sub">${limit
            ? `Monthly cap on ${esc(g.category_emoji || '')} ${esc(g.category_name || 'a category')}`
            : g.target_date ? `By ${esc(longDate(g.target_date))}` : 'No deadline'}</div></div>
        ${status}
      </div>
      <div class="split" style="align-items:baseline">
        <span class="kpi-value">${esc(money(g.current))}</span>
        <span class="muted small">of ${esc(money(g.target_amount))}</span>
      </div>
      ${meter(g.percent / 100, limit && !g.onPace ? 'over' : '')}
      <p class="small muted" style="margin-top:8px">${limit
        ? g.onPace ? `${esc(money(g.remaining))} left this month` : `${esc(money(g.current - g.target_amount))} over this month`
        : g.achieved ? 'Goal reached.'
          : `${esc(money(g.remaining))} to go${g.requiredMonthly ? ` · about ${esc(money(g.requiredMonthly))} a month to finish on time` : ''}`}</p>
      <div class="goal-actions">
        ${limit ? '' : `<button class="btn btn-sm btn-primary" type="button" data-add-money="${g.id}">${icon('plus')}Add money</button>`}
        <button class="btn btn-sm" type="button" data-edit-goal="${g.id}">Edit</button>
      </div>
    </section>`;
}

function goalDrawer(ctx, groups, goal) {
  const g = goal || { kind: 'save' };
  const spending = groups.filter((x) => x.kind === 'spending');
  openDrawer({
    title: goal ? 'Edit goal' : 'New goal',
    body: `
      <form id="goal-form">
        <label class="field"><span class="field-label">Name</span>
          <input type="text" name="name" required maxlength="80" value="${esc(g.name || '')}" placeholder="Emergency fund"></label>
        <label class="field"><span class="field-label">Type</span>
          <select name="kind">
            <option value="save" ${g.kind === 'save' ? 'selected' : ''}>Save toward an amount</option>
            <option value="payoff" ${g.kind === 'payoff' ? 'selected' : ''}>Pay something off</option>
            <option value="limit" ${g.kind === 'limit' ? 'selected' : ''}>Cap monthly spending in a category</option>
          </select></label>
        <div class="field-row">
          <label class="field"><span class="field-label" data-target-label>${g.kind === 'limit' ? 'Monthly cap' : 'Target'}</span>
            <span class="money-input"><input type="text" inputmode="decimal" name="targetAmount" required value="${g.target_amount ?? ''}"></span></label>
          <label class="field" data-not-limit ${g.kind === 'limit' ? 'hidden' : ''}><span class="field-label">Target date</span>
            <input type="date" name="targetDate" value="${g.target_date ? String(g.target_date).slice(0, 10) : ''}"></label>
        </div>
        <label class="field" data-limit ${g.kind === 'limit' ? '' : 'hidden'}><span class="field-label">Category</span>
          <select name="categoryId">${spending.map((grp) => `<optgroup label="${esc(grp.name)}">${grp.categories.map((c) => `
            <option value="${c.id}" ${String(c.id) === String(g.category_id) ? 'selected' : ''}>${esc(`${c.emoji || ''} ${c.name}`.trim())}</option>`).join('')}</optgroup>`).join('')}</select></label>
        <label class="field" data-not-limit ${g.kind === 'limit' ? 'hidden' : ''}><span class="field-label">Already saved</span>
          <span class="money-input"><input type="text" inputmode="decimal" name="startingAmount" value="${g.starting_amount ?? 0}"></span></label>
      </form>`,
    footer: `${goal ? '<button class="btn btn-danger" type="button" data-delete>Delete</button>' : ''}
      <button class="btn btn-primary" type="button" data-save>${goal ? 'Save' : 'Create goal'}</button>`,
    onMount(drawer, close) {
      const form = drawer.querySelector('#goal-form');
      form.kind.addEventListener('change', () => {
        const limit = form.kind.value === 'limit';
        drawer.querySelectorAll('[data-limit]').forEach((el) => { el.hidden = !limit; });
        drawer.querySelectorAll('[data-not-limit]').forEach((el) => { el.hidden = limit; });
        drawer.querySelector('[data-target-label]').textContent = limit ? 'Monthly cap' : 'Target';
      });

      drawer.querySelector('[data-save]').addEventListener('click', async () => {
        const f = new FormData(form);
        const limit = f.get('kind') === 'limit';
        const body = {
          name: String(f.get('name') || '').trim(),
          kind: f.get('kind'),
          targetAmount: Number(String(f.get('targetAmount')).replace(/[$,]/g, '')),
          targetDate: limit ? null : (f.get('targetDate') || null),
          categoryId: limit ? Number(f.get('categoryId')) : null,
          startingAmount: limit ? 0 : Number(String(f.get('startingAmount') || 0).replace(/[$,]/g, '')) || 0,
        };
        if (!body.name) { toast('Give the goal a name.', 'bad'); return; }
        try {
          if (goal) await patch(`/goals/${goal.id}`, body);
          else await post('/goals', body);
          close();
          toast(goal ? 'Goal saved' : 'Goal created');
          ctx.rerender();
        } catch (err) { toast(err.message, 'bad'); }
      });

      const remove = drawer.querySelector('[data-delete]');
      if (remove) {
        remove.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: 'Delete this goal?', message: `"${goal.name}" and its contributions will be removed.`,
            confirmLabel: 'Delete', danger: true,
          });
          if (!ok) return;
          try {
            await del(`/goals/${goal.id}`);
            close();
            toast('Goal deleted');
            ctx.rerender();
          } catch (err) { toast(err.message, 'bad'); }
        });
      }
    },
  });
}

function contributionDrawer(ctx, goal) {
  openDrawer({
    title: `Add to ${goal.name}`,
    body: `
      <form id="money-form">
        <label class="field"><span class="field-label">Amount</span>
          <span class="money-input"><input type="text" inputmode="decimal" name="amount" required></span>
          <span class="field-help">Use a negative amount to record a withdrawal.</span></label>
        <label class="field"><span class="field-label">Date</span>
          <input type="date" name="occurredOn" value="${todayISO()}"></label>
        <label class="field"><span class="field-label">Note</span>
          <input type="text" name="note" maxlength="120" placeholder="Optional"></label>
      </form>`,
    footer: '<button class="btn btn-primary" type="button" data-save>Add</button>',
    onMount(drawer, close) {
      drawer.querySelector('[data-save]').addEventListener('click', async () => {
        const f = new FormData(drawer.querySelector('#money-form'));
        try {
          const res = await post(`/goals/${goal.id}/contributions`, {
            amount: Number(String(f.get('amount')).replace(/[$,]/g, '')),
            occurredOn: f.get('occurredOn'),
            note: f.get('note'),
          });
          close();
          toast(res.goal.achieved ? `${goal.name} reached 🎉` : 'Added');
          ctx.rerender();
        } catch (err) { toast(err.message, 'bad'); }
      });
    },
  });
}
