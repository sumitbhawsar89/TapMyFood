require('dotenv').config();
const { Worker } = require('bullmq');
const db          = require('../database/db');
const whatsapp    = require('../services/whatsapp');
const { redisConnection } = require('./setup');
const deliverySvc = require('../services/delivery');

console.log('🚀 Worker started — waiting for messages...');

// ─────────────────────────────────────────────
// MESSAGE WORKER
// Handles incoming WhatsApp messages
//
// What this worker does:
//   1. Delivery boy CLAIM / DELIVERED commands
//   2. Owner ! commands (stats, offers)
//   3. ALL customer messages → welcome + web URL
//
// What this worker does NOT do:
//   - WhatsApp ordering (moved to web UI)
//   - Cart management (web UI handles this)
//   - Session creation (customer does this in web UI by entering phone)
// ─────────────────────────────────────────────
const messageWorker = new Worker('whatsapp-messages', async (job) => {

  const { from, message, restaurantId, isButtonReply, buttonId, timestamp } = job.data;
  console.log(`📨 Processing from ${from}: "${message}" ${buttonId ? `[button: ${buttonId}]` : ''}`);

  // ── 1. Delivery boy button commands ──
  const claimSource = (buttonId || message || '').toUpperCase().trim();
  if (claimSource.startsWith('CLAIM-')) {
    const billNumber = claimSource.substring(6).trim();
    await deliverySvc.handleClaim(from, billNumber, restaurantId);
    return;
  }
  if (claimSource.startsWith('DELIVERED-')) {
    const billNumber = claimSource.substring(10).trim();
    await deliverySvc.handleDelivered(from, billNumber, restaurantId);
    return;
  }

  // ── 2. Get restaurant info ──
  const restaurant = await db.queryOne(
    'SELECT * FROM restaurants WHERE id = $1 AND is_active = true',
    [restaurantId]
  );
  if (!restaurant) {
    console.log(`⚠️ Restaurant not found: ${restaurantId}`);
    return;
  }
  console.log(`✅ Restaurant found: ${restaurant.name}`);

  // ── 3. Owner ! commands ──
  if (restaurant.owner_phone === from && (message || '').startsWith('!')) {
    await handleOwnerCommand(from, message.substring(1).trim(), restaurant);
    return;
  }

  // ── 4. Restaurant hours check ──
  if (restaurant.open_time && restaurant.close_time) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const [openH, openM]   = restaurant.open_time.split(':').map(Number);
    const [closeH, closeM] = restaurant.close_time.split(':').map(Number);
    const nowMins   = now.getHours() * 60 + now.getMinutes();
    const openMins  = openH * 60 + openM;
    const closeMins = closeH * 60 + closeM;
    if (nowMins < openMins || nowMins >= closeMins) {
      await whatsapp.sendMessage(from,
        `🕐 *We're currently closed!*\n\n` +
        `${restaurant.name} is open from *${restaurant.open_time}* to *${restaurant.close_time}* (IST).\n\n` +
        `Please message us during opening hours. We'd love to serve you! 🙏`
      );
      return;
    }
  }

  // ── 5. STOP / START opt-out ──
  const msg = (message || '').toLowerCase().trim();
  if (msg === 'stop' || msg === 'unsubscribe') {
    await db.query(
      `INSERT INTO opt_outs (restaurant_id, phone)
       VALUES ($1, $2) ON CONFLICT (restaurant_id, phone) DO NOTHING`,
      [restaurantId, from]
    );
    await whatsapp.sendMessage(from,
      `You've been unsubscribed. Reply *START* to re-subscribe anytime. 🙏`
    );
    return;
  }
  if (msg === 'start' || msg === 'subscribe') {
    await db.query(
      `DELETE FROM opt_outs WHERE restaurant_id = $1 AND phone = $2`,
      [restaurantId, from]
    );
    await whatsapp.sendMessage(from, `You're back! You'll now receive updates from us. 🎉`);
    return;
  }

  // ── 6. Check opt-out ──
  const optedOut = await db.queryOne(
    `SELECT 1 FROM opt_outs WHERE restaurant_id = $1 AND phone = $2`,
    [restaurantId, from]
  );
  if (optedOut) { console.log(`⛔ Opted out: ${from}`); return; }

  console.log(`🔵 Reached step 7 — sending welcome to ${from}`);

  // ── 7. ALL CUSTOMER MESSAGES → Welcome + Web URL ──
  // Customer enters their phone number in web UI to create a session
  // WhatsApp number is used ONLY for sending this link + future notifications
  const appUrl   = process.env.APP_URL || 'https://tapmyfood.com';
  // Encode last 10 digits of WhatsApp number in URL so start.html can pre-fill phone
  const phoneHint = from.replace(/\D/g, '').slice(-10);
  const startUrl  = `${appUrl}/start?r=${restaurantId}&p=${phoneHint}`;

  await whatsapp.sendMessage(from,
    `👋 *Welcome to ${restaurant.name}!*\n\n` +
    `📱 *Tap to browse menu & place your order:*\n` +
    `${startUrl}\n\n` +
    `_Select Delivery or Takeaway on the next screen_`
  );

  console.log(`📱 Welcome + URL sent to ${from}`);

}, { connection: redisConnection, concurrency: 1 });

// ─────────────────────────────────────────────
// OWNER WHATSAPP COMMANDS (! prefix)
// e.g. !STATS, !OFFER LIST, !OFFER ADD 20% off today
// ─────────────────────────────────────────────
async function handleOwnerCommand(from, message, restaurant) {
  const msg   = message.trim();
  const lower = msg.toLowerCase();
  console.log(`👑 Owner command from ${from}: "${msg}"`);

  // HELP
  if (lower === 'help') {
    await whatsapp.sendMessage(from,
      `👑 *Owner Commands*\n_(prefix all with !)_\n\n` +
      `*!OFFER LIST* — see all offers\n` +
      `*!OFFER ADD <text>* — add new offer\n` +
      `  Examples:\n` +
      `  !OFFER ADD 20% off today\n` +
      `  !OFFER ADD Happy hours 4-7pm 15% off\n` +
      `  !OFFER ADD Free cold coffee above 200\n` +
      `  !OFFER ADD 10% off on thursday\n` +
      `*!OFFER OFF <number>* — deactivate offer\n` +
      `*!OFFER ON <number>* — reactivate offer\n` +
      `*!OFFER DEL <number>* — delete offer\n` +
      `*!STATS* — today's order summary\n` +
      `*!TAKEAWAY LIST* — pending pickup tokens today`
    );
    return;
  }

  // STATS
  if (lower === 'stats') {
    const today = new Date().toISOString().slice(0, 10);
    const stats = await db.queryOne(
      `SELECT COUNT(DISTINCT o.id) as total_orders,
              COALESCE(SUM(b.grand_total), 0) as total_revenue
       FROM orders o
       LEFT JOIN bills b ON b.order_id = o.id
       WHERE o.restaurant_id = $1 AND DATE(o.created_at) = $2`,
      [restaurant.id, today]
    );
    await whatsapp.sendMessage(from,
      `📊 *Today's Stats — ${restaurant.name}*\n\n` +
      `Orders: ${stats.total_orders}\n` +
      `Revenue: ₹${stats.total_revenue}`
    );
    return;
  }

  // OFFER LIST
  if (lower === 'offer list' || lower === 'offer' || lower === 'offers') {
    const offers = await db.queryAll(
      `SELECT o.*, mi.name as free_item_name
       FROM offers o LEFT JOIN menu_items mi ON mi.id = o.free_item_id
       WHERE o.restaurant_id = $1 ORDER BY o.created_at DESC`,
      [restaurant.id]
    );
    if (!offers.length) {
      await whatsapp.sendMessage(from, 'No offers yet. Use !OFFER ADD to create one.');
      return;
    }
    let reply = `🎉 *Offers for ${restaurant.name}*\n\n`;
    offers.forEach((o, i) => {
      reply += `${o.is_active ? '✅' : '❌'} *${i + 1}. ${o.title}*\n`;
      if (o.happy_hour_start) reply += `   ⏰ ${o.happy_hour_start.slice(0,5)} - ${o.happy_hour_end.slice(0,5)}\n`;
      if (o.valid_until)      reply += `   📅 Until: ${o.valid_until}\n`;
      reply += '\n';
    });
    reply += `_!OFFER OFF <number> to deactivate_`;
    await whatsapp.sendMessage(from, reply);
    return;
  }

  // OFFER OFF / ON
  if (lower.startsWith('offer off ') || lower.startsWith('offer on ')) {
    const isOff  = lower.startsWith('offer off');
    const num    = parseInt(lower.split(' ').pop()) - 1;
    const offers = await db.queryAll(
      'SELECT id, title FROM offers WHERE restaurant_id = $1 ORDER BY created_at DESC',
      [restaurant.id]
    );
    if (!offers[num]) { await whatsapp.sendMessage(from, `❌ Offer #${num+1} not found.`); return; }
    await db.query('UPDATE offers SET is_active = $1 WHERE id = $2', [!isOff, offers[num].id]);
    await whatsapp.sendMessage(from, `${isOff ? '❌ Deactivated' : '✅ Activated'}: *${offers[num].title}*`);
    return;
  }

  // OFFER DEL
  if (lower.startsWith('offer del ')) {
    const num    = parseInt(lower.split(' ').pop()) - 1;
    const offers = await db.queryAll(
      'SELECT id, title FROM offers WHERE restaurant_id = $1 ORDER BY created_at DESC',
      [restaurant.id]
    );
    if (!offers[num]) { await whatsapp.sendMessage(from, `❌ Offer #${num+1} not found.`); return; }
    await db.query('DELETE FROM offers WHERE id = $1', [offers[num].id]);
    await whatsapp.sendMessage(from, `🗑️ Deleted: *${offers[num].title}*`);
    return;
  }

  // OFFER ADD
  if (lower.startsWith('offer add ')) {
    const text   = msg.substring(10).trim();
    const lower2 = text.toLowerCase();

    let offerType = 'percent_off', discountPercent = 0, minOrderAmount = 0;
    let happyStart = null, happyEnd = null, freeItemId = null;
    let validDays = 'all', validModes = 'all', validUntil = null;
    let title = text;

    const pctMatch = text.match(/(\d+)%/i);
    if (pctMatch) discountPercent = parseInt(pctMatch[1]);

    const hourMatch = text.match(/(\d+)\s*(?:pm|am)?\s*[-–]\s*(\d+)\s*(pm|am)/i);
    if (hourMatch && discountPercent > 0) {
      offerType = 'happy_hour';
      let startH = parseInt(hourMatch[1]), endH = parseInt(hourMatch[2]);
      const ampm = hourMatch[3].toLowerCase();
      if (ampm === 'pm' && endH < 12)   endH   += 12;
      if (ampm === 'pm' && startH < 12) startH += 12;
      happyStart = `${String(startH).padStart(2,'0')}:00`;
      happyEnd   = `${String(endH).padStart(2,'0')}:00`;
      title = `Happy Hours ${happyStart} - ${happyEnd}: ${discountPercent}% off`;
    }

    const freeMatch = text.match(/free\s+(.+?)\s+(?:above|over|on orders above)\s+(\d+)/i);
    if (freeMatch) {
      offerType = 'item_free'; minOrderAmount = parseInt(freeMatch[2]); discountPercent = 0;
      const menuItem = await db.queryOne(
        `SELECT id, name FROM menu_items WHERE restaurant_id = $1 AND name ILIKE $2 LIMIT 1`,
        [restaurant.id, `%${freeMatch[1].trim()}%`]
      );
      if (!menuItem) { await whatsapp.sendMessage(from, `❌ Item "${freeMatch[1]}" not found.`); return; }
      freeItemId = menuItem.id;
      title = `Free ${menuItem.name} on orders above ₹${minOrderAmount}`;
    }

    const dayMatch = lower2.match(/\b(?:on|every)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/i);
    if (dayMatch) { validDays = dayMatch[1].toLowerCase(); validUntil = null; }

    const durationMatch = lower2.match(/\b(today|tomorrow)\b/);
    if (durationMatch && !dayMatch) {
      const now = new Date();
      if (durationMatch[1] === 'tomorrow') now.setDate(now.getDate() + 1);
      validUntil = now.toISOString().slice(0, 10);
    }

    const today = new Date().toISOString().slice(0, 10);
    await db.query(
      `INSERT INTO offers (restaurant_id, title, description, offer_type, discount_percent,
         free_item_id, min_order_amount, happy_hour_start, happy_hour_end,
         valid_from, valid_until, valid_days, valid_modes, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)`,
      [restaurant.id, title, title, offerType, discountPercent,
       freeItemId, minOrderAmount, happyStart, happyEnd,
       today, validUntil, validDays, validModes]
    );
    await whatsapp.sendMessage(from, `✅ *Offer Added!*\n📌 ${title}\n\nCustomers will see this automatically 🎉`);
    return;
  }

  // TAKEAWAY LIST
  if (lower === 'takeaway list' || lower === 'takeaway') {
    const pending = await db.queryAll(
      `SELECT s.pickup_token, b.grand_total,
              to_char(s.created_at AT TIME ZONE 'Asia/Kolkata', 'HH12:MI AM') as order_time
       FROM sessions s
       JOIN bills b ON b.session_id = s.id
       WHERE s.restaurant_id = $1
         AND s.mode = 'takeaway'
         AND s.status = 'ordered'
         AND DATE(s.created_at) = CURRENT_DATE
       ORDER BY s.pickup_token_num ASC`,
      [restaurant.id]
    );
    if (!pending.length) {
      await whatsapp.sendMessage(from, '🏃 No takeaway orders today yet.');
    } else {
      let reply = `🏃 *Today's Takeaway Orders*\n━━━━━━━━━━━━━━\n`;
      for (const p of pending) reply += `${p.pickup_token}  ₹${p.grand_total}  ${p.order_time}\n`;
      reply += `━━━━━━━━━━━━━━\n${pending.length} order(s) today`;
      await whatsapp.sendMessage(from, reply);
    }
    return;
  }

  await whatsapp.sendMessage(from, `❓ Unknown command. Send *!HELP* to see all commands.`);
}

// ─────────────────────────────────────────────
// NOTIFICATION WORKER
// Sends outgoing WhatsApp messages
// Called by billing.js, delivery.js via BullMQ queue
// ─────────────────────────────────────────────
const notificationWorker = new Worker('whatsapp-notifications', async (job) => {
  const { to, message, type, documentUrl, filename } = job.data;
  if (type === 'document' && documentUrl) {
    await whatsapp.sendDocument(to, documentUrl, filename, message);
  } else {
    await whatsapp.sendMessage(to, message);
  }
}, { connection: redisConnection, concurrency: 10 });

messageWorker.on('failed',      (job, err) => console.error(`❌ Message job ${job?.id} failed:`, err.message));
notificationWorker.on('failed', (job, err) => console.error(`❌ Notif job ${job?.id} failed:`,   err.message));

process.on('SIGTERM', async () => {
  await messageWorker.close();
  await notificationWorker.close();
  process.exit(0);
});

