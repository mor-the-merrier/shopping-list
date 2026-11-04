/*
 * Data layer: saving, barcode → product mapping, price stats and
 * "what do I need to buy" predictions. All local, no server.
 *
 * State shape:
 *   receipts:  [{ id, chainId, chainName, date, time, invoice, total, itemCount, importedAt }]
 *   purchases: [{ receiptId, key, rawName, unitPrice, qty, total, discount, weighted }]
 *   products:  { [productId]: { id, name } }
 *   codeMap:   { [key]: productId }     key = barcode, or "chain:code" for short in-store codes
 *   list:      [{ id, name, checked, addedAt, listId? }]   items of every list (no listId = main list)
 *   lists:     [{ id, name, createdAt }]   extra simple lists (pharmacy, ...)
 *   dismissed: { [productId]: "YYYY-MM-DD" }   suggestions hidden until that date
 *   trips:     [{ date, estimate, actual, items }]   finished shopping trips
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'kniyot.v1';
  const Categories = () =>
    root.KniyotCategories || (typeof require === 'function' ? require('./categories.js') : null);
  const DAY = 24 * 60 * 60 * 1000;
  const PRICE_WINDOW_DAYS = 365;
  const SUGGEST_AHEAD_DAYS = 2;

  const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const round2 = (n) => Math.round(n * 100) / 100;

  function emptyState() {
    return { receipts: [], purchases: [], products: {}, codeMap: {}, list: [], dismissed: {}, trips: [], lists: [] };
  }

  function median(nums) {
    if (!nums.length) return null;
    const s = nums.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
  }

  function todayISO(now) {
    const d = now ? new Date(now) : new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function addDays(iso, n) {
    return new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);
  }

  /** Real barcodes are global; short codes (produce etc.) are per chain. */
  function codeKey(chainId, code) {
    return String(code).length >= 8 ? String(code) : `${chainId}:${code}`;
  }

  const clampQty = (n) => Math.max(1, Math.min(99, Math.round(Number(n) || 1)));

  /**
   * "2 חלב", "חלב 2", "חלב x2", "3× ביצים" → { name: 'חלב', qty: 2 }.
   * A plain number (no "x") counts only up to 10: "12 ביצים" is a tray of 12,
   * "שמנת 250" is a size. "3%" is part of the name.
   */
  function parseQuantity(text) {
    const s = String(text || '').trim().replace(/\s+/g, ' ');
    let m = s.match(/^(\d{1,2})\s*[x×*]\s*(.*\S)$/); // "2x חלב"
    if (m && /[^\d\s]/.test(m[2])) return { name: m[2].trim(), qty: clampQty(m[1]) };
    m = s.match(/^(\d{1,2})\s+(.*\S)$/); // "2 חלב"
    if (m && /[^\d\s]/.test(m[2]) && +m[1] >= 1 && +m[1] <= 10) return { name: m[2].trim(), qty: clampQty(m[1]) };
    m = s.match(/^(.*\S)\s*[x×*]\s*(\d{1,2})$/);
    if (m) return { name: m[1].trim(), qty: clampQty(m[2]) };
    m = s.match(/^(.*[^\d\s].*?)\s+(\d{1,2})$/);
    if (m && +m[2] >= 1 && +m[2] <= 10) return { name: m[1].trim(), qty: clampQty(m[2]) };
    return { name: s, qty: null };
  }

  class Store {
    constructor(state) {
      this.state = Object.assign(emptyState(), state || {});
    }

    // ---------- persistence ----------
    static load() {
      try {
        const raw = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
        return new Store(raw ? JSON.parse(raw) : null);
      } catch (e) {
        console.warn('Could not load saved data', e);
        return new Store();
      }
    }

    /** Save and tell listeners (the cloud sync) that something changed. */
    save() {
      this.saveLocal();
      if (typeof this.onChange === 'function') this.onChange();
    }

    /** Save to this device only (used when applying changes that came from the cloud). */
    saveLocal() {
      try {
        if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch (e) {
        console.warn('Could not save data', e);
      }
    }

    exportJSON() {
      return JSON.stringify(this.state, null, 2);
    }

    importJSON(json) {
      const data = JSON.parse(json);
      if (!data || !Array.isArray(data.receipts) || typeof data.products !== 'object') {
        throw new Error('הקובץ לא נראה כמו גיבוי של האפליקציה');
      }
      this.state = Object.assign(emptyState(), data);
      this.save();
    }

    // ---------- products ----------
    productList() {
      return Object.values(this.state.products).sort((a, b) => a.name.localeCompare(b.name, 'he'));
    }

    findProductByName(name) {
      const n = norm(name);
      return Object.values(this.state.products).find((p) => norm(p.name) === n) || null;
    }

    /** For the shopping list: exact name only, never a guess. */
    matchProduct(name) {
      return this.findProductByName(name);
    }

    /**
     * Products whose name contains what was typed as whole words
     * ("עגבניות" → "עגבניות שרי", but "חלב" ↛ "חלבה"). Most often bought first.
     */
    similarProducts(name, limit = 4) {
      const n = norm(name);
      if (n.length < 2) return [];
      const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const word = new RegExp(`(^|\\s)${escaped}(\\s|$)`);
      return Object.values(this.state.products)
        .filter((p) => norm(p.name) !== n && word.test(norm(p.name)))
        .map((p) => ({ p, starts: norm(p.name).startsWith(n + ' '), times: (this.stats(p.id) || { timesBought: 0 }).timesBought }))
        .sort((a, b) => Number(b.starts) - Number(a.starts) || b.times - a.times)
        .slice(0, limit)
        .map((x) => x.p);
    }

    renameItem(id, name) {
      const item = this.state.list.find((i) => i.id === id);
      if (item && String(name).trim()) item.name = String(name).trim();
      this.save();
    }

    getOrCreateProduct(name) {
      const existing = this.findProductByName(name);
      if (existing) return existing;
      const p = { id: uid('p'), name: String(name).trim() };
      this.state.products[p.id] = p;
      return p;
    }

    /** Link a receipt code to a product (by name; creates the product if new). */
    assignCode(key, productName) {
      const p = this.getOrCreateProduct(productName);
      this.state.codeMap[key] = p.id;
      return p;
    }

    /** Rename a product. Renaming to an existing name merges the two. */
    renameProduct(id, newName) {
      const p = this.state.products[id];
      if (!p || !String(newName).trim()) return;
      const other = this.findProductByName(newName);
      if (other && other.id !== id) {
        for (const k of Object.keys(this.state.codeMap)) {
          if (this.state.codeMap[k] === id) this.state.codeMap[k] = other.id;
        }
        delete this.state.products[id];
      } else {
        p.name = String(newName).trim();
      }
      this.save();
    }

    // ---------- store sections ----------
    /** Section id for a product: the user's choice, else a guess from its names. */
    categoryOfProduct(product) {
      if (!product) return 'other';
      if (product.category) return product.category;
      return Categories().guessCategory(product.name, ...this.rawNamesOf(product.id));
    }

    /** Section id for a list item (works for items with no receipt history too). */
    categoryOfItem(item) {
      const product = this.matchProduct(item.name);
      return product ? this.categoryOfProduct(product) : Categories().guessCategory(item.name);
    }

    setCategory(productId, categoryId) {
      const p = this.state.products[productId];
      if (!p || !Categories().BY_ID[categoryId]) return;
      p.category = categoryId;
      this.save();
    }

    /** What's left to buy, grouped by section in the order you walk through a store. */
    listBySection() {
      const { ORDER, BY_ID } = Categories();
      const groups = new Map();
      for (const item of this.itemsOf(null)) {
        if (item.checked) continue; // checked items are shown in the cart
        const id = this.categoryOfItem(item);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(item);
      }
      return Array.from(groups.entries())
        .sort((a, b) => ORDER[a[0]] - ORDER[b[0]])
        .map(([id, items]) => ({ category: BY_ID[id], items }));
    }

    codesOf(productId) {
      return Object.keys(this.state.codeMap).filter((k) => this.state.codeMap[k] === productId);
    }

    rawNamesOf(productId) {
      const keys = new Set(this.codesOf(productId));
      const names = new Set(this.state.purchases.filter((x) => keys.has(x.key)).map((x) => x.rawName));
      return Array.from(names);
    }

    // ---------- receipts ----------
    isDuplicate(parsed) {
      return this.state.receipts.some(
        (r) =>
          r.chainId === parsed.chain.id &&
          r.date === parsed.date &&
          r.invoice === parsed.invoice &&
          Math.abs(r.total - parsed.total) < 0.01
      );
    }

    /**
     * Save a parsed receipt. Returns the codes that are not yet linked to a
     * product, so the UI can ask the user what each one is.
     */
    importReceipt(parsed) {
      const receipt = {
        id: uid('r'),
        chainId: parsed.chain.id,
        chainName: parsed.chain.name,
        date: parsed.date || todayISO(),
        time: parsed.time,
        invoice: parsed.invoice,
        total: parsed.total,
        itemCount: parsed.items.length,
        importedAt: new Date().toISOString(),
      };
      this.state.receipts.push(receipt);

      const unknown = new Map();
      for (const item of parsed.items) {
        // No barcode (a line typed in by hand, or unread): keyed by its name.
        const key = item.code ? codeKey(receipt.chainId, item.code) : `name:${norm(item.name)}`;
        this.state.purchases.push({
          receiptId: receipt.id,
          key,
          rawName: item.name,
          unitPrice: item.unitPrice,
          qty: item.qty,
          total: item.total,
          discount: item.discount,
          weighted: item.weighted,
        });
        if (!this.state.codeMap[key] && !unknown.has(key)) {
          unknown.set(key, { key, rawName: item.name, unitPrice: item.unitPrice, weighted: item.weighted });
        }
      }
      this.save();
      return { receipt, unknown: Array.from(unknown.values()) };
    }

    deleteReceipt(id) {
      this.state.receipts = this.state.receipts.filter((r) => r.id !== id);
      this.state.purchases = this.state.purchases.filter((p) => p.receiptId !== id);
      this.save();
    }

    receiptsSorted() {
      return this.state.receipts.slice().sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
    }

    // ---------- stats ----------
    /** All purchases of a product, each with its receipt date. */
    purchasesOf(productId) {
      const keys = new Set(this.codesOf(productId));
      const dates = new Map(this.state.receipts.map((r) => [r.id, r.date]));
      return this.state.purchases
        .filter((p) => keys.has(p.key) && dates.has(p.receiptId))
        .map((p) => Object.assign({ date: dates.get(p.receiptId) }, p));
    }

    stats(productId, now) {
      const today = todayISO(now);
      const all = this.purchasesOf(productId);
      if (!all.length) return null;

      const recent = all.filter((p) => daysBetween(p.date, today) <= PRICE_WINDOW_DAYS);
      const pool = recent.length ? recent : all;
      const prices = pool.map((p) => p.unitPrice);
      const latest = all.slice().sort((a, b) => b.date.localeCompare(a.date))[0];

      const dates = Array.from(new Set(all.map((p) => p.date))).sort();
      const intervals = [];
      for (let i = 1; i < dates.length; i++) {
        const d = daysBetween(dates[i - 1], dates[i]);
        if (d > 0) intervals.push(d);
      }
      const every = intervals.length ? Math.round(median(intervals)) : null;
      const lastDate = dates[dates.length - 1];
      const daysSince = daysBetween(lastDate, today);

      // What a typical shopping trip spends on this product (e.g. 3 cottage cheeses = ₪20.1).
      const perReceipt = new Map();
      for (const p of pool) perReceipt.set(p.receiptId, (perReceipt.get(p.receiptId) || 0) + p.total + p.discount);

      return {
        usualPrice: round2(median(prices)),
        typicalSpend: round2(median(Array.from(perReceipt.values()))),
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        lastPrice: latest.unitPrice,
        lastPaidEach: round2((latest.total + latest.discount) / latest.qty),
        weighted: all.some((p) => p.weighted),
        timesBought: dates.length,
        lastDate,
        daysSince,
        every,
        dueIn: every != null ? every - daysSince : null,
      };
    }

    // ---------- lists ----------
    // The main shopping list (items with no listId) has prices, sections and
    // suggestions. Extra lists ("פארם") are simple: items checked off, nothing else.

    /** Items of one list: null = the main shopping list. */
    itemsOf(listId = null) {
      return this.state.list.filter((i) => (i.listId || null) === (listId || null));
    }

    /** The extra lists, oldest first. */
    extraLists() {
      return (this.state.lists || []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    }

    addList(name) {
      const clean = String(name || '').trim();
      if (!clean) return null;
      this.state.lists = this.state.lists || [];
      const dup = this.state.lists.find((l) => norm(l.name) === norm(clean));
      if (dup) return dup;
      const list = { id: uid('L'), name: clean, createdAt: new Date().toISOString() };
      this.state.lists.push(list);
      this.save();
      return list;
    }

    renameList(id, name) {
      const list = (this.state.lists || []).find((l) => l.id === id);
      if (!list || !String(name).trim()) return;
      list.name = String(name).trim();
      this.save();
    }

    /** Delete a list and its items. */
    deleteList(id) {
      this.state.lists = (this.state.lists || []).filter((l) => l.id !== id);
      this.state.list = this.state.list.filter((i) => i.listId !== id);
      this.save();
    }

    // ---------- list items ----------
    /**
     * Add to a list. qty: how many (omitted = "the usual amount").
     * Adding something that's already on the list raises its quantity instead.
     * Returns the item; item.merged is true when an existing line was raised.
     */
    addToList(name, listId = null, qty = null) {
      const clean = String(name || '').trim(); // exactly what was typed
      if (!clean) return null;
      const dup = this.itemsOf(listId).find((i) => !i.checked && norm(i.name) === norm(clean));
      if (dup) {
        dup.qty = clampQty((dup.qty || 1) + (qty || 1));
        this.save();
        return Object.assign(dup, { merged: true });
      }
      const item = { id: uid('l'), name: clean, checked: false, addedAt: new Date().toISOString() };
      if (listId) item.listId = listId;
      if (qty && qty > 1) item.qty = clampQty(qty);
      this.state.list.push(item);
      this.save();
      return item;
    }

    setQty(id, qty) {
      const item = this.state.list.find((i) => i.id === id);
      if (!item) return;
      item.qty = clampQty(qty);
      this.save();
    }

    toggleItem(id) {
      const item = this.state.list.find((i) => i.id === id);
      if (item) item.checked = !item.checked;
      this.save();
    }

    removeItem(id) {
      this.state.list = this.state.list.filter((i) => i.id !== id);
      this.save();
    }

    clearChecked(listId = null) {
      this.state.list = this.state.list.filter((i) => !(i.checked && (i.listId || null) === (listId || null)));
      this.save();
    }

    /**
     * Estimated cost of the list, from what is usually spent on each product.
     * Items with no price history are counted in `unpriced`.
     */
    estimate(now) {
      const sum = { all: 0, cart: 0, unpriced: 0, items: 0 };
      for (const item of this.itemsOf(null)) {
        sum.items++;
        const p = this.matchProduct(item.name);
        const s = p ? this.stats(p.id, now) : null;
        if (!s) {
          sum.unpriced++;
          continue;
        }
        const line = this.lineEstimate(item, s);
        sum.all += line;
        if (item.checked) sum.cart += line;
      }
      sum.all = round2(sum.all);
      sum.cart = round2(sum.cart);
      return sum;
    }

    /**
     * Expected cost of one list line. No quantity given: what a trip usually
     * spends on it (3 cottage cheeses = 3). A quantity: the usual price × that many
     * (for something weighed, that many times the usual amount).
     */
    lineEstimate(item, stats) {
      if (!stats) return 0;
      if (!item.qty) return stats.typicalSpend;
      return round2((stats.weighted ? stats.typicalSpend : stats.usualPrice) * item.qty);
    }

    /** Close a shopping trip: remember estimate vs. actual, clear the cart. */
    finishTrip(actual, now) {
      const est = this.estimate(now);
      const cartCount = this.itemsOf(null).filter((i) => i.checked).length;
      this.state.trips = this.state.trips || [];
      this.state.trips.push({
        id: uid('t'),
        date: todayISO(now),
        estimate: est.cart || est.all,
        actual: actual != null && !isNaN(actual) ? round2(actual) : null,
        items: cartCount,
      });
      this.state.list = this.state.list.filter((i) => !(i.checked && !i.listId)); // main list only
      this.save();
      return this.state.trips[this.state.trips.length - 1];
    }

    lastTrip() {
      const t = this.state.trips || [];
      return t.length ? t[t.length - 1] : null;
    }

    /** Products that are probably running out, based on how often they are bought. */
    suggestions(now) {
      const today = todayISO(now);
      const onList = new Set();
      for (const i of this.itemsOf(null).filter((x) => !x.checked)) {
        const m = this.matchProduct(i.name);
        if (m) onList.add(m.id);
      }
      const out = [];
      for (const p of Object.values(this.state.products)) {
        if (onList.has(p.id)) continue;
        const hiddenUntil = this.state.dismissed[p.id];
        if (hiddenUntil && hiddenUntil > today) continue;
        const s = this.stats(p.id, now);
        if (!s || s.every == null) continue;
        // Overdue by a lot → probably not buying it any more.
        if (s.daysSince > s.every * 3) continue;
        if (s.dueIn <= SUGGEST_AHEAD_DAYS) out.push({ product: p, stats: s });
      }
      return out.sort((a, b) => a.stats.dueIn - b.stats.dueIn);
    }

    dismissSuggestion(productId, now) {
      const s = this.stats(productId, now);
      const days = s && s.every ? Math.max(2, Math.round(s.every / 2)) : 7;
      this.state.dismissed[productId] = addDays(todayISO(now), days);
      this.save();
    }
  }

  const api = { Store, codeKey, median, todayISO, uid, norm, parseQuantity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KniyotStore = api;
})(typeof window !== 'undefined' ? window : globalThis);
