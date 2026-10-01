/* ==========================================================
   Netlify Function: رفع فيرموير جديد لجهاز محدد - منصة Qamha Scada System
   ==========================================================
   الهدف: تخلي الأدمن يرفع ملف .bin من واجهة "الأجهزة" بالداشبورد، من أي مكان (مو لازم
   يكون بموقع الأجهزة)، بدون تخزين أي مفتاح/توكن حساس بمتصفحه - المفتاح يضل بس بإعدادات
   Netlify (متغيرات بيئة، سيرفر-سايد) نفس فكرة netlify/functions/check-thresholds.js
   الموجودة أصلاً بالمشروع.

   شنو تسوي بالضبط:
   1. تتحقق إن المستخدم أدمن فعلاً (عبر Firebase ID Token يرسله المتصفح)
   2. ترفع firmware.bin + version.txt لمستودع GitHub (qamha-scada/qamha-monitoring)
      بمسار firmware/{deviceId}/ - نفس المسار الي كل جهاز يفحصه أصلاً بالـOTA العادي
   3. تكتب علم "تحديث مطلوب الآن" بفايربيس (/otaCommands/{deviceId}) عبر Admin SDK
      (يتجاوز قواعد الأمان - ما يحتاج صلاحية كتابة من المتصفح إطلاقاً) - الجهاز يفحص
      هذا المسار كل 15 ثانية (checkOtaFastFlag بالفيرموير) وياخذ التحديث خلال ثواني

   إعدادات مطلوبة بـNetlify (Site settings -> Environment variables):
   - FIREBASE_SERVICE_ACCOUNT_KEY : نفس القيمة المستخدمة بدالة check-thresholds.js
   - GITHUB_TOKEN                 : Personal Access Token (خصصه بس لصلاحية Contents
     على مستودع qamha-scada/qamha-monitoring - Fine-grained PAT من GitHub Settings)
   ========================================================== */

const admin = require("firebase-admin");
const https = require("https");

const GITHUB_OWNER = "qamha-scada";
const GITHUB_REPO = "qamha-monitoring";
const GITHUB_BRANCH = "main";

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://qamha-metering-default-rtdb.europe-west1.firebasedatabase.app",
  });
}

// ============================================================
// دالة مساعدة: نداء GitHub REST API (Contents API) - GET لجلب sha الملف الحالي (لو موجود)،
// PUT لإنشاء/تحديث الملف. نستخدم https المدمجة بـNode بدل أي مكتبة خارجية (تبسيط التبعيات)
// ============================================================
function githubRequest(method, path, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        "User-Agent": "qamha-scada-upload-firmware",
        "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    };
    if (bodyStr) {
      options.headers["Content-Type"] = "application/json";
      options.headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) { /* رد فاضي أو مو JSON */ }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ترفع ملف واحد (base64Content) بمسار repoPath - تجيب الـsha الحالي أول لو الملف موجود
// أصلاً (GitHub يرفض التحديث بدون sha الصحيح - حماية من الكتابة فوق تعديل ماكو عندك)
async function putFile(repoPath, base64Content, commitMessage) {
  const getRes = await githubRequest(
    "GET",
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`
  );
  const sha = getRes.statusCode === 200 && getRes.body ? getRes.body.sha : undefined;

  const putRes = await githubRequest(
    "PUT",
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}`,
    {
      message: commitMessage,
      content: base64Content,
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    }
  );
  if (putRes.statusCode !== 200 && putRes.statusCode !== 201) {
    throw new Error(
      `GitHub PUT فشل (${repoPath}) - كود ${putRes.statusCode}: ${JSON.stringify(putRes.body)}`
    );
  }
  return putRes.body;
}

// رؤوس CORS: مطلوبة لأن الأدمن ممكن يفتح الداشبورد من عنوان السيرفر المحلي (شبكة داخلية)
// بينما هذي الدالة نفسها موجودة بس على دومين Netlify - المتصفح يرفض الطلب Cross-Origin
// بدون هذي الرؤوس. الأمان الفعلي يعتمد على فحص توكن الدخول + isAdmin فوق، مو على الأصل
// (Origin)، فما مشكلة نسمح لأي أصل يوصل - لو ماكو توكن أدمن صحيح، الطلب يترفض بأي حال
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: "Method Not Allowed" };
  }

  try {
    // 1) التحقق إن المستخدم مسجل دخول وأدمن فعلاً
    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: "مفقود توكن الدخول" }) };
    }

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: "توكن الدخول غير صالح" }) };
    }

    const userSnap = await admin.database().ref(`users/${decoded.uid}/isAdmin`).once("value");
    if (userSnap.val() !== true) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: "هذا الإجراء يحتاج صلاحية أدمن" }) };
    }

    // 2) قراءة الطلب
    const body = JSON.parse(event.body || "{}");
    const { deviceId, version, binBase64 } = body;

    if (!deviceId || !/^[a-zA-Z0-9_-]+$/.test(deviceId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "deviceId غير صالح" }) };
    }
    if (!version || typeof version !== "string" || version.length > 40) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "رقم النسخة غير صالح" }) };
    }
    if (!binBase64 || typeof binBase64 !== "string" || binBase64.length < 100) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "ملف الفيرموير مفقود أو فاسد" }) };
    }
    // حد أقصى معقول لحجم الملف (4 ميجا بعد فك base64 - أكبر بكثير من أي .bin متوقع لـESP32)
    if (binBase64.length > 4 * 1024 * 1024 * 1.4) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "حجم الملف كبير جداً" }) };
    }

    // 3) رفع الملفين لـGitHub (firmware.bin + version.txt) بمسار firmware/{deviceId}/
    const versionBase64 = Buffer.from(version, "utf8").toString("base64");

    await putFile(
      `firmware/${deviceId}/firmware.bin`,
      binBase64,
      `تحديث فيرموير ${deviceId} إلى نسخة ${version} (عبر واجهة إدارة الأجهزة)`
    );
    await putFile(
      `firmware/${deviceId}/version.txt`,
      versionBase64,
      `تحديث رقم نسخة ${deviceId} إلى ${version}`
    );

    // 4) كتابة علم "تحديث مطلوب الآن" بفايربيس - الجهاز يفحصه كل 15 ثانية ويطبّق فوراً
    const requestId = String(Date.now());
    await admin.database().ref(`otaCommands/${deviceId}`).set({
      requestId,
      version,
      uploadedBy: decoded.email || decoded.uid,
      uploadedAt: Date.now(),
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, requestId, message: "تم الرفع - الجهاز راح يطبّق التحديث خلال ثواني قليلة" }),
    };
  } catch (err) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: err.message || String(err) }) };
  }
};
