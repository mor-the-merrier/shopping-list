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
  function buildRows({ words, codeWords, amountWords, width, codeFrom, amountTo }) {
    const cFrom = codeFrom != null ? codeFrom : width * CODE_FROM;
    const aTo = amountTo != null ? amountTo : width * AMOUNT_TO;
    const all = [];
    for (const w of words) {
      if (centerX(w) < aTo) continue; // the price column comes from the digit pass
      all.push({ kind: 'desc', w });
    }
    // A barcode never has "." or ":" (those are prices, percentages or times).
    for (const w of codeWords) if (!/[.:]/.test(w.text)) all.push({ kind: 'code', w });
    for (const w of amountWords) all.push({ kind: 'amount', w });
    all.sort((a, b) => centerY(a.w) - centerY(b.w));

    const heights = all.map((a) => a.w.bbox.y1 - a.w.bbox.y0).filter((h) => h > 0).sort((a, b) => a - b);
    const lineH = heights.length ? heights[Math.floor(heights.length / 2)] : 20;
    const tolerance = lineH * 0.6;

    const rows = [];
    for (const a of all) {
      const y = centerY(a.w);
      let row = rows.length ? rows[rows.length - 1] : null;
      if (!row || Math.abs(row.y - y) > tolerance) {
        row = { y, desc: [], code: [], amount: [] };
        rows.push(row);
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
      code: codeWord ? codeWord.text.replace(/\D/g, '') : '',
      // right-to-left reading order for the Hebrew description
      desc: r.desc
        .filter((w) => centerX(w) < descEdge)
        .sort((a, b) => b.bbox.x1 - a.bbox.x1)
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      amount: r.amount.map((w) => w.text).join('').replace(/[^\d.-]/g, ''),
      };
    });
  }

  /** "2.12-" or "-2.12" → -2.12; "14.89" → 14.89; no decimal point → null (not a price). */
  function parseAmount(s) {
    // the first price-shaped number; stray digits stuck to it are OCR noise
    const m = String(s || '').match(/(-?)(\d{1,4}\.\d{2})(-?)/);
    if (!m) return null;
    const v = parseFloat(m[2]);
    return m[1] || m[3] ? -v : v;
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
    return c;
  }

  const WEIGHT_ROW = /ק["״'׳]?ג\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/;
  const UNITS_ROW = /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*ליחיד/;
  const END_ROW = /לתשלום|שולם|סה["״]?כ/;
  // Paper receipts: rows that come after the items (VAT, payment, item count).
  const AFTER_ITEMS = /לתשלום|שולם|סה["״]?כ|מע["״]?מ|חייב|אשראי|מזומן|עודף|פריטים|תשלום/;

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
      const amount = parseAmount(r.amount);
      if (!started) {
        if (/קוד|תאור|לתשלום/.test(desc) && /תאור/.test(desc)) started = true; // table header
        else if (r.code.length >= minCode && amount != null) started = true; // header missed by OCR
        else continue;
        if (/תאור/.test(desc)) continue;
      }
      if ((paper ? AFTER_ITEMS : END_ROW).test(desc) && r.code.length < minCode) {
        close();
        endIndex = i;
        break;
      }

      const weight = desc.match(WEIGHT_ROW);
      const units = !weight && desc.match(UNITS_ROW);

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

      if (r.code.length >= minCode) {
        lastItemRow = i;
        close();
        pending = { code: fixBarcode(r.code), name: desc, unitPrice: null, qty: 1, total: null, discount: 0, weighted: false };
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

    const sum = round2(items.reduce((s, i) => s + i.total + i.discount, 0));

    // Paper receipts: the "to pay" word is often unreadable, so find the total
    // among the amounts after the items: one equal to the sum, or one that
    // repeats (it's printed as the total and again as the payment).
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

  const api = { buildRows, parseRows, parseAmount, fixTimes, fixBarcode, eanValid, looksLikeShufersal, CODE_FROM, AMOUNT_TO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shufersal = api;
})(typeof window !== 'undefined' ? window : globalThis);
