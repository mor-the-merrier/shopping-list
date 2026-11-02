/*
 * Reading receipts that are pictures (Shufersal's PDF, or a screenshot) with
 * Tesseract.js: free, open-source OCR that runs inside the browser. Nothing is
 * sent anywhere; the first use downloads the OCR engine and the Hebrew
 * language file (a few MB), after which the browser keeps them cached.
 *
 * Three passes over three columns of the receipt (see js/shufersal.js):
 *   description column, Hebrew only
 *   code column, digits only
 *   amount column, digits, "." and "-" only
 */
(function (root) {
  'use strict';

  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  const TARGET_WIDTH = 1100; // px: small text stays readable, memory stays reasonable on phones
  const MAX_PIXELS = 15e6; // iOS refuses canvases much bigger than ~16M pixels

  let loading = null;

  function loadTesseract() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload = () => resolve(root.Tesseract);
      s.onerror = () => {
        loading = null;
        reject(new Error('לא הצלחתי לטעון את זיהוי הטקסט. צריך חיבור לאינטרנט בפעם הראשונה.'));
      };
      document.head.appendChild(s);
    });
    return loading;
  }

  function canvasOf(width, height) {
    const c = document.createElement('canvas');
    c.width = Math.round(width);
    c.height = Math.round(height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  function fitScale(width, height) {
    let scale = TARGET_WIDTH / width;
    if (width * height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (width * height));
    return scale;
  }

  /** The first page of a PDF as one canvas (pages stacked, for long receipts). */
  async function pdfToCanvas(file) {
    await root.PdfText.loadPdfJs();
    const pdf = await root.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let n = 1; n <= Math.min(pdf.numPages, 5); n++) pages.push(await pdf.getPage(n));
    const base = pages.map((p) => p.getViewport({ scale: 1 }));
    const width = Math.max(...base.map((v) => v.width));
    const height = base.reduce((s, v) => s + v.height, 0);
    const scale = fitScale(width, height);
    const canvas = canvasOf(width * scale, height * scale);
    const ctx = canvas.getContext('2d');
    let y = 0;
    for (const page of pages) {
      const vp = page.getViewport({ scale });
      const part = canvasOf(vp.width, vp.height);
      await page.render({ canvasContext: part.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
      ctx.drawImage(part, 0, y);
      y += vp.height;
    }
    return canvas;
  }

  /** A photo or screenshot as a canvas. */
  async function imageToCanvas(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('לא הצלחתי לפתוח את התמונה'));
        i.src = url;
      });
      const scale = fitScale(img.naturalWidth, img.naturalHeight);
      const canvas = canvasOf(img.naturalWidth * scale, img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function crop(canvas, x0, x1) {
    const c = canvasOf(x1 - x0, canvas.height);
    c.getContext('2d').drawImage(canvas, x0, 0, x1 - x0, canvas.height, 0, 0, x1 - x0, canvas.height);
    return c;
  }

  /** Tesseract.js result → flat list of words, shifted back to full-image coordinates. */
  function wordsOf(data, dx) {
    let words = data.words;
    if (!words && data.blocks) {
      words = [];
      for (const b of data.blocks) for (const p of b.paragraphs || []) for (const l of p.lines || []) words.push(...(l.words || []));
    }
    return (words || [])
      .filter((w) => w.text && w.text.trim())
      .map((w) => ({ text: w.text, bbox: { x0: w.bbox.x0 + dx, y0: w.bbox.y0, x1: w.bbox.x1 + dx, y1: w.bbox.y1 } }));
  }

  /**
   * Read a picture receipt. onProgress(fraction 0..1, label) is called as it goes.
   * Returns { text, words, codeWords, amountWords, width }.
   */
  async function readPictureReceipt(file, onProgress = () => {}) {
    onProgress(0.02, 'מכין את התמונה');
    const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name || '');
    const canvas = isPdf ? await pdfToCanvas(file) : await imageToCanvas(file);
    const W = canvas.width;
    const S = root.Shufersal;
    const xCode = Math.floor(W * S.CODE_FROM);
    const xAmount = Math.floor(W * S.AMOUNT_TO);

    onProgress(0.06, 'טוען את זיהוי הטקסט');
    const Tesseract = await loadTesseract();

    let stage = 0;
    const stages = 3;
    const logger = (m) => {
      if (m.status === 'recognizing text') onProgress(0.1 + (0.9 * (stage + m.progress)) / stages, `קורא את הקבלה (${stage + 1} מתוך ${stages})`);
      else if (/loading|initializ/i.test(m.status)) onProgress(0.08, 'טוען את זיהוי הטקסט');
    };

    const heb = await Tesseract.createWorker('heb', 1, { logger });
    const digits = await Tesseract.createWorker('eng', 1, { logger });
    try {
      await heb.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
      const desc = await heb.recognize(crop(canvas, xAmount, xCode));

      stage = 1;
      await digits.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789' });
      const code = await digits.recognize(crop(canvas, xCode, W));

      stage = 2;
      await digits.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789.-' });
      const amount = await digits.recognize(crop(canvas, 0, xAmount));

      onProgress(1, 'מסיים');
      return {
        text: desc.data.text || '',
        words: wordsOf(desc.data, xAmount),
        codeWords: wordsOf(code.data, xCode),
        amountWords: wordsOf(amount.data, 0),
        width: W,
      };
    } finally {
      heb.terminate();
      digits.terminate();
    }
  }

  root.ReceiptOcr = { readPictureReceipt, loadTesseract };
})(window);
