/* ==========================================================
   Service Worker لمنصة Qamha Scada System
   - يخلي الموقع قابل للتثبيت (PWA) على الموبايل/التابلت
   - يستقبل إشعارات Push حتى إذا المتصفح/التطبيق مسكر (عن طريق Firebase Cloud Messaging)
   ========================================================== */

const CACHE_NAME = 'qamha-scada-v7';
const CACHE_FILES = ['./index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

// ملاحظة: ما نستدعي skipWaiting() هنا تلقائياً - نخلي أي نسخة جديدة توصل تبقى
// "بانتظار" لحد ما المستخدم نفسه يوافق على التحديث من الصفحة (شريط "يتوفر تحديث
// جديد")، حتى ما ينقلب التطبيق تحته وهو يستخدمه بدون علمه. الصفحة ترسل رسالة
// SKIP_WAITING بعد موافقة المستخدم (شوف معالج الرسائل تحت).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CACHE_FILES).catch(() => {}))
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // شبكة أولاً، وإذا ما فيه اتصال نرجع النسخة المخزنة (تصفح بسيط بدون نت).
  // كمان: أي طلب ينجح (حتى لو لمكتبة خارجية من CDN، مثل مكتبة فايربيس أو xlsx/pdf)
  // نخزن نسخة منه بالكاش تلقائياً وقت النجاح - بدون ما نحتاج نحدد مسبقاً كل
  // مكتبة نستخدمها بـCACHE_FILES. هذا يخلي التطبيق يشتغل بالكامل حتى بدون
  // إنترنت طالما فُتح مرة وحدة ناجحة سابقاً (كل مكتبات فايربيس المطلوبة للدخول
  // وعرض البيانات صارت متوفرة أوفلاين تلقائياً).
  const req = event.request;
  if (req.method !== 'GET') return; // ما نخزن أي طلب كتابة (POST/PATCH..)
  event.respondWith(
    fetch(req).then((response) => {
      if (response && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
      }
      return response;
    }).catch(() => caches.match(req))
  );
});

/* ---------- Firebase Cloud Messaging: استقبال إشعارات بالخلفية ---------- */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

/* ⚠️ حط هنا نفس بيانات firebaseConfig الموجودة بملف index.html (لازم تكون مطابقة تماماً) */
firebase.initializeApp({
  apiKey: "AIzaSyAvNfgUCEmVikT-IE0XvE5s3SRFfwm5gLA",
  databaseURL: "https://qamha-metering-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "qamha-metering",
  messagingSenderId: "877494683287",
  appId: "1:877494683287:web:600c1ef1417e74a6f14bd2"
});

try {
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || '⚠️ تنبيه من منصة قمحة';
    const body = (payload.notification && payload.notification.body) || '';
    self.registration.showNotification(title, {
      body,
      icon: './icon.svg',
      badge: './icon.svg',
      dir: 'rtl',
      lang: 'ar',
      vibrate: [200, 100, 200, 100, 200]
    });
  });
} catch (e) {
  console.warn('FCM messaging init failed in service worker:', e);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clientsArr) => {
      const existing = clientsArr.find((c) => c.url.includes(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow('./index.html');
    })
  );
});
