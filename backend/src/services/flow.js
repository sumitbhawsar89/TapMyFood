// ══════════════════════════════════════════════════════════
// OrderBuddy — Strict Flow Controller
// State machine: each state accepts ONLY valid inputs
// Any off-flow text → pushed back to correct step
// ══════════════════════════════════════════════════════════

const db       = require('../database/db');
const cartSvc  = require('./cart');
const whatsapp = require('./whatsapp');

// ── State definitions ──
const STATES = {
  BROWSING:              'active',          // showing menu, waiting for order
  CART_ACTIVE:           'cart_active',     // has items, show add/place/cancel
  AWAITING_ADDRESS:      'awaiting_address',
  AWAITING_CONFIRMATION: 'awaiting_confirmation',
  ORDERED:               'ordered',
};

// ── Set session state ──
async function setState(sessionId, state) {
  await db.query(
    'UPDATE sessions SET status = $1, updated_at = NOW() WHERE id = $2',
    [state, sessionId]
  );
}

// ── Show cart buttons ──
async function showCartButtons(from, session) {
  const cart = await cartSvc.getCart(session.id);
  if (cart.items.length === 0) {
    await setState(session.id, STATES.BROWSING);
    return;
  }
  await setState(session.id, STATES.CART_ACTIVE);
  await whatsapp.sendInteractiveButtons(from,
    `🛒 *Cart:* ${cart.items.length} item(s) — ₹${cart.subtotal}`,
    [
      { id: 'add_more',      title: '➕ Add More'   },
      { id: 'confirm_order', title: '✅ Place Order' },
      { id: 'cancel_order',  title: '❌ Cancel'      },
    ]
  );
}

// ── Guard: in cart_active state, reject off-flow text ──
// Returns true if message was handled (blocked), false if should proceed
async function guardCartActive(session, from, message, buttonId) {
  if (session.status !== STATES.CART_ACTIVE) return false;
  if (buttonId) return false; // buttons always allowed

  // Natural language that's clearly order-related — allow through
  const msg = message.toLowerCase().trim();
  const orderRelated = [
    'place order', 'confirm', 'order kar', 'haan', 'ha ', 'yes',
    'cancel', 'add more', 'remove', 'hatao', 'clear',
    'menu', 'offer', 'bas', 'done', 'thats all',
  ];
  if (orderRelated.some(w => msg.includes(w) || msg === w)) return false;

  // Off-flow text in cart_active — nudge back
  const cart = await cartSvc.getCart(session.id);
  let cartSummary = '';
  for (const item of cart.items) {
    cartSummary += `• ${item.name} x${item.quantity} — ₹${item.subtotal}\n`;
    if (item.notes) cartSummary += `  📝 _${item.notes}_\n`;
  }

  await whatsapp.sendMessage(from,
    `👇 You have items in your cart! Please use the buttons to continue.\n\n${cartSummary}`
  );
  await whatsapp.sendInteractiveButtons(from,
    `🛒 *Cart:* ${cart.items.length} item(s) — ₹${cart.subtotal}`,
    [
      { id: 'add_more',      title: '➕ Add More'   },
      { id: 'confirm_order', title: '✅ Place Order' },
      { id: 'cancel_order',  title: '❌ Cancel'      },
    ]
  );
  return true; // handled — stop further processing
}

// ── Guard: in awaiting_address, reject non-address input ──
async function guardAwaitingAddress(session, from, message, buttonId, isLocation) {
  if (session.status !== STATES.AWAITING_ADDRESS) return false;
  if (buttonId) return false;
  if (isLocation) return false;

  const msg = message.toLowerCase().trim();
  // Minimum address-like: 10+ chars or contains numbers/locality keywords
  const looksLikeAddress = message.length >= 8 ||
    /\d/.test(message) ||
    ['flat', 'house', 'road', 'nagar', 'society', 'plot', 'sector', 'lane', 'street'].some(w => msg.includes(w));

  if (looksLikeAddress) return false;

  // Too short / gibberish — ask again
  await whatsapp.sendMessage(from,
    `📍 Please share your *delivery address* so we can deliver to you.\n\nYou can:\n• Type your full address\n• Or tap 📎 → Location → Send Current Location`
  );
  return true;
}

// ── Guard: in awaiting_confirmation, only accept confirm/cancel ──
async function guardAwaitingConfirmation(session, from, message, buttonId) {
  if (session.status !== STATES.AWAITING_CONFIRMATION) return false;
  if (buttonId) return false;

  const msg = message.toLowerCase().trim();
  const confirmWords = ['yes', 'haan', 'ha', 'ok', 'confirm', 'place', 'karo', 'bilkul', 'done'];
  const cancelWords  = ['no', 'nahi', 'cancel', 'nope', 'mat karo', 'band karo'];

  if (confirmWords.some(w => msg.includes(w))) return false; // let it through to confirm handler
  if (cancelWords.some(w => msg.includes(w)))  return false; // let it through to cancel handler

  // Any other input — re-show confirmation
  const cart = await cartSvc.getCart(session.id);
  let summary = '';
  for (const item of cart.items) {
    summary += `• ${item.name} x${item.quantity} — ₹${item.subtotal}\n`;
    if (item.notes) summary += `  📝 _${item.notes}_\n`;
  }

  await whatsapp.sendMessage(from,
    `👇 Your order is waiting for confirmation!\n\n${summary}\nTap *Confirm* to place or *Cancel* to clear.`
  );
  await whatsapp.sendInteractiveButtons(from,
    `🛒 Total: ₹${cart.subtotal} — Confirm order?`,
    [
      { id: 'confirm_order', title: '✅ Confirm Order' },
      { id: 'cancel_order',  title: '❌ Cancel'         },
    ]
  );
  return true;
}

// ── Guard: in browsing state after welcome, typed random text ──
// Food/order related → pass to AI
// Completely off-topic → nudge back to buttons
async function guardBrowsing(session, from, message, buttonId) {
  // Only applies right after welcome (isNewSession was just shown)
  // Check if session has no cart items AND status is 'active'
  if (session.status !== STATES.BROWSING) return false;
  if (buttonId) return false; // buttons always pass

  const msg = message.toLowerCase().trim();

  // Always allow food/order related text
  const foodRelated = [
    // ordering intent
    'menu', 'order', 'burger', 'pizza', 'fries', 'chicken', 'veg', 'paneer',
    'what', 'show', 'dikhao', 'kya', 'hai', 'price', 'rate', 'kitna',
    'offer', 'discount', 'deal', 'combo', 'special', 'today',
    // item names (generic)
    'rice', 'noodle', 'pasta', 'sandwich', 'wrap', 'roll', 'salad',
    'drink', 'juice', 'coffee', 'tea', 'water', 'cold',
    // hindi/hinglish ordering
    'chahiye', 'dena', 'do', 'lena', 'khana', 'peena', 'milega',
    'ek', 'do', 'teen', 'ek plate', 'order karna',
    // acknowledgements
    'hi', 'hello', 'hii', 'helo', 'hey', 'ok', 'okay', 'haan', 'ha', 'yes',
    // numbers (likely ordering qty)
    '1', '2', '3', '4', '5',
  ];

  if (foodRelated.some(w => msg.includes(w) || msg === w)) return false;

  // Looks like off-topic text — nudge back
  await whatsapp.sendMessage(from,
    `👋 I'm your food ordering assistant!

Use the buttons below to get started, or just tell me what you'd like to eat 🍔`
  );
  await new Promise(r => setTimeout(r, 400));
  await whatsapp.sendInteractiveButtons(from,
    '👇 What would you like?',
    [
      { id: 'show_menu',   title: '📋 View Menu'      },
      { id: 'view_offers', title: '🎉 Today\'s Offers' },
    ]
  );
  return true;
}

module.exports = { STATES, setState, showCartButtons, guardBrowsing, guardCartActive, guardAwaitingAddress, guardAwaitingConfirmation };

