// Run with: node test/parser.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parse, parseItemLine, visualToLogical } = require('../js/parser.js');

const text = fs.readFileSync(path.join(__dirname, 'sample-yohananof.txt'), 'utf8');
const r = parse(text);

assert.strictEqual(r.chain.name, 'יוחננוף');
assert.strictEqual(r.date, '2026-10-13');
assert.strictEqual(r.invoice, '4521');
assert.strictEqual(r.total, 196.58);
assert.strictEqual(r.items.length, 20, 'all 20 item lines parsed');
assert.deepStrictEqual(r.warnings, [], 'no warnings: ' + r.warnings.join(' | '));

const milk = r.items.find((i) => i.code === '7290000000017');
assert.strictEqual(milk.unitPrice, 6.9);
assert.strictEqual(milk.weighted, false);

const banana = r.items.find((i) => i.code === '623');
assert.strictEqual(banana.name, 'בננה');
assert.strictEqual(banana.weighted, true);
assert.strictEqual(banana.qty, 1.3);

const yogurt = r.items.find((i) => i.code === '7290000000062');
assert.strictEqual(yogurt.qty, 3);
assert.strictEqual(yogurt.discount, -2.6);

const cottage = r.items.filter((i) => i.code === '7290000000055');
assert.strictEqual(cottage.length, 2);
assert.strictEqual(cottage[1].discount, 0);
const paper = r.items.find((i) => i.code === '7290000000123');
assert.strictEqual(paper.discount, -10);

// Reversed column order (as a PDF may produce it)
const rev = parseItemLine('ILS6.9 1 6.9 חלב 3% 7290000000017 1');
assert.strictEqual(rev.code, '7290000000017');
assert.strictEqual(rev.unitPrice, 6.9);

// Visual-order Hebrew line
assert.strictEqual(visualToLogical('רג 80 תיקש'), 'שקית 80 גר');
assert.strictEqual(visualToLogical('הבלח 5%'), '5% חלבה');

console.log(`OK: ${r.items.length} items, sum ₪${r.itemsSum} = total ₪${r.total}`);
