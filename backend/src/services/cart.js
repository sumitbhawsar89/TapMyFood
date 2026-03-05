const db = require('../database/db');

// ─────────────────────────────────────────────
// Add item to cart
// ─────────────────────────────────────────────
async function addToCart(sessionId, restaurantId, itemId, quantity = 1, notes = null) {
  // Validate item belongs to this restaurant
  const item = await db.queryOne(
    'SELECT * FROM menu_items WHERE id = $1 AND restaurant_id = $2 AND is_available = true',
    [itemId, restaurantId]
  );

  if (!item) return { success: false, error: `Sorry, that item is not available. Please choose from our menu.` };

  // Check if already in cart — update quantity
  const existing = await db.queryOne(
    'SELECT * FROM cart_items WHERE session_id = $1 AND menu_item_id = $2',
    [sessionId, itemId]
  );

  if (existing) {
    const newQty = existing.quantity + quantity;
    await db.query(
      'UPDATE cart_items SET quantity = $1, subtotal = $2 WHERE id = $3',
      [newQty, item.price * newQty, existing.id]
    );
  } else {
    await db.query(
      `INSERT INTO cart_items
        (session_id, menu_item_id, name, price, quantity, subtotal, kot_type, tax_category, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [sessionId, itemId, item.name, item.price, quantity,
       item.price * quantity, item.kot_type, item.tax_category, notes]
    );
  }

  return { success: true, item: { name: item.name, price: item.price, quantity } };
}

// ─────────────────────────────────────────────
// Remove item from cart
// ─────────────────────────────────────────────
async function removeFromCart(sessionId, itemId) {
  const result = await db.query(
    'DELETE FROM cart_items WHERE session_id = $1 AND menu_item_id = $2',
    [sessionId, itemId]
  );
  return { success: result.rowCount > 0, error: result.rowCount === 0 ? 'Item not in cart' : null };
}

// ─────────────────────────────────────────────
// Get cart contents
// ─────────────────────────────────────────────
async function getCart(sessionId) {
  const items = await db.queryAll(
    'SELECT * FROM cart_items WHERE session_id = $1 ORDER BY added_at',
    [sessionId]
  );
  const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
  return { items, subtotal, count: items.length };
}

// ─────────────────────────────────────────────
// Format cart as readable text for AI
// ─────────────────────────────────────────────
function formatCartForAI(cart) {
  if (cart.items.length === 0) return 'Cart is empty.';
  let text = '🛒 Your current order:\n';
  for (const item of cart.items) {
    text += `  • ${item.name} ×${item.quantity} — ₹${item.subtotal}\n`;
    if (item.notes) text += `    Note: ${item.notes}\n`;
  }
  text += `\nSubtotal: ₹${cart.subtotal}`;
  return text;
}

// ─────────────────────────────────────────────
// Clear cart
// ─────────────────────────────────────────────
async function clearCart(sessionId) {
  await db.query('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);
}

module.exports = { addToCart, removeFromCart, getCart, formatCartForAI, clearCart };

