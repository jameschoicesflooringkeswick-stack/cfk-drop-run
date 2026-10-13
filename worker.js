// CFK Drop Run — serves the app, stores shared "dropped" ticks in KV (binding: DROPS),
// and keeps recent sales fresh by itself from PropTrack's licensed Listings API
// (secrets PROPTRACK_KEY + PROPTRACK_SECRET). Sales are cached in KV under "sales:v1".
const ID = /^[a-z0-9-]{1,160}$/;

// All ticks live in one KV value ("drops:v1") so a phone reads back its own tick straight away
// (KV's key listing can lag by up to a minute, which made fresh ticks vanish on reopen).
async function allDrops(env) {
  let all = await env.DROPS.get("drops:v1", "json");
  if (!all) { // one-time move from the old one-key-per-tick layout
    all = {}; let cursor;
    do { const page = await env.DROPS.list({ prefix: "d:", cursor });
      for (const k of page.keys) all[k.name.slice(2)] = k.metadata || {};
      cursor = page.list_complete ? null : page.cursor; } while (cursor);
    await env.DROPS.put("drops:v1", JSON.stringify(all));
  }
  return all;
}
async function listDrops(env) {
  const all = await allDrops(env);
  return Response.json(Object.entries(all).map(([id, m]) => ({ id, ...m })), { headers: { "Cache-Control": "no-store" } });
}

async function setDrop(request, env) {
  let body;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const { id, done, name, suburb } = body || {};
  if (typeof id !== "string" || !ID.test(id)) return new Response("Bad id", { status: 400 });
  const clean = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : "");
  const all = await allDrops(env);
  if (done) all[id] = { n: clean(name), s: clean(suburb), t: (all[id] && all[id].t) || Date.now() }; // suburb / when — used for stats
  else delete all[id];
  await env.DROPS.put("drops:v1", JSON.stringify(all));
  return Response.json({ ok: true });
}


/* ---------- Agency "recently sold" pages (sites whose terms and robots.txt allow it) ---------- */
const UA = { "User-Agent": "CFKDropRun/1.0 (internal tool; contact via choicesflooring.com.au)", "Accept": "text/html" };
const AGENCIES = [ // pages = how deep to read each cycle (~6 weeks of sales); checked: terms + robots.txt allow it
  { id: "klemich", pages: 10, page: (p) => `https://www.klemich.com.au/recently-sold${p > 1 ? "?page=" + p : "/"}` },
  { id: "magain", pages: 16, page: (p) => `https://www.magain.com.au/recently-sold/${p > 1 ? "page/" + p + "/" : ""}` },
  // Not used: OCRE (Vercel bot check), Ray White (CloudFront block) — we never get around blocks.
  // Fox, Eclipse: listings load by script, nothing in the page. LJ Hooker, Harcourts: terms forbid it.
];

const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#0?39;|&rsquo;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const STREET = /\b(street|st|road|rd|avenue|ave|terrace|tce|drive|dr|court|ct|crescent|cres|place|pl|parade|pde|grove|gr|lane|ln|way|close|cl|circuit|cct|boulevard|bvd|highway|hwy|walk|square|sq|rise|mews|esplanade|esp|crt|track|link|loop|row|vista|view|green|ridge|reach|glade|gardens|strand|common|chase|outlook|heights)\b/i;
// "16 Tudor Street, Dulwich" / "16 Tudor Street Dulwich SA 5065" -> {addr, suburb}
function splitAddress(t) {
  t = strip(t).replace(/\s*,?\s*(SA|South Australia)\b.*$/i, "").replace(/^(sold|address)[:\s]*/i, "");
  let addr, suburb;
  if (t.includes(",")) { const parts = t.split(",").map((x) => x.trim()).filter(Boolean); suburb = parts.pop(); addr = parts.join(", "); }
  else { const m = t.match(new RegExp("^(.*?" + STREET.source + ")\\s+(.+)$", "i")); if (m) { addr = m[1]; suburb = m[m.length - 1]; } }
  if (!addr || !suburb || !/\d/.test(addr) || /\d/.test(suburb) || suburb.length > 30) return null;
  return { addr: addr.replace(/^lot\s+\d+\s*,?\s*/i, "").trim(), suburb: title(suburb) };
}
// Generic sold-page parser: JSON-LD first (schema.org), then common listing-card markup.
function parseAgency(html, base) {
  const out = [], seen = new Set();
  const add = (r) => { if (!r || seen.has(r.addr + "|" + r.suburb)) return; seen.add(r.addr + "|" + r.suburb); out.push(r); };
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) return o.forEach(walk);
      const ad = o.address && typeof o.address === "object" ? o.address : null;
      if (ad && (ad.streetAddress || ad.name)) {
        const sp = splitAddress((ad.streetAddress || ad.name) + ", " + (ad.addressLocality || ""));
        if (sp) add({ ...sp, url: o.url || (o.item && o.item.url) || "", price: num((o.offers && o.offers.price) || ""), bed: num(o.numberOfBedrooms || o.numberOfRooms), bath: num(o.numberOfBathroomsTotal) });
      } else if (o.name && typeof o.name === "string" && STREET.test(o.name) && /^\s*\d/.test(o.name)) {
        const sp = splitAddress(o.name); if (sp) add({ ...sp, url: o.url || "", price: num((o.offers && o.offers.price) || "") });
      }
      for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
    };
    walk(j);
  }
  if (!out.length) {
    const cards = html.split(/class="[^"]*\b(?:listing-item|property-item|listing-card|property-card|listing)\b[^"]*"/i).slice(1);
    for (const c0 of cards) {
      const c = c0.slice(0, 5000);
      const am = c.match(/class="[^"]*address[^"]*"[^>]*>([\s\S]*?)<\/(?:p|h\d|div|span|a)>/i);
      if (!am) continue;
      const sp = splitAddress(am[1]); if (!sp) continue;
      const g = (k) => { const m = c.match(new RegExp('class="[^"]*' + k + '[^"]*"[^>]*>([\\s\\S]*?)<\\/', "i")); return m ? strip(m[1]) : ""; };
      const href = (c.match(/href="([^"]+)"/) || [])[1] || "";
      add({ ...sp, url: href.startsWith("http") ? href : href ? new URL(href, base).href : "", price: /\$/.test(g("price")) ? num(g("price").split("-")[0]) : 0, bed: num(g("bed")), bath: num(g("bath")), car: num(g("car")) });
    }
  }
  return out;
}

/* One page per cron run, so each site sees at most ~2 requests an hour. A full pass takes ~13 hours.
   Sale date = the day a house first appears on an agency's sold page. On the very first pass the date
   is estimated from how deep the page is (page 1 = newest). */
const geoKey = (a, s) => (a + "|" + s).toLowerCase().replace(/[^a-z0-9|/]/g, "");
async function geocode(r) {
  const q = new URLSearchParams({ format: "json", countrycodes: "au", limit: "1", q: `${r.addr}, ${r.suburb}, South Australia` });
  const res = await fetch("https://nominatim.openstreetmap.org/search?" + q, { headers: { "User-Agent": UA["User-Agent"] } });
  const j = res.ok ? await res.json().catch(() => []) : [];
  return j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
}
// Respect each site's robots.txt automatically (re-checked daily) — if a site starts disallowing us, we stop.
function robotsAllows(txt, path) {
  let applies = false, rules = [];
  for (const raw of String(txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim(); if (!line) continue;
    const [k, ...rest] = line.split(":"); const v = rest.join(":").trim(), key = k.trim().toLowerCase();
    if (key === "user-agent") applies = v === "*" || /cfkdroprun/i.test(v);
    else if (applies && (key === "disallow" || key === "allow") && v) rules.push([key, v]);
  }
  let best = null; // longest matching rule wins
  for (const [k, v] of rules) { const re = new RegExp("^" + v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")); if (re.test(path) && (!best || v.length > best[1].length)) best = [k, v]; }
  return !best || best[0] === "allow";
}
async function siteOk(st, src, u) {
  const host = new URL(u).origin, site = (st.sites[src.id] ||= {});
  if (site.blockedUntil && Date.now() < site.blockedUntil) return "paused (site blocked us)";
  if (!site.robotsAt || Date.now() - site.robotsAt > 864e5) {
    try { const r = await fetch(host + "/robots.txt", { headers: UA }); site.robots = r.ok ? (await r.text()).slice(0, 20000) : ""; } catch { site.robots = site.robots || ""; }
    site.robotsAt = Date.now();
  }
  const url = new URL(u);
  return robotsAllows(site.robots, url.pathname + url.search) ? null : "robots.txt disallows";
}

async function crawlAgencies(env, force) {
  const st = (await env.DROPS.get("agency:v1", "json")) || { rows: {}, a: 0, p: 1, passes: {}, log: [] };
  st.sites ||= {};
  if (!st.fix1) { st.fix1 = 1; delete st.passes.klemich; } // first klemich pass hit a wrong page URL
  // first pass of each site runs one page a minute so the app fills quickly; after that one page per 30 min
  const firstPassLeft = AGENCIES.some((x) => !st.passes[x.id]);
  if (!force && !firstPassLeft && st.updated && Date.now() - Date.parse(st.updated) < 29 * 60e3) return null;
  const src = AGENCIES[st.a % AGENCIES.length], first = !st.passes[src.id];
  const today = day(new Date()), u = src.page(st.p);
  let status = 0, found = 0, added = 0, known = null;
  const skip = await siteOk(st, src, u);
  if (skip) { status = skip; found = 0; }
  else try {
    const res = await fetch(u, { headers: UA }); status = res.status;
    if ([401, 403, 429, 503].includes(res.status)) st.sites[src.id].blockedUntil = Date.now() + 7 * 864e5; // never push past a block
    if (res.ok) {
      const rows = parseAgency(await res.text(), u); found = rows.length;
      for (const r of rows) {
        const k = geoKey(r.addr, r.suburb);
        if (st.rows[k]) { st.rows[k].seen = today; continue; }
        const est = day(new Date(Date.now() - Math.round(((st.p - 1) / src.pages) * 42) * 864e5));
        st.rows[k] = { ...r, type: "House", date: first ? (known && known.get(k)) || est : today, src: src.id, seen: today, ...(first && !(known && known.get(k)) ? { approx: 1 } : {}) };
        added++;
      }
    }
  } catch (e) { status = 0; }
  // geocode a few new houses per run (OpenStreetMap asks for no more than 1 request a second)
  let geo = 0;
  for (const r of Object.values(st.rows)) {
    if (geo >= 6) break;
    if (r.lat || r.geoTried) continue;
    if (geo === 0) await new Promise((ok) => setTimeout(ok, 1100));
    r.geoTried = 1; geo++;
    try { const g = await geocode(r); if (g) Object.assign(r, g); } catch {}
    await new Promise((ok) => setTimeout(ok, 1200));
  }
  // next page; wrap to next agency after its last page (or when a page comes back empty)
  if (st.p >= src.pages || !found) { st.passes[src.id] = (st.passes[src.id] || 0) + 1; st.a = (st.a + 1) % AGENCIES.length; st.p = 1; } else st.p++;
  const cut = day(new Date(Date.now() - KEEP_DAYS * 864e5));
  for (const [k, v] of Object.entries(st.rows)) if (v.date < cut) delete st.rows[k];
  st.updated = new Date().toISOString();
  const site = st.sites[src.id] ||= {};
  site.lastRun = Date.now(); site.lastStatus = status;
  if (found > 0) { site.lastOk = Date.now(); site.fails = 0; } else site.fails = (site.fails || 0) + 1;
  if (added > 0) site.lastNew = Date.now();
  site.skip = typeof status === "string" ? status : null;
  st.log = [{ t: st.updated, s: src.id, p: u, h: status, n: found, a: added, g: geo }, ...(st.log || [])].slice(0, 30);
  await env.DROPS.put("agency:v1", JSON.stringify(st));
  return st.log[0];
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

// Plain-English problems for the app to show, so nobody has to dig to find out what's wrong.
function health(ag) {
  const out = [], now = Date.now(), d = (t) => t ? new Date(t).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "Australia/Adelaide" }) : "never";
  const NAME = { klemich: "Klemich", magain: "Magain" };
  if (!ag.updated || now - Date.parse(ag.updated) > 3 * 3600e3) out.push({ level: "error", msg: `Background updater hasn't run since ${d(ag.updated && Date.parse(ag.updated))}. Check the Cloudflare worker's cron trigger.` });
  for (const a of AGENCIES) {
    const s = (ag.sites || {})[a.id] || {}, n = NAME[a.id] || a.id;
    if (s.blockedUntil && now < s.blockedUntil) out.push({ level: "error", msg: `${n}: their website is blocking our reader (error ${s.lastStatus || "?"}). Paused until ${d(s.blockedUntil)} — we never get around blocks.` });
    else if (s.skip && /robots/.test(s.skip)) out.push({ level: "error", msg: `${n}: their robots.txt now says no to automated reading, so we've stopped (legal).` });
    else if ((s.fails || 0) >= 3 && s.lastStatus === 200) out.push({ level: "error", msg: `${n}: website layout seems to have changed — no houses read since ${d(s.lastOk)}. The reader needs updating.` });
    else if ((s.fails || 0) >= 3) out.push({ level: "error", msg: `${n}: can't reach their website (${s.lastStatus || "no response"}). No houses read since ${d(s.lastOk)}.` });
    else if (s.lastOk && now - s.lastOk > 2 * 864e5) out.push({ level: "warn", msg: `${n}: nothing read since ${d(s.lastOk)}.` });
    else if (s.lastNew && now - s.lastNew > 7 * 864e5) out.push({ level: "warn", msg: `${n}: no new sold houses for a week (since ${d(s.lastNew)}).` });
  }
  return out;
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
      const ag = env.DROPS ? (await env.DROPS.get("agency:v1", "json")) || { rows: {} } : { rows: {} };
      const agRows = Object.values(ag.rows).map(({ seen, geoTried, ...r }) => ({ ...r, url: r.url || "" }));
      return Response.json({ updated: [st.updated, ag.updated].filter(Boolean).sort().pop() || null, problems: health(ag), sales: [...Object.values(st.sales), ...agRows] }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/api/status") {
      const st = env.DROPS ? await loadState(env) : {};
      const wk = day(new Date(Date.now() - 7 * 864e5));
      return Response.json({ connected: !!(env.PROPTRACK_KEY && env.PROPTRACK_SECRET), updated: st.updated || null, lastRun: st.lastRun || null,
        sales: Object.keys(st.sales || {}).length, soldLast7Days: Object.values(st.sales || {}).filter((s) => s.date >= wk).length,
        sample: url.searchParams.has("sample") ? st.sample : undefined, log: (st.log || []).slice(0, 10),
        agencies: await (async () => { const ag = (await env.DROPS.get("agency:v1", "json")) || { rows: {} }; const rows = Object.values(ag.rows);
          return { houses: rows.length, geocoded: rows.filter((r) => r.lat).length, bySite: AGENCIES.map((a) => [a.id, rows.filter((r) => r.src === a.id).length]), next: ag.a !== undefined ? AGENCIES[ag.a % AGENCIES.length].id + " p" + ag.p : null, log: (ag.log || []).slice(0, 8) }; })() }, { headers: { "Cache-Control": "no-store" } });
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
    if (!env.DROPS) return;
    ctx.waitUntil(crawlAgencies(env));
    if (env.PROPTRACK_KEY && env.PROPTRACK_SECRET) ctx.waitUntil(refresh(env, false));
  },
};
