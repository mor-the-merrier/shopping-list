// Run with: node test/check.test.js
// Checking photographed receipt lines against known barcodes, prices and the total.
const assert = require('assert');
const C = require('../js/check.js');

// made-up barcodes with valid check digits
const LIST = {
  '7290000000015': 'אבקת כביסה מקסימה סנסטיב',
  '7290000000077': 'מלח שולחן דק',
  '7290000000060': 'סבון לאמבטיה',
  '7290000000084': 'תחליב רחצה פינוק',
};
const PRICES = { '7290000000077': [2.09], '7290000000084': [13.9, 14.5] };
const opts = {
  isKnownCode: (c) => !!LIST[c],
  nameOf: (c) => LIST[c] || '',
  pricesOf: (c) => PRICES[c] || [],
};
const line = (code, name, total, extra = {}) => Object.assign({ code, name, total, unitPrice: total, qty: 1, discount: 0, weighted: false }, extra);

// ---------- barcodes ----------
assert.ok(C.nearCodes('7290000000016').includes('7290000000015'));
{
  // one digit off, one known code that close
  const it = line('7290000000068', 'ז"ו 30', 49.9);
  assert.strictEqual(C.fixCode(it, opts.isKnownCode, opts.pricesOf, opts.nameOf), '7290000000060', 'the only known code one digit away');
  const it2 = line('7290000000010', 'מקסימה 30', 49.9);
  // two known codes one digit away (…015 and …060): the name read says which
  assert.strictEqual(C.fixCode(it2, opts.isKnownCode, opts.pricesOf, opts.nameOf), '7290000000015');
}
{
  // unknown and nothing near: the check digit is worked out
  const it = line('7290000099991', 'משהו', 5);
  assert.strictEqual(C.fixCode(it, opts.isKnownCode, opts.pricesOf, opts.nameOf), '7290000099996');
}
assert.ok(C.nameLikeness('מקל"מה סנסניב', 'אבקת כביסה מקסימה סנסטיב') > C.nameLikeness('מקל"מה סנסניב', 'סבון לאמבטיה'));

// ---------- prices ----------
assert.strictEqual(C.oneDigitApart(13.97, 13.9), 0);
assert.strictEqual(C.oneDigitApart(10.9, 16.9), 3);
assert.strictEqual(C.oneDigitApart(10.9, 16.8), -1);
{
  // a known shelf price one (last) digit away is taken, even with no total
  const parsed = { items: [line('7290000000084', 'פינוק', 13.97), line('7290000000077', 'מלח', 2.0)], totalFound: false };
  C.checkReceipt(parsed, opts);
  assert.deepStrictEqual(parsed.items.map((i) => i.total), [13.9, 2.09]);
  assert.ok(parsed.items.every((i) => i.sure));
}

// ---------- the printed total wins ----------
{
  // one faint last digit: the lines are made to add up
  const parsed = {
    items: [line('', 'ביצים', 14.56), line('', 'קוטג', 20.4, { qty: 3, unitPrice: 6.8, qtyChecked: true }), line('', 'לחם', 8.5)],
    total: 43.44,
    totalFound: true,
  };
  const r = C.checkReceipt(parsed, opts);
  assert.ok(r.matches);
  assert.deepStrictEqual(parsed.items.map((i) => i.total), [14.54, 20.4, 8.5], 'only an unchecked line changes');
  assert.strictEqual(parsed.itemsSum, 43.44);
}
{
  // two lines could explain it equally: nothing is changed, both stay unsure
  const parsed = { items: [line('', 'א', 5.56), line('', 'ב', 7.56)], total: 13.1, totalFound: true };
  const r = C.checkReceipt(parsed, opts);
  assert.strictEqual(r.matches, false);
  assert.deepStrictEqual(parsed.items.map((i) => i.total), [5.56, 7.56]);
  assert.deepStrictEqual(parsed.items.map((i) => i.sure), [false, false]);
  assert.ok(parsed.warnings.some((w) => /שונה מהסה״כ/.test(w)));
}
{
  // already adds up: everything is taken as right
  const parsed = { items: [line('', 'א', 5.5), line('', 'ב', 7.6)], total: 13.1, totalFound: true };
  C.checkReceipt(parsed, opts);
  assert.ok(parsed.items.every((i) => i.sure));
}
{
  // a discount read with a stray last digit
  const parsed = { items: [line('', 'שמפו', 13.9, { discount: -3.86 }), line('', 'לחם', 8.5)], total: 18.6, totalFound: true };
  C.checkReceipt(parsed, opts);
  assert.strictEqual(parsed.items[0].discount, -3.8);
}

console.log('OK: check (barcodes by name and check digit, known prices, lines made to add up to the total)');
