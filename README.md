# Ink Boarding Pass

Live Ink ecosystem "boarding pass" — enter a wallet address and get an airline-ticket-style
card built from public NADO, Tydro, and Ink onchain data. No wallet connection, read-only.

- **Live**: https://ink-boarding-pass.onrender.com
- Deep link: `/?wallet=0x...`

## Architecture
- `public/` — single-page app (`index.html`, DC runtime `support.js`, brand assets)
- `server.js` — Express: static hosting + same-origin `/api/*` proxy so the browser
  never makes cross-origin calls:
  - `POST /api/rpc` → Ink RPC (whitelisted read-only methods)
  - `POST /api/nado/archive`, `/api/nado/rewards`, `GET /api/nado/symbols` (5-min cache)
  - `GET /api/explorer` → Ink explorer `getLogs` only
  - per-IP rate limit, body caps, upstream timeouts, security headers
- Deploy: Render web service (`render.yaml`), Node ≥18, `node server.js`, health check `/health`.
