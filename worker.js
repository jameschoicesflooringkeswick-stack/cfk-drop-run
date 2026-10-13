// CFK Drop Run — serves the app, stores shared "dropped" ticks in KV (binding: DROPS),
// and keeps recent sales fresh by itself from PropTrack's licensed Listings API
// (secrets PROPTRACK_KEY + PROPTRACK_SECRET). Sales are cached in KV under "sales:v1".
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


/* ---------- Automatic sales refresh: PropTrack Listings API ----------
   Point & radius search (max 55 km) over a handful of points that cover SA's populated areas,
   status=sold, newest first. First run backfills KEEP_DAYS; later runs only ask for sales since
   the last run (minus a few days, because agents report sales late). */
const KEEP_DAYS = 120, EVERY_MIN = 30;
const PT_BASE = (env) => env.PROPTRACK_BASE || "https://data.proptrack.com";
const PT_TOKEN = (env) => env.PROPTRACK_TOKEN_URL || PT_BASE(env) + "/oauth2/token";
const POINTS = [ // [name, lat, lng, radius km]
  ["Adelaide", -34.93, 138.60, 55], ["Gawler & Barossa", -34.55, 138.85, 40], ["Fleurieu", -35.50, 138.65, 40],
  ["Murray Bridge & Hills", -35.10, 139.10, 40], ["Yorke & Copper Coast", -34.10, 137.80, 55], ["Mid North", -33.40, 138.30, 55],
  ["Upper Spencer Gulf", -32.90, 137.70, 55], ["Riverland", -34.25, 140.55, 55], ["South East", -37.50, 140.60, 55],
  ["Limestone Coast North", -36.60, 140.30, 55], ["Port Lincoln", -34.70, 135.85, 55], ["Kangaroo Island", -35.75, 137.50, 55],
];
const num = (v) => parseInt(String(v ?? "").replace(/[^0-9]/g, ""), 10) || 0;
const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== "");
const day = (d) => d.toISOString().slice(0, 10);
const title = (v) => String(v || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

async function loadState(env) {
  return (await env.DROPS.get("sales:v1", "json")) || { sales: {}, log: [] };
}
async function token(env, st) {
  if (st.tok && st.tok.exp > Date.now() + 60e3) return st.tok.v;
  const res = await fetch(PT_TOKEN(env), {
    method: "POST",
    headers: { "Authorization": "Basic " + btoa(env.PROPTRACK_KEY + ":" + env.PROPTRACK_SECRET), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error("token " + res.status + " " + JSON.stringify(j).slice(0, 200));
  st.tok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return st.tok.v;
}
// Turn one PropTrack listing into the app's row. Field names follow PropTrack's docs; the
// address/attributes objects are read defensively until we've seen a live response.
function fromPropTrack(l) {
  const a = l.address || {}, at = l.attributes || {};
  if (!l.saleDate && !at.saleDate) return null;
  const date = String(pick(l.saleDate, at.saleDate)).slice(0, 10);
  const type = String(pick(at.propertyType, a.propertyType, l.propertyType, "house"));
  if (/land|vacant/i.test(type)) return null;
  const street = pick(a.streetAddress, a.street, [a.streetNumber, a.streetName, a.streetType].filter(Boolean).join(" "), String(pick(a.fullAddress, a.displayAddress, "")).split(",")[0]);
  const addr = (a.unitNumber && !String(street).includes("/") ? a.unitNumber + "/" : "") + String(street || "").trim();
  const suburb = pick(a.suburb, a.suburbName, a.locality);
  if (!/\d/.test(addr) || !suburb) return null;
  const lat = +pick(a.latitude, a.lat, a.location && a.location.latitude, l.latitude), lng = +pick(a.longitude, a.lng, a.location && a.location.longitude, l.longitude);
  return {
    addr, suburb: title(suburb), type: /unit|apartment|flat/i.test(type) ? "Unit" : title(type), date,
    price: l.saleValueSuppressed ? 0 : num(pick(l.saleValue, at.saleValue)), // agent-advised sale value only; listingPrice may not be displayed
    bed: num(pick(at.bedrooms, l.bedrooms)), bath: num(pick(at.bathrooms, l.bathrooms)), car: num(pick(at.carSpaces, at.carspaces, l.carSpaces)),
    url: "https://www.realestate.com.au/" + l.listingId, src: "proptrack",
    ...(lat && lng ? { lat, lng } : {}),
  };
}
async function searchPoint(env, tok, p, startDate, maxPages) {
  const rows = [], meta = { s: p[0], h: 0, n: 0, pages: 0 };
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ listingTypes: "sale", status: "sold", pointType: "latLong", latitude: p[1], longitude: p[2], radius: p[3] * 1000, sortBy: "dateDesc", startDate, endDate: day(new Date()), pageSize: 200 });
    if (cursor) q.set("afterPageCursor", cursor);
    const res = await fetch(PT_BASE(env) + "/api/v2/listings/search/point-and-radius?" + q, { headers: { "Authorization": "Bearer " + tok, "Accept": "application/json" } });
    meta.h = res.status; meta.pages++;
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) { meta.e = JSON.stringify(j).slice(0, 200); break; }
    if (!meta.sample && j.listings && j.listings[0]) meta.sample = JSON.stringify(j.listings[0]).slice(0, 2000);
    for (const l of j.listings || []) { const r = fromPropTrack(l); if (r) rows.push(r); }
    meta.n += (j.listings || []).length;
    if (!j.pageInfo || !j.pageInfo.hasNextPage) break;
    cursor = j.pageInfo.pageEndCursor;
  }
  return { rows, meta };
}
async function refresh(env, force) {
  const st = await loadState(env);
  if (!force && st.lastRun && Date.now() - st.lastRun < EVERY_MIN * 60e3) return null;
  const first = !st.lastRun;
  const since = day(new Date(first ? Date.now() - KEEP_DAYS * 864e5 : st.lastRun - 7 * 864e5));
  let tok, log = [], added = 0;
  try { tok = await token(env, st); } catch (e) { log.push({ s: "auth", h: 0, e: String(e).slice(0, 200) }); }
  if (tok) for (const p of POINTS) {
    const { rows, meta } = await searchPoint(env, tok, p, since, first ? 25 : 5).catch((e) => ({ rows: [], meta: { s: p[0], h: 0, e: String(e).slice(0, 200) } }));
    for (const r of rows) { if (!st.sales[r.url]) added++; st.sales[r.url] = r; }
    if (meta.sample) { st.sample = meta.sample; delete meta.sample; }
    log.push(meta);
  }
  const cut = day(new Date(Date.now() - KEEP_DAYS * 864e5));
  for (const [k, v] of Object.entries(st.sales)) if (v.date < cut) delete st.sales[k];
  if (tok && log.every((m) => m.h === 200)) st.lastRun = Date.now();
  st.updated = new Date().toISOString();
  st.log = [{ t: st.updated, added, r: log }, ...(st.log || [])].slice(0, 30);
  await env.DROPS.put("sales:v1", JSON.stringify(st));
  return { added, total: Object.keys(st.sales).length, log };
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
      const wk = day(new Date(Date.now() - 7 * 864e5));
      return Response.json({ connected: !!(env.PROPTRACK_KEY && env.PROPTRACK_SECRET), updated: st.updated || null, lastRun: st.lastRun || null,
        sales: Object.keys(st.sales || {}).length, soldLast7Days: Object.values(st.sales || {}).filter((s) => s.date >= wk).length,
        sample: url.searchParams.has("sample") ? st.sample : undefined, log: (st.log || []).slice(0, 10) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/refresh") {
      if (!env.PROPTRACK_KEY || !env.PROPTRACK_SECRET) return new Response("PropTrack keys not set", { status: 503 });
      return Response.json(await refresh(env, true), { headers: { "Cache-Control": "no-store" } });
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
    if (env.DROPS && env.PROPTRACK_KEY && env.PROPTRACK_SECRET) ctx.waitUntil(refresh(env, false));
  },
};
