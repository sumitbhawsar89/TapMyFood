// ══════════════════════════════════════════════════════════
// OrderBuddy — Order UI API Routes
// Register in server.js: app.register(orderUIRoutes, { prefix: '/api/order-ui' })
// ══════════════════════════════════════════════════════════

const db          = require('../database/db');
const cartSvc     = require('../services/cart');
const whatsapp    = require('../services/whatsapp');
const billing     = require('../services/billing');
const deliverySvc = require('../services/delivery');

module.exports = async function orderUIRoutes(fastify, opts) {

  // ── GET /api/order-ui/session/:sessionId ──
  fastify.get('/session/:sessionId', async (req, reply) => {
    const session = await db.queryOne(
      `SELECT s.id, s.mode, s.table_number, s.status, s.customer_phone,
              s.discount_pct, s.platform, s.restaurant_id,
              r.name AS restaurant_name
       FROM sessions s
       JOIN restaurants r ON r.id = s.restaurant_id
       WHERE s.id = $1`,
      [req.params.sessionId]
    );
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    return reply.send(session);
  });

  // ── GET /api/order-ui/menu/:sessionId ──
  fastify.get('/menu/:sessionId', async (req, reply) => {
    const session = await db.queryOne(
      'SELECT restaurant_id FROM sessions WHERE id = $1',
      [req.params.sessionId]
    );
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const [restaurant, categories, items, modifiers] = await Promise.all([
      db.queryOne('SELECT id, name, slug, welcome_message FROM restaurants WHERE id = $1', [session.restaurant_id]),
      db.queryAll(
        `SELECT id, name, sort_order FROM menu_categories
         WHERE restaurant_id = $1 AND is_active = true
         ORDER BY sort_order ASC NULLS LAST, name ASC`,
        [session.restaurant_id]
      ),
      db.queryAll(
        `SELECT id, name, price, description, category_id, is_veg, image_url
         FROM menu_items
         WHERE restaurant_id = $1 AND is_available = true
         ORDER BY sort_order ASC NULLS LAST, name ASC`,
        [session.restaurant_id]
      ),
      db.queryAll(
        `SELECT id, name, price, applicable_categories, applicable_item_ids
         FROM menu_modifiers
         WHERE restaurant_id = $1 AND is_active = true
         ORDER BY sort_order ASC`,
        [session.restaurant_id]
      ).catch(() => [])
    ]);

    return reply.send({ restaurant, categories, items, modifiers });
  });

  // ── GET /api/order-ui/cart/:sessionId ──
  fastify.get('/cart/:sessionId', async (req, reply) => {
    try {
      const cart = await cartSvc.getCart(req.params.sessionId);
      return reply.send(cart);
    } catch (e) {
      return reply.send({ items: [], subtotal: 0 });
    }
  });

  // ── POST /api/order-ui/cart/:sessionId ──
  fastify.post('/cart/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;
    const { items }     = req.body;

    const session = await db.queryOne(
      'SELECT restaurant_id FROM sessions WHERE id = $1', [sessionId]
    );
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    // Fetch menu items to get name/price/kot_type/tax_category
    const menuItems = await db.queryAll(
      'SELECT id, name, price, kot_type, tax_category FROM menu_items WHERE restaurant_id = $1',
      [session.restaurant_id]
    );
    const menuMap = {};
    menuItems.forEach(i => { menuMap[i.id] = i; });

    // UPSERT each item — never DELETE the whole cart
    // This prevents stale browser state from wiping AI-written items
    // Items in browser = update qty. Items only in DB (AI-written) = untouched.
    const browserIds = new Set((items || []).map(i => i.menu_item_id).filter(Boolean));

    for (const item of (items || [])) {
      if (!item.menu_item_id || !item.quantity || item.quantity < 1) continue;
      const mi = menuMap[item.menu_item_id];
      if (!mi) continue;
      await db.query(
        `INSERT INTO cart_items
           (session_id, menu_item_id, name, price, quantity, subtotal, kot_type, tax_category, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (session_id, menu_item_id)
         DO UPDATE SET quantity=$5, subtotal=$6, notes=COALESCE($9, cart_items.notes)`,
        [sessionId, item.menu_item_id, mi.name, mi.price, item.quantity,
         mi.price * item.quantity, mi.kot_type, mi.tax_category, item.notes || null]
      );
      console.log('💾 saveCart upsert: ' + mi.name + ' x' + item.quantity);
    }

    // Only delete items that browser explicitly removed (qty=0 or absent from browser)
    // But ONLY if browser sent a non-empty cart (partial saves shouldn't delete anything)
    if (browserIds.size > 0) {
      const existingItems = await db.queryAll(
        'SELECT menu_item_id FROM cart_items WHERE session_id = $1', [sessionId]
      );
      for (const existing of existingItems) {
        if (!browserIds.has(existing.menu_item_id)) {
          // Item in DB but not in browser — only delete if browser sent a FULL cart
          // Full cart = browser sent 3+ items OR explicitly removed this item
          if (items && items.length >= existingItems.length) {
            await db.query(
              'DELETE FROM cart_items WHERE session_id=$1 AND menu_item_id=$2',
              [sessionId, existing.menu_item_id]
            );
            console.log('🗑️ saveCart removed: ' + existing.menu_item_id);
          }
        }
      }
    }

    const cart = await cartSvc.getCart(sessionId);
    return reply.send({ success: true, cart });
  });

  // ── POST /api/order-ui/cart-item/:sessionId — single item upsert (safe, no full-cart wipe) ──
  fastify.post('/cart-item/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;
    const { menu_item_id, quantity, name, price, notes, modifiers } = req.body || {};
    const parsedMods = Array.isArray(modifiers) ? modifiers : [];
    const modsTotal  = parsedMods.reduce((s, m) => s + (m.price || 0), 0);
    if (!menu_item_id) return reply.status(400).send({ error: 'menu_item_id required' });

    const session = await db.queryOne(
      `SELECT s.id, o.id AS order_id
       FROM sessions s
       LEFT JOIN orders o ON o.session_id = s.id
       WHERE s.id = $1 AND s.status NOT IN ('closed','paid','delivered')`,
      [sessionId]
    );
    if (!session) return reply.status(410).send({ error: 'Session expired or order already placed' });
    // Block cart changes if order already exists
    if (session.order_id) return reply.status(409).send({ error: 'Order already placed — cart locked' });

    // Always look up authoritative menu data — never trust browser price
    const mi = await db.queryOne('SELECT * FROM menu_items WHERE id = $1', [menu_item_id]);
    const basePrice   = mi ? mi.price        : (price || 0);
    const itemPrice   = basePrice + modsTotal;
    const kotType     = mi ? mi.kot_type     : 'kitchen';
    const taxCategory = mi ? mi.tax_category : 'food';
    const itemName    = mi ? mi.name         : (name || 'Unknown');
    const qty         = parseInt(quantity) || 0;

    if (qty < 1) {
      // qty=0 means remove
      await db.query(
        'DELETE FROM cart_items WHERE session_id=$1 AND menu_item_id=$2',
        [sessionId, menu_item_id]
      );
      console.log('🗑️ cart-item removed: ' + itemName);
    } else {
      await db.query(
        `INSERT INTO cart_items
           (session_id, menu_item_id, name, price, quantity, subtotal, kot_type, tax_category, notes, modifiers)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (session_id, menu_item_id)
         DO UPDATE SET
           quantity  = $5,
           subtotal  = $6,
           notes     = COALESCE($9, cart_items.notes),
           modifiers = $10`,
        [sessionId, menu_item_id, itemName, itemPrice, qty,
         itemPrice * qty, kotType, taxCategory, notes || null, JSON.stringify(parsedMods)]
      );
      console.log('🛒 cart-item upsert: ' + itemName + ' x' + qty);
    }
    return reply.send({ success: true });
  });

  // ── GET /api/order-ui/past-addresses/:sessionId ──
  fastify.get('/past-addresses/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;
    const session = await db.queryOne('SELECT customer_phone, restaurant_id FROM sessions WHERE id = $1', [sessionId]);
    if (!session) return reply.send({ addresses: [] });

    const past = await db.queryAll(
      `SELECT DISTINCT ON (delivery_address) delivery_address
       FROM sessions
       WHERE customer_phone = $1
         AND restaurant_id = $2
         AND delivery_address IS NOT NULL
         AND delivery_address != ''
       ORDER BY delivery_address, created_at DESC
       LIMIT 3`,
      [session.customer_phone, session.restaurant_id]
    );
    return reply.send({ addresses: past.map(r => r.delivery_address) });
  });

  // ── POST /api/order-ui/address/:sessionId ──
  fastify.post('/address/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;
    const { address }   = req.body || {};
    if (!address) return reply.status(400).send({ error: 'Address required' });

    await db.query(
      'UPDATE sessions SET delivery_address = $1, updated_at = NOW() WHERE id = $2',
      [address, sessionId]
    );
    return reply.send({ success: true });
  });

  // ── POST /api/order-ui/place-order/:sessionId ──
  fastify.post('/place-order/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;

    const session = await db.queryOne(
      `SELECT s.*, r.name AS restaurant_name, r.owner_phone, r.delivery_phones,
              r.delivery_fee, r.free_delivery_above
       FROM sessions s JOIN restaurants r ON r.id = s.restaurant_id
       WHERE s.id = $1`,
      [sessionId]
    );
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    if (['closed', 'paid', 'delivered'].includes(session.status)) {
      return reply.status(410).send({ error: 'Session expired. Please scan QR code again.' });
    }

    const cart = await cartSvc.getCart(sessionId);
    if (!cart.items || cart.items.length === 0) {
      return reply.status(400).send({ error: 'Cart is empty' });
    }

    try {
      console.log(`🛒 Web order: session=${sessionId}, mode=${session.mode}, items=${cart.items.length}`);

      // Step 1: Create order row
      const { rows: [order] } = await db.query(
        `INSERT INTO orders (session_id, restaurant_id, status)
         VALUES ($1, $2, 'confirmed') RETURNING *`,
        [sessionId, session.restaurant_id]
      );

      for (const item of cart.items) {
        await db.query(
          `INSERT INTO order_items
            (order_id, menu_item_id, name, price, quantity, subtotal, kot_type, tax_category, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [order.id, item.menu_item_id, item.name, item.price,
           item.quantity, item.subtotal,
           item.kot_type || 'kitchen',
           item.tax_category || 'standard',
           item.notes || null]
        );
      }

      // Step 2: KOT
      const foodItems = cart.items.filter(i => (i.kot_type || 'kitchen') === 'kitchen');
      const barItems  = cart.items.filter(i => i.kot_type === 'bar');
      if (foodItems.length > 0) {
        await db.query(
          `INSERT INTO kots (order_id, restaurant_id, kot_type, items, table_number)
           VALUES ($1,$2,'kitchen',$3,$4)`,
          [order.id, session.restaurant_id, JSON.stringify(foodItems), session.table_number || null]
        );
      }
      if (barItems.length > 0) {
        await db.query(
          `INSERT INTO kots (order_id, restaurant_id, kot_type, items, table_number)
           VALUES ($1,$2,'bar',$3,$4)`,
          [order.id, session.restaurant_id, JSON.stringify(barItems), session.table_number || null]
        );
      }

      // Step 3: Clear cart
      await db.query('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);

      // Step 4: Generate bill
      const bill = await billing.generateBill(session);
      console.log(`✅ Bill generated: ${bill.bill_number}`);

      // Update session status
      if (session.mode !== 'dine_in') {
        await db.query(
          "UPDATE sessions SET status = 'ordered', updated_at = NOW() WHERE id = $1",
          [sessionId]
        );
      }

      // Customer WhatsApp confirmation — full bill breakdown
      let confirmMsg = `✅ *Order Confirmed!*\n\n*Bill #${bill.bill_number}*\n\n`;
      for (const item of cart.items) {
        confirmMsg += `• ${item.name} x${item.quantity} — ₹${item.subtotal}\n`;
        if (item.notes) confirmMsg += `  📝 _${item.notes}_\n`;
      }
      confirmMsg += `\nSubtotal: ₹${bill.subtotal}\n`;
      if (bill.total_tax > 0)        confirmMsg += `GST: ₹${bill.total_tax}\n`;
      if (bill.discount_amount > 0)  confirmMsg += `Discount: -₹${bill.discount_amount}\n`;
      if (bill.deliveryFee > 0)      confirmMsg += `Delivery Fee: ₹${bill.deliveryFee}\n`;
      else if (bill.freeDelivery)    confirmMsg += `Delivery Fee: FREE 🎉\n`;
      if (bill.platform_fee > 0)     confirmMsg += `Convenience Fee: ₹${bill.platform_fee}\n`;
      confirmMsg += `━━━━━━━━━━━━\n*Total: ₹${bill.grand_total}*`;
      if (bill.appliedOffers?.length > 0) {
        confirmMsg += `\n\n🎉 *Offers Applied:*\n`;
        for (const o of bill.appliedOffers) confirmMsg += `  • ${o}\n`;
      }
      if (session.mode === 'delivery') {
        if (session.delivery_address) confirmMsg += `\n\n📍 *Delivering to:*\n${session.delivery_address}`;
        confirmMsg += `\n\n🛵 Estimated: *25-35 mins*`;
      } else if (session.mode === 'dine_in') {
        confirmMsg += `\n\n🍽️ Table ${session.table_number} — being prepared!`;
      } else if (session.mode === 'takeaway') {
        confirmMsg += `\n\n🎫 Ready in *15-20 mins* — show at counter`;
      }
      await whatsapp.sendMessage(session.customer_phone, confirmMsg);

      // Owner notification
      if (session.owner_phone) {
        let ownerMsg = `🔔 *New Order (Web UI)*\n*Bill:* ${bill.bill_number}\n`;
        ownerMsg += `━━━━━━━━━━━━━━\n`;
        for (const item of cart.items) {
          ownerMsg += `• ${item.name} x${item.quantity} — ₹${item.subtotal}\n`;
          if (item.notes) ownerMsg += `  ⚠️ *SPECIAL: ${item.notes}*\n`;
        }
        ownerMsg += `━━━━━━━━━━━━━━\n`;
        ownerMsg += `💰 *Total: ₹${bill.grand_total}*\n`;
        ownerMsg += `📱 *Via:* Web Menu | 📦 *Mode:* ${session.mode.toUpperCase()}\n`;
        if (session.mode === 'dine_in' && session.table_number) ownerMsg += `🍽️ *Table:* ${session.table_number}`;
        if (session.mode === 'delivery' && session.delivery_address) ownerMsg += `📍 *Address:* ${session.delivery_address}`;
        await whatsapp.sendMessage(session.owner_phone, ownerMsg);
      }

      // Delivery boy notification
      if (session.mode === 'delivery' && session.delivery_phones) {
        const restaurant = await db.queryOne('SELECT * FROM restaurants WHERE id = $1', [session.restaurant_id]);
        await deliverySvc.broadcastToDeliveryBoys({
          order:  { id: order.id },
          bill:   { ...bill, payment_status: bill.status },
          session,
          restaurant,
          cart,
        });
        console.log(`📦 Delivery broadcast sent for bill ${bill.bill_number}`);
      } else if (session.mode === 'delivery') {
        console.log(`⚠️ No delivery_phones set — skipping delivery notification`);
      }

      // Dine-in: keep session active
      if (session.mode === 'dine_in') {
        await db.query("UPDATE sessions SET status = 'active', updated_at = NOW() WHERE id = $1", [sessionId]);
        await new Promise(r => setTimeout(r, 1000));
        await whatsapp.sendInteractiveButtons(session.customer_phone,
          `Table ${session.table_number} — Order sent! 👨‍🍳\nWant anything else?`,
          [
            { id: 'view_running_tab', title: 'View My Tab'  },
            { id: 'request_bill',     title: 'Request Bill' },
          ]
        );
      }

      return reply.send({ success: true, bill_number: bill.bill_number, total: bill.grand_total });
    } catch (err) {
      console.error('Order UI place order error:', err);
      return reply.status(500).send({ error: 'Failed to place order' });
    }
  });

  // ── POST /api/order-ui/ai-place-order/:sessionId ──
  // Called by AI when customer confirms order intent
  fastify.post('/ai-place-order/:sessionId', async (req, reply) => {
    const { sessionId } = req.params;
    const { address }   = req.body || {};

    // Save address if provided
    if (address) {
      await db.query(
        'UPDATE sessions SET delivery_address = $1, updated_at = NOW() WHERE id = $2',
        [address, sessionId]
      );
    }

    // Delegate to place-order logic by calling it internally
    return fastify.inject({
      method: 'POST',
      url: `/api/order-ui/place-order/${sessionId}`,
      payload: {},
    }).then(r => {
      const data = JSON.parse(r.payload);
      return reply.status(r.statusCode).send(data);
    });
  });

  // ── POST /api/order-ui/upsell/:sessionId ──
  // Called just before place order — AI suggests one more item
  fastify.post('/upsell/:sessionId', async (req, reply) => {
    const { sessionId }  = req.params;
    const { cartItems }  = req.body || {};

    const session = await db.queryOne('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!session) return reply.send({ suggestion: null });

    const menuItems = await db.queryAll(
      `SELECT mi.id, mi.name, mi.price, mi.kot_type, mi.tax_category, mc.name AS category
       FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id
       WHERE mi.restaurant_id = $1 AND mi.is_available = true
       ORDER BY mc.sort_order, mi.sort_order`,
      [session.restaurant_id]
    );

    const cartSet  = new Set((cartItems || []).map(n => n.toLowerCase()));
    const menuText = menuItems.map(i => i.name + ' ₹' + i.price + ' [' + i.category + ']').join(', ');

    try {
      // Deterministic rule-based upsell — no AI call, no timeout risk
      const cartSet = new Set((cartItems || []).map(n => n.toLowerCase()));
      const hasBurger = cartItems.some(n => n.toLowerCase().includes('burger'));
      const hasDrink  = cartItems.some(n =>
        n.toLowerCase().includes('coffee') || n.toLowerCase().includes('shake') ||
        n.toLowerCase().includes('juice')  || n.toLowerCase().includes('drink'));
      const hasFries  = cartItems.some(n =>
        n.toLowerCase().includes('fries') || n.toLowerCase().includes('chips'));
      const hasNuggets = cartItems.some(n => n.toLowerCase().includes('nugget'));

      // Priority: burger+no drink → suggest drink, burger+no fries → suggest fries
      let candidate = null;
      if (hasBurger && !hasDrink) {
        candidate = menuItems.find(i =>
          (i.name.toLowerCase().includes('coffee') || i.name.toLowerCase().includes('shake')) &&
          !cartSet.has(i.name.toLowerCase()));
      }
      if (!candidate && hasBurger && !hasFries) {
        candidate = menuItems.find(i =>
          i.name.toLowerCase().includes('fries') && !cartSet.has(i.name.toLowerCase()));
      }
      if (!candidate && hasBurger && !hasNuggets) {
        candidate = menuItems.find(i =>
          i.name.toLowerCase().includes('nugget') && !cartSet.has(i.name.toLowerCase()));
      }
      if (!candidate) {
        // Fallback: first item not in cart
        candidate = menuItems.find(i => !cartSet.has(i.name.toLowerCase()) && i.price < 100);
      }

      if (!candidate) return reply.send({ suggestion: null });

      const messages = {
        drink:   'Perfect with your burger — refreshing combo! 🥤',
        fries:   'Crispy fries make every burger better! 🍟',
        nugget:  'Best combo with your order — try it! 🍗',
        default: 'Customers love pairing this with their order! 😋'
      };
      const msgKey = candidate.name.toLowerCase().includes('coffee') || candidate.name.toLowerCase().includes('shake')
        ? 'drink' : candidate.name.toLowerCase().includes('fries') ? 'fries'
        : candidate.name.toLowerCase().includes('nugget') ? 'nugget' : 'default';

      return reply.send({
        suggestion: candidate.name,
        itemId:     candidate.id,
        price:      candidate.price,
        message:    messages[msgKey]
      });
    } catch(e) {
      console.error('Upsell error:', e.message);
      return reply.send({ suggestion: null });
    }
  });

  // ── POST /api/order-ui/ai-chat/:sessionId ──
  fastify.post('/ai-chat/:sessionId', async (req, reply) => {
    const { sessionId }              = req.params;
    const { message, history, cartInfo, language } = req.body || {};

    const session = await db.queryOne('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!session) return reply.status(404).send({ error: 'Session not found' });

    const menuItems = await db.queryAll(
      `SELECT mi.id, mi.name, mi.price, mi.kot_type, mi.tax_category, mc.name AS category
       FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id
       WHERE mi.restaurant_id = $1 AND mi.is_available = true
       ORDER BY mc.sort_order, mi.sort_order`,
      [session.restaurant_id]
    );

    const menuText = menuItems.map(i => `${i.name} | ₹${i.price} | ${i.category}`).join('\n');

    const deliveryAddress = session.delivery_address || null;
    const isDelivery = session.mode === 'delivery';

    // Get latest order status for this session
    const latestOrder = await db.queryOne(
      `SELECT o.id, o.status, o.created_at,
              b.bill_number, b.grand_total,
              k.status AS kot_status, k.kot_type
       FROM orders o
       LEFT JOIN bills b ON b.order_id = o.id
       LEFT JOIN kots k ON k.order_id = o.id AND k.kot_type = 'kitchen'
       WHERE o.session_id = $1
       ORDER BY o.created_at DESC LIMIT 1`,
      [sessionId]
    );

    let orderContext = 'No order placed yet in this session';
    if (latestOrder) {
      const kotStatus = latestOrder.kot_status || 'new';
      const statusMap = {
        new: 'Order received — kitchen will start soon',
        cooking: 'Being prepared in kitchen (15-20 mins)',
        ready: latestOrder.status === 'delivery' ? 'Out for delivery (10-15 mins)' : 'Ready for pickup at counter',
        done: 'Delivered'
      };
      orderContext = 'Bill #' + latestOrder.bill_number + ' — ₹' + latestOrder.grand_total +
        ' | Status: ' + (statusMap[kotStatus] || kotStatus);
    }

    // Always fetch live cart from DB for AI context (browser cart can be stale)
    const liveCart = await cartSvc.getCart(sessionId);
    const liveCartText = liveCart.items.length
      ? liveCart.items.map(i => `${i.name} x${i.quantity} (₹${i.subtotal})`).join(', ')
      : 'empty';

    const systemPrompt = `You are Buddy, a friendly menu assistant for ${session.restaurant_name || 'this restaurant'}.
Your ONLY job: help customer pick items and add them to cart.

SESSION: ${session.mode}${session.table_number ? ', Table ' + session.table_number : ''}

MENU:
${menuText}

CURRENT CART (from DB — this is accurate):
${liveCartText}

YOUR RULES — READ CAREFULLY:

1. ADD ITEMS ONLY — use @@ADD:Item Name:qty@@
   - DEFAULT QTY IS ALWAYS 1 — unless customer says a number explicitly
   - "peri peri" → @@ADD:Peri-Peri French Fries:1@@  (NOT 2, NOT guessing)
   - "do russian aur ek coffee" → @@ADD:Russian Burger:2@@ @@ADD:Cold Coffee:1@@
   - Hindi: ek=1, do=2, teen=3, char=4, paanch=5
   - English: one=1, two=2, three=3
   - If no number → always 1. Never assume based on other items in order.

2. NEVER manage cart — no UPDATE, no REMOVE, no qty changes
   - If customer says "remove X" or "change qty" → say: "Cart mein +/- buttons se change karo 👆"
   - If customer says "sirf ek chahiye tha" → say: "Cart drawer mein minus button tap karo 😊"
   - NEVER try to fix quantities yourself

3. NEVER show cart contents in your reply
   - Cart is shown live on screen — don't repeat it
   - NEVER say "Cart: X x1, Y x2, Total ₹Z" — customer can already see this
   - Just confirm what YOU just added: "✅ Russian Burger x2 add kar diya!"

4. When customer is done → emit @@SHOW_CART@@
   - Triggers: "bas", "theek hai", "ho gaya", "order karo", "haan", "nhi" (when cart not empty)
   - Say: "Cart ready hai! 🛒 Place Order button tap karo!"
   - Do NOT say anything about cart contents

5. LANGUAGE: Reply in ${language || 'English'}
   - Hinglish if Hindi/Hinglish selected
   - Item names always in English as-is

6. Keep replies SHORT — max 2 sentences
   - Don't list entire menu unless asked
   - Don't repeat yourself`;

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const response = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system:     systemPrompt,
        messages:   [...(history || []).slice(-8), { role: 'user', content: message }],
      });

      let reply_text = response.content.find(b => b.type === 'text')?.text || 'Let me know how I can help!';
      console.log(`🤖 AI raw: ${reply_text.substring(0, 300)}`);

      // Parse signals
      const addSignals    = [...reply_text.matchAll(/@@ADD:([^@]+)@@/g)];
      const updateSignals = [...reply_text.matchAll(/@@UPDATE:([^@]+)@@/g)];
      const removeSignals = [...reply_text.matchAll(/@@REMOVE:([^@]+)@@/g)];
      const placeMatch    = reply_text.match(/@@PLACE_ORDER:([^@]*)@@/);
      const showCartMatch = reply_text.match(/@@SHOW_CART@@/);
      const needAddress   = reply_text.includes('@@NEED_ADDRESS@@');
      const itemsAdded    = [];

      // ADD items — format: @@ADD:Name:qty@@
      const seenItems = new Set(); // prevent duplicate signals in one response
      for (const match of addSignals) {
        const parts     = match[1].split(':');
        const rawName   = parts[0].trim().toLowerCase();
        const rawNote   = parts.slice(2).join(':').trim() || null;
        // qty comes from signal format @@ADD:Name:qty@@
        // If AI omitted qty → default to 1
        let qty = parseInt(parts[1]) || 1;
        if (!parts[1]) {
          console.log(`⚠️ AI omitted qty in signal for "${rawName}" — defaulting to 1`);
        }

        if (seenItems.has(rawName)) {
          console.log(`⚠️ Duplicate @@ADD@@ signal for "${rawName}" — skipping`);
          continue;
        }
        seenItems.add(rawName);

        // ── Smart fuzzy matcher ──
        // Handles: missing spaces ("28pm"→"2"+"8pm"), abbreviations ("bp"→"blenders pride"),
        // size variants ("large"→"90ml"), brand shortcuts
        const BRAND_SHORTCUTS = {
          'bp':  'blenders pride', 'rc':  'royal challenge',
          'dsp': 'dsp black',      'jd':  'jack daniels',
          'jw':  'johnnie walker',  'ob':  'old monk',
          'mc':  'mcdowells',      'rsl': 'royal stag',
          'kf':  'kingfisher',     'bb':  'budweiser',
        };
        const SIZE_MAP = {
          'large': '90ml', 'small': '30ml', 'medium': '60ml',
          'peg': '', 'neat': '', 'shot': '30ml',
          'full': '90ml', 'half': '45ml',
        };

        function normalize(str) {
          return str.toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[^a-z0-9 ]/g, '')
            .trim();
        }

        function expandName(name) {
          // Replace shortcuts with full names
          let expanded = name;
          for (const [abbr, full] of Object.entries(BRAND_SHORTCUTS)) {
            const re = new RegExp('\\b' + abbr + '\\b', 'gi');
            expanded = expanded.replace(re, full);
          }
          // Replace size words with ml
          for (const [word, ml] of Object.entries(SIZE_MAP)) {
            const re = new RegExp('\\b' + word + '\\b', 'gi');
            if (ml) expanded = expanded.replace(re, ml);
            else expanded = expanded.replace(re, '').trim();
          }
          return normalize(expanded);
        }

        function trySmartSplit(rawName, menuItems) {
          // Case: "28pm" → try prefix digits as qty, rest as name
          // Case: "390ml" → could be qty "3" + "90ml" peg size
          const prefixMatch = rawName.match(/^(\d+)(.+)$/);
          if (prefixMatch) {
            const prefixNum  = parseInt(prefixMatch[1]);
            const remainder  = prefixMatch[2].trim();
            if (prefixNum >= 1 && prefixNum <= 20 && remainder.length >= 2) {
              const found = fuzzyFind(remainder, menuItems);
              if (found) return { found, inferredQty: prefixNum };
            }
          }
          return null;
        }

        function fuzzyFind(name, menuItems) {
          const n = normalize(name);
          const e = expandName(name);

          // 1. Exact match
          let found = menuItems.find(i => normalize(i.name) === n);
          if (found) return found;

          // 2. Expanded exact match (after shortcut expansion)
          found = menuItems.find(i => normalize(i.name) === e);
          if (found) return found;

          // 3. Menu item name starts with search term
          found = menuItems.find(i => normalize(i.name).startsWith(n))
               || menuItems.find(i => normalize(i.name).startsWith(e));
          if (found) return found;

          // 4. Search term starts with menu item name
          found = menuItems.find(i => n.startsWith(normalize(i.name)))
               || menuItems.find(i => e.startsWith(normalize(i.name)));
          if (found) return found;

          // 5. Contains match
          found = menuItems.find(i => normalize(i.name).includes(n))
               || menuItems.find(i => n.includes(normalize(i.name)))
               || menuItems.find(i => normalize(i.name).includes(e))
               || menuItems.find(i => e.includes(normalize(i.name)));
          if (found) return found;

          // 6. Word-by-word match — all significant words must appear in item name
          const words = e.split(' ').filter(w => w.length > 1);
          found = menuItems.find(i => {
            const iName = normalize(i.name);
            return words.length > 0 && words.every(w => iName.includes(w));
          });
          if (found) return found;

          // 7. Partial word match — most words match (>=60%)
          found = menuItems.find(i => {
            const iName = normalize(i.name);
            const matches = words.filter(w => iName.includes(w));
            return words.length > 0 && matches.length / words.length >= 0.6;
          });
          return found || null;
        }

        // Try normal fuzzy find first
        let found = fuzzyFind(rawName, menuItems);
        let inferredQty = qty;

        // If not found — try smart split (e.g. "28pm" → qty=2 + name="8pm")
        if (!found) {
          const split = trySmartSplit(rawName, menuItems);
          if (split) {
            found = split.found;
            inferredQty = split.inferredQty;
            console.log("Smart split: " + rawName + " -> qty=" + inferredQty + " item=" + found.name);
          }
        }

        if (!found) {
          console.log("No menu match for: " + rawName);
        }

        // Use inferred qty from smart split if applicable
        if (found && inferredQty !== qty) {
          console.log(`📊 Qty updated: signal=${qty} → smart split=${inferredQty}`);
          qty = inferredQty;
        }

        if (found) {
          // SET qty explicitly — use upsert so it doesn't double-add if item exists
          await db.query(
            `INSERT INTO cart_items
               (session_id, menu_item_id, name, price, quantity, kot_type, tax_category, subtotal, notes)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (session_id, menu_item_id)
             DO UPDATE SET quantity = $5, subtotal = $8, notes = COALESCE($9, cart_items.notes)`,
            [
              sessionId, found.id, found.name, found.price, qty,
              found.kot_type || 'kitchen',
              found.tax_category || 'food',
              found.price * qty,
              rawNote
            ]
          );
          itemsAdded.push({ id: found.id, name: found.name, price: found.price, qty });
          console.log(`🛒 AI added: ${found.name} x${qty}`);
        } else {
          console.log(`⚠️ AI tried to add "${rawName}" — no match`);
        }
      }

      // UPDATE qty (@@UPDATE:Name:new_qty@@)
      for (const match of updateSignals) {
        const parts   = match[1].split(':');
        const rawName = parts[0].trim().toLowerCase();
        const newQty  = parseInt(parts[1]) || 0;

        function normalize(s) { return (s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }
        const found = menuItems.find(i => normalize(i.name) === normalize(rawName))
                   || menuItems.find(i => normalize(i.name).includes(normalize(rawName)))
                   || menuItems.find(i => normalize(rawName).includes(normalize(i.name)));

        if (found) {
          if (newQty <= 0) {
            await db.query(
              'DELETE FROM cart_items WHERE session_id=$1 AND menu_item_id=$2',
              [sessionId, found.id]
            );
            itemsAdded.push({ id: found.id, name: found.name, price: found.price, qty: 0 });
            console.log('🗑️ AI UPDATE removed: ' + found.name);
          } else {
            await db.query(
              `INSERT INTO cart_items
                 (session_id, menu_item_id, name, price, quantity, kot_type, tax_category, subtotal, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)
               ON CONFLICT (session_id, menu_item_id)
               DO UPDATE SET quantity=$5, subtotal=$8`,
              [sessionId, found.id, found.name, found.price, newQty,
               found.kot_type||'kitchen', found.tax_category||'food', found.price*newQty]
            );
            itemsAdded.push({ id: found.id, name: found.name, price: found.price, qty: newQty });
            console.log('✏️ AI UPDATE: ' + found.name + ' → x' + newQty);
          }
        } else {
          console.log('⚠️ UPDATE signal — no menu match for: ' + rawName);
        }
      }

      // REMOVE items (legacy @@REMOVE@@)
      for (const match of removeSignals) {
        const requested = match[1].trim().toLowerCase();
        const found = menuItems.find(i => i.name.toLowerCase().includes(requested) || requested.includes(i.name.toLowerCase()));
        if (found) {
          await db.query('DELETE FROM cart_items WHERE session_id = $1 AND menu_item_id = $2', [sessionId, found.id]);
          console.log(`🗑️ AI removed: ${found.name}`);
        }
      }

      // Strip all signals from visible reply
      reply_text = reply_text
        .replace(/@@ADD:[^@]*@@/g, '')
        .replace(/@@UPDATE:[^@]*@@/g, '')
        .replace(/@@REMOVE:[^@]*@@/g, '')
        .replace(/@@PLACE_ORDER:[^@]*@@/g, '')
        .replace(/@@SHOW_CART@@/g, '')
        .replace(/@@NEED_ADDRESS@@/g, '')
        .trim();

      // PLACE ORDER
      if (placeMatch) {
        const addressFromAI = placeMatch[1].trim();
        if (addressFromAI) {
          await db.query('UPDATE sessions SET delivery_address = $1 WHERE id = $2', [addressFromAI, sessionId]);
        }
        // Refresh session with latest address
        const freshSession = await db.queryOne(
          `SELECT s.*, r.name AS restaurant_name, r.owner_phone, r.delivery_phones,
                  r.delivery_fee, r.free_delivery_above
           FROM sessions s JOIN restaurants r ON r.id = s.restaurant_id WHERE s.id = $1`,
          [sessionId]
        );
        const cart = await cartSvc.getCart(sessionId);
        if (cart.items?.length > 0) {
          return reply.send({ reply: reply_text, itemsAdded, action: 'place_order', session: freshSession });
        }
      }

      if (needAddress) {
        return reply.send({ reply: reply_text, itemsAdded, action: 'need_address' });
      }

      const action = showCartMatch ? 'show_cart' : undefined;
      return reply.send({ reply: reply_text, itemsAdded, action });
    } catch (err) {
      console.error('AI chat error:', err);
      return reply.send({ reply: 'Sorry, I had a hiccup! Try asking again.' });
    }
  });
}

	  
