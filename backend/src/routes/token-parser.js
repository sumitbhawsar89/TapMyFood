'use strict';

// ════════════════════════════════════════════════
// BAR ORDER TOKEN PARSER
// Deterministic rule engine for ambiguous bar orders
// ════════════════════════════════════════════════

// ── Known brands and their aliases ──
const BRANDS = {
  'chivas':          'Chivas Regal',
  'chivas regal':    'Chivas Regal',
  'cr':              'Chivas Regal',
  '8pm':             '8PM Whisky',
  'eight pm':        '8PM Whisky',
  'blenders pride':  'Blenders Pride',
  'bp':              'Blenders Pride',
  'royal challenge': 'Royal Challenge',
  'rc':              'Royal Challenge',
  'royal stag':      'Royal Stag',
  'rs':              'Royal Stag',
  'mcdowells':       'McDowell\'s No.1',
  'mc':              'McDowell\'s No.1',
  'officer choice':  'Officer\'s Choice',
  'oc':              'Officer\'s Choice',
  'jack daniels':    'Jack Daniel\'s',
  'jd':              'Jack Daniel\'s',
  'johnnie walker':  'Johnnie Walker',
  'jw':              'Johnnie Walker',
  'black label':     'Johnnie Walker Black Label',
  'red label':       'Johnnie Walker Red Label',
  'old monk':        'Old Monk',
  'om':              'Old Monk',
  'dsp':             'DSP Black',
  'dsp black':       'DSP Black',
  'kingfisher':      'Kingfisher',
  'kf':              'Kingfisher',
  'budweiser':       'Budweiser',
  'bud':             'Budweiser',
  'corona':          'Corona',
  'heineken':        'Heineken',
  'tuborg':          'Tuborg',
  'haywards':        'Haywards 5000',
  'h5000':           'Haywards 5000',
  'bacardi':         'Bacardi',
  'smirnoff':        'Smirnoff',
  'absolut':         'Absolut',
  'beefeater':       'Beefeater',
};

// ── Size tokens: map to ml value ──
const SIZES = {
  '30ml': 30,  '30': 30,
  '60ml': 60,  '60': 60,
  '90ml': 90,  '90': 90,
  '120ml': 120, '120': 120,
  '180ml': 180, '180': 180,
  '330ml': 330, '330': 330,   // beer
  '500ml': 500, '500': 500,   // beer
  '650ml': 650, '650': 650,   // beer large
  'small':  30,
  'peg':    60,
  'large':  90,
  'full':   90,
  'half':   45,
  'double': 60,
  'neat':   60,
  'shot':   30,
  'pint':   330,
  'pitcher': 1000,
};

// ── Hindi qty words ──
const HINDI_QTY = {
  'ek': 1, 'do': 2, 'teen': 3, 'char': 4,
  'paanch': 5, 'chhe': 6, 'saat': 7,
  'aath': 8, 'nau': 9, 'das': 10,
  'one': 1, 'two': 2, 'three': 3, 'four': 4,
  'five': 5, 'six': 6, 'seven': 7,
  'eight': 8, 'nine': 9, 'ten': 10,
};

// ── Separators / filler words to strip ──
const FILLERS = new Set([
  'aur', 'and', 'with', 'for', 'of', 'the', 'a', 'an',
  'also', 'plus', 'give', 'de', 'dena', 'lao', 'chahiye',
  'please', 'order', 'add', 'want', 'need',
]);

// ════════════════════════════════════════════════
// TOKENIZER
// ════════════════════════════════════════════════
function tokenize(input) {
  // Normalize: lowercase, collapse spaces
  const raw = input.toLowerCase().trim().replace(/\s+/g, ' ');

  // Split on spaces and punctuation (keep together: 90ml, 8pm, etc.)
  const words = raw.split(/[\s,\/]+/);

  const tokens = [];
  let i = 0;

  while (i < words.length) {
    const w = words[i];

    // Skip filler words
    if (FILLERS.has(w)) { i++; continue; }

    // ── Multi-word brand match (try longest match first) ──
    let brandMatched = false;
    for (let len = 3; len >= 2; len--) {
      if (i + len - 1 < words.length) {
        const phrase = words.slice(i, i + len).join(' ');
        if (BRANDS[phrase]) {
          tokens.push({ type: 'BRAND', value: BRANDS[phrase], raw: phrase });
          i += len;
          brandMatched = true;
          break;
        }
      }
    }
    if (brandMatched) continue;

    // ── Single-word brand ──
    if (BRANDS[w]) {
      tokens.push({ type: 'BRAND', value: BRANDS[w], raw: w });
      i++; continue;
    }

    // ── Size with ml suffix (e.g. "90ml", "330ml") ──
    const mlMatch = w.match(/^(\d+)ml$/);
    if (mlMatch) {
      tokens.push({ type: 'SIZE', value: parseInt(mlMatch[1]), raw: w });
      i++; continue;
    }

    // ── Named sizes (large, small, peg etc.) ──
    if (SIZES[w] && isNaN(parseInt(w))) {
      tokens.push({ type: 'SIZE', value: SIZES[w], raw: w });
      i++; continue;
    }

    // ── Hindi qty words ──
    if (HINDI_QTY[w]) {
      tokens.push({ type: 'QTY', value: HINDI_QTY[w], raw: w });
      i++; continue;
    }

    // ── Pure number ──
    if (/^\d+$/.test(w)) {
      const n = parseInt(w);
      // Ambiguous: could be qty (1-20) or size (30, 60, 90, 120, 180...)
      // Context resolves this in grouper — tag as AMBIG for now
      if (SIZES[String(n)]) {
        tokens.push({ type: 'AMBIG', value: n, raw: w });
      } else if (n <= 20) {
        tokens.push({ type: 'QTY', value: n, raw: w });
      } else {
        tokens.push({ type: 'UNKNOWN', value: w, raw: w });
      }
      i++; continue;
    }

    // ── Time-like pattern (8pm → brand name like 8PM Whisky) ──
    const timeMatch = w.match(/^(\d+)(am|pm)$/);
    if (timeMatch) {
      const brandKey = w; // e.g. "8pm"
      if (BRANDS[brandKey]) {
        tokens.push({ type: 'BRAND', value: BRANDS[brandKey], raw: w });
      } else {
        // Unknown time-brand — keep as partial brand for fuzzy resolve
        tokens.push({ type: 'BRAND', value: w.toUpperCase() + ' Whisky', raw: w });
      }
      i++; continue;
    }

    // ── Unknown word — could be part of a brand not in our list ──
    tokens.push({ type: 'UNKNOWN', value: w, raw: w });
    i++;
  }

  return tokens;
}

// ════════════════════════════════════════════════
// GROUPER — converts token stream into order items
// ════════════════════════════════════════════════
function groupTokens(tokens) {
  const groups = [];
  let current = { qty: null, size: null, brand: null, unknowns: [] };

  function flush() {
    if (current.brand || current.unknowns.length > 0) {
      groups.push({ ...current });
    }
    current = { qty: null, size: null, brand: null, unknowns: [] };
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const next = tokens[i + 1];

    if (tok.type === 'QTY') {
      // QTY starts a new group if current group has a brand
      if (current.brand || current.unknowns.length > 0) flush();
      current.qty = tok.value;

    } else if (tok.type === 'SIZE') {
      current.size = tok.value;

    } else if (tok.type === 'AMBIG') {
      // Ambiguous number: if current group has no size yet → treat as SIZE
      // if current group has no qty → treat as QTY
      if (!current.size && SIZES[String(tok.value)]) {
        current.size = tok.value;
      } else if (!current.qty) {
        current.qty = tok.value;
      } else {
        // Has both — this might be a new group's qty
        flush();
        current.qty = tok.value;
      }

    } else if (tok.type === 'BRAND') {
      // New brand starts a new group if current has a brand
      if (current.brand) flush();
      current.brand = tok.value;

    } else if (tok.type === 'UNKNOWN') {
      current.unknowns.push(tok.raw);
    }
  }
  flush();

  // Apply defaults
  return groups.map(g => ({
    qty:    g.qty    || 1,
    size:   g.size   || null,
    brand:  g.brand  || (g.unknowns.length ? g.unknowns.join(' ') : null),
    needs_clarification: !g.brand && !g.unknowns.length,
  }));
}

// ════════════════════════════════════════════════
// RESOLVER — match groups to menu items
// ════════════════════════════════════════════════
function normalize(s) {
  return (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim();
}

function resolveGroups(groups, menuItems) {
  const results = [];
  const clarify  = [];

  for (const g of groups) {
    if (g.needs_clarification) continue;

    // Build search string: "Brand SizeML" or just "Brand"
    const brandNorm = normalize(g.brand);
    const sizeStr   = g.size ? g.size + 'ml' : null;
    const searchFull = sizeStr ? brandNorm + ' ' + sizeStr : brandNorm;
    const searchAlt  = sizeStr ? brandNorm + ' ' + normalize(sizeStr) : brandNorm;

    // Try increasingly loose matches
    let found =
      menuItems.find(i => normalize(i.name) === searchFull) ||
      menuItems.find(i => normalize(i.name) === searchAlt) ||
      menuItems.find(i => normalize(i.name).includes(searchFull)) ||
      menuItems.find(i => sizeStr && normalize(i.name).includes(brandNorm) && normalize(i.name).includes(normalize(sizeStr))) ||
      menuItems.find(i => normalize(i.name).includes(brandNorm)) ||
      menuItems.find(i => brandNorm.split(' ').every(w => w.length > 1 && normalize(i.name).includes(w)));

    if (found) {
      results.push({ item: found, qty: g.qty });
    } else {
      clarify.push({ raw: g.brand + (sizeStr ? ' ' + sizeStr : ''), qty: g.qty });
    }
  }

  return { results, clarify };
}

// ════════════════════════════════════════════════
// MAIN ENTRY — parse bar order string
// Returns: { results, clarify, tokens, groups }
// ════════════════════════════════════════════════
function parseBarOrder(input, menuItems) {
  const tokens = tokenize(input);
  const groups = groupTokens(tokens);
  const { results, clarify } = resolveGroups(groups, menuItems);
  return { results, clarify, tokens, groups };
}

// ── Detect if message looks like a bar order ──
function isBarOrder(message, session) {
  const m = message.toLowerCase();
  const hasBarWords = /\b(whisky|whiskey|rum|vodka|gin|beer|wine|scotch|brandy|tequila|shots?|peg|90ml|60ml|30ml|large|small|neat|on the rocks)\b/.test(m);
  const hasBarBrands = Object.keys(BRANDS).some(b => m.includes(b));
  return hasBarWords || hasBarBrands;
}

module.exports = { parseBarOrder, isBarOrder, tokenize, groupTokens };

