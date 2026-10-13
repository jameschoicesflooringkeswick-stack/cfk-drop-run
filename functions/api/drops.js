// Shared "dropped" ticks for CFK Drop Run.
// Needs a KV namespace bound to this Pages project as DROPS (Settings → Bindings).
const ID = /^[a-z0-9-]{1,160}$/;
const KEEP_SECONDS = 60 * 60 * 24 * 150; // ticks expire after ~5 months

export async function onRequestGet({ env }) {
  if (!env.DROPS) return new Response("KV binding DROPS missing", { status: 503 });
  const ids = [];
  let cursor;
  do {
    const page = await env.DROPS.list({ prefix: "d:", cursor });
    for (const k of page.keys) ids.push(k.name.slice(2));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return Response.json(ids, { headers: { "Cache-Control": "no-store" } });
}

export async function onRequestPost({ request, env }) {
  if (!env.DROPS) return new Response("KV binding DROPS missing", { status: 503 });
  let body;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const { id, done } = body || {};
  if (typeof id !== "string" || !ID.test(id)) return new Response("Bad id", { status: 400 });
  if (done) await env.DROPS.put("d:" + id, new Date().toISOString(), { expirationTtl: KEEP_SECONDS });
  else await env.DROPS.delete("d:" + id);
  return Response.json({ ok: true });
}
