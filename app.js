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
  salesMode: 'event',     // 売上画面：event=イベント別 / daily=日別
  dailyOpen: null,
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
  const reopen = await restoreDraft();
  bindUI(); bindUI2();
  renderAll();
  if (reopen) openCheckout();
  updateNet();
  // iPhoneがアプリを裏に回した時にも、会計途中の内容を保存しておく
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveDraft(); });
  window.addEventListener('pagehide', saveDraft);
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
  // ○%引きは1円未満を切り捨て（お客様に有利な方向）
  const raw = state.discPct ? Math.floor(subtotal * state.discPct / 100) : toInt($('#discount').value);
  const discount = Math.min(raw, subtotal);
  const total = subtotal - discount;
  const count = lines.reduce((s, l) => s + l.qty, 0);
  return { lines, subtotal, discount, total, count };
}

// ---------- 画面描画 ----------
function renderAll() {
  renderBanner(); renderCats(); renderGrid(); renderCartBar();
  renderStock(); renderSales(); renderEventBox(); renderAdmin();
}

const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
function renderBanner() {
  const safariWarn = isStandalone() ? '' : `<div class="warn-banner danger-banner">Safariで開いています。ホーム画面の「FILERレジ」アイコンから開いてください。Safariとアイコンではデータが別々に保存されるため、売上が消えたように見えます。</div>`;
  $('#eventBanner').innerHTML = safariWarn + (state.event
    ? `<div class="event-chip">${esc(state.event.name)}　${esc(state.event.date)}</div>`
    : `<button class="warn-banner" id="goEvent">イベントが未登録です。タップして登録してください</button>`);
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
    const disabled = soldOut || (left === 0 && !q);
    return `<div class="product ${q ? 'in-cart' : ''} ${soldOut ? 'soldout' : ''} ${disabled ? 'disabled' : ''}" data-id="${p.id}" role="button">
      ${q ? `<span class="badge">${q}</span>` : ''}
      <span class="pname">${esc(p.name)}${stockLabel ? `<br>${stockLabel}` : ''}</span>
      <span class="pfoot"><span class="pprice">${yen(p.price)}</span></span>
      ${q ? `<button class="minus" data-minus="${p.id}" aria-label="1つ減らす">−</button>` : ''}
    </div>`;
  }).join('') || '<p class="note">この分類の商品はありません</p>';
}

// ---------- 会計途中の内容の保存・復元 ----------
// 別のアプリ（PayPayなど）に切り替えてiPhoneがアプリを閉じても、カートが消えないようにする
const DRAFT_KEY = 'filer-pos-draft';
let draftReady = false;
function saveDraft() {
  if (!draftReady) return;
  try {
    if (state.cart.size === 0) { localStorage.removeItem(DRAFT_KEY); return; }
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      cart: [...state.cart], temp: state.tempProducts, method: state.method,
      discount: $('#discount').value, discPct: state.discPct || null, received: $('#received').value,
      checkoutId: state.checkoutId, open: !$('#checkout').hidden, category: state.category,
      eventId: state.event ? state.event.id : null, savedAt: Date.now(),
    }));
  } catch (_) {}
}
async function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) {}
  draftReady = true;
  if (!d || !Array.isArray(d.cart)) return false;
  // 12時間以上前のもの、別イベントのもの、すでに確定済みの会計は復元しない
  const evId = state.event ? state.event.id : null;
  if (Date.now() - d.savedAt > 12 * 3600 * 1000 || d.eventId !== evId) { saveDraft(); return false; }
  if (d.checkoutId && await DB.get('sales', d.checkoutId)) { localStorage.removeItem(DRAFT_KEY); return false; }
  state.tempProducts = Array.isArray(d.temp) ? d.temp : [];
  for (const [id, q] of d.cart) if (productById(id) && q > 0) state.cart.set(id, q);
  if (state.cart.size === 0) return false;
  state.method = d.method || null;
  state.discPct = d.discPct || null;
  state.checkoutId = d.checkoutId || null;
  if (d.category) state.category = d.category;
  $('#discount').value = d.discount || '';
  $('#received').value = d.received || '';
  setTimeout(() => toast('会計途中の内容を復元しました'), 300);
  return !!d.open;
}

function renderCartBar() {
  saveDraft();
  const t = totals();
  $('#cartCount').textContent = `${t.count}点`;
  $('#cartTotal').textContent = yen(t.subtotal);
  $('#openCheckout').disabled = t.count === 0;
}

function renderCheckout() {
  saveDraft();
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
  if (state.discPct) $('#discount').value = t.discount || '';
  $('#discLabel').textContent = state.discPct ? `（${state.discPct}%引き）` : '';
  document.querySelectorAll('.disc button').forEach((b) => b.classList.toggle('active',
    state.discPct ? b.dataset.p == state.discPct : (b.dataset.d && b.dataset.d !== '0' && toInt($('#discount').value) === +b.dataset.d)));
  if (!state.discPct && toInt($('#discount').value) > t.subtotal) err = '値引きが小計を超えています';
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

  $('#historyList').innerHTML = list.map((s) => saleCard(s)).join('') || '<p class="note">会計はまだありません</p>';
  if (state.salesMode === 'daily') renderDaily();
}

// 会計1件の表示（履歴・日別で共通）
function saleCard(s, withDate) {
  const d = new Date(s.createdAt);
  const time = (withDate ? d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) + ' ' : '')
    + d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const items = s.items.map((i) => `${esc(i.name)}×${i.qty}`).join('、');
  const tags = (s.editedFrom ? '<span class="tag">修正後</span>' : '') + (s.addedLater ? '<span class="tag">後から追加</span>' : '');
  return `<div class="sale ${s.status}">
    <div class="sale-head"><span>${time}　${METHOD_LABEL[s.method]} ${tags}</span><b>${yen(s.total)}</b></div>
    <div class="sale-items">${items}${s.discount ? `（値引き${s.discountPct ? ' ' + s.discountPct + '%' : ''} −${yen(s.discount)}）` : ''}${s.note ? `<br>メモ：${esc(s.note)}` : ''}</div>
    ${s.status === 'voided' ? `<div class="voided-label">取消済み</div>`
      : s.status === 'edited' ? `<div class="voided-label">修正済み（修正前の記録）</div>`
      : `<div class="sale-btns"><button class="btn small" data-editsale="${s.id}">編集</button><button class="btn ghost small" data-void="${s.id}">取消</button></div>`}
  </div>`;
}

// ---------- 日別の売上 ----------
async function dailySummary() {
  const sales = (await DB.all('sales')).filter((s) => s.status === 'completed');
  const days = {};
  sales.forEach((s) => {
    const d = days[s.dateKey] || (days[s.dateKey] = { date: s.dateKey, count: 0, cash: 0, paypay: 0, total: 0, discount: 0 });
    d.count++; d.total += s.total; d.discount += s.discount || 0;
    if (s.method === 'cash') d.cash += s.total; else if (s.method === 'paypay') d.paypay += s.total;
  });
  return { days: Object.values(days).sort((a, b) => b.date.localeCompare(a.date)), sales };
}
const fmtDate = (k) => { const [y, m, d] = k.split('-'); const w = '日月火水木金土'[new Date(+y, m - 1, +d).getDay()]; return `${+m}/${+d}（${w}）`; };

async function renderDaily() {
  const { days } = await dailySummary();
  $('#dailyTable').innerHTML = days.length
    ? `<table class="tbl daily"><tr><th>日付</th><th>件数</th><th>現金</th><th>PayPay</th><th>合計</th></tr>${days.map((d) =>
      `<tr data-day="${d.date}" class="${state.dailyOpen === d.date ? 'open' : ''}"><td>${fmtDate(d.date)}</td><td>${d.count}</td><td>${yen(d.cash)}</td><td>${yen(d.paypay)}</td><td><b>${yen(d.total)}</b></td></tr>`).join('')}</table>
      <p class="note">日付をタップすると、その日の会計を確認・編集できます。</p>`
    : '<p class="note">まだ会計がありません</p>';
  renderDayDetail();
}
async function renderDayDetail() {
  const day = state.dailyOpen;
  if (!day) { $('#dailyDetail').innerHTML = ''; return; }
  const list = (await DB.all('sales')).filter((s) => s.dateKey === day).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const evs = Object.fromEntries((await DB.all('events')).map((e) => [e.id, e.name]));
  $('#dailyDetail').innerHTML = `<h3>${fmtDate(day)} の会計</h3>` + (list.map((s) =>
    `<div class="ev-tag">${esc(evs[s.eventId] || 'イベント未設定')}</div>` + saleCard(s)).join('') || '<p class="note">会計はありません</p>');
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

async function renderEventBox() {
  const [events, sales, last] = await Promise.all([DB.all('events'), DB.all('sales'), DB.get('meta', 'lastBackupAt')]);
  events.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt.localeCompare(a.createdAt));
  const countBy = {};
  sales.forEach((s) => { if (s.status === 'completed') countBy[s.eventId] = (countBy[s.eventId] || 0) + 1; });
  const cur = state.event ? state.event.id : null;
  const list = events.map((e) => `
    <div class="event-row ${e.id === cur ? 'current' : ''}">
      <div><b>${esc(e.name)}</b><br><small>${esc(e.date)}　${esc(e.place)}　会計${countBy[e.id] || 0}件</small></div>
      ${e.id === cur ? '<span class="cur-label">使用中</span>' : `<button class="btn small ghost" data-switch="${e.id}">切り替え</button>`}
    </div>`).join('');
  $('#eventBox').innerHTML = (list ? `<p class="note">売上・在庫は「使用中」のイベントの分だけ表示されます。過去のイベントを見る時は「切り替え」を押してください。</p>${list}` : '')
    + `<button class="btn ${cur ? '' : 'primary'} wide mt" id="newEventBtn">${cur ? '新しいイベントを始める' : 'イベントを登録する'}</button>`;

  let persisted = null;
  try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch (_) {}
  const latestSale = sales.reduce((m, s) => (s.createdAt > m ? s.createdAt : m), '');
  const needBackup = latestSale && (!last || last.value < latestSale);
  $('#dataStatus').innerHTML = `<div class="card">
    保存されている会計：<b>${sales.length}件</b>（イベント${events.length}件）<br>
    <small>最後のバックアップ：${last ? new Date(last.value).toLocaleString('ja-JP') : 'まだありません'}</small>
    ${needBackup ? '<br><small class="error">バックアップしていない会計があります</small>' : ''}
    ${persisted === false && !isStandalone() ? '<br><small class="error">Safariで開いているため、データが消えやすい状態です</small>' : ''}
  </div>`;
}

async function switchEvent(id) {
  const go = async () => {
    await DB.put('meta', { key: 'currentEventId', value: id });
    state.cart.clear(); state.tempProducts = []; state.method = null; state.checkoutId = null; state.discPct = null;
    await reload(); renderAll(); toast('イベントを切り替えました');
  };
  if (state.cart.size) confirmDialog('イベントを切り替えますか？', 'カートに入っている商品は消えます。', '切り替える', go);
  else await go();
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
    const minus = e.target.closest('.minus');
    if (minus) {
      const id = minus.dataset.minus; const q = state.cart.get(id) || 0;
      if (q <= 1) state.cart.delete(id); else state.cart.set(id, q - 1);
      renderGrid(); renderCartBar(); return;
    }
    const b = e.target.closest('.product'); if (!b || b.classList.contains('disabled')) return;
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

  $('#discount').addEventListener('input', () => { state.discPct = null; renderCheckout(); });
  document.querySelector('.disc').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.p) { state.discPct = +b.dataset.p; }
    else { state.discPct = null; $('#discount').value = b.dataset.d === '0' ? '' : b.dataset.d; }
    renderCheckout();
  });
  $('#received').addEventListener('input', renderCheckout);
  document.querySelector('#cashArea .quick').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-q]'); if (!b) return;
    $('#received').value = b.dataset.q === 'exact' ? totals().total : b.dataset.q;
    renderCheckout();
  });

  $('#confirmBtn').addEventListener('click', confirmSale);
  $('#nextBtn').addEventListener('click', () => { $('#done').hidden = true; });

  $('#salesMode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    state.salesMode = b.dataset.mode;
    document.querySelectorAll('#salesMode button').forEach((x) => x.classList.toggle('active', x === b));
    $('#salesEvent').hidden = state.salesMode !== 'event';
    $('#salesDaily').hidden = state.salesMode !== 'daily';
    if (state.salesMode === 'daily') renderDaily();
  });
  $('#dailyTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-day]'); if (!tr) return;
    state.dailyOpen = state.dailyOpen === tr.dataset.day ? null : tr.dataset.day;
    renderDaily();
  });
  $('#view-sales').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.editsale) editSale(b.dataset.editsale);
    if (b.dataset.addsale) editSale(null);
    if (b.dataset.void && b.closest('#dailyDetail')) voidSaleConfirm(b.dataset.void);
  });
  $('#dailyCsvBtn').addEventListener('click', dailyCsv);
  $('#historyList').addEventListener('click', (e) => {
    const id = e.target.dataset.void; if (!id) return;
    voidSaleConfirm(id);
  });
}

function voidSaleConfirm(id) {
  {
    confirmDialog('この会計を取消しますか？', '取消した会計は履歴に「取消済み」として残り、売上から除かれ、在庫も元に戻ります。', '取消する', async () => {
      await DB.voidSale(id);
      await reloadStock();
      renderAll();
    });
  }
}

function bindUI2() {

  $('#stockList').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.carry) editCarryIn(b.dataset.carry);
    if (b.dataset.adjust) editAdjust(b.dataset.adjust);
  });

  $('#eventBox').addEventListener('click', (e) => {
    if (e.target.id === 'newEventBtn') newEvent();
    if (e.target.dataset.switch) switchEvent(e.target.dataset.switch);
  });
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
function closeCheckout() { $('#checkout').hidden = true; saveDraft(); }

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
    discountPct: state.discPct || null,
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
    $('#discount').value = ''; $('#received').value = ''; state.discPct = null;
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

// ---------- 会計の編集・後から追加 ----------
const toLocalInput = (d) => { const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };

async function editSale(id) {
  const old = id ? await DB.get('sales', id) : null;
  if (id && (!old || old.status !== 'completed')) { toast('この会計は編集できません'); return; }
  const ed = {
    lines: old ? old.items.map((i) => ({ ...i })) : [],
    method: old ? old.method : 'cash',
  };
  const productOpts = state.products.filter((p) => !p.hidden)
    .map((p) => `<option value="${p.id}">${esc(p.category)}｜${esc(p.name)}（${yen(p.price)}）</option>`).join('');
  $('#dialogBody').innerHTML = `<h3>${old ? '会計を編集' : '会計を後から追加'}</h3>
    ${old ? '<p class="note">保存すると、元の会計は「修正済み」として履歴に残り、売上と在庫は修正後の内容で計算し直されます。</p>'
          : `<p class="note">記録し忘れた会計を追加します。${state.event ? `イベント「${esc(state.event.name)}」に追加されます。` : ''}</p>`}
    <label>日時<input id="edWhen" type="datetime-local" value="${toLocalInput(old ? new Date(old.createdAt) : new Date())}"></label>
    <div id="edLines"></div>
    <label>商品を追加<select id="edAdd"><option value="">選んでください</option>${productOpts}<option value="__manual">手入力（名前・値段を入れる）</option></select></label>
    <div id="edManual" hidden class="ed-manual">
      <input id="edMName" placeholder="商品名"><input id="edMPrice" type="number" inputmode="numeric" placeholder="値段">
      <button class="btn small" id="edMAdd">追加</button>
    </div>
    <label>値引き（円）<input id="edDisc" type="number" inputmode="numeric" value="${old && old.discount ? old.discount : ''}" placeholder="0"></label>
    <div class="methods ed-methods">
      <button class="method" data-edmethod="cash">現金</button>
      <button class="method" data-edmethod="paypay">PayPay</button>
    </div>
    <label>メモ（修正の理由など）<input id="edNote" value="${esc(old && old.note ? old.note : '')}"></label>
    <div class="row big"><span>合計</span><span id="edTotal">¥0</span></div>
    <p id="fErr" class="error"></p>
    <div class="dialog-actions"><button class="btn ghost" id="dlgCancel">やめる</button>
    <button class="btn primary" id="dlgOk">保存</button></div>`;
  $('#dialog').hidden = false;
  $('#dialog .sheet-inner').scrollTop = 0;

  const calc = () => {
    const subtotal = ed.lines.reduce((s, l) => s + l.price * l.qty, 0);
    const discount = Math.min(toInt($('#edDisc').value), subtotal);
    return { subtotal, discount, total: subtotal - discount };
  };
  const draw = () => {
    $('#edLines').innerHTML = ed.lines.map((l, i) => `
      <div class="line">
        <div class="lname">${esc(l.name)}<small><input class="ed-price" data-i="${i}" type="number" inputmode="numeric" value="${l.price}">円</small></div>
        <div class="qty"><button data-edq="${i}" data-d="-1">−</button><span>${l.qty}</span><button data-edq="${i}" data-d="1">＋</button></div>
        <div class="lsub">${yen(l.price * l.qty)}</div>
        <button class="del" data-eddel="${i}">×</button>
      </div>`).join('') || '<p class="note">商品がありません。下の「商品を追加」から選んでください。</p>';
    document.querySelectorAll('[data-edmethod]').forEach((b) => b.classList.toggle('active', b.dataset.edmethod === ed.method));
    $('#edTotal').textContent = yen(calc().total);
  };
  draw();

  $('#dialogBody').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edq) { const l = ed.lines[+b.dataset.edq]; l.qty += +b.dataset.d; if (l.qty <= 0) ed.lines.splice(+b.dataset.edq, 1); draw(); }
    if (b.dataset.eddel) { ed.lines.splice(+b.dataset.eddel, 1); draw(); }
    if (b.dataset.edmethod) { ed.method = b.dataset.edmethod; draw(); }
  };
  $('#dialogBody').oninput = (e) => {
    if (e.target.classList.contains('ed-price')) { ed.lines[+e.target.dataset.i].price = toInt(e.target.value); $('#edTotal').textContent = yen(calc().total); }
    if (e.target.id === 'edDisc') $('#edTotal').textContent = yen(calc().total);
  };
  const addLine = (item) => {
    const ex = ed.lines.find((l) => l.productId === item.productId && l.price === item.price && l.name === item.name);
    if (ex) ex.qty++; else ed.lines.push({ ...item, qty: 1 });
    draw();
  };
  $('#edAdd').onchange = () => {
    const v = $('#edAdd').value;
    $('#edManual').hidden = v !== '__manual';
    if (v && v !== '__manual') {
      const p = productById(v);
      addLine({ productId: p.id, name: p.name, category: p.category, price: p.price });
      $('#edAdd').value = '';
    }
  };
  $('#edMAdd').onclick = () => {
    const price = toInt($('#edMPrice').value);
    if (price <= 0) { $('#fErr').textContent = '値段を入力してください'; return; }
    addLine({ productId: uid('t'), name: $('#edMName').value.trim() || '手入力商品', category: '手入力', price });
    $('#edMName').value = ''; $('#edMPrice').value = ''; $('#edManual').hidden = true; $('#edAdd').value = ''; $('#fErr').textContent = '';
  };
  $('#dlgCancel').onclick = () => { $('#dialog').hidden = true; $('#dialogBody').onclick = null; $('#dialogBody').oninput = null; };
  let busy = false;
  $('#dlgOk').onclick = async () => {
    if (busy) return;
    const t = calc();
    if (!ed.lines.length) { $('#fErr').textContent = '商品を1つ以上入れてください'; return; }
    if (ed.lines.some((l) => l.price <= 0)) { $('#fErr').textContent = '値段が0円の商品があります'; return; }
    if (toInt($('#edDisc').value) > t.subtotal) { $('#fErr').textContent = '値引きが小計を超えています'; return; }
    const when = $('#edWhen').value ? new Date($('#edWhen').value) : new Date();
    if (isNaN(when)) { $('#fErr').textContent = '日時を正しく入力してください'; return; }
    busy = true;
    const sale = {
      id: uid('s'),
      createdAt: when.toISOString(),
      dateKey: localDateKey(when),
      eventId: old ? old.eventId : (state.event ? state.event.id : null),
      items: ed.lines.map((l) => ({ productId: l.productId, name: l.name, category: l.category, price: l.price, qty: l.qty, subtotal: l.price * l.qty })),
      subtotal: t.subtotal, discount: t.discount, discountPct: null, total: t.total,
      method: ed.method,
      received: ed.method === 'cash' ? (old && old.method === 'cash' && old.received >= t.total ? old.received : t.total) : null,
      change: null, status: 'completed',
      note: $('#edNote').value.trim(),
      ...(old ? { editedFrom: old.id } : { addedLater: true }),
    };
    if (sale.received != null) sale.change = sale.received - sale.total;
    const r = await DB.replaceSale(old ? old.id : null, sale);
    busy = false;
    if (!r.ok) { $('#fErr').textContent = '保存できませんでした：' + r.reason; return; }
    $('#dialog').hidden = true; $('#dialogBody').onclick = null; $('#dialogBody').oninput = null;
    await reloadStock(); renderAll(); if (state.salesMode === 'daily') renderDaily();
    toast(old ? '会計を修正しました' : '会計を追加しました');
  };
}

async function dailyCsv() {
  const { days } = await dailySummary();
  const rows = [['日付', '会計件数', '現金', 'PayPay', '合計', '値引き合計']];
  days.slice().reverse().forEach((d) => rows.push([d.date, d.count, d.cash, d.paypay, d.total, d.discount]));
  await saveFile(`filer-daily-${stamp()}.csv`, toCsv(rows), 'text/csv');
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
  renderEventBox();
}

async function salesCsv() {
  const list = (await eventSales()).reverse();
  const rows = [['会計ID', '日時', '状態', '決済', '商品', 'カテゴリ', '単価', '数量', '小計', '会計割引', '会計合計']];
  list.forEach((s) => s.items.forEach((i, idx) => rows.push([
    s.id, new Date(s.createdAt).toLocaleString('ja-JP'), ({ voided: '取消', edited: '修正前' }[s.status] || '確定'), METHOD_LABEL[s.method],
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
