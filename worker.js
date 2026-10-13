// CFK Drop Run — serves the app, stores shared "dropped" ticks in KV (binding: DROPS),
// and keeps recent sales fresh by itself: every 2 minutes a cron run reads the newest sold
// listings for the next 2 suburbs on Domain and saves them in KV (key "sales:v1").
import GROUPS from "./scripts/groups.json";
const ID = /^[a-z0-9-]{1,160}$/;

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
    metadata: { n: clean(name), s: clean(suburb), t: Date.now() }, // who / suburb / when — used for team stats
  });
  else await env.DROPS.delete("d:" + id);
  return Response.json({ ok: true });
}


/* ---------- Automatic sales refresh ---------- */
const SLUGS = [...Object.values(GROUPS.metro).flat(), ...Object.values(GROUPS.regional).flat()];
const PER_RUN = 2, KEEP_DAYS = 120;
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const num = (v) => parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10) || 0;
const unesc = (v) => { try { return JSON.parse('"' + v + '"'); } catch { return v; } };
const field = (chunk, re) => { const m = chunk.match(re); return m ? unesc(m[1]) : ""; };

// Pull sold listings out of a Domain search page without parsing the whole (large) page.
function parseDomain(html) {
  const out = [];
  const parts = html.split('"listingModel":').slice(1);
  for (const chunk0 of parts) {
    const chunk = chunk0.slice(0, 6000);
    const url = field(chunk, /"url":"([^"]+)"/);
    const street = field(chunk, /"street":"([^"]*)"/);
    const suburb = field(chunk, /"suburb":"([^"]*)"/);
    const tag = field(chunk, /"tagText":"([^"]*)"/);
    const d = tag.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/);
    if (!url || !street || !suburb || !d) continue;
    const type = field(chunk, /"propertyType(?:Formatted)?":"([^"]*)"/) || "House";
    if (/land|vacant/i.test(type)) continue;
    const mm = MON[d[2].toLowerCase()]; if (!mm) continue;
    const date = `${d[3]}-${String(mm).padStart(2, "0")}-${d[1].padStart(2, "0")}`;
    const lat = parseFloat(field(chunk, /"lat":(-?[0-9.]+)/)), lng = parseFloat(field(chunk, /"lng":(-?[0-9.]+)/));
    const priceTxt = field(chunk, /"price":"([^"]*)"/);
    out.push({
      addr: street.replace(/,\s*$/, "").trim(),
      suburb: suburb.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
      type: /apartment|unit|flat/i.test(type) ? "Unit" : type.replace(/\b\w/g, (c) => c.toUpperCase()),
      price: /\$\s*[0-9]/.test(priceTxt) ? num(priceTxt.split("-")[0]) : 0,
      date,
      bed: num(field(chunk, /"beds":([0-9]+)/)), bath: num(field(chunk, /"baths":([0-9]+)/)), car: num(field(chunk, /"parking":([0-9]+)/)),
      url: url.startsWith("http") ? url : "https://www.domain.com.au" + url,
      ...(lat && lng ? { lat, lng } : {}),
    });
  }
  return out;
}

async function fetchSuburb(slug) {
  const res = await fetch(`https://www.domain.com.au/sold-listings/${slug}/?sort=solddate-desc`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-AU,en;q=0.9",
    },
    cf: { cacheTtl: 0 },
  });
  if (!res.ok) return { slug, status: res.status, rows: [] };
  const html = await res.text();
  return { slug, status: res.status, rows: parseDomain(html), bytes: html.length };
}

async function loadState(env) {
  return (await env.DROPS.get("sales:v1", "json")) || { cursor: 0, sales: {}, log: [] };
}

async function refresh(env, slugs) {
  const st = await loadState(env);
  const list = slugs || Array.from({ length: PER_RUN }, (_, i) => SLUGS[(st.cursor + i) % SLUGS.length]);
  const results = await Promise.all(list.map((s) => fetchSuburb(s).catch((e) => ({ slug: s, status: 0, rows: [], error: String(e).slice(0, 120) }))));
  const cut = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  let added = 0;
  for (const r of results) for (const row of r.rows) { if (!st.sales[row.url]) added++; st.sales[row.url] = row; }
  for (const [k, v] of Object.entries(st.sales)) if (v.date < cut) delete st.sales[k];
  if (!slugs) st.cursor = (st.cursor + PER_RUN) % SLUGS.length;
  st.updated = new Date().toISOString();
  st.log = [{ t: st.updated, r: results.map((r) => ({ s: r.slug, h: r.status, n: r.rows.length, e: r.error })) }, ...(st.log || [])].slice(0, 40);
  await env.DROPS.put("sales:v1", JSON.stringify(st));
  return { added, results: results.map((r) => ({ slug: r.slug, status: r.status, found: r.rows.length, bytes: r.bytes, error: r.error })), total: Object.keys(st.sales).length };
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
    if (url.pathname === "/api/sales") {
      const st = env.DROPS ? await loadState(env) : { sales: {} };
      return Response.json({ updated: st.updated || null, sales: Object.values(st.sales) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/status") {
      const st = env.DROPS ? await loadState(env) : {};
      const recent = Object.values(st.sales || {}).filter((s) => s.date >= new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)).length;
      return Response.json({ updated: st.updated || null, cursor: st.cursor, suburbs: SLUGS.length, sales: Object.keys(st.sales || {}).length, soldLast7Days: recent, log: (st.log || []).slice(0, 15) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/probe") { // diagnostics: can this server reach a listings site?
      const u = url.searchParams.get("u") || "";
      let t; try { t = new URL(u); } catch { return new Response("bad url", { status: 400 }); }
      if (!/^(www\.)?(domain\.com\.au|homely\.com\.au|realestate\.com\.au|api\.domain\.com\.au|onthehouse\.com\.au|property\.com\.au)$/.test(t.hostname)) return new Response("host not allowed", { status: 400 });
      const r = await fetch(t, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15", "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "Accept-Language": "en-AU,en;q=0.9" } }).catch((e) => ({ status: 0, text: async () => String(e) }));
      const body = await r.text();
      const i = Math.max(0, body.search(/[Ss]old/));
      return Response.json({ status: r.status, bytes: body.length, head: body.slice(0, 300), nearSold: body.slice(i, i + 800) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/refresh") { // manual check of one suburb, e.g. /api/refresh?slug=unley-sa-5061
      const slug = (url.searchParams.get("slug") || "").toLowerCase();
      if (!/^[a-z0-9-]{3,60}-sa-[0-9]{4}$/.test(slug)) return new Response("Use ?slug=unley-sa-5061", { status: 400 });
      return Response.json(await refresh(env, [slug]), { headers: { "Cache-Control": "no-store" } });
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
  async scheduled(event, env, ctx) {
    if (env.DROPS) ctx.waitUntil(refresh(env));
  },
};
