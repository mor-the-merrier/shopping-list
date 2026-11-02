/*
 * Extract the text of a PDF receipt in the browser, using pdf.js
 * (free, open source, loaded only when a PDF is uploaded).
 *
 * PDFs store text in pieces: whole lines, words, or single characters, and
 * Hebrew (right-to-left) mixed with numbers (left-to-right). There is no one
 * correct way to put the pieces back together, so this builds the text in
 * several ways and lets the caller keep whichever reads best.
 */
(function (root) {
  'use strict';

  const PDFJS_VERSION = '3.11.174';
  const PDFJS_BASE = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/`;
  let loading = null;

  function loadPdfJs() {
    if (root.pdfjsLib) return Promise.resolve(root.pdfjsLib);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS_BASE + 'pdf.min.js';
      s.onload = () => {
        root.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
        resolve(root.pdfjsLib);
      };
      s.onerror = () => {
        loading = null;
        reject(new Error('לא הצלחתי לטעון את קורא ה־PDF. צריך חיבור לאינטרנט בפעם הראשונה.'));
      };
      document.head.appendChild(s);
    });
    return loading;
  }

  const CURRENCY_START = /^\s*(?:ILS|₪)/;
  const HEBREW = /[֐-׿]/;

  /** Normalize pdf.js items into { str, x, y, w, h, dir } and drop empty ones. */
  function cleanItems(items) {
    return items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width || 0,
        h: Math.abs(it.height || it.transform[3] || 10),
        dir: it.dir || (HEBREW.test(it.str) ? 'rtl' : 'ltr'),
      }));
  }

  /** Group items that share a baseline into rows, top to bottom. */
  function rowsOf(items) {
    const rows = [];
    for (const it of items) {
      let row = rows.find((r) => Math.abs(r.y - it.y) < Math.max(2, it.h * 0.35));
      if (!row) {
        row = { y: it.y, parts: [] };
        rows.push(row);
      }
      row.parts.push(it);
    }
    return rows.sort((a, b) => b.y - a.y);
  }

  const tidy = (s) => s.replace(/\s+/g, ' ').trim();

  /** Strategy A: every piece is a word; read right to left (flip if the total comes first). */
  function linesSpaced(rows) {
    return rows.map((row) => {
      let parts = row.parts.slice().sort((a, b) => b.x - a.x);
      if (CURRENCY_START.test(parts[0].str)) parts = row.parts.slice().sort((a, b) => a.x - b.x);
      return tidy(parts.map((p) => p.str).join(' '));
    });
  }

  /**
   * Strategy B: pieces that touch belong to the same word (handles PDFs that
   * store single characters). Each word is assembled in its own direction,
   * then words are read right to left.
   */
  function linesJoined(rows) {
    return rows.map((row) => {
      const sorted = row.parts.slice().sort((a, b) => a.x - b.x);
      const words = [];
      let cur = null;
      for (const p of sorted) {
        const gap = cur ? p.x - (cur.right) : Infinity;
        if (cur && gap < Math.max(1, p.h * 0.18)) {
          cur.parts.push(p);
          cur.right = p.x + p.w;
        } else {
          cur = { parts: [p], left: p.x, right: p.x + p.w };
          words.push(cur);
        }
      }
      const text = (w) => {
        const rtl = w.parts.filter((p) => p.dir === 'rtl').length > w.parts.length / 2;
        const ordered = rtl ? w.parts.slice().reverse() : w.parts;
        return ordered.map((p) => p.str).join('');
      };
      let ordered = words.slice().reverse(); // right to left
      if (ordered.length && CURRENCY_START.test(text(ordered[0]))) ordered = words;
      return tidy(ordered.map(text).join(' '));
    });
  }

  /** Strategy C: the order the PDF itself stores the text in, a new line when the baseline moves. */
  function linesStreamOrder(items) {
    const lines = [];
    let line = [];
    let lastY = null;
    for (const it of items) {
      if (lastY !== null && Math.abs(it.y - lastY) > Math.max(2, it.h * 0.35)) {
        lines.push(tidy(line.join(' ')));
        line = [];
      }
      line.push(it.str);
      lastY = it.y;
    }
    if (line.length) lines.push(tidy(line.join(' ')));
    return lines;
  }

  /** Same as C, but pieces are joined without spaces (for PDFs that store spaces as text). */
  function linesStreamTight(items) {
    const lines = [];
    let line = '';
    let lastY = null;
    for (const it of items) {
      if (lastY !== null && Math.abs(it.y - lastY) > Math.max(2, it.h * 0.35)) {
        lines.push(tidy(line));
        line = '';
      }
      line += it.str;
      lastY = it.y;
    }
    if (line) lines.push(tidy(line));
    return lines;
  }

  /** All the ways to read the PDF, as { name, text }. */
  async function pdfToTexts(file) {
    const pdfjsLib = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const out = { spaced: [], joined: [], stream: [], tight: [] };
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const items = cleanItems(content.items);
      const rows = rowsOf(items);
      out.spaced.push(...linesSpaced(rows));
      out.joined.push(...linesJoined(rows));
      out.stream.push(...linesStreamOrder(items));
      out.tight.push(...linesStreamTight(items));
    }
    return Object.entries(out).map(([name, lines]) => ({ name, text: lines.join('\n') }));
  }

  /** Kept for compatibility: the first strategy only. */
  async function pdfToText(file) {
    return (await pdfToTexts(file))[0].text;
  }

  root.PdfText = { pdfToText, pdfToTexts, linesSpaced, linesJoined, linesStreamOrder, linesStreamTight, rowsOf, cleanItems };
})(window);
