'use strict';

/**
 * broadcasts-routes.js
 * Dashboard API for managing broadcasts + viewing abandoned cart stats
 */

module.exports = async function broadcastRoutes(fastify, opts) {
  const db = fastify.db;

  // ── GET /api/broadcasts — list all broadcasts for a restaurant ──
  fastify.get('/broadcasts', async (req, reply) => {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return reply.status(400).send({ error: 'restaurant_id required' });

    const rows = await db.queryAll(
      `SELECT * FROM broadcasts
       WHERE restaurant_id = $1
       ORDER BY scheduled_at DESC
       LIMIT 50`,
      [restaurant_id]
    );
    return reply.send({ broadcasts: rows });
  });

  // ── POST /api/broadcasts — create a broadcast ──
  fastify.post('/broadcasts', async (req, reply) => {
    const {
      restaurant_id, title, message, audience,
      scheduled_at, repeat_type, repeat_day, repeat_time
    } = req.body || {};

    if (!restaurant_id || !title || !message || !scheduled_at) {
      return reply.status(400).send({ error: 'restaurant_id, title, message, scheduled_at required' });
    }

    // Validate audience
    const validAudiences = ['all', 'recent', 'inactive', 'vip'];
    const aud = validAudiences.includes(audience) ? audience : 'all';

    // Preview: count how many will receive
    const countResult = await getAudienceCount(db, restaurant_id, aud);

    const broadcast = await db.queryOne(
      `INSERT INTO broadcasts
         (restaurant_id, title, message, audience, scheduled_at, repeat_type, repeat_day, repeat_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [restaurant_id, title, message, aud,
       new Date(scheduled_at),
       repeat_type || 'once',
       repeat_day  || null,
       repeat_time || null]
    );

    return reply.send({ broadcast, estimated_recipients: countResult });
  });

  // ── DELETE /api/broadcasts/:id — cancel a broadcast ──
  fastify.delete('/broadcasts/:id', async (req, reply) => {
    const { id } = req.params;
    const { restaurant_id } = req.query;

    const result = await db.query(
      `UPDATE broadcasts SET status = 'cancelled'
       WHERE id = $1 AND restaurant_id = $2 AND status = 'scheduled'`,
      [id, restaurant_id]
    );

    return reply.send({ success: true });
  });

  // ── GET /api/broadcasts/audience-preview — count recipients before sending ──
  fastify.get('/broadcasts/audience-preview', async (req, reply) => {
    const { restaurant_id, audience } = req.query;
    if (!restaurant_id) return reply.status(400).send({ error: 'restaurant_id required' });

    const count = await getAudienceCount(db, restaurant_id, audience || 'all');
    return reply.send({ count });
  });

  // ── GET /api/broadcasts/templates — get message templates ──
  fastify.get('/broadcasts/templates', async (req, reply) => {
    return reply.send({ templates: BROADCAST_TEMPLATES });
  });

  // ── GET /api/abandoned-carts — view abandoned cart stats ──
  fastify.get('/abandoned-carts', async (req, reply) => {
    const { restaurant_id } = req.query;
    if (!restaurant_id) return reply.status(400).send({ error: 'restaurant_id required' });

    const stats = await db.queryOne(
      `SELECT
         COUNT(*) FILTER (WHERE o.id IS NULL AND ci.id IS NOT NULL
           AND s.last_message_ts > NOW() - INTERVAL '24 hours'
           AND s.last_message_ts < NOW() - INTERVAL '30 minutes') AS active_abandoned,
         COUNT(*) FILTER (WHERE s.recovery_sent_at > NOW() - INTERVAL '24 hours') AS reminders_sent_today,
         COALESCE(SUM(ci.subtotal) FILTER (
           WHERE o.id IS NULL AND ci.id IS NOT NULL
             AND s.last_message_ts > NOW() - INTERVAL '24 hours'
             AND s.last_message_ts < NOW() - INTERVAL '30 minutes'
         ), 0) AS abandoned_value
       FROM sessions s
       LEFT JOIN cart_items ci ON ci.session_id = s.id
       LEFT JOIN orders o ON o.session_id = s.id
       WHERE s.restaurant_id = $1
         AND s.status NOT IN ('closed','paid','delivered')`,
      [restaurant_id]
    );

    return reply.send({ stats });
  });
};

// ── Count audience for preview ──
async function getAudienceCount(db, restaurantId, audience) {
  let filter = '';
  if (audience === 'recent') {
    filter = `AND MAX(o.created_at) > NOW() - INTERVAL '30 days'`;
  } else if (audience === 'inactive') {
    filter = `AND MAX(o.created_at) < NOW() - INTERVAL '14 days'
              AND MAX(o.created_at) > NOW() - INTERVAL '90 days'`;
  } else if (audience === 'vip') {
    filter = `AND (COUNT(DISTINCT o.id) >= 5 OR SUM(b.grand_total) >= 5000)`;
  }

  const result = await db.queryOne(
    `SELECT COUNT(*) AS count
     FROM (
       SELECT s.customer_phone
       FROM sessions s
       JOIN orders o ON o.session_id = s.id
       JOIN bills b ON b.order_id = o.id
       WHERE s.restaurant_id = $1
         AND s.customer_phone IS NOT NULL
         AND s.customer_phone NOT IN (
           SELECT phone FROM opt_outs WHERE restaurant_id = $1
         )
       GROUP BY s.customer_phone
       HAVING 1=1 ${filter}
     ) audience`,
    [restaurantId]
  );
  return parseInt(result?.count || 0);
}

// ── Pre-built broadcast templates ──
const BROADCAST_TEMPLATES = [
  {
    id: 'happy_hour',
    name: '🍺 Happy Hour',
    message:
      `🎉 *Happy Hours at {{restaurant}}!*\n\n` +
      `⏰ Today 5PM - 8PM — Get 20% OFF on all drinks!\n\n` +
      `Order now 👉 {{url}}\n\n` +
      `_Reply STOP to opt out_`,
  },
  {
    id: 'weekend_special',
    name: '🍔 Weekend Special',
    message:
      `🔥 *Weekend Special is here!*\n\n` +
      `This weekend only — Buy 2 get 1 FREE on selected items!\n\n` +
      `Don't miss out 👉 {{url}}\n\n` +
      `_Reply STOP to opt out_`,
  },
  {
    id: 'we_miss_you',
    name: '😢 We Miss You',
    message:
      `Hey {{name}}! 👋\n\n` +
      `It's been a while since your last order. We miss you!\n\n` +
      `Come back today and enjoy *15% OFF* with code: COMEBACK\n\n` +
      `Order here 👉 {{url}}\n\n` +
      `_Reply STOP to opt out_`,
  },
  {
    id: 'new_item',
    name: '✨ New Item Launch',
    message:
      `🆕 *We've added something new to our menu!*\n\n` +
      `Come check it out and be the first to try it 😋\n\n` +
      `View menu 👉 {{url}}\n\n` +
      `_Reply STOP to opt out_`,
  },
  {
    id: 'daily_special',
    name: '🌟 Today\'s Special',
    message:
      `🌟 *Today's Special at {{restaurant}}*\n\n` +
      `Check out what's fresh and exciting today!\n\n` +
      `Order now 👉 {{url}}\n\n` +
      `_Reply STOP to opt out_`,
  },
];

