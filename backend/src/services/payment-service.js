// ─────────────────────────────────────────────
// OrderBuddy — Payment Service (Gateway Router)
// src/services/payment-service.js
//
// This is the ONLY file that order-ui.js calls for payments.
// Never call a gateway adapter directly from routes.
//
// Reads restaurant's gateway config from restaurant_settings.
// Routes to correct adapter: paytm | razorpay | phonepe
//
// Adding a new gateway = add one adapter file + one case below.
// Zero changes needed in order-ui.js or server.js.
// ─────────────────────────────────────────────
const db = require('../database/db');

// ─────────────────────────────────────────────
// Get gateway config for a restaurant
// ─────────────────────────────────────────────
async function getGatewayConfig(restaurantId) {
  const [gatewayRow, configRow] = await Promise.all([
    db.queryOne(
      `SELECT value FROM restaurant_settings
       WHERE restaurant_id = $1 AND key = 'payment_gateway'`,
      [restaurantId]
    ),
    db.queryOne(
      `SELECT value FROM restaurant_settings
       WHERE restaurant_id = $1 AND key = 'payment_gateway_config'`,
      [restaurantId]
    ),
  ]);

  const gateway = gatewayRow?.value || 'paytm'; // default to paytm
  let config = {};

  if (configRow?.value) {
    try { config = JSON.parse(configRow.value); } catch {}
  }

  return { gateway, config };
}

// ─────────────────────────────────────────────
// Get adapter for gateway
// ─────────────────────────────────────────────
function getAdapter(gateway) {
  switch (gateway) {
    case 'paytm':
      return require('./adapters/paytm-adapter');
    case 'razorpay':
      return require('./adapters/razorpay-adapter');
    case 'phonepe':
      return require('./adapters/phonepe-adapter');
    default:
      throw new Error(`Unsupported payment gateway: ${gateway}`);
  }
}

// ─────────────────────────────────────────────
// Initiate payment
// Called from order-ui.js after order is created
//
// Returns: { payment_url, gateway_order_id, txn_token? }
// ─────────────────────────────────────────────
async function initiate({ restaurantId, sessionId, billId, amount, customerPhone, billNumber, mode }) {
  const { gateway, config } = await getGatewayConfig(restaurantId);

  if (!config.mid && !config.key_id) {
    throw new Error(`Payment gateway not configured for this restaurant. Add MID to settings.`);
  }

  const adapter = getAdapter(gateway);
  const BASE_URL = process.env.BASE_URL;

  const result = await adapter.initiate({
    config,
    orderId:       `OB-${billNumber}-${Date.now()}`,
    amount,                          // in paise (integer)
    customerPhone,
    billNumber,
    sessionId,
    billId,
    callbackUrl:   `${BASE_URL}/payment/webhook/${gateway}`,
    successUrl:    `${BASE_URL}/payment/success`,
    failureUrl:    `${BASE_URL}/payment/failure`,
  });

  // Store gateway info on bill — gateway-agnostic columns
  await db.query(
    `UPDATE bills
     SET gateway          = $1,
         gateway_order_id = $2,
         gateway_status   = 'initiated'
     WHERE id = $3`,
    [gateway, result.gateway_order_id, billId]
  );

  console.log(`💳 Payment initiated — ${gateway} — ${billNumber} — ₹${(amount/100).toFixed(2)}`);

  return result;
}

// ─────────────────────────────────────────────
// Handle webhook
// Called from POST /payment/webhook/:gateway
//
// Returns: { success, bill_number?, error? }
// ─────────────────────────────────────────────
async function handleWebhook(gateway, body) {
  const adapter = getAdapter(gateway);

  // 1. Adapter normalizes the webhook body
  const normalized = await adapter.handleWebhook(body);

  if (!normalized) {
    return { success: false, error: 'Invalid webhook' };
  }

  // 2. Find bill by gateway_order_id
  const bill = await db.queryOne(
    `SELECT b.*, s.customer_phone, s.id AS session_id, s.mode
     FROM bills b
     JOIN sessions s ON s.id = b.session_id
     WHERE b.gateway_order_id = $1`,
    [normalized.gateway_order_id]
  );

  if (!bill) {
    console.error(`Bill not found for gateway_order_id: ${normalized.gateway_order_id}`);
    return { success: false, error: 'Bill not found' };
  }

  // 3. Update bill with normalized data
  await db.query(
    `UPDATE bills
     SET gateway_txn_id  = $1,
         gateway_status  = $2,
         gateway_raw     = $3
     WHERE id = $4`,
    [
      normalized.gateway_txn_id,
      normalized.status,
      JSON.stringify(normalized.raw),
      bill.id,
    ]
  );

  // 4. Handle success
  if (normalized.status === 'success') {
    await db.query(
      `UPDATE bills
       SET status         = 'paid',
           payment_method = $1,
           paid_at        = NOW()
       WHERE id = $2`,
      [normalized.method || 'upi', bill.id]
    );

    // Close session
    await db.query(
      `UPDATE sessions SET status = 'paid', updated_at = NOW()
       WHERE id = $1`,
      [bill.session_id]
    );

    // WhatsApp receipt
    const { notificationQueue } = require('../queue/setup');
    await notificationQueue.add('payment-confirmed', {
      to:      bill.customer_phone,
      message: `✅ *Payment Confirmed!*\n\nBill: ${bill.bill_number}\nAmount: ₹${(bill.grand_total/100).toFixed(2)}\nTxn: ${normalized.gateway_txn_id}\n\nThank you! 🙏`,
      type:    'text',
    });

    console.log(`✅ Payment confirmed — ${gateway} — ${bill.bill_number}`);
    return { success: true, bill_number: bill.bill_number };
  }

  // 5. Handle failure
  if (normalized.status === 'failed') {
    console.log(`❌ Payment failed — ${gateway} — ${normalized.gateway_order_id}`);
    return { success: false, status: 'failed' };
  }

  // Pending — wait for next webhook
  return { success: false, status: 'pending' };
}

module.exports = { initiate, handleWebhook, getGatewayConfig };

