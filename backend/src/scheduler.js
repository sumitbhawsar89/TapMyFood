'use strict';
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

/**
 * scheduler.js — Background jobs for tapmyfood
 *
 * Jobs:
 *   1. Abandoned Cart Recovery  — runs every 10 min
 *      Sessions with cart items, no order, idle >30 min → WhatsApp reminder
 *
 *   2. Push Broadcasts          — runs every 5 min
 *      Checks broadcasts table for scheduled messages → sends to opted-in customers
 *
 * Usage: node scheduler.js  (or via PM2 as a separate process)
 */

const db        = require('./database/db');
const whatsapp  = require('./services/whatsapp');

const ABANDONED_CART_INTERVAL_MS = 10 * 60 * 1000;  // check every 10 min
const BROADCAST_INTERVAL_MS      =  5 * 60 * 1000;  // check every 5 min
const IDLE_THRESHOLD_MINS        = 30;               // cart abandoned after 30 min idle
const APP_URL = process.env.APP_URL || 'https://tapmyfood.com';

// ═══════════════════════════════════════════════════════
// JOB 1: ABANDONED CART RECOVERY
// ═══════════════════════════════════════════════════════
async function runAbandonedCartJob() {
  try {
    // Find sessions:
    //  - Have cart items
    //  - No completed order
    //  - Last message > 30 min ago (idle)
    //  - Not already sent a recovery message
    //  - Not closed/paid
    const idleThreshold = IDLE_THRESHOLD_MINS;
    const abandoned = await db.queryAll(
      `SELECT
         s.id            AS session_id,
         s.customer_phone,
         s.restaurant_id,
         s.mode,
         s.last_message_ts,
         r.name          AS restaurant_name,
         json_agg(
           json_build_object('name', ci.name, 'qty', ci.quantity, 'price', ci.price)
           ORDER BY ci.added_at
         ) AS items,
         SUM(ci.subtotal) AS cart_total
       FROM sessions s
       JOIN restaurants r ON r.id = s.restaurant_id
       JOIN cart_items ci ON ci.session_id = s.id
       LEFT JOIN orders o ON o.session_id = s.id
       WHERE o.id IS NULL
         AND s.status NOT IN ('closed','paid','delivered')
         AND s.customer_phone IS NOT NULL
         AND to_timestamp(s.last_message_ts::bigint) < NOW() - ($1 * INTERVAL '1 minute')
         AND to_timestamp(s.last_message_ts::bigint) > NOW() - INTERVAL '2 hours'
         AND (s.recovery_sent_at IS NULL
              OR s.recovery_sent_at < NOW() - INTERVAL '24 hours')
       GROUP BY s.id, s.customer_phone, s.restaurant_id,
                s.mode, s.last_message_ts, r.name`,
      [idleThreshold]
    );

    console.log(`🛒 Abandoned cart job: found ${abandoned.length} sessions`);

    for (const session of abandoned) {
      try {
        const items     = session.items;
        const topItems  = items.slice(0, 2).map(i => `*${i.name}*${i.qty > 1 ? ' x'+i.qty : ''}`).join(', ');
        const more      = items.length > 2 ? ` +${items.length - 2} more` : '';
        const orderUrl  = `${APP_URL}/order/${session.session_id}`;

        const message =
          `Hey! 👋 You left something behind at *${session.restaurant_name}*\n\n` +
          `🛒 Your cart: ${topItems}${more}\n` +
          `💰 Total: ₹${session.cart_total}\n\n` +
          `Your order is saved — complete it here:\n📱 ${orderUrl}\n\n` +
          `_Reply STOP to opt out of reminders_`;

        await whatsapp.sendMessage(session.customer_phone, message);

        // Mark recovery sent
        await db.query(
          `UPDATE sessions SET recovery_sent_at = NOW() WHERE id = $1`,
          [session.session_id]
        );

        console.log(`✅ Recovery sent to ${session.customer_phone} — ${topItems}`);

        // Throttle — don't hammer WhatsApp API
        await sleep(500);

      } catch (err) {
        console.error(`❌ Recovery failed for ${session.customer_phone}:`, err.message);
      }
    }

  } catch (err) {
    console.error('❌ Abandoned cart job failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════
// JOB 2: PUSH BROADCASTS
// ═══════════════════════════════════════════════════════
async function runBroadcastJob() {
  try {
    // Fetch broadcasts ready to send
    const broadcasts = await db.queryAll(
      `SELECT * FROM broadcasts
       WHERE status = 'scheduled'
         AND scheduled_at <= NOW()
         AND (sent_at IS NULL)
       ORDER BY scheduled_at ASC
       LIMIT 5`,   // process max 5 at a time
      []
    );

    if (broadcasts.length === 0) return;
    console.log(`📢 Broadcast job: processing ${broadcasts.length} broadcasts`);

    for (const broadcast of broadcasts) {
      try {
        // Mark as sending to prevent double-send
        await db.query(
          `UPDATE broadcasts SET status = 'sending', sent_at = NOW() WHERE id = $1`,
          [broadcast.id]
        );

        // Get target audience
        const customers = await getAudience(broadcast);
        console.log(`📢 Broadcast "${broadcast.title}" → ${customers.length} customers`);

        let sent = 0, failed = 0;

        for (const customer of customers) {
          try {
            const message = personalizeMessage(broadcast.message, customer);
            await whatsapp.sendMessage(customer.phone, message);
            sent++;
            await sleep(300); // WhatsApp rate limit — max ~3/sec
          } catch (err) {
            failed++;
            console.error(`❌ Broadcast send failed to ${customer.phone}:`, err.message);
          }
        }

        // Mark done
        await db.query(
          `UPDATE broadcasts
           SET status = 'sent', sent_count = $2, failed_count = $3
           WHERE id = $1`,
          [broadcast.id, sent, failed]
        );

        console.log(`✅ Broadcast done: ${sent} sent, ${failed} failed`);

      } catch (err) {
        await db.query(
          `UPDATE broadcasts SET status = 'failed', error = $2 WHERE id = $1`,
          [broadcast.id, err.message]
        );
        console.error(`❌ Broadcast ${broadcast.id} failed:`, err.message);
      }
    }

  } catch (err) {
    console.error('❌ Broadcast job failed:', err.message);
  }
}

// ── Get audience for a broadcast ──
async function getAudience(broadcast) {
  // Target options:
  //   'all'         — all customers who ever ordered from this restaurant
  //   'recent'      — ordered in last 30 days
  //   'inactive'    — haven't ordered in 14+ days
  //   'vip'         — ordered 5+ times OR spent ₹5000+

  const baseQuery = `
    SELECT DISTINCT
      s.customer_phone AS phone,
      MAX(b.grand_total) AS max_order,
      COUNT(DISTINCT o.id) AS order_count,
      MAX(o.created_at) AS last_order_at
    FROM sessions s
    JOIN orders o ON o.session_id = s.id
    JOIN bills b ON b.order_id = o.id
    WHERE s.restaurant_id = $1
      AND s.customer_phone IS NOT NULL
      AND s.customer_phone NOT IN (
        SELECT phone FROM opt_outs WHERE restaurant_id = $1
      )
    GROUP BY s.customer_phone
  `;

  let filter = '';
  if (broadcast.audience === 'recent') {
    filter = `HAVING MAX(o.created_at) > NOW() - INTERVAL '30 days'`;
  } else if (broadcast.audience === 'inactive') {
    filter = `HAVING MAX(o.created_at) < NOW() - INTERVAL '14 days'
                 AND MAX(o.created_at) > NOW() - INTERVAL '90 days'`;
  } else if (broadcast.audience === 'vip') {
    filter = `HAVING COUNT(DISTINCT o.id) >= 5 OR SUM(b.grand_total) >= 5000`;
  }

  return db.queryAll(baseQuery + filter + ' LIMIT 1000', [broadcast.restaurant_id]);
}

// ── Personalize message with customer data ──
function personalizeMessage(template, customer) {
  return template
    .replace(/\{\{name\}\}/g, customer.name || 'there')
    .replace(/\{\{order_count\}\}/g, customer.order_count || '')
    .replace(/\{\{last_order\}\}/g, customer.last_order_at
      ? new Date(customer.last_order_at).toLocaleDateString('en-IN', { day:'numeric', month:'short' })
      : '');
}

// ── Helper ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════
async function start() {
  console.log('⏰ Scheduler started');
  console.log(`   Abandoned cart: every ${ABANDONED_CART_INTERVAL_MS/60000} min`);
  console.log(`   Broadcasts:     every ${BROADCAST_INTERVAL_MS/60000} min`);

  // Run immediately on start
  await runAbandonedCartJob();
  await runBroadcastJob();

  // Then on intervals
  setInterval(runAbandonedCartJob, ABANDONED_CART_INTERVAL_MS);
  setInterval(runBroadcastJob,     BROADCAST_INTERVAL_MS);
}

start().catch(err => {
  console.error('❌ Scheduler startup failed:', err);
  process.exit(1);
});

