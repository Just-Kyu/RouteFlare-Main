const express = require('express');
const cors = require('cors');
const compression = require('compression');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));

// ─── Response cache (cuts egress by caching Samsara responses) ──
const _cache = new Map();
const CACHE_TTL = 300000;
function cacheKey(apiKey, url){ return apiKey.slice(-8) + ':' + url; }
function getCached(key){ const e = _cache.get(key); if(!e) return null; if(Date.now() - e.t > CACHE_TTL){ _cache.delete(key); return null; } return e; }
function setCache(key, status, body){ _cache.set(key, { t: Date.now(), s: status, b: body }); if(_cache.size > 500){ const first = _cache.keys().next().value; _cache.delete(first); } }

// ─── JSON file storage ──────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TX_FILE = path.join(DATA_DIR, 'transactions.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const SEED_FILE = path.join(__dirname, 'seed-data.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data));
}

function getTxs() { return readJSON(TX_FILE, []); }
function saveTxs(txs) { writeJSON(TX_FILE, txs); }
function getMeta() { return readJSON(META_FILE, {}); }
function saveMeta(m) { writeJSON(META_FILE, m); }

const SAMSARA_BASE = 'https://api.samsara.com';
const SYNC_SECRET = process.env.SYNC_SECRET || 'rf_sync_2026';

// ─── Helpers ─────────────────────────────────────────────
function getSamsaraKey(req) {
  const auth = req.headers.authorization || '';
  return auth.replace(/^Bearer\s+/i, '').trim();
}

async function samsaraFetch(endpoint, apiKey, params = {}) {
  const url = new URL(endpoint, SAMSARA_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Samsara ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function samsaraFetchAll(endpoint, apiKey, params = {}) {
  const allData = [];
  let cursor = null;
  let page = 0;

  do {
    const qp = { ...params, limit: 512 };
    if (cursor) qp.after = cursor;

    const json = await samsaraFetch(endpoint, apiKey, qp);
    allData.push(...(json.data || []));
    cursor = json.pagination?.endCursor || null;
    page++;
    if (page > 20) break;
  } while (cursor);

  return allData;
}

function txId(tx) {
  const base = `${tx.date}_${tx.truckUnit}_${tx.station}_${tx.total}`.replace(/[^a-zA-Z0-9_]/g, '');
  return `tx_${base}_${Date.now().toString(36)}`;
}

function storeTx(tx) {
  if (!tx.id) tx.id = txId(tx);
  tx.syncedAt = tx.syncedAt || new Date().toISOString();

  const txs = getTxs();
  if (txs.some(t => t.id === tx.id)) return false;

  txs.unshift(tx);
  saveTxs(txs);
  const meta = getMeta();
  meta.last_sync = new Date().toISOString();
  saveMeta(meta);
  return true;
}

// ─── Samsara: ALL vehicles (paginated) ───────────────────
app.get('/fleet/vehicles', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Samsara API key' });

  const ck = cacheKey(apiKey, '/fleet/vehicles');
  const hit = getCached(ck);
  if(hit){ console.log('[vehicles] cache hit'); return res.status(hit.s).set('Content-Type','application/json').send(hit.b); }
  try {
    const all = await samsaraFetchAll('/fleet/vehicles', apiKey);
    console.log(`[vehicles] ${all.length} total`);
    const body = JSON.stringify({ data: all, pagination: { hasNextPage: false } });
    setCache(ck, 200, body);
    res.set('Content-Type','application/json').send(body);
  } catch (err) {
    console.error('[vehicles]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Samsara: generic proxy (handles /fleet/vehicles/stats and all other /fleet/* calls) ──
app.all('/fleet/*', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Samsara API key' });

  try {
    const samsaraUrl = `${SAMSARA_BASE}${req.originalUrl}`;
    if(req.method === 'GET'){
      const ck = cacheKey(apiKey, req.originalUrl);
      const hit = getCached(ck);
      if(hit){ console.log(`[proxy] cache hit ${req.originalUrl.slice(0,60)}`); return res.status(hit.s).set('Content-Type','application/json').send(hit.b); }
    }
    console.log(`[proxy] ${req.method} ${samsaraUrl.slice(0,80)}`);
    const opts = {
      method: req.method,
      headers: { Authorization: `Bearer ${apiKey}` },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') opts.body = JSON.stringify(req.body);
    const sRes = await fetch(samsaraUrl, opts);
    const data = await sRes.text();
    console.log(`[proxy] → ${sRes.status} (${data.length} bytes)`);
    if(req.method === 'GET') setCache(cacheKey(apiKey, req.originalUrl), sRes.status, data);
    res.status(sRes.status).set('Content-Type', 'application/json').send(data);
  } catch (err) {
    console.error(`[proxy] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.all('/fuel-purchase/*', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Samsara API key' });

  try {
    const opts = {
      method: req.method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') opts.body = JSON.stringify(req.body);
    const sRes = await fetch(`${SAMSARA_BASE}${req.originalUrl}`, opts);
    const data = await sRes.text();
    res.status(sRes.status).set('Content-Type', 'application/json').send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Debug endpoint ──────────────────────────────────────
app.get('/api/debug/samsara', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Send Authorization: Bearer <key> header' });

  const out = { vehicles: null, stats: null, errors: [] };
  try {
    const vRes = await fetch(`${SAMSARA_BASE}/fleet/vehicles?limit=3`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    out.vehicles = await vRes.json();
  } catch (e) { out.errors.push('vehicles: ' + e.message); }

  try {
    const sRes = await fetch(`${SAMSARA_BASE}/fleet/vehicles/stats?types=fuelPercents,engineStates,gps,obdOdometerMeters&limit=3`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    out.stats = await sRes.json();
  } catch (e) { out.errors.push('stats: ' + e.message); }

  res.json(out);
});

// ─── Shared config (companies, API keys, settings) ──────
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Config is synced from clients on every page load — no need to seed empty keys

app.get('/api/config', (req, res) => {
  const config = readJSON(CONFIG_FILE, null);
  if (!config) return res.json({ ok: false });
  res.json({ ok: true, config });
});

app.post('/api/config', (req, res) => {
  const { companies, apiKeys, threshold, adminUrl } = req.body;
  if (!companies || !apiKeys) return res.status(400).json({ error: 'Missing companies/apiKeys' });

  const config = {
    companies,
    apiKeys,
    threshold: threshold || 20,
    adminUrl: adminUrl || '',
    updatedAt: new Date().toISOString(),
  };
  writeJSON(CONFIG_FILE, config);
  console.log(`[config] Saved ${companies.length} companies`);
  res.json({ ok: true });
});

// ─── Transactions ────────────────────────────────────────
app.post('/transactions', (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    let stored = 0;
    for (const item of items) { if (storeTx(item)) stored++; }
    res.json({ ok: true, stored, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/transactions', (req, res) => {
  const since = req.query.since || null;
  let txs = getTxs();
  if (since) txs = txs.filter(t => t.syncedAt && t.syncedAt >= since);
  const meta = getMeta();
  res.json({ ok: true, count: txs.length, lastSync: meta.last_sync || null, transactions: txs });
});

app.get('/transactions/count', (req, res) => {
  const meta = getMeta();
  res.json({ ok: true, count: getTxs().length, lastSync: meta.last_sync || null });
});

app.delete('/transactions', (req, res) => {
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  const count = getTxs().length;
  saveTxs([]);
  const meta = getMeta(); delete meta.last_sync; saveMeta(meta);
  res.json({ ok: true, deleted: count });
});

// ─── Webhooks ────────────────────────────────────────────
app.post('/webhook/samsara', (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    let stored = 0;
    for (const event of events) {
      const vehicle = event?.data?.vehicle || event?.vehicle || {};
      const alert = event?.data?.alert || event?.alert || event;
      const now = new Date().toISOString().split('T')[0];
      const loc = vehicle?.gps?.reverseGeo?.formattedLocation || 'Unknown';
      const parts = loc.split(',').map(p => p.trim());
      const tx = {
        id: txId({ date: now, truckUnit: vehicle.name || '', station: 'Samsara Alert', total: 0 }),
        date: alert?.triggeredAt?.split('T')[0] || now,
        station: 'Fuel Stop (via Samsara)',
        city: parts.length >= 3 ? parts[parts.length - 3] : parts[0] || 'Unknown',
        state: parts.length >= 2 ? parts[parts.length - 2]?.trim() : '',
        truckUnit: vehicle.externalIds?.['samsara.unit_number'] || vehicle.name || '',
        truckName: vehicle.name || '',
        gallons: 0, pricePerGal: 0, discountedPrice: 0, total: 0, saved: 0,
        source: 'samsara_alert', syncedAt: new Date().toISOString(),
      };
      if (storeTx(tx)) stored++;
    }
    res.json({ ok: true, stored, total: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook/relay', (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    let stored = 0;
    for (const d of items) {
      const date = d.work_date || d.date || d.transaction_date || new Date().toISOString().split('T')[0];
      const station = d.location || d.station || d.merchant_name || 'Unknown';
      const truckUnit = d.truck_number || d.truckUnit || d['Truck #'] || '';
      const gallons = parseFloat(d.volume_diesel || d.diesel_auto_volume || d.gallons || 0);
      const retailPrice = parseFloat(d.retail_price_diesel || d.retail_price || d.pricePerGal || 0);
      const discPrice = parseFloat(d.discounted_price_diesel || d.discounted_price || d.discountedPrice || retailPrice);
      const total = parseFloat(d.total_price_diesel || d.total || 0) || (gallons * discPrice);
      const saved = parseFloat(d.discount_amount_diesel || d.saved || 0) || (gallons * (retailPrice - discPrice));
      const tx = {
        id: txId({ date, truckUnit, station, total }),
        date, station, truckUnit,
        truckName: d.driver || d.driver_name || d.truckName || '',
        gallons, pricePerGal: retailPrice, discountedPrice: discPrice,
        total, saved, source: d._source || 'relay', syncedAt: new Date().toISOString(),
      };
      if (gallons > 0 || total > 0) { if (storeTx(tx)) stored++; }
    }
    res.json({ ok: true, stored, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Fuel Logs (persistent, shared across team) ─────────
const FUEL_LOGS_FILE = path.join(DATA_DIR, 'fuel-logs.json');
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
if (!fs.existsSync(RECEIPTS_DIR)) fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

function getFuelLogs() { return readJSON(FUEL_LOGS_FILE, []); }
function saveFuelLogs(logs) { writeJSON(FUEL_LOGS_FILE, logs); }

// Auto-seed fuel logs from seed-data.json on first run
if (getFuelLogs().length === 0 && fs.existsSync(SEED_FILE)) {
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    if (seed.ff_fuel_log) {
      const logs = JSON.parse(seed.ff_fuel_log);
      if (logs.length) {
        saveFuelLogs(logs);
        console.log(`[RouteFlare] Seeded ${logs.length} fuel logs from seed-data.json`);
      }
    }
  } catch (e) { console.warn('Seed load failed:', e.message); }
}

app.get('/api/fuel-logs', (req, res) => {
  const logs = getFuelLogs();
  if (req.query.countOnly === '1') {
    return res.json({ ok: true, count: logs.length });
  }
  res.json({ ok: true, count: logs.length, logs });
});

app.post('/api/fuel-logs', (req, res) => {
  try {
    const logs = getFuelLogs();
    const items = Array.isArray(req.body) ? req.body : [req.body];
    let added = 0, updated = 0;
    const existingMap = new Map(logs.map((l, i) => [l.id, i]));
    for (const item of items) {
      if (!item.id) continue;
      const idx = existingMap.get(item.id);
      if (idx === undefined) {
        logs.push(item);
        existingMap.set(item.id, logs.length - 1);
        added++;
      } else if (item.editedAt && (!logs[idx].editedAt || item.editedAt > logs[idx].editedAt)) {
        logs[idx] = item;
        updated++;
      } else if (item.createdAt && !logs[idx].createdAt) {
        logs[idx] = item;
        updated++;
      }
    }
    if (added || updated) saveFuelLogs(logs);
    res.json({ ok: true, added, updated, total: logs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/fuel-logs/:id', (req, res) => {
  try {
    const logs = getFuelLogs();
    const idx = logs.findIndex(l => l.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    logs[idx] = { ...logs[idx], ...req.body, id: req.params.id };
    saveFuelLogs(logs);
    res.json({ ok: true, log: logs[idx] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/fuel-logs/:id', (req, res) => {
  try {
    let logs = getFuelLogs();
    const before = logs.length;
    logs = logs.filter(l => l.id !== req.params.id);
    saveFuelLogs(logs);
    // Track deleted IDs so other clients learn about deletions
    const deleted = readJSON(path.join(DATA_DIR, 'deleted-ids.json'), []);
    if (!deleted.includes(req.params.id)) {
      deleted.push(req.params.id);
      writeJSON(path.join(DATA_DIR, 'deleted-ids.json'), deleted);
    }
    res.json({ ok: true, deleted: before - logs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fuel-logs/deleted', (req, res) => {
  const deleted = readJSON(path.join(DATA_DIR, 'deleted-ids.json'), []);
  res.json({ ok: true, ids: deleted });
});

// ─── Receipt upload (base64 in JSON body) ────────────────
app.post('/api/fuel-logs/:id/receipt', (req, res) => {
  try {
    const { data, filename, mimeType } = req.body;
    if (!data || !filename) return res.status(400).json({ error: 'Missing data or filename' });
    const ext = path.extname(filename).toLowerCase() || '.bin';
    const allowed = ['.png', '.jpg', '.jpeg', '.pdf'];
    if (!allowed.includes(ext)) return res.status(400).json({ error: 'Only PNG, JPG, PDF allowed' });
    const safeName = `${req.params.id}_${Date.now()}${ext}`;
    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(path.join(RECEIPTS_DIR, safeName), buf);
    const logs = getFuelLogs();
    const log = logs.find(l => l.id === req.params.id);
    if (log) {
      if (!log.receipts) log.receipts = [];
      log.receipts.push({ name: safeName, originalName: filename, mimeType: mimeType || 'application/octet-stream', uploadedAt: new Date().toISOString() });
      saveFuelLogs(logs);
    }
    res.json({ ok: true, receipt: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/receipts/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename);
  const filePath = path.join(RECEIPTS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// ─── API health check ────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ service: 'RouteFlare Backend', status: 'ok', fuelLogs: getFuelLogs().length, transactions: getTxs().length, uptime: Math.floor(process.uptime()) });
});

// ─── Seed data for first-time setup ──────────────────────
app.get('/api/seed-data', (req, res) => {
  const seedFile = path.join(__dirname, 'seed-data.json');
  if (fs.existsSync(seedFile)) return res.sendFile(seedFile);
  res.json({});
});

// ─── Serve frontend (AFTER api routes) ───────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logo-icon.png', (req, res) => res.sendFile(path.join(__dirname, 'logo-icon.png')));
app.get('/logo-full.png', (req, res) => res.sendFile(path.join(__dirname, 'logo-full.png')));

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RouteFlare running on port ${PORT}`);
});
