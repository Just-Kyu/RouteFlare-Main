#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# FuelPro Sync Worker — Setup Script
# ═══════════════════════════════════════════════════════════════
# This script deploys the Cloudflare Worker and registers
# a Samsara webhook so fuel transactions auto-sync to FuelPro.
#
# Prerequisites:
#   1. npm install -g wrangler
#   2. wrangler login  (authenticate with Cloudflare)
#   3. Set your Samsara API key below
# ═══════════════════════════════════════════════════════════════

set -e

# Set your Samsara API key here or via environment variable
SAMSARA_API_KEY="${SAMSARA_API_KEY:?Please set SAMSARA_API_KEY environment variable}"

echo "═══════════════════════════════════════"
echo "  FuelPro Sync Worker Setup"
echo "═══════════════════════════════════════"

# Step 1: Create KV namespace
echo ""
echo "[1/5] Creating KV namespace..."
KV_OUTPUT=$(wrangler kv:namespace create FUEL_KV 2>&1)
echo "$KV_OUTPUT"
KV_ID=$(echo "$KV_OUTPUT" | grep -oP 'id = "\K[^"]+')

if [ -z "$KV_ID" ]; then
  echo "⚠ Could not extract KV ID. Check output above and update wrangler.toml manually."
else
  echo "✓ KV namespace ID: $KV_ID"
  # Update wrangler.toml with the KV ID
  sed -i "s/^id = \"\"/id = \"$KV_ID\"/" wrangler.toml
  echo "✓ Updated wrangler.toml"
fi

# Step 2: Set the Samsara API key as a secret
echo ""
echo "[2/5] Setting Samsara API key as worker secret..."
echo "$SAMSARA_API_KEY" | wrangler secret put SAMSARA_API_KEY

# Step 3: Deploy the worker
echo ""
echo "[3/5] Deploying worker..."
wrangler deploy
WORKER_URL=$(wrangler whoami 2>&1 | grep -oP 'https://fuelpro-sync\.\S+\.workers\.dev' || echo "")

if [ -z "$WORKER_URL" ]; then
  echo ""
  echo "Enter your worker URL (e.g., https://fuelpro-sync.youraccount.workers.dev):"
  read WORKER_URL
fi

echo "✓ Worker deployed at: $WORKER_URL"

# Step 4: Register Samsara webhook for fuel alerts
echo ""
echo "[4/5] Registering Samsara webhook for fuel alerts..."

# Create webhook via Samsara API
WEBHOOK_RESPONSE=$(curl -s -X POST "https://api.samsara.com/webhooks" \
  -H "Authorization: Bearer $SAMSARA_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"FuelPro Sync\",
    \"url\": \"${WORKER_URL}/webhook/samsara\",
    \"eventTypes\": [\"Alert\"],
    \"customHeaders\": {
      \"X-Source\": \"samsara-fuelpro\"
    }
  }")

echo "$WEBHOOK_RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$WEBHOOK_RESPONSE"

WEBHOOK_ID=$(echo "$WEBHOOK_RESPONSE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null || echo "")
if [ -n "$WEBHOOK_ID" ]; then
  echo "✓ Webhook registered! ID: $WEBHOOK_ID"
else
  echo "⚠ Webhook registration may have failed. Check output above."
  echo "  You can manually create it at: https://cloud.samsara.com/o/*/settings/webhooks"
fi

# Step 5: Test the worker
echo ""
echo "[5/5] Testing worker health..."
HEALTH=$(curl -s "${WORKER_URL}/" 2>/dev/null)
echo "$HEALTH" | python3 -m json.tool 2>/dev/null || echo "$HEALTH"

echo ""
echo "═══════════════════════════════════════"
echo "  Setup Complete!"
echo "═══════════════════════════════════════"
echo ""
echo "Worker URL: ${WORKER_URL}"
echo ""
echo "Now update FuelPro's index.html:"
echo "  Set FUEL_SYNC_URL = '${WORKER_URL}'"
echo ""
echo "Samsara will push fuel alerts to: ${WORKER_URL}/webhook/samsara"
echo "Relay can push transactions to:   ${WORKER_URL}/webhook/relay"
echo ""
echo "To manually push a test transaction:"
echo "  curl -X POST ${WORKER_URL}/webhook/relay \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"work_date\":\"2026-04-03\",\"location\":\"Pilot #640\",\"truck_number\":\"201\",\"driver\":\"Test Driver\",\"volume_diesel\":100,\"retail_price_diesel\":4.10,\"discounted_price_diesel\":3.50,\"total_price_diesel\":350,\"discount_amount_diesel\":60}'"
echo ""
