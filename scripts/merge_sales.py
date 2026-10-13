"""Merge newly fetched Domain sold rows into sales.json.
Usage: python3 scripts/merge_sales.py new_rows.txt
new_rows.txt: one row per line  address|suburb|type|price|YYYY-MM-DD|beds|baths|parking|url
Refuses to write if the result would shrink below half the current size (exit code 2)."""
import json, sys, re, datetime as dt
from zoneinfo import ZoneInfo
today = dt.datetime.now(ZoneInfo("Australia/Adelaide")).date()
cut = today - dt.timedelta(days=120)
cur = json.load(open("sales.json"))
by = {s["url"]: s for s in cur.get("sales", []) if s.get("url")}
before = len(by)
num = lambda v: int(re.sub(r"[^0-9]", "", v) or 0)
for ln in open(sys.argv[1], encoding="utf-8"):
    p = [x.strip() for x in ln.strip().split("|")]
    if len(p) < 9 or "domain.com.au" not in p[8]: continue
    addr, sub, typ, price, date, bed, bath, car, url = p[:9]
    addr = re.sub(r",?\s*" + re.escape(sub) + r"\s*$", "", addr, flags=re.I).strip(" ,")  # "3 Royal Close, Findon" -> "3 Royal Close"
    if not re.search(r"\d", addr) or addr.lower() == sub.lower(): continue  # no street address to drop a flyer at
    if re.search(r"land|vacant|acreage", typ, re.I): continue
    try: d = dt.date.fromisoformat(date)
    except ValueError: continue
    if d < cut or d > today: continue
    if re.search(r"apartment|unit|flat", typ, re.I): typ = "Unit"
    by[url] = {"addr": addr, "suburb": sub.title().replace("'S", "'s"), "type": typ or "House", "price": num(price),
               "date": date, "bed": num(bed), "bath": num(bath), "car": num(car), "url": url}
sales = sorted((s for s in by.values() if s["date"] >= cut.isoformat()), key=lambda s: s["date"], reverse=True)
if before and len(sales) < before / 2:
    print(f"refusing: {before} -> {len(sales)}"); sys.exit(2)
json.dump({"updated": today.isoformat(), "sales": sales}, open("sales.json", "w"), separators=(",", ":"))
print(f"{before} -> {len(sales)} sales")
