// データ保存（IndexedDB）
// ・アプリを更新してもデータは消えません（バージョンを上げても既存データは残す作り）
// ・会計は1つのトランザクションでまとめて保存するので、途中で落ちても中途半端な記録は残りません
const DB_NAME = 'filer-marche-pos';
const DB_VERSION = 1;

const SEED_PRODUCTS = [
  ['ジャーキー', 'お試し4種セット', 1000],
  ['ジャーキー', 'モモ40g', 900],
  ['ジャーキー', 'レバー40g', 900],
  ['ジャーキー', 'ハツ30g', 900],
  ['ジャーキー', 'ラング25g', 900],
  ['アキレス', 'ショート20g', 1000],
  ['アキレス', 'ハーフ20g', 1000],
  ['アキレス', '丸ごと40〜45g', 1900],
  ['冷凍商品', 'ボーンブロス100ml', 500],
  ['冷凍商品', 'ホロホロ煮70g', 600],
  ['冷凍商品', 'ヤギミルク100ml', 400],
  ['その他', 'ギフトBOX', 500],
];

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const old = e.oldVersion;
      // v1: 全ストアを作成（今後の段階で使うものも先に用意）
      if (old < 1) {
        db.createObjectStore('products', { keyPath: 'id' });
        const sales = db.createObjectStore('sales', { keyPath: 'id' });
        sales.createIndex('createdAt', 'createdAt');
        sales.createIndex('eventId', 'eventId');
        db.createObjectStore('events', { keyPath: 'id' });
        const moves = db.createObjectStore('stockMoves', { keyPath: 'id' });
        moves.createIndex('eventId', 'eventId');
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      // 将来の変更は if (old < 2) {...} のように追記し、既存データは消さない
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  db: null,
  async init() {
    this.db = await openDB();
    // 永続化をお願いする（Safariが勝手に消しにくくなる。対応していなくても問題なし）
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}
    const seeded = await this.get('meta', 'seeded');
    if (!seeded) {
      const tx = this.db.transaction(['products', 'meta'], 'readwrite');
      SEED_PRODUCTS.forEach(([category, name, price], i) => {
        tx.objectStore('products').put({ id: uid('p'), category, name, price, hidden: false, sort: i });
      });
      tx.objectStore('meta').put({ key: 'seeded', value: true });
      await txDone(tx);
    }
  },
  get(store, key) {
    return new Promise((res, rej) => {
      const r = this.db.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  all(store) {
    return new Promise((res, rej) => {
      const r = this.db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async put(store, value) {
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await txDone(tx);
  },
  // 在庫の増減記録（台帳方式：持込・販売・取消・修正をすべて記録し、合計が残数になる）
  movesFor(eventId) {
    return new Promise((res, rej) => {
      const r = this.db.transaction('stockMoves').objectStore('stockMoves').index('eventId').getAll(eventId);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async addMove(move) {
    await this.put('stockMoves', { id: uid('m'), createdAt: new Date().toISOString(), ...move });
  },
  // 会計の保存：売上と在庫減算を1つのトランザクションで実行（片方だけ保存されることはない）
  // 在庫が足りない、または同じ会計が保存済みなら何も保存しない
  commitSale(sale) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['sales', 'stockMoves'], 'readwrite');
      const sales = tx.objectStore('sales');
      const moves = tx.objectStore('stockMoves');
      let result = { ok: true };
      const fail = (reason) => { result = { ok: false, reason }; try { tx.abort(); } catch (_) {} };
      sales.get(sale.id).onsuccess = (e) => {
        if (e.target.result) return fail('この会計は既に保存されています');
        const mr = sale.eventId ? moves.index('eventId').getAll(sale.eventId) : null;
        const proceed = (list) => {
          const stock = stockFromMoves(list);
          for (const it of sale.items) {
            const st = stock[it.productId];
            if (st && st.managed && st.remaining < it.qty) {
              return fail(`${it.name} の在庫が足りません（残り${st.remaining}個）`);
            }
          }
          sales.add(sale);
          const now = sale.createdAt;
          for (const it of sale.items) {
            if (stock[it.productId] && stock[it.productId].managed) {
              moves.add({ id: uid('m'), eventId: sale.eventId, productId: it.productId, type: 'sale', qty: -it.qty, saleId: sale.id, createdAt: now });
            }
          }
        };
        if (mr) mr.onsuccess = () => proceed(mr.result); else proceed([]);
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => resolve(result.ok ? { ok: false, reason: '保存に失敗しました' } : result);
      tx.onerror = () => {};
    });
  },
  // 会計取消：記録は消さずに「取消」状態にし、減らした在庫を戻す
  async voidSale(id, reason) {
    const tx = this.db.transaction(['sales', 'stockMoves'], 'readwrite');
    const store = tx.objectStore('sales');
    const moves = tx.objectStore('stockMoves');
    const r = store.get(id);
    r.onsuccess = () => {
      const s = r.result;
      if (!s || s.status === 'voided') return;
      const now = new Date().toISOString();
      s.status = 'voided'; s.voidedAt = now; s.voidReason = reason || '';
      store.put(s);
      if (!s.eventId) return;
      const mr = moves.index('eventId').getAll(s.eventId);
      mr.onsuccess = () => {
        mr.result.filter((m) => m.saleId === id && m.type === 'sale').forEach((m) => {
          moves.add({ id: uid('m'), eventId: s.eventId, productId: m.productId, type: 'void', qty: -m.qty, saleId: id, createdAt: now });
        });
      };
    };
    await txDone(tx);
  },
  // 全データのバックアップ（JSON）
  async exportAll() {
    const data = {};
    for (const st of ['products', 'sales', 'events', 'stockMoves', 'meta']) data[st] = await this.all(st);
    return { app: 'filer-marche-pos', dbVersion: DB_VERSION, exportedAt: new Date().toISOString(), data };
  },
  // 復元：全データを入れ替える（1つのトランザクションなので途中で失敗したら元のまま）
  async importAll(backup) {
    if (!backup || backup.app !== 'filer-marche-pos' || !backup.data) throw new Error('このアプリのバックアップファイルではありません');
    const stores = ['products', 'sales', 'events', 'stockMoves', 'meta'];
    for (const st of stores) if (!Array.isArray(backup.data[st])) throw new Error('ファイルが壊れています（' + st + '）');
    const tx = this.db.transaction(stores, 'readwrite');
    for (const st of stores) {
      const os = tx.objectStore(st);
      os.clear();
      backup.data[st].forEach((v) => os.put(v));
    }
    await txDone(tx);
  },
};

// 在庫台帳から商品ごとの在庫を計算
function stockFromMoves(list) {
  const s = {};
  for (const m of list) {
    const x = s[m.productId] || (s[m.productId] = { managed: false, carryIn: 0, sold: 0, adjust: 0, remaining: 0 });
    if (m.type === 'carryIn') { x.managed = true; x.carryIn += m.qty; }
    if (m.type === 'sale') x.sold -= m.qty;
    if (m.type === 'void') x.sold -= m.qty;
    if (m.type === 'adjust') { x.managed = true; x.adjust += m.qty; }
    x.remaining += m.qty;
  }
  return s;
}

function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('aborted'));
  });
}
