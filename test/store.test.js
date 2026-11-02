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

// "עגבניות" on the list becomes the receipt's "עגבניות שרי"; products stay separate
store.assignCode('yohananof:728', 'עגבניות שרי');
assert.strictEqual(store.matchProduct('עגבניות'), null);
assert.strictEqual(store.addToList('עגבניות').name, 'עגבניות שרי');
// Whole words only: "חלב" must not turn into "רבע לשבע חלבה"
store.assignCode('7290000000147', 'רבע לשבע חלבה');
assert.deepStrictEqual(store.similarProducts('חלב').map((p) => p.name), []);
// Once regular tomatoes exist as their own product, "עגבניות" stays "עגבניות"
store.assignCode('yohananof:9999', 'עגבניות');
assert.notStrictEqual(store.findProductByName('עגבניות').id, store.findProductByName('עגבניות שרי').id);
assert.strictEqual(store.resolveName('עגבניות'), 'עגבניות');
// Items typed before a matching receipt get renamed later
store.state.list.push({ id: 'x1', name: 'גבינת מוצרלה', checked: false });
store.assignCode('2100000000101', 'גבינת מוצרלה בסגנון');
store.resolveListNames();
assert.strictEqual(store.state.list.find((i) => i.id === 'x1').name, 'גבינת מוצרלה בסגנון');

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
