const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── JSON file storage ──────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const TX_FILE = path.join(DATA_DIR, 'transactions.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');

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

  try {
    const all = await samsaraFetchAll('/fleet/vehicles', apiKey);
    console.log(`[vehicles] ${all.length} total`);
    res.json({ data: all, pagination: { hasNextPage: false } });
  } catch (err) {
    console.error('[vehicles]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Samsara: ALL vehicle stats (paginated) ──────────────
app.get('/fleet/vehicles/stats', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Samsara API key' });

  try {
    const all = await samsaraFetchAll('/fleet/vehicles/stats', apiKey, {
      types: req.query.types || 'fuelPercents,engineStates,gps,obdOdometerMeters',
      decorations: req.query.decorations || '',
    });
    console.log(`[stats] ${all.length} vehicles`);
    res.json({ data: all, pagination: { hasNextPage: false } });
  } catch (err) {
    console.error('[stats]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Samsara: generic proxy ──────────────────────────────
app.all('/fleet/*', async (req, res) => {
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

// ─── API health check ────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ service: 'RouteFlare Backend', status: 'ok', transactions: getTxs().length });
});

// ─── Serve frontend (AFTER api routes) ───────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logo-icon.png', (req, res) => res.sendFile(path.join(__dirname, 'logo-icon.png')));
app.get('/logo-full.png', (req, res) => res.sendFile(path.join(__dirname, 'logo-full.png')));

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RouteFlare running on port ${PORT}`);
});
