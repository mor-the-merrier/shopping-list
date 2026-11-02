/*
 * Receipt parser.
 * Turns the text of a digital receipt (Weezmo format, used by Yohananof and
 * other chains) into structured data. No AI, just rules.
 *
 * Item line (logical order):
 *   <line#> <barcode> <name ...> <unit price> <quantity> ILS<total>
 * Discount line (belongs to the item above it):
 *   <promo name ...> -<amount>
 *
 * Works in the browser (window.ReceiptParser) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  const HEBREW = /[֐-׿]/;
  const CURRENCY_TOKEN = /^(?:ILS|₪)\s*-?\d+(?:\.\d+)?$|^-?\d+(?:\.\d+)?\s*(?:ILS|₪)$/;
  const NUMBER = /^-?\d+(?:\.\d+)?$/;
  // Words that always appear on a receipt; used to detect reversed Hebrew text.
  const KNOWN_WORDS = ['תודה', 'חשבונית', 'סניף', 'תאריך', 'מחיר'];

  const CHAINS = [
    { id: 'yohananof', name: 'יוחננוף', match: /יוחננוף|yohananof/i },
    { id: 'rami-levy', name: 'רמי לוי', match: /רמי\s*לוי|rami\s*levy/i },
    { id: 'shufersal', name: 'שופרסל', match: /שופרסל|shufersal/i },
    { id: 'victory', name: 'ויקטורי', match: /ויקטורי|victory/i },
    { id: 'osher-ad', name: 'אושר עד', match: /אושר\s*עד/ },
  ];

  const reverse = (s) => Array.from(s).reverse().join('');
  const round2 = (n) => Math.round(n * 100) / 100;
  const toNumber = (token) => parseFloat(String(token).replace(/ILS|₪/g, '').trim());

  /** Some PDFs store Hebrew in visual (reversed) order. Detect and fix it. */
  function needsHebrewFix(text) {
    const forward = KNOWN_WORDS.some((w) => text.includes(w));
    const backward = KNOWN_WORDS.some((w) => text.includes(reverse(w)));
    return backward && !forward;
  }

  /** Reverse a visual-order string to logical order, keeping digit runs readable. */
  function visualToLogical(s) {
    return reverse(s).replace(/[\d.,%:/]+/g, (run) => reverse(run));
  }

  function normalizeText(text) {
    let t = String(text || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[‎‏‪-‮⁦-⁩]/g, '') // bidi control chars
      .replace(/ /g, ' ')
      .replace(/₪\s+/g, '₪')
      .replace(/ILS\s+/g, 'ILS');
    if (needsHebrewFix(t)) {
      t = t.split('\n').map(visualToLogical).join('\n');
    }
    return t;
  }

  function detectChain(text) {
    const header = text.match(/שם עסק\s*:\s*([^\n]+)/);
    const haystack = header ? header[1] : text;
    const chain = CHAINS.find((c) => c.match.test(haystack)) || CHAINS.find((c) => c.match.test(text));
    if (chain) return { id: chain.id, name: chain.name };
    if (header) {
      const name = header[1].trim();
      return { id: name.toLowerCase().replace(/\s+/g, '-'), name };
    }
    return { id: 'unknown', name: 'לא ידוע' };
  }

  function parseHeader(text) {
    const out = {};
    const date = text.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
    if (date) {
      const [, d, m, y, time] = date;
      out.date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      out.time = time || '';
    }
    const invoice = text.match(/חשבונית(?:\s*מס)?\s*:\s*(\d+)/);
    if (invoice) out.invoice = invoice[1];
    const branch = text.match(/מספר סניף\s*:\s*(\d+)/);
    if (branch) out.branch = branch[1];
    // 'סה"כ:' exactly (not 'סה"כ ללא מע"מ')
    const total = text.match(/סה["״]?כ\s*:\s*(?:ILS|₪)?\s*(\d+(?:\.\d+)?)/);
    if (total) out.total = parseFloat(total[1]);
    return out;
  }

  /** Parse one item line. Accepts both logical and reversed column order. */
  function parseItemLine(line) {
    let tokens = line.trim().split(/\s+/);
    if (tokens.length < 5) return null;

    let totalIndex = tokens.findIndex((t) => CURRENCY_TOKEN.test(t));
    if (totalIndex === 0) {
      tokens = tokens.slice().reverse();
      totalIndex = tokens.length - 1;
    }
    if (totalIndex !== tokens.length - 1) return null;

    const [lineNo, code] = tokens;
    if (!/^\d{1,3}$/.test(lineNo) || !/^\d{3,14}$/.test(code)) return null;

    const total = toNumber(tokens[totalIndex]);
    const qtyToken = tokens[totalIndex - 1];
    const priceToken = tokens[totalIndex - 2];
    if (!NUMBER.test(qtyToken) || !NUMBER.test(priceToken)) return null;

    const qty = parseFloat(qtyToken);
    const unitPrice = parseFloat(priceToken);
    // Sanity check: price × qty must match the line total (allow rounding).
    if (Math.abs(unitPrice * qty - total) > 0.05 + Math.abs(total) * 0.01) return null;

    const name = tokens.slice(2, totalIndex - 2).join(' ');
    if (!name) return null;

    return {
      code,
      name,
      unitPrice,
      qty,
      total,
      discount: 0,
      weighted: !Number.isInteger(qty),
    };
  }

  /** "רבע לשבע 2ב20 -4.90" → -4.9 (or null if it is not a discount line). */
  function parseDiscountLine(line) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) return null;
    const last = tokens[tokens.length - 1];
    const first = tokens[0];
    const candidate = /^-\d+(?:\.\d+)?$/.test(last) ? last : /^-\d+(?:\.\d+)?$/.test(first) ? first : null;
    if (!candidate) return null;
    if (!HEBREW.test(line)) return null;
    return parseFloat(candidate);
  }

  function parse(rawText) {
    const text = normalizeText(rawText);
    const header = parseHeader(text);
    const chain = detectChain(text);
    const items = [];
    const warnings = [];

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const item = parseItemLine(line);
      if (item) {
        items.push(item);
        continue;
      }
      const discount = parseDiscountLine(line);
      if (discount !== null && items.length) {
        const prev = items[items.length - 1];
        prev.discount = round2(prev.discount + discount);
      }
    }

    const sum = round2(items.reduce((s, i) => s + i.total + i.discount, 0));
    if (!items.length) {
      warnings.push('לא נמצאו מוצרים בקבלה.');
    } else if (header.total != null && Math.abs(sum - header.total) > 0.1) {
      warnings.push(`סכום המוצרים (₪${sum}) לא תואם לסה״כ בקבלה (₪${header.total}). ייתכן שחלק מהשורות לא זוהו.`);
    }
    if (!header.date) warnings.push('לא נמצא תאריך קנייה בקבלה.');

    return {
      chain,
      date: header.date || null,
      time: header.time || '',
      invoice: header.invoice || '',
      branch: header.branch || '',
      total: header.total != null ? header.total : sum,
      itemsSum: sum,
      items,
      warnings,
    };
  }

  const api = { parse, parseItemLine, parseDiscountLine, normalizeText, visualToLogical };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReceiptParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
