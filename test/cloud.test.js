// Run with: node test/cloud.test.js
// Two "phones" share one simulated Firebase backend.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parse } = require('../js/parser.js');
const { Store } = require('../js/store.js');
const { Cloud, DELETE, parseInvite } = require('../js/cloud.js');

const clone = (x) => JSON.parse(JSON.stringify(x));
const tick = () => new Promise((r) => setImmediate(r));

/** In-memory stand-in for Firestore, shared by every phone. */
function createBackend() {
  const households = {};
  const listeners = {};
  let nextUid = 1;

  const notify = (hid) => {
    const h = households[hid];
    for (const cb of listeners[hid] || []) {
      setImmediate(() => {
        cb('household', clone(h.data));
        for (const c of ['list', 'receipts', 'trips', 'lists']) cb(c, clone(h[c]));
        cb('catalog', h.catalog ? clone(h.catalog) : null);
      });
    }
  };

  const adapterFor = () => {
    const uid = 'user' + nextUid++;
    return {
      uid,
      async signIn() {
        return uid;
      },
      async getHousehold(hid) {
        return households[hid] ? clone(households[hid].data) : null;
      },
      async createHousehold(hid, data) {
        households[hid] = { data: clone(data), list: {}, receipts: {}, trips: {}, lists: {}, catalog: null };
      },
      async joinHousehold(hid, u) {
        households[hid].data.members.push(u);
        notify(hid);
      },
      async fetchAll(hid) {
        const h = households[hid];
        return clone({ list: h.list, receipts: h.receipts, trips: h.trips, lists: h.lists, catalog: h.catalog });
      },
      subscribe(hid, cb) {
        (listeners[hid] = listeners[hid] || []).push(cb);
        return () => (listeners[hid] = listeners[hid].filter((x) => x !== cb));
      },
      async commit(hid, ops) {
        const h = households[hid];
        if (!h.data.members.includes(uid)) throw new Error('permission-denied');
        for (const op of ops) {
          if (op.type === 'set') h[op.coll][op.id] = clone(op.data);
          else if (op.type === 'delete') delete h[op.coll][op.id];
          else if (op.type === 'catalogSet') h.catalog = clone(op.data);
          else if (op.type === 'catalogUpdate') {
            if (!h.catalog) throw new Error('not-found: catalog');
            for (const [[field, key], value] of op.changes) {
              h.catalog[field] = h.catalog[field] || {};
              if (value === DELETE || (value && value.__delete)) delete h.catalog[field][key];
              else h.catalog[field][key] = clone(value);
            }
          }
        }
        notify(hid);
      },
    };
  };
  return { households, adapterFor };
}

function memoryStorage() {
  const m = {};
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => (m[k] = String(v)), removeItem: (k) => delete m[k] };
}

(async () => {
  const text = fs.readFileSync(path.join(__dirname, 'sample-yohananof.txt'), 'utf8');
  const backend = createBackend();

  // --- Phone A: has a receipt and a list, then creates the household ---
  const storeA = new Store();
  const { unknown } = storeA.importReceipt(parse(text));
  for (const u of unknown) storeA.assignCode(u.key, u.rawName);
  storeA.assignCode('7290000000017', 'חלב');
  storeA.addToList('חלב');
  storeA.addToList('נייר אפייה');

  let updatesA = 0;
  const cloudA = new Cloud(storeA, backend.adapterFor(), { storage: memoryStorage(), onUpdate: () => updatesA++, inviteBase: 'https://x.github.io/kniyot/' });
  await cloudA.start();
  assert.strictEqual(cloudA.status, 'local');
  const hid = await cloudA.createHousehold();
  await tick();
  assert.strictEqual(cloudA.status, 'synced');
  const h = backend.households[hid];
  assert.strictEqual(Object.keys(h.receipts).length, 1, 'receipt uploaded');
  assert.strictEqual(Object.values(h.receipts)[0].purchases.length, 20, 'purchase lines uploaded');
  assert.strictEqual(Object.keys(h.list).length, 2, 'list uploaded');
  assert.ok(h.catalog && Object.keys(h.catalog.products).length > 0, 'catalog uploaded');
  assert.ok(cloudA.inviteLink().endsWith('?join=' + hid));
  assert.strictEqual(parseInvite(cloudA.inviteLink()), hid);
  assert.strictEqual(parseInvite('  ' + hid.toUpperCase() + ' '), hid);
  assert.strictEqual(parseInvite('hello'), null);

  // --- Phone B: has its own list item + a product of the same name, joins via link ---
  const storeB = new Store();
  const pB = storeB.getOrCreateProduct('חלב'); // same name, different id → must merge into A's
  storeB.state.codeMap['9999999999999'] = pB.id;
  storeB.addToList('במבה');
  storeB.addToList('חלב'); // already on A's list → not duplicated
  const cloudB = new Cloud(storeB, backend.adapterFor(), { storage: memoryStorage() });
  await cloudB.start();
  await cloudB.joinHousehold(cloudA.inviteLink());
  await tick();
  await tick();

  const names = (s) => s.state.list.map((i) => i.name).sort();
  assert.deepStrictEqual(names(storeB), ['במבה', 'חלב', 'נייר אפייה'], 'B sees merged list');
  assert.deepStrictEqual(names(storeA), ['במבה', 'חלב', 'נייר אפייה'], 'A gets B\'s item live');
  assert.strictEqual(storeB.state.purchases.length, 20, 'B has A\'s receipt lines');
  const milkA = storeA.findProductByName('חלב');
  assert.strictEqual(storeA.state.codeMap['9999999999999'], milkA.id, 'B\'s code points at the shared milk product');
  assert.strictEqual(Object.values(storeA.state.products).filter((p) => p.name === 'חלב').length, 1, 'one milk, not two');
  assert.ok(storeB.stats(storeB.findProductByName('חלב').id).usualPrice === 6.9, 'B sees milk price from A\'s receipt');
  assert.strictEqual(cloudA.members, 2);

  // --- B checks off milk in the store → A sees it ---
  const milkItemB = storeB.state.list.find((i) => i.name === 'חלב');
  storeB.toggleItem(milkItemB.id);
  await tick();
  await tick();
  assert.ok(storeA.state.list.find((i) => i.name === 'חלב').checked, 'checked on A too');

  // --- Both rename different products at the same time → neither is lost ---
  const cottage = storeA.findProductByName('קוטג 5% 250 גרם');
  const eggs = storeB.findProductByName('ביצים L 12 יח');
  storeA.renameProduct(cottage.id, 'קוטג׳');
  storeB.renameProduct(eggs.id, 'ביצים');
  await tick();
  await tick();
  for (const s of [storeA, storeB]) {
    assert.ok(s.findProductByName('קוטג׳'), 'cottage rename kept');
    assert.ok(s.findProductByName('ביצים'), 'eggs rename kept');
  }

  // --- A finishes the trip → cart cleared everywhere, trip saved ---
  storeA.finishTrip(30);
  await tick();
  await tick();
  assert.ok(!storeB.state.list.some((i) => i.checked), 'cart cleared on B');
  assert.strictEqual(storeB.lastTrip().actual, 30, 'B sees the trip');

  // --- B deletes the receipt → gone for A ---
  storeB.deleteReceipt(storeB.state.receipts[0].id);
  await tick();
  await tick();
  assert.strictEqual(storeA.state.receipts.length, 0);
  assert.strictEqual(storeA.state.purchases.length, 0);

  // --- Extra lists sync, and same-named lists merge on join ---
  const pharmA = storeA.addList('פארם');
  storeA.addToList('אקמול', pharmA.id);
  await tick();
  await tick();
  assert.deepStrictEqual(storeB.extraLists().map((l) => l.name), ['פארם'], 'B sees the new list');
  assert.deepStrictEqual(storeB.itemsOf(pharmA.id).map((i) => i.name), ['אקמול'], 'B sees its items');
  storeB.toggleItem(storeB.itemsOf(pharmA.id)[0].id);
  await tick();
  await tick();
  assert.ok(storeA.itemsOf(pharmA.id)[0].checked, 'A sees B check it off');
  assert.strictEqual(storeA.itemsOf(null).some((i) => i.name === 'אקמול'), false, 'not on the main list');

  const storeD = new Store();
  const pharmD = storeD.addList('פארם');
  storeD.addToList('משחת שיניים', pharmD.id);
  storeD.addToList('אקמול', pharmD.id); // open on D, checked on the shared list → kept as a new open item
  const cloudD = new Cloud(storeD, backend.adapterFor(), { storage: memoryStorage() });
  await cloudD.start();
  await cloudD.joinHousehold(hid);
  await tick();
  await tick();
  assert.strictEqual(storeA.extraLists().length, 1, 'one פארם list, not two');
  assert.deepStrictEqual(storeA.itemsOf(pharmA.id).map((i) => i.name).sort(), ['אקמול', 'אקמול', 'משחת שיניים'].sort(), 'D\'s items moved into the shared list');

  // --- Reopening the app on A: rejoins the saved household by itself ---
  const storageA2 = memoryStorage();
  storageA2.setItem('kniyot.household', hid);
  const storeA2 = new Store();
  const cloudA2 = new Cloud(storeA2, { ...backend.adapterFor(), signIn: async () => cloudA.uid }, { storage: storageA2 });
  await cloudA2.start();
  assert.strictEqual(cloudA2.status, 'synced');
  assert.deepStrictEqual(names(storeA2), names(storeA), 'fresh phone loads the shared list');

  // --- Wrong code ---
  const cloudC = new Cloud(new Store(), backend.adapterFor(), { storage: memoryStorage() });
  await cloudC.start();
  await assert.rejects(() => cloudC.joinHousehold('zzzzzzzzzzzzzzzzzzzz'), /לא נמצאה/);

  // --- Leaving stops syncing on that phone only ---
  cloudB.leave();
  storeB.addToList('רק אצלי');
  await tick();
  assert.ok(!storeA.state.list.some((i) => i.name === 'רק אצלי'));

  console.log('OK: create, join + merge, live list, concurrent renames, trips, deletes, reopen, leave');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
