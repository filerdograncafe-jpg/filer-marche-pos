// オフライン用：アプリのファイルをiPhone内に保存しておき、電波が無くても起動できるようにする
// アプリを更新したら CACHE の番号を上げる（売上データはIndexedDBにあるので消えない）
const CACHE = 'filer-pos-v5';
const FILES = ['./', 'index.html', 'style.css', 'db.js', 'app.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// まず保存済みファイルを使い、無ければネットから取得
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
