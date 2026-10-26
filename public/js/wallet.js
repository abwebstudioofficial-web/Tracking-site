// Transport Hub wallet (see supabase/migrations/20261026200000_wallet.sql).
// - Carriers, brokers and dispatchers: balance, "Add money" by JazzCash (send money, then enter
//   the amount, transaction ID and a screenshot), and the history. Fees are taken on delivery.
// - Admins (Wallets tab): JazzCash payments to check (approve / reject), every company's balance
//   with add / take money by hand, and the JazzCash details shown to companies.
window.HubWallet = (() => {
  const { sb } = Ibraya;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (n) => `${n < 0 ? '−' : ''}Rs ${Math.abs(Number(n || 0)).toLocaleString('en-PK')}`;
  const when = (t) => new Date(t).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const localPhone = (p) => (p && p.startsWith('+92') ? '0' + p.slice(3) : p || '');
  const BUCKET = 'wallet-proofs';
  const KIND = { deposit: 'JazzCash top-up', fee: 'Transport Hub fee', adjust: 'By Transport Hub' };
  const STATUS = { pending: ['Waiting for check', 'warn'], approved: ['', ''], rejected: ['Not approved', 'bad'] };

  function entryRow(w, { admin = false, actions = '' } = {}) {
    const [label, cls] = STATUS[w.status];
    const sub = [
      admin ? `<b>${esc(w.company.name)}</b>` : '',
      w.tid ? `TID ${esc(w.tid)}` : '',
      w.route ? esc(w.route) : '',
      w.note ? esc(w.note) : '',
      when(w.created_at),
    ].filter(Boolean).join(' · ');
    return `<div class="row wallet-row">
      <div class="row-main"><b>${KIND[w.kind]}</b>${label ? ` <span class="pill small ${cls}">${label}</span>` : ''}
        <div class="muted small">${sub}</div></div>
      <div class="row-actions">
        ${w.has_proof ? `<button class="btn btn-ghost btn-small" data-proof="${esc(w.proof_path)}">Screenshot</button>` : ''}
        <span class="price ${w.amount < 0 ? 'minus' : 'plus'}">${w.amount > 0 ? '+' : ''}${rs(w.amount)}</span>
        ${actions}
      </div>
    </div>`;
  }

  function payBox(pay) {
    const j = pay.jazzcash || {};
    const copy = (v, label) => (v ? `<div class="pay-line"><span>${label}</span><b>${esc(v)}</b>
      <button type="button" class="btn btn-ghost btn-small" data-copy="${esc(v)}">Copy</button></div>` : '');
    return `<div class="pay-box">
      <div class="pay-brand">JazzCash</div>
      ${copy(j.number, 'Account number')}
      ${copy(j.till_id, 'Till ID')}
      ${j.name ? `<div class="pay-line"><span>Account name</span><b>${esc(j.name)}</b></div>` : ''}
    </div>`;
  }

  function wireCommon(root) {
    root.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied ✓'; } catch { b.textContent = b.dataset.copy; }
      setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    }));
    root.querySelectorAll('[data-proof]').forEach((b) => b.addEventListener('click', async () => {
      const win = window.open('', '_blank');
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(b.dataset.proof, 300);
      if (error) { if (win) win.close(); Ibraya.message('Could not open', Ibraya.friendlyError(error)); return; }
      if (win) win.location = data.signedUrl; else location.href = data.signedUrl;
    }));
  }

  // ---------- a company's wallet ----------
  async function renderWallet(body, { rpc, busy }) {
    body.innerHTML = '<div class="panel-card"><p class="muted">Loading…</p></div>';
    let d;
    try { d = await rpc('my_wallet'); } catch (err) {
      body.innerHTML = `<div class="panel-card"><p class="error">${esc(Ibraya.friendlyError(err))}</p></div>`;
      return;
    }
    body.innerHTML = `
      <div class="money-cards">
        <div class="panel-card money"><small>Wallet balance · بیلنس</small><b class="${d.balance < 0 ? 'minus' : ''}">${rs(d.balance)}</b></div>
        <div class="panel-card money"><small>Waiting for check</small><b>${rs(d.pending)}</b></div>
        <div class="panel-card money"><small>Fee per truck trip</small><b>${rs(d.fee_per_trip)}</b></div>
      </div>
      <div class="panel-card narrow">
        <h2>Add money · رقم جمع کریں</h2>
        <ol class="steps-list">
          <li>Send the money from your JazzCash app to Transport Hub:</li>
        </ol>
        ${payBox(d.pay)}
        <ol class="steps-list" start="2">
          <li>Enter the amount and the transaction ID (TID) from the JazzCash message, and add a screenshot.</li>
          <li>Transport Hub checks it and adds it to your balance. You get an alert.</li>
        </ol>
        <form id="deposit-form" novalidate>
          <div class="field-pair">
            <label class="field"><span>Amount sent (Rs)</span><input name="amount" type="number" min="100" step="1" inputmode="numeric" placeholder="e.g. 5000" required></label>
            <label class="field"><span>Transaction ID (TID)</span><input name="tid" maxlength="30" autocomplete="off" spellcheck="false" placeholder="e.g. 012345678901" required></label>
          </div>
          <label class="field"><span>Screenshot of the payment <i>(recommended)</i></span><input name="file" type="file" accept="image/*,application/pdf"></label>
          <div class="error" id="deposit-error"></div>
          <button class="btn" id="deposit-submit">I have sent it · بھیج دیا</button>
        </form>
        <p class="muted small">The Transport Hub fee (${rs(d.fee_per_trip)} per truck trip) is taken from this wallet when a trip is delivered. To bid on a load, your wallet needs enough for that load's fee.</p>
      </div>
      <div class="panel-card"><h2>History</h2><div class="rows">${d.items.length ? d.items.map((w) => entryRow(w)).join('') : '<p class="muted">Nothing yet.</p>'}</div></div>`;
    wireCommon(body);
    const f = body.querySelector('#deposit-form');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(body.querySelector('#deposit-submit'), body.querySelector('#deposit-error'), async () => {
        const amount = parseInt(f.amount.value, 10);
        const tid = f.tid.value.replace(/\s/g, '').toUpperCase();
        if (!(amount >= 100)) throw new Error('Enter the amount you sent');
        if (!/^[A-Z0-9]{6,30}$/.test(tid)) throw new Error('Enter the transaction ID (TID) from the JazzCash message');
        let path = null;
        const file = f.file.files[0];
        if (file) {
          if (file.size > 5 * 1024 * 1024) throw new Error('The screenshot is too big (5 MB max)');
          const companyId = (await rpc('my_company')).company.id;
          const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'jpg';
          path = `${companyId}/${Date.now()}.${ext}`;
          const up = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined });
          if (up.error) throw up.error;
        }
        await rpc('wallet_deposit', { p_amount: amount, p_tid: tid, p_proof_path: path });
        await Ibraya.dialog({ title: 'Sent for checking ✓', message: `${rs(amount)} · TID ${tid}\nTransport Hub will check it and add it to your balance. You'll get an alert.`, cancel: false });
        await renderWallet(body, { rpc, busy });
      });
    });
  }

  // ---------- admins: payments to check, balances, JazzCash details ----------
  async function renderAdmin(body, { rpc, busy }) {
    body.innerHTML = '<div class="panel-card"><p class="muted">Loading…</p></div>';
    let d;
    try { d = await rpc('admin_wallets'); } catch (err) {
      body.innerHTML = `<div class="panel-card"><p class="error">${esc(Ibraya.friendlyError(err))}</p></div>`;
      return;
    }
    const j = d.pay.jazzcash || {};
    const total = d.wallets.reduce((s, w) => s + Number(w.balance), 0);
    body.innerHTML = `
      <div class="money-cards">
        <div class="panel-card money"><small>Payments to check</small><b>${d.pending.length}</b></div>
        <div class="panel-card money"><small>Money in all wallets</small><b>${rs(total)}</b></div>
        <div class="panel-card money"><small>Companies with a wallet</small><b>${d.wallets.length}</b></div>
      </div>
      <div class="panel-card">
        <h2>JazzCash payments to check · ادائیگیاں چیک کریں</h2>
        <p class="muted small">Open the JazzCash Business app, find the payment with this TID and amount, then approve it. Only approved money counts in the balance.</p>
        <div class="rows">${d.pending.length ? d.pending.map((w) => entryRow(w, { admin: true, actions: `
            <button class="btn btn-small" data-approve="${w.id}" data-what="${esc(w.company.name)} · ${rs(w.amount)}">Approve</button>
            <button class="btn btn-ghost btn-small" data-reject="${w.id}" data-what="${esc(w.company.name)} · ${rs(w.amount)}">Reject</button>` })).join('') : '<p class="muted">Nothing to check.</p>'}</div>
      </div>
      <div class="panel-card">
        <h2>Wallets</h2>
        <div class="rows">${d.wallets.length ? d.wallets.map((w) => `
          <div class="row"><div class="row-main"><b>${esc(w.name)}</b>
            <div class="muted small">${esc(Ibraya.COMPANY_KINDS[w.kind] ? Ibraya.COMPANY_KINDS[w.kind].en : w.kind)} · ${esc(w.city)}${w.phone ? ` · ${esc(localPhone(w.phone))}` : ''}</div></div>
            <div class="row-actions"><span class="price ${w.balance < 0 ? 'minus' : ''}">${rs(w.balance)}</span>
              <button class="btn btn-ghost btn-small" data-adjust="${w.id}" data-name="${esc(w.name)}">Add / take</button></div></div>`).join('')
          : '<p class="muted">No carriers, brokers or dispatchers yet.</p>'}</div>
      </div>
      <div class="panel-card narrow">
        <h2>JazzCash account shown to companies</h2>
        <form id="pay-form" novalidate>
          <label class="field"><span>Account name</span><input name="name" maxlength="80" value="${esc(j.name)}"></label>
          <div class="field-pair">
            <label class="field"><span>Account number</span><input name="number" maxlength="14" inputmode="numeric" value="${esc(j.number)}"></label>
            <label class="field"><span>Till ID</span><input name="till" maxlength="12" inputmode="numeric" value="${esc(j.till_id)}"></label>
          </div>
          <div class="error" id="pay-error"></div>
          <button class="btn btn-small" id="pay-save">Save</button>
        </form>
      </div>
      ${d.recent.length ? `<div class="panel-card"><h2>Recent</h2><div class="rows">${d.recent.map((w) => entryRow(w, { admin: true })).join('')}</div></div>` : ''}`;
    wireCommon(body);
    const again = () => renderAdmin(body, { rpc, busy });
    body.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
      if (!(await Ibraya.dialog({ title: `Approve ${b.dataset.what}?`, message: 'Only if you can see this payment in the JazzCash Business app.', okText: 'Approve' }))) return;
      busy(b, null, async () => { await rpc('admin_decide_deposit', { p_entry: b.dataset.approve, p_approve: true, p_note: '' }); await again(); });
    }));
    body.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
      const note = await Ibraya.dialog({ title: `Reject ${b.dataset.what}?`, message: 'Tell them why (they see this).', okText: 'Reject', danger: true,
        input: { placeholder: 'e.g. No payment with this TID', validate: (v) => (v.trim() ? '' : 'Write the reason') } });
      if (note == null) return;
      busy(b, null, async () => { await rpc('admin_decide_deposit', { p_entry: b.dataset.reject, p_approve: false, p_note: note }); await again(); });
    }));
    body.querySelectorAll('[data-adjust]').forEach((b) => b.addEventListener('click', async () => {
      const amount = await Ibraya.dialog({ title: `Add or take money: ${b.dataset.name}`, message: 'Rupees to add, or with − in front to take out (e.g. 5000 or -1000).', okText: 'Next',
        input: { type: 'text', placeholder: 'e.g. 5000', validate: (v) => (/^-?\d{1,7}$/.test(v.trim()) && Number(v) !== 0 ? '' : 'Enter a number, e.g. 5000 or -1000') } });
      if (amount == null) return;
      const note = await Ibraya.dialog({ title: `${Number(amount) > 0 ? 'Add' : 'Take'} ${rs(Math.abs(Number(amount)))}`, message: 'Why? (the company sees this)', okText: 'Save',
        input: { placeholder: 'e.g. Cash received at office', validate: (v) => (v.trim() ? '' : 'Write the reason') } });
      if (note == null) return;
      busy(b, null, async () => { await rpc('admin_wallet_adjust', { p_company: b.dataset.adjust, p_amount: Number(amount), p_note: note }); await again(); });
    }));
    const pf = body.querySelector('#pay-form');
    pf.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(body.querySelector('#pay-save'), body.querySelector('#pay-error'), async () => {
        await rpc('admin_set_pay_info', { p_name: pf.name.value, p_number: pf.number.value, p_till_id: pf.till.value.trim() });
        await again();
      });
    });
  }

  return { renderWallet, renderAdmin };
})();
