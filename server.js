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
const RISEX_API_URL = 'https://api.rise.trade';

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

// The editable design file is sometimes opened from the legacy local preview
// on :8000. Let that local-only page reuse this server's real RISEx proxy.
app.use('/api/risex/profile', (req, res, next) => {
  const origin = String(req.headers.origin || '');
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    return res.sendStatus(204);
  }
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

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 25000);
  try {
    const upstream = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    const text = await upstream.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (error) {
      throw new Error('RISEx returned invalid JSON.');
    }
    if (!upstream.ok) {
      const message = data && data.error && data.error.message;
      throw new Error(message || ('RISEx HTTP ' + upstream.status));
    }
    return data && data.data !== undefined ? data.data : data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRisexTransfers(address) {
  const items = [];
  let complete = false;
  for (let page = 1; page <= 25; page += 1) {
    const query = new URLSearchParams({
      account: address,
      page: String(page),
      limit: '1000',
      sorted_by: '-time'
    });
    const data = await fetchJson(RISEX_API_URL + '/v1/account/transfer-history?' + query, 26000);
    const batch = data && Array.isArray(data.items) ? data.items : [];
    items.push.apply(items, batch);
    if (!data || !data.has_next_page) {
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error('RISEx transfer history is too large to summarize safely.');
  return items;
}

function risexCabin(rank) {
  if (!Number.isFinite(rank) || rank <= 0) return { code: 'OPEN', name: 'NEW TRAVELER' };
  if (rank <= 100) return { code: 'F', name: 'FIRST CLASS' };
  if (rank <= 500) return { code: 'J', name: 'BUSINESS' };
  if (rank <= 2500) return { code: 'W', name: 'PREMIUM ECONOMY' };
  if (rank <= 10000) return { code: 'Y+', name: 'ECONOMY PLUS' };
  return { code: 'Y', name: 'ECONOMY' };
}

function sumDecimalRows(rows) {
  const unit = 1000000000000000000n;
  let total = 0n;
  for (const item of rows) {
    const match = String(item && item.amount !== undefined ? item.amount : '0').trim().match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
    if (!match) continue;
    const fraction = (match[3] || '').slice(0, 18).padEnd(18, '0');
    const value = BigInt(match[2]) * unit + BigInt(fraction || '0');
    total += match[1] === '-' ? -value : value;
  }
  const negative = total < 0n;
  if (negative) total = -total;
  const whole = total / unit;
  const fraction = (total % unit).toString().padStart(18, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toString() + (fraction ? '.' + fraction : '');
}

const risexProfileCache = new Map();
app.get('/api/risex/profile', async (req, res) => {
  const address = String(req.query.address || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
    return res.status(400).json({ error: 'Enter a valid EVM wallet address.' });
  }

  const cached = risexProfileCache.get(address);
  if (cached && Date.now() - cached.at < 30000) {
    res.setHeader('Cache-Control', 'private, max-age=15');
    return res.json(cached.value);
  }

  const queryAddress = encodeURIComponent(address);
  const reads = await Promise.allSettled([
    fetchRisexTransfers(address),
    fetchJson(RISEX_API_URL + '/v1/stats/user-trading?address=' + queryAddress, 22000),
    fetchJson(RISEX_API_URL + '/v1/portfolio/details?account=' + queryAddress, 22000),
    fetchJson(RISEX_API_URL + '/v1/portfolio/header?account=' + queryAddress, 22000),
    fetchJson(RISEX_API_URL + '/v1/portfolio/stats?account=' + queryAddress + '&period=all', 22000)
  ]);

  if (reads.every(item => item.status === 'rejected')) {
    return res.status(502).json({ error: 'RISEx public data is temporarily unavailable.' });
  }

  const transfers = reads[0].status === 'fulfilled' ? reads[0].value : [];
  const trading = reads[1].status === 'fulfilled' ? reads[1].value : null;
  const portfolio = reads[2].status === 'fulfilled' ? reads[2].value : null;
  const header = reads[3].status === 'fulfilled' ? reads[3].value : null;
  const performance = reads[4].status === 'fulfilled' ? reads[4].value : null;
  const depositRows = transfers.filter(item => item && item.type === 'DEPOSIT');
  const withdrawalRows = transfers.filter(item => item && item.type === 'WITHDRAW');
  const latestPnl = portfolio && portfolio.summary && portfolio.summary.realized_pnl !== undefined
    ? portfolio.summary.realized_pnl
    : null;
  const allTime = header && header.all_time ? header.all_time : null;
  const rank = Number(allTime && allTime.volume_rank || 0);
  const cabin = risexCabin(rank);
  const failedSources = ['transfers', 'trading', 'pnl', 'rank', 'performance']
    .filter((name, index) => reads[index].status === 'rejected');
  const value = {
    project: 'risex',
    address,
    network: { name: 'Rise Mainnet', chainId: 4153 },
    volume: trading && trading.total_volume !== undefined
      ? String(trading.total_volume)
      : (allTime && allTime.volume !== undefined ? String(allTime.volume) : null),
    netPnl: latestPnl === null || latestPnl === undefined ? null : String(latestPnl),
    deposits: sumDecimalRows(depositRows),
    withdrawals: sumDecimalRows(withdrawalRows),
    depositCount: depositRows.length,
    withdrawalCount: withdrawalRows.length,
    tradeCount: trading && trading.trade_count !== undefined ? Number(trading.trade_count) : null,
    winRate: trading && trading.win_rate !== undefined
      ? String(trading.win_rate)
      : (performance && performance.performance ? String(performance.performance.win_rate || '') : null),
    rank: Number.isFinite(rank) && rank > 0 ? rank : null,
    cabin,
    points: null,
    pointsStatus: 'owner-auth-required',
    sourceCount: 5 - failedSources.length,
    sourceTotal: 5,
    failedSources
  };
  risexProfileCache.set(address, { at: Date.now(), value });
  if (risexProfileCache.size > 1000) {
    const oldest = risexProfileCache.keys().next().value;
    risexProfileCache.delete(oldest);
  }
  res.setHeader('Cache-Control', 'private, max-age=15');
  res.json(value);
});

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

// Local design source. Render/production serves only /public.
if (process.env.NODE_ENV !== 'production') {
  app.use('/ink', express.static(path.join(__dirname, '..', 'ink'), {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
}

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

app.listen(PORT, () => console.log('Ink Boarding Pass listening on :' + PORT));
