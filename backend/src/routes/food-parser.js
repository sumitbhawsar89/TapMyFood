'use strict';

// ════════════════════════════════════════════════
// FOOD ORDER TOKEN PARSER
// Menu-first greedy matching — dish names consumed
// before any number is interpreted as qty
// ════════════════════════════════════════════════

// ── Qty words (English + Hindi) ──
const QTY_WORDS = {
  'one':1, 'two':2, 'three':3, 'four':4, 'five':5,
  'six':6, 'seven':7, 'eight':8, 'nine':9, 'ten':10,
  'ek':1, 'do':2, 'teen':3, 'char':4, 'paanch':5,
  'chhe':6, 'saat':7, 'aath':8, 'nau':9, 'das':10,
  // do NOT include "do" in isolation below — handled by menu-first
};

// ── Filler words to skip ──
const FILLERS = new Set([
  'aur','and','with','also','plus','please','order',
  'add','want','need','de','dena','lao','chahiye',
  'mujhe','hame','humko','karo','kar','bhi','ek',
  'a','an','the','some','for','of',
]);

function normalize(s) {
  return (s || '').toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

// Phonetic normalization — collapse common spelling variants
// so "pyaaza" matches "pyaza", "aloo" matches "alu" etc.
function phoneticNorm(s) {
  return normalize(s)
    .replace(/aa/g, 'a') // pyaaza → pyaza, saag → sag
    .replace(/ee/g, 'i') // paneer → panir (both forms stored)
    .replace(/oo/g, 'u') // aloo → alu
    .replace(/kh/g, 'k') // makhani → makani
    .replace(/gh/g, 'g') // ghee → ge
    .replace(/sh/g, 's') // shahi → sahi
    .replace(/(\w) +/g, '$1') // double letters → single
    .trim();
}

// ════════════════════════════════════════════════
// GREEDY MENU MATCHER
// Tries to match the longest possible dish name
// starting at each position in the word array
// ════════════════════════════════════════════════
function greedyMenuMatch(words, startIdx, menuIndex) {
  // Try longest match first (up to 6 words)
  for (let len = 6; len >= 1; len--) {
    if (startIdx + len - 1 >= words.length) continue;
    const phrase = words.slice(startIdx, startIdx + len).join(' ');
    const normPh = normalize(phrase);
    const phonePh = phoneticNorm(phrase);

    if (menuIndex[normPh]) return { item: menuIndex[normPh], consumed: len };
    if (menuIndex[phonePh]) return { item: menuIndex[phonePh], consumed: len };

    // Without trailing suffix words
    const stripped = normPh.replace(/\b(burger|pizza|rice|naan|roti|curry|masala|gravy)\b/, '').trim();
    if (stripped && menuIndex[stripped]) return { item: menuIndex[stripped], consumed: len };
  }
  return null;
}

// ════════════════════════════════════════════════
// BUILD MENU INDEX
// Keys: normalized full name + normalized aliases
// ════════════════════════════════════════════════
function buildMenuIndex(menuItems) {
  const index = {};

  function addKey(key, item) {
    if (key && key.length > 1 && !index[key]) index[key] = item;
  }

  // Track single-word keys — only add if unique (avoid "burger" matching first burger found)
  const singleWordCandidates = {};

  for (const item of menuItems) {
    const key = normalize(item.name);
    const phone = phoneticNorm(item.name);
    const parts = key.split(' ');

    // Exact normalized + phonetic
    addKey(key, item);
    addKey(phone, item);

    // Progressive sub-phrases (longest first)
    for (let len = parts.length; len >= 2; len--) {
      const sub = parts.slice(0, len).join(' ');
      addKey(sub, item);
      addKey(phoneticNorm(sub), item);
    }

    // Two-word shorthand
    if (parts.length >= 2) {
      addKey(parts.slice(0, 2).join(' '), item);
      addKey(phoneticNorm(parts.slice(0, 2).join(' ')), item);
    }

    // Single meaningful words (first non-generic word) — e.g. "russian" for "Russian Burger"
    // Only index if the word is specific (not generic like burger/pizza/rice/shake)
    const GENERIC = new Set(['burger','pizza','rice','naan','roti','curry','masala',
                             'gravy','shake','coffee','tea','juice','roll','wrap',
                             'combo','meal','special','large','small','regular']);
    for (const word of parts) {
      if (word.length > 2 && !GENERIC.has(word)) {
        if (!singleWordCandidates[word]) {
          singleWordCandidates[word] = item; // first match wins
        } else if (singleWordCandidates[word] !== item) {
          singleWordCandidates[word] = null; // ambiguous — don't index
        }
      }
    }
  }

  // Add unambiguous single-word keys
  for (const [word, item] of Object.entries(singleWordCandidates)) {
    if (item !== null) {
      addKey(word, item);
      addKey(phoneticNorm(word), item);
    }
  }
  return index;
}

// ════════════════════════════════════════════════
// PARSER
// ════════════════════════════════════════════════

// ── Modifier/note extraction ──
// Strips "extra cheese", "no onion", "k sath" etc. from input
// Returns {cleaned, note} — note is attached to the ordered item
const MODIFIER_PATTERNS = [
  /\bextra\s+(\w+(?:\s+\w+)?)/gi,
  /\bno\s+(\w+(?:\s+\w+)?)/gi,
  /\bwithout\s+(\w+(?:\s+\w+)?)/gi,
  /\bless\s+(\w+(?:\s+\w+)?)/gi,
  /\bmore\s+(\w+(?:\s+\w+)?)/gi,
  /\bbina\s+(\w+(?:\s+\w+)?)/gi,
  /\bwith\s+(?:extra\s+)?(\w+(?:\s+\w+)?)/gi,
  /(\w+(?:\s+\w+)?)\s+ke?\s+sath\b/gi,
];
const NOTE_STOP_WORDS = new Set([
  'burger','pizza','rice','fries','shake','coffee','tea','juice',
  'nugget','roll','wrap','combo','meal','naan','roti','order','please',
  'chahiye','dena','lena','add','aur','and','ek','do','teen'
]);

function extractModifiers(text) {
  let cleaned = text;
  const notes = [];
  for (const pat of MODIFIER_PATTERNS) {
    pat.lastIndex = 0;
    let m;
    while ((m = pat.exec(text)) !== null) {
      const word = (m[1] || '').trim().toLowerCase().split(' ')[0];
      if (!NOTE_STOP_WORDS.has(word) && word.length > 1) {
        notes.push(m[0].trim());
        cleaned = cleaned.replace(m[0], ' ');
      }
    }
  }
  return {
    cleaned: cleaned.replace(/\s+/g, ' ').trim(),
    note: notes.length > 0 ? notes.join(', ') : null
  };
}

function parseFoodOrder(input, menuItems) {
  const menuIndex = buildMenuIndex(menuItems);

  // Extract modifier notes before parsing (e.g. "extra cheese k sath" → note)
  const { cleaned: cleanedInput, note: globalNote } = extractModifiers(input || '');

  const raw = normalize(cleanedInput);
  const words = raw.split(/[\s,\/]+/).filter(Boolean);

  const groups = []; // { item, qty, note }
  const unmatched = []; // words that didn't match anything

  let i = 0;
  let pendingQty = null;
  let pendingNote = globalNote; // note from modifier extraction

  while (i < words.length) {
    const w = words[i];

    // ── Skip fillers ──
    if (FILLERS.has(w) && w !== 'ek') { i++; continue; }

    // ── Try menu match FIRST (greedy, longest match wins) ──
    const match = greedyMenuMatch(words, i, menuIndex);
    if (match) {
      const qty = pendingQty || 1;
      groups.push({ item: match.item, qty });
      pendingQty = null;
      let consumed = match.consumed;

      // If matched via short form, check if next words are part of the full dish name
      // e.g. matched "paneer do" but full name is "Paneer Do Pyaza" → consume "pyaaza" too
      const fullNameWords = normalize(match.item.name).split(' ');
      const matchedWords = words.slice(i, i + consumed);
      if (matchedWords.length < fullNameWords.length) {
        const remaining = fullNameWords.length - matchedWords.length;
        for (let extra = 0; extra < remaining && i + consumed < words.length; extra++) {
          const nextW = words[i + consumed];
          const expectedW = fullNameWords[matchedWords.length + extra];
          // Check phonetic similarity
          if (phoneticNorm(nextW) === phoneticNorm(expectedW) ||
              nextW.startsWith(expectedW.slice(0,3)) ||
              expectedW.startsWith(nextW.slice(0,3))) {
            consumed++;
          } else {
            break;
          }
        }
      }

      i += consumed;
      continue;
    }

    // ── Numeric digit qty ──
    if (/^\d+$/.test(w)) {
      const n = parseInt(w);
      if (n >= 1 && n <= 20) {
        pendingQty = n;
        i++; continue;
      }
      // Large number — not a qty, probably part of dish name not in menu
      unmatched.push(w);
      i++; continue;
    }

    // ── Hindi/English qty word ──
    if (QTY_WORDS[w]) {
      pendingQty = QTY_WORDS[w];
      i++; continue;
    }

    // ── Unknown word — collect for fuzzy fallback ──
    unmatched.push(w);
    i++;
  }

  // ── Fuzzy fallback for unmatched words ──
  // If there are unmatched words, try fuzzy matching them against menu
  const clarify = [];
  if (unmatched.length > 0) {
    const phrase = unmatched.join(' ');
    const fuzzyMatch = fuzzyFind(phrase, menuItems);
    if (fuzzyMatch) {
      groups.push({ item: fuzzyMatch, qty: pendingQty || 1, note: pendingNote || null });
      pendingQty = null;
      pendingNote = null;
    } else if (unmatched.some(w => w.length > 2)) {
      clarify.push(phrase);
    }
  }

  return { results: groups, clarify };
}

function fuzzyFind(name, menuItems) {
  const n = normalize(name);
  const words = n.split(' ').filter(w => w.length > 2);

  // Helper: among multiple matches, always pick the SHORTEST item name
  // This prevents "Cold Coffee" from matching "Combo: Big Tikki + Cold Coffee"
  function shortest(candidates) {
    const valid = candidates.filter(Boolean);
    if (valid.length === 0) return null;
    return valid.reduce((a, b) => a.name.length <= b.name.length ? a : b);
  }

  // 1. Exact match
  const exact = menuItems.filter(i => normalize(i.name) === n);
  if (exact.length > 0) return shortest(exact);

  // 2. Item name contains search term (e.g. "cold coffee" in "Cold Coffee with Ice-cream")
  // BUT skip combos/bundles when a standalone item also matches
  const contains = menuItems.filter(i => normalize(i.name).includes(n));
  if (contains.length > 0) return shortest(contains);

  // 3. Search term contains item name (e.g. "cold coffe" contains "cold coffee" after normalization)
  const reverse = menuItems.filter(i => n.includes(normalize(i.name)));
  if (reverse.length > 0) return shortest(reverse);

  // 4. All significant words match
  const allWords = menuItems.filter(i => words.length > 0 && words.every(w => normalize(i.name).includes(w)));
  if (allWords.length > 0) return shortest(allWords);

  // 5. Typo tolerance — 60% word match
  const partial = menuItems.filter(i => {
    const iw = normalize(i.name).split(' ').filter(w => w.length > 2);
    const matches = words.filter(w => iw.includes(w));
    return words.length > 0 && matches.length / words.length >= 0.6;
  });
  if (partial.length > 0) return shortest(partial);

  // 6. Levenshtein fuzzy — for typos like "coffe" → "coffee"
  // Only match if edit distance is small relative to word length
  const typo = menuItems.filter(i => {
    const iWords = normalize(i.name).split(' ').filter(w => w.length > 2);
    return words.some(w => iWords.some(iw => {
      const maxLen = Math.max(w.length, iw.length);
      const dist = levenshtein(w, iw);
      return dist <= Math.floor(maxLen * 0.3); // max 30% edit distance
    }));
  });
  if (typo.length > 0) return shortest(typo);

  return null;
}

// ── Detect if message is a food order ──
// Returns true if it doesn't look like a bar order
// (bar parser runs first, food parser is fallback for food)
function isFoodOrder(message) {
  const m = message.toLowerCase();
  // Has item-ordering intent
  const hasIntent = /\b(chahiye|dena|order|add|lao|do|want|please|aur|and|\d+)\b/.test(m);
  // Is NOT a greeting or question
  const isQuestion = /\?(what|how|which|kya|kon|kitna|kaisa)/.test(m);
  return hasIntent && !isQuestion;
}

// ════════════════════════════════════════════════
// SUGGESTION ENGINE — "did you mean?"
// Returns top 3 closest menu items for unmatched phrase
// ════════════════════════════════════════════════

// Levenshtein distance between two strings
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  dp[0] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// Score how similar query is to a menu item (0 = perfect, higher = worse)
function similarityScore(query, itemName) {
  const q = phoneticNorm(query);
  const it = phoneticNorm(itemName);

  // Exact phonetic match
  if (q === it) return 0;

  // Levenshtein on full names
  const lev = levenshtein(q, it);

  // Word overlap bonus — shared words reduce score
  const qWords = q.split(' ').filter(w => w.length > 1);
  const itWords = it.split(' ').filter(w => w.length > 1);
  const shared = qWords.filter(w => itWords.some(iw => iw.startsWith(w) || w.startsWith(iw)));
  const overlapBonus = shared.length * 2;

  return lev - overlapBonus;
}

function getSuggestions(query, menuItems, maxResults = 3) {
  const scored = menuItems
    .map(item => ({ item, score: similarityScore(query, item.name) }))
    .sort((a, b) => a.score - b.score)
    .slice(0, maxResults);

  // Only suggest items with reasonable similarity (score < 8)
  return scored.filter(s => s.score < 8).map(s => s.item);
}

module.exports = { parseFoodOrder, isFoodOrder, buildMenuIndex, getSuggestions };

