# CFK Drop Run

Map of recently sold homes across South Australia for Choices Flooring Keswick flyer drops.

- `index.html` — the app (live GPS, week/fortnight/month filter, best-route planning)
- Sales come only from agency sites whose terms and robots.txt allow it (see `AGENCIES` in worker.js), read slowly by a 30-minute cron, plus PropTrack if licensed keys are added
- Map: OpenFreeMap / OpenMapTiles / © OpenStreetMap contributors
- `functions/api/drops.js` — shared "dropped" ticks, stored in Cloudflare KV

## Cloudflare Pages setup (once)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → pick `cfk-drop-run`.
2. Build settings: framework **None**, build command empty, output directory `/`. Deploy.
3. **Storage & Databases → KV** → create a namespace called `cfk-drops`.
4. Back in the Pages project → **Settings → Bindings** → add **KV namespace**: variable name `DROPS`, namespace `cfk-drops`. Redeploy.
5. Optional: **Custom domains** → add e.g. `drop.choicesflooring.com.au`.

Every push to `main` (including the nightly sales update) redeploys automatically.
