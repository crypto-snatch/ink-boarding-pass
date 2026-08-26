# Onchain Boarding Pass

Issue your own onchain "boarding pass" — enter a wallet address and get an airline-ticket-style
card built from public data. Live routes: INK (NADO, Tydro, Ink chain), RISEx (Rise chain),
and Perpl (Monad chain);
more projects are concept passes for now. No wallet connection, read-only.

- **Live**: https://onchain-boarding-pass.onrender.com
- Deep link: `/?project=perpl&wallet=0x...`

## Architecture
- `public/` — single-page app (`index.html`, DC runtime `support.js`, brand assets)
- `server.js` — Express: static hosting + same-origin `/api/*` proxy so the browser
  never makes cross-origin calls:
  - `POST /api/rpc` → Ink RPC (whitelisted read-only methods)
  - `POST /api/nado/archive`, `/api/nado/rewards`, `GET /api/nado/symbols` (5-min cache)
  - `GET /api/explorer` → Ink explorer `getLogs` only
  - `GET /api/risex/profile?address=` → RISEx public profile aggregation (api.rise.trade, 30s cache)
  - `GET /api/perpl/profile?address=` → Perpl public leaderboard + Monad exchange state (30s cache)
  - per-IP rate limit, body caps, upstream timeouts, security headers
- Deploy: Render web service (`render.yaml`), Node ≥18, `node server.js`, health check `/health`.
