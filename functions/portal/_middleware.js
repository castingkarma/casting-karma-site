// ───────────────────────────────────────────────────────────────────────────
// Server-side password gate for the admin portal at /portal  (Cloudflare Pages)
//
// Just a password — no OTP, no email code. But this is REAL protection, not a
// client-side trick: the dashboard HTML is never sent to the browser until a
// valid, HMAC-signed session cookie is present. The password and signing secret
// live as environment variables on Cloudflare — never in any file the browser
// can read.
//
// ONE-TIME SETUP (Cloudflare dashboard → Workers & Pages → casting-karma-site →
// Settings → Variables and Secrets → add for Production AND Preview):
//   ADMIN_PASSWORD = Karma0330            (the login password)
//   SESSION_SECRET = <long random string> (signs the session cookie; keep secret)
// To rotate/kick every session: change SESSION_SECRET. To change the password:
// change ADMIN_PASSWORD. No redeploy needed for var changes to take effect.
// ───────────────────────────────────────────────────────────────────────────

const COOKIE = "ck_admin";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const enc = new TextEncoder();

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function makeToken(secret) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  return exp + "." + (await hmacHex(secret, "ok|" + exp));
}

async function tokenValid(secret, token) {
  if (!token || token.indexOf(".") < 0) return false;
  const i = token.indexOf(".");
  const exp = token.slice(0, i), sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false; // expired
  const good = await hmacHex(secret, "ok|" + exp);
  if (good.length !== sig.length) return false;
  let diff = 0;
  for (let k = 0; k < good.length; k++) diff |= good.charCodeAt(k) ^ sig.charCodeAt(k);
  return diff === 0;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let k = 0; k < a.length; k++) diff |= a.charCodeAt(k) ^ b.charCodeAt(k);
  return diff === 0;
}

function getCookie(request, name) {
  const c = request.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

function loginPage(message) {
  const html = LOGIN_HTML.replace("{{MSG}}",
    message ? `<div class="err">${message}</div>` : "");
  return new Response(html, {
    status: message ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const secret = env.SESSION_SECRET || "";
  const password = env.ADMIN_PASSWORD || "";

  // Sign out — clear the cookie on BOTH paths (new "/" and any legacy "/portal")
  if (url.searchParams.has("logout")) {
    const h = new Headers({ "Location": "/portal/" });
    h.append("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
    h.append("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/portal; Max-Age=0`);
    return new Response(null, { status: 302, headers: h });
  }

  // Login submit
  if (request.method === "POST") {
    if (!password || !secret) {
      return loginPage("Portal isn’t configured yet — set ADMIN_PASSWORD and SESSION_SECRET in Cloudflare.");
    }
    let attempt = "";
    try {
      const form = await request.formData();
      attempt = (form.get("password") || "").toString();
    } catch (_) {}
    if (!timingSafeEqual(attempt, password)) {
      return loginPage("Incorrect password.");
    }
    const token = await makeToken(secret);
    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/portal/",
        "Set-Cookie": `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`,
      },
    });
  }

  // Authenticated GET → serve the protected dashboard (next() = static asset)
  if (secret && (await tokenValid(secret, getCookie(request, COOKIE)))) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "no-store");
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  }

  // Not authenticated → show the login page (dashboard is never sent)
  return loginPage("");
}

const LOGIN_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Casting Karma LLC — Portal</title>
<link rel="icon" href="https://castingkarmallc.com/emblem.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root{--gold:#d9b45b;--ink:#eae7dd;--ink2:#9aa79b;--line:rgba(255,255,255,.12)}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    color:var(--ink);background:radial-gradient(1200px 700px at 50% -10%,#12281d 0%,#0a1712 55%,#060d0a 100%);
    display:flex;align-items:center;justify-content:center;padding:24px}
  .card{width:100%;max-width:380px;text-align:center}
  .emblem{width:74px;height:74px;object-fit:contain;opacity:.95;margin-bottom:18px}
  h1{font-family:'Cinzel',Georgia,serif;font-size:19px;letter-spacing:2px;font-weight:600;margin:0 0 4px}
  .sub{font-size:12px;letter-spacing:2.5px;text-transform:uppercase;color:var(--gold);margin-bottom:26px}
  form{display:flex;flex-direction:column;gap:12px}
  input[type=password]{width:100%;padding:13px 15px;border-radius:11px;border:1px solid var(--line);
    background:rgba(0,0,0,.3);color:var(--ink);font-size:16px;text-align:center;font-family:inherit}
  input[type=password]:focus{outline:none;border-color:var(--gold)}
  button{width:100%;padding:13px 15px;border-radius:11px;border:none;cursor:pointer;
    background:linear-gradient(180deg,#e7c777,#c69f45);color:#1a1207;font-size:15px;font-weight:800;font-family:inherit;letter-spacing:.3px}
  button:hover{filter:brightness(1.05)}
  .err{background:rgba(210,90,70,.14);border:1px solid rgba(210,90,70,.4);color:#eba894;
    font-size:13px;padding:9px 12px;border-radius:10px;margin-bottom:14px}
  .foot{margin-top:22px;font-size:11px;color:var(--ink2)}
</style></head>
<body>
  <div class="card">
    <img class="emblem" src="https://castingkarmallc.com/emblem.png" alt="Casting Karma">
    <h1>Casting Karma LLC</h1>
    <div class="sub">Admin Portal</div>
    {{MSG}}
    <form method="POST" action="/portal/" autocomplete="off">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Enter</button>
    </form>
    <div class="foot">Private. Authorized access only.</div>
  </div>
</body></html>`;
