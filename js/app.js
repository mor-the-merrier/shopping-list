/*
 * UI: four screens (list, receipts, products, family). Plain DOM, no framework.
 */
(function () {
  'use strict';

  const { Store } = window.KniyotStore;
  const store = Store.load();

  const ui = {
    tab: 'list',
    expanded: null, // list item id with open details
    pending: null, // { parsed, duplicate, text }
    unknown: null, // codes waiting to be named after a save
    productQuery: '',
    editing: null, // product id being renamed
    confirmDelete: null, // receipt id waiting for a second tap
    listId: (() => {
      try {
        return localStorage.getItem('kniyot.currentList') || null;
      } catch (e) {
        return null;
      }
    })(), // null = the main shopping list
    creatingList: false,
    editingList: false,
    confirmDeleteList: false,
    pendingJoin: null, // household code from an invite link
    joinError: '',
    busy: false, // a create/join is in progress
    confirmLeave: false,
  };

  // ---------- family sharing (Firebase) ----------
  let cloud = null;
  if (window.KniyotCloud && /^https?:$/.test(location.protocol)) {
    const { Cloud, firebaseAdapter } = window.KniyotCloud;
    // window.__kniyotTestAdapter lets browser tests use a simulated Firebase.
    cloud = new Cloud(store, window.__kniyotTestAdapter || firebaseAdapter(), {
      storage: (() => {
        try {
          return window.localStorage;
        } catch (e) {
          return null;
        }
      })(),
      onUpdate: () => render(),
      inviteBase: location.origin + location.pathname,
    });
  }
  const params = new URLSearchParams(location.search);
  if (params.get('join')) ui.pendingJoin = params.get('join');

  function clearJoinParam() {
    ui.pendingJoin = null;
    try {
      history.replaceState(null, '', location.pathname);
    } catch (e) {
      /* not allowed in some frames */
    }
  }

  function cloudErrorText(err) {
    const code = (err && (err.code || err.message)) || '';
    if (/permission/i.test(code)) return 'אין הרשאה לרשימה הזו. אם זו הפעם הראשונה, צריך להדביק את כללי האבטחה ב־Firebase (מוסבר ב־README).';
    if (/operation-not-allowed|admin-restricted/i.test(code)) return 'צריך להפעיל כניסה אנונימית ב־Firebase (Authentication ← Sign-in method ← Anonymous).';
    if (/unavailable|network|offline/i.test(code)) return 'אין חיבור לאינטרנט. השינויים נשמרים ויסתנכרנו כשהחיבור יחזור.';
    return (err && err.message) || 'משהו השתבש בסנכרון.';
  }

  const view = document.getElementById('view');
  const ICON_CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';

  // ---------- helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const money = (n) => {
    if (n == null || isNaN(n)) return '';
    // Like a shelf tag: 18.90, 6.77, 79
    const fixed = Number(n).toFixed(2);
    return fixed.endsWith('.00') ? fixed.slice(0, -3) : fixed;
  };

  const dateHe = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${Number(d)}.${Number(m)}.${y}`;
  };

  const round2 = (n) => Math.round(n * 100) / 100;

  const daysHe = (n) => (n === 0 ? 'היום' : n === 1 ? 'אתמול' : `לפני ${n} ימים`);

  const everyHe = (n) => (n === 1 ? 'כל יום' : n === 7 ? 'כל שבוע' : n === 14 ? 'כל שבועיים' : `כל ~${n} ימים`);

  const dueHe = (dueIn) => {
    if (dueIn < 0) return `היה אמור להיגמר ${daysHe(-dueIn)}`;
    if (dueIn === 0) return 'כנראה נגמר היום';
    if (dueIn === 1) return 'כנראה ייגמר מחר';
    return `כנראה ייגמר בעוד ${dueIn} ימים`;
  };

  function toast(msg) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2700);
  }

  /** Shorten a receipt name into a friendlier default ("ביצים 12 יח גדול" → "ביצים"). */
  function suggestName(raw) {
    let s = String(raw)
      .replace(/\b\d+(?:\.\d+)?\s*(?:גרם|גר|ג|ק["״]?ג|קג|מ["״]?ל|מל|ליטר|ל|יח(?:'|׳)?|%)(?=\s|$)/g, '')
      .replace(/\b\d+(?:\.\d+)?%?(?=\s|$)/g, '')
      .replace(/\s+[א-ת]["״]?$/g, '') // trailing cut-off letter
      .replace(/\s+(?:שקית|יח|במשקל|שקיל)(?=\s|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return s || String(raw).trim();
  }

  function priceTag(stats) {
    if (!stats) return '';
    return `<span class="price" aria-label="בערך ${money(stats.usualPrice)} שקלים${stats.weighted ? ' לקילו' : ''}"><bdi dir="ltr"><span class="approx" aria-hidden="true">~</span>₪${money(stats.usualPrice)}</bdi>${
      stats.weighted ? '<small> לק״ג</small>' : ''
    }</span>`;
  }

  function refreshDatalist() {
    document.getElementById('productNames').innerHTML = store
      .productList()
      .map((p) => `<option value="${esc(p.name)}"></option>`)
      .join('');
  }

  function setTab(tab) {
    ui.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    render();
    window.scrollTo(0, 0);
  }

  // ---------- list screen ----------
  const SECTION_ICONS = {
    produce: '<path d="M11 20A7 7 0 0 1 4 13c0-5 4-9 16-9 0 12-4 16-9 16Z"/><path d="M4 20c4-4 7-6 11-8"/>',
    bakery: '<path d="M5 11a4 4 0 0 1 3-6.7A4 4 0 0 1 12 3a4 4 0 0 1 4 1.3A4 4 0 0 1 19 11v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M9 11v5M15 11v5"/>',
    dairy: '<path d="M8 2h8v4l2 3v13H6V9l2-3z"/><path d="M6 13h12"/>',
    meat: '<path d="M15.5 4.5a5 5 0 0 1 0 7.1l-4 4-4.5.4.4-4.5 4-4a5 5 0 0 1 4.1-3z"/><path d="m7.4 16.6-3.2 3.2M5 21l-1.8-1.8"/>',
    pantry: '<path d="M7 3h10v3H7z"/><path d="M6 6h12v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z"/><path d="M6 11h12"/>',
    frozen: '<path d="M12 2v20M4 7l16 10M20 7 4 17"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2"/>',
    drinks: '<path d="M10 2h4v4l2 3v12a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9l2-3z"/><path d="M8 13h8"/>',
    snacks: '<circle cx="12" cy="12" r="5"/><path d="m7 12-4-3v6zM17 12l4-3v6z"/>',
    home: '<path d="M3 10 12 3l9 7v11H3z"/><path d="M9 21v-6h6v6"/>',
    care: '<path d="M12 21s-7-4.4-9.3-9A5.3 5.3 0 0 1 12 6.3 5.3 5.3 0 0 1 21.3 12C19 16.6 12 21 12 21z"/>',
    other: '<circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/>',
  };

  function sectionIcon(id) {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SECTION_ICONS[id] || SECTION_ICONS.other}</svg>`;
  }

  /** "מחלקה" picker inside an item's details on the list. */
  function sectionPicker(item) {
    const current = store.categoryOfItem(item);
    return `
      <div class="section-pick">
        <label for="sec-${item.id}">מחלקה</label>
        <select id="sec-${item.id}" class="cat-select" data-item-category="${item.id}">
          ${window.KniyotCategories.CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === current ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
      </div>`;
  }

  function setList(id) {
    ui.listId = id || null;
    ui.expanded = null;
    ui.editingList = false;
    ui.confirmDeleteList = false;
    try {
      if (ui.listId) localStorage.setItem('kniyot.currentList', ui.listId);
      else localStorage.removeItem('kniyot.currentList');
    } catch (e) {
      /* storage blocked: fine, just not remembered */
    }
    render();
  }

  /** The row of lists at the top: the main shopping list, extra lists, and "+". */
  function listsBarHtml() {
    const pill = (id, name, count) => `
      <button class="list-pill${(ui.listId || '') === (id || '') ? ' active' : ''}" data-list="${id || ''}" aria-pressed="${(ui.listId || '') === (id || '')}">
        ${esc(name)}${count ? `<span class="pill-count">${count}</span>` : ''}
      </button>`;
    const openCount = (id) => store.itemsOf(id).filter((i) => !i.checked).length;
    return `
      <nav class="lists-bar" aria-label="רשימות">
        ${pill(null, 'קניות', openCount(null))}
        ${store.extraLists().map((l) => pill(l.id, l.name, openCount(l.id))).join('')}
        <button class="list-pill new-pill" data-act="new-list" aria-label="רשימה חדשה">+ רשימה</button>
      </nav>
      ${
        ui.creatingList
          ? `<form class="new-list" id="newListForm">
               <label for="newListInput">שם הרשימה</label>
               <div class="rename-row">
                 <input id="newListInput" placeholder="למשל פארם, בית מרקחת, חומרי בניין" autocomplete="off" enterkeyhint="done">
                 <button class="btn small" type="submit">יצירה</button>
                 <button class="link" type="button" data-act="cancel-new-list">ביטול</button>
               </div>
               <p class="hint">רשימה פשוטה: מוסיפים פריטים ומסמנים. בלי מחירים ומחלקות.</p>
             </form>`
          : ''
      }`;
  }

  /** An extra list: items, check off, done section. No prices or sections. */
  function renderSimpleList(list) {
    const items = store.itemsOf(list.id);
    const open = items.filter((i) => !i.checked);
    const done = items.filter((i) => i.checked);
    const row = (item, isLast) => `
      <li class="item${item.checked ? ' done' : ''}${isLast ? ' last' : ''}" data-id="${item.id}">
        <div class="row">
          <button class="check" data-act="toggle" aria-label="${item.checked ? 'ביטול סימון' : 'סימון'} ${esc(item.name)}" aria-pressed="${item.checked}">${ICON_CHECK}</button>
          <button class="name" data-act="toggle">${esc(item.name)}</button>
          <button class="remove" data-act="remove-item" aria-label="מחיקת ${esc(item.name)}">×</button>
        </div>
      </li>`;

    const editHtml = ui.editingList
      ? `<form class="panel list-edit" id="listEditForm">
           <label for="listNameInput" class="field-label">שם הרשימה</label>
           <div class="rename-row">
             <input id="listNameInput" value="${esc(list.name)}" autocomplete="off">
             <button class="btn small" type="submit">שמירה</button>
           </div>
           <div class="actions">
             ${
               ui.confirmDeleteList
                 ? `<button class="btn danger small solid" type="button" data-act="delete-list">למחוק את "${esc(list.name)}" וכל הפריטים בה?</button>
                    <button class="link" type="button" data-act="keep-list">לא</button>`
                 : `<button class="btn danger small" type="button" data-act="ask-delete-list">מחיקת הרשימה</button>`
             }
             <button class="link" type="button" data-act="close-list-edit">סגירה</button>
           </div>
         </form>`
      : '';

    view.innerHTML = `
      ${listsBarHtml()}
      <div class="list-title">
        <h2>${esc(list.name)}</h2>
        <button class="link" data-act="edit-list" aria-expanded="${ui.editingList}">עריכת הרשימה</button>
      </div>
      ${editHtml}
      <form class="add" id="addForm">
        <label class="sr-only" for="addInput">פריט להוספה ל${esc(list.name)}</label>
        <input id="addInput" placeholder="מה להוסיף ל${esc(list.name)}?" autocomplete="off" enterkeyhint="done">
        <button class="add-btn" type="submit" aria-label="הוספה"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
      </form>
      ${open.length ? `<section class="aisle"><ul class="list">${open.map((it, i) => row(it, i === open.length - 1)).join('')}</ul></section>` : ''}
      ${!items.length ? `<div class="empty"><strong>הרשימה ריקה</strong>מוסיפים פריט בשורה למעלה.</div>` : ''}
      ${!open.length && done.length ? `<p class="all-done">הכול סומן.</p>` : ''}
      ${
        done.length
          ? `<section class="aisle cart" aria-label="סומנו">
               <h2 class="aisle-head tone-cart"><span>סומנו</span><span class="aisle-count">${done.length}</span></h2>
               <ul class="list">${done.map((it, i) => row(it, i === done.length - 1)).join('')}</ul>
             </section>
             <div class="list-actions"><button class="link" data-act="clear">ניקוי מה שסומן</button></div>`
          : ''
      }
    `;
    document.body.classList.remove('has-bar');
    document.getElementById('topMeta').textContent = open.length ? `${open.length} פריטים` : '';
  }

  function renderList() {
    const extra = ui.listId ? store.extraLists().find((l) => l.id === ui.listId) : null;
    if (ui.listId && !extra) ui.listId = null; // the list was deleted (maybe by the family)
    if (extra) {
      renderSimpleList(extra);
      return;
    }
    const list = store.itemsOf(null);
    const open = list.filter((i) => !i.checked);
    const done = list.filter((i) => i.checked);
    const suggestions = store.suggestions();
    const groups = store.listBySection();

    const itemHtml = (item, isLast) => {
      const product = store.matchProduct(item.name);
      const stats = product ? store.stats(product.id) : null;
      const isOpen = ui.expanded === item.id;
      let detail = '';
      if (isOpen) {
        if (stats) {
          const unit = stats.weighted ? ' לק״ג' : '';
          detail = `
            <div class="detail">
              <dl class="facts">
                <dt>מחיר רגיל</dt><dd>₪${money(stats.usualPrice)}${unit}</dd>
                ${stats.maxPrice - stats.minPrice > 0.01 ? `<dt>טווח</dt><dd>₪${money(stats.minPrice)} עד ₪${money(stats.maxPrice)}</dd>` : ''}
                <dt>פעם אחרונה</dt><dd>${daysHe(stats.daysSince)}, ₪${money(stats.lastPrice)}${
                  stats.lastPaidEach < stats.lastPrice - 0.01 ? ` (במבצע ₪${money(stats.lastPaidEach)})` : ''
                }</dd>
                ${stats.every ? `<dt>תדירות</dt><dd>${everyHe(stats.every)}</dd>` : ''}
              </dl>
              <form class="compare" data-compare="${product.id}">
                <label for="cmp-${item.id}">המחיר על המדף</label>
                <input id="cmp-${item.id}" inputmode="decimal" placeholder="₪" autocomplete="off">
                <span class="verdict-slot" aria-live="polite"></span>
              </form>
              ${sectionPicker(item)}
            </div>`;
        } else {
          detail = `<div class="detail"><p class="detail-note">עוד אין מחירים למוצר הזה. אחרי שתעלי קבלה שבה הוא מופיע, המחיר הרגיל יופיע כאן.</p>${sectionPicker(item)}</div>`;
        }
      }
      const price = stats
        ? `<span class="price" aria-label="בערך ${money(stats.usualPrice)} שקלים${stats.weighted ? ' לקילו' : ''}"><bdi dir="ltr"><span class="approx" aria-hidden="true">~</span>₪${money(stats.usualPrice)}</bdi>${
            stats.weighted ? '<small> לק״ג</small>' : ''
          }</span>`
        : `<span class="price none">אין מחיר</span>`;
      return `
        <li class="item${item.checked ? ' done' : ''}${isLast ? ' last' : ''}" data-id="${item.id}">
          <div class="row">
            <button class="check" data-act="toggle" aria-label="${item.checked ? 'ביטול סימון' : 'סימון'} ${esc(item.name)}" aria-pressed="${item.checked}">${ICON_CHECK}</button>
            <button class="name" data-act="expand" aria-expanded="${isOpen}">${esc(item.name)}</button>
            ${price}
          </div>
          ${detail}
        </li>`;
    };

    const sectionsHtml = groups
      .map(
        ({ category, items }) => `
        <section class="aisle" aria-label="${esc(category.name)}">
          <h2 class="aisle-head tone-${category.tone}">${sectionIcon(category.id)}<span>${esc(category.name)}</span><span class="aisle-count">${items.length}</span></h2>
          <ul class="list">${items.map((it, i) => itemHtml(it, i === items.length - 1)).join('')}</ul>
        </section>`
      )
      .join('');

    const SHOW = 3;
    const shown = ui.allSuggestions ? suggestions : suggestions.slice(0, SHOW);
    const hidden = suggestions.length - shown.length;
    const suggestHtml = suggestions.length
      ? `<div class="quick" role="group" aria-label="כנראה נגמר">
           <span class="quick-label">כנראה נגמר:</span>
           ${shown
             .map(
               ({ product, stats }) => `
             <span class="chip" title="${esc(dueHe(stats.dueIn))}">
               <button class="chip-add" data-suggest="${product.id}" aria-label="הוספת ${esc(product.name)} לרשימה, ${esc(dueHe(stats.dueIn))}">+ ${esc(product.name)}</button>
               <button class="chip-x" data-dismiss="${product.id}" aria-label="להסתיר את ${esc(product.name)} לבינתיים">×</button>
             </span>`
             )
             .join('')}
           ${hidden > 0 ? `<button class="link" data-act="more-suggestions">עוד ${hidden}</button>` : ''}
           ${ui.allSuggestions && suggestions.length > SHOW ? `<button class="link" data-act="less-suggestions">פחות</button>` : ''}
         </div>`
      : '';

    const last = store.lastTrip();
    let emptyHtml = '';
    if (!list.length) {
      const diff = last && last.actual != null ? round2(last.actual - last.estimate) : null;
      emptyHtml = `
        <div class="empty">
          <strong>הרשימה ריקה</strong>
          אפשר להוסיף מוצר בשורה למעלה. אחרי שתעלי כמה קבלות, יופיעו כאן גם הצעות למה שכנראה נגמר.
          ${
            last
              ? `<p class="last-trip">בקנייה הקודמת (${dateHe(last.date)}): משוער ₪${money(last.estimate)}${
                  last.actual != null ? `, שולם ₪${money(last.actual)} (${diff > 0 ? `₪${money(diff)} יותר` : diff < 0 ? `₪${money(-diff)} פחות` : 'בדיוק'})` : ''
                }</p>`
              : ''
          }
        </div>`;
    }

    // ---- floating total bar ----
    const est = store.estimate();
    let barHtml = '';
    if (list.length) {
      const unpriced = est.unpriced ? ` · ${est.unpriced} בלי מחיר` : '';
      barHtml = ui.finishing
        ? `<form class="cartbar finishing" id="tripForm" aria-label="סיום קנייה">
             <div class="bar-text">
               <label for="actualInput" class="bar-label">כמה שילמת בפועל? (משוער ₪${money(est.cart || est.all)})</label>
               <input id="actualInput" inputmode="decimal" placeholder="₪" autocomplete="off">
             </div>
             <div class="bar-actions">
               <button class="bar-btn" type="submit">שמירה</button>
               <button class="bar-link" type="button" data-act="cancel-finish">ביטול</button>
             </div>
           </form>`
        : `<div class="cartbar" role="region" aria-label="סיכום">
             <div class="bar-text">
               <span class="bar-label">משוער · בעגלה ${done.length}/${list.length}${unpriced}</span>
               <span class="bar-value">${est.all > 0 ? `<bdi dir="ltr"><span class="approx" aria-hidden="true">~</span>₪${money(est.all)}</bdi>` : '—'}</span>
             </div>
             <button class="bar-btn" data-act="finish" ${done.length ? '' : 'disabled'} title="${done.length ? '' : 'מסמנים מוצרים בעגלה, ואז מסיימים'}">סיום קנייה</button>
           </div>`;
    }

    const joinHtml =
      ui.pendingJoin && cloud && !cloud.hid
        ? `<section class="panel invite-panel">
             <h3>הוזמנת לרשימה משותפת</h3>
             <p>אחרי ההצטרפות תראי את אותה רשימה, קבלות ומחירים כמו כל המשפחה. מה שכבר יש לך כאן יתווסף אליה.</p>
             ${ui.joinError ? `<p class="notice">${esc(ui.joinError)}</p>` : ''}
             <div class="actions">
               <button class="btn" data-act="join-pending" ${ui.busy || cloud.status === 'connecting' ? 'disabled' : ''}>הצטרפות</button>
               <button class="link" data-act="dismiss-join">לא עכשיו</button>
             </div>
           </section>`
        : '';

    view.innerHTML = `
      ${joinHtml}
      ${listsBarHtml()}
      <form class="add" id="addForm">
        <label class="sr-only" for="addInput">מוצר להוספה</label>
        <input id="addInput" list="productNames" placeholder="מה צריך לקנות?" autocomplete="off" enterkeyhint="done">
        <button class="add-btn" type="submit" aria-label="הוספה"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>
      </form>
      ${suggestHtml}
      ${sectionsHtml}
      ${!open.length && done.length ? `<p class="all-done">הכול בעגלה. אפשר לסיים את הקנייה.</p>` : ''}
      ${
        done.length
          ? `<section class="aisle cart" aria-label="בעגלה">
               <h2 class="aisle-head tone-cart"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.6 12.4a2 2 0 0 0 2 1.6h8.2a2 2 0 0 0 2-1.6L21 7H6"/></svg><span>בעגלה</span><span class="aisle-count">${done.length} · <bdi dir="ltr"><span class="approx" aria-hidden="true">~</span>₪${money(est.cart)}</bdi></span></h2>
               <ul class="list">${done.map((it, i) => itemHtml(it, i === done.length - 1)).join('')}</ul>
             </section>
             <div class="list-actions"><button class="link" data-act="clear">ניקוי העגלה בלי לשמור קנייה</button></div>`
          : ''
      }
      ${emptyHtml}
      ${barHtml}
    `;
    document.body.classList.toggle('has-bar', !!barHtml);
    const sections = groups.length;
    document.getElementById('topMeta').textContent = open.length
      ? `${open.length} פריטים · ${sections === 1 ? 'מחלקה אחת' : `${sections} מחלקות`}`
      : '';
  }

  // ---------- receipts screen ----------
  function renderReceipts() {
    let pendingHtml = '';
    if (ui.pending) {
      const { parsed, duplicate, text } = ui.pending;
      // The date field below handles a missing date, so don't repeat it as a warning.
      const warnings = parsed.warnings
        .filter((w) => !/תאריך/.test(w))
        .map((w) => `<p class="notice">${esc(w)}</p>`)
        .join('');
      if (!parsed.items.length) {
        pendingHtml = `
          <section class="panel">
            <h3>לא הצלחתי לקרוא את הקבלה</h3>
            <p>הטקסט שחולץ מהקובץ מופיע למטה. אם זו קבלה מרשת אחרת, אפשר להעתיק אותו ולשלוח כדי להוסיף לה תמיכה.</p>
            <details><summary>הטקסט שחולץ</summary><pre class="debug" id="extractedText">${esc(text)}</pre></details>
            <div class="actions">
              <button class="btn small" data-act="copy-extracted">העתקת הטקסט</button>
              <button class="btn secondary small" data-act="cancel">סגירה</button>
            </div>
          </section>`;
      } else {
        pendingHtml = `
          <section class="panel">
            <h3>${esc(parsed.chain.name)}${parsed.date ? `, ${dateHe(parsed.date)}` : ''}</h3>
            <p>${parsed.items.length} שורות, סה״כ ₪${money(parsed.total)}</p>
            ${duplicate ? '<p class="notice">הקבלה הזו כבר שמורה.</p>' : warnings || '<p class="notice ok">כל השורות זוהו והסכום תואם לקבלה.</p>'}
            ${
              duplicate
                ? ''
                : `<div class="receipt-date${parsed.date ? '' : ' missing'}">
                     <label for="receiptDate">${parsed.date ? 'תאריך הקנייה' : 'לא מצאתי תאריך בקבלה. מתי הייתה הקנייה?'}</label>
                     <div class="rename-row">
                       <input type="date" id="receiptDate" value="${esc(parsed.date || '')}" max="${window.KniyotStore.todayISO()}">
                       ${parsed.date ? '' : '<button class="btn secondary small" type="button" data-act="date-today">היום</button>'}
                     </div>
                   </div>`
            }
            <div class="actions">
              ${duplicate ? '' : `<button class="btn" data-act="save-receipt" ${parsed.date ? '' : 'disabled'}>שמירת הקבלה</button>`}
              <button class="btn secondary" data-act="cancel">ביטול</button>
            </div>
          </section>`;
      }
    }

    let mapHtml = '';
    if (ui.unknown && ui.unknown.length) {
      mapHtml = `
        <form class="panel" id="mapForm">
          <h3>${ui.unknown.length} מוצרים חדשים</h3>
          <p>איך לקרוא לכל אחד ברשימה? שם קצר כמו "חלב" עדיף. אם כותבים שם של מוצר שכבר קיים, הם יחוברו.</p>
          ${ui.unknown
            .map(
              (u, i) => `
            <div class="map-row">
              <label for="map-${i}">${esc(u.rawName)}, ₪${money(u.unitPrice)}${u.weighted ? ' לק״ג' : ''}</label>
              <input id="map-${i}" data-key="${esc(u.key)}" list="productNames" value="${esc(suggestName(u.rawName))}" autocomplete="off">
            </div>`
            )
            .join('')}
          <div class="actions"><button class="btn" type="submit">שמירת השמות</button></div>
        </form>`;
    }

    const receipts = store.receiptsSorted();
    const pastHtml = receipts.length
      ? `<h2>קבלות שמורות (${receipts.length})</h2>
         <ul class="rows">
           ${receipts
             .map(
               (r) => `
             <li>
               <span class="grow">${esc(r.chainName)}<span class="sub">${dateHe(r.date)}, ${r.itemCount} שורות</span></span>
               <span class="price">₪${money(r.total)}</span>
               ${
                 ui.confirmDelete === r.id
                   ? `<button class="btn danger small solid" data-delete-receipt="${r.id}">למחוק?</button>
                      <button class="link" data-act="keep-receipt">לא</button>`
                   : `<button class="btn danger small" data-ask-delete="${r.id}" aria-label="מחיקת הקבלה מ־${dateHe(r.date)}">מחיקה</button>`
               }
             </li>`
             )
             .join('')}
         </ul>`
      : '';

    view.innerHTML = `
      ${ui.unknown && ui.unknown.length ? '' : `
      ${
        ui.ocr
          ? `<section class="panel ocr" aria-live="polite">
               <h3>קורא את הקבלה</h3>
               <p id="ocrLabel">${esc(ui.ocr.label)}</p>
               <div class="ocr-track"><div class="ocr-bar" id="ocrBar" style="width: ${Math.round(ui.ocr.progress * 100)}%"></div></div>
               <p class="hint">קבלה שהיא תמונה (כמו של שופרסל) נקראת בזיהוי טקסט בטלפון עצמו. זה לוקח כחצי דקה, ובפעם הראשונה קצת יותר.</p>
             </section>`
          : `<label class="upload">
               <input type="file" id="pdfInput" accept="application/pdf,.pdf,image/*">
               <strong>העלאת קבלה</strong>
               <span>PDF מהקישור ב־SMS, או צילום מסך של הקבלה. עובד עם יוחננוף ושופרסל.</span>
             </label>`
      }
      <details class="paste">
        <summary>או הדבקת הטקסט של הקבלה</summary>
        <textarea id="pasteInput" placeholder="מדביקים כאן את כל הטקסט שבדף הקבלה"></textarea>
        <button class="btn small" data-act="parse-paste">קריאת הקבלה</button>
      </details>`}
      ${pendingHtml}
      ${mapHtml}
      ${pastHtml}
    `;
    document.getElementById('topMeta').textContent = receipts.length ? `${receipts.length} קבלות` : '';
  }

  /**
   * Parse one text, or several readings of the same PDF, and keep the one
   * that finds the most lines (ties: the one whose sum matches the total).
   */
  function handleParsed(textOrTexts) {
    const texts = Array.isArray(textOrTexts) ? textOrTexts : [textOrTexts];
    let best = null;
    for (const text of texts) {
      const parsed = window.ReceiptParser.parse(text);
      const score = parsed.items.length * 10 - parsed.warnings.length;
      if (!best || score > best.score) best = { parsed, text, score };
    }
    showParsed(best.parsed, best.text);
  }

  function showParsed(parsed, text) {
    ui.pending = { parsed, duplicate: parsed.items.length ? store.isDuplicate(parsed) : false, text };
    render();
  }

  /** Picture receipts (Shufersal's PDF, screenshots): OCR in the browser, with progress. */
  async function readPicture(file) {
    ui.ocr = { progress: 0, label: 'מכין את התמונה' };
    ui.pending = null;
    render();
    const result = await window.ReceiptOcr.readPictureReceipt(file, (progress, label) => {
      ui.ocr = { progress, label };
      const bar = document.getElementById('ocrBar');
      const text = document.getElementById('ocrLabel');
      if (bar) bar.style.width = `${Math.round(progress * 100)}%`;
      if (text) text.textContent = label;
    });
    ui.ocr = null;
    const rows = window.Shufersal.buildRows(result);
    let parsed = window.Shufersal.parseRows(rows, result.text);
    // Not a Shufersal layout? Try the general text parser on what was read.
    if (!parsed.items.length) {
      const general = window.ReceiptParser.parse(result.text);
      if (general.items.length) parsed = general;
    }
    const debug = rows.map((r) => [r.code, r.desc, r.amount].filter(Boolean).join(' | ')).join('\n');
    showParsed(parsed, debug || result.text);
  }

  // ---------- products screen ----------
  function renderProducts() {
    const q = ui.productQuery.trim().toLowerCase();
    const products = store
      .productList()
      .filter((p) => !q || p.name.toLowerCase().includes(q) || store.rawNamesOf(p.id).some((n) => n.toLowerCase().includes(q)));

    const rows = products
      .map((p) => {
        const s = store.stats(p.id);
        const sub = s
          ? [s.every ? everyHe(s.every) : `נקנה ${s.timesBought === 1 ? 'פעם אחת' : `${s.timesBought} פעמים`}`, `לאחרונה ${daysHe(s.daysSince)}`].join(', ')
          : 'אין קניות שמורות';
        const editing = ui.editing === p.id;
        return `
          <li class="${editing ? 'editing' : ''}">
            <div class="li-row">
              <button class="grow" data-rename="${p.id}" aria-expanded="${editing}" aria-label="שינוי השם של ${esc(p.name)}">${esc(p.name)}<span class="sub">${sub}</span></button>
              ${priceTag(s)}
            </div>
            ${
              editing
                ? `<form class="rename" data-rename-form="${p.id}">
                     <label for="rn-${p.id}">שם ברשימה</label>
                     <div class="rename-row">
                       <input id="rn-${p.id}" list="productNames" value="${esc(p.name)}" autocomplete="off">
                       <button class="btn small" type="submit">שמירה</button>
                     </div>
                     <span class="sub">בקבלות: ${store.rawNamesOf(p.id).map(esc).join(', ') || 'אין'}</span>
                     <label for="cat-${p.id}">מחלקה</label>
                     <select id="cat-${p.id}" class="cat-select" data-category-for="${p.id}">
                       ${window.KniyotCategories.CATEGORIES.map(
                         (c) => `<option value="${c.id}" ${c.id === store.categoryOfProduct(p) ? 'selected' : ''}>${esc(c.name)}</option>`
                       ).join('')}
                     </select>
                   </form>`
                : ''
            }
          </li>`;
      })
      .join('');

    view.innerHTML = `
      ${store.productList().length ? `
        <label class="sr-only" for="productSearch">חיפוש מוצר</label>
        <input class="search" id="productSearch" type="search" placeholder="חיפוש מוצר" value="${esc(ui.productQuery)}">
        <ul class="rows">${rows || '<li class="empty">לא נמצא מוצר בשם הזה.</li>'}</ul>
        <p class="hint">לחיצה על מוצר משנה את השם שלו. שינוי לשם של מוצר קיים מחבר ביניהם.</p>`
        : `<div class="empty"><strong>עוד אין מוצרים</strong>המוצרים נוצרים מהקבלות. אפשר להתחיל במסך הקבלות.</div>`}
    `;
    document.getElementById('topMeta').textContent = store.productList().length ? `${store.productList().length} מוצרים` : '';
  }

  // ---------- family screen ----------
  function joinFormHtml(prefill) {
    return `
      <form class="join" id="joinForm">
        <label for="joinInput">יש לך קישור הזמנה או קוד?</label>
        <div class="rename-row">
          <input id="joinInput" value="${esc(prefill || '')}" placeholder="מדביקים כאן את הקישור" autocomplete="off" dir="ltr">
          <button class="btn small" type="submit" ${ui.busy ? 'disabled' : ''}>הצטרפות</button>
        </div>
        ${ui.joinError ? `<p class="notice">${esc(ui.joinError)}</p>` : ''}
      </form>`;
  }

  function familyHtml() {
    if (!cloud) {
      return `<p class="hint">השיתוף עם המשפחה עובד באתר עצמו, אחרי שהוא עולה ל־GitHub. בתצוגה המקדימה הנתונים נשמרים רק בדפדפן הזה.</p>`;
    }
    const s = cloud.status;
    if (s === 'off' || s === 'connecting') return `<p class="hint">מתחבר…</p>`;
    if (s === 'unavailable') {
      return `<p class="notice">השיתוף לא זמין כרגע. ${esc(cloudErrorText(cloud.error))}</p>
              <p class="hint">בינתיים הכול נשמר בטלפון הזה.</p>`;
    }
    if (cloud.hid) {
      const link = cloud.inviteLink();
      const others = Math.max(0, cloud.members - 1);
      return `
        <div class="panel family">
          <h3>הרשימה משותפת</h3>
          <p>${others ? `עוד ${others === 1 ? 'מכשיר אחד מחובר' : `${others} מכשירים מחוברים`} לרשימה.` : 'עוד אף אחד לא הצטרף. שלחי את הקישור לבני המשפחה.'}</p>
          ${s === 'error' ? `<p class="notice">${esc(cloudErrorText(cloud.error))}</p>` : '<p class="notice ok">מסונכרן. כל שינוי מופיע אצל כולם.</p>'}
          <label class="field-label" for="inviteLink">קישור הזמנה</label>
          <input id="inviteLink" class="invite" value="${esc(link)}" readonly dir="ltr">
          <div class="actions">
            <button class="btn small" data-act="copy-invite">העתקת הקישור</button>
            ${navigator.share ? '<button class="btn secondary small" data-act="share-invite">שליחה</button>' : ''}
          </div>
          <p class="hint">שמרי את הקישור. הוא גם הדרך לחזור לרשימה אם מחליפים טלפון.</p>
        </div>
        <div class="actions">
          ${
            ui.confirmLeave
              ? `<button class="btn danger small solid" data-act="leave">להפסיק לשתף בטלפון הזה?</button>
                 <button class="link" data-act="keep-sharing">לא</button>`
              : `<button class="link" data-act="ask-leave">הפסקת שיתוף בטלפון הזה</button>`
          }
        </div>`;
    }
    return `
      <div class="panel family">
        <h3>רשימה אחת לכל המשפחה</h3>
        <p>כולם רואים את אותה רשימה, אותן קבלות ואותם מחירים. מי שמסמן משהו בסופר, זה מסומן אצל כולם. לא צריך חשבון או סיסמה.</p>
        ${s === 'error' ? `<p class="notice">${esc(cloudErrorText(cloud.error))}</p>` : ''}
        <div class="actions">
          <button class="btn" data-act="create-household" ${ui.busy ? 'disabled' : ''}>יצירת רשימה משותפת</button>
        </div>
      </div>
      ${joinFormHtml(ui.pendingJoin)}`;
  }

  function renderFamily() {
    view.innerHTML = `
      ${familyHtml()}
      <h2>גיבוי</h2>
      <p class="hint">${cloud && cloud.hid ? 'הנתונים שמורים בענן. אפשר גם להוריד עותק לגיבוי נוסף.' : 'הנתונים שמורים רק בטלפון הזה. כדאי לשמור גיבוי מדי פעם.'}</p>
      <div class="actions">
        <button class="btn secondary small" data-act="export">הורדת גיבוי</button>
        <label class="btn secondary small" style="cursor:pointer">שחזור מגיבוי<input type="file" id="importInput" accept="application/json,.json" class="sr-only"></label>
      </div>
    `;
    document.getElementById('topMeta').textContent = cloud && cloud.hid ? 'משותף' : '';
  }

  // ---------- render ----------
  function render() {
    // Keep what the user is typing when a change from the family re-renders the screen.
    // Text fields only: a file picker's value can't be set from code.
    const active = document.activeElement;
    const isTextField =
      active &&
      active.id &&
      view.contains(active) &&
      (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && /^(text|search|url|tel|email|number|)$/.test(active.type || '')));
    const keep = isTextField ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;

    refreshDatalist();
    if (ui.tab === 'list') renderList();
    else if (ui.tab === 'receipts') renderReceipts();
    else if (ui.tab === 'products') renderProducts();
    else renderFamily();

    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) {
        try {
          el.value = keep.value;
          el.focus();
          el.setSelectionRange(keep.start, keep.end);
        } catch (e) {
          /* some input types have no selection */
        }
      }
    }
  }

  // ---------- events ----------
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  view.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;

    if (form.id === 'addForm') {
      const input = form.querySelector('input');
      const typed = input.value.trim();
      const item = store.addToList(typed, ui.listId);
      if (item) {
        // Phone keyboards can re-type a word that was still being composed after we
        // clear the box, so end the composition first (blur), then clear, and check again.
        input.blur();
        input.value = '';
        render();
        const fresh = document.getElementById('addInput');
        fresh.value = '';
        fresh.focus();
        setTimeout(() => {
          const el = document.getElementById('addInput');
          if (el && el.value.trim() === typed) el.value = '';
        }, 80);
      }
      return;
    }

    if (form.dataset.compare) {
      const input = form.querySelector('input');
      const shelf = parseFloat(input.value.replace(',', '.').replace('₪', ''));
      const s = store.stats(form.dataset.compare);
      const slot = form.querySelector('.verdict-slot');
      if (!s || isNaN(shelf)) return;
      const diff = (shelf - s.usualPrice) / s.usualPrice;
      let cls = 'normal', txt = 'מחיר רגיל';
      if (diff <= -0.05) { cls = 'cheap'; txt = `זול ב־${Math.round(-diff * 100)}% מהרגיל`; }
      else if (diff >= 0.05) { cls = 'pricey'; txt = `יקר ב־${Math.round(diff * 100)}% מהרגיל`; }
      slot.innerHTML = `<span class="verdict ${cls}">${txt}</span>`;
      return;
    }

    if (form.id === 'newListForm') {
      const list = store.addList(form.querySelector('input').value);
      if (list) {
        ui.creatingList = false;
        toast(`נוצרה הרשימה "${list.name}"`);
        setList(list.id);
        const input = document.getElementById('addInput');
        if (input) input.focus();
      }
      return;
    }

    if (form.id === 'listEditForm' && ui.listId) {
      store.renameList(ui.listId, form.querySelector('input').value);
      ui.editingList = false;
      render();
      return;
    }

    if (form.id === 'tripForm') {
      const raw = form.querySelector('input').value.replace(',', '.').replace('₪', '').trim();
      const actual = raw ? parseFloat(raw) : null;
      if (raw && isNaN(actual)) {
        toast('הסכום צריך להיות מספר, למשל 142.50');
        return;
      }
      const trip = store.finishTrip(actual);
      ui.finishing = false;
      if (trip.actual != null && trip.estimate) {
        const diff = round2(trip.actual - trip.estimate);
        toast(
          diff > 0.5
            ? `הקנייה נשמרה. יצא ₪${money(diff)} יותר מהמשוער`
            : diff < -0.5
            ? `הקנייה נשמרה. יצא ₪${money(-diff)} פחות מהמשוער`
            : 'הקנייה נשמרה. יצא בדיוק כמו המשוער'
        );
      } else {
        toast('הקנייה נשמרה');
      }
      render();
      return;
    }

    if (form.id === 'joinForm') {
      joinWith(form.querySelector('input').value);
      return;
    }

    if (form.dataset.renameForm) {
      const p = store.state.products[form.dataset.renameForm];
      const name = form.querySelector('input').value.trim();
      ui.editing = null;
      if (p && name && name !== p.name) {
        const merging = store.findProductByName(name);
        store.renameProduct(p.id, name);
        toast(merging ? `חובר אל ${merging.name}` : 'השם עודכן');
      }
      render();
      return;
    }

    if (form.id === 'mapForm') {
      form.querySelectorAll('input[data-key]').forEach((input) => {
        const name = input.value.trim() || input.closest('.map-row').querySelector('label').textContent.split(',')[0];
        store.assignCode(input.dataset.key, name);
      });
      store.save();
      const n = ui.unknown.length;
      ui.unknown = null;
      toast(`נשמרו ${n} מוצרים`);
      render();
    }
  });

  view.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-act]');
    if (!t) return;
    const li = t.closest('.item');

    if (t.dataset.act === 'toggle' && li) {
      store.toggleItem(li.dataset.id);
      render();
    } else if (t.dataset.act === 'expand' && li) {
      ui.expanded = ui.expanded === li.dataset.id ? null : li.dataset.id;
      render();
    } else if (t.dataset.act === 'create-household' && cloud) {
      ui.busy = true;
      render();
      cloud
        .createHousehold()
        .then(() => toast('הרשימה המשותפת מוכנה'))
        .catch((err) => {
          console.error(err);
          toast(cloudErrorText(err));
        })
        .finally(() => {
          ui.busy = false;
          render();
        });
    } else if (t.dataset.act === 'copy-extracted' && ui.pending) {
      (navigator.clipboard ? navigator.clipboard.writeText(ui.pending.text) : Promise.reject())
        .then(() => toast('הטקסט הועתק'))
        .catch(() => {
          const pre = document.getElementById('extractedText');
          if (pre) {
            pre.closest('details').open = true;
            window.getSelection().selectAllChildren(pre);
          }
          toast('הטקסט מסומן. אפשר להעתיק אותו');
        });
    } else if (t.dataset.act === 'join-pending') {
      joinWith(ui.pendingJoin);
    } else if (t.dataset.act === 'dismiss-join') {
      clearJoinParam();
      render();
    } else if (t.dataset.act === 'copy-invite' && cloud) {
      const link = cloud.inviteLink();
      const input = document.getElementById('inviteLink');
      (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
        .then(() => toast('הקישור הועתק'))
        .catch(() => {
          input.select();
          toast('הקישור מסומן. אפשר להעתיק אותו');
        });
    } else if (t.dataset.act === 'share-invite' && cloud) {
      navigator.share({ title: 'רשימת הקניות שלנו', text: 'הצטרפות לרשימת הקניות המשותפת:', url: cloud.inviteLink() }).catch(() => {});
    } else if (t.dataset.act === 'ask-leave') {
      ui.confirmLeave = true;
      render();
    } else if (t.dataset.act === 'keep-sharing') {
      ui.confirmLeave = false;
      render();
    } else if (t.dataset.act === 'leave' && cloud) {
      ui.confirmLeave = false;
      cloud.leave();
      toast('השיתוף הופסק בטלפון הזה');
      render();
    } else if (t.dataset.act === 'finish') {
      ui.finishing = true;
      render();
      const input = document.getElementById('actualInput');
      if (input) input.focus();
    } else if (t.dataset.act === 'cancel-finish') {
      ui.finishing = false;
      render();
    } else if (t.dataset.act === 'more-suggestions' || t.dataset.act === 'less-suggestions') {
      ui.allSuggestions = t.dataset.act === 'more-suggestions';
      render();
    } else if (t.dataset.act === 'clear') {
      store.clearChecked(ui.listId);
      render();
    } else if (t.dataset.list !== undefined && t.classList.contains('list-pill')) {
      ui.creatingList = false;
      setList(t.dataset.list);
    } else if (t.dataset.act === 'new-list') {
      ui.creatingList = !ui.creatingList;
      render();
      const input = document.getElementById('newListInput');
      if (input) input.focus();
    } else if (t.dataset.act === 'cancel-new-list') {
      ui.creatingList = false;
      render();
    } else if (t.dataset.act === 'edit-list') {
      ui.editingList = !ui.editingList;
      ui.confirmDeleteList = false;
      render();
    } else if (t.dataset.act === 'close-list-edit') {
      ui.editingList = false;
      ui.confirmDeleteList = false;
      render();
    } else if (t.dataset.act === 'ask-delete-list') {
      ui.confirmDeleteList = true;
      render();
    } else if (t.dataset.act === 'keep-list') {
      ui.confirmDeleteList = false;
      render();
    } else if (t.dataset.act === 'delete-list' && ui.listId) {
      const list = store.extraLists().find((l) => l.id === ui.listId);
      store.deleteList(ui.listId);
      toast(`הרשימה "${list ? list.name : ''}" נמחקה`);
      setList(null);
    } else if (t.dataset.act === 'remove-item' && li) {
      store.removeItem(li.dataset.id);
      render();
    } else if (t.dataset.suggest) {
      const p = store.state.products[t.dataset.suggest];
      store.addToList(p.name);
      toast(`${p.name} נוסף לרשימה`);
      render();
    } else if (t.dataset.dismiss) {
      store.dismissSuggestion(t.dataset.dismiss);
      render();
    } else if (t.dataset.act === 'parse-paste') {
      const text = document.getElementById('pasteInput').value;
      if (text.trim()) handleParsed(text);
    } else if (t.dataset.act === 'date-today' && ui.pending) {
      setReceiptDate(window.KniyotStore.todayISO());
    } else if (t.dataset.act === 'save-receipt' && ui.pending) {
      if (!ui.pending.parsed.date) {
        toast('צריך לבחור את תאריך הקנייה');
        return;
      }
      const { unknown } = store.importReceipt(ui.pending.parsed);
      ui.pending = null;
      ui.unknown = unknown;
      toast('הקבלה נשמרה');
      render();
    } else if (t.dataset.act === 'cancel') {
      ui.pending = null;
      render();
    } else if (t.dataset.askDelete) {
      ui.confirmDelete = t.dataset.askDelete;
      render();
    } else if (t.dataset.act === 'keep-receipt') {
      ui.confirmDelete = null;
      render();
    } else if (t.dataset.deleteReceipt) {
      store.deleteReceipt(t.dataset.deleteReceipt);
      ui.confirmDelete = null;
      toast('הקבלה נמחקה');
      render();
    } else if (t.dataset.rename) {
      ui.editing = ui.editing === t.dataset.rename ? null : t.dataset.rename;
      render();
      const input = document.getElementById(`rn-${ui.editing}`);
      if (input) input.focus();
    } else if (t.dataset.act === 'export') {
      const blob = new Blob([store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `kniyot-backup-${window.KniyotStore.todayISO()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  });

  /** The user picked or fixed the receipt's date. */
  function setReceiptDate(iso) {
    if (!ui.pending || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
    ui.pending.parsed.date = iso;
    ui.pending.parsed.warnings = ui.pending.parsed.warnings.filter((w) => !/תאריך/.test(w));
    ui.pending.duplicate = store.isDuplicate(ui.pending.parsed);
    render();
  }

  view.addEventListener('change', async (e) => {
    if (e.target.id === 'receiptDate') {
      setReceiptDate(e.target.value);
      return;
    }
    if (e.target.dataset && e.target.dataset.itemCategory) {
      const item = store.state.list.find((i) => i.id === e.target.dataset.itemCategory);
      if (item) {
        // No product yet (e.g. "מלח"): create one by this name, so the choice is
        // remembered next time and shared with the family.
        const product = store.matchProduct(item.name) || store.getOrCreateProduct(item.name);
        store.setCategory(product.id, e.target.value);
        toast(`"${item.name}" עבר למחלקה: ${window.KniyotCategories.BY_ID[e.target.value].name}`);
        render();
      }
      return;
    }
    if (e.target.dataset && e.target.dataset.categoryFor) {
      store.setCategory(e.target.dataset.categoryFor, e.target.value);
      toast(`הועבר למחלקה: ${window.KniyotCategories.BY_ID[e.target.value].name}`);
      return;
    }
    if (e.target.id === 'pdfInput' && e.target.files[0]) {
      const file = e.target.files[0];
      e.target.value = ''; // so choosing the same file again still triggers
      const isImage = /^image\//.test(file.type);
      try {
        let readings = [];
        if (!isImage) {
          toast('קורא את הקבלה…');
          readings = await window.PdfText.pdfToTexts(file);
        }
        // A PDF with no text inside (like Shufersal's) or a screenshot: read the picture.
        const hasText = readings.some((r) => r.text.replace(/\s/g, '').length > 40);
        if (isImage || !hasText) await readPicture(file);
        else handleParsed(readings.map((r) => r.text));
      } catch (err) {
        console.error(err);
        ui.ocr = null;
        render();
        toast(err.message || 'לא הצלחתי לפתוח את הקובץ');
      }
    } else if (e.target.id === 'importInput' && e.target.files[0]) {
      try {
        store.importJSON(await e.target.files[0].text());
        toast('הגיבוי שוחזר');
        render();
      } catch (err) {
        toast(err.message);
      }
    }
  });

  view.addEventListener('input', (e) => {
    if (e.target.form && e.target.form.dataset.compare) {
      e.target.form.requestSubmit();
    } else if (e.target.id === 'productSearch') {
      ui.productQuery = e.target.value;
      const pos = e.target.selectionStart;
      renderProducts();
      const input = document.getElementById('productSearch');
      input.focus();
      input.setSelectionRange(pos, pos);
    }
  });

  function joinWith(code) {
    if (!cloud || ui.busy) return;
    ui.busy = true;
    ui.joinError = '';
    render();
    cloud
      .joinHousehold(code)
      .then(() => {
        clearJoinParam();
        toast('הצטרפת לרשימה המשותפת');
        setTab('list');
      })
      .catch((err) => {
        console.error(err);
        ui.joinError = err.code ? cloudErrorText(err) : err.message;
      })
      .finally(() => {
        ui.busy = false;
        render();
      });
  }

  // Ask the browser not to clear this site's data when space runs low.
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    /* not supported */
  }

  render();
  if (cloud) cloud.start();
})();
