require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../database/db');
const menuSvc   = require('./menu');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function processMessage(session, message) {
  const { restaurant, categories, items, blockedItems } = await menuSvc.getRestaurantData(session.restaurant_id);
  const systemPrompt = await menuSvc.buildSystemPrompt(restaurant, categories, items, blockedItems, session);

  let history = [];
  if (session.chat_history) {
    if (Array.isArray(session.chat_history)) {
      history = session.chat_history;
    } else if (typeof session.chat_history === 'string' && session.chat_history.length > 2) {
      try { history = JSON.parse(session.chat_history); } catch(e) { history = []; }
    }
  }

  const cleanHistory = history
    .filter(m => m && m.role && typeof m.content === 'string' && m.content.length > 0)
    .slice(-10);

  const messages = [...cleanHistory, { role: 'user', content: message }];

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 512,
    system:     systemPrompt,
    messages,
    // ── NO TOOLS ── AI is conversation-only. Cart is handled by worker code.
  });

  const finalReply = response.content.find(b => b.type === 'text')?.text || '';

  // Save clean text history
  const newHistory = [
    ...cleanHistory,
    { role: 'user',      content: message    },
    { role: 'assistant', content: finalReply },
  ];

  await db.query(
    'UPDATE sessions SET chat_history = $1, updated_at = NOW() WHERE id = $2',
    [JSON.stringify(newHistory), session.id]
  );

  return { reply: finalReply, cartModified: false };
}

module.exports = { processMessage };
