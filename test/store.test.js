// Run with: node test/store.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parse } = require('../js/parser.js');
const { Store } = require('../js/store.js');

const text = fs.readFileSync(path.join(__dirname, 'sample-yohananof.txt'), 'utf8');
const store = new Store();

// An older receipt two weeks earlier: eggs and milk at slightly different prices.
const older = parse(text);
older.date = '2026-09-29';
older.invoice = '1111';
older.total = 1;
older.items = older.items
  .filter((i) => ['7290000000031', '7290000000017', '623'].includes(i.code))
  .map((i) => Object.assign({}, i, { unitPrice: i.unitPrice - 0.5 }));

const first = store.importReceipt(older);
assert.strictEqual(first.unknown.length, 3);
store.assignCode('7290000000031', 'ביצים');
store.assignCode('7290000000017', 'חלב');
store.assignCode('yohananof:623', 'בננה');

const recent = parse(text);
assert.strictEqual(store.isDuplicate(recent), false);
const second = store.importReceipt(recent);
assert.strictEqual(store.isDuplicate(recent), true);
// Unknown codes are unique (cottage x3, mozzarella x2, burgul x2, huggies x2 collapse).
const uniqueCodes = new Set(recent.items.map((i) => i.code)).size;
assert.strictEqual(second.unknown.length, uniqueCodes - 3);

const eggs = store.findProductByName('ביצים');
const s = store.stats(eggs.id, '2026-10-26T10:00:00');
assert.strictEqual(s.timesBought, 2);
assert.strictEqual(s.every, 14);
assert.strictEqual(s.daysSince, 13);
assert.strictEqual(s.dueIn, 1);
assert.strictEqual(s.lastPrice, 13.9);

const banana = store.stats(store.findProductByName('בננה').id, '2026-10-26T10:00:00');
assert.strictEqual(banana.weighted, true);
assert.strictEqual(banana.lastPrice, 7.9);

const sugg = store.suggestions('2026-10-26T10:00:00').map((x) => x.product.name);
assert.ok(sugg.includes('ביצים') && sugg.includes('חלב'), 'eggs + milk suggested: ' + sugg);

// Already on the list → not suggested
store.addToList('ביצים');
assert.ok(!store.suggestions('2026-10-26T10:00:00').some((x) => x.product.name === 'ביצים'));

// Dismiss → hidden
store.dismissSuggestion(store.findProductByName('חלב').id, '2026-10-26T10:00:00');
assert.ok(!store.suggestions('2026-10-26T10:00:00').some((x) => x.product.name === 'חלב'));

// Merge by renaming
store.assignCode('7290000000055', 'קוטג׳');
const tmp = store.assignCode('2100000000101', 'מוצרלה');
store.renameProduct(tmp.id, 'קוטג׳');
assert.strictEqual(store.codesOf(store.findProductByName('קוטג׳').id).length, 2);

// What the user typed wins: no renaming, even when a longer product exists
store.assignCode('yohananof:728', 'עגבניות שרי');
assert.strictEqual(store.matchProduct('עגבניות'), null);
assert.strictEqual(store.addToList('עגבניות').name, 'עגבניות');
store.assignCode('7290000000147', 'מלח לימון');
assert.strictEqual(store.addToList('מלח').name, 'מלח');
assert.strictEqual(store.matchProduct('מלח'), null, 'no price borrowed from מלח לימון');
// Whole words only in suggestions: "חלב" must not match "רבע לשבע חלבה"
store.assignCode('7290000000154', 'רבע לשבע חלבה');
assert.deepStrictEqual(store.similarProducts('חלב').map((p) => p.name), []);

// Estimate: cottage was bought 3× in one trip → typical spend 20.1
const cottage = store.stats(store.findProductByName('קוטג׳').id, '2026-10-26T10:00:00');
assert.ok(cottage.typicalSpend > 0);
store.state.list = [];
store.addToList('ביצים');
store.addToList('משהו חדש');
let est = store.estimate('2026-10-26T10:00:00');
assert.strictEqual(est.unpriced, 1);
assert.strictEqual(est.all, s.typicalSpend);
store.toggleItem(store.state.list[0].id);
est = store.estimate('2026-10-26T10:00:00');
assert.strictEqual(est.cart, est.all);
const trip = store.finishTrip(15, '2026-10-26T10:00:00');
assert.strictEqual(trip.actual, 15);
assert.strictEqual(trip.items, 1);
assert.strictEqual(store.state.list.length, 1, 'cart cleared, open item kept');
assert.strictEqual(store.lastTrip().date, '2026-10-26');

// Store sections: guessed, overridable, grouped in store-walk order
store.state.list = [];
for (const n of ['נייר אפייה', 'חלב', 'עגבניות שרי', 'משהו לא מוכר']) store.addToList(n);
assert.deepStrictEqual(
  store.listBySection().map((g) => g.category.id),
  ['produce', 'dairy', 'home', 'other'],
  'sections in store order'
);
const tomatoes = store.findProductByName('עגבניות שרי');
store.setCategory(tomatoes.id, 'frozen');
assert.strictEqual(store.categoryOfItem(store.state.list.find((i) => i.name === 'עגבניות שרי')), 'frozen', 'manual choice wins');
store.setCategory(tomatoes.id, 'not-a-section');
assert.strictEqual(store.categoryOfProduct(tomatoes), 'frozen', 'invalid section ignored');

// Delete receipt
store.deleteReceipt(first.receipt.id);
assert.strictEqual(store.stats(eggs.id, '2026-10-26T10:00:00').timesBought, 1);

console.log('OK: store, stats, suggestions');

// ---------- extra simple lists ----------
{
  const s2 = new Store();
  s2.addToList('חלב');
  const pharm = s2.addList('פארם');
  assert.strictEqual(s2.addList(' פארם ').id, pharm.id, 'same name = same list');
  s2.addToList('אקמול', pharm.id);
  s2.addToList('חלב', pharm.id); // same name on another list is a separate item
  assert.strictEqual(s2.itemsOf(null).length, 1, 'main list untouched');
  assert.strictEqual(s2.itemsOf(pharm.id).length, 2);
  assert.strictEqual(s2.estimate().items, 1, 'estimate counts the main list only');
  assert.ok(s2.listBySection().every((g) => g.items.every((i) => !i.listId)), 'sections show the main list only');

  const akamol = s2.itemsOf(pharm.id).find((i) => i.name === 'אקמול');
  s2.toggleItem(akamol.id);
  s2.toggleItem(s2.itemsOf(null)[0].id);
  s2.finishTrip(10);
  assert.ok(s2.itemsOf(pharm.id).find((i) => i.id === akamol.id), 'finishing the shopping trip keeps other lists');
  s2.clearChecked(pharm.id);
  assert.deepStrictEqual(s2.itemsOf(pharm.id).map((i) => i.name), ['חלב'], 'clear done on the pharmacy list only');

  s2.renameList(pharm.id, 'בית מרקחת');
  assert.strictEqual(s2.extraLists()[0].name, 'בית מרקחת');
  s2.deleteList(pharm.id);
  assert.strictEqual(s2.extraLists().length, 0);
  assert.strictEqual(s2.state.list.filter((i) => i.listId).length, 0, 'deleting a list removes its items');
  console.log('OK: extra lists');
}

// ---------- quantities ----------
{
  const { parseQuantity } = require('../js/store.js');
  assert.deepStrictEqual(parseQuantity('2 חלב'), { name: 'חלב', qty: 2 });
  assert.deepStrictEqual(parseQuantity('חלב x3'), { name: 'חלב', qty: 3 });
  assert.deepStrictEqual(parseQuantity('ביצים x12'), { name: 'ביצים', qty: 12 });
  assert.deepStrictEqual(parseQuantity('12 ביצים'), { name: '12 ביצים', qty: null }, 'a tray of 12, not twelve');
  assert.deepStrictEqual(parseQuantity('חלב 3%'), { name: 'חלב 3%', qty: null });
  assert.deepStrictEqual(parseQuantity('שמנת 250'), { name: 'שמנת 250', qty: null });

  const s3 = new Store();
  const milkReceipt = parse(text);
  const { unknown } = s3.importReceipt(milkReceipt);
  for (const u of unknown) s3.assignCode(u.key, u.rawName);
  s3.assignCode('7290000000017', 'חלב'); // 6.90, one per trip
  s3.assignCode('7290000000055', 'קוטג'); // 6.50, two per trip

  const milk = s3.addToList('חלב', null, 2);
  assert.strictEqual(milk.qty, 2);
  const again = s3.addToList('חלב');
  assert.strictEqual(again.id, milk.id, 'same line, not a duplicate');
  assert.strictEqual(again.qty, 3, 'adding again raises the quantity');
  assert.strictEqual(again.merged, true);
  s3.setQty(milk.id, 0);
  assert.strictEqual(milk.qty, 1, 'never below 1');
  s3.setQty(milk.id, 2);

  const cottage = s3.addToList('קוטג'); // no quantity: the usual amount (2 × 6.50)
  assert.strictEqual(cottage.qty, undefined);
  const est = s3.estimate();
  assert.strictEqual(est.all, 13.8 + 13, 'milk 2 × 6.90 + cottage as usually bought');
  s3.setQty(cottage.id, 1);
  assert.strictEqual(s3.estimate().all, 13.8 + 6.5, 'quantity given: usual price × quantity');
  console.log('OK: quantities');
}
