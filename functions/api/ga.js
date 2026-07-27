// ───────────────────────────────────────────────────────────────────────────
// GET /api/ga — server-side GA4 reader for the admin portal.
//
// Returns per-project sessions (today / 7 days / 30 days / total) plus
// AI-referral sessions (traffic sent from AI answer engines), pulled live from
// the GA4 Data API using a Google service account. The service-account key never
// touches the browser — it lives only in Cloudflare env. Guarded by the same
// admin session cookie as /portal, so only a logged-in admin can call it.
//
// ENV (Cloudflare Pages → casting-karma-site → Settings → Variables and Secrets):
//   GA4_CLIENT_EMAIL  service-account email (…@….iam.gserviceaccount.com)   [secret]
//   GA4_PRIVATE_KEY   the service-account private key, PEM (\n-escaped is fine) [secret]
//   GA4_PROPERTIES    JSON map of slug → numeric GA4 property id, e.g.
//                     {"castingkarma":"123456789","standbyproof":"987654321"}  [plain]
//   SESSION_SECRET    (already set for the portal) — verifies the admin cookie
//
// Any slug without a property id, or missing creds, comes back null → the
// dashboard shows "—" for it. Nothing here ever fabricates a number.
// ───────────────────────────────────────────────────────────────────────────

const COOKIE = "ck_admin";

// Unambiguous AI answer-engine hosts. We deliberately EXCLUDE bare bing.com /
// google.com so ordinary organic search isn't miscounted as an AI referral.
const AI_SOURCES = [
  "chatgpt.com", "chat.openai.com",
  "perplexity.ai",
  "gemini.google.com", "bard.google.com",
  "copilot.microsoft.com",
  "claude.ai", "you.com", "poe.com", "phind.com",
];
function isAISource(src) {
  src = (src || "").toLowerCase();
  return AI_SOURCES.some(s => src === s || src.endsWith("." + s));
}

const enc = new TextEncoder();

// ---- admin cookie verify (same scheme as functions/portal/_middleware.js) ----
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const s = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function cookieValid(secret, token) {
  if (!token || token.indexOf(".") < 0) return false;
  const i = token.indexOf(".");
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const good = await hmacHex(secret, "ok|" + exp);
  if (good.length !== sig.length) return false;
  let d = 0;
  for (let k = 0; k < good.length; k++) d |= good.charCodeAt(k) ^ sig.charCodeAt(k);
  return d === 0;
}
function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// ---- Google service account → OAuth2 access token (JWT RS256 via Web Crypto) ----
function b64urlFromString(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromBytes(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function pemToPkcs8(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
async function getAccessToken(email, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = b64urlFromString(JSON.stringify(header)) + "." + b64urlFromString(JSON.stringify(claim));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned));
  const jwt = unsigned + "." + b64urlFromBytes(sig);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!r.ok) throw new Error("token " + r.status + " " + (await r.text()).slice(0, 180));
  const j = await r.json();
  return j.access_token;
}

// ---- GA4 Data API: one batch per property (sessions x4 ranges + AI-source report) ----
async function propertyMetrics(token, propertyId) {
  const sess = (startDate) => ({ dateRanges: [{ startDate, endDate: "today" }], metrics: [{ name: "sessions" }] });
  const body = {
    requests: [
      sess("today"),
      sess("7daysAgo"),
      sess("30daysAgo"),
      sess("2020-01-01"), // "total" — GA4 only holds data from the property's start
      {
        dateRanges: [
          { startDate: "30daysAgo", endDate: "today" },
          { startDate: "2020-01-01", endDate: "today" },
        ],
        dimensions: [{ name: "sessionSource" }],
        metrics: [{ name: "sessions" }],
        limit: 500,
      },
    ],
  };
  const r = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:batchRunReports`,
    { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) throw new Error("ga4 " + r.status + " " + (await r.text()).slice(0, 180));
  const j = await r.json();
  const reports = j.reports || [];
  const one = (rep) => (rep && rep.rows && rep.rows[0] ? parseInt(rep.rows[0].metricValues[0].value, 10) || 0 : 0);
  const d = one(reports[0]), w = one(reports[1]), m = one(reports[2]), t = one(reports[3]);

  // AI referrals: rows carry [sessionSource, dateRange] (dateRange appended when >1 range)
  let aiM = 0, aiT = 0;
  const aiRep = reports[4];
  if (aiRep && aiRep.rows) {
    for (const row of aiRep.rows) {
      const dims = (row.dimensionValues || []).map(x => x.value);
      const src = dims[0] || "";
      if (!isAISource(src)) continue;
      const rng = dims.find(v => /^date_range_\d+$/.test(v)) || "date_range_0";
      const v = parseInt(row.metricValues[0].value, 10) || 0;
      if (rng === "date_range_0") aiM += v; else aiT += v;
    }
  }
  return { d, w, m, t, aiM, aiT };
}

function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": maxAge ? `private, max-age=${maxAge}` : "no-store",
    },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  // Only a logged-in admin may read analytics
  const secret = env.SESSION_SECRET || "";
  if (!secret || !(await cookieValid(secret, getCookie(request, COOKIE)))) {
    return json({ error: "unauthorized" }, 401);
  }

  const email = env.GA4_CLIENT_EMAIL || "";
  const pk = (env.GA4_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  let props = {};
  try { props = JSON.parse(env.GA4_PROPERTIES || "{}"); } catch (_) { props = {}; }
  const slugs = Object.keys(props);

  if (!email || !pk || slugs.length === 0) {
    return json({
      updatedAt: new Date().toISOString(),
      connected: false,
      projects: {},
      note: "GA4 not configured yet — set GA4_CLIENT_EMAIL, GA4_PRIVATE_KEY and GA4_PROPERTIES.",
    });
  }

  let token;
  try {
    token = await getAccessToken(email, pk);
  } catch (e) {
    return json({ updatedAt: new Date().toISOString(), connected: false, projects: {}, error: "auth: " + String(e.message || e) });
  }

  const warnings = [];
  const projects = {};
  await Promise.all(slugs.map(async (slug) => {
    const pid = String(props[slug] || "").trim();
    if (!pid) { projects[slug] = null; return; }
    try {
      projects[slug] = await propertyMetrics(token, pid);
    } catch (e) {
      projects[slug] = null;
      warnings.push(slug + ": " + String(e.message || e));
    }
  }));

  return json({
    updatedAt: new Date().toISOString(),
    connected: true,
    projects,
    ...(warnings.length ? { warnings } : {}),
  }, 200, 300);
}
