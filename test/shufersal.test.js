// Run with: node test/shufersal.test.js
// Shufersal receipts are pictures, read with OCR in three columns. This test
// builds made-up OCR words in that layout (items, barcodes and prices are
// fictional) including the quirks OCR produces, and checks the parsed result.
const assert = require('assert');
const { buildRows, parseRows, parseAmount, fixTimes, looksLikeShufersal } = require('../js/shufersal.js');

const W = 1029;
const STEP = 63; // px between receipt lines
const words = [];
const codeWords = [];
const amountWords = [];
let y = 100;

/** One receipt line: code (right), description (middle, right-aligned), amount (left). */
function line(code, desc, amount) {
  const box = (x0, x1) => ({ x0, y0: y, x1, y1: y + 30 });
  if (code) codeWords.push({ text: code, bbox: box(980 - code.length * 20, 980) });
  if (desc) {
    let right = 690;
    for (const w of desc.split(' ')) {
      const width = w.length * 18;
      words.push({ text: w, bbox: box(right - width, right) });
      right -= width + 12;
    }
  }
  if (amount) amountWords.push({ text: amount, bbox: box(170 - amount.length * 18, 170) });
  y += STEP;
}

line('', 'שופרסל בע"מ', '');
line('', 'תאור', ''); // table header (קוד / לתשלום fall in the number columns)
line('428', 'בטטה מובחרת', ''); // weighed item: name row…
line('', 'ק"ג 1.200 א 8.00 לק"ג', '9.60'); // …weight row, with x read as א
line('1036', 'בצל יבש', '');
line('', 'ק"ג 0.500 x 6.00 לק"ג', '3.00');
line('', 'קטיף 2.90 בצל יבש-', '-0.50'); // discount, minus in front
line('', 'מות100', ''); // second line of the discount text
line('7290000000017', 'חסה לבבות בשקית', '9.90'); // one unit, price on the same row
line('7290000000024', 'מסיר אבנית מכונת קפה', '');
line('', '2 x 18.90 ליחידה', '37.80'); // quantity row
line('', '2ב24 מסיר אבנית מכונת', '13.80-'); // discount, minus at the end
line('', 'קפה700', '');
line('7290000000031', 'יוגורט קראנצ', '171'); // "171" is the end of the name, not a price
line('', '4 x 5.20 ליחידה', '20.80');
line('2868996', 'קוטג 5% שומן 250ג', '6.20');
line('', 'לתשלום', '73.00'); // end of the items
line('', '* תאריך: 28/10/26 *', '');
line('', '* שעה: 11:07 *', '');
line('', '* סה"כ שולם: 73.00 *', '');

const fullText = words
  .reduce((lines, w) => {
    const key = w.bbox.y0;
    (lines[key] = lines[key] || []).push(w.text);
    return lines;
  }, {});
const text = Object.values(fullText).map((ws) => ws.join(' ')).join('\n');

const rows = buildRows({ words, codeWords, amountWords, width: W });
const r = parseRows(rows, text);

assert.ok(looksLikeShufersal(text));
assert.strictEqual(r.chain.id, 'shufersal');
assert.strictEqual(r.date, '2026-10-28');
assert.strictEqual(r.time, '11:07');
assert.strictEqual(r.total, 73);
assert.strictEqual(r.items.length, 6, 'six items');
assert.deepStrictEqual(r.warnings, [], 'no warnings: ' + r.warnings.join(' | '));
assert.strictEqual(r.itemsSum, 73, 'sum matches the total');

const [potato, onion, lettuce, descaler, yogurt, cottage] = r.items;
assert.deepStrictEqual([potato.code, potato.qty, potato.unitPrice, potato.total, potato.weighted], ['428', 1.2, 8, 9.6, true]);
assert.strictEqual(potato.name, 'בטטה מובחרת');
assert.deepStrictEqual([onion.total, onion.discount], [3, -0.5]);
assert.deepStrictEqual([lettuce.qty, lettuce.unitPrice, lettuce.total, lettuce.weighted], [1, 9.9, 9.9, false]);
assert.deepStrictEqual([descaler.qty, descaler.unitPrice, descaler.total, descaler.discount], [2, 18.9, 37.8, -13.8]);
assert.deepStrictEqual([yogurt.qty, yogurt.unitPrice, yogurt.total], [4, 5.2, 20.8], 'stray 171 ignored');
assert.deepStrictEqual([cottage.code, cottage.total], ['2868996', 6.2]);

// helpers
assert.strictEqual(parseAmount('2.12-'), -2.12);
assert.strictEqual(parseAmount('-2.12'), -2.12);
assert.strictEqual(parseAmount('14.89'), 14.89);
assert.strictEqual(parseAmount('171'), null);
assert.strictEqual(fixTimes('ק"ג 1.885 א 7.90 לק"ג'), 'ק"ג 1.885 x 7.90 לק"ג');

console.log(`OK: Shufersal layout, ${r.items.length} items, sum ₪${r.itemsSum} = total ₪${r.total}`);
