// Transport Hub: one invoice, printable. The carrier adds extra charges and confirms payment;
// the shipper reports how it paid.
(async () => {
  const { sb } = Ibraya;
  const $ = (id) => document.getElementById(id);
  const main = $('main');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rs = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-PK');
  const date = (t) => (t ? new Date(String(t).length === 10 ? t + 'T00:00:00' : t).toLocaleDateString('en-PK', { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const localPhone = (p) => (p && p.startsWith('+92') ? '0' + p.slice(3) : p || '');
  const EQUIPMENT = { container_20: '20ft container', container_40: '40ft container', flatbed: 'Flatbed / trailer', open_body: 'Open body truck', covered: 'Covered / box truck', other: 'Truck' };
  const TRADE = { import: 'Import', export: 'Export', domestic: 'Domestic' };
  const METHODS = { bank: 'Bank transfer', cash: 'Cash', jazzcash: 'JazzCash', easypaisa: 'Easypaisa', cheque: 'Cheque', other: 'Other' };
  const STATUS = { unpaid: ['Unpaid', 'warn'], paid_reported: ['Payment reported, waiting for the carrier to confirm', 'warn'], paid: ['Paid ✓', 'ok'] };

  $('print').addEventListener('click', () => window.print());
  const id = new URLSearchParams(location.search).get('id');
  const me = await Ibraya.guard('/hub');
  if (!me) return;

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw error;
    return data;
  }
  async function busy(btn, errEl, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    if (errEl) errEl.textContent = '';
    try { await fn(); } catch (err) {
      if (errEl) errEl.textContent = Ibraya.friendlyError(err); else Ibraya.message('Something went wrong', Ibraya.friendlyError(err));
    } finally { btn.disabled = false; }
  }

  const party = (label, c) => `<div class="inv-party"><small>${label}</small><b>${esc(c.name)}</b>
    <span>${esc([c.address, c.city].filter(Boolean).join(', '))}</span>
    ${c.phone ? `<span>Phone ${esc(localPhone(c.phone))}</span>` : ''}${c.ntn ? `<span>NTN ${esc(c.ntn)}</span>` : ''}</div>`;

  function render(d) {
    const i = d.invoice;
    const l = d.load;
    const [label, cls] = STATUS[i.status];
    const late = i.status !== 'paid' && new Date(i.due_date + 'T23:59:59') < new Date();
    document.title = `${i.number} · Transport Hub`;
    const lines = [[`Freight: ${l.pickup_city} → ${l.drop_city} · ${EQUIPMENT[l.equipment]}${l.trucks > 1 ? ` × ${l.trucks}` : ''}`, i.freight, null],
      ...i.extras.map((e, n) => [e.label, e.amount, n])];
    main.innerHTML = `
      <article class="invoice">
        <div class="inv-head">
          <div class="brand"><div class="brand-mark"><img src="/img/logo.png" alt=""></div><div>Transport Hub<small>Freight invoice</small></div></div>
          <div class="inv-no"><b>${esc(i.number)}</b><span>Issued ${date(i.created_at)}</span><span>Due ${date(i.due_date)}</span>
            <span class="pill small ${late ? 'bad' : cls}">${late ? 'Overdue' : label}</span></div>
        </div>
        <div class="inv-parties">${party('From (carrier)', d.carrier)}${party('Bill to (shipper)', d.shipper)}</div>
        <dl class="details inv-load">
          <dt>Shipment</dt><dd>${TRADE[l.trade]} · ${esc(l.pickup_place ? `${l.pickup_place}, ${l.pickup_city}` : l.pickup_city)} → ${esc(l.drop_place ? `${l.drop_place}, ${l.drop_city}` : l.drop_city)}</dd>
          <dt>Pickup date</dt><dd>${date(l.pickup_date)}</dd>
          ${l.delivered_at ? `<dt>Delivered</dt><dd>${date(l.delivered_at)}</dd>` : ''}
          ${l.cargo ? `<dt>Cargo</dt><dd>${esc(l.cargo)}${l.weight_tons ? ` · ${Number(l.weight_tons)} tons` : ''}</dd>` : ''}
          ${l.container_no ? `<dt>Container / BL</dt><dd>${esc(l.container_no)}</dd>` : ''}
          ${d.drivers.length ? `<dt>Driver${d.drivers.length > 1 ? 's' : ''}</dt><dd>${d.drivers.map((x) => esc(x.name)).join(', ')}</dd>` : ''}
        </dl>
        <table class="inv-lines">
          <thead><tr><th>Description</th><th>Amount</th></tr></thead>
          <tbody>${lines.map(([t, a, n]) => `<tr><td>${esc(t)}${d.can_edit && n != null ? ` <button class="link no-print" data-remove="${n}">remove</button>` : ''}</td><td>${rs(a)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td>Total</td><td>${rs(i.total)}</td></tr></tfoot>
        </table>
        ${i.paid_method ? `<p class="muted">Paid by ${esc(METHODS[i.paid_method])}${i.paid_ref ? `, reference ${esc(i.paid_ref)}` : ''}${i.paid_reported_at ? ` on ${date(i.paid_reported_at)}` : ''}${i.paid_at ? ` · received ${date(i.paid_at)}` : ''}.</p>` : ''}
        <p class="muted small">Booked and delivered through Transport Hub. The carrier and the shipper settle payment directly.</p>
      </article>
      ${d.can_edit ? `<div class="panel-card narrow no-print"><h2>Add a charge · اضافی چارج</h2>
        <form id="charge-form" class="assign-form" novalidate>
          <input name="label" class="select" maxlength="80" placeholder="e.g. Detention 1 day, toll, labour">
          <input name="amount" class="select" type="number" min="1" step="100" inputmode="numeric" placeholder="Rs" style="max-width:130px">
          <button class="btn btn-small">Add</button>
        </form><div class="error" id="charge-error"></div></div>` : ''}
      ${d.can_report ? `<div class="panel-card narrow no-print"><h2>I have paid · ادائیگی ہو گئی</h2>
        <form id="paid-form" novalidate>
          <label class="field"><span>How did you pay?</span><select name="method" class="select">${Object.entries(METHODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="field"><span>Reference / transaction ID <i>(optional)</i></span><input name="ref" maxlength="80"></label>
          <div class="error" id="paid-error"></div>
          <button class="btn" id="paid-submit">Tell the carrier I've paid ${rs(i.total)}</button>
        </form></div>` : ''}
      ${d.can_confirm ? `<div class="panel-card narrow no-print"><h2>${i.status === 'paid_reported' ? 'The shipper says it has paid' : 'Payment received?'}</h2>
        <p class="muted">${i.status === 'paid_reported' ? 'Check your account, then confirm.' : 'If the shipper paid you outside the app (e.g. cash), mark it here.'}</p>
        <div class="form-actions">
          ${i.status === 'paid_reported' ? '<button class="btn btn-ghost btn-small" id="not-received">Not received</button>' : ''}
          <button class="btn btn-small" id="received">Yes, I received ${rs(i.total)}</button>
        </div><div class="error" id="confirm-error"></div></div>` : ''}`;

    const cf = $('charge-form');
    if (cf) cf.addEventListener('submit', (e) => {
      e.preventDefault();
      busy(cf.querySelector('button'), $('charge-error'), async () => {
        const amount = parseInt(cf.amount.value, 10);
        if (cf.label.value.trim().length < 2) throw new Error('Write what the charge is for');
        if (!amount || amount < 1) throw new Error('Enter the amount in rupees');
        render(await rpc('invoice_add_charge', { p_invoice: id, p_label: cf.label.value, p_amount: amount }));
      });
    });
    main.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => busy(b, null, async () => {
      render(await rpc('invoice_remove_charge', { p_invoice: id, p_index: Number(b.dataset.remove) }));
    })));
    const pf = $('paid-form');
    if (pf) pf.addEventListener('submit', (e) => {
      e.preventDefault();
      busy($('paid-submit'), $('paid-error'), async () => render(await rpc('invoice_report_paid', { p_invoice: id, p_method: pf.method.value, p_ref: pf.ref.value })));
    });
    const yes = $('received');
    if (yes) yes.addEventListener('click', async () => {
      if (!(await Ibraya.dialog({ title: `Received ${rs(i.total)}?`, message: 'The invoice is marked paid and the shipper is told.', okText: 'Yes, received' }))) return;
      busy(yes, $('confirm-error'), async () => render(await rpc('invoice_confirm_paid', { p_invoice: id, p_received: true })));
    });
    const no = $('not-received');
    if (no) no.addEventListener('click', async () => {
      if (!(await Ibraya.dialog({ title: 'Payment not received?', message: 'The shipper is told that it has not arrived.', okText: 'Not received', danger: true }))) return;
      busy(no, $('confirm-error'), async () => render(await rpc('invoice_confirm_paid', { p_invoice: id, p_received: false })));
    });
  }

  try {
    if (!id) throw new Error('Invoice not found');
    render(await rpc('invoice_detail', { p_invoice: id }));
  } catch (err) {
    main.innerHTML = `<section class="panel-card"><p class="error">${esc(Ibraya.friendlyError(err))}</p><a class="btn btn-ghost" href="/hub">Back to the hub</a></section>`;
  }
})();
