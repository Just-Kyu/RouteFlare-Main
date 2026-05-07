const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── SQLite setup ────────────────────────────────────────
const dbPath = process.env.DB_PATH || path.join(__dirname, 'routeflare.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

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
  const limit = 512;

  do {
    const qp = { ...params, limit };
    if (cursor) qp.after = cursor;

    const json = await samsaraFetch(endpoint, apiKey, qp);
    const items = json.data || [];
    allData.push(...items);
    cursor = json.pagination?.endCursor || null;
    page++;

    if (page > 20) break;
  } while (cursor);

  return allData;
}

// ─── Samsara: Get ALL vehicles (paginated) ───────────────
app.get('/fleet/vehicles', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Samsara API key' });

  try {
    const allVehicles = await samsaraFetchAll('/fleet/vehicles', apiKey);
    console.log(`[vehicles] Fetched ${allVehicles.length} vehicles`);
    res.json({ data: allVehicles, pagination: { hasNextPage: false } });
  } catch (err) {
    console.error('[vehicles]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Samsara: Get ALL vehicle stats (paginated) ─────────
app.get('/fleet/vehicles/stats', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Samsara API key' });

  const types = req.query.types || 'fuelPercents,engineStates,gps,obdOdometerMeters';
  const decorations = req.query.decorations || '';

  try {
    const allStats = await samsaraFetchAll('/fleet/vehicles/stats', apiKey, {
      types,
      decorations,
    });
    console.log(`[stats] Fetched stats for ${allStats.length} vehicles`);
    res.json({ data: allStats, pagination: { hasNextPage: false } });
  } catch (err) {
    console.error('[stats]', err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Samsara: Generic proxy for any other /fleet/* call ──
app.all('/fleet/*', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Samsara API key' });

  const samsaraUrl = `${SAMSARA_BASE}${req.originalUrl}`;
  try {
    const opts = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      opts.body = JSON.stringify(req.body);
    }
    const sRes = await fetch(samsaraUrl, opts);
    const data = await sRes.text();
    res.status(sRes.status).set('Content-Type', 'application/json').send(data);
  } catch (err) {
    console.error('[proxy]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Fuel-purchase proxy ─────────────────────────────────
app.all('/fuel-purchase/*', async (req, res) => {
  const apiKey = getSamsaraKey(req);
  if (!apiKey) return res.status(401).json({ error: 'Missing Samsara API key' });

  const samsaraUrl = `${SAMSARA_BASE}${req.originalUrl}`;
  try {
    const opts = {
      method: req.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      opts.body = JSON.stringify(req.body);
    }
    const sRes = await fetch(samsaraUrl, opts);
    const data = await sRes.text();
    res.status(sRes.status).set('Content-Type', 'application/json').send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transactions: POST (store) ──────────────────────────
function txId(tx) {
  const base = `${tx.date}_${tx.truckUnit}_${tx.station}_${tx.total}`.replace(/[^a-zA-Z0-9_]/g, '');
  return `tx_${base}_${Date.now().toString(36)}`;
}

function storeTx(tx) {
  if (!tx.id) tx.id = txId(tx);
  tx.syncedAt = tx.syncedAt || new Date().toISOString();

  const existing = db.prepare('SELECT id FROM transactions WHERE id = ?').get(tx.id);
  if (existing) return false;

  db.prepare('INSERT INTO transactions (id, data) VALUES (?, ?)').run(tx.id, JSON.stringify(tx));
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)").run(new Date().toISOString());
  return true;
}

app.post('/transactions', (req, res) => {
  try {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    let stored = 0;
    for (const item of items) {
      if (storeTx(item)) stored++;
    }
    res.json({ ok: true, stored, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Transactions: GET ───────────────────────────────────
app.get('/transactions', (req, res) => {
  const since = req.query.since || null;
  const rows = db.prepare('SELECT data FROM transactions ORDER BY created_at DESC').all();
  let txs = rows.map(r => JSON.parse(r.data));
  if (since) txs = txs.filter(t => t.syncedAt && t.syncedAt >= since);
  const lastSync = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get();
  res.json({ ok: true, count: txs.length, lastSync: lastSync?.value || null, transactions: txs });
});

// ─── Transactions: count ─────────────────────────────────
app.get('/transactions/count', (req, res) => {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM transactions').get();
  const lastSync = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get();
  res.json({ ok: true, count: row.cnt, lastSync: lastSync?.value || null });
});

// ─── Transactions: DELETE ────────────────────────────────
app.delete('/transactions', (req, res) => {
  const secret = req.headers['x-sync-secret'];
  if (secret !== SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const row = db.prepare('SELECT COUNT(*) as cnt FROM transactions').get();
  db.prepare('DELETE FROM transactions').run();
  db.prepare("DELETE FROM meta WHERE key = 'last_sync'").run();
  res.json({ ok: true, deleted: row.cnt });
});

// ─── Webhooks ────────────────────────────────────────────
app.post('/webhook/samsara', (req, res) => {
  try {
    const events = Array.isArray(req.body) ? req.body : [req.body];
    let stored = 0;
    for (const event of events) {
      const alert = event?.data?.alert || event?.alert || event;
      const vehicle = event?.data?.vehicle || event?.vehicle || {};
      const now = new Date().toISOString().split('T')[0];
      const location = vehicle?.gps?.reverseGeo?.formattedLocation || 'Unknown';
      const parts = location.split(',').map(p => p.trim());

      const tx = {
        id: txId({ date: now, truckUnit: vehicle.name || '', station: 'Samsara Alert', total: 0 }),
        date: alert?.triggeredAt?.split('T')[0] || now,
        station: 'Fuel Stop (via Samsara)',
        city: parts.length >= 3 ? parts[parts.length - 3] : parts[0] || 'Unknown',
        state: parts.length >= 2 ? parts[parts.length - 2]?.trim() : '',
        truckUnit: vehicle.externalIds?.['samsara.unit_number'] || vehicle.name || '',
        truckName: vehicle.name || '',
        gallons: 0,
        pricePerGal: 0,
        discountedPrice: 0,
        total: 0,
        saved: 0,
        source: 'samsara_alert',
        syncedAt: new Date().toISOString(),
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
        total, saved, source: d._source || 'relay',
        syncedAt: new Date().toISOString(),
      };
      if (gallons > 0 || total > 0) { if (storeTx(tx)) stored++; }
    }
    res.json({ ok: true, stored, total: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health check ────────────────────────────────────────
app.get('/', (req, res) => {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM transactions').get();
  const lastSync = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get();
  res.json({
    service: 'RouteFlare Backend',
    status: 'ok',
    transactions: row.cnt,
    lastSync: lastSync?.value || null,
    features: [
      'Samsara proxy with full pagination (all vehicles)',
      'Fuel transaction storage (SQLite)',
      'Webhook endpoints for Samsara & Relay',
    ],
  });
});

// ─── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RouteFlare backend running on port ${PORT}`);
});
