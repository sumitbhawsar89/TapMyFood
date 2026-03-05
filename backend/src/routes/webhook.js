const db               = require('../database/db');
const { messageQueue } = require('../queue/setup');

// ─────────────────────────────────────────────
// Verify webhook (Meta one-time handshake)
// ─────────────────────────────────────────────
async function verifyWebhook(req, reply) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified');
    return reply.status(200).send(challenge);
  }
  console.error('❌ Webhook verification failed');
  return reply.status(403).send('Forbidden');
}

// ─────────────────────────────────────────────
// Receive incoming WhatsApp message
// ─────────────────────────────────────────────
async function receiveMessage(req, reply) {
  // Always respond 200 immediately — Meta retries if we don't
  reply.status(200).send('EVENT_RECEIVED');

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value    = change.value;
        const messages = value.messages || [];

        // phone_number_id — unique per WhatsApp number in Meta
        // This is how we identify WHICH restaurant this message belongs to
        const phoneNumberId = value.metadata.phone_number_id;

        for (const msg of messages) {
          const from = msg.from; // customer's phone number

          if (msg.type === 'text') {
            const text = msg.text.body;
            console.log(`📩 Text from ${from} → phoneId ${phoneNumberId}: "${text}"`);
            await queueMessage(from, text, phoneNumberId, msg.timestamp, false, null);
          }
          else if (msg.type === 'interactive' && msg.interactive.type === 'button_reply') {
            const buttonId    = msg.interactive.button_reply.id;
            const buttonTitle = msg.interactive.button_reply.title;
            console.log(`🔘 Button from ${from}: "${buttonTitle}" [${buttonId}]`);
            await queueMessage(from, buttonTitle, phoneNumberId, msg.timestamp, true, buttonId);
          }
          else if (msg.type === 'location') {
            // Customer shared live location or place pin
            const loc = msg.location;
            const lat = loc.latitude;
            const lng = loc.longitude;
            const locationText = `LOCATION:${lat},${lng}`;
            console.log(`📍 Location from ${from}: ${lat},${lng}`);
            await queueMessage(from, locationText, phoneNumberId, msg.timestamp, false, null);
          }
          else {
            console.log(`⏭️ Skipping message type: ${msg.type}`);
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Webhook processing error:', err);
  }
}

// ─────────────────────────────────────────────
// Look up restaurant by WhatsApp phone_number_id
// and push message to queue
// ─────────────────────────────────────────────
async function queueMessage(from, text, phoneNumberId, timestamp, isButtonReply, buttonId) {

  // ── THE KEY CHANGE ──
  // Look up restaurant by phone_number_id (unique per WA number in Meta)
  // This makes the system 100% universal — works for unlimited restaurants
  // No code change needed when onboarding new restaurant, just a DB insert
  const restaurant = await db.queryOne(
    `SELECT id, name FROM restaurants
     WHERE whatsapp_number_id = $1
       AND is_active = true
     LIMIT 1`,
    [phoneNumberId]
  );

  if (!restaurant) {
    console.error(`❌ No restaurant found for phone_number_id: ${phoneNumberId}`);
    console.error(`   → Run: UPDATE restaurants SET whatsapp_number_id = '${phoneNumberId}' WHERE slug = 'your-slug';`);
    return;
  }

  console.log(`🏪 Resolved: ${restaurant.name}`);

  await messageQueue.add('incoming-message', {
    from,
    message:      text,
    restaurantId: restaurant.id,
    phoneNumberId,
    timestamp,
    isButtonReply,
    buttonId,
  });

  console.log(`✅ Queued [${isButtonReply ? 'button' : 'text'}] → ${restaurant.name}`);
}

module.exports = { verifyWebhook, receiveMessage };

