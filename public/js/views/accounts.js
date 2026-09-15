import { get, patch } from '../api.js';
import { esc, money, shortDate, timeAgo, plural } from '../format.js';
import { icon, openDrawer, toast, empty } from '../ui.js';

export default async function render(ctx) {
  const { view } = ctx;
  ctx.setActions(`<button class="btn btn-primary btn-sm only-desktop" type="button" data-action="upload">${icon('upload')}Upload statement</button>`);

  const [a, history] = await Promise.all([get('/accounts'), get('/import/history')]);
  const visible = a.accounts.filter((x) => !x.archived);

  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Net worth</div><div class="kpi-value">${esc(money(a.netWorth))}</div><div class="kpi-sub">Across visible accounts</div></div>
      <div class="kpi"><div class="kpi-label">Assets</div><div class="kpi-value">${esc(money(a.assets))}</div><div class="kpi-sub">Positive balances</div></div>
      <div class="kpi"><div class="kpi-label">Liabilities</div><div class="kpi-value">${esc(money(a.liabilities))}</div><div class="kpi-sub">Money owed</div></div>
      <div class="kpi"><div class="kpi-label">Accounts</div><div class="kpi-value">${visible.length}</div><div class="kpi-sub">${a.accounts.length - visible.length ? `${a.accounts.length - visible.length} hidden` : 'From your uploads'}</div></div>
    </div>

    <section class="card card-flush">
      <div class="card-head"><h2>Accounts</h2></div>
      ${a.accounts.length ? `<div class="rows">${a.accounts.map((x) => `
        <button class="row" type="button" data-account="${x.id}">
          <span class="emoji-tile" aria-hidden="true">${x.type === 'credit' ? '💳' : '🏦'}</span>
          <div class="row-main">
            <div class="row-title">${esc(x.name)} ${x.archived ? '<span class="chip">Hidden</span>' : ''}</div>
            <div class="row-sub">${x.mask ? `••${esc(x.mask)} · ` : ''}${plural(x.transactionCount, 'transaction')}${x.firstOn ? ` · ${esc(shortDate(x.firstOn))} – ${esc(shortDate(x.lastOn))}` : ''}</div>
          </div>
          <div class="row-end">
            <div class="amount">${x.balance == null ? '—' : esc(money(x.balance))}</div>
            ${x.balanceAsOf ? `<div class="tiny muted">as of ${esc(timeAgo(x.balanceAsOf))}</div>` : ''}
          </div>
        </button>`).join('')}</div>`
        : empty('No accounts yet', 'Accounts appear after your first upload.',
          `<button class="btn btn-primary" type="button" data-action="upload">${icon('upload')}Upload statement</button>`)}
    </section>

    <div class="grid grid-2">
      <section class="card card-flush">
        <div class="card-head"><h2>Upload history</h2></div>
        ${history.runs.length ? `<div class="rows">${history.runs.map((r) => `
          <div class="row">
            <div class="row-main">
              <div class="row-title">${r.status === 'ok' ? `${plural(r.imported, 'new transaction')}` : 'Upload failed'}</div>
              <div class="row-sub">${esc(r.status === 'ok' ? `${r.duplicates} already here` : r.message || 'Unknown error')}</div>
            </div>
            <div class="row-end">
              ${r.status === 'ok'
                ? `<span class="chip good">${icon('check')}Imported</span>`
                : r.status === 'error' ? `<span class="chip bad">${icon('alert')}Failed</span>` : '<span class="chip">Running</span>'}
              <div class="tiny muted" style="margin-top:4px">${esc(timeAgo(r.started_at))}</div>
            </div>
          </div>`).join('')}</div>`
          : empty('No uploads yet')}
      </section>

      <section class="card">
        <div class="card-head"><h2>Getting a statement from Golden 1</h2></div>
        <ol class="steps">
          <li>Sign in to Golden 1 online banking.</li>
          <li>Open an account and click the download (cloud) icon.</li>
          <li>Choose <strong>OFX</strong> as the format and pick a date range.</li>
          <li>Upload the file with <strong>Upload statement</strong>.</li>
        </ol>
        <p class="small muted" style="margin-top:12px">Overlapping dates are fine — transactions already here are skipped, so you can download a little extra each time.</p>
        <button class="btn btn-primary" type="button" data-action="upload" style="margin-top:14px">${icon('upload')}Upload statement</button>
      </section>
    </div>`;

  view.addEventListener('click', (e) => {
    const row = e.target.closest('[data-account]');
    if (!row) return;
    const account = a.accounts.find((x) => x.id === Number(row.dataset.account));
    openDrawer({
      title: 'Edit account',
      body: `
        <form id="account-form">
          <label class="field"><span class="field-label">Name</span>
            <input type="text" name="name" value="${esc(account.name)}" required maxlength="80"></label>
          <label class="check"><input type="checkbox" name="archived" ${account.archived ? 'checked' : ''}>
            <span>Hide this account
              <span class="field-help">Its transactions leave budgets, reports and net worth. Nothing is deleted.</span></span></label>
        </form>`,
      footer: '<button class="btn btn-primary" type="button" data-save>Save</button>',
      onMount(drawer, close) {
        drawer.querySelector('[data-save]').addEventListener('click', async () => {
          const f = new FormData(drawer.querySelector('#account-form'));
          try {
            await patch(`/accounts/${account.id}`, { name: f.get('name'), archived: f.get('archived') === 'on' });
            close();
            toast('Account saved');
            ctx.rerender();
          } catch (err) { toast(err.message, 'bad'); }
        });
      },
    });
  });
}
