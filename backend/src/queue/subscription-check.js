require('dotenv').config();
const db       = require('../database/db');
const whatsapp = require('../services/whatsapp');

// ─────────────────────────────────────────────
// SUBSCRIPTION CHECKER
// Run daily via PM2 cron
// Checks expiring/expired subscriptions
// Sends WhatsApp reminders to restaurant owners
// ─────────────────────────────────────────────

async function checkSubscriptions() {
  console.log(`🔄 [${new Date().toISOString()}] Checking subscriptions...`);

  try {
    // 1. Find restaurants expiring in 3 days — send reminder
    const expiringSoon = await db.queryAll(`
      SELECT id, name, phone, subscription_end, subscription_status
      FROM restaurants
      WHERE subscription_status IN ('trial', 'active')
        AND subscription_end BETWEEN NOW() AND NOW() + INTERVAL '3 days'
        AND is_active = true
    `);

    for (const r of expiringSoon) {
      const daysLeft = Math.ceil((new Date(r.subscription_end) - new Date()) / (1000 * 60 * 60 * 24));
      console.log(`⚠️ ${r.name} subscription expiring in ${daysLeft} days`);

      if (r.phone) {
        const msg = r.subscription_status === 'trial'
          ? `Hi! Your free trial for *${r.name}* on BazaarAI expires in *${daysLeft} days*.\n\nTo continue receiving orders without interruption, please renew for just *₹300/month*.\n\nContact us to renew: [your number here]`
          : `Hi! Your BazaarAI subscription for *${r.name}* expires in *${daysLeft} days*.\n\nRenew now for ₹300/month to keep your AI waiter active.\n\nContact: [your number here]`;

        await whatsapp.sendMessage(r.phone, msg);
      }
    }

    // 2. Suspend expired restaurants
    const expired = await db.queryAll(`
      UPDATE restaurants
      SET subscription_status = 'expired', is_active = false
      WHERE subscription_status IN ('trial', 'active')
        AND subscription_end < NOW()
        AND is_active = true
      RETURNING id, name, phone
    `);

    for (const r of expired) {
      console.log(`❌ Suspended: ${r.name} (subscription expired)`);

      if (r.phone) {
        await whatsapp.sendMessage(r.phone,
          `Your BazaarAI subscription for *${r.name}* has expired.\n\nYour AI waiter is now paused.\n\nRenew for ₹300/month to reactivate.\n\nContact: [your number here]`
        );
      }
    }

    // 3. Print revenue summary
    const revenue = await db.queryAll(`SELECT * FROM revenue_summary ORDER BY total_earned DESC`);
    console.log('\n📊 Revenue Summary:');
    for (const r of revenue) {
      console.log(`  ${r.restaurant}: ₹${r.total_earned} total | Sub: ${r.subscription_status} (expires ${r.sub_expires})`);
    }

    console.log(`✅ Subscription check complete. Expiring: ${expiringSoon.length} | Suspended: ${expired.length}`);
    process.exit(0);

  } catch (err) {
    console.error('❌ Subscription check error:', err.message);
    process.exit(1);
  }
}

checkSubscriptions();

