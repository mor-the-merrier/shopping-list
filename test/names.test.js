// Run with: node test/names.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const N = require('../js/names.js');

(async () => {
  // ---------- OCR-aware word fixes ----------
  const v = new N.Vocabulary(['פקורינו']);
  assert.strictEqual(v.fixName('הומום נרעי:ים 42'), 'חומוס גרעינים 42', 'ה/ח, ם/ס confused; ":" was a letter');
  assert.strictEqual(v.fixName('גנ ינת 36%'), 'גבינת 36%', 'a word split in two is joined');
  assert.strictEqual(v.fixName('טלב תנובה'), 'חלב תנובה');
  assert.strictEqual(v.fixName('בטטה מובחרת'), 'בטטה מובחרת', 'correct words untouched');
  assert.strictEqual(v.fixName('קשקשת 500'), 'קשקשת 500', 'nothing close: left as read');
  assert.ok(N.distance('הומום', 'חומוס', 5) < 1, 'confusable letters are cheap');
  assert.ok(N.distance('בננה', 'חומוס', 5) >= 3);

  // ---------- improve(): your products, then the barcode list, then OCR fixes ----------
  // Serve a made-up barcode list from a temporary folder via a fake fetch.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'names-'));
  fs.writeFileSync(path.join(dir, 'barcodes.json'), JSON.stringify({ '7290000000015': 'גבינת פקורינו 36% 200 גר' }));
  fs.writeFileSync(path.join(dir, 'words.json'), JSON.stringify(['שמנת', 'לבישול']));
  global.fetch = async (url) => {
    const file = path.join(dir, path.basename(url));
    if (!fs.existsSync(file)) return { ok: false };
    return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
  N._reset();

  const items = [
    { code: '7290000000015', name: 'ינת בקךרי1 36%' }, // in the barcode list
    { code: '7290000000039', name: 'שמנת לבי:שול 15%' }, // not in the list: fixed from words.json
    { code: '7290000000046', name: 'לחם' }, // you named it already
    { code: '208428', name: 'הומום נרעי:ים' }, // in-store code: fixed from the base vocabulary
  ];
  await N.improve(items, { fixOcr: true, known: (c) => (c === '7290000000046' ? 'לחם אחיד' : null) });
  assert.deepStrictEqual(
    items.map((i) => [i.name, i.nameFrom]),
    [
      ['גבינת פקורינו', 'barcode'],
      ['שמנת לבישול 15%', 'fixed'],
      ['לחם אחיד', 'yours'],
      ['חומוס גרעינים', 'fixed'],
    ]
  );
  assert.strictEqual(items[0].ocrName, 'ינת בקךרי1 36%', 'what OCR read is kept');
  assert.strictEqual(items[0].fullName, 'גבינת פקורינו 36% 200 גר', 'the full store name is kept');

  // Text receipts: barcode names only, readable names never "fixed"
  N._reset();
  const text = [{ code: '7290000000099', name: 'חלב תנובה טרי קרט+ פ' }];
  await N.improve(text, { fixOcr: false });
  assert.strictEqual(text[0].name, 'חלב תנובה טרי קרט+ פ');

  // No barcode list yet (first run, offline): still works
  global.fetch = async () => ({ ok: false });
  N._reset();
  const offline = [{ code: '7290000000015', name: 'טלב' }];
  await N.improve(offline, { fixOcr: true });
  assert.strictEqual(offline[0].name, 'חלב');

  // ---------- short names ----------
  const short = {
    'שמנת לבישול 15% 250 מ"ל': 'שמנת לבישול',
    'פקורינו פרוס 34% 150גר': 'פקורינו פרוס',
    'קוטג 5% 250ג שטראוס': 'קוטג',
    'יוגורט יווני8*140ג יופלה': 'יוגורט יווני',
    'חלב מפוסטר 1% בקרטון 1ל': 'חלב מפוסטר',
    'גב.לבנה 5% שומן 500 גרם': 'גבינה לבנה',
    'שמנת חמוצה15% חצי מנה100': 'שמנת חמוצה',
    'גבינה חצי קשה מופחת': 'גבינה חצי קשה מופחת',
    'תירס בואקום - 2 יח )ק(': 'תירס',
    'מוצרלה בגליל 22% במשקל': 'מוצרלה בגליל',
    'לחם אחיד פרוס': 'לחם אחיד פרוס',
  };
  for (const [full, want] of Object.entries(short)) assert.strictEqual(N.shortName(full), want, full);

  console.log('OK: product names (barcode list, your products, OCR fixes)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
