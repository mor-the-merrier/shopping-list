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

console.log(`OK: paper receipts (cleaning, columns, ${merged.items.length} items over 2 photos, overlap dropped)`);
