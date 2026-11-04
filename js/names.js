/*
 * Product names on receipts, without AI:
 *
 * 1. Products you already named: the barcode is known, use that name.
 * 2. Known barcodes: data/barcodes.json (built weekly by a GitHub Action from
 *    the supermarkets' public price files) gives the real name.
 * 3. Everything else (produce, in-store codes): fix OCR mistakes word by word
 *    against a Hebrew grocery vocabulary, allowing for the letters OCR confuses
 *    on printed receipts (ה/ח, ם/ס, נ/ג, ר/ד, ו/ז/ן…).
 */
(function (root) {
  'use strict';

  // Base vocabulary: common words in Israeli supermarket product names.
  // data/words.json (from the price files) adds tens of thousands more.
  const BASE_WORDS = `
חלב גבינה גבינת גבינות צהובה לבנה מלוחה בולגרית פטה צפתית מוצרלה פרמזן פקורינו ריקוטה קוטג שמנת מתוקה חמוצה
לבישול להקצפה חמאה מרגרינה יוגורט יווני מעדן מעדני פודינג שוקו משקה ביצים ביצה גדולות בינוניות לחם לחמניות
לחמנייה פיתות פיתה חלה חלות טורטייה טורטיה אחיד מלא מלאה כוסמין שיפון דגנים קמח סוכר מלח פלפל שחור לבן אורז פרסי
בסמטי יסמין פסטה ספגטי פנה פתיתים קוסקוס בורגול עדשים שעועית חומוס טחינה גולמית גרעינים גרעיני דלעת חמניות שקדים
אגוזי אגוזים מלך קשיו בוטנים פיסטוק צימוקים תמרים שמן זית קנולה חמניות חומץ רסק עגבניות עגבנייה עגבניה רוטב קטשופ
מיונז חרדל דבש ריבה ממרח שוקולד קקאו קפה נמס טורקי תה מים מינרלים סודה מיץ תפוזים ענבים לימון לימונדה קולה בירה יין
מלפפון מלפפונים חסה לבבות כרוב כרובית ברוקולי גזר בצל שום תפוח תפוחי אדמה בטטה קישוא קישואים חציל חצילים גמבה תירס
אפונה פטריות פטרוזיליה כוסברה שמיר נענע בזיליקום סלרי סלק צנון כרישה לוף בננה בננות תפוחים אגס אגסים אבטיח מלון
תפוז קלמנטינה קלמנטינות אבוקדו מנגו אננס קיווי תות תותים שזיף שזיפים אפרסק נקטרינה רימון תאנים שרי חריף מתוק אדום
ירוק צהוב עוף חזה שניצל כרעיים שוקיים כנפיים פרגית טחון בשר בקר הודו נקניק נקניקיות סלמון טונה דג דגים פילה
נייר טואלט מגבות סופג אפייה אלומיניום ניילון שקיות אשפה סבון כלים נוזל אבקה כביסה מרכך אקונומיקה מסיר שומנים
אבנית ספוג ספוגים מטהר אוויר חיתולים מגבונים שמפו משחת שיניים מברשת דאודורנט במבה ביסלי חטיף חטיפי עוגיות עוגה
וופל וופלים קרקרים פריכיות בייגלה ארוז ארוזה ארוזים טרי טרייה טריה מובחר מובחרת יבש יבשה קפוא קפואה קפואים אורגני
אורגנית דל שומן מופחת מופחתת טבעי טבעית קלוי קלויים מלוח מעושן פרוס פרוסה פרוסות שלם שלמה טחונה מארז אריזה יחידות
קרטון בקבוק פחית שקית במשקל חצי קשה רכה מגורדת שמנת חמוצה גבינת שמנת קרם פרש עמק תנובה שטראוס טרה יטבתה עלית
אסם תלמה סוגת וילי פוד פרי זוגות וואקום קלופים קלופות טהור סירופ מייפל כמון כורכום פפריקה זעתר סומק אורגנו קינמון
שמרים אינסטנט וניל פירורי לחם קורנפלקס דגני בוקר גרנולה שיבולת שועל דקה גסה מוזלי חלבה טחינה גלידה ארטיק
`.trim().split(/\s+/);

  // Letters OCR mixes up on receipt print (both directions).
  const CONFUSED = [
    'הח', 'חת', 'הת', 'םס', 'םט', 'סט', 'נג', 'נכ', 'גכ', 'בכ', 'בפ', 'רד', 'רך', 'דך', 'וז', 'וי', 'וך', 'ון', 'זן',
    'ין', 'יו', 'עצ', 'קף', 'צץ', 'מם', 'נן', 'כך', 'פף', 'טמ', 'אה', 'בנ', 'כנ', 'שמ', 'תמ', 'לד',
  ];
  const CONF = new Set();
  for (const pair of CONFUSED) {
    CONF.add(pair[0] + pair[1]);
    CONF.add(pair[1] + pair[0]);
  }

  const HEB = /[א-ת]/;
  // In a Hebrew word, symbols and digits are letters OCR couldn't read: mark them "?".
  const cleanToken = (t) => {
    const s = String(t);
    if (!HEB.test(s)) return s.replace(/[^0-9%.]/g, '');
    return s
      .replace(/^[^א-ת0-9]+|[^א-ת0-9%]+$/g, '') // punctuation at the edges isn't a letter
      .replace(/[^א-ת]/g, '?')
      .replace(/\?{2,}/g, '?');
  };

  /** Edit distance where confusable letters cost 0.35 instead of 1. */
  function distance(a, b, limit) {
    const n = a.length, m = b.length;
    if (Math.abs(n - m) > limit) return Infinity;
    let prev = new Float32Array(m + 1);
    let cur = new Float32Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      cur[0] = i;
      let rowMin = cur[0];
      for (let j = 1; j <= m; j++) {
        const ca = a[i - 1], cb = b[j - 1];
        const sub = ca === cb ? 0 : ca === '?' ? 0.3 : CONF.has(ca + cb) ? 0.35 : 1;
        cur[j] = Math.min(prev[j - 1] + sub, prev[j] + (ca === '?' ? 0.5 : 1), cur[j - 1] + 1);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > limit) return Infinity;
      [prev, cur] = [cur, prev];
    }
    return prev[m];
  }

  class Vocabulary {
    constructor(words = []) {
      this.byLength = new Map();
      this.known = new Set();
      this.add(BASE_WORDS);
      this.add(words);
    }

    add(words) {
      for (const raw of words) {
        const w = cleanToken(raw);
        if (w.length < 2 || !HEB.test(w) || w.includes('?') || this.known.has(w)) continue;
        this.known.add(w);
        if (!this.byLength.has(w.length)) this.byLength.set(w.length, []);
        this.byLength.get(w.length).push(w); // earlier = more common
      }
    }

    /** The closest real word and its distance per letter, or null. */
    nearest(t, maxPerLetter = 0.34) {
      if (this.known.has(t)) return { word: t, score: 0 };
      const limit = Math.max(0.7, t.length * maxPerLetter);
      let best = null;
      let bestD = Infinity;
      for (let len = Math.max(2, t.length - 2); len <= t.length + 2; len++) {
        for (const w of this.byLength.get(len) || []) {
          const d = distance(t, w, Math.min(limit, bestD));
          if (d < bestD) {
            bestD = d;
            best = w;
            if (d === 0) return w;
          }
        }
      }
      return best && bestD <= limit ? { word: best, score: bestD / Math.max(t.length, best.length) } : null;
    }

    /** The closest real word, or the token as it was if nothing is close enough. */
    fix(token) {
      const t = cleanToken(token);
      if (t.length < 2 || !HEB.test(t) || this.known.has(t)) return t.replace(/\?/g, '') || token;
      const hit = this.nearest(t);
      return hit ? hit.word : t.replace(/\?/g, '');
    }

    /** Fix every word of an OCR'd name; drop leftover junk (single letters, symbols). */
    fixName(name) {
      const tokens = String(name || '')
        .split(/\s+/)
        .map(cleanToken)
        .filter((t) => t && (HEB.test(t) || /^\d+(\.\d+)?%?$/.test(t)));
      const out = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (!HEB.test(t)) {
          out.push(t); // sizes and percentages: "36%", "500"
          continue;
        }
        // a word OCR split in two ("גנ ינת" = "גבינת"): try it joined
        const next = tokens[i + 1];
        if (next && HEB.test(next) && !this.known.has(t) && !this.known.has(next) && Math.min(t.length, next.length) <= 3) {
          const joined = this.nearest(t + next, 0.22);
          if (joined) {
            out.push(joined.word);
            i++;
            continue;
          }
        }
        if (t.replace(/\?/g, '').length < 2) continue;
        out.push(this.fix(t));
      }
      return out.join(' ');
    }
  }

  // ---------- short names for the list ----------
  // Store-style names carry sizes, percentages, packaging and brands:
  // "שמנת לבישול 15% 250 מ"ל" → "שמנת לבישול".
  const DROP_WORDS = new Set(
    `גרם גר ג קג ק"ג ליטר ל מל מ"ל מ"ל יח יח' יחידות יחידה מידה מנה מנות שומן אחוז
     בקרטון קרטון קרט בשקית שקית שקיות בבקבוק בקבוק פחית בפחית מארז במארז זוגות זוג וואקום בואקום ואקום
     ארוז ארוזה ארוזים במשקל שקיל משקל מוקטן גדול גדולה קטן קטנה חדש חדשה מבצע
     תנובה שטראוס יטבתה טרה עלית אסם תלמה סוגת יופלה אנגל מוריץ שופרסל יוחננוף רמי לוי עסיס פרימור
     מעדנות ויליפוד נסטלה יכין זוגלובק טבעול סנפרוסט מילוטל גד הנסיכה בייגל קוקה קולה פריגת`
      .split(/\s+/)
      .map((w) => w.replace(/["'׳״]/g, ''))
  );
  const ABBREVIATIONS = [
    [/(^|\s)גב(?:י)?\.(?=[א-ת])/g, '$1גבינה '], // "גב.לבנה" → "גבינה לבנה"
    [/(^|\s)שמ\.(?=[א-ת])/g, '$1שמנת '],
    [/חצי\s*מנה\s*\d*/g, ' '], // "חצי מנה100": a pack size, unlike "חצי קשה"
    [/(^|\s)גב['׳]?\.?(?=\s|$)/g, '$1גבינה'],
    [/(^|\s)גבי\.(?=\s|$)/g, '$1גבינה'],
    [/(^|\s)שמ\.(?=\s|$)/g, '$1שמנת'],
  ];

  function shortName(name) {
    let s = String(name || '');
    for (const [re, to] of ABBREVIATIONS) s = s.replace(re, to);
    s = s
      .replace(/[()"\]\[+*,\-–—/]/g, ' ') // brackets, quotes and separators
      .replace(/(\D)(\d)/g, '$1 $2') // "חמוצה15%" → "חמוצה 15%"
      .replace(/(\d)([^\d\s.%*])/g, '$1 $2'); // "150גר" → "150 גר"
    const words = s.split(/\s+/).filter(Boolean);
    const kept = [];
    for (const w of words) {
      const bare = w.replace(/["'׳״.]/g, '');
      if (!bare) continue;
      if (/\d/.test(bare) || bare === '%') continue; // sizes, percentages, counts
      if (DROP_WORDS.has(bare)) continue;
      if (bare.length < 2 && HEB.test(bare)) continue; // a cut-off letter at the end
      if (!HEB.test(bare)) continue; // latin leftovers ("L", "x")
      kept.push(w.replace(/\.$/, ''));
    }
    const out = kept.slice(0, 4).join(' ');
    return out || String(name || '').replace(/\d+/g, '').trim();
  }

  // ---------- the barcode list (lazy, cached) ----------
  let data = null;

  function fetchJson(url, timeoutMs) {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .finally(() => timer && clearTimeout(timer));
  }

  /** Load data/barcodes.json and data/words.json once. Works without them (first run, offline). */
  function load(base = 'data/') {
    if (!data) {
      data = Promise.all([fetchJson(base + 'barcodes.json', 15000), fetchJson(base + 'words.json', 15000)]).then(([codes, words]) => ({
        codes: codes || {},
        vocab: new Vocabulary(Array.isArray(words) ? words : []),
      }));
    }
    return data;
  }

  /**
   * Give receipt items readable names, in place.
   * opts.known(code) → name of a product you already named, or null.
   * opts.extraWords: more vocabulary (your product names).
   * Each item gets nameFrom: 'yours' | 'barcode' | 'fixed' | undefined.
   */
  async function improve(items, opts = {}) {
    const { codes, vocab } = await load(opts.base);
    if (opts.extraWords && opts.extraWords.length) {
      vocab.add(opts.extraWords.flatMap((n) => String(n).split(/\s+/)));
    }
    for (const it of items) {
      if (!it.ocrName) it.ocrName = it.name;
      const mine = it.code && opts.known ? opts.known(it.code) : null;
      if (mine) {
        it.name = mine;
        it.nameFrom = 'yours';
      } else if (it.code && codes[it.code]) {
        it.fullName = codes[it.code];
        it.name = shortName(codes[it.code]);
        it.nameFrom = 'barcode';
      } else if (opts.fixOcr) {
        const fixed = shortName(vocab.fixName(it.name));
        if (fixed && fixed !== it.name) {
          it.name = fixed;
          it.nameFrom = 'fixed';
        }
      }
    }
    return items;
  }

  const api = { improve, load, shortName, Vocabulary, distance, BASE_WORDS, _reset: () => (data = null) };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ProductNames = api;
})(typeof window !== 'undefined' ? window : globalThis);
