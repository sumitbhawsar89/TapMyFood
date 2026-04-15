// ══════════════════════════════════════════════════════════════════
// OrderBuddy — Menu Descriptor Bot
// Phase 1: Menu browsing + item description ONLY
// NO ordering, NO cart, NO payment, NO AI at runtime
// All data served from DB — zero hallucination possible
// Blueprint ref: Section 7.8 — Menu Assistant Bot
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const { Worker }          = require('bullmq');
const db                  = require('../database/db');
const whatsapp            = require('../services/whatsapp');
const { redisConnection } = require('./setup');

// ── In-memory map: phone → { categoryMap, itemMap } ──────────────
// Stores number → category/item mappings per user session
// Cleared when user starts fresh
const userMenuState = new Map();

// ── Synonym normalisation ─────────────────────────────────────────
const SYNONYM_MAP = {
  'cold drink':   'beverages', 'cold drinks':  'beverages',
  'soft drink':   'beverages', 'soft drinks':  'beverages',
  'aerated':      'beverages', 'fizzy':        'beverages',
  'drinks':       'beverages', 'drink':        'beverages',
  'starter':      'starter',   'starters':     'starter',
  'appetizer':    'starter',   'snack':        'starter',
  'snacks':       'starter',   'appetisers':   'starter',
  'main':         'main course','mains':       'main course',
  'main course':  'main course','main courses':'main course',
  'dessert':      'dessert',   'desserts':     'dessert',
  'sweet':        'dessert',   'sweets':       'dessert',
  'mithai':       'dessert',
};

function normalise(text) {
  const t = text.toLowerCase().trim();
  return SYNONYM_MAP[t] || t;
}

// ── Spice emoji helper ────────────────────────────────────────────
function spiceEmoji(level) {
  if (!level || level === 'none') return '';
  if (level === 'mild')   return '🌶 Mild';
  if (level === 'medium') return '🌶🌶 Medium';
  if (level === 'spicy')  return '🌶🌶🌶 Spicy';
  return level;
}

// ── Veg indicator ─────────────────────────────────────────────────
function vegTag(item) {
  if (item.is_veg === true  || item.veg_flag === true)  return '🟢 Veg';
  if (item.is_veg === false || item.veg_flag === false) return '🔴 Non-veg';
  return '';
}

// ── Format item description for WhatsApp ─────────────────────────
function formatItemDetail(item) {
  const lines = [];
  lines.push(`*${item.name}* — ₹${item.price}`);
  const veg   = vegTag(item);
  const spice = spiceEmoji(item.spice_level);
  if (veg || spice) lines.push([veg, spice].filter(Boolean).join('  '));
  if (item.description) lines.push(`\n_${item.description}_`);
  if (item.ingredients) lines.push(`\n🥘 *Ingredients:* ${item.ingredients}`);
  if (item.allergens && item.allergens.length)
    lines.push(`⚠️ *Contains:* ${item.allergens.join(', ')}`);
  if (!item.restaurant_verified && item.system_generated)
    lines.push(`\n_ℹ️ Description is AI-generated and pending restaurant review._`);
  return lines.join('\n');
}

// ── Send welcome + category menu ─────────────────────────────────
async function sendCategoryMenu(from, restaurant, categories) {
  // Store number→category map for this user
  const catMap = {};
  let menuText = `👋 Welcome to *${restaurant.name}*!\n\nHere's our menu:\n\n`;
  categories.forEach((cat, idx) => {
    const num = idx + 1;
    catMap[String(num)] = cat;
    catMap[cat.name.toLowerCase()] = cat;
    menuText += `${num}. ${cat.name}\n`;
  });
  menuText += `\nType a number or category name to explore.\n`;
  menuText += `Ask me about any dish — spice level, ingredients, veg/non-veg! 🍽️`;
  userMenuState.set(from, { catMap, itemMap: null, restaurantId: restaurant.id });
  await whatsapp.sendMessage(from, menuText);
}

// ── Send items in a category ──────────────────────────────────────
async function sendCategoryItems(from, category, items) {
  const itemMap = {};
  let text = `*${category.name.toUpperCase()}*\n\n`;
  items.forEach((item, idx) => {
    const num = idx + 1;
    itemMap[String(num)] = item;
    itemMap[item.name.toLowerCase()] = item;
    const veg   = vegTag(item);
    const spice = spiceEmoji(item.spice_level);
    const tags  = [veg, spice].filter(Boolean).join(' ');
    text += `${num}. *${item.name}* — ₹${item.price}`;
    if (tags) text += `  ${tags}`;
    text += `\n`;
  });
  text += `\nType a number or item name to learn more.\nType *menu* to go back to categories.`;

  // Update item map, keep cat map
  const state = userMenuState.get(from) || {};
  userMenuState.set(from, { ...state, itemMap, currentCategory: category });
  await whatsapp.sendMessage(from, text);
}

// ── Resolve item query — fuzzy match ─────────────────────────────
async function findItem(query, restaurantId) {
  const q = normalise(query);
  // Exact name match first
  let item = await db.queryOne(
    `SELECT * FROM menu_items
     WHERE restaurant_id = $1
       AND is_available = true
       AND LOWER(name) = $2
     LIMIT 1`,
    [restaurantId, q]
  );
  if (item) return item;
  // ILIKE partial match
  item = await db.queryOne(
    `SELECT * FROM menu_items
     WHERE restaurant_id = $1
       AND is_available = true
       AND LOWER(name) ILIKE $2
     LIMIT 1`,
    [restaurantId, `%${q}%`]
  );
  return item || null;
}

// ── Detect question type from message ────────────────────────────
function detectQuestionType(msg) {
  const m = msg.toLowerCase();
  if (/\b(spic|hot|mild|spice|spicy|spiciness|kitna spicy|how spicy)\b/.test(m)) return 'spice';
  if (/\b(veg|non.?veg|vegetarian|meat|chicken|paneer|jain|vegan)\b/.test(m))    return 'diet';
  if (/\b(ingredient|contain|made of|kya hai|what.?is|describe|bata)\b/.test(m)) return 'describe';
  if (/\b(allergen|allerg|nut|gluten|dairy|lactose)\b/.test(m))                  return 'allergen';
  if (/\b(price|cost|kitna|how much|rate|₹|rs\.?)\b/.test(m))                   return 'price';
  if (/\b(calorie|kcal|healthy|calories|weight)\b/.test(m))                     return 'calories';
  return 'describe'; // default
}

// ── Build answer for a specific question type ────────────────────
function buildAnswer(item, qtype) {
  switch (qtype) {
    case 'spice': {
      const s = item.spice_level;
      if (!s || s === 'none') return `*${item.name}* is not spicy at all 😊`;
      return `${spiceEmoji(s)}\n*${item.name}* is ${s}.`;
    }
    case 'diet': {
      const v = vegTag(item);
      return `${v}\n*${item.name}* is ${item.is_veg || item.veg_flag ? 'vegetarian 🟢' : 'non-vegetarian 🔴'}.`;
    }
    case 'allergen': {
      if (!item.allergens || !item.allergens.length)
        return `No allergen information available for *${item.name}*. Please check with the restaurant.`;
      return `⚠️ *${item.name}* contains: ${item.allergens.join(', ')}`;
    }
    case 'price':
      return `*${item.name}* is priced at *₹${item.price}*.`;
    case 'calories':
      if (!item.calories)
        return `Calorie information is not available for *${item.name}*.`;
      return `*${item.name}* has *${item.calories} kcal*.`;
    default:
      return formatItemDetail(item);
  }
}

// ── Out-of-scope reply ────────────────────────────────────────────
function outOfScopeReply(type) {
  const replies = {
    order:   `I can help with menu questions only 🙏\nTo place an order, please ask our staff or visit the counter.`,
    cart:    `I can help with menu questions only 🙏\nTo place an order, please ask our staff or visit the counter.`,
    payment: `I can help with menu questions only 🙏\nFor billing, please ask our staff.`,
    general: `I can only help with questions about our menu items 🙏\nAsk me about any dish — spice, ingredients, price!`,
  };
  return replies[type] || replies.general;
}

function detectOutOfScope(msg) {
  const m = msg.toLowerCase();
  if (/\b(add|cart|order|place order|confirm|checkout|buy)\b/.test(m)) return 'order';
  if (/\b(pay|payment|bill|upi|razorpay|cash)\b/.test(m))             return 'payment';
  return null;
}

// ── Show veg-only or non-veg filter ──────────────────────────────
async function sendFilteredItems(from, restaurantId, isVeg) {
  const items = await db.queryAll(
    `SELECT mi.*, mc.name AS category_name
     FROM menu_items mi
     JOIN menu_categories mc ON mc.id = mi.category_id
     WHERE mi.restaurant_id = $1
       AND mi.is_available  = true
       AND (mi.is_veg = $2 OR mi.veg_flag = $2)
     ORDER BY mc.sort_order, mi.sort_order
     LIMIT 20`,
    [restaurantId, isVeg]
  );
  if (!items.length) {
    return await whatsapp.sendMessage(from,
      isVeg ? 'No veg items found on the menu.' : 'No non-veg items found on the menu.'
    );
  }
  const label = isVeg ? '🟢 Veg Items' : '🔴 Non-Veg Items';
  let text = `*${label}*\n\n`;
  items.forEach(item => {
    text += `• *${item.name}* — ₹${item.price}`;
    const spice = spiceEmoji(item.spice_level);
    if (spice) text += `  ${spice}`;
    text += `\n`;
  });
  text += `\nAsk me about any item for more details!`;
  await whatsapp.sendMessage(from, text);
}

// ════════════════════════════════════════════════════════════════════
// MAIN WORKER
// ════════════════════════════════════════════════════════════════════
console.log('🚀 Menu Descriptor Bot started — waiting for messages...');

const messageWorker = new Worker('whatsapp-messages', async (job) => {

  const { from, message, restaurantId, isButtonReply, buttonId, timestamp } = job.data;
  console.log(`📨 [DESCRIPTOR] from ${from}: "${message}"`);

  // ── 1. Load restaurant ──
  const restaurant = await db.queryOne(
    'SELECT * FROM restaurants WHERE id = $1 AND is_active = true',
    [restaurantId]
  );
  if (!restaurant) {
    console.error(`❌ Restaurant not found: ${restaurantId}`);
    return;
  }

  // ── 2. Check open/close hours ──
  if (restaurant.open_time && restaurant.close_time) {
    const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const [oH, oM] = restaurant.open_time.split(':').map(Number);
    const [cH, cM] = restaurant.close_time.split(':').map(Number);
    const nowM  = now.getHours() * 60 + now.getMinutes();
    const openM = oH * 60 + oM;
    const clsM  = cH * 60 + cM;
    if (nowM < openM || nowM >= clsM) {
      const fmt = t => t.replace(/^(\d):/, '0$1:');
      await whatsapp.sendMessage(from,
        `🕐 *We're currently closed!*\n\n` +
        `${restaurant.name} is open from *${fmt(restaurant.open_time)}* ` +
        `to *${fmt(restaurant.close_time)}* (IST).\n\n` +
        `Message us during opening hours — we'd love to help! 🙏`
      );
      return;
    }
  }

  // ── 3. Handle owner commands (start with !) ──
  if (restaurant.owner_phone === from && message.startsWith('!')) {
    // Pass-through to owner command handler (delivery boy claims etc.)
    // For now just acknowledge — owner commands not changed
    await whatsapp.sendMessage(from, `Owner commands coming soon. Use the dashboard for now.`);
    return;
  }

  // ── 4. Handle delivery boy commands ──
  const claimSrc = (buttonId || message || '').toUpperCase().trim();
  if (claimSrc.startsWith('CLAIM-') || claimSrc.startsWith('DELIVERED-')) {
    // Keep existing delivery boy flow untouched
    const deliverySvc = require('../services/delivery');
    if (claimSrc.startsWith('CLAIM-'))
      await deliverySvc.handleClaim(from, claimSrc.substring(6), restaurantId);
    else
      await deliverySvc.handleDelivered(from, claimSrc.substring(10), restaurantId);
    return;
  }

  const msg   = message.trim();
  const lower = msg.toLowerCase().trim();
  const state = userMenuState.get(from);

  // ── 5. Detect and reject out-of-scope requests ──
  const oos = detectOutOfScope(lower);
  if (oos) {
    await whatsapp.sendMessage(from, outOfScopeReply(oos));
    return;
  }

  // ── 6. Greetings / hi / hello → show menu ──
  const greetings = ['hi', 'hello', 'hey', 'hii', 'helo', 'namaste', 'namaskar',
                     'start', 'menu', 'help', 'kya hai', 'show menu', 'menu dikhao'];
  if (greetings.includes(lower) || !state) {
    const categories = await db.queryAll(
      `SELECT * FROM menu_categories
       WHERE restaurant_id = $1 AND is_active = true
       ORDER BY sort_order`,
      [restaurantId]
    );
    if (!categories.length) {
      await whatsapp.sendMessage(from, `👋 Welcome to *${restaurant.name}*! Our menu is being updated. Please check back soon.`);
      return;
    }
    await sendCategoryMenu(from, restaurant, categories);
    return;
  }

  // ── 7. Veg / non-veg filter ──
  if (/\b(only veg|show veg|veg items|veg only|pure veg|veg menu)\b/.test(lower)) {
    await sendFilteredItems(from, restaurantId, true);
    return;
  }
  if (/\b(non.?veg|nonveg|non veg items|show non.?veg)\b/.test(lower)) {
    await sendFilteredItems(from, restaurantId, false);
    return;
  }

  // ── 8. Category number tap (e.g. "1", "2") ──
  if (state?.catMap && /^\d+$/.test(lower)) {
    const cat = state.catMap[lower];
    if (cat) {
      const items = await db.queryAll(
        `SELECT * FROM menu_items
         WHERE restaurant_id = $1 AND category_id = $2 AND is_available = true
         ORDER BY sort_order`,
        [restaurantId, cat.id]
      );
      if (!items.length) {
        await whatsapp.sendMessage(from, `No items available in *${cat.name}* right now.`);
        return;
      }
      await sendCategoryItems(from, cat, items);
      return;
    }
  }

  // ── 9. Item number tap (e.g. "2" after seeing category items) ──
  if (state?.itemMap && /^\d+$/.test(lower)) {
    const item = state.itemMap[lower];
    if (item) {
      await whatsapp.sendMessage(from, formatItemDetail(item));
      await new Promise(r => setTimeout(r, 400));
      await whatsapp.sendMessage(from,
        `Ask me anything about *${item.name}* — spice level, ingredients, allergens!\n\nType *menu* to go back.`
      );
      return;
    }
  }

  // ── 10. Category name match ──
  if (state?.catMap) {
    const normQ = normalise(lower);
    const catMatch = state.catMap[normQ] ||
      Object.values(state.catMap).find(c =>
        typeof c === 'object' && c.name && c.name.toLowerCase().includes(normQ)
      );
    if (catMatch && typeof catMatch === 'object') {
      const items = await db.queryAll(
        `SELECT * FROM menu_items
         WHERE restaurant_id = $1 AND category_id = $2 AND is_available = true
         ORDER BY sort_order`,
        [restaurantId, catMatch.id]
      );
      if (!items.length) {
        await whatsapp.sendMessage(from, `No items available in *${catMatch.name}* right now.`);
        return;
      }
      await sendCategoryItems(from, catMatch, items);
      return;
    }
  }

  // ── 11. Direct item question — "is chicken tikka spicy?" ──
  // Extract item name from question then look up from DB
  const qtype = detectQuestionType(lower);

  // First try: match against item map if user is viewing a category
  if (state?.itemMap) {
    const itemMatch = Object.values(state.itemMap).find(i =>
      typeof i === 'object' && i.name && lower.includes(i.name.toLowerCase())
    );
    if (itemMatch) {
      await whatsapp.sendMessage(from, buildAnswer(itemMatch, qtype));
      return;
    }
  }

  // Second try: search DB by name in message
  const item = await findItem(lower, restaurantId);
  if (item) {
    await whatsapp.sendMessage(from, buildAnswer(item, qtype));
    await new Promise(r => setTimeout(r, 300));
    // Offer more details
    await whatsapp.sendMessage(from,
      `Type *menu* to browse all categories, or ask me anything else about our dishes! 🍽️`
    );
    return;
  }

  // ── 12. "Show all items" / "full menu" ──
  if (/\b(all items|full menu|complete menu|sab kuch|sabhi)\b/.test(lower)) {
    const categories = await db.queryAll(
      `SELECT * FROM menu_categories WHERE restaurant_id = $1 AND is_active = true ORDER BY sort_order`,
      [restaurantId]
    );
    await sendCategoryMenu(from, restaurant, categories);
    return;
  }

  // ── 13. Unknown / not found ──
  await whatsapp.sendMessage(from,
    `Sorry, I couldn't find that on our menu 🙏\n\n` +
    `Try:\n` +
    `• Type *menu* to see all categories\n` +
    `• Type an item name to learn about it\n` +
    `• Ask: _"Is paneer tikka spicy?"_ or _"Show veg items"_`
  );

}, { connection: redisConnection, concurrency: 5 });

// ── NOTIFICATION WORKER — unchanged ──────────────────────────────
const { Worker: W2 } = require('bullmq');
const notificationWorker = new W2('whatsapp-notifications', async (job) => {
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
