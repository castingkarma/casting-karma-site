// POST /api/lead — shared Cloudflare Pages Function for EVERY CK smoke test.
// Self-hosted capture (D1), routed by the `project` field. No Google, no 3rd party.
// A lead is written to D1 (durable, the count we trust) and, if RESEND_API_KEY is
// set, an instant email alert fires too. D1 either writes the row or throws — we
// never fake a success. Bind D1 as LEADS; optional env: RESEND_API_KEY, ALERT_TO.

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function saveToD1(env, L) {
  if (!env.LEADS) throw new Error("D1 binding LEADS not configured");
  const res = await env.LEADS.prepare(
    `INSERT INTO smoke_leads (project, name, business, email, state, homes, urgency, plan, ref, ua, country, ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(L.project, L.name, L.business, L.email, L.state, L.homes, L.urgency, L.plan, L.ref, L.ua, L.country, L.ts).run();
  if (!res?.success || (res.meta && res.meta.changes === 0)) throw new Error("D1 wrote 0 rows");
  return res.meta?.last_row_id ?? null;
}

async function emailOps(env, L) {
  const key = env.RESEND_API_KEY;
  if (!key) return false; // optional path
  const to = env.ALERT_TO || "jamin@castingkarmallc.com";
  const d = (v) => (v && String(v).trim()) ? String(v).trim() : "—";
  const text =
    `New smoke-test lead — ${d(L.project)}\n\n` +
    `Name: ${d(L.name)}\nPark / company: ${d(L.business)}\nEmail: ${d(L.email)}\n` +
    `State: ${d(L.state)}\nAbandoned homes: ${d(L.homes)}\nUrgency: ${d(L.urgency)}\n` +
    `Plan interest: ${d(L.plan)}\nCame from: ${d(L.ref)}\nWhen: ${d(L.ts)}\n`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Casting Karma <contact@castingkarmallc.com>", to: [to], subject: `Smoke lead — ${d(L.project)} — ${d(L.business)}`, text }),
  });
  if (!r.ok) throw new Error("resend " + r.status);
  return true;
}

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad json" }, 400); }
  const email = String(b.email || "").trim();
  if (!email || !email.includes("@")) return json({ ok: false, error: "email required" }, 400);
  const L = {
    project: String(b.project || "unsorted").slice(0, 90),
    name: String(b.name || "").trim(),
    business: String(b.business || "").trim(),
    email,
    state: String(b.state || "").trim(),
    homes: String(b.homes || "").trim(),
    urgency: String(b.urgency || "").trim(),
    plan: String(b.plan || "").trim(),
    ref: String(b.ref || "direct").slice(0, 300),
    ts: b.ts || new Date().toISOString(),
    ua: (request.headers.get("user-agent") || "").slice(0, 300),
    country: request.headers.get("cf-ipcountry") || null,
  };
  const [db, mail] = await Promise.allSettled([saveToD1(env, L), emailOps(env, L)]);
  const dbOK = db.status === "fulfilled";
  if (!dbOK) {
    console.error("SMOKE LEAD — D1 FAILED:", db.reason?.message, JSON.stringify(L));
    if (mail.status !== "fulfilled") return json({ ok: false, error: "capture failed" }, 500);
  }
  return json({ ok: true, recorded: { db: dbOK, email: mail.status === "fulfilled" } });
}
