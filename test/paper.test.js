// Run with: node test/paper.test.js
// Photos of paper receipts: cleaning, columns, parsing, several photos.
// All data here is made up (layout of a typical Israeli supermarket slip).
const assert = require('assert');
const P = require('../js/paper.js');
const S = require('../js/shufersal.js');

// ---------- cleaning ----------
{
  // 40x30 picture: dark "table" around a light "paper" area with one black dot
  const W = 40, H = 30;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const paper = x >= 10 && x < 30 && y >= 5 && y < 25;
      const [r, g, b] = paper ? [235, 235, 238] : [140, 100, 60];
      rgba.set([r, g, b, 255], i);
    }
  rgba.set([10, 10, 10, 255], (15 * W + 20) * 4); // ink
  rgba.set([220, 60, 60, 255], (16 * W + 20) * 4); // red logo ink
  const box = P.findPaper(rgba, W, H);
  assert.ok(box.x0 <= 10 && box.x0 >= 8 && box.x1 >= 29 && box.x1 <= 31, 'paper found horizontally: ' + JSON.stringify(box));
  assert.ok(box.y0 <= 5 && box.y1 >= 24, 'paper found vertically');
  const gray = P.maxChannel(rgba, W, H);
  assert.strictEqual(gray[15 * W + 20], 10, 'black ink stays black');
  assert.strictEqual(gray[16 * W + 20], 220, 'red ink turns light');
  const even = P.evenLight(gray, W, H, 5);
  assert.ok(even[15 * W + 20] < 60 && even[12 * W + 15] > 230, 'contrast kept after evening the light');
  const thick = P.thicken(P.threshold(even, 200), W, H);
  assert.strictEqual(thick[15 * W + 21], 0, 'stroke thickened');
}

// ---------- barcodes ----------
assert.strictEqual(S.fixBarcode('290000000015'), '7290000000015', 'dropped leading 7 restored');
assert.strictEqual(S.fixBarcode('290000000016'), '290000000016', 'not restored when the check digit disagrees');
assert.strictEqual(S.fixBarcode('208428'), '208428', 'short in-store codes untouched');
assert.ok(S.eanValid('7290000000015'));

// ---------- a photo, as the three OCR readings would see it ----------
const W = 2000;
function photo(lines, y0 = 300) {
  const words = [], codeWords = [], amountWords = [];
  let y = y0;
  for (const [code, name, amount] of lines) {
    const box = (x0, x1) => ({ x0, y0: y, x1, y1: y + 70 });
    if (code) codeWords.push({ text: code, bbox: box(1860 - code.length * 32, 1860) });
    let right = 1300;
    for (const w of (name || '').split(' ').filter(Boolean)) {
      const width = w.length * 30;
      words.push({ text: w, bbox: box(right - width, right) });
      right -= width + 20;
    }
    if (amount) {
      amountWords.push({ text: amount, bbox: box(520 - amount.length * 34, 520) });
      words.push({ text: amount, bbox: box(520 - amount.length * 34, 520) }); // the Hebrew pass sees prices too
    }
    if (code) words.push({ text: 'גנ', bbox: box(1860 - code.length * 32, 1860) }); // a garbled barcode
    y += 105;
  }
  return { words, codeWords, amountWords, width: W };
}

const page1 = photo([
  ['', 'תאריך קניה 10:21 04/11/2026', ''],
  ['', 'ברקוד שם פריט סכום', ''],
  ['208428', 'חומוס גרעינים', '8.90'],
  ['290000000015', 'גבינה צהובה 28%', '29.90'], // leading 7 dropped by OCR
  ['7290000000039', 'שמנת לבישול 15%', '8.90'],
  ['7290000000046', 'לחם אחיד', '7.50'],
]);
const page2 = photo([
  ['7290000000046', 'לחם אחיד', '7.50'], // overlaps the end of page 1
  ['7290000000053', 'מלפפון חמוץ', '12.40'],
  ['', '5 פריטים', ''],
  ['', 'לתשלום', ''],
  ['18.00', 'מע"מ 18.00%', '10.13'], // VAT line: "18.00" in the code strip is not a barcode
  ['', 'אשראי', '67.60'],
]);

const cols = P.findColumns(page1.words, W);
assert.ok(cols.found, 'columns found');
assert.ok(cols.amountTo > 520 && cols.amountTo < 700, 'price column edge: ' + cols.amountTo);
assert.ok(cols.codeFrom >= W * 0.5 && cols.codeFrom <= 1450, 'barcode column edge: ' + cols.codeFrom);

function read(p, text) {
  const c = P.findColumns(p.words, W);
  const rows = S.buildRows(Object.assign({}, p, c));
  return S.parseRows(rows, text, { paper: true, chain: P.detectStore(text) || { id: 'unknown', name: '' } });
}

const r1 = read(page1, 'סופר כח בע"מ\nתאריך קניה 10:21 04/11/2026');
assert.deepStrictEqual(r1.items.map((i) => [i.code, i.total]), [
  ['208428', 8.9],
  ['7290000000015', 29.9],
  ['7290000000039', 8.9],
  ['7290000000046', 7.5],
]);
assert.strictEqual(r1.items[1].name, 'גבינה צהובה 28%', 'name kept, barcode not mixed into it');
assert.strictEqual(r1.date, '2026-11-04');
assert.strictEqual(r1.time, '10:21');
assert.deepStrictEqual(r1.chain, { id: 'super-koach', name: 'סופר כח' });

const r2 = read(page2, 'לתשלום\nאשראי 67.60');
assert.deepStrictEqual(r2.items.map((i) => i.code), ['7290000000046', '7290000000053'], 'VAT line is not an item');
assert.strictEqual(r2.totalFound, false, 'no total in page 2 alone: its items sum to 19.90');

// ---------- several photos ----------
const merged = P.mergePhotos([r2, r1]); // picked in the wrong order: the dated one goes first
assert.deepStrictEqual(merged.items.map((i) => i.code), ['208428', '7290000000015', '7290000000039', '7290000000046', '7290000000053']);
assert.strictEqual(merged.overlapDropped, 1, 'the overlapping line counted once');
assert.strictEqual(merged.itemsSum, 67.6);
assert.strictEqual(merged.date, '2026-11-04');

// a total that repeats after the items (to pay + card payment) is found
const withTotal = photo([
  ['7290000000046', 'לחם', '7.50'],
  ['7290000000053', 'מלפפון', '12.40'],
  ['', 'סיכום', ''],
]);
withTotal.amountWords.push({ text: '19.90', bbox: { x0: 400, y0: 700, x1: 520, y1: 770 } });
withTotal.amountWords.push({ text: '19.90', bbox: { x0: 400, y0: 820, x1: 520, y1: 890 } });
const r3 = read(withTotal, '');
assert.strictEqual(r3.total, 19.9);
assert.strictEqual(r3.totalFound, true);

// year misread by OCR (2646) → this year, or last year if that would be in the future
const thisYear = new Date().getFullYear();
const r4 = read(photo([['7290000000046', 'לחם', '7.50']]), 'תאריך קניה 01/01/2646');
assert.strictEqual(r4.date, `${thisYear}-01-01`);

// ---------- the total next to "לתשלום" ----------
{
  // A footer with a normal line, a separator rule, a double-height total and two normal lines
  const W2 = 400, H2 = 300;
  const g = new Uint8ClampedArray(W2 * H2).fill(255);
  const fill = (x0, y0, x1, y1) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * W2 + x] = 0;
  };
  fill(250, 10, 380, 30); // "3 פריטים"
  for (let x = 20; x < 380; x += 6) fill(x, 38, x + 4, 40); // dashed separator
  fill(120, 50, 170, 92); // big "47.70"
  fill(200, 50, 300, 92); // big "לתשלום"
  fill(120, 110, 170, 130); // "40.42"
  fill(200, 110, 280, 130);
  fill(130, 150, 170, 170); // "7.28"
  fill(200, 150, 290, 170);
  const box = P.bigTotalBox(g, W2, H2, 0);
  assert.ok(box, 'big line found');
  assert.ok(box.y0 <= 50 && box.y1 >= 92 && box.y0 > 40, 'the tall line, without the separator: ' + JSON.stringify(box));
  assert.ok(box.x0 < 120 && box.x1 > 170 && box.x1 < 200, 'just the amount, not the word: ' + JSON.stringify(box));
  assert.ok(box.squash > 0.4 && box.squash < 0.6, 'squashed to normal height');
}
{
  const footer = [
    { text: '40.42', bbox: { x0: 100, y0: 200, x1: 180, y1: 230 } },
    { text: '47.70', bbox: { x0: 100, y0: 300, x1: 180, y1: 330 } }, // the card payment line
  ];
  // two readings of the big total disagree: the one matching the sum wins
  assert.deepStrictEqual(P.findTotal(footer, [], 47.7, ['47.10', '47.70']), { value: 47.7, how: 'big' });
  // neither matches the sum (a line is missing): the one printed again below wins
  assert.deepStrictEqual(P.findTotal(footer, [], 39.6, ['47.10', '47.70']), { value: 47.7, how: 'big' });
  // no big total: the amount on the "לתשלום" line, then one equal to the sum, then the first
  const words = [{ text: 'לתשלום', bbox: { x0: 300, y0: 195, x1: 420, y1: 235 } }];
  assert.deepStrictEqual(P.findTotal(footer, words, 0, null), { value: 40.42, how: 'label' });
  assert.deepStrictEqual(P.findTotal(footer, [], 47.7, null), { value: 47.7, how: 'sum' });
  assert.deepStrictEqual(P.findTotal(footer, [], 1, null), { value: 40.42, how: 'first' });

  const parsed = { items: [{ total: 8.9, discount: 0 }], itemsSum: 8.9, totalFound: false, total: 8.9, warnings: [] };
  P.applyTotal(parsed, { footerWords: footer, words: [], bigTotal: ['47.70'] });
  assert.strictEqual(parsed.total, 47.7);
  assert.strictEqual(parsed.totalFound, true);
  assert.ok(parsed.warnings.some((w) => /לא תואם/.test(w)), 'mismatch flagged');
}


// ---------- a long receipt: quantity lines, produce codes, glued barcodes, split payment ----------
{
  // [code-strip reading, name, amount, middle reading]
  const lines = [
    ['', 'קוד תאור לתשלום', '', ''],
    ['7290000000015', 'מגבות נייר', '12.9', ''], // last 0 too faint: "12.9"
    ['117177290000000039', 'יוגורט 125ג', '', ''], // the name's "125" stuck to the barcode
    ['', 'ליחידה', '26.00', '6.50x4'],
    ['', 'יוגורט', '-4.00', ''],
    ['729000000004', 'לחם', '7.50', ''], // last digit lost at the paper's edge
    ['964775', 'בננה', '', ''],
    ['', 'לק"ג', '11.92', '.90x221.205'], // "9.90 x ק"ג 1.205": the price lost a digit, ק"ג read as "22"
    ['22', 'עגבניה', '', ''], // a 2-digit produce code, trusted because a weight line follows
    ['', 'לק"ג', '4.49', '6.90x120.650'],
    ['', 'להצלוו', '58.81', ''], // "לתשלום" in double-width letters, unreadable
    ['', 'ע. סודקסו', '20.00', ''],
    ['02101', 'ישראכרט', '38.81', ''], // a payment line that looks like an item
  ];
  const words = [], codeWords = [], amountWords = [], midWords = [];
  let y = 300;
  for (const [code, name, amount, mid] of lines) {
    const box = (x0, x1) => ({ x0, y0: y, x1, y1: y + 70 });
    if (code) codeWords.push({ text: code, bbox: box(1860 - code.length * 32, 1860) });
    if (mid) midWords.push({ text: mid, bbox: box(1100, 1100 + mid.length * 32) });
    let right = 1300;
    for (const w of name.split(' ')) {
      words.push({ text: w, bbox: box(right - w.length * 30, right) });
      right -= w.length * 30 + 20;
    }
    if (amount) {
      amountWords.push({ text: amount, bbox: box(520 - amount.length * 34, 520) });
      words.push({ text: amount, bbox: box(520 - amount.length * 34, 520) });
    }
    y += 85;
  }
  // a smudge made one price's box two lines tall: it still lands on its own line
  amountWords[2].bbox.y1 += 90;
  const c = P.findColumns(words, W);
  const rows = S.buildRows({ words, codeWords, amountWords, midWords, width: W, codeFrom: c.codeFrom, amountTo: c.amountTo });
  const r = S.parseRows(rows, 'יוניברס', { paper: true, chain: { id: 'unknown', name: '' } });
  assert.deepStrictEqual(
    r.items.map((i) => [i.code, i.qty, i.weighted, i.total, i.discount]),
    [
      ['7290000000015', 1, false, 12.9, 0],
      ['7290000000039', 4, false, 26, -4],
      ['7290000000046', 1, false, 7.5, 0],
      ['964775', 1.205, true, 11.93, 0], // 1.205 × 9.90: the faint last digit read as 2
      ['22', 0.65, true, 4.49, 0],
    ]
  );
  assert.strictEqual(r.items[3].unitPrice, 9.9, 'price per kg completed from ".90" and the arithmetic');
  assert.strictEqual(r.items[1].unitPrice, 6.5);
  assert.strictEqual(r.total, 58.81, 'the total is the line the payments below add up to');
  assert.strictEqual(r.totalFound, true);
}

// overlap between two photos, with one line read differently in each
{
  const it = (code, total) => ({ code, total, discount: 0, name: '', qty: 1 });
  const a = { items: [it('111111', 5), it('7290000000015', 12.9), it('7290000000039', 26), it('', 4.49), it('7290000000046', 7.5)], date: '2026-11-01', totalFound: false };
  const b = { items: [it('7290000000015', 12.9), it('7290000000039', 26), it('', 4.46), it('7290000000046', 7.5), it('222222', 3)], totalFound: true, total: 58.89 };
  const m = P.mergePhotos([a, b]);
  assert.strictEqual(m.overlapDropped, 4, 'four lines seen twice');
  assert.deepStrictEqual(m.items.map((i) => i.total), [5, 12.9, 26, 4.49, 7.5, 3]);

  // the first photo missed a line in the overlap: the second photo's reading is kept
  const c = { items: [it('111111', 5), it('7290000000015', 12.9), it('', 4.49), it('7290000000046', 7.5)], date: '2026-11-01' };
  const d = { items: [it('7290000000015', 12.9), it('7290000000039', 26), it('', 4.49), it('7290000000046', 7.5), it('222222', 3)] };
  const m2 = P.mergePhotos([c, d]);
  assert.deepStrictEqual(m2.items.map((i) => i.total), [5, 12.9, 26, 4.49, 7.5, 3]);
  assert.strictEqual(m2.overlapDropped, 3);

  // no overlap: everything kept
  const m3 = P.mergePhotos([c, { items: [it('333333', 9), it('444444', 1)] }]);
  assert.strictEqual(m3.items.length, 6);
  assert.strictEqual(m3.overlapDropped, 0);
}

// helpers for these
assert.strictEqual(S.pickCode('117177290000000039'), '7290000000039');
assert.strictEqual(S.pickCode('7290000000039'), '7290000000039');
assert.strictEqual(S.pickCode('283642'), '283642');
assert.strictEqual(S.pickCode('11217121210202'), '1210202', 'no barcode inside: the right-aligned end');
assert.strictEqual(S.fixBarcode('729000000003'), '7290000000039', 'lost check digit restored');
assert.strictEqual(S.parseAmount('19.9'), 19.9);
assert.strictEqual(S.parseAmount('13.907'), 13.9);
assert.deepStrictEqual(S.midQuantity('6.50x4', 26), { qty: 4, unitPrice: 6.5, weighted: false, total: 26, qtyChecked: true });
// the unit price unreadable: 3 units, and 20.40 divides by 3
assert.deepStrictEqual(S.midQuantity('4 80x3', 20.4), { qty: 3, unitPrice: 6.8, weighted: false, total: 20.4, qtyChecked: true });
// weight × price per kilo: last digits fixed so the arithmetic works
for (const [mid, paid, raw, want] of [
  ['.90x221.205', 11.9, '11.9', [1.205, 9.9, 11.93]],
  ['90x221.080', 5.2, '5.20', [1.08, 4.9, 5.29]],
  ['6.90x120.659', 4.46, '4.46', [0.65, 6.9, 4.49]],
  ['30x21.050', 7.25, '7.25', [1.05, 6.9, 7.25]],
  ['5.00x420.253', 21.95, '21.95', [0.258, 85, 21.93]],
]) {
  const q = S.midQuantity(mid, paid, raw);
  assert.deepStrictEqual([q.qty, q.unitPrice, q.total, q.weighted], want.concat(true), mid);
}
assert.strictEqual(S.midQuantity('85.00x220.258', 21.93).qty, 0.258);
assert.strictEqual(S.midQuantity('5.20', 5.2), null, 'a price alone is not a quantity line');

// ---------- a curled receipt: lines levelled ----------
{
  const w = 800, h = 600;
  const gray = new Uint8ClampedArray(w * h).fill(255);
  // text lines (dashes of ink) that drop 3° toward the right
  const t = Math.tan((3 * Math.PI) / 180);
  for (let line = 0; line < 8; line++) {
    for (let x = 40; x < w - 40; x++) {
      if (x % 40 > 30) continue; // gaps between "words"
      const yc = 60 + line * 64 + (x - w / 2) * t;
      for (let dy = -8; dy <= 8; dy++) {
        const yy = Math.round(yc + dy);
        if (yy >= 0 && yy < h) gray[yy * w + x] = 0;
      }
    }
  }
  const skew = P.estimateSkew(gray, w, h);
  assert.ok(Math.abs(skew - 3) <= 0.5, 'tilt measured: ' + skew);
  const { images } = P.levelLines([gray], w, h, 300);
  // after levelling, a line's ink is at the same height on the left and the right
  const inkAt = (img, x) => {
    for (let y = 30; y < 140; y++) if (img[y * w + x] < 128) return y;
    return -1;
  };
  assert.ok(Math.abs(inkAt(images[0], 100) - inkAt(images[0], 690)) <= 4, `level: ${inkAt(images[0], 100)} vs ${inkAt(images[0], 690)}`);
  assert.ok(Math.abs(inkAt(gray, 100) - inkAt(gray, 690)) > 20, 'it was tilted before');
}

console.log(`OK: paper receipts (cleaning, columns, ${merged.items.length} items over 2 photos, overlap dropped)`);
