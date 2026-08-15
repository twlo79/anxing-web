// 安幸上工 service worker
//
// 刻意寫得很薄。這是一個「資料隨時在變」的內部後台 —— 訂單、收款、核可狀態
// 都必須是最新的，快取舊資料比沒有快取更危險（會讓人以為單子還沒被核可）。
// 所以這裡不做任何 API 或頁面內容的快取，只負責兩件事：
//   1. 讓網站符合 PWA 的安裝條件（必須有 service worker）
//   2. 承接推播通知（階段 C 會用到）
//
// 之後若要加離線快取，只快取 /icons/ 這類靜態資源，不要碰 supabase.co 的請求。

self.addEventListener('install', () => {
  self.skipWaiting();          // 新版本立刻接手，不等舊分頁全部關掉
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

// 不攔截任何請求，一律走網路。
// 完全不註冊 fetch 事件的話，部分瀏覽器不認為這是可安裝的 PWA，
// 所以保留一個直接放行的 handler。
self.addEventListener('fetch', () => {});

// ── 以下為階段 C 的推播通知，先放著不會有作用（沒有訂閱就不會觸發）──

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || '安幸上工';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.tag || 'anxing',
    // 沒帶網址就落在「新訊息」——那一頁看得到這則通知本身,
    // 而 /purchases 對一則訂單通知來說是完全不相干的地方
    data: { url: data.url || '/settings?tab=news' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/settings?tab=news';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // 已經開著的分頁就直接切過去，不要每次都開新視窗
      for (const c of list) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});
