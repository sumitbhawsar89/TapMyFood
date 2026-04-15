require('dotenv').config({ path: '/home/ubuntu/restaurant-ai/backend/.env' });
const db = require('../src/database/db');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANGUAGES = [
  // English first — original, stored as-is
  { code: 'en',      name: 'English (original — unchanged)' },
  // Indian languages
  { code: 'hi',      name: 'Hindi (Devanagari script)' },
  { code: 'mr',      name: 'Marathi (Devanagari script)' },
  { code: 'hi_LATN', name: 'Hinglish (Hindi in Roman/English script, casual tone)' },
  { code: 'ta',      name: 'Tamil (Tamil script)' },
  { code: 'te',      name: 'Telugu (Telugu script)' },
  { code: 'gu',      name: 'Gujarati (Gujarati script)' },
  { code: 'ml',      name: 'Malayalam (Malayalam script)' },
  { code: 'kn',      name: 'Kannada (Kannada script)' },
  // International
  { code: 'ru',      name: 'Russian (Cyrillic script)' },
  { code: 'zh',      name: 'Chinese Simplified' },
  { code: 'de',      name: 'German' },
  { code: 'fr',      name: 'French' },
  { code: 'es',      name: 'Spanish' },
];

async function translateItem(item) {
  const prompt = `You are a restaurant menu translator. Translate the following menu item into multiple languages.

Item Name: "${item.name}"
Item Description: "${item.description || ''}"

IMPORTANT RULES:
- For "en": return the ORIGINAL name and description UNCHANGED — do not translate
- For item NAMES in all other languages: use transliteration (how it sounds), NOT literal meaning
  Example: "Paneer Burger" in Gujarati → "પનીર બર્ગર" (sounds like it, NOT "ચીઝ બ્રેડ")
  Example: "Paneer Burger" in German/French/Spanish → "Paneer Burger" (food names stay)
- For DESCRIPTIONS in all other languages: full natural translation conveying meaning
- For "hi_LATN" (Hinglish): Hindi words in Roman script, casual Indian tone
  Example: "Dahi mein marinate kiya hua paneer, tandoor mein grilled"
- Food brand names (Smirnoff, Kingfisher, Coca-Cola) stay as-is in ALL languages
- If description is empty, return empty string for description
- Return ONLY valid JSON, no other text, no markdown

Return this exact JSON structure:
{
  "en":      { "name": "...", "description": "..." },
  "hi":      { "name": "...", "description": "..." },
  "mr":      { "name": "...", "description": "..." },
  "hi_LATN": { "name": "...", "description": "..." },
  "ta":      { "name": "...", "description": "..." },
  "te":      { "name": "...", "description": "..." },
  "gu":      { "name": "...", "description": "..." },
  "ml":      { "name": "...", "description": "..." },
  "kn":      { "name": "...", "description": "..." },
  "ru":      { "name": "...", "description": "..." },
  "zh":      { "name": "...", "description": "..." },
  "de":      { "name": "...", "description": "..." },
  "fr":      { "name": "...", "description": "..." },
  "es":      { "name": "...", "description": "..." }
}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function run() {
  const { rows: items } = await db.query(`
    SELECT id, name, description
    FROM menu_items
    WHERE is_available = true
    ORDER BY name
  `);

  console.log(`\nFound ${items.length} items to translate`);
  console.log(`Languages: English, Hindi, Marathi, Hinglish, Tamil, Telugu, Gujarati, Malayalam, Kannada, Russian, Chinese, German, French, Spanish\n`);
  console.log(`Total rows to create: ${items.length} items × 14 languages × 2 fields = ${items.length * 14 * 2} rows\n`);

  let success = 0;
  let failed = 0;
  const failedItems = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      process.stdout.write(`[${i+1}/${items.length}] ${item.name} ... `);

      const translations = await translateItem(item);

      for (const [langCode, content] of Object.entries(translations)) {
        if (content.name) {
          await db.query(`
            INSERT INTO menu_translations
              (item_id, language_code, field, translated_text, is_verified)
            VALUES ($1, $2, 'name', $3, false)
            ON CONFLICT (item_id, language_code, field)
            DO UPDATE SET translated_text = $3, is_verified = false
          `, [item.id, langCode, content.name]);
        }
        if (content.description) {
          await db.query(`
            INSERT INTO menu_translations
              (item_id, language_code, field, translated_text, is_verified)
            VALUES ($1, $2, 'description', $3, false)
            ON CONFLICT (item_id, language_code, field)
            DO UPDATE SET translated_text = $3, is_verified = false
          `, [item.id, langCode, content.description]);
        }
      }

      console.log(`✅`);
      success++;
      await new Promise(r => setTimeout(r, 600));

    } catch (err) {
      console.log(`❌ ${err.message}`);
      failed++;
      failedItems.push(item.name);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`✅ Translated: ${success}`);
  console.log(`❌ Failed:     ${failed}`);
  if (failedItems.length > 0) {
    console.log(`Failed items: ${failedItems.join(', ')}`);
  }

  const { rows: summary } = await db.query(`
    SELECT language_code, COUNT(*) FILTER (WHERE field='name') as names,
           COUNT(*) FILTER (WHERE field='description') as descriptions
    FROM menu_translations
    GROUP BY language_code
    ORDER BY language_code
  `);

  console.log('\nTranslation summary:');
  console.table(summary);
  process.exit(0);
}

run().catch(e => { console.error('❌', e.message); process.exit(1); });

