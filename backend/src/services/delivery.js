// ─────────────────────────────────────────────
// OrderBuddy — Delivery Assignment Service
// Claim-based model: broadcast to all boys,
// first to reply CLAIM-XXXX gets the order
// ─────────────────────────────────────────────

const db       = require('../database/db');
const whatsapp = require('../services/whatsapp');

// ─────────────────────────────────────────────
// Broadcast new delivery order to all delivery boys
// Creates a pending assignment, sends claim message
// ─────────────────────────────────────────────
async function broadcastToDeliveryBoys({ order, bill, session, restaurant, cart }) {
  const deliveryPhones = (restaurant.delivery_phones || '')
    .split(',').map(p => p.trim()).filter(Boolean);

  if (!deliveryPhones.length) return null;

  // Create assignment record
  let assignment;
  try {
    assignment = await db.queryOne(
      `INSERT INTO delivery_assignments
         (order_id, restaurant_id, bill_number, customer_phone,
          delivery_address, delivery_lat, delivery_lng,
          cod_amount, status, notified_phones)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
       RETURNING *`,
      [
        order.id,
        restaurant.id,
        bill.bill_number,
        session.customer_phone,
        session.delivery_address || '',
        session.delivery_lat || null,
        session.delivery_lng || null,
        bill.grand_total,
        deliveryPhones.join(','),
      ]
    );
  } catch (e) {
    console.error('❌ delivery_assignments INSERT failed:', e.message);
    console.error('👉 Did you run migration_delivery_and_outlets.sql? Run: sudo -u postgres psql -d restaurant_ai -f migration_delivery_and_outlets.sql');
    // Still notify delivery boys even if DB insert fails
    assignment = { id: 'temp', notified_phones: deliveryPhones.join(',') };
  }

  const now = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata'
  });

  // Build message body
  let body = `🛵 *New Delivery Order!* — Tap to claim!\n`;
  body += `🏪 ${restaurant.name}\n`;
  body += `━━━━━━━━━━━━━━\n`;
  for (const item of cart.items) {
    body += `• ${item.name} x${item.quantity}\n`;
    if (item.notes) body += `  _${item.notes}_\n`;
  }
  body += `━━━━━━━━━━━━━━\n`;
  const isPaid = ['paid','completed'].includes(bill.payment_status);
  if (isPaid) {
    body += `💳 *PREPAID ₹${bill.grand_total}* (already paid online — no cash to collect)\n`;
  } else {
    body += `💰 *COD: ₹${bill.grand_total}* (collect cash on delivery)\n`;
  }
  body += `📞 Customer: +${session.customer_phone}\n`;

  if (session.delivery_address) {
    if (session.delivery_address.startsWith('https://maps.google.com')) {
      body += `📍 Location: ${session.delivery_address}\n`;
    } else {
      const enc = encodeURIComponent(session.delivery_address);
      body += `📍 Address: ${session.delivery_address}\n`;
      body += `🗺️ Maps: https://maps.google.com/?q=${enc}\n`;
    }
  }
  body += `\n⏰ ${now}`;

  // Send interactive button — delivery boy just taps, no typing needed
  const sends = deliveryPhones.map(phone =>
    whatsapp.sendInteractiveButtons(phone, body, [
      { id: `CLAIM-${bill.bill_number}`, title: '✅ Accept Delivery' },
    ])
    .then(() => console.log(`🛵 Delivery boy notified: ${phone}`))
    .catch(e => console.error(`Failed to notify ${phone}:`, e.message))
  );
  await Promise.all(sends);

  console.log(`📦 Assignment ${assignment.id} pending — ${deliveryPhones.length} boys notified`);
  return assignment;
}

// ─────────────────────────────────────────────
// Handle claim message from delivery boy
// Called when someone sends "CLAIM-XXXX"
// ─────────────────────────────────────────────
async function handleClaim(deliveryPhone, billNumber, restaurantId) {
  // Find the pending assignment for this bill
  const assignment = await db.queryOne(
    `SELECT da.*, o.id AS order_id
     FROM delivery_assignments da
     JOIN orders o ON o.id = da.order_id
     WHERE da.bill_number = $1
       AND da.restaurant_id = $2
     ORDER BY da.created_at DESC LIMIT 1`,
    [billNumber, restaurantId]
  );

  if (!assignment) {
    await whatsapp.sendMessage(deliveryPhone,
      `❌ Order *${billNumber}* not found. It may have been cancelled.`
    );
    return false;
  }

  // ── Already claimed by someone else ──
  if (assignment.status === 'claimed') {
    const takenBy = assignment.claimed_by === deliveryPhone
      ? 'you!'
      : 'another delivery boy.';
    await whatsapp.sendMessage(deliveryPhone,
      `⚠️ Order *${billNumber}* was already claimed by ${takenBy}\n\nWait for the next order! 🛵`
    );
    return false;
  }

  // ── Already delivered or cancelled ──
  if (['delivered', 'cancelled'].includes(assignment.status)) {
    await whatsapp.sendMessage(deliveryPhone,
      `ℹ️ Order *${billNumber}* is already ${assignment.status}.`
    );
    return false;
  }

  // ── Claim it — atomic update to prevent race condition ──
  const claimed = await db.queryOne(
    `UPDATE delivery_assignments
     SET status = 'claimed',
         claimed_by = $1,
         claimed_at = NOW()
     WHERE id = $2
       AND status = 'pending'
     RETURNING *`,
    [deliveryPhone, assignment.id]
  );

  if (!claimed) {
    // Race condition — someone else claimed it in the same millisecond
    await whatsapp.sendMessage(deliveryPhone,
      `⚡ Just missed it! Order *${billNumber}* was claimed by someone else.\n\nBe faster next time! 🛵`
    );
    return false;
  }

  // ── Successfully claimed ──
  console.log(`✅ Order ${billNumber} claimed by ${deliveryPhone}`);

  // Confirm to the winner
  let confirmMsg = `✅ *You got it! Order ${billNumber}*\n\n`;
  confirmMsg += `💰 *Collect: ₹${assignment.cod_amount}* from customer\n`;
  confirmMsg += `📞 *Call customer:* +${assignment.customer_phone}\n`;
  if (assignment.delivery_address) {
    if (assignment.delivery_address.startsWith('https://maps.google.com')) {
      confirmMsg += `📍 *Navigate:* ${assignment.delivery_address}\n`;
    } else {
      const enc = encodeURIComponent(assignment.delivery_address);
      confirmMsg += `📍 *Address:* ${assignment.delivery_address}\n`;
      confirmMsg += `🗺️ *Maps:* https://maps.google.com/?q=${enc}\n`;
    }
  }
  confirmMsg += `\nOnce delivered, reply: *DELIVERED-${billNumber}*`;

  // Send confirm message with "Mark Delivered" button
  await whatsapp.sendInteractiveButtons(deliveryPhone, confirmMsg, [
    { id: `DELIVERED-${billNumber}`, title: '✅ Mark as Delivered' },
  ]).catch(() => whatsapp.sendMessage(deliveryPhone, confirmMsg));

  // Notify others it's taken
  const otherPhones = (assignment.notified_phones || '')
    .split(',').map(p => p.trim())
    .filter(p => p && p !== deliveryPhone);

  const notifyOthers = otherPhones.map(phone =>
    whatsapp.sendMessage(phone,
      `ℹ️ Order *${billNumber}* has been claimed.\nStand by for the next order! 🛵`
    ).catch(() => {})
  );
  await Promise.all(notifyOthers);

  // Update order with assigned delivery boy
  await db.query(
    `UPDATE orders SET delivery_boy = $1, updated_at = NOW() WHERE id = $2`,
    [deliveryPhone, assignment.order_id]
  );

  return true;
}

// ─────────────────────────────────────────────
// Handle delivery confirmation "DELIVERED-XXXX"
// ─────────────────────────────────────────────
async function handleDelivered(deliveryPhone, billNumber, restaurantId) {
  const updated = await db.queryOne(
    `UPDATE delivery_assignments
     SET status = 'delivered', delivered_at = NOW()
     WHERE bill_number = $1
       AND restaurant_id = $2
       AND claimed_by = $3
       AND status = 'claimed'
     RETURNING *`,
    [billNumber, restaurantId, deliveryPhone]
  );

  if (!updated) {
    await whatsapp.sendMessage(deliveryPhone,
      `❌ Could not mark *${billNumber}* as delivered. Either not assigned to you or already done.`
    );
    return;
  }

  // Mark order as delivered
  await db.query(
    `UPDATE orders SET status = 'delivered', updated_at = NOW()
     WHERE id = $1`,
    [updated.order_id]
  );

  // Mark bill as delivered
  await db.query(
    `UPDATE bills SET delivery_status = 'delivered', delivered_at = NOW()
     WHERE order_id = $1`,
    [updated.order_id]
  );

  // Notify customer
  const session = await db.queryOne(
    `SELECT s.*, r.name AS restaurant_name
     FROM sessions s
     JOIN restaurants r ON r.id = s.restaurant_id
     WHERE s.id = (SELECT session_id FROM orders WHERE id = $1)`,
    [updated.order_id]
  );

  if (session) {
    await whatsapp.sendMessage(session.customer_phone,
      `🎉 *Order Delivered!*\n\nYour order from ${session.restaurant_name} has been delivered.\n` +
      `Bill: ${billNumber}\n\nEnjoy your meal! 😊🙏`
    );
  }

  await whatsapp.sendMessage(deliveryPhone,
    `✅ *Order ${billNumber} marked as delivered!*\n\nGreat work! 🛵💪\nWaiting for next order...`
  );

  console.log(`✅ Delivered: ${billNumber} by ${deliveryPhone}`);
}

module.exports = { broadcastToDeliveryBoys, handleClaim, handleDelivered };
