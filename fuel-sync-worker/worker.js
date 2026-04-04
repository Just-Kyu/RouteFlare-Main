/**
 * FuelPro Sync Worker — Cloudflare Worker
 *
 * Receives fuel purchase webhooks from Samsara (and/or direct Relay pushes),
 * stores them in KV, and serves them to FuelPro on demand.
 *
 * Endpoints:
 *   POST /webhook/samsara      — Samsara alert webhook (fuel level jump = fill-up)
 *   POST /webhook/relay        — Direct Relay transaction push
 *   POST /transactions         — Manual transaction push (from CSV import, etc.)
 *   GET  /transactions         — Fetch all transactions (with ?since=ISO timestamp)
 *   GET  /transactions/count   — Quick count of stored transactions
 *   DELETE /transactions       — Clear all (requires SYNC_SECRET)
 *
 * KV Structure:
 *   tx:{id}       → individual transaction JSON
 *   tx_index      → JSON array of all transaction IDs (newest first)
 *   last_sync     → ISO timestamp of last webhook received
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Sync-Secret',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// Generate a unique transaction ID
function txId(tx) {
  const base = `${tx.date}_${tx.truckUnit}_${tx.station}_${tx.total}`.replace(/[^a-zA-Z0-9_]/g, '');
  return `samsara_${base}_${Date.now().toString(36)}`;
}

// Normalize a Samsara fuel alert into our standard transaction format
function normalizeAlert(alertData) {
  // Samsara alert webhook payload structure:
  // { eventType: "Alert", data: { alert: { ... }, vehicle: { ... } } }
  const alert = alertData?.data?.alert || alertData?.alert || alertData;
  const vehicle = alertData?.data?.vehicle || alertData?.vehicle || {};

  const now = new Date().toISOString().split('T')[0];
  const location = vehicle?.gps?.reverseGeo?.formattedLocation || 'Unknown';
  const parts = location.split(',').map(p => p.trim());
  const city = parts.length >= 3 ? parts[parts.length - 3] : parts[0] || 'Unknown';
  const state = parts.length >= 2 ? parts[parts.length - 2]?.trim() : '';

  return {
    id: txId({ date: now, truckUnit: vehicle.name || '', station: 'Samsara Alert', total: 0 }),
    date: alert?.triggeredAt?.split('T')[0] || now,
    station: `Fuel Stop (via Samsara)`,
    city,
    state,
    truckUnit: vehicle.externalIds?.['samsara.unit_number'] || vehicle.name || '',
    truckName: vehicle.name || '',
    gallons: 0, // Samsara alerts don't include exact gallons
    pricePerGal: 0,
    discountedPrice: 0,
    total: 0,
    discountTotal: 0,
    saved: 0,
    companyIndex: 0,
    source: 'samsara_alert',
    raw: alertData,
    syncedAt: new Date().toISOString(),
  };
}

// Normalize a Relay transaction push
function normalizeRelay(relayData) {
  // Relay fuel transaction fields (based on their CSV/API format):
  const d = relayData;
  const date = d.work_date || d.date || d.transaction_date || new Date().toISOString().split('T')[0];
  const station = d.location || d.station || d.merchant_name || 'Unknown';
  const truckUnit = d.truck_number || d.truckUnit || d['Truck #'] || '';
  const driver = d.driver || d.driver_name || d.truckName || '';
  const gallons = parseFloat(d.volume_diesel || d.diesel_auto_volume || d.gallons || 0);
  const retailPrice = parseFloat(d.retail_price_diesel || d.retail_price || d.pricePerGal || 0);
  const discPrice = parseFloat(d.discounted_price_diesel || d.discounted_price || d.discountedPrice || retailPrice);
  const total = parseFloat(d.total_price_diesel || d.total || 0) || (gallons * discPrice);
  const saved = parseFloat(d.discount_amount_diesel || d.saved || 0) || (gallons * (retailPrice - discPrice));

  // Parse city/state from station name or location
  let city = d.city || '', stateAbbr = d.state || '';
  if (!city && station) {
    const locParts = station.split(',').map(p => p.trim());
    if (locParts.length >= 2) {
      city = locParts[locParts.length - 2] || '';
      stateAbbr = locParts[locParts.length - 1]?.replace(/\d/g, '').trim() || '';
    }
  }

  return {
    id: txId({ date, truckUnit, station, total }),
    date,
    station,
    city,
    state: stateAbbr,
    truckUnit: String(truckUnit),
    truckName: driver,
    gallons,
    pricePerGal: retailPrice,
    discountedPrice: discPrice,
    total: total || (gallons * discPrice),
    discountTotal: total || (gallons * discPrice),
    saved: saved || 0,
    companyIndex: parseInt(d.companyIndex) || 0,
    source: d._source || 'relay',
    syncedAt: new Date().toISOString(),
  };
}

// Store a transaction in KV
async function storeTx(env, tx) {
  // Save the transaction
  await env.FUEL_KV.put(`tx:${tx.id}`, JSON.stringify(tx));

  // Update the index
  let index = [];
  try {
    const raw = await env.FUEL_KV.get('tx_index');
    if (raw) index = JSON.parse(raw);
  } catch (e) { }

  // Dedupe by checking for similar transactions (same date, truck, similar total)
  const isDupe = index.some(existingId => {
    // Quick check - if IDs match exactly
    if (existingId === tx.id) return true;
    return false;
  });

  if (!isDupe) {
    index.unshift(tx.id); // newest first
    await env.FUEL_KV.put('tx_index', JSON.stringify(index));
  }

  await env.FUEL_KV.put('last_sync', new Date().toISOString());
  return !isDupe;
}

// Fetch transactions from KV
async function fetchTxs(env, since = null) {
  let index = [];
  try {
    const raw = await env.FUEL_KV.get('tx_index');
    if (raw) index = JSON.parse(raw);
  } catch (e) { }

  const transactions = [];
  for (const id of index) {
    try {
      const raw = await env.FUEL_KV.get(`tx:${id}`);
      if (raw) {
        const tx = JSON.parse(raw);
        if (since && tx.syncedAt && tx.syncedAt < since) continue;
        transactions.push(tx);
      }
    } catch (e) { }
  }

  return transactions;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ═══════════════════════════════════════
    // POST /webhook/samsara — Samsara alert webhook
    // ═══════════════════════════════════════
    if (path === '/webhook/samsara' && method === 'POST') {
      try {
        const body = await request.json();
        // Samsara sends an array of events
        const events = Array.isArray(body) ? body : [body];
        let stored = 0;

        for (const event of events) {
          // Only process fuel-related alerts
          const alertType = event?.data?.alert?.conditionType ||
            event?.alert?.conditionType || '';
          const tx = normalizeAlert(event);
          if (await storeTx(env, tx)) stored++;
        }

        return json({ ok: true, stored, total: events.length });
      } catch (e) {
        return err(`Webhook parse error: ${e.message}`, 500);
      }
    }

    // ═══════════════════════════════════════
    // POST /webhook/relay — Direct Relay transaction push
    // ═══════════════════════════════════════
    if (path === '/webhook/relay' && method === 'POST') {
      try {
        const body = await request.json();
        const items = Array.isArray(body) ? body : [body];
        let stored = 0;

        for (const item of items) {
          const tx = normalizeRelay(item);
          if (tx.gallons > 0 || tx.total > 0) {
            if (await storeTx(env, tx)) stored++;
          }
        }

        return json({ ok: true, stored, total: items.length });
      } catch (e) {
        return err(`Relay parse error: ${e.message}`, 500);
      }
    }

    // ═══════════════════════════════════════
    // POST /transactions — Manual batch push
    // ═══════════════════════════════════════
    if (path === '/transactions' && method === 'POST') {
      try {
        const body = await request.json();
        const items = Array.isArray(body) ? body : [body];
        let stored = 0;

        for (const item of items) {
          // Accept pre-formatted transactions or normalize from Relay format
          const tx = item.id && item.date && item.station
            ? { ...item, syncedAt: item.syncedAt || new Date().toISOString() }
            : normalizeRelay(item);
          if (await storeTx(env, tx)) stored++;
        }

        return json({ ok: true, stored, total: items.length });
      } catch (e) {
        return err(`Push error: ${e.message}`, 500);
      }
    }

    // ═══════════════════════════════════════
    // GET /transactions — Fetch transactions
    // ═══════════════════════════════════════
    if (path === '/transactions' && method === 'GET') {
      const since = url.searchParams.get('since') || null;
      const transactions = await fetchTxs(env, since);
      const lastSync = await env.FUEL_KV.get('last_sync');

      return json({
        ok: true,
        count: transactions.length,
        lastSync,
        transactions,
      });
    }

    // ═══════════════════════════════════════
    // GET /transactions/count — Quick count
    // ═══════════════════════════════════════
    if (path === '/transactions/count' && method === 'GET') {
      let count = 0;
      try {
        const raw = await env.FUEL_KV.get('tx_index');
        if (raw) count = JSON.parse(raw).length;
      } catch (e) { }
      const lastSync = await env.FUEL_KV.get('last_sync');
      return json({ ok: true, count, lastSync });
    }

    // ═══════════════════════════════════════
    // DELETE /transactions — Clear all (requires secret)
    // ═══════════════════════════════════════
    if (path === '/transactions' && method === 'DELETE') {
      const secret = request.headers.get('X-Sync-Secret');
      if (secret !== env.SYNC_SECRET) return err('Unauthorized', 401);

      let index = [];
      try {
        const raw = await env.FUEL_KV.get('tx_index');
        if (raw) index = JSON.parse(raw);
      } catch (e) { }

      for (const id of index) {
        await env.FUEL_KV.delete(`tx:${id}`);
      }
      await env.FUEL_KV.delete('tx_index');
      await env.FUEL_KV.delete('last_sync');

      return json({ ok: true, deleted: index.length });
    }

    // ═══════════════════════════════════════
    // GET / — Health check
    // ═══════════════════════════════════════
    if (path === '/' && method === 'GET') {
      let count = 0;
      try {
        const raw = await env.FUEL_KV.get('tx_index');
        if (raw) count = JSON.parse(raw).length;
      } catch (e) { }
      const lastSync = await env.FUEL_KV.get('last_sync');
      return json({
        service: 'FuelPro Sync Worker',
        status: 'ok',
        transactions: count,
        lastSync,
        endpoints: [
          'POST /webhook/samsara',
          'POST /webhook/relay',
          'POST /transactions',
          'GET  /transactions?since=ISO',
          'GET  /transactions/count',
          'DELETE /transactions (requires X-Sync-Secret)',
        ],
      });
    }

    // ═══════════════════════════════════════
    // Proxy to Samsara API (same as existing worker)
    // ═══════════════════════════════════════
    if (path.startsWith('/fleet/') || path.startsWith('/fuel-purchase')) {
      const samsaraUrl = `https://api.samsara.com${path}${url.search}`;
      const proxyReq = new Request(samsaraUrl, {
        method,
        headers: request.headers,
        body: method !== 'GET' ? await request.text() : undefined,
      });
      const resp = await fetch(proxyReq);
      const body = await resp.text();
      return new Response(body, {
        status: resp.status,
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    return err('Not found', 404);
  },
};
