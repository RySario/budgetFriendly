import { get, post, patch, del, api } from '../api.js';
import { esc } from '../format.js';
import {
  icon, openDrawer, toast, empty, confirmDialog, segmented, themeChoice, THEME_OPTIONS,
} from '../ui.js';

export default async function render(ctx) {
  const { view } = ctx;
  const [s, groups, { rules }] = await Promise.all([
    get('/settings'), ctx.groups(), get('/categories/rules/all'),
  ]);
  const learned = rules.filter((r) => r.auto);

  // The theme control and the tour button are handled by the app shell, so
  // they behave the same here as in the More sheet.
  view.innerHTML = `
    <div class="grid grid-2">
      <section class="card">
        <div class="card-head"><h2>Appearance</h2></div>
        <p class="small muted" style="margin-bottom:12px">Auto follows your device's light or dark setting. The choice is saved on this device.</p>
        ${segmented('theme', THEME_OPTIONS, themeChoice())}
        <div class="settings-divider"></div>
        <div class="card-head" style="margin-bottom:6px"><h2>Guided tour</h2></div>
        <p class="small muted">A one-minute look at where everything is.</p>
        <button class="btn btn-sm" type="button" data-action="tour" style="margin-top:12px">${icon('help')}Take the tour</button>
      </section>

      <section class="card">
        <div class="card-head"><h2>Your account</h2></div>
        <div class="kv"><span class="muted">Signed in as</span><span class="truncate">${esc(s.user.email)}</span></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:14px">
          <button class="btn btn-sm" type="button" data-password>Change password</button>
          <button class="btn btn-sm btn-quiet" type="button" data-action="logout">${icon('logout')}Sign out</button>
        </div>
      </section>
    </div>

    <section class="card">
      <div class="card-head"><h2>Your data</h2></div>
      <div class="grid grid-2" style="gap:0 32px">
        <div>
          <div class="kv"><span class="muted">Transactions</span><span class="num">${s.counts.transactions}</span></div>
          <div class="kv"><span class="muted">Waiting for review</span><span class="num">${s.counts.needs_review}</span></div>
          <div class="kv"><span class="muted">Accounts</span><span class="num">${s.counts.accounts}</span></div>
        </div>
        <div>
          <div class="kv"><span class="muted">Categories</span><span class="num">${s.counts.categories}</span></div>
          <div class="kv"><span class="muted">Merchant rules</span><span class="num">${s.counts.rules} (${s.counts.learned_rules} yours)</span></div>
          <div class="kv"><span class="muted">Goals</span><span class="num">${s.counts.goals}</span></div>
        </div>
      </div>
      <p class="small muted" style="margin-top:14px">To erase all financial data and start over — your login is kept — run this on the server:</p>
      <pre class="code">dokku run budgetfriendly npm run reset-data -- --yes</pre>
    </section>

    <section class="card card-flush">
      <div class="card-head">
        <div><h2>Categories</h2><div class="card-sub">Select a category to rename it, change its emoji, or move it to another group.</div></div>
      </div>
      ${groups.map((g) => `
        <div class="date-head">
          <span>${esc(g.name)}</span>
          <button class="link-btn" type="button" data-add-category="${g.id}">${icon('plus', 14)}Add</button>
        </div>
        <div class="chips-wrap">${g.categories.map((c) => `
          <button class="pill pill-btn" type="button" data-category="${c.id}">
            <span aria-hidden="true">${esc(c.emoji || '•')}</span>${esc(c.name)}<span class="muted">${c.transaction_count}</span>
          </button>`).join('')}</div>`).join('')}
    </section>

    <section class="card card-flush">
      <div class="card-head">
        <div><h2>Rules you've taught it</h2><div class="card-sub">Added when you choose "Always categorize" on a transaction.</div></div>
      </div>
      ${learned.length ? `<div class="rows">${learned.map((r) => `
        <div class="row">
          <div class="row-main">
            <div class="row-title">${esc(r.pattern)}</div>
            <div class="row-sub">→ ${esc(r.category_emoji || '')} ${esc(r.category_name)}</div>
          </div>
          <button class="icon-btn" type="button" data-delete-rule="${r.id}" aria-label="Delete rule for ${esc(r.pattern)}">${icon('trash')}</button>
        </div>`).join('')}</div>`
        : empty('No rules yet', 'Recategorize a transaction and choose "Always categorize" to teach it a merchant.')}
    </section>`;

  view.addEventListener('click', async (e) => {
    if (e.target.closest('[data-password]')) { passwordDrawer(); return; }

    const add = e.target.closest('[data-add-category]');
    if (add) { categoryDrawer(ctx, groups, null, Number(add.dataset.addCategory)); return; }

    const cat = e.target.closest('[data-category]');
    if (cat) {
      const category = groups.flatMap((g) => g.categories).find((c) => c.id === Number(cat.dataset.category));
      categoryDrawer(ctx, groups, category, category.group_id);
      return;
    }

    const rule = e.target.closest('[data-delete-rule]');
    if (rule) {
      try {
        await del(`/categories/rules/${rule.dataset.deleteRule}`);
        toast('Rule removed');
        ctx.rerender();
      } catch (err) { toast(err.message, 'bad'); }
    }
  });
}

function categoryDrawer(ctx, groups, category, groupId) {
  const system = category && category.is_system;
  openDrawer({
    title: category ? 'Edit category' : 'New category',
    body: `
      <form id="category-form">
        <div class="field-row" style="grid-template-columns:84px 1fr">
          <label class="field"><span class="field-label">Emoji</span>
            <input type="text" name="emoji" maxlength="8" value="${esc(category ? category.emoji || '' : '')}" placeholder="🙂" style="text-align:center"></label>
          <label class="field"><span class="field-label">Name</span>
            <input type="text" name="name" maxlength="60" required value="${esc(category ? category.name : '')}" ${system ? 'readonly' : ''}></label>
        </div>
        <label class="field"><span class="field-label">Group</span>
          <select name="groupId" ${system ? 'disabled' : ''}>${groups.map((g) => `
            <option value="${g.id}" ${g.id === groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
          ${system ? '<span class="field-help">Built-in categories keep their name and group; you can still change the emoji.</span>' : ''}</label>
      </form>`,
    footer: `${category && !system ? '<button class="btn btn-danger" type="button" data-delete>Delete</button>' : ''}
      <button class="btn btn-primary" type="button" data-save>${category ? 'Save' : 'Add category'}</button>`,
    onMount(drawer, close) {
      const form = drawer.querySelector('#category-form');
      drawer.querySelector('[data-save]').addEventListener('click', async () => {
        const f = new FormData(form);
        const body = { emoji: f.get('emoji'), name: f.get('name') };
        if (!system) body.groupId = Number(f.get('groupId'));
        try {
          if (category) await patch(`/categories/${category.id}`, body);
          else await post('/categories', body);
          ctx.invalidateGroups();
          close();
          toast(category ? 'Category saved' : 'Category added');
          ctx.rerender();
        } catch (err) { toast(err.message, 'bad'); }
      });

      const remove = drawer.querySelector('[data-delete]');
      if (remove) {
        remove.addEventListener('click', async () => {
          const ok = await confirmDialog({
            title: `Delete ${category.name}?`,
            message: `Its ${category.transaction_count} transactions move to ${category.kind === 'income' ? 'Other Income' : 'Uncategorized'}.`,
            confirmLabel: 'Delete', danger: true,
          });
          if (!ok) return;
          try {
            await del(`/categories/${category.id}`);
            ctx.invalidateGroups();
            close();
            toast('Category deleted');
            ctx.rerender();
          } catch (err) { toast(err.message, 'bad'); }
        });
      }
    },
  });
}

function passwordDrawer() {
  openDrawer({
    title: 'Change password',
    body: `
      <form id="password-form">
        <label class="field"><span class="field-label">Current password</span>
          <input type="password" name="currentPassword" autocomplete="current-password" required></label>
        <label class="field"><span class="field-label">New password</span>
          <input type="password" name="newPassword" autocomplete="new-password" minlength="8" required>
          <span class="field-help">At least 8 characters.</span></label>
      </form>`,
    footer: '<button class="btn btn-primary" type="button" data-save>Update password</button>',
    onMount(drawer, close) {
      drawer.querySelector('[data-save]').addEventListener('click', async () => {
        const f = new FormData(drawer.querySelector('#password-form'));
        try {
          await api('/auth/password', { method: 'POST', body: Object.fromEntries(f) });
          close();
          toast('Password updated');
        } catch (err) { toast(err.message, 'bad'); }
      });
    },
  });
}
