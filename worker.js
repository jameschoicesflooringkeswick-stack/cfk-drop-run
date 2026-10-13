// CFK Drop Run — serves the app and stores shared "dropped" ticks in KV (binding: DROPS).
const ID = /^[a-z0-9-]{1,160}$/;
const KEEP_SECONDS = 60 * 60 * 24 * 150; // ticks expire after ~5 months

async function listDrops(env) {
  const ids = [];
  let cursor;
  do {
    const page = await env.DROPS.list({ prefix: "d:", cursor });
    for (const k of page.keys) ids.push({ id: k.name.slice(2), ...(k.metadata || {}) });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return Response.json(ids, { headers: { "Cache-Control": "no-store" } });
}

async function setDrop(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const { id, done, name, suburb } = body || {};
  if (typeof id !== "string" || !ID.test(id)) return new Response("Bad id", { status: 400 });
  const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : "");
  if (done) await env.DROPS.put("d:" + id, new Date().toISOString(), {
    expirationTtl: KEEP_SECONDS,
    metadata: { n: clean(name), s: clean(suburb), t: Date.now() }, // who / suburb / when — used for team stats
  });
  else await env.DROPS.delete("d:" + id);
  return Response.json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/drops") {
      if (!env.DROPS) return new Response("KV binding DROPS missing", { status: 503 });
      if (request.method === "GET") return listDrops(env);
      if (request.method === "POST") return setDrop(request, env);
      return new Response("Method not allowed", { status: 405 });
    }
    // sales.json must never be cached stale
    const res = await env.ASSETS.fetch(request);
    if (url.pathname === "/sales.json") {
      const r = new Response(res.body, res);
      r.headers.set("Cache-Control", "no-cache");
      return r;
    }
    return res;
  },
};
