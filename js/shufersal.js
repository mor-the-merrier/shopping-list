/*
 * Picture receipts: Shufersal's digital receipt, and photos of paper receipts.
 * (The file keeps its old name; js/paper.js adds the photo-specific parts.)
 *
 * Shufersal's receipt PDF is a picture of the receipt (no text inside), so the
 * app reads it with OCR (see js/ocr.js). This file turns the OCR words into
 * receipt data. It's pure logic, testable without a browser.
 *
 * Layout (right to left): code | description | amount. An item takes 1–3 rows:
 *   7290016334500  חסה לבבות בשקית            9.90     ← code, name, price (qty 1)
 *   428            בטטה מובחרת                         ← code, name
 *                  ק"ג 1.885 x 7.90 לק"ג     14.89     ← weight × price per kg
 *   7290020269638  מסיר אבנית מכונת קפה
 *                  2 x 18.90 ליחידה           37.80     ← quantity × unit price
 *                  2ב24 מסיר אבנית...        -13.80     ← discount for the item above
 *
 * OCR is run three times: the whole receipt (Hebrew text), and the code and
 * amount columns with digits only, which reads numbers much more reliably.
 */
(function (root) {
  'use strict';

  // Column boundaries as a share of the image width (from Shufersal's layout).
  const CODE_FROM = 0.68; // code column: right of this
  const AMOUNT_TO = 0.19; // amount column: left of this

  const round2 = (n) => Math.round(n * 100) / 100;
  const centerY = (w) => (w.bbox.y0 + w.bbox.y1) / 2;
  const centerX = (w) => (w.bbox.x0 + w.bbox.x1) / 2;

  /**
   * Merge the three OCR readings into rows.
   * Each word: { text, bbox: { x0, y0, x1, y1 } } in full-image pixels.
   * codeFrom / amountTo: the column edges in pixels (default: Shufersal's layout).
   */
  function buildRows({ words, codeWords, amountWords, midWords = [], width, codeFrom, amountTo }) {
    const cFrom = codeFrom != null ? codeFrom : width * CODE_FROM;
    const aTo = amountTo != null ? amountTo : width * AMOUNT_TO;
    const all = [];
    for (const w of words) {
      if (centerX(w) < aTo) continue; // the price column comes from the digit pass
      all.push({ kind: 'desc', w });
    }
    // A barcode never has "." or ":" (those are prices, percentages or times).
    for (const w of codeWords) {
      const t = w.text.replace(/^\.+|\.+$/g, '');
      if (/[:xX]/.test(t)) continue;
      if (t.includes('.') && !/729\d{9}/.test(t)) continue;
      all.push({ kind: 'code', w });
    }
    for (const w of amountWords) all.push({ kind: 'amount', w });
    // photos: the middle of the line read as digits, for "6.50 x 4" and weights
    for (const w of midWords) all.push({ kind: 'mid', w });
    all.sort((a, b) => centerY(a.w) - centerY(b.w));

    const heights = all.map((a) => a.w.bbox.y1 - a.w.bbox.y0).filter((h) => h > 0).sort((a, b) => a - b);
    const lineH = heights.length ? heights[Math.floor(heights.length / 2)] : 20;
    const tolerance = lineH * 0.6;

    // A word box much taller than a line (a smudge or the paper's edge got
    // included) has a misleading middle: place those after the others.
    const tall = (a) => a.w.bbox.y1 - a.w.bbox.y0 > lineH * 1.5;
    const rows = [];
    for (const a of all) {
      if (tall(a)) continue;
      const y = centerY(a.w);
      let row = rows.length ? rows[rows.length - 1] : null;
      if (!row || Math.abs(row.y - y) > tolerance) {
        row = { y, desc: [], code: [], amount: [], mid: [] };
        rows.push(row);
      }
      row[a.kind].push(a.w);
    }
    for (const a of all) {
      if (!tall(a)) continue;
      // the rows it covers; the first one still missing this kind of word, else the one nearest its top
      const inside = rows.filter((r) => r.y >= a.w.bbox.y0 - tolerance && r.y <= a.w.bbox.y1 + tolerance);
      const top = a.w.bbox.y0 + lineH / 2;
      const free = inside.filter((r) => !r[a.kind].length);
      const pick = (list) => list.slice().sort((p, q) => Math.abs(p.y - top) - Math.abs(q.y - top))[0];
      let row = pick(free) || pick(inside);
      if (!row) {
        row = { y: centerY(a.w), desc: [], code: [], amount: [], mid: [] };
        rows.push(row);
        rows.sort((p, q) => p.y - q.y);
      }
      row[a.kind].push(a.w);
    }

    return rows.map((r) => {
      // Barcodes are right-aligned: the rightmost number on the line is the code,
      // anything left of it in the strip is part of the name read as digits.
      const codeWord = r.code
        .filter((w) => /\d{2,}/.test(w.text))
        .sort((a, b) => b.bbox.x1 - a.bbox.x1)[0];
      const descEdge = codeWord ? Math.min(codeWord.bbox.x0, cFrom + (width - cFrom) / 2) : cFrom;
      return {
      y: Math.round(r.y),
      code: codeWord ? pickCode(codeWord.text) : '',
      // right-to-left reading order for the Hebrew description
      desc: r.desc
        .filter((w) => centerX(w) < descEdge)
        .sort((a, b) => b.bbox.x1 - a.bbox.x1)
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      amount: r.amount.map((w) => w.text).join('').replace(/[^\d.-]/g, ''),
      mid: r.mid
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)
        .map((w) => w.text)
        .join(' '),
      // the description in the order it's printed, left to right ("לק"ג 9.90 x")
      ltr: r.desc
        .filter((w) => centerX(w) < descEdge)
        .sort((a, b) => a.bbox.x0 - b.bbox.x0)
        .map((w) => w.text)
        .join(' '),
      };
    });
  }

  /**
   * The barcode in a digits reading of the code column. On a photo the name's
   * last digits ("125ג", "1%") can stick to it: "117177290116935614".
   * An Israeli barcode (729 + 10 digits) inside is taken, preferring one whose
   * check digit is right; otherwise a long run keeps its last 7 digits
   * (in-store codes are short and right-aligned, so the code is at the end).
   */
  function pickCode(text) {
    const d = String(text || '').replace(/\D/g, '');
    if (d.length <= 13 && (d.length < 13 || !/729/.test(d.slice(1)))) return d;
    let fallback = null;
    for (let i = d.length - 13; i >= 0; i--) {
      const c = d.slice(i, i + 13);
      if (!c.startsWith('729')) continue;
      if (eanValid(c)) return c;
      if (!fallback) fallback = c;
    }
    if (fallback) return fallback;
    // 729 + 9 digits at the very end: the check digit was lost
    const short = d.match(/729\d{9}$/);
    if (short) return short[0];
    return d.length > 8 ? d.slice(-7) : d;
  }

  /** "2.12-" or "-2.12" → -2.12; "14.89" → 14.89; no decimal point → null (not a price). */
  function parseAmount(s) {
    // the first price-shaped number; stray digits stuck to it are OCR noise
    const str = String(s || '');
    const m = str.match(/(-?)(\d{1,4}\.\d{2})(-?)/);
    if (m) {
      const v = parseFloat(m[2]);
      return m[1] || m[3] ? -v : v;
    }
    // "19.9": the last 0 of a dot-matrix "0" is often too faint to read
    const one = str.match(/^(-?)(\d{1,4}\.\d)(-?)$/);
    if (one) {
      const v = parseFloat(one[2]);
      return one[1] || one[3] ? -v : v;
    }
    return null;
  }

  /**
   * A quantity line read from the middle of a photo ("6.50 x 4", "6.90 x 0.650"):
   * the unit price before the x, and the amount of the line decides the rest.
   */
  function midQuantity(mid, amount) {
    const m = String(mid || '').match(/(\d{0,4}\.?\d{0,2})\s*[xX×]\s*(.*)$/);
    if (!m) return null;
    const unitPrice = parseFloat(m[1]) || 0;
    const rest = m[2];
    const paid = amount != null && amount > 0 ? amount : null;
    // a weight has 3 decimals; "ק"ג" before it often reads as digits, so keep one digit before the point
    const w = rest.match(/(\d\.\d{3})(?!\d)/);
    // without a weight, the unit price must have read whole ("6.50")
    if (!w && !/^\d{1,4}\.\d{2}$/.test(m[1])) return null;
    if (!w && !(unitPrice > 0)) return null;
    if (w && !paid && !/^\d{1,4}\.\d{2}$/.test(m[1])) return null;
    if (w && parseFloat(w[1]) > 0) {
      const qty = parseFloat(w[1]);
      // the line's amount reads more reliably than the small unit price
      return { qty, unitPrice: paid ? round2(paid / qty) : unitPrice, weighted: true, total: paid || round2(qty * unitPrice) };
    }
    if (paid) {
      const ratio = paid / unitPrice;
      if (Math.round(ratio) >= 1 && Math.abs(ratio - Math.round(ratio)) < 0.02) return { qty: Math.round(ratio), unitPrice, weighted: false, total: paid };
      const n = rest.match(/^\s*(\d{1,2})(?![\d.])/);
      if (n && +n[1] > 0) return { qty: +n[1], unitPrice: round2(paid / +n[1]), weighted: false, total: paid };
      return null;
    }
    const n = rest.match(/^\s*(\d{1,2})(?![\d.])/);
    if (n && +n[1] > 0) return { qty: +n[1], unitPrice, weighted: false, total: round2(+n[1] * unitPrice) };
    return null;
  }

  /**
   * A row's quantity line, if it is one. The middle digits reading may hold all
   * of "6.50 x 4", or only the weight when the unit price sits further left in
   * the description ("לק"ג 9.90 א" + "1.205").
   */
  function rowQuantity(r, amount) {
    const direct = midQuantity(r.mid, amount);
    if (direct) return direct;
    if (!r.ltr) return null;
    const joined = `${r.ltr} ${r.mid || ''}`
      .replace(/(^|\s)[אxX×*](?=\s|$)/g, '$1x')
      .replace(/[^\d.x\s]/g, ' ')
      .replace(/\s+/g, ' ');
    return midQuantity(joined, amount);
  }

  /** OCR often reads the "x" between numbers as the Hebrew letter א. */
  function fixTimes(s) {
    return String(s || '').replace(/(\d)\s*[אxX×*]\s*(\d)/g, '$1 x $2').replace(/[‎‏‪-‮]/g, '');
  }

  /** EAN-13 check digit: Israeli barcodes (729…) can be checked and sometimes repaired. */
  function eanValid(code) {
    if (!/^\d{13}$/.test(code)) return false;
    const d = Array.from(code, Number);
    const sum = d.slice(0, 12).reduce((s, n, i) => s + n * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === d[12];
  }

  /** OCR sometimes drops the leading 7 of 729…: put it back when the check digit agrees. */
  function fixBarcode(code) {
    const c = String(code || '');
    if (c.length === 12 && c.startsWith('29') && eanValid('7' + c)) return '7' + c;
    if (c.length === 11 && c.startsWith('9') && eanValid('72' + c)) return '72' + c;
    // 729 + 9 digits: the last digit was lost at the paper's edge; it's the check digit
    if (c.length === 12 && c.startsWith('729')) {
      for (let d = 0; d <= 9; d++) if (eanValid(c + d)) return c + d;
    }
    return c;
  }

  const WEIGHT_ROW = /ק["״'׳]?ג\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/;
  const UNITS_ROW = /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*ליחיד/;
  const END_ROW = /לתשלום|שולם|סה["״]?כ/;
  // Paper receipts: rows that come after the items (VAT, payment, item count).
  const AFTER_ITEMS = /לתשלום|שולם|סה["״]?כ|מע["״]?מ|חייב|אשראי|מזומן|עודף|פריטים|תשלום/;

  /**
   * "לתשלום" as OCR reads it when printed in wide letters: "להצלוו", "ל ת ש ל ו ם".
   * Letters it confuses are allowed; it must be the whole description.
   */
  function looksLikeToPay(desc) {
    const t = String(desc || '').replace(/[^א-ת]/g, '');
    return /^ל[תהח][שצעט]ל[ויז][םסוה]?$/.test(t);
  }

  function parseHeader(text) {
    const out = {};
    const date = text.match(/תאריך[^\d\n]{0,12}(\d{1,2})\/(\d{1,2})\/(\d{2,4})/) || text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (date) {
      let y = date[3].length === 2 ? `20${date[3]}` : date[3];
      const now = new Date();
      const thisYear = now.getFullYear();
      // A misread year (2646, 2O26): use this year, or last year if that would be in the future.
      if (+y < thisYear - 2 || +y > thisYear) {
        const monthDay = `${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}`;
        const today = now.toISOString().slice(5, 10);
        y = String(monthDay > today ? thisYear - 1 : thisYear);
      }
      const m = +date[2], d = +date[1];
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) out.date = `${y}-${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}`;
    }
    const time = text.match(/שעה\s*:?\s*(\d{1,2}:\d{2})/) || text.match(/(\d{1,2}:\d{2})\s*\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}\/\d{1,2}\/\d{2,4}\s*(\d{1,2}:\d{2})/);
    if (time) out.time = time[1] || time[2];
    const invoice = text.match(/חשבונית\s*\/?\s*קבלה\s*(\d{6,})/);
    if (invoice) out.invoice = invoice[1];
    const paid = text.match(/סה["״]?כ\s*שולם\s*:?\s*(\d+\.\d{2})/);
    if (paid) out.total = parseFloat(paid[1]);
    return out;
  }

  /** Is this OCR text a Shufersal receipt? */
  function looksLikeShufersal(text) {
    return /שופרסל|shufersal/i.test(String(text || ''));
  }

  /**
   * Rows (from buildRows) + the full OCR text → the same shape as
   * ReceiptParser.parse(), so the rest of the app doesn't care which chain it was.
   */
  function parseRows(rows, fullText, opts = {}) {
    const paper = !!opts.paper; // a photo of a paper receipt: stricter, and no reliable header words
    const header = parseHeader(fullText || '');
    const items = [];
    let pending = null; // an item waiting for its quantity row
    let started = false;
    let endIndex = rows.length;
    let lastItemRow = -1; // where to look for the total when no "to pay" line was read
    const minCode = paper ? 4 : 2;

    const close = () => {
      if (pending && pending.total != null) items.push(pending);
      pending = null;
    };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const desc = fixTimes(r.desc);
      let amount = parseAmount(r.amount);
      // photos: "4990" — the decimal point was too faint to read
      const bare = r.amount.replace(/\.+$/, '');
      if (amount == null && paper && /^-?\d{3,4}$/.test(bare)) amount = parseFloat(bare) / 100;
      if (!started) {
        if (/קוד|תאור|לתשלום/.test(desc) && /תאור/.test(desc)) started = true; // table header
        else if (r.code.length >= minCode && amount != null) started = true; // header missed by OCR
        else continue;
        if (/תאור/.test(desc)) continue;
      }
      const toPay = paper && r.code.length < minCode && amount != null && amount > 0 && looksLikeToPay(desc);
      if (((paper ? AFTER_ITEMS : END_ROW).test(desc) || toPay) && r.code.length < minCode) {
        close();
        endIndex = i;
        // the amount on the "to pay" line is the total
        if (paper && header.total == null && amount != null && amount > 0 && (toPay || /לתשלום/.test(desc))) header.total = amount;
        break;
      }

      const weight = desc.match(WEIGHT_ROW);
      const units = !weight && desc.match(UNITS_ROW);

      // photos: the quantity line as read by the digits pass
      const midQty = pending && pending.total == null && !weight && !units && r.code.length < minCode ? rowQuantity(r, amount) : null;
      if (midQty) {
        Object.assign(pending, midQty);
        close();
        continue;
      }

      if ((weight || units) && pending) {
        const qty = parseFloat((weight || units)[1]);
        const unitPrice = parseFloat((weight || units)[2]);
        pending.qty = qty;
        pending.unitPrice = unitPrice;
        pending.weighted = !!weight;
        pending.total = amount != null && amount > 0 ? amount : round2(qty * unitPrice);
        close();
        continue;
      }

      if (amount != null && amount < 0) {
        close();
        const last = items[items.length - 1];
        if (last) last.discount = round2(last.discount + amount);
        continue;
      }

      // photos: an item whose price line didn't read as a quantity line
      if (paper && pending && pending.total == null && r.code.length < minCode && amount != null && amount > 0) {
        pending.total = amount;
        pending.unitPrice = amount;
        close();
        continue;
      }

      // photos: produce has short in-store codes ("22", "481"); trust one only
      // when the next line is its weight or quantity
      const next = rows[i + 1];
      const shortCode =
        paper && r.code.length >= 2 && r.code.length < minCode && amount == null && next && !next.code &&
        rowQuantity(next, parseAmount(next.amount)) != null;

      if (r.code.length >= minCode || shortCode) {
        lastItemRow = i;
        close();
        pending = { row: i, code: fixBarcode(r.code), name: desc, unitPrice: null, qty: 1, total: null, discount: 0, weighted: false };
        if (amount != null && amount > 0) {
          pending.total = amount;
          pending.unitPrice = amount;
        }
        continue;
      }

      // A row with only text: the second line of a long name or of a discount. Skip it.
    }
    close();

    for (const it of items) {
      if (it.unitPrice == null) it.unitPrice = it.total;
      it.name = it.name.replace(/\s+/g, ' ').trim();
    }

    // Paper receipts: the "to pay" word is often unreadable. The total is then
    // the first line after some items whose amount is paid by the lines below it
    // (one payment, or several: 200.00 + 265.75), or that equals the items above.
    if (header.total == null && paper) {
      const amountAt = (j) => {
        const r = rows[j];
        if (!r || r.code.length >= minCode) return null;
        const a = parseAmount(r.amount);
        return a != null && a > 0 ? a : null;
      };
      const close2 = (a, b) => Math.abs(a - b) <= Math.max(0.15, a * 0.002);
      for (let j = items.length ? items[0].row + 1 : rows.length; j < rows.length; j++) {
        const a = amountAt(j);
        if (a == null) continue;
        const before = items.filter((it) => it.row < j);
        const sumBefore = round2(before.reduce((s, it) => s + it.total + it.discount, 0));
        if (!before.length || a < sumBefore * 0.5) continue;
        let paidBelow = 0, matched = close2(a, sumBefore);
        for (let k = j + 1; k < Math.min(rows.length, j + 8) && !matched; k++) {
          const b = amountAt(k);
          if (b == null) continue;
          paidBelow = round2(paidBelow + b);
          if (close2(a, paidBelow)) matched = true;
          if (paidBelow > a + 1) break;
        }
        if (matched) {
          header.total = a;
          // anything read as an item below the total is payment details
          for (let n = items.length - 1; n >= 0; n--) if (items[n].row > j) items.splice(n, 1);
          break;
        }
      }
    }
    const sum = round2(items.reduce((s, i) => s + i.total + i.discount, 0));
    for (const it of items) delete it.row;

    // Otherwise: an amount after the items equal to the sum, or one that repeats
    // (it's printed as the total and again as the payment).
    if (header.total == null && paper) {
      const from = endIndex < rows.length ? endIndex : lastItemRow + 1;
      const after = rows.slice(from).map((r) => parseAmount(r.amount)).filter((a) => a != null && a > 0);
      const equal = after.find((a) => Math.abs(a - sum) < 0.01);
      if (equal != null) header.total = equal;
      else {
        const counts = new Map();
        for (const a of after) counts.set(a, (counts.get(a) || 0) + 1);
        const repeated = Array.from(counts.entries()).filter(([a, n]) => n >= 2 && a >= sum * 0.5).sort((a, b) => b[1] - a[1])[0];
        if (repeated) header.total = repeated[0];
      }
    }

    const warnings = [];
    if (!items.length) warnings.push('לא נמצאו מוצרים בקבלה.');
    else if (header.total != null && Math.abs(sum - header.total) > 0.1) {
      warnings.push(`סכום המוצרים (₪${sum}) לא תואם לסה״כ בקבלה (₪${header.total}). ייתכן שחלק מהשורות לא נקראו נכון.`);
    }
    if (!header.date) warnings.push('לא נמצא תאריך קנייה בקבלה.');

    return {
      chain: opts.chain || { id: 'shufersal', name: 'שופרסל' },
      totalFound: header.total != null,
      date: header.date || null,
      time: header.time || '',
      invoice: header.invoice || '',
      branch: '',
      total: header.total != null ? header.total : sum,
      itemsSum: sum,
      items,
      warnings,
    };
  }

  const api = { buildRows, parseRows, parseAmount, pickCode, midQuantity, rowQuantity, looksLikeToPay, fixTimes, fixBarcode, eanValid, looksLikeShufersal, CODE_FROM, AMOUNT_TO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shufersal = api;
})(typeof window !== 'undefined' ? window : globalThis);
