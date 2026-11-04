/*
 * Checking a photographed receipt against what's known, so nobody has to go
 * over it line by line.
 *
 * OCR of a dot-matrix receipt gets most digits right, but the last digit of a
 * number is often wrong (14.54 → 14.56, 7290012117091 → 7290012117031).
 * Three kinds of evidence fix most of that:
 *
 *  1. Barcodes: a barcode that isn't in the national list (or among the user's
 *     own products) but is one digit away from exactly one that is, is that one.
 *  2. Prices: a price one digit away from the shelf price of that barcode
 *     (data/prices.json) or from what the user paid for it before is that price.
 *  3. The total printed on the receipt wins. When the lines don't add up to it,
 *     the smallest set of likely corrections (a last digit, a known price)
 *     that makes them add up exactly is applied, if there's one clear answer.
 *
 * Each line ends up with `sure`: true when its amount is backed by arithmetic
 * (weight × price), a known price, or the total. The review screen only asks
 * about the others.
 *
 * Pure logic, testable in Node.
 */
(function (root) {
  'use strict';

  const round2 = (n) => Math.round(n * 100) / 100;
  const cents = (n) => Math.round(n * 100);

  function eanValid(code) {
    if (!/^\d{13}$/.test(code)) return false;
    const d = Array.from(code, Number);
    const sum = d.slice(0, 12).reduce((s, n, i) => s + n * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === d[12];
  }

  /** Codes one edit away: one digit changed, or one digit too many / too few. */
  function nearCodes(code) {
    const out = new Set();
    for (let i = 0; i < code.length; i++) {
      for (let d = 0; d <= 9; d++) {
        if (String(d) === code[i]) continue;
        out.add(code.slice(0, i) + d + code.slice(i + 1));
      }
      out.add(code.slice(0, i) + code.slice(i + 1)); // a stray digit
    }
    for (let i = 0; i <= code.length; i++) for (let d = 0; d <= 9; d++) out.add(code.slice(0, i) + d + code.slice(i)); // a lost digit
    out.delete(code);
    return Array.from(out).filter((c) => c.length >= 2 && (c.length !== 13 || eanValid(c)));
  }

  /** How alike two Hebrew names look, 0..1 (shared letter pairs). */
  function nameLikeness(a, b) {
    const pairs = (s) => {
      const t = String(s || '').replace(/[^א-ת]/g, '');
      const out = [];
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
      return out;
    };
    const A = pairs(a), B = pairs(b);
    if (!A.length || !B.length) return 0;
    const pool = B.slice();
    let hit = 0;
    for (const p of A) {
      const k = pool.indexOf(p);
      if (k >= 0) {
        hit++;
        pool.splice(k, 1);
      }
    }
    return (2 * hit) / (A.length + B.length);
  }

  /** Barcodes two digits away (13 digits only, valid check digit). */
  function twoDigitsAway(code) {
    const out = [];
    if (code.length !== 13) return out;
    for (let i = 0; i < 12; i++)
      for (let j = i + 1; j < 13; j++)
        for (let a = 0; a <= 9; a++) {
          if (String(a) === code[i]) continue;
          for (let b = 0; b <= 9; b++) {
            if (String(b) === code[j]) continue;
            const c = code.slice(0, i) + a + code.slice(i + 1, j) + b + code.slice(j + 1);
            if (eanValid(c)) out.push(c);
          }
        }
    return out;
  }

  /**
   * The barcode a misread one most likely is: a known code one or two digits
   * away, weighed by how close, whether its name looks like the name that was
   * read, and whether its price is this line's price. With nothing close, a
   * 13-digit code just gets its check digit worked out.
   */
  function fixCode(it, isKnown, pricesOf, nameOf) {
    const price = it.unitPrice || it.total;
    const scored = [];
    const score = (c, edits) => {
      const like = nameLikeness(it.ocrName || it.name, nameOf(c));
      const priced = pricesOf(c).some((p) => Math.abs(p - price) < 0.005);
      return edits - 1.6 * like - (priced ? 1.2 : 0);
    };
    for (const c of nearCodes(it.code)) if (isKnown(c)) scored.push({ c, s: score(c, 1), like: nameLikeness(it.ocrName || it.name, nameOf(c)) });
    // two digits off only when the name or price backs it up
    for (const c of twoDigitsAway(it.code)) {
      if (!isKnown(c)) continue;
      // two misread digits happen, but so do look-alike barcodes: the name must agree too
      if (nameLikeness(it.ocrName || it.name, nameOf(c)) < 0.25) continue;
      const s = score(c, 2);
      if (s < 1.2) scored.push({ c, s });
    }
    scored.sort((x, y) => x.s - y.s);
    if (scored.length) return scored.length === 1 || scored[1].s - scored[0].s >= 0.25 ? scored[0].c : null;
    if (it.code.length === 13 && !eanValid(it.code)) {
      for (let d = 0; d <= 9; d++) if (eanValid(it.code.slice(0, 12) + d)) return it.code.slice(0, 12) + d;
    }
    return null;
  }

  /** Same length, one digit different (the decimal point stays put). */
  function oneDigitApart(a, b) {
    const x = Number(a).toFixed(2), y = Number(b).toFixed(2);
    if (x.length !== y.length) return -1;
    let diff = -1;
    for (let i = 0; i < x.length; i++) {
      if (x[i] === y[i]) continue;
      if (diff >= 0 || x[i] === '.' || y[i] === '.') return -1;
      diff = i;
    }
    return diff < 0 ? -1 : x.length - 1 - diff; // 0 = the last digit
  }

  /**
   * opts:
   *  isKnownCode(code) → true for a barcode in the national list or the user's products
   *  pricesOf(code)    → shelf / earlier prices for that code (unit prices), or []
   *  nameOf(code)      → the product name for a known code (to compare with what was read)
   */
  function checkReceipt(parsed, opts = {}) {
    const isKnown = opts.isKnownCode || (() => false);
    const pricesOf = opts.pricesOf || (() => []);
    const nameOf = opts.nameOf || (() => '');
    const items = parsed.items;

    // ---------- 1. barcodes ----------
    for (const it of items) {
      if (!it.code || isKnown(it.code)) continue;
      const pick = fixCode(it, isKnown, pricesOf, nameOf);
      if (pick && pick !== it.code) {
        it.ocrCode = it.code;
        it.code = pick;
      }
    }

    // ---------- 2. each line's possible amounts ----------
    // {cents delta, cost, apply()} per line; the reading itself is free.
    const options = items.map((it) => {
      const opts2 = [];
      if (it.qtyChecked || it.byHand) {
        it.sure = true; // weight × price already worked out, or typed in by the user
        return opts2;
      }
      const qty = it.qty || 1;
      const refs = it.code ? pricesOf(it.code) : [];
      // two readings of the price (from differently cleaned images) that agree count as sure
      const alt = it.totalAlt;
      const agreed = alt != null && Math.abs(alt - it.total) < 0.005;
      it.sure = agreed || refs.some((p) => Math.abs(p - it.unitPrice) < 0.005);
      if (alt != null && alt > 0 && !agreed && Math.abs(alt - it.total) < 10) {
        opts2.push({ delta: cents(alt) - cents(it.total), cost: 0.4, set: { total: alt, unitPrice: round2(alt / qty) } });
      }
      if (!it.weighted && !refs.some((p) => Math.abs(p - it.unitPrice) < 0.005)) {
        for (const p of refs) {
          const pos = oneDigitApart(p, it.unitPrice);
          if (pos < 0) continue;
          const total = round2(p * qty);
          // taken at once when the two readings disagreed; otherwise only to make the total add up
          const cost = agreed ? 0.7 : pos === 0 ? 0.3 : 0.6;
          opts2.push({ delta: cents(total) - cents(it.total), cost, set: { unitPrice: p, total }, known: true });
        }
      }
      // the last digit of the amount, of any line (weighed ones too)
      const base = cents(it.total);
      for (let d = 0; d <= 9; d++) {
        const v = Math.floor(base / 10) * 10 + d;
        if (v === base || v <= 0) continue;
        const total = v / 100;
        // cheaper on a line whose two readings disagreed
        const cost = agreed ? (d === 0 ? 1.8 : 2) : d === 0 ? 0.8 : 1;
        opts2.push({ delta: v - base, cost, set: { total, unitPrice: it.weighted ? it.unitPrice : round2(total / qty) } });
      }
      // a discount's last digit (discounts are usually round)
      if (it.discount) {
        const b = cents(-it.discount);
        for (let d = 0; d <= 9; d++) {
          const v = Math.floor(b / 10) * 10 + d;
          if (v === b) continue;
          opts2.push({ delta: b - v, cost: d === 0 ? 0.6 : 1.5, set: { discount: -v / 100 } });
        }
      }
      return opts2;
    });

    // known prices one digit away are taken even without a total to check against
    for (let i = 0; i < items.length; i++) {
      const known = options[i].filter((o) => o.known);
      if (known.length === 1 && known[0].cost <= 0.3) {
        Object.assign(items[i], known[0].set);
        items[i].sure = true;
        items[i].fixedBy = 'price';
        options[i] = options[i].filter((o) => !o.known).map((o) => Object.assign({}, o, { delta: o.delta - known[0].delta }));
      }
    }

    const sumOf = () => round2(items.reduce((s, it) => s + it.total + (it.discount || 0), 0));
    let sum = sumOf();

    // ---------- 3. the printed total wins ----------
    const result = { changed: 0, matches: false };
    if (parsed.totalFound && parsed.total != null) {
      const need = cents(parsed.total) - cents(sum);
      if (need === 0) result.matches = true;
      else if (Math.abs(need) <= 2000) {
        const best = cheapestFix(options, need);
        // apply only a clear answer: cheap, and clearly better than the next one
        if (best && best.cost <= 3.6 && best.margin >= 0.25) {
          for (const [i, k] of best.picks) {
            Object.assign(items[i], options[i][k].set);
            items[i].fixedBy = items[i].fixedBy || 'total';
          }
          result.changed = best.picks.length;
          result.matches = true;
        }
      }
      if (result.matches) for (const it of items) it.sure = true;
    }
    sum = sumOf();
    parsed.itemsSum = sum;
    parsed.unsure = items.filter((it) => !it.sure).length;
    parsed.warnings = (parsed.warnings || []).filter((w) => !/לא תואם/.test(w));
    if (parsed.totalFound && Math.abs(sum - parsed.total) > 0.005) {
      parsed.warnings.push(`סכום השורות (₪${sum}) שונה מהסה״כ בקבלה (₪${parsed.total}).`);
    }
    return result;
  }

  /**
   * Choose at most one option per line so the deltas add up to `need` cents,
   * at the lowest cost. Returns { cost, picks: [[line, option]], margin } where
   * margin is how much more the next best way would cost.
   */
  function cheapestFix(options, need) {
    // states: delta → [best cost, picks, second best cost]; at most 3 changes
    let states = new Map([[0, { cost: 0, picks: [], second: Infinity }]]);
    for (let i = 0; i < options.length; i++) {
      if (!options[i].length) continue;
      const next = new Map(states);
      for (const [delta, st] of states) {
        if (st.picks.length >= 3) continue;
        options[i].forEach((o, k) => {
          const d = delta + o.delta;
          if (Math.abs(d) > 4000) return;
          const cost = st.cost + o.cost;
          const cur = next.get(d);
          if (!cur) next.set(d, { cost, picks: st.picks.concat([[i, k]]), second: Math.min(Infinity, st.second + o.cost) });
          else if (cost < cur.cost - 1e-9) next.set(d, { cost, picks: st.picks.concat([[i, k]]), second: Math.min(cur.cost, st.second + o.cost) });
          else next.set(d, Object.assign({}, cur, { second: Math.min(cur.second, cost) }));
        });
      }
      states = next;
    }
    const hit = states.get(need);
    if (!hit) return null;
    return { cost: hit.cost, picks: hit.picks, margin: hit.second - hit.cost };
  }

  const api = { checkReceipt, nearCodes, twoDigitsAway, nameLikeness, fixCode, oneDigitApart, cheapestFix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ReceiptCheck = api;
})(typeof window !== 'undefined' ? window : globalThis);
