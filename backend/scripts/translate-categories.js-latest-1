require('dotenv').config({ path: '/home/ubuntu/restaurant-ai/backend/.env' });
const db = require('../src/database/db');
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANGUAGES = [
  { code: 'hi',      name: 'Hindi (Devanagari script)' },
  { code: 'mr',      name: 'Marathi (Devanagari script)' },
  { code: 'hi_LATN', name: 'Hinglish (Hindi in Roman script, casual)' },
  { code: 'ta',      name: 'Tamil (Tamil script)' },
  { code: 'te',      name: 'Telugu (Telugu script)' },
  { code: 'gu',      name: 'Gujarati (Gujarati script)' },
  { code: 'ml',      name: 'Malayalam (Malayalam script)' },
  { code: 'kn',      name: 'Kannada (Kannada script)' },
  { code: 'ru',      name: 'Russian (Cyrillic script)' },
  { code: 'zh',      name: 'Chinese Simplified' },
  { code: 'de',      name: 'German' },
  { code: 'fr',      name: 'French' },
  { code: 'es',      name: 'Spanish' },
];

async function createTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS category_translations (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      category_id   UUID NOT NULL,
      language_code VARCHAR(10) NOT NULL,
      translated_name TEXT NOT NULL,
      UNIQUE(category_id, language_code)
    )
  `);
  console.log('✅ category_translations table ready');
}

async function translateCategories() {
  const { rows: categories } = await db.query(`
    SELECT id, name FROM menu_categories
    WHERE is_active = true
    ORDER BY name
  `);

  console.log(`\nFound ${categories.length} categories to translate`);
  console.log(`Languages: ${LANGUAGES.length}\n`);

  for (const cat of categories) {
    process.stdout.write(`Translating: "${cat.name}" ... `);
    try {
      const prompt = `Translate this restaurant menu category name into multiple languages.
Category: "${cat.name}"

RULES:
- Preserve emojis exactly as-is at the end
- Transliterate food/restaurant terms (don't translate literally)
- Keep translations short — category names only, no descriptions
- For hi_LATN (Hinglish): use casual Roman script Hindi
- Return ONLY valid JSON, no markdown

Return:
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

      for (const [langCode, translatedName] of Object.entries(translations)) {
        if (translatedName) {
          await db.query(`
            INSERT INTO category_translations (category_id, language_code, translated_name)
            VALUES ($1, $2, $3)
            ON CONFLICT (category_id, language_code)
            DO UPDATE SET translated_name = $3
          `, [cat.id, langCode, translatedName]);
        }
      }

      console.log('✅');
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`❌ ${err.message}`);
    }
  }

  const { rows: summary } = await db.query(`
    SELECT language_code, COUNT(*) as count
    FROM category_translations
    GROUP BY language_code ORDER BY language_code
  `);
  console.log('\nCategory translation summary:');
  console.table(summary);
  process.exit(0);
}

createTable().then(translateCategories).catch(e => { console.error(e); process.exit(1); });

