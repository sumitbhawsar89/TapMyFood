require('dotenv').config();
const db = require('../database/db');

// ─────────────────────────────────────────────
// SESSION CLEANUP JOB
// Runs every 15 minutes via PM2 cron
// Closes sessions inactive for more than 2 hours
// ─────────────────────────────────────────────

async function cleanupSessions() {
  console.log(`🔄 [${new Date().toISOString()}] Running session cleanup...`);

  try {
    // 1. Close sessions with no activity for 2 hours
    const timedOut = await db.queryAll(`
      UPDATE sessions
      SET status = 'closed'
      WHERE status IN ('active', 'ordered')
        AND updated_at < NOW() - INTERVAL '2 hours'
      RETURNING id, customer_phone, mode, restaurant_id
    `);

    if (timedOut.length > 0) {
      console.log(`⏰ Closed ${timedOut.length} timed-out sessions`);
      for (const s of timedOut) {
        console.log(`   → ${s.customer_phone} | mode: ${s.mode}`);
        // Clear their cart too
        await db.query('DELETE FROM cart_items WHERE session_id = $1', [s.id]);
      }
    } else {
      console.log('✅ No timed-out sessions found');
    }

    // 2. Clear orphaned cart items (safety cleanup)
    const orphaned = await db.query(`
      DELETE FROM cart_items
      WHERE session_id IN (
        SELECT id FROM sessions WHERE status = 'closed'
      )
    `);

    console.log(`🧹 Cleanup complete`);
    process.exit(0);

  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
    process.exit(1);
  }
}

cleanupSessions();

