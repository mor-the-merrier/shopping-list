/*
 * Shufersal digital receipts.
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
   */
  function buildRows({ words, codeWords, amountWords, width }) {
    const all = [];
    for (const w of words) {
      const x = centerX(w);
      if (x > width * CODE_FROM || x < width * AMOUNT_TO) continue; // number columns come from the digit passes
      all.push({ kind: 'desc', w });
    }
    for (const w of codeWords) all.push({ kind: 'code', w });
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

    return rows.map((r) => ({
      y: Math.round(r.y),
      code: r.code.map((w) => w.text).join('').replace(/\D/g, ''),
      // right-to-left reading order for the Hebrew description
      desc: r.desc
        .sort((a, b) => b.bbox.x1 - a.bbox.x1)
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      amount: r.amount.map((w) => w.text).join('').replace(/[^\d.-]/g, ''),
    }));
  }

  /** "2.12-" or "-2.12" → -2.12; "14.89" → 14.89; no decimal point → null (not a price). */
  function parseAmount(s) {
    const m = String(s || '').match(/^(-?)(\d+\.\d{1,2})(-?)$/);
    if (!m) return null;
    const v = parseFloat(m[2]);
    return m[1] || m[3] ? -v : v;
  }

  /** OCR often reads the "x" between numbers as the Hebrew letter א. */
  function fixTimes(s) {
    return String(s || '').replace(/(\d)\s*[אxX×*]\s*(\d)/g, '$1 x $2').replace(/[‎‏‪-‮]/g, '');
  }

  const WEIGHT_ROW = /ק["״'׳]?ג\s*(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)/;
  const UNITS_ROW = /(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*ליחיד/;
  const END_ROW = /לתשלום|שולם|סה["״]?כ/;

  function parseHeader(text) {
    const out = {};
    const date = text.match(/תאריך[^\d\n]{0,12}(\d{1,2})\/(\d{1,2})\/(\d{2,4})/) || text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (date) {
      const y = date[3].length === 2 ? `20${date[3]}` : date[3];
      out.date = `${y}-${date[2].padStart(2, '0')}-${date[1].padStart(2, '0')}`;
    }
    const time = text.match(/שעה\s*:?\s*(\d{1,2}:\d{2})/);
    if (time) out.time = time[1];
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
  function parseRows(rows, fullText) {
    const header = parseHeader(fullText || '');
    const items = [];
    let pending = null; // an item waiting for its quantity row
    let started = false;

    const close = () => {
      if (pending && pending.total != null) items.push(pending);
      pending = null;
    };

    for (const r of rows) {
      const desc = fixTimes(r.desc);
      const amount = parseAmount(r.amount);
      if (!started) {
        if (/קוד|תאור|לתשלום/.test(desc) && /תאור/.test(desc)) started = true; // table header
        else if (r.code.length >= 2 && amount != null) started = true; // header missed by OCR
        else continue;
        if (/תאור/.test(desc)) continue;
      }
      if (END_ROW.test(desc) && !r.code) {
        close();
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

      if (r.code.length >= 2) {
        close();
        pending = { code: r.code, name: desc, unitPrice: null, qty: 1, total: null, discount: 0, weighted: false };
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
    const warnings = [];
    if (!items.length) warnings.push('לא נמצאו מוצרים בקבלה.');
    else if (header.total != null && Math.abs(sum - header.total) > 0.1) {
      warnings.push(`סכום המוצרים (₪${sum}) לא תואם לסה״כ בקבלה (₪${header.total}). ייתכן שחלק מהשורות לא נקראו נכון.`);
    }
    if (!header.date) warnings.push('לא נמצא תאריך קנייה בקבלה.');

    return {
      chain: { id: 'shufersal', name: 'שופרסל' },
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

  const api = { buildRows, parseRows, parseAmount, fixTimes, looksLikeShufersal, CODE_FROM, AMOUNT_TO };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shufersal = api;
})(typeof window !== 'undefined' ? window : globalThis);
