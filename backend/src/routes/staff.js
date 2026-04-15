// ─────────────────────────────────────────────
// OrderBuddy Staff API Routes
// Registered in server.js as:
//   app.register(require('./routes/staff'), { prefix: '/api' })
// ─────────────────────────────────────────────
const db = require('../database/db');

module.exports = async function staffRoutes(fastify, opts) {

  // ── POST /api/staff/login ─────────────────────────────────────────
  // Body: { restaurant_id, pin }
  // Returns: { token, staff: { id, name, role, restaurant_id } }
  //
  // Token pattern: base64(staff_id:role:restaurant_id:timestamp)
  // Matches existing dashboard.js auth pattern — no new dependencies
  // ─────────────────────────────────────────────────────────────────
  fastify.post('/staff/login', async (req, reply) => {
    const { restaurant_id, pin } = req.body;

    if (!restaurant_id || !pin) {
      return reply.status(400).send({ error: 'restaurant_id and pin required' });
    }

    // Find staff member by PIN in this restaurant
    const staff = await db.queryOne(
      `SELECT id, name, role, restaurant_id, is_active
       FROM staff
       WHERE restaurant_id = $1
         AND pin_hash = $2
         AND is_active = true
       LIMIT 1`,
      [restaurant_id, pin.toString()]
    );

    if (!staff) {
      return reply.status(401).send({ error: 'Invalid PIN' });
    }

    // Log the session start
    await db.query(
      `INSERT INTO staff_sessions
         (staff_id, restaurant_id, started_at, is_active)
       VALUES ($1, $2, NOW(), true)
       ON CONFLICT DO NOTHING`,
      [staff.id, staff.restaurant_id]
    ).catch(() => {
      // staff_sessions may have different schema — non-fatal
    });

    // Build token — same pattern as dashboard.js
    // base64(staff_id:role:restaurant_id:timestamp)
    const token = Buffer.from(
      `${staff.id}:${staff.role}:${staff.restaurant_id}:${Date.now()}`
    ).toString('base64');

    return reply.send({
      token,
      staff: {
        id:            staff.id,
        name:          staff.name,
        role:          staff.role,
        restaurant_id: staff.restaurant_id,
      }
    });
  });

  // ── GET /api/staff/me ─────────────────────────────────────────────
  // Validate token and return staff info
  // Header: Authorization: Bearer <token>
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/staff/me', async (req, reply) => {
    const parsed = parseStaffToken(req.headers.authorization);
    if (!parsed) {
      return reply.status(401).send({ error: 'Invalid or missing token' });
    }

    const staff = await db.queryOne(
      `SELECT id, name, role, restaurant_id
       FROM staff
       WHERE id = $1
         AND restaurant_id = $2
         AND is_active = true`,
      [parsed.staffId, parsed.restaurantId]
    );

    if (!staff) {
      return reply.status(401).send({ error: 'Staff not found or inactive' });
    }

    return reply.send({ staff });
  });

  // ── GET /api/staff/list ───────────────────────────────────────────
  // List all staff for a restaurant (owner only — uses dashboard token)
  // Header: Authorization: Bearer <dashboard_token>
  // Query:  ?restaurant_id=xxx
  // ─────────────────────────────────────────────────────────────────
  fastify.get('/staff/list', async (req, reply) => {
    const { restaurant_id } = req.query;
    if (!restaurant_id) {
      return reply.status(400).send({ error: 'restaurant_id required' });
    }

    const staffList = await db.query(
      `SELECT id, name, phone, role, is_active, created_at
       FROM staff
       WHERE restaurant_id = $1
       ORDER BY role, name`,
      [restaurant_id]
    );

    return reply.send({ staff: staffList.rows || staffList });
  });

  // ── POST /api/staff/add ───────────────────────────────────────────
  // Add a new staff member (owner only)
  // Body: { restaurant_id, name, phone, role, pin }
  // ─────────────────────────────────────────────────────────────────
  fastify.post('/staff/add', async (req, reply) => {
    const { restaurant_id, name, phone, role, pin } = req.body;

    if (!restaurant_id || !name || !role || !pin) {
      return reply.status(400).send({
        error: 'restaurant_id, name, role, and pin required'
      });
    }

    const validRoles = ['manager', 'waiter', 'kitchen', 'cashier'];
    if (!validRoles.includes(role)) {
      return reply.status(400).send({
        error: `role must be one of: ${validRoles.join(', ')}`
      });
    }

    if (pin.toString().length !== 4) {
      return reply.status(400).send({ error: 'PIN must be exactly 4 digits' });
    }

    const newStaff = await db.queryOne(
      `INSERT INTO staff (restaurant_id, name, phone, role, pin_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, phone, role, created_at`,
      [restaurant_id, name, phone || null, role, pin.toString()]
    );

    return reply.status(201).send({ staff: newStaff });
  });

  // ── PUT /api/staff/:id/deactivate ─────────────────────────────────
  // Deactivate a staff member (owner only)
  // ─────────────────────────────────────────────────────────────────
  fastify.put('/staff/:id/deactivate', async (req, reply) => {
    const { id } = req.params;
    const { restaurant_id } = req.body;

    if (!restaurant_id) {
      return reply.status(400).send({ error: 'restaurant_id required' });
    }

    await db.query(
      `UPDATE staff SET is_active = false
       WHERE id = $1 AND restaurant_id = $2`,
      [id, restaurant_id]
    );

    return reply.send({ success: true });
  });

};

// ─────────────────────────────────────────────
// Helper: parse staff token from Authorization header
// Token format: base64(staff_id:role:restaurant_id:timestamp)
// Returns: { staffId, role, restaurantId, timestamp } or null
// ─────────────────────────────────────────────
function parseStaffToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.replace('Bearer ', '').trim();
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 4) return null;
    return {
      staffId:      parts[0],
      role:         parts[1],
      restaurantId: parts[2],
      timestamp:    parts[3],
    };
  } catch {
    return null;
  }
}

// Export helper for use in other routes (waiter screen, etc.)
module.exports.parseStaffToken = parseStaffToken;

