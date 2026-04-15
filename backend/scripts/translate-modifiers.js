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

async function run() {
  // Create table
  await db.query(`
    CREATE TABLE IF NOT EXISTS modifier_translations (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      modifier_id     UUID NOT NULL,
      language_code   VARCHAR(10) NOT NULL,
      translated_name TEXT NOT NULL,
      UNIQUE(modifier_id, language_code)
    )
  `);
  console.log('✅ modifier_translations table ready');

  // Also store English
  await db.query(`
    INSERT INTO modifier_translations (modifier_id, language_code, translated_name)
    SELECT id, 'en', name FROM menu_modifiers
    ON CONFLICT (modifier_id, language_code) DO UPDATE SET translated_name = EXCLUDED.translated_name
  `);
  console.log('✅ English modifier names stored');

  const { rows: modifiers } = await db.query(
    'SELECT id, name FROM menu_modifiers WHERE is_active = true ORDER BY name'
  );
  console.log(`\nFound ${modifiers.length} modifiers to translate\n`);

  for (const mod of modifiers) {
    process.stdout.write(`Translating: "${mod.name}" ... `);
    try {
      const prompt = `Translate this restaurant menu add-on/modifier name into multiple languages.
Name: "${mod.name}"
RULES:
- Short translation — modifier/add-on name only
- Keep food terms as transliterations where natural
- Return ONLY valid JSON, no markdown
{
  "hi": "...", "mr": "...", "hi_LATN": "...",
  "ta": "...", "te": "...", "gu": "...", "ml": "...", "kn": "...",
  "ru": "...", "zh": "...", "de": "...", "fr": "...", "es": "..."
}`;

      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0].text.trim().replace(/```json|```/g, '').trim();
      const translations = JSON.parse(text);

      for (const [langCode, translatedName] of Object.entries(translations)) {
        if (translatedName) {
          await db.query(`
            INSERT INTO modifier_translations (modifier_id, language_code, translated_name)
            VALUES ($1, $2, $3)
            ON CONFLICT (modifier_id, language_code)
            DO UPDATE SET translated_name = $3
          `, [mod.id, langCode, translatedName]);
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
    FROM modifier_translations
    GROUP BY language_code ORDER BY language_code
  `);
  console.log('\nModifier translation summary:');
  console.table(summary);
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });

