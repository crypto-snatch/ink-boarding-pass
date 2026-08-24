// Ink Boarding Pass — static host + same-origin API proxy.
// Proxies public NADO / Tydro / Ink endpoints so the browser never hits CORS.
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

const INK_RPC_URL = 'https://rpc-gel.inkonchain.com';
const NADO_ARCHIVE_URL = 'https://archive.prod.nado.xyz/v1';
const NADO_REWARDS_URL = 'https://archive.prod.nado.xyz/rewards/v1';
const NADO_SYMBOLS_URL = 'https://gateway.prod.nado.xyz/v1/query?type=symbols';
const INK_EXPLORER_API = 'https://explorer.inkonchain.com/api';

const RPC_METHODS = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getBalance',
  'eth_getTransactionCount', 'eth_call'
]);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '120kb' }));

// --- tiny per-IP rate limit (protects upstreams from abuse) ---
const hits = new Map();
app.use('/api/', (req, res, next) => {
  const now = Date.now();
  // Behind Render's proxy the trustworthy client IP is the LAST entry
  // (client-supplied X-Forwarded-For values are prepended, so first is spoofable).
  const fwd = req.headers['x-forwarded-for'];
  const key = fwd
    ? String(fwd).split(',').pop().trim()
    : req.socket.remoteAddress;
  let entry = hits.get(key);
  if (!entry || now - entry.start > 10000) {
    entry = { start: now, count: 0 };
    hits.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > 240) return res.status(429).json({ error: 'Too many requests.' });
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now - v.start > 10000) hits.delete(k);
  }
  next();
});

async function forward(res, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 25000);
  try {
    const upstream = await fetch(url, Object.assign({}, init, { signal: controller.signal }));
    const text = await upstream.text();
    res.status(upstream.status)
      .type(upstream.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'Upstream timed out.' : 'Upstream request failed.' });
  } finally {
    clearTimeout(timer);
  }
}

const postJson = body => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

app.post('/api/rpc', (req, res) => {
  const body = req.body;
  if (!body || typeof body.method !== 'string' || !RPC_METHODS.has(body.method)) {
    return res.status(400).json({ error: 'RPC method not allowed.' });
  }
  forward(res, INK_RPC_URL, postJson(body), 20000);
});

app.post('/api/nado/archive', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid body.' });
  forward(res, NADO_ARCHIVE_URL, postJson(req.body), 25000);
});

app.post('/api/nado/rewards', (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'Invalid body.' });
  forward(res, NADO_REWARDS_URL, postJson(req.body), 25000);
});

// Symbols change rarely — cache for 5 minutes.
let symbolsCache = { at: 0, text: '', type: 'application/json' };
app.get('/api/nado/symbols', async (req, res) => {
  if (symbolsCache.text && Date.now() - symbolsCache.at < 300000) {
    return res.type(symbolsCache.type).send(symbolsCache.text);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const upstream = await fetch(NADO_SYMBOLS_URL, { signal: controller.signal });
    const text = await upstream.text();
    if (upstream.ok) symbolsCache = { at: Date.now(), text, type: upstream.headers.get('content-type') || 'application/json' };
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (error) {
    res.status(502).json({ error: 'Upstream request failed.' });
  } finally {
    clearTimeout(timer);
  }
});

app.get('/api/explorer', (req, res) => {
  const q = req.query || {};
  if (q.module !== 'logs' || q.action !== 'getLogs') {
    return res.status(400).json({ error: 'Only log queries are allowed.' });
  }
  const params = new URLSearchParams();
  for (const key of Object.keys(q)) {
    const value = q[key];
    if (typeof value === 'string' && value.length < 200) params.set(key, value);
  }
  forward(res, INK_EXPLORER_API + '?' + params.toString(), {}, 26000);
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

app.listen(PORT, () => console.log('Ink Boarding Pass listening on :' + PORT));
