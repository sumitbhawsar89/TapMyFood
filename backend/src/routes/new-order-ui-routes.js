// ══════════════════════════════════════════════════════════════════════
// TAPMYFOOD — NEW ROUTES TO ADD TO order-ui.js
// Add these BEFORE the closing } of module.exports = async function
// ══════════════════════════════════════════════════════════════════════

// ── POST /api/order-ui/session/start ──────────────────────────────────
// Called when customer selects platform at QR scan screen
// Creates session OR returns existing active session for this table
fastify.post('/session/start', async (req, reply) => {
  const { restaurant_id, table_number, platform, mode } = req.body || {};

  if (!restaurant_id) return reply.status(400).send({ error: 'restaurant_id required' });

  // Validate platform
  const validPlatforms = ['direct', 'zomato', 'swiggy'];
  const safePlatform   = validPlatforms.includes(platform) ? platform : 'direct';

  // Validate mode
  const validModes = ['dine_in', 'takeaway', 'delivery', 'zomato_dine_in', 'swiggy_dine_in'];
  const safeMode   = validModes.includes(mode) ? mode : 'dine_in';

  // Check restaurant exists
  const restaurant = await db.queryOne(
    'SELECT id, name, welcome_message FROM restaurants WHERE id = $1',
    [restaurant_id]
  );
  if (!restaurant) return reply.status(404).send({ error: 'Restaurant not found' });

  // Check for existing active session on this table
  // (handles case where customer rescans QR mid-session)
  if (table_number && safeMode === 'dine_in') {
    const existing = await db.queryOne(
      `SELECT id, status, platform, bill_status
       FROM sessions
       WHERE restaurant_id = $1
         AND table_number  = $2
         AND mode          = 'dine_in'
         AND status NOT IN ('closed','paid','delivered')
         AND created_at > NOW() - INTERVAL '8 hours'
       ORDER BY created_at DESC
       LIMIT 1`,
      [restaurant_id, table_number]
    );
    if (existing) {
      // Return existing session — let frontend show resume prompt
      return reply.send({
        session_id:     existing.id,
        resumed:        true,
        platform:       existing.platform,
        bill_status:    existing.bill_status,
        restaurant_name: restaurant.name,
        welcome_message: restaurant.welcome_message,
      });
    }
  }

  // Load platform discount if Zomato/Swiggy
  let discountPct = 0;
  if (safePlatform !== 'direct') {
    const setting = await db.queryOne(
      `SELECT value FROM restaurant_settings
       WHERE restaurant_id = $1 AND key = $2`,
      [restaurant_id, `${safePlatform}_discount_pct`]
    ).catch(() => null);
    discountPct = setting ? (parseInt(setting.value) || 0) : 0;
  }

  // Create new session
  // customer_phone is required by DB — use placeholder for QR sessions
  // (phone collected later if needed for delivery)
  const session = await db.queryOne(
    `INSERT INTO sessions
       (restaurant_id, customer_phone, table_number, mode,
        platform, discount_pct, discount_source,
        platform_locked, upsell_shown, bill_status, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, false, 'none', 'active')
     RETURNING id, mode, table_number, platform, discount_pct, status`,
    [
      restaurant_id,
      'qr_session',          // placeholder — no phone for QR dine-in
      table_number || null,
      safeMode,
      safePlatform,
      discountPct,
      safePlatform !== 'direct' ? safePlatform : null,
    ]
  );

  console.log(`✅ Session started: ${session.id} | mode=${safeMode} | platform=${safePlatform} | table=${table_number}`);

  return reply.send({
    session_id:      session.id,
    resumed:         false,
    platform:        safePlatform,
    discount_pct:    discountPct,
    restaurant_name: restaurant.name,
    welcome_message: restaurant.welcome_message,
  });
});

// ── POST /api/order-ui/session/platform ──────────────────────────────
// Update platform BEFORE first order (edit window)
fastify.post('/session/platform', async (req, reply) => {
  const { session_id, platform } = req.body || {};
  if (!session_id || !platform) return reply.status(400).send({ error: 'session_id and platform required' });

  const validPlatforms = ['direct', 'zomato', 'swiggy'];
  if (!validPlatforms.includes(platform)) return reply.status(400).send({ error: 'Invalid platform' });

  // Check session exists and platform not locked
  const session = await db.queryOne(
    'SELECT id, platform_locked, restaurant_id FROM sessions WHERE id = $1',
    [session_id]
  );
  if (!session) return reply.status(404).send({ error: 'Session not found' });
  if (session.platform_locked) {
    return reply.status(409).send({ error: 'Platform locked after first order — cannot change' });
  }

  // Load new platform discount
  let discountPct = 0;
  if (platform !== 'direct') {
    const setting = await db.queryOne(
      `SELECT value FROM restaurant_settings
       WHERE restaurant_id = $1 AND key = $2`,
      [session.restaurant_id, `${platform}_discount_pct`]
    ).catch(() => null);
    discountPct = setting ? (parseInt(setting.value) || 0) : 0;
  }

  await db.query(
    `UPDATE sessions
     SET platform = $1, discount_pct = $2,
         discount_source = $3, updated_at = NOW()
     WHERE id = $4`,
    [platform, discountPct, platform !== 'direct' ? platform : null, session_id]
  );

  console.log(`✏️ Platform updated: ${session_id} → ${platform}`);
  return reply.send({ success: true, platform, discount_pct: discountPct });
});

// ── POST /api/order-ui/ai-parse/:sessionId ────────────────────────────
// Receives AI @@CART JSON signal, validates against DB, returns verified items
// Frontend calls this AFTER AI responds — before showing confirmation card
fastify.post('/ai-parse/:sessionId', async (req, reply) => {
  const { sessionId } = req.params;
  const { cart_signal } = req.body || {};
  // cart_signal = [{ id: "uuid", qty: 2, notes: "extra spicy" }, ...]

  if (!cart_signal || !Array.isArray(cart_signal) || cart_signal.length === 0) {
    return reply.status(400).send({ error: 'cart_signal array required' });
  }

  const session = await db.queryOne(
    'SELECT restaurant_id FROM sessions WHERE id = $1 AND status NOT IN (\'closed\',\'paid\')',
    [sessionId]
  );
  if (!session) return reply.status(410).send({ error: 'Session expired' });

  // Fetch all available menu items + modifiers for this restaurant
  const [menuItems, modifiers] = await Promise.all([
    db.queryAll(
      `SELECT id, name, price, kot_type, tax_category, is_available, category_id
       FROM menu_items
       WHERE restaurant_id = $1`,
      [session.restaurant_id]
    ),
    db.queryAll(
      `SELECT id, name, price, applicable_item_ids, applicable_categories
       FROM menu_modifiers
       WHERE restaurant_id = $1 AND is_active = true`,
      [session.restaurant_id]
    ),
  ]);

  const menuMap = {};
  menuItems.forEach(i => { menuMap[i.id] = i; });

  const verified   = [];  // items that passed all checks
  const rejected   = [];  // items that failed (not in menu, unavailable)

  for (const signal of cart_signal) {
    const { id, qty, notes } = signal;

    // 1. item_id must be valid UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!id || !uuidRegex.test(id)) {
      rejected.push({ id, reason: 'invalid_id' });
      console.warn(`⚠️ ai-parse: invalid UUID "${id}"`);
      continue;
    }

    // 2. item must exist in this restaurant's menu
    const item = menuMap[id];
    if (!item) {
      rejected.push({ id, reason: 'not_in_menu' });
      console.warn(`⚠️ ai-parse: item not found "${id}"`);
      continue;
    }

    // 3. item must be available
    if (!item.is_available) {
      rejected.push({ id, name: item.name, reason: 'unavailable' });
      console.warn(`⚠️ ai-parse: item unavailable "${item.name}"`);
      continue;
    }

    // 4. qty must be valid
    const safeQty = Math.max(1, parseInt(qty) || 1);

    // 5. Parse notes — separate free notes from potential paid modifier hints
    // We DON'T do modifier matching here — that happens on confirmation card
    // where customer explicitly checks/unchecks modifiers
    const safeNotes = (notes || '').trim().substring(0, 500);

    // 6. Find applicable modifiers for this item (shown as checkboxes on card)
    const applicableModifiers = modifiers.filter(mod => {
      const itemMatch = mod.applicable_item_ids &&
        mod.applicable_item_ids.includes(id);
      const catMatch  = mod.applicable_categories &&
        mod.applicable_categories.includes(item.category_id);
      return itemMatch || catMatch;
    }).map(mod => ({
      id:    mod.id,
      name:  mod.name,
      price: mod.price,
    }));

    verified.push({
      menu_item_id:         item.id,
      name:                 item.name,
      price:                item.price,          // authoritative DB price
      qty:                  safeQty,
      kot_type:             item.kot_type,
      tax_category:         item.tax_category,
      notes:                safeNotes,
      applicable_modifiers: applicableModifiers, // shown as checkboxes
      line_total:           item.price * safeQty,
    });
  }

  console.log(`✅ ai-parse: ${verified.length} verified, ${rejected.length} rejected`);

  return reply.send({
    verified,
    rejected,
    has_errors: rejected.length > 0,
  });
});

// ── GET /api/order-ui/bill/:sessionId ─────────────────────────────────
// Returns current draft bill for dine-in (live, sums ALL orders in session)
fastify.get('/bill/:sessionId', async (req, reply) => {
  const { sessionId } = req.params;

  const session = await db.queryOne(
    `SELECT s.*, r.name AS restaurant_name,
            r.restaurant_type, r.state_code,
            r.delivery_fee, r.free_delivery_above,
            r.bill_prefix
     FROM sessions s
     JOIN restaurants r ON r.id = s.restaurant_id
     WHERE s.id = $1`,
    [sessionId]
  );
  if (!session) return reply.status(404).send({ error: 'Session not found' });

  // Get ALL order items across ALL orders in this session (dine-in multi-round)
  const allOrderItems = await db.queryAll(
    `SELECT oi.name, oi.price, oi.quantity, oi.subtotal,
            oi.tax_category, oi.kot_type, oi.notes,
            o.created_at AS ordered_at
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.session_id = $1
     ORDER BY o.created_at ASC, oi.name ASC`,
    [sessionId]
  );

  if (allOrderItems.length === 0) {
    return reply.send({ items: [], subtotal: 0, grand_total: 0, empty: true });
  }

  // Calculate taxes using existing billing service
  const { calculateTaxes } = require('../services/billing');
  const taxes = calculateTaxes(allOrderItems, session);

  // Platform discount (Zomato/Swiggy)
  const discountPct    = session.discount_pct || 0;
  const discountAmount = Math.round(taxes.subtotal * discountPct / 100);

  // Delivery fee
  let deliveryFee = 0;
  if (session.mode === 'delivery') {
    const freeAbove = session.free_delivery_above || 0;
    deliveryFee = (freeAbove > 0 && taxes.subtotal >= freeAbove)
      ? 0 : (session.delivery_fee || 0);
  }

  const platformFee = 3;
  const grandTotal  = taxes.subtotal + taxes.total_tax - discountAmount + deliveryFee + platformFee;

  return reply.send({
    items:            allOrderItems,
    subtotal:         taxes.subtotal,
    cgst:             taxes.cgst,
    sgst:             taxes.sgst,
    vat:              taxes.vat,
    total_tax:        taxes.total_tax,
    discount_pct:     discountPct,
    discount_amount:  discountAmount,
    delivery_fee:     deliveryFee,
    platform_fee:     platformFee,
    grand_total:      grandTotal,
    bill_status:      session.bill_status,
    session_platform: session.platform,
  });
});

// ── POST /api/order-ui/bill/request/:sessionId ────────────────────────
// Customer taps "Get Bill" — moves bill_status to draft
fastify.post('/bill/request/:sessionId', async (req, reply) => {
  const { sessionId } = req.params;

  const session = await db.queryOne(
    'SELECT id, bill_status, mode FROM sessions WHERE id = $1',
    [sessionId]
  );
  if (!session) return reply.status(404).send({ error: 'Session not found' });
  if (session.bill_status === 'paid') {
    return reply.status(409).send({ error: 'Bill already paid' });
  }

  // Check orders exist
  const orderCount = await db.queryOne(
    'SELECT COUNT(*) as cnt FROM orders WHERE session_id = $1',
    [sessionId]
  );
  if (parseInt(orderCount.cnt) === 0) {
    return reply.status(400).send({ error: 'No orders placed yet' });
  }

  await db.query(
    `UPDATE sessions SET bill_status = 'draft', updated_at = NOW() WHERE id = $1`,
    [sessionId]
  );

  console.log(`🧾 Bill requested: session ${sessionId}`);
  return reply.send({ success: true, bill_status: 'draft' });
});

// ── POST /api/order-ui/bill/pay/:sessionId ────────────────────────────
// Customer taps "Pay Now" — moves bill_status to payment_pending
// Also handles platform choice (direct vs zomato/swiggy)
fastify.post('/bill/pay/:sessionId', async (req, reply) => {
  const { sessionId } = req.params;
  const { payment_method, payment_type } = req.body || {};
  // payment_method: cash | upi | card | cod | counter_qr
  // payment_type:   direct | platform

  const session = await db.queryOne(
    `SELECT s.*, r.name AS restaurant_name, r.owner_phone
     FROM sessions s
     JOIN restaurants r ON r.id = s.restaurant_id
     WHERE s.id = $1`,
    [sessionId]
  );
  if (!session) return reply.status(404).send({ error: 'Session not found' });
  if (session.bill_status === 'paid') {
    return reply.status(409).send({ error: 'Already paid' });
  }

  const safeMethod = payment_method || 'cash';
  const safeType   = payment_type   || 'direct';

  // Move to payment_pending — session locks for new orders
  await db.query(
    `UPDATE sessions
     SET bill_status = 'payment_pending',
         updated_at  = NOW()
     WHERE id = $1`,
    [sessionId]
  );

  // Notify owner via WhatsApp
  if (session.owner_phone) {
    const msg = safeType === 'platform'
      ? `💳 *Payment Initiated*\nTable ${session.table_number} — ${(session.platform || '').toUpperCase()} payment\nCustomer is paying via app.\n\n[Verify & Confirm] in dashboard`
      : `💳 *Payment Initiated*\nTable ${session.table_number} — ${safeMethod.toUpperCase()}\nPlease collect payment and confirm in dashboard.`;
    await whatsapp.sendMessage(session.owner_phone, msg).catch(e =>
      console.warn('WhatsApp notify failed:', e.message)
    );
  }

  console.log(`💳 Pay initiated: ${sessionId} | method=${safeMethod} | type=${safeType}`);
  return reply.send({ success: true, bill_status: 'payment_pending' });
});

// ── POST /api/order-ui/bill/confirm/:sessionId ────────────────────────
// Owner confirms payment received — called from owner dashboard
// Locks session permanently
fastify.post('/bill/confirm/:sessionId', async (req, reply) => {
  const { sessionId } = req.params;
  const { payment_method, payment_type, amount_collected } = req.body || {};

  const session = await db.queryOne(
    `SELECT s.*, r.name AS restaurant_name
     FROM sessions s JOIN restaurants r ON r.id = s.restaurant_id
     WHERE s.id = $1`,
    [sessionId]
  );
  if (!session) return reply.status(404).send({ error: 'Session not found' });
  if (session.bill_status === 'paid') {
    return reply.status(409).send({ error: 'Already paid' });
  }

  // Lock session
  await db.query(
    `UPDATE sessions
     SET bill_status = 'paid',
         status      = 'paid',
         updated_at  = NOW()
     WHERE id = $1`,
    [sessionId]
  );

  // Mark bill(s) as paid for this session
  await db.query(
    `UPDATE bills
     SET status         = 'paid',
         payment_method = COALESCE($1, payment_method),
         payment_type   = $2,
         cash_collected = $3,
         paid_at        = NOW()
     WHERE session_id = $4`,
    [
      payment_method || 'cash',
      payment_type   || 'direct',
      (payment_method === 'cash' || payment_method === 'cod'),
      sessionId,
    ]
  );

  console.log(`✅ Payment confirmed: ${sessionId} | method=${payment_method} | type=${payment_type}`);

  // Notify customer via WhatsApp if phone available
  if (session.customer_phone && session.customer_phone !== 'qr_session') {
    const msg = `✅ *Payment Confirmed!*\n\nThank you for dining with us! 🙏\nUmmeed hai khana pasand aaya!\n\n_${session.restaurant_name}_`;
    await whatsapp.sendMessage(session.customer_phone, msg).catch(() => {});
  }

  return reply.send({ success: true, bill_status: 'paid' });
});

// ── POST /api/order-ui/session/close/:sessionId ───────────────────────
// Owner manually closes session (walkout / end of night)
fastify.post('/session/close/:sessionId', async (req, reply) => {
  const { sessionId } = req.params;
  const { reason }    = req.body || {};

  await db.query(
    `UPDATE sessions
     SET status     = 'closed',
         updated_at = NOW()
     WHERE id = $1`,
    [sessionId]
  );

  console.log(`🔒 Session closed: ${sessionId} | reason=${reason || 'manual'}`);
  return reply.send({ success: true });
});

// ══════════════════════════════════════════════════════════════════════
// UPGRADED AI CHAT — replaces existing /ai-chat/:sessionId
// Key changes:
//   1. Menu sent with UUIDs
//   2. @@CART JSON format (not @@ADD:Name:qty@@)
//   3. Upsell flag from DB
//   4. All 14 rules in system prompt
//   5. AI never writes to cart — returns signal only
// ══════════════════════════════════════════════════════════════════════
fastify.post('/ai-chat-v2/:sessionId', async (req, reply) => {
  const { sessionId } = req.params;
  const { message, history, language } = req.body || {};

  if (!message) return reply.status(400).send({ error: 'message required' });

  // ── Load session ──
  const session = await db.queryOne(
    `SELECT s.*, r.name AS restaurant_name, r.welcome_message
     FROM sessions s
     JOIN restaurants r ON r.id = s.restaurant_id
     WHERE s.id = $1`,
    [sessionId]
  );
  if (!session) return reply.status(404).send({ error: 'Session not found' });

  // Block chat if session is payment_pending or paid/closed
  if (session.bill_status === 'payment_pending') {
    return reply.send({
      reply: 'Payment process mein hai 😊 Naya order nahi ho sakta abhi. Dobara aana! 🙏',
      signal: null,
    });
  }
  if (['paid', 'closed', 'delivered'].includes(session.status)) {
    return reply.send({
      reply: 'Session expire ho gayi 😊 Ummeed hai khana pasand aaya! Dobara milte hain 🙏',
      signal: null,
    });
  }

  // ── Load menu with UUIDs ──
  const [menuItems, categories, modifiers] = await Promise.all([
    db.queryAll(
      `SELECT mi.id, mi.name, mi.price, mi.is_available,
              mc.name AS category_name, mc.id AS category_id
       FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id
       WHERE mi.restaurant_id = $1 AND mi.is_available = true
       ORDER BY mc.sort_order ASC NULLS LAST, mi.sort_order ASC NULLS LAST`,
      [session.restaurant_id]
    ),
    db.queryAll(
      `SELECT id, name FROM menu_categories
       WHERE restaurant_id = $1 AND is_active = true
       ORDER BY sort_order ASC`,
      [session.restaurant_id]
    ),
    db.queryAll(
      `SELECT id, name, price, applicable_item_ids
       FROM menu_modifiers
       WHERE restaurant_id = $1 AND is_active = true`,
      [session.restaurant_id]
    ).catch(() => []),
  ]);

  // ── Build UUID-based menu text ──
  const menuText = menuItems
    .map(i => `[${i.id}] ${i.name} | ₹${i.price} | ${i.category_name}`)
    .join('\n');

  // ── Live cart from DB ──
  const liveCart = await cartSvc.getCart(sessionId);
  const cartText = liveCart.items.length
    ? liveCart.items.map(i => `• ${i.name} x${i.quantity} (₹${i.subtotal})`).join('\n')
    : 'empty';

  // ── Latest order status ──
  const latestOrder = await db.queryOne(
    `SELECT o.id, k.status AS kot_status
     FROM orders o
     LEFT JOIN kots k ON k.order_id = o.id AND k.kot_type = 'kitchen'
     WHERE o.session_id = $1
     ORDER BY o.created_at DESC LIMIT 1`,
    [sessionId]
  ).catch(() => null);

  const kotStatus = latestOrder
    ? ({ new: 'Order received — kitchen preparing', cooking: 'Being prepared (15-20 mins)',
         ready: 'Ready!', done: 'Delivered' }[latestOrder.kot_status] || latestOrder.kot_status)
    : 'No order placed yet';

  // ── Build system prompt ──
  const systemPrompt = `You are Buddy, a friendly ordering assistant for ${session.restaurant_name}.
Your ONLY job: help customer pick items and build their order.
Session: ${session.mode}${session.table_number ? ', Table ' + session.table_number : ''}
Platform: ${session.platform || 'direct'}
Language: Reply in ${language || 'Hinglish (Hindi+English mix)'}. Item names always in English as-is.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MENU (format: [UUID] Name | ₹Price | Category):
${menuText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT CART (live from DB):
${cartText}

LAST ORDER STATUS: ${kotStatus}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR SIGNAL FORMAT — when emitting cart:
@@CART:[{"id":"EXACT-UUID-FROM-MENU","qty":2,"notes":"extra spicy, no onion"},{"id":"EXACT-UUID","qty":1,"notes":""}]@@

RULES — follow ALL of these EXACTLY:

1. SIGNAL FORMAT — use @@CART JSON@@ ONLY — never @@ADD@@ or @@REMOVE@@
   - id = EXACT UUID from menu above — copy it character by character
   - qty = number — default 1 if customer didn't mention
   - notes = preparation/serving instructions only (extra spicy, no onion, sauce side mein)
   - NEVER include modifier prices in notes — just the instruction text
   - Emit signal ONLY when ZERO ambiguity remains for ALL items

2. NEVER emit signal until 100% clear on every item AND every quantity
   - 2+ items match → show numbered list → ask customer to pick
   - Two numbers in message ("do aur teen") → ask "2 ya 3 chahiye?"
   - Ambiguous modifier → ask "Extra patty add karna hai (+price) ya sirf style change (free)?"
   - Ask ONE question at a time — never multiple questions together

3. QUANTITY WORDS — parse these correctly:
   Hindi: ek=1, do=2, teen=3, char=4, paanch=5, chhe=6, saat=7, aath=8
   English: one=1, two=2, three=3, four=4, five=5
   Spanish: uno=1, dos=2, tres=3
   No number mentioned → always default to 1
   "ek aur burger" → qty 1 additive (add 1 more to existing)

4. NEVER touch cart — never say item was added before emitting signal
   - Say: "ho gaya!" or confirm what you're adding, then emit signal
   - NEVER say "Cart mein add kar diya" — that happens after customer confirms

5. CART CHANGES — redirect to UI
   - Remove/update requests → "Cart mein +/- buttons se change karo 😊"
   - Never emit @@CART for removals

6. UPSELL — only if upsell_shown is false
   Upsell shown: ${session.upsell_shown ? 'YES — skip upsell completely' : 'NO — upsell allowed once'}
   - When customer signals done ("bas", "ho gaya", "order karo") → suggest ONE item
   - Burger + no drink → suggest a drink
   - Main course + no dessert → suggest dessert
   - Cart already full (main+drink+side) → skip upsell
   - Customer says no → move on immediately, NEVER ask again
   - After upsell (yes or no) → emit @@CART signal

7. ORDER STATUS — if customer asks about their order
   Current status: ${kotStatus}
   Just tell them the status — do not make up details

8. BILL REQUESTS — always redirect to UI button
   "bill lao", "check please", "pay karna hai" →
   Reply: "Bill ke liye neeche 🧾 Get Bill button tap karo 😊"
   NEVER handle billing yourself

9. MENU NAVIGATION
   - Keyword search → group by category → show top 3 per category
   - Show format: "1. Item Name — ₹Price"
   - More than 5 matches → show top 3 + "Aur dekho menu mein ☝️"
   - Customer picks number → confirm that exact item

10. KEEP REPLIES SHORT — max 2-3 lines
    - Never list entire menu unprompted
    - Never repeat cart contents (shown on screen)
    - Friendly, warm tone always

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXAMPLE — correct signal:
Customer: "do Russian Burger aur ek Cold Coffee extra ice"
Signal: @@CART:[{"id":"uuid-of-russian-burger","qty":2,"notes":""},{"id":"uuid-of-cold-coffee","qty":1,"notes":"extra ice"}]@@
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system:     systemPrompt,
      messages:   [...(history || []).slice(-10), { role: 'user', content: message }],
    });

    let replyText = response.content.find(b => b.type === 'text')?.text || 'Let me know how I can help!';
    console.log(`🤖 AI v2 raw: ${replyText.substring(0, 200)}`);

    // ── Parse @@CART signal ──
    const cartMatch = replyText.match(/@@CART:(\[[\s\S]*?\])@@/);
    let cartSignal  = null;

    if (cartMatch) {
      try {
        cartSignal = JSON.parse(cartMatch[1]);
        // Validate basic structure
        if (!Array.isArray(cartSignal)) cartSignal = null;
      } catch (e) {
        console.warn('⚠️ AI returned malformed @@CART JSON:', cartMatch[1]);
        cartSignal = null;
      }
    }

    // ── Check if upsell was just shown ──
    // If AI mentioned an upsell suggestion, mark flag in DB
    const isUpsellMsg = !session.upsell_shown && cartSignal === null &&
      /saath mein|add karein|try karein|suggest|recommend/i.test(replyText);
    if (isUpsellMsg) {
      await db.query(
        'UPDATE sessions SET upsell_shown = true WHERE id = $1',
        [sessionId]
      ).catch(() => {});
    }

    // ── Strip signal from visible reply ──
    const cleanReply = replyText
      .replace(/@@CART:\[[\s\S]*?\]@@/g, '')
      .replace(/@@ADD:[^@]*@@/g, '')     // legacy cleanup
      .replace(/@@UPDATE:[^@]*@@/g, '')
      .replace(/@@REMOVE:[^@]*@@/g, '')
      .replace(/@@SHOW_CART@@/g, '')
      .replace(/@@PLACE_ORDER:[^@]*@@/g, '')
      .trim();

    return reply.send({
      reply:       cleanReply,
      cart_signal: cartSignal,   // null = no action, array = show confirmation card
      // Frontend: if cart_signal is not null → call /ai-parse → show confirmation card
    });

  } catch (err) {
    console.error('AI chat v2 error:', err);
    return reply.send({
      reply: 'Sorry, thodi dikkat aayi! Dobara try karo 😊',
      cart_signal: null,
    });
  }
});

