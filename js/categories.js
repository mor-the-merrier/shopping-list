/*
 * Store sections ("מחלקות"): the order you walk through a supermarket, and a
 * keyword guess for each product name. No AI: a word list. When several
 * keywords match, the longest one wins ("מיץ לימון" → pantry, not produce).
 * A product's section can always be changed by hand (Products screen).
 *
 * Keywords match whole words; a keyword ending in * matches the start of a word.
 */
(function (root) {
  'use strict';

  const CATEGORIES = [
    {
      id: 'produce',
      name: 'פירות וירקות',
      tone: 'green',
      words: ['עגבניות', 'עגבניה', 'עגבניית', 'מלפפון', 'מלפפונים', 'פלפל', 'בצל', 'שום', 'תפוח', 'תפוחים', 'בננה', 'בננות', 'לימון', 'לימונים', 'תפוז', 'תפוזים', 'קלמנטינה', 'קלמנטינות', 'אבוקדו', 'גזר', 'כרוב', 'חסה', 'ברוקולי', 'כרובית', 'קישוא', 'קישואים', 'חציל', 'חצילים', 'בטטה', 'תפוח אדמה', 'תפוחי אדמה', 'פטרוזיליה', 'כוסברה', 'נענע', 'שמיר', 'בזיליקום', 'ענבים', 'אבטיח', 'מלון', 'אגס', 'אגסים', 'אפרסק', 'שזיף', 'שזיפים', 'תות', 'תותים', 'מנגו', 'אננס', 'קיווי', 'רימון', 'פטריות', 'סלק', 'צנון', 'כרישה', 'סלרי', 'ירק', 'ירקות', 'פירות', 'נבטים', 'ג׳ינג׳ר', 'גינגר'],
    },
    {
      id: 'bakery',
      name: 'לחם ומאפים',
      tone: 'amber',
      words: ['לחם', 'לחמניה', 'לחמניות', 'פיתה', 'פיתות', 'חלה', 'חלות', 'בייגל', 'באגט', 'טורטייה', 'טורטיה', 'קרואסון', 'מאפה', 'מאפים', 'עוגה', 'פרוסות'],
    },
    {
      id: 'dairy',
      name: 'חלב וביצים',
      tone: 'blue',
      words: ['חלב', 'גבינה', 'גבינת', 'גבינות', 'קוטג', 'יוגורט*', 'שמנת', 'חמאה', 'לבנה', 'לאבנה', 'ביצים', 'ביצה', 'מעדן', 'מעדני', 'פודינג', 'מוצרלה', 'צפתית', 'בולגרית', 'ריקוטה', 'דנונה', 'מילקי', 'משקה חלב', 'שוקו', 'חלבון*', 'סקי', 'יופלה', 'עד חצות', 'רבע לשבע', 'נפוליאון'],
    },
    {
      id: 'meat',
      name: 'בשר ודגים',
      tone: 'red',
      words: ['עוף', 'חזה', 'שניצל', 'שניצלים', 'בשר', 'בשר טחון', 'כרעיים', 'פרגית', 'קבב', 'נקניק*', 'סלמון', 'דג', 'דגים', 'המבורגר', 'שוקיים', 'הודו', 'כנפיים', 'אנטריקוט', 'פילה'],
    },
    {
      id: 'pantry',
      name: 'מזווה',
      tone: 'orange',
      words: ['אורז', 'פסטה', 'ספגטי', 'קמח', 'סוכר', 'מלח', 'שמן', 'רסק', 'קטשופ', 'מיונז', 'טחינה', 'חומוס', 'תבלין', 'תבלינים', 'כמון', 'פפריקה', 'כורכום', 'פלפל שחור', 'בורגול', 'קוסקוס', 'עדשים', 'שעועית', 'שיבולת שועל', 'קורנפלקס', 'דגני*', 'ריבה', 'דבש', 'ממרח', 'קפה', 'תה', 'טונה', 'תירס', 'זיתים', 'חמוצים', 'מלפפון חמוץ', 'מלפפונים חמוצים', 'מיץ לימון', 'מלח לימון', 'רסק עגבניות', 'רסק', 'אינסטנט', 'אבקת', 'שמרים', 'סירופ', 'מייפל', 'אגוזי*', 'שקדים', 'פתיתים', 'נודלס', 'רוטב', 'חומץ', 'שימורי*', 'קטניות', 'גריסים'],
    },
    {
      id: 'frozen',
      name: 'קפואים',
      tone: 'cyan',
      words: ['קפוא*', 'מוקפא*', 'אפונה', 'שעועית ירוקה', 'גלידה', 'גלידות', 'ארטיק', 'בורקס', 'פיצה קפואה', 'ירקות קפואים'],
    },
    {
      id: 'drinks',
      name: 'משקאות',
      tone: 'teal',
      words: ['מים', 'סודה', 'קולה', 'מיץ', 'משקה', 'בירה', 'יין', 'נביעות', 'מיץ תפוזים', 'מיץ ענבים', 'פריגת', 'ספרייט', 'פפסי', 'שוופס'],
    },
    {
      id: 'snacks',
      name: 'חטיפים ומתוקים',
      tone: 'pink',
      words: ['במבה', 'ביסלי', 'חטיף*', 'שוקולד', 'עוגיות', 'עוגייה', 'וופל', 'וופלים', 'גרעינים', 'גרעיני', 'חמניות', 'ציפס', 'צ׳יפס', 'שוקו ציפס', 'סוכריות', 'מסטיק', 'חלבה', 'פופקורן', 'קרקר*', 'בייגלה', 'פרינגלס', 'דובונים', 'פתיבר'],
    },
    {
      id: 'home',
      name: 'בית וניקיון',
      tone: 'yellow',
      words: ['נייר', 'נייר אפייה', 'נייר טואלט', 'נייר סופג', 'אקונומיקה', 'סבון', 'נוזל כלים', 'נוזל לכלים', 'סנו', 'ניקוי', 'מסיר', 'שקיות', 'שקית אשפה', 'אלומיניום', 'ספוג*', 'טואלט', 'מטהר', 'כביסה', 'מרכך', 'קצף', 'אבנית', 'נרות', 'סוללות', 'ניילון', 'מגבות', 'כלים חד פעמיים', 'צלחות'],
    },
    {
      id: 'care',
      name: 'תינוקות ופארם',
      tone: 'purple',
      words: ['האגיס', 'טיטולים', 'חיתולים', 'מטרנה', 'סימילאק', 'שמפו', 'מרכך שיער', 'משחת שיניים', 'מברשת שיניים', 'דאודורנט', 'מגבונים', 'תחליב', 'קרם', 'פדים', 'תחבושות', 'פרידום'],
    },
    { id: 'other', name: 'אחר', tone: 'gray', words: [] },
  ];

  const BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
  const ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, i]));

  /** Lower case, no quote marks (קוטג' = קוטג׳ = קוטג), single spaces. */
  function clean(s) {
    return ' ' + String(s || '').toLowerCase().replace(/["״׳'`]/g, '').replace(/[^\p{L}\p{N}%]+/gu, ' ').replace(/\s+/g, ' ').trim() + ' ';
  }

  const KEYWORDS = [];
  for (const c of CATEGORIES) {
    for (const w of c.words) {
      const prefix = w.endsWith('*');
      KEYWORDS.push({ id: c.id, text: clean(prefix ? w.slice(0, -1) : w).trim(), prefix });
    }
  }
  KEYWORDS.sort((a, b) => b.text.length - a.text.length); // longest first

  /** Best guess for a product name, or 'other'. */
  function guessCategory(...names) {
    for (const name of names) {
      const hay = clean(name);
      if (!hay.trim()) continue;
      for (const k of KEYWORDS) {
        if (k.prefix ? hay.includes(' ' + k.text) : hay.includes(' ' + k.text + ' ')) return k.id;
      }
    }
    return 'other';
  }

  const api = { CATEGORIES, BY_ID, ORDER, guessCategory };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KniyotCategories = api;
})(typeof window !== 'undefined' ? window : globalThis);
