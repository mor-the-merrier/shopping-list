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

  // ---------- photos of paper receipts ----------

  const PHOTO_WIDTH = 2000; // receipt width after cropping: dot-matrix text gets ~35px tall
  const PHOTO_MAX_PIXELS = 12e6;

  async function loadBitmap(file) {
    if (root.createImageBitmap) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (e) {
        /* fall back to <img> */
      }
    }
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error('לא הצלחתי לפתוח את התמונה'));
        i.src = url;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  function grayCanvas(gray, width, height) {
    const c = canvasOf(width, height);
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(width, height);
    for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = gray[p];
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /** Photo → cropped, cleaned canvases: { text, digits, width, height }. */
  async function preparePhoto(file) {
    const P = root.PaperReceipt;
    const bmp = await loadBitmap(file);
    const W0 = bmp.width || bmp.naturalWidth;
    const H0 = bmp.height || bmp.naturalHeight;

    // find the paper on a small copy
    const s = Math.min(1, 900 / Math.max(W0, H0));
    const small = canvasOf(W0 * s, H0 * s);
    small.getContext('2d').drawImage(bmp, 0, 0, small.width, small.height);
    const sd = small.getContext('2d').getImageData(0, 0, small.width, small.height);
    const box = P.findPaper(sd.data, small.width, small.height);
    const cx = box.x0 / s, cy = box.y0 / s, cw = (box.x1 - box.x0 + 1) / s, ch = (box.y1 - box.y0 + 1) / s;

    // crop and scale the receipt to a working size
    let scale = PHOTO_WIDTH / cw;
    if (cw * ch * scale * scale > PHOTO_MAX_PIXELS) scale = Math.sqrt(PHOTO_MAX_PIXELS / (cw * ch));
    const work = canvasOf(cw * scale, ch * scale);
    const wctx = work.getContext('2d');
    wctx.imageSmoothingQuality = 'high';
    wctx.drawImage(bmp, cx, cy, cw, ch, 0, 0, work.width, work.height);
    if (bmp.close) bmp.close();

    const data = wctx.getImageData(0, 0, work.width, work.height).data;
    const clean = P.cleanForOcr(data, work.width, work.height);
    return {
      text: grayCanvas(clean.text, work.width, work.height),
      digits: grayCanvas(clean.digits, work.width, work.height),
      width: work.width,
      height: work.height,
    };
  }

  /** A vertical strip of a canvas, enlarged (digits read better a bit bigger). */
  function strip(canvas, x0, x1, scale = 1.5) {
    x0 = Math.max(0, Math.round(x0));
    x1 = Math.min(canvas.width, Math.round(x1));
    const c = canvasOf((x1 - x0) * scale, canvas.height * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, x0, 0, x1 - x0, canvas.height, 0, 0, c.width, c.height);
    return c;
  }

  /** Everything below the items (total, VAT, payment), full width. */
  function footer(canvas, fromY) {
    const y0 = Math.max(0, Math.round(fromY || 0));
    const h = Math.max(1, canvas.height - y0);
    const c = canvasOf(canvas.width, h);
    c.getContext('2d').drawImage(canvas, 0, y0, canvas.width, h, 0, 0, canvas.width, h);
    return c;
  }

  /** The big total's box, squashed back to normal proportions, on a white margin. */
  function bigTotalCanvas(canvas, box, factor = 1) {
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    const sh = Math.max(12, Math.round(h * box.squash * factor));
    const c = canvasOf(w + 40, sh + 40);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, box.x0, box.y0, w, h, 20, 20, w, sh);
    return c;
  }

  function grayOf(canvas) {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    const g = new Uint8ClampedArray(canvas.width * canvas.height);
    for (let p = 0, i = 0; p < g.length; p++, i += 4) g[p] = d[i];
    return g;
  }

  /** Strip words → full-image coordinates. */
  function unstrip(words, x0, scale = 1.5) {
    return words.map((w) => ({
      text: w.text,
      bbox: { x0: w.bbox.x0 / scale + x0, y0: w.bbox.y0 / scale, x1: w.bbox.x1 / scale + x0, y1: w.bbox.y1 / scale },
    }));
  }

  /**
   * Read photos of one paper receipt. Returns one reading per photo:
   * { text, words, codeWords, amountWords, width, codeFrom, amountTo }.
   * onProgress(fraction, label).
   */
  async function readPaperPhotos(files, onProgress = () => {}) {
    const n = files.length;
    const Tesseract = await loadTesseract();
    let photo = 0;
    let stage = 0;
    const label = () => `קורא את הקבלה${n > 1 ? ` (צילום ${photo + 1} מתוך ${n})` : ''}`;
    const logger = (m) => {
      if (m.status === 'recognizing text') onProgress((photo + (stage + m.progress) / 4) / n, label());
      else if (/loading|initializ/i.test(m.status)) onProgress(0.02, 'טוען את זיהוי הטקסט');
    };
    const heb = await Tesseract.createWorker('heb', 1, { logger });
    const digits = await Tesseract.createWorker('eng', 1, { logger });
    const out = [];
    try {
      for (photo = 0; photo < n; photo++) {
        stage = 0;
        onProgress(photo / n, `מכין את התמונה${n > 1 ? ` (${photo + 1} מתוך ${n})` : ''}`);
        const img = await preparePhoto(files[photo]);

        await heb.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
        const r1 = await heb.recognize(img.text);
        const words = wordsOf(r1.data, 0);
        const cols = root.PaperReceipt.findColumns(words, img.width);

        stage = 1;
        await digits.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789.' });
        const r2 = await digits.recognize(strip(img.digits, cols.codeFrom, img.width));

        stage = 2;
        await digits.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789.-' });
        const r3 = await digits.recognize(strip(img.text, 0, cols.amountTo));

        // the total is often printed big and centered next to "לתשלום", outside the price column
        stage = 3;
        let footerWords = [];
        if (cols.itemsEnd && cols.itemsEnd < img.height - 20) {
          await digits.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789.' });
          const r4 = await digits.recognize(footer(img.text, cols.itemsEnd));
          footerWords = wordsOf(r4.data, 0).map((w) => ({
            text: w.text,
            bbox: { x0: w.bbox.x0, y0: w.bbox.y0 + cols.itemsEnd, x1: w.bbox.x1, y1: w.bbox.y1 + cols.itemsEnd },
          }));
        }
        // a double-height total next to "לתשלום": read on its own, squashed to normal size
        let bigTotal = null;
        const box = cols.itemsEnd ? root.PaperReceipt.bigTotalBox(grayOf(img.text), img.width, img.height, cols.itemsEnd) : null;
        if (box) {
          // read it twice at slightly different sizes; findTotal picks the reading to trust
          await digits.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789.' });
          bigTotal = [];
          for (const factor of [1, 0.8]) {
            const r5 = await digits.recognize(bigTotalCanvas(img.text, box, factor));
            if ((r5.data.text || '').trim()) bigTotal.push(r5.data.text.trim());
          }
        }

        out.push({
          text: r1.data.text || '',
          words,
          codeWords: unstrip(wordsOf(r2.data, 0), cols.codeFrom),
          amountWords: unstrip(wordsOf(r3.data, 0), 0),
          footerWords,
          bigTotal,
          width: img.width,
          codeFrom: cols.codeFrom,
          amountTo: cols.amountTo,
        });
      }
      onProgress(1, 'מסיים');
      return out;
    } finally {
      heb.terminate();
      digits.terminate();
    }
  }

  root.ReceiptOcr = { readPictureReceipt, readPaperPhotos, preparePhoto, strip, unstrip, footer, bigTotalCanvas, grayOf, loadTesseract };
})(window);
