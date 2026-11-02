/*
 * Family sharing: keeps the data in Firebase (Cloud Firestore) so everyone
 * in the household sees the same list, receipts and prices.
 *
 * - Sign-in is anonymous: no accounts or passwords. A household is joined
 *   with its invite link, and the link is also how you get back in on a new phone.
 * - Firestore works offline and syncs when the connection is back.
 *
 * Firestore layout (one household):
 *   households/{hid}                  { members: [uid], createdAt }
 *   households/{hid}/list/{itemId}    a shopping-list item
 *   households/{hid}/receipts/{id}    receipt details + its purchase lines
 *   households/{hid}/trips/{id}       a finished shopping trip
 *   households/{hid}/lists/{id}       an extra simple list (its items are in list/, tagged listId)
 *   households/{hid}/meta/catalog     { products, codeMap, dismissed }
 *
 * The sync logic talks to an "adapter", so it can be tested without Firebase
 * (see test/cloud.test.js). firebaseAdapter() below is the real one.
 */
(function (root) {
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyB63PFbSBQpjaXmUY-ATsZDD09J6PIA8P0',
    authDomain: 'more-the-merrier.firebaseapp.com',
    projectId: 'more-the-merrier',
    storageBucket: 'more-the-merrier.firebasestorage.app',
    messagingSenderId: '623659560479',
    appId: '1:623659560479:web:92a3f3a8d3eba5438aef2a',
  };
  const SDK_BASE = 'https://www.gstatic.com/firebasejs/10.14.1/';

  const HOUSEHOLD_KEY = 'kniyot.household';
  const DIRTY_KEY = 'kniyot.dirty';
  const COLLECTIONS = ['list', 'receipts', 'trips', 'lists'];
  const DELETE = { __delete: true };

  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const emptyCatalog = () => ({ products: {}, codeMap: {}, dismissed: {} });

  function randomId(length) {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alikes (l/1, o/0)
    const bytes = new Uint8Array(length);
    (root.crypto || require('crypto').webcrypto).getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  // ---------- app state <-> Firestore documents ----------

  /** Split the app state into the documents it is stored as. */
  function toParts(state) {
    const list = {};
    for (const item of state.list || []) list[item.id] = clone(item);

    const receipts = {};
    for (const r of state.receipts || []) receipts[r.id] = Object.assign(clone(r), { purchases: [] });
    for (const p of state.purchases || []) {
      const r = receipts[p.receiptId];
      if (!r) continue;
      const line = clone(p);
      delete line.receiptId;
      r.purchases.push(line);
    }

    const trips = {};
    (state.trips || []).forEach((t, i) => {
      if (!t.id) t.id = `t${String(t.date).replace(/-/g, '')}${i}`;
      trips[t.id] = clone(t);
    });

    const lists = {};
    for (const l of state.lists || []) lists[l.id] = clone(l);

    const catalog = {
      products: clone(state.products || {}),
      codeMap: clone(state.codeMap || {}),
      dismissed: clone(state.dismissed || {}),
    };
    return { list, receipts, trips, lists, catalog };
  }

  /** Put one part that came from the cloud back into the app state. */
  function applyPart(state, name, data) {
    if (name === 'list') {
      state.list = Object.values(data || {}).sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
    } else if (name === 'receipts') {
      const docs = Object.values(data || {});
      state.receipts = docs.map((r) => {
        const meta = clone(r);
        delete meta.purchases;
        return meta;
      });
      state.purchases = [];
      for (const r of docs) for (const p of r.purchases || []) state.purchases.push(Object.assign({ receiptId: r.id }, clone(p)));
    } else if (name === 'trips') {
      state.trips = Object.values(data || {}).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    } else if (name === 'lists') {
      state.lists = Object.values(data || {}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    } else if (name === 'catalog') {
      const c = data || emptyCatalog();
      state.products = clone(c.products || {});
      state.codeMap = clone(c.codeMap || {});
      state.dismissed = clone(c.dismissed || {});
    }
  }

  function applyAll(state, parts) {
    for (const name of COLLECTIONS) applyPart(state, name, parts[name]);
    applyPart(state, 'catalog', parts.catalog);
  }

  /** The writes needed to turn `prev` (what the cloud has) into `next` (what the app has). */
  function diffParts(prev, next) {
    const ops = [];
    for (const coll of COLLECTIONS) {
      const a = prev[coll] || {};
      const b = next[coll] || {};
      for (const id of Object.keys(b)) if (!same(a[id], b[id])) ops.push({ type: 'set', coll, id, data: clone(b[id]) });
      for (const id of Object.keys(a)) if (!(id in b)) ops.push({ type: 'delete', coll, id });
    }
    if (!prev.catalog) {
      ops.push({ type: 'catalogSet', data: clone(next.catalog) });
    } else {
      // Field-by-field, so two people naming different products don't overwrite each other.
      const changes = [];
      for (const field of ['products', 'codeMap', 'dismissed']) {
        const a = prev.catalog[field] || {};
        const b = next.catalog[field] || {};
        for (const k of Object.keys(b)) if (!same(a[k], b[k])) changes.push([[field, k], clone(b[k])]);
        for (const k of Object.keys(a)) if (!(k in b)) changes.push([[field, k], DELETE]);
      }
      if (changes.length) ops.push({ type: 'catalogUpdate', changes });
    }
    return ops;
  }

  /**
   * Joining a household that already has data: keep everything it has, and add
   * what exists only on this phone. Products with the same name become one.
   */
  function mergeParts(local, remote) {
    const merged = {
      list: clone(remote.list || {}),
      receipts: clone(remote.receipts || {}),
      trips: clone(remote.trips || {}),
      lists: clone(remote.lists || {}),
      catalog: clone(remote.catalog || emptyCatalog()),
    };
    const cat = merged.catalog;
    cat.products = cat.products || {};
    cat.codeMap = cat.codeMap || {};
    cat.dismissed = cat.dismissed || {};

    const idByName = {};
    for (const p of Object.values(cat.products)) idByName[norm(p.name)] = p.id;
    const remap = {};
    for (const p of Object.values(local.catalog.products || {})) {
      const existing = idByName[norm(p.name)];
      if (existing) {
        remap[p.id] = existing;
      } else {
        cat.products[p.id] = clone(p);
        idByName[norm(p.name)] = p.id;
        remap[p.id] = p.id;
      }
    }
    for (const [key, pid] of Object.entries(local.catalog.codeMap || {})) {
      if (!(key in cat.codeMap) && remap[pid]) cat.codeMap[key] = remap[pid];
    }
    for (const [pid, until] of Object.entries(local.catalog.dismissed || {})) {
      const id = remap[pid];
      if (id && !cat.dismissed[id]) cat.dismissed[id] = until;
    }

    const receiptKey = (r) => [r.chainId, r.date, r.invoice, Math.round(Number(r.total) * 100)].join('|');
    const haveReceipts = new Set(Object.values(merged.receipts).map(receiptKey));
    for (const r of Object.values(local.receipts)) {
      if (!merged.receipts[r.id] && !haveReceipts.has(receiptKey(r))) merged.receipts[r.id] = clone(r);
    }

    // Extra lists with the same name become one ("פארם" on both phones).
    const listIdByName = {};
    for (const l of Object.values(merged.lists)) listIdByName[norm(l.name)] = l.id;
    const listRemap = {};
    for (const l of Object.values(local.lists || {})) {
      const existing = listIdByName[norm(l.name)];
      if (existing) listRemap[l.id] = existing;
      else {
        merged.lists[l.id] = clone(l);
        listIdByName[norm(l.name)] = l.id;
        listRemap[l.id] = l.id;
      }
    }

    // Items: skip one that's already open on the same list.
    const openKey = (i) => `${i.listId || ''}|${norm(i.name)}`;
    const open = new Set(Object.values(merged.list).filter((i) => !i.checked).map(openKey));
    for (const item of Object.values(local.list)) {
      if (merged.list[item.id]) continue;
      const copy = clone(item);
      if (copy.listId) copy.listId = listRemap[copy.listId] || copy.listId;
      if (!copy.checked && open.has(openKey(copy))) continue;
      merged.list[copy.id] = copy;
    }

    for (const t of Object.values(local.trips)) if (!merged.trips[t.id]) merged.trips[t.id] = clone(t);
    return merged;
  }

  // ---------- the sync engine ----------

  class Cloud {
    /**
     * @param store    the app's Store
     * @param adapter  firebaseAdapter() or a test double
     * @param options  { storage: localStorage-like, onUpdate: called after any change, inviteBase: URL }
     */
    constructor(store, adapter, options = {}) {
      this.store = store;
      this.adapter = adapter;
      this.storage = options.storage || null;
      this.onUpdate = options.onUpdate || (() => {});
      this.inviteBase = options.inviteBase || '';
      this.status = 'off'; // off | connecting | local | synced | unavailable | error
      this.error = null;
      this.uid = null;
      this.hid = null;
      this.synced = null; // what the cloud has, as parts
      this.unsubscribe = null;
      this.pushQueued = false;
      this.members = 0;
    }

    get(key) {
      try {
        return this.storage ? this.storage.getItem(key) : null;
      } catch (e) {
        return null;
      }
    }

    set(key, value) {
      try {
        if (!this.storage) return;
        if (value == null) this.storage.removeItem(key);
        else this.storage.setItem(key, value);
      } catch (e) {
        /* storage blocked: sharing still works for this session */
      }
    }

    setStatus(status, error) {
      this.status = status;
      this.error = error || null;
      this.onUpdate();
    }

    inviteLink() {
      return this.hid ? `${this.inviteBase}?join=${this.hid}` : '';
    }

    async start() {
      this.setStatus('connecting');
      this.store.onChange = () => {
        if (this.hid && this.synced) this.queuePush();
        else this.set(DIRTY_KEY, '1'); // changed while not connected
      };
      try {
        this.uid = await this.adapter.signIn();
      } catch (e) {
        console.warn('Sharing unavailable', e);
        this.setStatus('unavailable', e);
        return;
      }
      const hid = this.get(HOUSEHOLD_KEY);
      if (hid) {
        try {
          await this.attach(hid, { merge: this.get(DIRTY_KEY) === '1' });
        } catch (e) {
          console.warn(e);
          this.setStatus('error', e);
        }
      } else {
        this.setStatus('local');
      }
    }

    /** Start a shared household from what is on this phone. */
    async createHousehold() {
      const hid = randomId(20);
      await this.adapter.createHousehold(hid, { members: [this.uid], createdAt: new Date().toISOString() });
      this.set(HOUSEHOLD_KEY, hid);
      this.hid = hid;
      this.synced = { list: {}, receipts: {}, trips: {}, lists: {}, catalog: null };
      await this.pushNow();
      await this.attach(hid, { merge: false });
      return hid;
    }

    /** Join with an invite link or code. Data on this phone is added to the household. */
    async joinHousehold(codeOrLink) {
      const hid = parseInvite(codeOrLink);
      if (!hid) throw new Error('הקוד לא תקין. צריך להדביק את קישור ההזמנה או את הקוד שבסופו.');
      const household = await this.adapter.getHousehold(hid);
      if (!household) throw new Error('לא נמצאה רשימה משותפת עם הקוד הזה.');
      if (!(household.members || []).includes(this.uid)) await this.adapter.joinHousehold(hid, this.uid);
      this.set(HOUSEHOLD_KEY, hid);
      await this.attach(hid, { merge: true });
    }

    /** Stop sharing on this phone. The household and its data stay in the cloud. */
    leave() {
      if (this.unsubscribe) this.unsubscribe();
      this.unsubscribe = null;
      this.hid = null;
      this.synced = null;
      this.set(HOUSEHOLD_KEY, null);
      this.setStatus('local');
    }

    async attach(hid, { merge }) {
      if (this.unsubscribe) this.unsubscribe();
      this.hid = hid;
      const household = await this.adapter.getHousehold(hid);
      this.members = household ? (household.members || []).length : 0;
      const remote = await this.adapter.fetchAll(hid);
      const local = toParts(this.store.state);
      const next = merge ? mergeParts(local, remote) : Object.assign({}, remote, { catalog: remote.catalog || emptyCatalog() });

      applyAll(this.store.state, clone(next));
      this.store.saveLocal();
      this.synced = clone(remote);
      this.set(DIRTY_KEY, null);
      await this.pushNow(); // uploads whatever the merge added

      this.unsubscribe = this.adapter.subscribe(hid, (name, data) => this.onRemote(name, data));
      this.setStatus('synced');
    }

    onRemote(name, data) {
      if (name === 'error') {
        this.setStatus('error', data);
        return;
      }
      if (name === 'household') {
        this.members = (data && data.members ? data.members : []).length;
        this.onUpdate();
        return;
      }
      if (!this.synced) return;
      if (name === 'catalog' && !data) return;
      this.synced[name] = clone(data);
      applyPart(this.store.state, name, clone(data));
      this.store.saveLocal();
      if (this.status !== 'synced') this.status = 'synced';
      this.onUpdate();
    }

    /** Several saves in the same moment become one upload. */
    queuePush() {
      if (this.pushQueued) return;
      this.pushQueued = true;
      Promise.resolve().then(() => {
        this.pushQueued = false;
        this.pushNow();
      });
    }

    async pushNow() {
      if (!this.hid || !this.synced) return;
      const next = toParts(this.store.state);
      const ops = diffParts(this.synced, next);
      if (!ops.length) return;
      this.synced = clone(next);
      try {
        await this.adapter.commit(this.hid, ops);
      } catch (e) {
        console.warn('Sync failed', e);
        this.setStatus('error', e);
      }
    }
  }

  /** Accepts a full invite link, "?join=CODE", or just the code. */
  function parseInvite(text) {
    const s = String(text || '').trim();
    const fromLink = s.match(/[?&]join=([a-z0-9]{12,40})/i);
    if (fromLink) return fromLink[1].toLowerCase();
    if (/^[a-z0-9]{12,40}$/i.test(s)) return s.toLowerCase();
    return null;
  }

  // ---------- the real Firebase adapter ----------

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('לא הצלחתי לטעון את Firebase'));
      document.head.appendChild(s);
    });
  }

  function firebaseAdapter(config = FIREBASE_CONFIG) {
    let fb = null;
    let db = null;

    async function load() {
      if (db) return;
      if (!root.firebase || !root.firebase.firestore) {
        await loadScript(SDK_BASE + 'firebase-app-compat.js');
        await loadScript(SDK_BASE + 'firebase-auth-compat.js');
        await loadScript(SDK_BASE + 'firebase-firestore-compat.js');
      }
      fb = root.firebase;
      if (!fb.apps.length) fb.initializeApp(config);
      db = fb.firestore();
      try {
        await db.enablePersistence({ synchronizeTabs: true }); // works offline
      } catch (e) {
        console.warn('Offline cache unavailable', e.code || e);
      }
    }

    const home = (hid) => db.collection('households').doc(hid);

    return {
      async signIn() {
        await load();
        const auth = fb.auth();
        const existing = await new Promise((resolve) => {
          const stop = auth.onAuthStateChanged((user) => {
            stop();
            resolve(user);
          });
        });
        if (existing) return existing.uid;
        const cred = await auth.signInAnonymously();
        return cred.user.uid;
      },

      async getHousehold(hid) {
        const snap = await home(hid).get();
        return snap.exists ? snap.data() : null;
      },

      createHousehold(hid, data) {
        return home(hid).set(data);
      },

      joinHousehold(hid, uid) {
        return home(hid).update({ members: fb.firestore.FieldValue.arrayUnion(uid) });
      },

      async fetchAll(hid) {
        const out = {};
        for (const coll of COLLECTIONS) {
          const snap = await home(hid).collection(coll).get();
          out[coll] = {};
          snap.forEach((d) => (out[coll][d.id] = d.data()));
        }
        const cat = await home(hid).collection('meta').doc('catalog').get();
        out.catalog = cat.exists ? cat.data() : null;
        return out;
      },

      subscribe(hid, callback) {
        const onError = (err) => callback('error', err);
        const stops = COLLECTIONS.map((coll) =>
          home(hid)
            .collection(coll)
            .onSnapshot((snap) => {
              const docs = {};
              snap.forEach((d) => (docs[d.id] = d.data()));
              callback(coll, docs);
            }, onError)
        );
        stops.push(home(hid).collection('meta').doc('catalog').onSnapshot((d) => callback('catalog', d.exists ? d.data() : null), onError));
        stops.push(home(hid).onSnapshot((d) => callback('household', d.exists ? d.data() : null), onError));
        return () => stops.forEach((stop) => stop());
      },

      async commit(hid, ops) {
        const FieldValue = fb.firestore.FieldValue;
        const FieldPath = fb.firestore.FieldPath;
        // A batch holds at most 500 writes.
        for (let i = 0; i < ops.length; i += 400) {
          const batch = db.batch();
          for (const op of ops.slice(i, i + 400)) {
            if (op.type === 'set') batch.set(home(hid).collection(op.coll).doc(op.id), op.data);
            else if (op.type === 'delete') batch.delete(home(hid).collection(op.coll).doc(op.id));
            else if (op.type === 'catalogSet') batch.set(home(hid).collection('meta').doc('catalog'), op.data);
            else if (op.type === 'catalogUpdate') {
              const args = [];
              for (const [path, value] of op.changes) {
                args.push(new FieldPath(...path), value === DELETE || (value && value.__delete) ? FieldValue.delete() : value);
              }
              batch.update(home(hid).collection('meta').doc('catalog'), ...args);
            }
          }
          await batch.commit();
        }
      },
    };
  }

  const api = { Cloud, firebaseAdapter, toParts, applyPart, applyAll, diffParts, mergeParts, parseInvite, DELETE, FIREBASE_CONFIG };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KniyotCloud = api;
})(typeof window !== 'undefined' ? window : globalThis);
