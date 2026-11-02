/*
 * Extract the text of a PDF receipt in the browser, using pdf.js
 * (free, open source, loaded only when a PDF is uploaded).
 * Rebuilds lines from text positions so each receipt row becomes one line.
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

  /** Group text items that share a baseline into lines. */
  function itemsToLines(items) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4];
      const y = it.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) < 3);
      if (!row) {
        row = { y, parts: [] };
        rows.push(row);
      }
      row.parts.push({ x, str: it.str });
    }
    rows.sort((a, b) => b.y - a.y); // top to bottom

    return rows.map((row) => {
      // Right-to-left reading order first; if that puts the total first,
      // the table is laid out left-to-right, so flip.
      let parts = row.parts.slice().sort((a, b) => b.x - a.x);
      if (CURRENCY_START.test(parts[0].str)) parts = row.parts.slice().sort((a, b) => a.x - b.x);
      return parts.map((p) => p.str.trim()).join(' ').replace(/\s+/g, ' ');
    });
  }

  async function pdfToText(file) {
    const pdfjsLib = await loadPdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const lines = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      lines.push(...itemsToLines(content.items));
    }
    return lines.join('\n');
  }

  root.PdfText = { pdfToText, itemsToLines };
})(window);
