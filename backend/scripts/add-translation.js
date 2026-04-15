#!/usr/bin/env node
// ══════════════════════════════════════════════
// TapMyFood — Add Translation Utility
// Usage: node scripts/add-translation.js "key_name" "English text"
// Example: node scripts/add-translation.js "bill_requested" "Bill requested. Waiter is coming."
// ══════════════════════════════════════════════
require('dotenv').config({ path: '/home/ubuntu/restaurant-ai/backend/.env' });
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const I18N_PATH = '/home/ubuntu/restaurant-ai/backend/public/i18n.js';
// Also update the embedded version in order-ui.html
const HTML_PATH = '/home/ubuntu/restaurant-ai/backend/public/order-ui.html';

async function addTranslation(key, englishText) {
  if (!key || !englishText) {
    console.error('Usage: node add-translation.js "key_name" "English text"');
    process.exit(1);
  }

  console.log(`\nTranslating: "${englishText}"`);
  console.log(`Key: ${key}\n`);

  const prompt = `Translate this UI string for a restaurant ordering app into 13 languages.

Text: "${englishText}"

RULES:
- Short, natural tone — this is a button/toast/label on a mobile app
- Not too formal, not too casual
- Keep emojis if present in original
- Return ONLY valid JSON

{
  "hi":      "...",
  "mr":      "...",
  "hi_LATN": "...",
  "ta":      "...",
  "te":      "...",
  "gu":      "...",
  "ml":      "...",
  "kn":      "...",
  "ru":      "...",
  "zh":      "...",
  "de":      "...",
  "fr":      "...",
  "es":      "..."
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim().replace(/```json|```/g, '').trim();
  const translations = JSON.parse(text);

  // Show what was generated
  console.log('Generated translations:');
  console.log(`  en: "${englishText}"`);
  Object.entries(translations).forEach(([lang, val]) => {
    console.log(`  ${lang}: "${val}"`);
  });

  // Build the new key block to append to each language
  const allLangs = { en: englishText, ...translations };

  // Read current i18n content from HTML
  let html = fs.readFileSync(HTML_PATH, 'utf8');

  // Add key to each language block
  let updated = 0;
  for (const [lang, val] of Object.entries(allLangs)) {
    const escapedVal = val.replace(/'/g, "\\'");

    // Find popular_add line for this language and insert after
    let marker;
    if (lang === 'en') {
      // en is inside the main I18N object
      marker = "    popular_add:     '+ Add',";
    } else {
      // Other languages use I18N['xx'] = { ... }
      // Find the closing }; of this language block
      const blockStart = html.indexOf(`I18N['${lang}'] = {`);
      if (blockStart === -1) continue;
      const blockEnd = html.indexOf('};', blockStart);
      if (blockEnd === -1) continue;

      // Insert before closing };
      const insertStr = `  ${key}: '${escapedVal}',\n`;
      html = html.slice(0, blockEnd) + insertStr + html.slice(blockEnd);
      updated++;
      continue;
    }

    // For English — insert after popular_add line
    if (html.includes(marker)) {
      html = html.replace(marker, `${marker}\n    ${key}: '${escapedVal}',`);
      updated++;
    }
  }

  // Save updated HTML
  fs.writeFileSync(HTML_PATH, html);
  console.log(`\n✅ Added "${key}" to ${updated} language blocks in order-ui.html`);
  console.log(`\nNow use in your code:`);
  console.log(`  t('${key}')`);
  console.log(`\nRemember to restart: pm2 restart restaurant-api`);
}

const [,, key, text] = process.argv;
addTranslation(key, text).catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});

