// ───────────────────────────────────────────────────────────────────────────
// GET /api/ga-auth — one-time helper to connect Google Analytics via OAuth.
//
// No service-account key needed (so the org "Secure by Default" policy doesn't
// apply). This runs as YOU, and you already own every GA property, so there's
// no separate access grant either.
//
// SETUP (once):
//   1) In Google Cloud → APIs & Services → Credentials → Create OAuth client ID
//      → type "Web application" → Authorized redirect URI:
//         https://castingkarmallc.com/api/ga-auth
//      Copy the Client ID + Client secret.
//   2) In Cloudflare (casting-karma-site → Settings → Variables), set:
//         GA4_OAUTH_CLIENT_ID      (the client id)      [secret]
//         GA4_OAUTH_CLIENT_SECRET  (the client secret)  [secret]
//      Redeploy.
//   3) Visit https://castingkarmallc.com/api/ga-auth  → sign in / consent →
//      this page shows your GA4_REFRESH_TOKEN. Copy it into Cloudflare as
//         GA4_REFRESH_TOKEN        [secret]
//      Redeploy. Done — the GA tab now shows live numbers.
//
// Guarded by the admin session cookie, so only a logged-in admin can run it.
// ───────────────────────────────────────────────────────────────────────────

const COOKIE = "ck_admin";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const enc = new TextEncoder();

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const s = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function cookieValid(secret, token) {
  if (!token || token.indexOf(".") < 0) return false;
  const i = token.indexOf("."); const exp = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Math.floor(Date.now() / 1000)) return false;
  const good = await hmacHex(secret, "ok|" + exp);
  if (good.length !== sig.length) return false;
  let d = 0; for (let k = 0; k < good.length; k++) d |= good.charCodeAt(k) ^ sig.charCodeAt(k);
  return d === 0;
}
function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function page(bodyHtml) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex">
    <title>Connect Google Analytics</title>
    <style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0a120d;color:#eae7dd;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.6}
    code,textarea{font-family:ui-monospace,Menlo,monospace}
    .box{background:rgba(255,255,255,.05);border:1px solid rgba(217,180,91,.3);border-radius:12px;padding:16px;margin:16px 0}
    textarea{width:100%;height:120px;background:#060d0a;color:#e7c777;border:1px solid rgba(217,180,91,.3);border-radius:8px;padding:10px}
    a.btn{display:inline-block;background:linear-gradient(180deg,#e7c777,#c69f45);color:#1a1207;font-weight:800;text-decoration:none;padding:11px 18px;border-radius:10px}
    h2{color:#d9b45b}</style>${bodyHtml}`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const secret = env.SESSION_SECRET || "";
  if (!secret || !(await cookieValid(secret, getCookie(request, COOKIE)))) {
    return new Response("Unauthorized — open this from inside the portal (log in first).", { status: 401 });
  }

  const clientId = env.GA4_OAUTH_CLIENT_ID || "";
  const clientSecret = env.GA4_OAUTH_CLIENT_SECRET || "";
  const url = new URL(request.url);
  const redirectUri = url.origin + "/api/ga-auth";

  if (!clientId || !clientSecret) {
    return page(`<h2>Step 1 not done yet</h2><p>Set <code>GA4_OAUTH_CLIENT_ID</code> and
      <code>GA4_OAUTH_CLIENT_SECRET</code> in Cloudflare (from your OAuth client), redeploy, then reload this page.</p>
      <p>Your OAuth client's Authorized redirect URI must be exactly:</p>
      <div class="box"><code>${redirectUri}</code></div>`);
  }

  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) return page(`<h2>Google returned an error</h2><p><code>${err}</code></p><p><a class="btn" href="/api/ga-auth">Try again</a></p>`);

  // No code yet → send the user to Google's consent screen
  if (!code) {
    const auth = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });
    return new Response(null, { status: 302, headers: { Location: auth, "Cache-Control": "no-store" } });
  }

  // Have a code → exchange it for a refresh token
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.refresh_token) {
    return page(`<h2>Couldn't get a refresh token</h2>
      <p>Google said: <code>${(data.error || r.status) + " " + (data.error_description || "")}</code></p>
      <p>Most common fix: make sure you clicked through the consent (not just sign-in). <a class="btn" href="/api/ga-auth">Try again</a></p>`);
  }

  return page(`<h2>✅ Connected — one paste left</h2>
    <p>Copy this value and set it in Cloudflare as <code>GA4_REFRESH_TOKEN</code> (secret), then redeploy. That's the final step.</p>
    <div class="box"><textarea readonly onclick="this.select()">${data.refresh_token}</textarea></div>
    <p style="color:#9aa79b;font-size:13px">This token lets the portal read your Google Analytics (read-only). Keep it secret; you can revoke it anytime at myaccount.google.com → Security → Third-party access.</p>`);
}
