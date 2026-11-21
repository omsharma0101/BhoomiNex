/**
 * BhoomiNex — Full OCR Engine
 * Uses Tesseract.js (pure JS) for English + Hindi document scanning.
 * Extracts land-record fields with confidence scoring.
 * No fake data — returns null/missing for unavailable fields.
 */

const Tesseract = require('tesseract.js');
const path = require('path');
const fs   = require('fs');

// ── Language model cache dir ──────────────────────────────────────────────────
const LANG_DATA_DIR = path.join(__dirname, 'tessdata');
if (!fs.existsSync(LANG_DATA_DIR)) fs.mkdirSync(LANG_DATA_DIR);

// ── Field extraction patterns (English + Hindi) ───────────────────────────────
const PATTERNS = {
  owner: [
    /\b(?:owner|malik|स्वामी|मालिक|khatedar|खातेदार|proprietor|name|नाम)\s*[:\-।]\s*([^\n\r,;|]{3,60})/i,
    /\b(?:sri|shri|smt|mr|mrs|sh)\s+([A-Z][a-zA-Z\s]{3,50})/,
    /खातेदार\s*का\s*नाम\s*[:\-।]?\s*([^\n\r,;|]{3,50})/,
  ],
  khasra: [
    /\b(?:khasra|खसरा|kh\.?\s*no|khasra\s+no)\s*[:\-।#]?\s*(\d+[\/\-]?\d*)/i,
    /खसरा\s*(?:नंबर|नं\.?|क्र\.?)\s*[:\-।]?\s*(\d+[\/\-]?\d*)/,
    /[Kk]hasra\s*[Nn]o\.?\s*[:\-]?\s*(\d+[\/\-]?\d*)/,
  ],
  khata: [
    /\b(?:khata|खाता|khata\s+no|bahi|बही|account\s+no|khatuni)\s*[:\-।#]?\s*(\d+[\/\-]?\d*)/i,
    /खाता\s*(?:नंबर|नं\.?|क्र\.?)\s*[:\-।]?\s*(\d+[\/\-]?\d*)/,
    /[Kk]hata\s*[Nn]o\.?\s*[:\-]?\s*(\d+[\/\-]?\d*)/,
  ],
  village: [
    /\b(?:village|gram|ग्राम|गांव|mouza|mauza|pargana)\s*[:\-।]?\s*([A-Za-zА-Яа-яऀ-ॿ\s]{3,50}?)(?:\s*,|\s*\n|\s*district|\s*dist)/i,
    /ग्राम\s*[:\-।]?\s*([^\n\r,;|]{3,40})/,
    /[Vv]illage\s*[:\-]?\s*([A-Za-z\s]{3,40})/,
  ],
  district: [
    /\b(?:district|जिला|zila|tehsil)\s*[:\-।]?\s*([A-Za-zऀ-ॿ\s]{3,40}?)(?:\s*,|\s*\n|\s*state|\s*rajya)/i,
    /जिला\s*[:\-।]?\s*([^\n\r,;|]{3,40})/,
    /[Dd]istrict\s*[:\-]?\s*([A-Za-z\s]{3,40})/,
  ],
  state: [
    /\b(?:state|राज्य|rajya|pradesh)\s*[:\-।]?\s*([A-Za-zऀ-ॿ\s]{3,40}?)(?:\s*,|\s*\n|\s*pin|\s*india)/i,
    /राज्य\s*[:\-।]?\s*([^\n\r,;|]{3,40})/,
    /[Ss]tate\s*[:\-]?\s*([A-Za-z\s]{3,40})/,
  ],
  area: [
    /\b(?:area|भूमि|land\s+area|raqba|रकबा|kshetrafal|क्षेत्रफल|acre|hectare|bigha|biswa)\s*[:\-।]?\s*([\d.,]+\s*(?:acre|hectare|bigha|biswa|sq\.|हेक्टेयर|बीघा|एकड़|वर्ग)?[A-Za-z]*)/i,
    /रकबा\s*[:\-।]?\s*([\d.,]+\s*[^\n\r,;|]{0,20})/,
    /([\d.,]+)\s*(?:acre|hectare|bigha|biswa|हेक्टेयर|बीघा)/i,
  ],
  docNumber: [
    /\b(?:document\s*(?:no|number)|deed\s*(?:no|number)|registration\s*(?:no|number)|reg\.?\s*no|पंजीकरण\s*(?:नंबर|नं))\s*[:\-।#]?\s*([A-Z0-9\/\-]{3,30})/i,
    /[Dd]oc(?:ument)?\s*[Nn]o\.?\s*[:\-]?\s*([A-Z0-9\/\-]{3,30})/,
  ],
  docType: [
    /\b(sale\s+deed|gift\s+deed|lease\s+deed|mortgage|jamabandi|khatauni|khasra|patta|fard|mutation|विक्रय\s*पत्र|दान\s*पत्र|पट्टा|खतौनी|जमाबंदी|फर्द)\b/i,
  ],
};

// ── Known Indian states for normalisation ─────────────────────────────────────
const KNOWN_STATES = [
  'Haryana','Punjab','Rajasthan','Uttar Pradesh','Madhya Pradesh','Maharashtra',
  'Gujarat','Bihar','West Bengal','Karnataka','Tamil Nadu','Andhra Pradesh',
  'Telangana','Odisha','Jharkhand','Chhattisgarh','Uttarakhand','Himachal Pradesh',
  'Delhi','Goa','Assam','Kerala',
];

function normaliseState(raw) {
  if (!raw) return null;
  const clean = raw.trim().replace(/\s+/g,' ');
  const found = KNOWN_STATES.find(s => s.toLowerCase() === clean.toLowerCase());
  return found || clean;
}

// ── Extract a single field with confidence ────────────────────────────────────
function extractField(text, patterns, confidenceWords, fieldName) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const value = match[1].trim().replace(/\s+/g,' ');
      if (value.length < 2) continue;

      // Compute average Tesseract word confidence for this value
      let conf = computeFieldConfidence(value, confidenceWords, fieldName);

      return { value, confidence: conf };
    }
  }
  return { value: null, confidence: 0 };
}

// ── Map extracted value back to Tesseract word confidences ────────────────────
function computeFieldConfidence(value, confidenceWords, fieldName) {
  if (!confidenceWords || confidenceWords.length === 0) return 50;

  const words = value.toLowerCase().split(/\s+/);
  const matched = [];

  for (const word of words) {
    const found = confidenceWords.find(cw =>
      cw.text && cw.text.toLowerCase().includes(word) && word.length > 2
    );
    if (found) matched.push(found.confidence);
  }

  if (matched.length === 0) {
    // Use average overall confidence as fallback, slightly penalised
    const avg = confidenceWords.reduce((s, w) => s + (w.confidence || 0), 0) / confidenceWords.length;
    return Math.max(40, Math.min(85, Math.round(avg * 0.85)));
  }

  const avg = matched.reduce((s, c) => s + c, 0) / matched.length;
  return Math.round(Math.min(99, avg));
}

// ── Main OCR function ─────────────────────────────────────────────────────────
async function runOCR(filePath, onProgress) {
  const ext = path.extname(filePath).toLowerCase();
  let ocrText = '';
  let wordConfidences = [];
  let overallConfidence = 0;

  const report = progress => {
    if (onProgress) onProgress(progress);
  };

  try {
    report({ stage: 'initializing', pct: 5 });

    if (ext === '.pdf') {
      // For PDFs: try pdfjs-dist text extraction first
      const result = await extractPDFText(filePath, report);
      ocrText = result.text;
      overallConfidence = result.isDigital ? 95 : 60;
      wordConfidences = result.wordConfidences || [];

      if (!ocrText || ocrText.trim().length < 20) {
        return {
          success: false,
          error: 'PDF appears to be a scanned image. Please upload as JPG or PNG for OCR processing.',
          text: '',
          fields: {},
          overallConfidence: 0,
        };
      }
      report({ stage: 'text_extracted', pct: 70 });
    } else {
      // Image files: use Tesseract.js
      report({ stage: 'preprocessing', pct: 10 });

      const ocrResult = await Tesseract.recognize(
        filePath,
        'eng+hin',
        {
          langPath: LANG_DATA_DIR,
          logger: m => {
            if (m.status === 'recognizing text') {
              report({ stage: 'ocr_scanning', pct: 10 + Math.round(m.progress * 55) });
            }
          },
          tessedit_char_whitelist: '',
          preserve_interword_spaces: '1',
        }
      );

      ocrText = ocrResult.data.text || '';
      overallConfidence = Math.round(ocrResult.data.confidence || 0);

      // Collect word-level confidences
      if (ocrResult.data.words) {
        wordConfidences = ocrResult.data.words
          .filter(w => w.text && w.text.trim().length > 0)
          .map(w => ({ text: w.text, confidence: w.confidence || 0 }));
      }

      report({ stage: 'ocr_complete', pct: 70 });
    }

    if (!ocrText || ocrText.trim().length < 10) {
      return {
        success: false,
        error: 'OCR could not extract meaningful text. Please ensure the document is clear and readable.',
        text: '',
        fields: {},
        overallConfidence: 0,
      };
    }

    report({ stage: 'extracting_fields', pct: 75 });

    // ── Extract fields ────────────────────────────────────────────────────────
    const rawOwner    = extractField(ocrText, PATTERNS.owner,     wordConfidences, 'owner');
    const rawKhasra   = extractField(ocrText, PATTERNS.khasra,    wordConfidences, 'khasra');
    const rawKhata    = extractField(ocrText, PATTERNS.khata,     wordConfidences, 'khata');
    const rawVillage  = extractField(ocrText, PATTERNS.village,   wordConfidences, 'village');
    const rawDistrict = extractField(ocrText, PATTERNS.district,  wordConfidences, 'district');
    const rawState    = extractField(ocrText, PATTERNS.state,     wordConfidences, 'state');
    const rawArea     = extractField(ocrText, PATTERNS.area,      wordConfidences, 'area');
    const rawDocNum   = extractField(ocrText, PATTERNS.docNumber, wordConfidences, 'docNumber');
    const rawDocType  = extractField(ocrText, PATTERNS.docType,   wordConfidences, 'docType');

    // Normalise state
    if (rawState.value) rawState.value = normaliseState(rawState.value);

    // ── Build extraction result ────────────────────────────────────────────────
    const fields = {
      owner:         { value: rawOwner.value,    confidence: rawOwner.confidence,    status: fieldStatus(rawOwner.value,    rawOwner.confidence) },
      khasra_number: { value: rawKhasra.value,   confidence: rawKhasra.confidence,   status: fieldStatus(rawKhasra.value,   rawKhasra.confidence) },
      khata_number:  { value: rawKhata.value,    confidence: rawKhata.confidence,    status: fieldStatus(rawKhata.value,    rawKhata.confidence) },
      village:       { value: rawVillage.value,  confidence: rawVillage.confidence,  status: fieldStatus(rawVillage.value,  rawVillage.confidence) },
      district:      { value: rawDistrict.value, confidence: rawDistrict.confidence, status: fieldStatus(rawDistrict.value, rawDistrict.confidence) },
      state:         { value: rawState.value,    confidence: rawState.confidence,    status: fieldStatus(rawState.value,    rawState.confidence) },
      land_area:     { value: rawArea.value,     confidence: rawArea.confidence,     status: fieldStatus(rawArea.value,     rawArea.confidence) },
      doc_number:    { value: rawDocNum.value,   confidence: rawDocNum.confidence,   status: fieldStatus(rawDocNum.value,   rawDocNum.confidence) },
      doc_type:      { value: rawDocType.value,  confidence: rawDocType.confidence,  status: fieldStatus(rawDocType.value,  rawDocType.confidence) },
    };

    report({ stage: 'validating', pct: 90 });

    // ── Overall stats ─────────────────────────────────────────────────────────
    const extracted = Object.values(fields).filter(f => f.value !== null);
    const extractionRate = Math.round((extracted.length / Object.keys(fields).length) * 100);
    const avgConfidence  = extracted.length
      ? Math.round(extracted.reduce((s, f) => s + f.confidence, 0) / extracted.length)
      : 0;

    report({ stage: 'complete', pct: 100 });

    return {
      success:         true,
      text:            ocrText.substring(0, 2000), // first 2000 chars
      fields,
      overallConfidence: avgConfidence,
      extractionRate,
      wordCount:       wordConfidences.length || ocrText.split(/\s+/).length,
    };

  } catch (err) {
    console.error('[OCR Error]', err.message);
    return {
      success: false,
      error:   'OCR processing failed: ' + err.message,
      text:    '',
      fields:  {},
      overallConfidence: 0,
    };
  }
}

// ── Field status helper ───────────────────────────────────────────────────────
function fieldStatus(value, confidence) {
  if (!value)             return 'missing';
  if (confidence >= 85)   return 'high';
  if (confidence >= 65)   return 'medium';
  return 'low';
}

// ── PDF text extraction via pdfjs-dist ────────────────────────────────────────
async function extractPDFText(filePath, report) {
  try {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = false; // disable worker in Node

    const data = new Uint8Array(fs.readFileSync(filePath));
    report({ stage: 'loading_pdf', pct: 20 });

    const pdf = await pdfjsLib.getDocument({ data, useSystemFonts: true }).promise;
    let fullText = '';
    const pages = Math.min(pdf.numPages, 5); // first 5 pages

    for (let i = 1; i <= pages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text    = content.items.map(item => item.str).join(' ');
      fullText += text + '\n';
      report({ stage: 'reading_pdf_page', pct: 20 + Math.round((i / pages) * 45) });
    }

    const isDigital = fullText.trim().length > 50;
    return { text: fullText, isDigital, wordConfidences: [] };

  } catch (err) {
    console.warn('[PDF] pdfjs failed:', err.message);
    return { text: '', isDigital: false, wordConfidences: [] };
  }
}

module.exports = { runOCR };
