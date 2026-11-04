/*
 * Photos of paper receipts.
 *
 * 1. Clean the photo (pure pixel functions, no canvas, so they're testable):
 *    find the paper, drop colored print showing through from the back
 *    (keep the brightest channel: black text stays dark, colored ink turns
 *    light), even out shadows by dividing by a blurred copy, then black/white.
 * 2. Find the columns: the price column (left) and barcode column (right),
 *    from where the prices sit in the first, Hebrew reading.
 * 3. Several photos of one long receipt: put them in order and drop the
 *    lines that appear twice where the photos overlap.
 *
 * The OCR itself and the canvas work are in js/ocr.js; rows → items in js/shufersal.js.
 */
(function (root) {
  'use strict';

  // ---------- 1. cleaning ----------

  /** Bounding box of the receipt paper: bright and nearly gray pixels. */
  function findPaper(rgba, width, height) {
    const rows = new Uint32Array(height);
    const cols = new Uint32Array(width);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
        const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
        if (mx > 150 && mx - mn < 45) {
          rows[y]++;
          cols[x]++;
        }
      }
    }
    const first = (arr, n, min) => {
      for (let i = 0; i < arr.length; i++) if (arr[i] > n * min) return i;
      return 0;
    };
    const last = (arr, n, min) => {
      for (let i = arr.length - 1; i >= 0; i--) if (arr[i] > n * min) return i;
      return arr.length - 1;
    };
    let y0 = first(rows, width, 0.25), y1 = last(rows, width, 0.25);
    let x0 = first(cols, height, 0.25), x1 = last(cols, height, 0.25);
    // Too small to be the receipt (a white table, a screenshot): use the whole picture.
    if ((x1 - x0) < width * 0.2 || (y1 - y0) < height * 0.2) return { x0: 0, y0: 0, x1: width - 1, y1: height - 1 };
    const padX = Math.round(width * 0.005), padY = Math.round(height * 0.005);
    x0 = Math.max(0, x0 - padX); y0 = Math.max(0, y0 - padY);
    x1 = Math.min(width - 1, x1 + padX); y1 = Math.min(height - 1, y1 + padY);
    return { x0, y0, x1, y1 };
  }

  /** RGBA → gray using the brightest channel (colored ink and show-through fade away). */
  function maxChannel(rgba, width, height) {
    const out = new Uint8ClampedArray(width * height);
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      out[p] = r > g ? (r > b ? r : b) : g > b ? g : b;
    }
    return out;
  }

  /** Divide by the local average brightness: shadows and gradients disappear. */
  function evenLight(gray, width, height, radius) {
    const W1 = width + 1;
    const sat = new Uint32Array(W1 * (height + 1)); // summed-area table
    for (let y = 1; y <= height; y++) {
      let rowSum = 0;
      for (let x = 1; x <= width; x++) {
        rowSum += gray[(y - 1) * width + (x - 1)];
        sat[y * W1 + x] = sat[(y - 1) * W1 + x] + rowSum;
      }
    }
    const out = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      const ya = Math.max(0, y - radius), yb = Math.min(height, y + radius + 1);
      for (let x = 0; x < width; x++) {
        const xa = Math.max(0, x - radius), xb = Math.min(width, x + radius + 1);
        const sum = sat[yb * W1 + xb] - sat[ya * W1 + xb] - sat[yb * W1 + xa] + sat[ya * W1 + xa];
        const mean = sum / ((xb - xa) * (yb - ya));
        out[y * width + x] = (gray[y * width + x] / (mean + 1)) * 255;
      }
    }
    return out;
  }

  function threshold(gray, level) {
    const out = new Uint8ClampedArray(gray.length);
    for (let i = 0; i < gray.length; i++) out[i] = gray[i] < level ? 0 : 255;
    return out;
  }

  /** Thicken dark strokes by one pixel (dot-matrix digits read better). */
  function thicken(bin, width, height) {
    const out = new Uint8ClampedArray(bin.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 255;
        for (let dy = -1; dy <= 1 && v; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < width && bin[yy * width + xx] === 0) {
              v = 0;
              break;
            }
          }
        }
        out[y * width + x] = v;
      }
    }
    return out;
  }

  /**
   * The full cleaning step on an already cropped and scaled picture.
   * Returns { text, digits }: gray arrays for the Hebrew/price passes and the barcode pass.
   */
  const CLEAN = { radiusDiv: 40, textLevel: 210, digitsLevel: 205 };

  function cleanForOcr(rgba, width, height, opts = {}) {
    const o = Object.assign({}, CLEAN, opts);
    const gray = maxChannel(rgba, width, height);
    const even = evenLight(gray, width, height, Math.max(12, Math.round(width / o.radiusDiv)));
    const text = threshold(even, o.textLevel);
    const digits = thicken(threshold(even, o.digitsLevel), width, height);
    return { text, digits };
  }

  // ---------- 2. columns ----------

  const AMOUNT = /^-?\d{1,4}[.,]\d{2}-?$/;
  const NOISE = /^[|[\]\-_.,:;'"`~=—–]+$/;

  /**
   * From the Hebrew reading's words (full-image pixels), find where the price
   * column ends (left side) and where the barcode column starts (right side).
   */
  function findColumns(words, width) {
    const clean = words.filter((w) => !NOISE.test(w.text) && w.bbox.x1 - w.bbox.x0 > width * 0.012);
    const heights = clean.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const lineH = heights.length ? heights[Math.floor(heights.length / 2)] : 30;

    // group into lines by vertical position
    const sorted = clean.slice().sort((a, b) => a.bbox.y0 + a.bbox.y1 - (b.bbox.y0 + b.bbox.y1));
    const lines = [];
    for (const w of sorted) {
      const y = (w.bbox.y0 + w.bbox.y1) / 2;
      const line = lines[lines.length - 1];
      if (line && Math.abs(line.y - y) < lineH * 0.6) line.words.push(w);
      else lines.push({ y, words: [w] });
    }

    // Item lines: a price on the left. Barcodes are right-aligned, so on each
    // item line the barcode is whatever ends at the right margin (the Hebrew
    // reading may split it, or miss it on a line — then that line doesn't count).
    const items = [];
    for (const line of lines) {
      const ws = line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
      if (ws.length >= 2 && AMOUNT.test(ws[0].text) && ws[0].bbox.x1 < width * 0.45) items.push(ws);
    }
    const margin = items.length ? Math.max(...items.map((ws) => Math.max(...ws.map((w) => w.bbox.x1)))) : width;
    const amountRight = [];
    const codeLeft = [];
    for (const ws of items) {
      amountRight.push(ws[0].bbox.x1);
      const atMargin = ws.filter((w) => w.bbox.x1 >= margin - width * 0.04 && w.bbox.x0 > width * 0.5);
      if (atMargin.length) codeLeft.push(Math.min(...atMargin.map((w) => w.bbox.x0)));
    }
    if (amountRight.length && !codeLeft.length) codeLeft.push(width * 0.7);
    // where the items end: the total, VAT and payment lines come after this
    const itemsEnd = items.length ? Math.max(...items.map((ws) => Math.max(...ws.map((w) => w.bbox.y1)))) : 0;
    if (!amountRight.length) return { amountTo: Math.round(width * 0.28), codeFrom: Math.round(width * 0.7), found: false, itemsEnd };
    const pad = width * 0.02;
    return {
      amountTo: Math.round(Math.max(...amountRight) + pad),
      // generous: the strip may include the end of names; the rightmost number per line is the code
      codeFrom: Math.round(Math.max(width * 0.5, Math.min(Math.min(...codeLeft) - pad, width * 0.62))),
      found: true,
      itemLines: amountRight.length,
      itemsEnd,
    };
  }

  // ---------- the big "to pay" line ----------

  /**
   * Text lines (y ranges) in a black/white picture from row fromY down.
   * Separator rules (ink spread across most of the width) count as gaps.
   */
  function lineBands(gray, width, height, fromY = 0) {
    const edge = Math.round(width * 0.015);
    const inkRow = new Uint8Array(height);
    for (let y = Math.max(0, fromY); y < height; y++) {
      let count = 0, first = -1, last = -1;
      for (let x = edge; x < width - edge; x++) {
        if (gray[y * width + x] < 128) {
          count++;
          if (first < 0) first = x;
          last = x;
        }
      }
      const rule = last - first > width * 0.6 && count > width * 0.08;
      inkRow[y] = count > width * 0.004 && !rule ? 1 : 0;
    }
    const bands = [];
    let start = -1;
    for (let y = Math.max(0, fromY); y <= height; y++) {
      const on = y < height && inkRow[y];
      if (on && start < 0) start = y;
      if (!on && start >= 0) {
        if (y - start > 8) bands.push({ y0: start, y1: y });
        start = -1;
      }
    }
    return bands;
  }

  /**
   * Many receipts print the total in double-height digits next to "לתשלום".
   * OCR expects uniform text, so find that tall line below the items and the
   * amount at its left; ocr.js squashes it to normal proportions and reads it.
   * Returns { x0, y0, x1, y1, squash } or null.
   */
  function bigTotalBox(gray, width, height, fromY) {
    const bands = lineBands(gray, width, height, fromY);
    if (bands.length < 2) return null;
    const hs = bands.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
    const med = hs[Math.floor(hs.length / 2)];
    const tall = bands.slice(0, 4).find((b) => b.y1 - b.y0 >= med * 1.4);
    if (!tall) return null;

    // words on that line: runs of ink columns separated by more than ~half a letter height
    const edge = Math.round(width * 0.015);
    const runs = [];
    let s = -1, e = -1, gap = 0;
    for (let x = edge; x < width - edge + med; x++) {
      let ink = false;
      if (x < width - edge) {
        for (let y = tall.y0; y < tall.y1 && !ink; y++) if (gray[y * width + x] < 128) ink = true;
      }
      if (ink) {
        if (s < 0) s = x;
        e = x;
        gap = 0;
      } else if (s >= 0 && ++gap > med * 0.6) {
        if (e - s > med * 0.3) runs.push({ x0: s, x1: e });
        s = -1;
      }
    }
    if (!runs.length) return null;
    const amount = runs[0]; // right-to-left receipt: the amount is left of "לתשלום"
    const pad = Math.round(med * 0.2);
    return {
      x0: Math.max(0, amount.x0 - pad),
      x1: Math.min(width, amount.x1 + pad),
      y0: Math.max(0, tall.y0 - 2),
      y1: Math.min(height, tall.y1 + 2),
      squash: med / (tall.y1 - tall.y0),
    };
  }

  // ---------- the total ----------

  const PRICE = /(\d{1,5})[.,](\d{2})(?!\d)/;
  const TO_PAY = /לתשל|תשלו|שלום|לתש|סה["״]?כ/;

  /**
   * The receipt's total, from a digits-only reading of the area below the items
   * (footerWords) and the Hebrew reading (words, to spot "לתשלום").
   * Order: the amount on the "to pay" line; an amount equal to the lines' sum;
   * the first amount below the items (on Israeli receipts that's "to pay").
   */
  function findTotal(footerWords, words, itemsSum, bigTotal) {
    // The double-height "to pay" amount, read on its own (once or more): trust a
    // reading that equals the lines' sum, then one the readings agree on, then the first.
    const big = (Array.isArray(bigTotal) ? bigTotal : bigTotal != null ? [bigTotal] : [])
      .map((t) => String(t).match(PRICE))
      .filter(Boolean)
      .map((m) => parseFloat(`${m[1]}.${m[2]}`));
    if (big.length) {
      const sum = big.find((v) => Math.abs(v - itemsSum) < 0.01);
      if (sum != null) return { value: sum, how: 'big' };
      const agreed = big.find((v, i) => big.indexOf(v) !== i);
      if (agreed != null) return { value: agreed, how: 'big' };
      const alsoBelow = big.find((v) => footerWords.some((w) => (String(w.text).match(PRICE) || [])[0] === v.toFixed(2)));
      if (alsoBelow != null) return { value: alsoBelow, how: 'big' }; // printed again as the payment
      return { value: big[0], how: 'big' };
    }
    const heights = footerWords.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const lineH = heights.length ? heights[Math.floor(heights.length / 2)] : 40;
    const amounts = [];
    for (const w of footerWords) {
      const m = String(w.text).match(PRICE);
      if (!m) continue;
      amounts.push({ value: parseFloat(`${m[1]}.${m[2]}`), y: (w.bbox.y0 + w.bbox.y1) / 2, h: w.bbox.y1 - w.bbox.y0 });
    }
    if (!amounts.length) return null;
    amounts.sort((a, b) => a.y - b.y);

    const label = words.find((w) => TO_PAY.test(w.text) && amounts.some((a) => Math.abs((w.bbox.y0 + w.bbox.y1) / 2 - a.y) < Math.max(lineH, a.h) * 0.7));
    if (label) {
      const ly = (label.bbox.y0 + label.bbox.y1) / 2;
      const onLine = amounts.filter((a) => Math.abs(a.y - ly) < Math.max(lineH, a.h) * 0.7);
      if (onLine.length) return { value: onLine[0].value, how: 'label' };
    }
    const equal = amounts.find((a) => Math.abs(a.value - itemsSum) < 0.01);
    if (equal) return { value: equal.value, how: 'sum' };
    const first = amounts.find((a) => a.value > 0);
    return first ? { value: first.value, how: 'first' } : null;
  }

  // ---------- store name ----------

  const KNOWN = [
    { id: 'shufersal', name: 'שופרסל', match: /שופרסל/ },
    { id: 'rami-levy', name: 'רמי לוי', match: /רמי\s*לוי/ },
    { id: 'yohananof', name: 'יוחננוף', match: /יוחננוף/ },
    { id: 'victory', name: 'ויקטורי', match: /ויקטורי/ },
    { id: 'osher-ad', name: 'אושר עד', match: /אושר\s*עד/ },
    { id: 'super-koach', name: 'סופר כח', match: /סופר\s*כ[חה]/ },
    { id: 'yeinot-bitan', name: 'יינות ביתן', match: /יינות\s*ביתן/ },
    { id: 'tiv-taam', name: 'טיב טעם', match: /טיב\s*טעם/ },
    { id: 'hatzi-hinam', name: 'חצי חינם', match: /חצי\s*חינם/ },
    { id: 'carrefour', name: 'קרפור', match: /קרפור|carrefour/i },
    { id: 'super-pharm', name: 'סופר-פארם', match: /סופר[\s-]*פארם/ },
  ];

  const storeId = (name) => String(name).trim().toLowerCase().replace(/["״׳']/g, '').replace(/\s+/g, '-');

  /** A known chain mentioned in the text, or null (the user types it in then). */
  function detectStore(text) {
    const hit = KNOWN.find((k) => k.match.test(String(text || '')));
    return hit ? { id: hit.id, name: hit.name } : null;
  }

  function storeFromName(name) {
    const hit = KNOWN.find((k) => k.match.test(name) || k.name === name.trim());
    return hit ? { id: hit.id, name: hit.name } : { id: storeId(name), name: String(name).trim() };
  }

  /** Put the total found below the items on a parsed photo, and flag a mismatch. */
  function applyTotal(parsed, reading) {
    if (parsed.totalFound || !parsed.items.length) return parsed;
    const t = findTotal(reading.footerWords || [], reading.words || [], parsed.itemsSum, reading.bigTotal);
    if (!t) return parsed;
    parsed.total = t.value;
    parsed.totalFound = true;
    parsed.totalHow = t.how;
    parsed.warnings = parsed.warnings.filter((w) => !/סה״כ|לא תואם/.test(w));
    if (Math.abs(parsed.itemsSum - t.value) > 0.1) {
      parsed.warnings.push(`סכום המוצרים (₪${parsed.itemsSum}) לא תואם לסה״כ בקבלה (₪${t.value}). אפשר לתקן את השורות למטה.`);
    }
    return parsed;
  }

  // ---------- 3. several photos ----------

  const round2 = (n) => Math.round(n * 100) / 100;
  const sameLine = (a, b) =>
    Math.abs(a.total - b.total) < 0.01 && (a.code && b.code ? a.code === b.code : true);

  /**
   * Parsed photos (in shooting order) → one receipt.
   * The photo that has the date goes first, the one with the total last;
   * lines repeated where two photos overlap are dropped.
   */
  function mergePhotos(parts) {
    if (parts.length === 1) return parts[0];
    const ordered = parts.slice();
    const head = ordered.findIndex((p) => p.date);
    if (head > 0) ordered.unshift(ordered.splice(head, 1)[0]);
    const tail = ordered.findIndex((p, i) => i > 0 && p.totalFound);
    if (tail > 0 && tail < ordered.length - 1) ordered.push(ordered.splice(tail, 1)[0]);

    const items = [];
    let dropped = 0;
    for (const part of ordered) {
      const next = part.items;
      // largest k where the last k lines so far equal the first k of this photo
      let overlap = 0;
      for (let k = Math.min(items.length, next.length, 8); k > 0; k--) {
        let ok = true;
        for (let j = 0; j < k && ok; j++) ok = sameLine(items[items.length - k + j], next[j]);
        if (ok) {
          overlap = k;
          break;
        }
      }
      dropped += overlap;
      items.push(...next.slice(overlap).map((it) => Object.assign({}, it)));
    }

    const first = ordered[0];
    const withTotal = ordered.slice().reverse().find((p) => p.totalFound);
    const sum = round2(items.reduce((s, i) => s + i.total + i.discount, 0));
    const total = withTotal ? withTotal.total : sum;
    const warnings = [];
    if (!items.length) warnings.push('לא נמצאו מוצרים בקבלה.');
    else if (withTotal && Math.abs(sum - total) > 0.1) {
      warnings.push(`סכום המוצרים (₪${sum}) לא תואם לסה״כ בקבלה (₪${total}). אפשר לתקן את השורות למטה.`);
    }
    return Object.assign({}, first, {
      date: (ordered.find((p) => p.date) || {}).date || null,
      time: (ordered.find((p) => p.time) || {}).time || '',
      totalFound: !!withTotal,
      total,
      itemsSum: sum,
      items,
      warnings,
      overlapDropped: dropped,
    });
  }

  const api = { CLEAN, findPaper, maxChannel, evenLight, threshold, thicken, cleanForOcr, findColumns, findTotal, applyTotal, lineBands, bigTotalBox, detectStore, storeFromName, mergePhotos, KNOWN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PaperReceipt = api;
})(typeof window !== 'undefined' ? window : globalThis);
