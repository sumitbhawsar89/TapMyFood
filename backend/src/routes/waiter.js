// ─────────────────────────────────────────────
// OrderBuddy Waiter API Routes
// Registered in server.js as:
//   app.register(require('./routes/waiter'), { prefix: '/api' })
//
// Auth: Staff token (from /api/staff/login)
//   Header: Authorization: Bearer <token>
//   Token: base64(staff_id:role:restaurant_id:timestamp)
// ─────────────────────────────────────────────
const db = require('../database/db');
const { parseStaffToken } = require('./staff');

module.exports = async function waiterRoutes(fastify, opts) {

  // ── AUTH HOOK — all waiter routes require staff token ─────────────
  fastify.addHook('preHandler', async (req, reply) => {
    // Skip preflight
    if (req.method === 'OPTIONS') return;

    const parsed = parseStaffToken(req.headers.authorization);
    if (!parsed) {
      return reply.status(401).send({ error: 'Staff token required' });
    }

    // Attach to request for use in handlers
    req.staffId       = parsed.staffId;
    req.staffRole     = parsed.role;
    req.restaurantId  = parsed.restaurantId;
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /api/waiter/floor
  // Returns full floor map: all tables with session + order status
  // ══════════════════════════════════════════════════════════════════
  fastify.get('/waiter/floor', async (req, reply) => {
    const restaurantId = req.restaurantId;

    // 1. Get table config from settings
    const settingRow = await db.queryOne(
      `SELECT value FROM restaurant_settings
       WHERE restaurant_id = $1 AND key = 'tables_config'`,
      [restaurantId]
    );

    let tables = [];
    if (settingRow?.value) {
      try { tables = JSON.parse(settingRow.value); } catch {}
    }

    // 2. Get all active dine_in sessions
    const activeSessions = await db.query(
      `SELECT
         s.id              AS session_id,
         s.table_number,
         s.customer_phone,
         s.status          AS session_status,
         s.bill_status,
         s.initiated_by,
         s.created_at      AS session_started,
         s.upsell_shown,
         COUNT(o.id)       AS order_count,
         COALESCE(SUM(b.grand_total), 0) AS running_total
       FROM sessions s
       LEFT JOIN orders o
         ON o.session_id = s.id
        AND o.status NOT IN ('cancelled')
       LEFT JOIN bills b
         ON b.session_id = s.id
        AND b.status != 'cancelled'
       WHERE s.restaurant_id = $1
         AND s.mode = 'dine_in'
         AND s.status = 'active'
       GROUP BY s.id
       ORDER BY s.created_at ASC`,
      [restaurantId]
    );

    const sessionRows = activeSessions.rows || activeSessions;

    // 3. Build session map keyed by table_number
    const sessionByTable = {};
    for (const s of sessionRows) {
      sessionByTable[s.table_number] = s;
    }

    // 4. Merge: configured tables + active sessions
    // Tables with no config entry but active session still show up
    const configuredNumbers = new Set(tables.map(t => t.number));

    // Add any active sessions not in config (handles unconfigured tables)
    for (const s of sessionRows) {
      if (!configuredNumbers.has(s.table_number)) {
        tables.push({
          number:  s.table_number,
          section: 'Unknown',
          capacity: null,
        });
        configuredNumbers.add(s.table_number);
      }
    }

    // 5. Build floor map
    const floor = tables.map(table => {
      const session = sessionByTable[table.number] || null;
      const state   = getTableState(session);
      const elapsed = session
        ? Math.floor((Date.now() - new Date(session.session_started).getTime()) / 60000)
        : 0;

      return {
        // Table info
        number:       table.number,
        section:      table.section || 'Main',
        capacity:     table.capacity || null,

        // State
        state,                        // free|seated|ordering|preparing|food_ready|billing|urgent
        color:        stateColor(state),
        clock_badge:  clockBadge(elapsed),
        elapsed_mins: elapsed,

        // Session info (null if free)
        session: session ? {
          id:             session.session_id,
          customer_phone: session.customer_phone,
          status:         session.session_status,
          bill_status:    session.bill_status,
          initiated_by:   session.initiated_by,  // customer | waiter
          order_count:    parseInt(session.order_count),
          running_total:  parseInt(session.running_total),
          started_at:     session.session_started,
        } : null,
      };
    });

    return reply.send({
      floor,
      summary: {
        total:    floor.length,
        free:     floor.filter(t => t.state === 'free').length,
        occupied: floor.filter(t => t.state !== 'free').length,
      }
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /api/waiter/tables/:tableNumber/start-session
  // Waiter starts a session on behalf of customer
  // Body: { covers?, customer_phone? }
  // ══════════════════════════════════════════════════════════════════
  fastify.post('/waiter/tables/:tableNumber/start-session', async (req, reply) => {
    const { tableNumber } = req.params;
    const { covers, customer_phone } = req.body || {};
    const restaurantId = req.restaurantId;

    // Check no active session already on this table
    const existing = await db.queryOne(
      `SELECT id FROM sessions
       WHERE restaurant_id = $1
         AND table_number  = $2
         AND mode          = 'dine_in'
         AND status        = 'active'`,
      [restaurantId, tableNumber]
    );

    if (existing) {
      return reply.status(409).send({
        error: 'Table already has an active session',
        session_id: existing.id,
      });
    }

    // Create session
    const session = await db.queryOne(
      `INSERT INTO sessions
         (restaurant_id, customer_phone, table_number, mode,
          status, initiated_by, staff_id, started_by_staff_name)
       VALUES ($1, $2, $3, 'dine_in', 'active', 'waiter', $4, $5)
       RETURNING id, table_number, customer_phone, status, created_at`,
      [
        restaurantId,
        customer_phone || 'waiter-initiated',
        tableNumber,
        req.staffId,
        req.staffId,  // will be replaced with name in future
      ]
    );

    return reply.status(201).send({ session });
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /api/waiter/tables/:tableNumber/close
  // Waiter manually marks table as free (floor map only)
  // Does NOT close any sessions or bills — just floor map update
  // ══════════════════════════════════════════════════════════════════
  fastify.post('/waiter/tables/:tableNumber/close', async (req, reply) => {
    const { tableNumber } = req.params;
    const restaurantId = req.restaurantId;

    // Update table_status
    await db.query(
      `INSERT INTO table_status (table_id, restaurant_id, status, last_updated_by, updated_at)
       VALUES ($1, $2, 'free', 'waiter', NOW())
       ON CONFLICT (table_id) DO UPDATE
         SET status = 'free',
             last_updated_by = 'waiter',
             updated_at = NOW()`,
      [tableNumber, restaurantId]
    );

    return reply.send({ success: true, table: tableNumber, status: 'free' });
  });

  // ══════════════════════════════════════════════════════════════════
  // PUT /api/waiter/sessions/:sessionId/transfer-table
  // Transfer session to a different table
  // Body: { new_table_number }
  // ══════════════════════════════════════════════════════════════════
  fastify.put('/waiter/sessions/:sessionId/transfer-table', async (req, reply) => {
    const { sessionId } = req.params;
    const { new_table_number } = req.body;

    if (!new_table_number) {
      return reply.status(400).send({ error: 'new_table_number required' });
    }

    // Check destination is free
    const destSession = await db.queryOne(
      `SELECT id FROM sessions
       WHERE restaurant_id = $1
         AND table_number  = $2
         AND mode          = 'dine_in'
         AND status        = 'active'`,
      [req.restaurantId, new_table_number]
    );

    if (destSession) {
      return reply.status(409).send({
        error: 'Destination table is occupied — manager approval required',
        occupied_by: destSession.id,
      });
    }

    // Transfer: update current_table (table_number) + set original if first transfer
    const updated = await db.queryOne(
      `UPDATE sessions SET
         table_number       = $1,
         original_table_id  = COALESCE(original_table_id, table_number::text::uuid),
         updated_at         = NOW()
       WHERE id            = $2
         AND restaurant_id = $3
         AND status        = 'active'
       RETURNING id, table_number, original_table_id`,
      [new_table_number, sessionId, req.restaurantId]
    );

    if (!updated) {
      return reply.status(404).send({ error: 'Session not found or not active' });
    }

    return reply.send({ success: true, session: updated });
  });

  // ══════════════════════════════════════════════════════════════════
  // GET /api/waiter/sessions/:sessionId
  // Get full session detail with orders and running bill
  // ══════════════════════════════════════════════════════════════════
  fastify.get('/waiter/sessions/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;

    const session = await db.queryOne(
      `SELECT s.*,
              COALESCE(SUM(b.grand_total), 0) AS running_total
       FROM sessions s
       LEFT JOIN bills b ON b.session_id = s.id AND b.status != 'cancelled'
       WHERE s.id = $1 AND s.restaurant_id = $2
       GROUP BY s.id`,
      [sessionId, req.restaurantId]
    );

    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    // Get orders for this session
    const orders = await db.query(
      `SELECT o.id, o.status, o.created_at, o.special_notes,
              json_agg(json_build_object(
                'id',       oi.id,
                'name',     oi.name,
                'quantity', oi.quantity,
                'price',    oi.price
              )) AS items
       FROM orders o
       LEFT JOIN order_items oi ON oi.order_id = o.id
       WHERE o.session_id = $1
         AND o.status != 'cancelled'
       GROUP BY o.id
       ORDER BY o.created_at ASC`,
      [sessionId]
    );

    return reply.send({
      session,
      orders: orders.rows || orders,
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // POST /api/waiter/tables/config
  // Save table configuration (owner sets up tables once)
  // Body: { restaurant_id, tables: [{number, section, capacity}] }
  // ══════════════════════════════════════════════════════════════════
  fastify.post('/waiter/tables/config', async (req, reply) => {
    const { tables } = req.body;

    if (!Array.isArray(tables) || tables.length === 0) {
      return reply.status(400).send({ error: 'tables array required' });
    }

    // Validate each table has a number
    for (const t of tables) {
      if (!t.number) {
        return reply.status(400).send({ error: 'Each table must have a number' });
      }
    }

    // Save to restaurant_settings
    await db.query(
      `INSERT INTO restaurant_settings
         (restaurant_id, key, value, created_at, updated_at)
       VALUES ($1, 'tables_config', $2, NOW(), NOW())
       ON CONFLICT (restaurant_id, key) DO UPDATE
         SET value = $2, updated_at = NOW()`,
      [req.restaurantId, JSON.stringify(tables)]
    );

    return reply.send({ success: true, table_count: tables.length });
  });

};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

// Derive table state from session data
function getTableState(session) {
  if (!session) return 'free';

  const { session_status, bill_status, order_count, elapsed_mins } = session;
  const orders = parseInt(order_count) || 0;
  const elapsed = parseInt(session?.elapsed_mins) || 0;

  if (session_status !== 'active') return 'free';

  // Billing state
  if (bill_status === 'pending' || bill_status === 'requested') return 'billing';

  // Urgent — unpaid too long
  if (bill_status === 'pending' && elapsed > 25) return 'urgent';

  // Has orders
  if (orders > 0) return 'ordering';

  // No orders yet — just seated
  return 'seated';
}

// Map state to color code for frontend
function stateColor(state) {
  const colors = {
    free:       'white',
    seated:     'green',
    ordering:   'yellow',
    preparing:  'orange',
    food_ready: 'blue',
    billing:    'purple',
    urgent:     'red',
    cleaning:   'grey',
    blocked:    'dark_grey',
  };
  return colors[state] || 'white';
}

// Clock badge based on elapsed minutes
function clockBadge(elapsedMins) {
  if (elapsedMins <= 60)  return 'white';
  if (elapsedMins <= 90)  return 'yellow';
  if (elapsedMins <= 120) return 'orange';
  return 'red';
}

