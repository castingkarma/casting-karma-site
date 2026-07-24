// Cloudflare Pages Function - POST /api/discovery-lead
// Emails a "let's chat" lead notification to contact@castingkarmallc.com via Resend when
// RESEND_API_KEY is set on the Pages project. This is the DISCOVERY-TOOL lead (the reading flow)
// and is intentionally SEPARATE from /api/lead (the shared smoke-test/D1 capture) so the two
// never collide. Until a key exists it returns {ok:false} and the site falls back to opening a
// pre-filled mailto, so no lead is ever lost. Runs on the LLC's existing Resend account - no new
// account.
//
// Turn ON: Resend (existing LLC account) - confirm castingkarmallc.com is a verified sending
// domain - create an API key - then Cloudflare dashboard - Workers and Pages - casting-karma-site
// - Settings - Variables and secrets - add RESEND_API_KEY (secret) - redeploy.
// Optional env: LEAD_TO (recipient, default contact@castingkarmallc.com), LEAD_FROM (sender).
// Hardening before heavy traffic (Ops): add Cloudflare Turnstile plus a KV/DO rate limit.

const NL = String.fromCharCode(10);
const DEFAULT_TO = "contact@castingkarmallc.com";
const DEFAULT_FROM = "Casting Karma Site <leads@castingkarmallc.com>";

function allowed(origin) {
  return origin === "https://castingkarmallc.com" || origin === "https://www.castingkarmallc.com";
}

function stripControls(s, n) {
  s = String(s == null ? "" : s);
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c < 32 || c === 127) ? " " : ch;
  }
  return out.trim().slice(0, n);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "https://castingkarmallc.com",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "https://castingkarmallc.com",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

export async function onRequestPost(context) {
  const request = context.request;
  const env = context.env;

  const origin = request.headers.get("Origin") || "";
  if (origin && !allowed(origin)) return json({ ok: false, reason: "origin" });

  const key = env.RESEND_API_KEY;
  if (!key) return json({ ok: false, reason: "not-configured" });

  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, reason: "bad-json" }); }

  const name = stripControls(body.name, 80);
  let method = stripControls(body.contactMethod, 10).toLowerCase();
  if (method !== "phone") method = "email";
  const contact = stripControls(body.contact, 120);
  const track = stripControls(body.track, 80);
  const industry = stripControls(body.industry, 60);
  const signal = stripControls(body.signal, 80);
  const details = stripControls(body.details, 600);
  const reading = stripControls(body.reading, 800);

  if (!name || !contact) return json({ ok: false, reason: "missing-fields" });

  const to = stripControls(env.LEAD_TO, 120) || DEFAULT_TO;
  const from = stripControls(env.LEAD_FROM, 160) || DEFAULT_FROM;

  const subject = "New lead - " + name + (industry ? " (" + industry + ")" : "") + " - let's chat";

  const html = [
    '<div style="font-family:Georgia,serif;font-size:15px;line-height:1.6;color:#1c1c1c">',
    '<h2 style="font-family:Georgia,serif;color:#7a5c12;margin:0 0 4px">A new lead from the discovery tool</h2>',
    '<p style="margin:0 0 16px;color:#555">They finished the reading and asked to talk.</p>',
    '<table style="border-collapse:collapse;width:100%;max-width:560px">',
    '<tr><td style="padding:6px 10px;font-weight:bold;width:150px;vertical-align:top">Name</td><td style="padding:6px 10px">' + esc(name) + '</td></tr>',
    '<tr><td style="padding:6px 10px;font-weight:bold;vertical-align:top">Reach them by</td><td style="padding:6px 10px">' + esc(method) + ' &mdash; <strong>' + esc(contact) + '</strong></td></tr>',
    '<tr><td style="padding:6px 10px;font-weight:bold;vertical-align:top">What brings them</td><td style="padding:6px 10px">' + esc(track) + '</td></tr>',
    '<tr><td style="padding:6px 10px;font-weight:bold;vertical-align:top">Industry</td><td style="padding:6px 10px">' + esc(industry) + '</td></tr>',
    '<tr><td style="padding:6px 10px;font-weight:bold;vertical-align:top">Main signal</td><td style="padding:6px 10px">' + esc(signal) + '</td></tr>',
    '<tr><td style="padding:6px 10px;font-weight:bold;vertical-align:top">In their words</td><td style="padding:6px 10px">' + (details ? esc(details) : '<em style="color:#999">(none provided)</em>') + '</td></tr>',
    '</table>',
    reading ? ('<div style="margin:18px 0 0;padding:14px 16px;background:#faf7ef;border-left:3px solid #c2a252;max-width:560px"><div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7a5c12;margin-bottom:6px">The reading they saw</div><div style="color:#333">' + esc(reading) + '</div></div>') : '',
    '<p style="margin:20px 0 0;color:#999;font-size:12px">Sent automatically by castingkarmallc.com</p>',
    '</div>'
  ].join("");

  const text = [
    "A new lead from the discovery tool.",
    "",
    "Name: " + name,
    "Reach them by " + method + ": " + contact,
    "What brings them: " + track,
    "Industry: " + industry,
    "Main signal: " + signal,
    "In their words: " + (details || "(none provided)"),
    "",
    reading ? ("The reading they saw:" + NL + reading) : "",
    "",
    "Sent automatically by castingkarmallc.com"
  ].join(NL);

  const emailBody = {
    from: from,
    to: [to],
    subject: subject,
    html: html,
    text: text
  };
  // If they chose email, let a reply go straight back to them.
  if (method === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    emailBody.reply_to = contact;
  }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + key
      },
      body: JSON.stringify(emailBody)
    });
    if (!r.ok) return json({ ok: false, reason: "upstream", status: r.status });
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, reason: "error" });
  }
}
