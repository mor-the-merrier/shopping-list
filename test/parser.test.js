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

// The same receipt as pdf.js extracts it in the browser: currency after the
// amount at the end of each line, total written backwards, time before the
// date, mirrored parentheses. (Regression: "ILS\s+" used to swallow line breaks.)
const pdfStyle = text
  .replace(/ILS(-?\d+(?:\.\d+)?)/g, '$1ILS')
  .replace(/סה"כ: (\d+(?:\.\d+)?)ILS/, '$1ILS :סה"כ')
  .replace('13/10/2026 18:20:05', '18:20:05 13/10/2026')
  .replace('יוגורט טבעי 3%', 'יוגורט טבעי )3%(');
const p = parse(pdfStyle);
assert.strictEqual(p.items.length, 20, 'pdf-style: all lines parsed');
assert.strictEqual(p.total, 196.58, 'pdf-style: reversed total found');
assert.deepStrictEqual(p.warnings, [], 'pdf-style: no warnings: ' + p.warnings.join(' | '));
assert.strictEqual(p.time, '18:20:05');
assert.strictEqual(p.items.find((i) => i.code === '7290000000062').name, 'יוגורט טבעי (3%)');
assert.strictEqual(p.items.find((i) => i.code === '7290000000123').discount, -10);

console.log(`OK: ${r.items.length} items, sum ₪${r.itemsSum} = total ₪${r.total} (also in pdf.js layout)`);
