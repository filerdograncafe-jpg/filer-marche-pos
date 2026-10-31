// FILER マルシェレジ
// 会計・売上保存・持ち込み在庫・イベント・バックアップ
const CATEGORIES = ['ジャーキー', 'アキレス', '冷凍商品', 'その他'];
const METHOD_LABEL = { cash: '現金', paypay: 'PayPay' };
const LOW_STOCK = 3; // 残りがこの数以下で警告表示

const state = {
  products: [],
  event: null,           // 現在のイベント
  stock: {},             // productId -> {managed, carryIn, sold, adjust, remaining}
  cart: new Map(),       // productId -> qty
  category: CATEGORIES[0],
  method: null,
  checkoutId: null,      // 会計ごとの固有ID（二重会計防止）
  saving: false,
};

const $ = (s) => document.querySelector(s);
const yen = (n) => '¥' + Math.round(n).toLocaleString('ja-JP');
const toInt = (v) => { const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function localDateKey(d = new Date()) {
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

// ---------- 起動 ----------
(async function start() {
  try {
    await DB.init();
  } catch (e) {
    document.body.innerHTML = '<p style="padding:24px">データ保存の準備に失敗しました。Safariのプライベートブラウズでは使えません。通常モードで開いてください。</p>';
    return;
  }
  await reload();
  bindUI();
  renderAll();
  updateNet();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // 新しいバージョンが届いたら、会計中でなければ自動で読み込み直す（データは消えません）
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      const busy = state.cart.size > 0 || !$('#checkout').hidden || !$('#dialog').hidden;
      if (!busy) location.reload(); else toast('新しいバージョンがあります。会計後にアプリを開き直してください');
    });
  }
})();

async function reload() {
  state.products = (await DB.all('products')).sort((a, b) => a.sort - b.sort);
  const cur = await DB.get('meta', 'currentEventId');
  state.event = cur ? await DB.get('events', cur.value) : null;
  await reloadStock();
}
async function reloadStock() {
  state.stock = state.event ? stockFromMoves(await DB.movesFor(state.event.id)) : {};
}
// 手入力の商品（その会計だけで使う一時的な商品）
state.tempProducts = [];
const productById = (id) => state.products.find((p) => p.id === id) || state.tempProducts.find((p) => p.id === id);
const stockOf = (id) => state.stock[id] && state.stock[id].managed ? state.stock[id] : null;
// カートに入っている分を差し引いた「あと何個入れられるか」（在庫管理していない商品は無制限）
function addable(id) {
  const st = stockOf(id);
  if (!st) return Infinity;
  return st.remaining - (state.cart.get(id) || 0);
}

// ---------- 計算（すべて整数の円で計算） ----------
function cartLines() {
  const lines = [];
  for (const [id, qty] of state.cart) {
    const p = productById(id);
    if (!p || qty <= 0) continue;
    lines.push({ productId: p.id, name: p.name, category: p.category, price: p.price, qty, subtotal: p.price * qty });
  }
  return lines;
}
function totals() {
  const lines = cartLines();
  const subtotal = lines.reduce((s, l) => s + l.subtotal, 0);
  const discount = Math.min(toInt($('#discount').value), subtotal);
  const total = subtotal - discount;
  const count = lines.reduce((s, l) => s + l.qty, 0);
  return { lines, subtotal, discount, total, count };
}

// ---------- 画面描画 ----------
function renderAll() {
  renderBanner(); renderCats(); renderGrid(); renderCartBar();
  renderStock(); renderSales(); renderEventBox(); renderAdmin();
}

function renderBanner() {
  $('#eventBanner').innerHTML = state.event
    ? `<div class="event-chip">${esc(state.event.name)}　${esc(state.event.date)}</div>`
    : `<button class="warn-banner" id="goEvent">イベントが未登録です。タップして登録してください</button>`;
  const name = state.event ? `（${esc(state.event.name)}）` : '';
  $('#stockEventName').innerHTML = name; $('#salesEventName').innerHTML = name;
}

function renderCats() {
  $('#catTabs').innerHTML = CATEGORIES.map((c) =>
    `<button class="${c === state.category ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
}

function renderGrid() {
  const items = state.products.filter((p) => !p.hidden && p.category === state.category);
  $('#productGrid').innerHTML = items.map((p) => {
    const q = state.cart.get(p.id) || 0;
    const st = stockOf(p.id);
    const soldOut = st && st.remaining <= 0;
    const left = st ? st.remaining - q : null;
    let stockLabel = '';
    if (st) stockLabel = soldOut ? '<span class="stock out">売り切れ</span>'
      : `<span class="stock ${st.remaining <= LOW_STOCK ? 'low' : ''}">残り${st.remaining}</span>`;
    return `<button class="product ${q ? 'in-cart' : ''} ${soldOut ? 'soldout' : ''}" data-id="${p.id}" ${soldOut || left === 0 && !q ? 'disabled' : ''}>
      ${q ? `<span class="badge">${q}</span>` : ''}
      <span class="pname">${esc(p.name)}</span>
      <span class="pfoot"><span class="pprice">${yen(p.price)}</span>${stockLabel}</span>
    </button>`;
  }).join('') || '<p class="note">この分類の商品はありません</p>';
}

function renderCartBar() {
  const t = totals();
  $('#cartCount').textContent = `${t.count}点`;
  $('#cartTotal').textContent = yen(t.subtotal);
  $('#openCheckout').disabled = t.count === 0;
}

function renderCheckout() {
  const t = totals();
  $('#cartList').innerHTML = t.lines.map((l) => `
    <div class="line">
      <div class="lname">${esc(l.name)}<small>${yen(l.price)}</small></div>
      <div class="qty">
        <button data-dec="${l.productId}">−</button>
        <span>${l.qty}</span>
        <button data-inc="${l.productId}" ${addable(l.productId) <= 0 ? 'disabled' : ''}>＋</button>
      </div>
      <div class="lsub">${yen(l.subtotal)}</div>
      <button class="del" data-del="${l.productId}" aria-label="削除">×</button>
    </div>`).join('') || '<p class="note">カートは空です</p>';
  $('#ckSubtotal').textContent = yen(t.subtotal);
  $('#ckTotal').textContent = yen(t.total);
  document.querySelectorAll('.method').forEach((b) => b.classList.toggle('active', b.dataset.method === state.method));
  $('#cashArea').hidden = state.method !== 'cash';

  let err = '';
  let ok = t.count > 0 && !!state.method;
  if (toInt($('#discount').value) > t.subtotal) err = '割引が小計を超えています';
  for (const l of t.lines) {
    const st = stockOf(l.productId);
    if (st && l.qty > st.remaining) { ok = false; err = `${l.name} の在庫が足りません（残り${st.remaining}個）`; }
  }
  if (state.method === 'cash') {
    const rec = toInt($('#received').value);
    if (rec > 0) {
      const ch = rec - t.total;
      $('#change').textContent = ch >= 0 ? yen(ch) : '不足';
      if (ch < 0) { ok = false; err = `お預かりが ${yen(-ch)} 不足しています`; }
    } else {
      $('#change').textContent = '—';
      ok = false;
    }
  }
  $('#ckError').textContent = err;
  $('#confirmBtn').disabled = !ok || state.saving;
}

async function eventSales() {
  const evId = state.event ? state.event.id : null;
  return (await DB.all('sales')).filter((s) => s.eventId === evId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function renderSales() {
  const list = await eventSales();
  const valid = list.filter((s) => s.status === 'completed');
  const sum = valid.reduce((s, x) => s + x.total, 0);
  const disc = valid.reduce((s, x) => s + x.discount, 0);
  const byMethod = {};
  valid.forEach((s) => { byMethod[s.method] = (byMethod[s.method] || 0) + s.total; });
  $('#todayTotal').textContent = yen(sum);
  $('#historySummary').innerHTML = `
    <div><small>売上合計</small><b>${yen(sum)}</b></div>
    <div><small>会計件数</small><b>${valid.length}件</b></div>
    <div><small>客単価</small><b>${valid.length ? yen(Math.round(sum / valid.length)) : '—'}</b></div>
    <div><small>現金</small><b>${yen(byMethod.cash || 0)}</b></div>
    <div><small>PayPay</small><b>${yen(byMethod.paypay || 0)}</b></div>
    <div><small>割引合計</small><b>${yen(disc)}</b></div>`;

  // 商品別（割引は会計単位なので、商品別売上は割引前の金額）
  const byProduct = {};
  valid.forEach((s) => s.items.forEach((i) => {
    const x = byProduct[i.name] || (byProduct[i.name] = { qty: 0, amount: 0 });
    x.qty += i.qty; x.amount += i.subtotal;
  }));
  const rows = Object.entries(byProduct).sort((a, b) => b[1].amount - a[1].amount);
  $('#productSales').innerHTML = rows.length
    ? `<table class="tbl"><tr><th>商品</th><th>個数</th><th>売上</th></tr>${rows.map(([n, x]) =>
      `<tr><td>${esc(n)}</td><td>${x.qty}</td><td>${yen(x.amount)}</td></tr>`).join('')}</table>
      ${disc ? `<p class="note">商品別売上は割引前の金額です（割引合計 ${yen(disc)}）</p>` : ''}`
    : '<p class="note">まだ販売がありません</p>';

  $('#historyList').innerHTML = list.map((s) => {
    const time = new Date(s.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    const items = s.items.map((i) => `${esc(i.name)}×${i.qty}`).join('、');
    return `<div class="sale ${s.status}">
      <div class="sale-head"><span>${time}　${METHOD_LABEL[s.method]}</span><b>${yen(s.total)}</b></div>
      <div class="sale-items">${items}${s.discount ? `（割引 −${yen(s.discount)}）` : ''}</div>
      ${s.status === 'voided'
        ? `<div class="voided-label">取消済み</div>`
        : `<button class="btn ghost small" data-void="${s.id}">この会計を取消</button>`}
    </div>`;
  }).join('') || '<p class="note">会計はまだありません</p>';
}

function renderStock() {
  if (!state.event) { $('#stockList').innerHTML = '<p class="note">先に「設定」でイベントを登録してください。</p>'; return; }
  $('#stockList').innerHTML = CATEGORIES.map((c) => {
    const items = state.products.filter((p) => p.category === c && !p.hidden);
    if (!items.length) return '';
    return `<h3>${esc(c)}</h3>` + items.map((p) => {
      const st = stockOf(p.id);
      return `<div class="stock-row ${st && st.remaining <= 0 ? 'out' : ''}">
        <div class="sname">${esc(p.name)}</div>
        ${st ? `<div class="snums"><span>持込<b>${st.carryIn}</b></span><span>販売<b>${st.sold}</b></span>${st.adjust ? `<span>修正<b>${st.adjust > 0 ? '+' : ''}${st.adjust}</b></span>` : ''}<span>残り<b class="${st.remaining <= LOW_STOCK ? 'low' : ''}">${st.remaining}</b></span></div>`
          : '<div class="snums muted">在庫未登録</div>'}
        <div class="sbtns">
          <button class="btn small" data-carry="${p.id}">持込</button>
          ${st ? `<button class="btn small ghost" data-adjust="${p.id}">修正</button>` : ''}
        </div>
      </div>`;
    }).join('');
  }).join('');
}

function renderEventBox() {
  $('#eventBox').innerHTML = state.event
    ? `<div class="card"><b>${esc(state.event.name)}</b><br><small>${esc(state.event.date)}　${esc(state.event.place)}</small></div>
       <button class="btn wide mt" id="newEventBtn">新しいイベントを始める</button>`
    : `<button class="btn primary wide" id="newEventBtn">イベントを登録する</button>`;
}

function renderAdmin() {
  $('#productAdminList').innerHTML = CATEGORIES.map((c) => {
    const items = state.products.filter((p) => p.category === c);
    return `<h3>${esc(c)}</h3>` + items.map((p) => `
      <button class="admin-item ${p.hidden ? 'hidden-item' : ''}" data-edit="${p.id}">
        <span>${esc(p.name)}${p.hidden ? '（非表示）' : ''}</span><span>${yen(p.price)}</span>
      </button>`).join('');
  }).join('');
}

// ---------- 操作 ----------
function showView(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $('#cartBar').style.display = name === 'register' ? '' : 'none';
  window.scrollTo(0, 0);
  if (name === 'sales') renderSales();
  if (name === 'stock') renderStock();
}

function bindUI() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]'); if (b) showView(b.dataset.view);
  });
  $('#eventBanner').addEventListener('click', (e) => { if (e.target.id === 'goEvent') { showView('settings'); newEvent(); } });

  $('#catTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cat]'); if (!b) return;
    state.category = b.dataset.cat; renderCats(); renderGrid();
  });

  $('#productGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.product'); if (!b || b.disabled) return;
    const id = b.dataset.id;
    if (addable(id) <= 0) { toast('在庫が足りません'); return; }
    state.cart.set(id, (state.cart.get(id) || 0) + 1);
    renderGrid(); renderCartBar();
  });

  $('#openCheckout').addEventListener('click', openCheckout);
  $('#closeCheckout').addEventListener('click', closeCheckout);

  $('#cartList').addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    const id = t.dataset.inc || t.dataset.dec || t.dataset.del;
    if (!id) return;
    const q = state.cart.get(id) || 0;
    if (t.dataset.inc && addable(id) > 0) state.cart.set(id, q + 1);
    if (t.dataset.dec) { if (q <= 1) state.cart.delete(id); else state.cart.set(id, q - 1); }
    if (t.dataset.del) state.cart.delete(id);
    renderCheckout(); renderGrid(); renderCartBar();
    if (state.cart.size === 0) closeCheckout();
  });

  document.querySelector('.methods').addEventListener('click', (e) => {
    const b = e.target.closest('.method'); if (!b) return;
    state.method = b.dataset.method;
    if (state.method !== 'cash') $('#received').value = '';
    renderCheckout();
  });

  $('#discount').addEventListener('input', renderCheckout);
  $('#received').addEventListener('input', renderCheckout);
  document.querySelector('.quick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-q]'); if (!b) return;
    $('#received').value = b.dataset.q === 'exact' ? totals().total : b.dataset.q;
    renderCheckout();
  });

  $('#confirmBtn').addEventListener('click', confirmSale);
  $('#nextBtn').addEventListener('click', () => { $('#done').hidden = true; });

  $('#historyList').addEventListener('click', (e) => {
    const id = e.target.dataset.void; if (!id) return;
    confirmDialog('この会計を取消しますか？', '取消した会計は履歴に「取消済み」として残り、売上から除かれ、在庫も元に戻ります。', '取消する', async () => {
      await DB.voidSale(id);
      await reloadStock();
      renderAll();
    });
  });

  $('#stockList').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.carry) editCarryIn(b.dataset.carry);
    if (b.dataset.adjust) editAdjust(b.dataset.adjust);
  });

  $('#eventBox').addEventListener('click', (e) => { if (e.target.id === 'newEventBtn') newEvent(); });
  $('#backupBtn').addEventListener('click', backup);
  $('#csvBtn').addEventListener('click', salesCsv);
  $('#stockCsvBtn').addEventListener('click', stockCsv);
  $('#restoreFile').addEventListener('change', restore);

  $('#manualBtn').addEventListener('click', manualItem);
  $('#addProductBtn').addEventListener('click', () => editProduct(null));
  $('#productAdminList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]'); if (b) editProduct(b.dataset.edit);
  });

  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
}

function openCheckout() {
  if (!state.checkoutId) state.checkoutId = uid('s');
  $('#checkout').hidden = false;
  renderCheckout();
}
function closeCheckout() { $('#checkout').hidden = true; }

async function confirmSale() {
  if (state.saving) return;            // 連打防止
  const t = totals();
  if (!t.count || !state.method) return;
  const received = state.method === 'cash' ? toInt($('#received').value) : null;
  if (state.method === 'cash' && received < t.total) return;

  state.saving = true; $('#confirmBtn').disabled = true;
  const now = new Date();
  const sale = {
    id: state.checkoutId || uid('s'),
    createdAt: now.toISOString(),
    dateKey: localDateKey(now),
    eventId: state.event ? state.event.id : null,
    items: t.lines,                    // 販売当時の商品名・価格を保存
    subtotal: t.subtotal,
    discount: t.discount,
    total: t.total,
    method: state.method,
    received,
    change: received != null ? received - t.total : null,
    status: 'completed',
  };
  try {
    const r = await DB.commitSale(sale);
    if (!r.ok) throw new Error(r.reason);
    state.cart.clear(); state.tempProducts = []; state.method = null; state.checkoutId = null;
    $('#discount').value = ''; $('#received').value = '';
    closeCheckout();
    $('#doneTotal').textContent = yen(sale.total);
    $('#doneChange').textContent = sale.method === 'cash' ? `お釣り ${yen(sale.change)}` : 'PayPay';
    $('#done').hidden = false;
    await reloadStock();
    renderAll();
  } catch (e) {
    $('#ckError').textContent = '会計できませんでした：' + e.message;
    await reloadStock();
  } finally {
    state.saving = false;
    if (!$('#checkout').hidden) renderCheckout();
  }
}

// ---------- 手入力の商品 ----------
function manualItem() {
  formDialog('手入力で商品を追加', `
    <label>商品名<input id="fName" placeholder="例：限定ジャーキー"></label>
    <label>販売価格（円・税込）<input id="fPrice" type="number" inputmode="numeric"></label>
    <label>数量<input id="fQty" type="number" inputmode="numeric" value="1"></label>
    <label class="check"><input type="checkbox" id="fSave"> 商品として登録する（次回からボタンで選べる）</label>
    <label id="fCatWrap" hidden>カテゴリ<select id="fCat">${CATEGORIES.map((c) => `<option ${c === state.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>`,
  async () => {
    const name = $('#fName').value.trim() || '手入力商品';
    const price = toInt($('#fPrice').value);
    const qty = toInt($('#fQty').value) || 1;
    if (price <= 0) return '価格を入力してください';
    let id;
    if ($('#fSave').checked) {
      const cat = $('#fCat').value;
      const p = { id: uid('p'), name, price, category: cat, hidden: false, sort: Date.now() };
      await DB.put('products', p);
      state.products = (await DB.all('products')).sort((a, b) => a.sort - b.sort);
      id = p.id; state.category = cat;
    } else {
      id = uid('t');
      state.tempProducts.push({ id, name, price, category: '手入力', hidden: true, temp: true });
    }
    state.cart.set(id, (state.cart.get(id) || 0) + qty);
    renderAll();
    toast(`${name} をカートに追加しました`);
  }, '追加');
  $('#fSave').onchange = () => { $('#fCatWrap').hidden = !$('#fSave').checked; };
}

// ---------- 在庫 ----------
function editCarryIn(id) {
  const p = productById(id); const st = stockOf(id);
  formDialog(`持ち込み数：${p.name}`, `<label>持ち込み数（個）<input id="fQty" type="number" inputmode="numeric" value="${st ? st.carryIn : ''}"></label>
    ${st && st.sold ? `<p class="note">販売済み ${st.sold}個 は自動で差し引かれます。</p>` : ''}`, async () => {
    const v = $('#fQty').value.trim();
    if (v === '' || toInt(v) < 0) return '持ち込み数を入力してください';
    const delta = toInt(v) - (st ? st.carryIn : 0);
    if (st && delta === 0) return;
    await DB.addMove({ eventId: state.event.id, productId: id, type: 'carryIn', qty: delta, note: '持込数設定' });
    await reloadStock(); renderAll();
  });
}

function editAdjust(id) {
  const p = productById(id); const st = stockOf(id);
  formDialog(`在庫の修正：${p.name}`, `<p>今の残り：<b>${st.remaining}個</b></p>
    <label>実際の残り（個）<input id="fQty" type="number" inputmode="numeric"></label>
    <label>理由<input id="fNote" placeholder="例：破損、試食、数え直し"></label>`, async () => {
    const v = $('#fQty').value.trim();
    if (v === '') return '実際の残りを入力してください';
    const delta = toInt(v) - st.remaining;
    if (delta === 0) return;
    await DB.addMove({ eventId: state.event.id, productId: id, type: 'adjust', qty: delta, note: $('#fNote').value.trim() });
    await reloadStock(); renderAll();
  });
}

// ---------- イベント ----------
function newEvent() {
  formDialog('イベントを登録', `<label>イベント名<input id="fName" placeholder="例：〇〇マルシェ"></label>
    <label>開催日<input id="fDate" type="date" value="${localDateKey()}"></label>
    <label>開催場所<input id="fPlace"></label>
    ${state.event ? '<p class="note">今のイベントのデータは残ります。新しいイベントは在庫・売上がゼロから始まります。</p>' : ''}`, async () => {
    const name = $('#fName').value.trim();
    if (!name) return 'イベント名を入力してください';
    const ev = { id: uid('e'), name, date: $('#fDate').value, place: $('#fPlace').value.trim(), createdAt: new Date().toISOString() };
    await DB.put('events', ev);
    await DB.put('meta', { key: 'currentEventId', value: ev.id });
    state.cart.clear();
    await reload(); renderAll();
  });
}

// ---------- バックアップ・CSV ----------
async function saveFile(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  // iPhoneでは共有メニューから「"ファイル"に保存」やGoogleドライブを選べる
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

async function backup() {
  const data = await DB.exportAll();
  await saveFile(`filer-pos-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
  await DB.put('meta', { key: 'lastBackupAt', value: new Date().toISOString() });
}

async function salesCsv() {
  const list = (await eventSales()).reverse();
  const rows = [['会計ID', '日時', '状態', '決済', '商品', 'カテゴリ', '単価', '数量', '小計', '会計割引', '会計合計']];
  list.forEach((s) => s.items.forEach((i, idx) => rows.push([
    s.id, new Date(s.createdAt).toLocaleString('ja-JP'), s.status === 'voided' ? '取消' : '確定', METHOD_LABEL[s.method],
    i.name, i.category, i.price, i.qty, i.subtotal, idx === 0 ? s.discount : '', idx === 0 ? s.total : '',
  ])));
  await saveFile(`filer-sales-${stamp()}.csv`, toCsv(rows), 'text/csv');
}

async function stockCsv() {
  const rows = [['商品', 'カテゴリ', '持込', '販売', '修正', '残り']];
  state.products.forEach((p) => {
    const st = stockOf(p.id); if (!st) return;
    rows.push([p.name, p.category, st.carryIn, st.sold, st.adjust, st.remaining]);
  });
  await saveFile(`filer-stock-${stamp()}.csv`, toCsv(rows), 'text/csv');
}

async function restore(e) {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  let data;
  try { data = JSON.parse(await f.text()); } catch (_) { toast('ファイルを読み込めませんでした'); return; }
  if (!data || data.app !== 'filer-marche-pos' || !data.data) { toast('このアプリのバックアップファイルではありません'); return; }
  const n = (k) => (data.data[k] || []).length;
  confirmDialog('バックアップから復元しますか？',
    `今のデータはすべて、このファイルの内容に置き換わります（元に戻せません）。\n作成日時：${new Date(data.exportedAt).toLocaleString('ja-JP')}\n会計 ${n('sales')}件・商品 ${n('products')}件・イベント ${n('events')}件\n念のため、先に今のデータをバックアップしてください。`,
    '復元する', async () => {
      try { await DB.importAll(data); await reload(); renderAll(); toast('復元しました'); }
      catch (err) { toast('復元できませんでした：' + err.message); }
    });
}

// ---------- ダイアログ ----------
function confirmDialog(title, body, okLabel, onOk) {
  $('#dialogBody').innerHTML = `<h3>${esc(title)}</h3><p class="pre">${esc(body)}</p>
    <div class="dialog-actions"><button class="btn ghost" id="dlgCancel">やめる</button>
    <button class="btn danger" id="dlgOk">${esc(okLabel)}</button></div>`;
  $('#dialog').hidden = false;
  $('#dlgCancel').onclick = () => { $('#dialog').hidden = true; };
  $('#dlgOk').onclick = async () => { $('#dialog').hidden = true; await onOk(); };
}

// onSave がエラーメッセージ（文字列）を返したら閉じずに表示する
function formDialog(title, inner, onSave, okLabel = '保存') {
  $('#dialogBody').innerHTML = `<h3>${esc(title)}</h3>${inner}<p id="fErr" class="error"></p>
    <div class="dialog-actions"><button class="btn ghost" id="dlgCancel">やめる</button>
    <button class="btn primary" id="dlgOk">${esc(okLabel)}</button></div>`;
  $('#dialog').hidden = false;
  $('#dlgCancel').onclick = () => { $('#dialog').hidden = true; };
  let busy = false;
  $('#dlgOk').onclick = async () => {
    if (busy) return; busy = true;
    try {
      const err = await onSave();
      if (err) { $('#fErr').textContent = err; return; }
      $('#dialog').hidden = true;
    } finally { busy = false; }
  };
}

function editProduct(id) {
  const p = id ? productById(id) : { id: null, name: '', price: 0, category: state.category, hidden: false };
  formDialog(id ? '商品を編集' : '商品を追加', `
    <label>商品名<input id="fName" value="${esc(p.name)}"></label>
    <label>販売価格（円・税込）<input id="fPrice" type="number" inputmode="numeric" value="${p.price || ''}"></label>
    <label>カテゴリ<select id="fCat">${CATEGORIES.map((c) => `<option ${c === p.category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    ${id ? `<label class="check"><input type="checkbox" id="fHidden" ${p.hidden ? 'checked' : ''}> レジに表示しない</label>` : ''}`, async () => {
    const name = $('#fName').value.trim();
    const price = toInt($('#fPrice').value);
    if (!name) return '商品名を入力してください';
    if (price <= 0) return '価格を入力してください';
    await DB.put('products', {
      ...p, id: p.id || uid('p'), name, price, category: $('#fCat').value,
      hidden: id ? $('#fHidden').checked : false, sort: p.sort != null ? p.sort : Date.now(),
    });
    await reload(); renderAll();
  });
}

let toastTimer;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

function updateNet() {
  $('#netStatus').classList.toggle('offline', !navigator.onLine);
}
