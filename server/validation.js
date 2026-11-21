/**
 * BhoomiNex — Validation Engine
 * Checks extracted fields for completeness, consistency and duplicates.
 * Generates a structured validation report.
 * 
 * IMPORTANT: Confidence scores reflect OCR/extraction quality only.
 * They do NOT represent legal ownership or title verification.
 */

const db = require('./db');

// ── Required fields and their minimum confidence thresholds ───────────────────
const REQUIRED_FIELDS = ['owner', 'khasra_number', 'village', 'district', 'state'];
const IMPORTANT_FIELDS = ['khata_number', 'land_area', 'doc_type'];
const HIGH_CONF_THRESHOLD   = 85;
const MEDIUM_CONF_THRESHOLD = 65;
const LOW_CONF_THRESHOLD    = 40;

// ── Land area units for normalisation ─────────────────────────────────────────
const AREA_UNITS = /\b(acre|hectare|bigha|biswa|sq\.?\s*meter|marla|kanal|गुंठा|बीघा|एकड़|हेक्टेयर)\b/i;

// ── Validate extracted fields ─────────────────────────────────────────────────
function validateExtraction(fields, existingRecords = []) {
  const warnings  = [];
  const errors    = [];
  const flags     = [];
  const actions   = [];
  let   qualityScore = 100;

  // ── 1. Missing required fields ────────────────────────────────────────────
  for (const key of REQUIRED_FIELDS) {
    const field = fields[key];
    if (!field || !field.value) {
      warnings.push({ field: key, type: 'missing', message: `Required field "${label(key)}" could not be extracted. Manual entry required.` });
      qualityScore -= 12;
      flags.push(key);
    }
  }

  for (const key of IMPORTANT_FIELDS) {
    const field = fields[key];
    if (!field || !field.value) {
      warnings.push({ field: key, type: 'missing', message: `Field "${label(key)}" not found in document.` });
      qualityScore -= 5;
    }
  }

  // ── 2. Low-confidence fields ──────────────────────────────────────────────
  for (const [key, field] of Object.entries(fields)) {
    if (!field.value) continue;
    if (field.confidence < LOW_CONF_THRESHOLD) {
      errors.push({ field: key, type: 'low_confidence', confidence: field.confidence, message: `"${label(key)}" has very low confidence (${field.confidence}%). Manual verification required.` });
      qualityScore -= 8;
      flags.push(key);
    } else if (field.confidence < MEDIUM_CONF_THRESHOLD) {
      warnings.push({ field: key, type: 'uncertain', confidence: field.confidence, message: `"${label(key)}" has moderate confidence (${field.confidence}%). Please verify.` });
      qualityScore -= 3;
    }
  }

  // ── 3. Land area plausibility ─────────────────────────────────────────────
  const areaField = fields.land_area;
  if (areaField && areaField.value) {
    const numeric = parseFloat(areaField.value.replace(/[^\d.]/g, ''));
    const hasUnit = AREA_UNITS.test(areaField.value);
    if (!hasUnit) {
      warnings.push({ field: 'land_area', type: 'unit_missing', message: 'Land area value detected but measurement unit not identified. Please verify.' });
      qualityScore -= 4;
    }
    if (!isNaN(numeric)) {
      if (numeric > 10000) {
        warnings.push({ field: 'land_area', type: 'unusually_large', message: `Land area (${numeric}) seems unusually large. Please verify.` });
        qualityScore -= 5;
      }
      if (numeric <= 0) {
        errors.push({ field: 'land_area', type: 'invalid', message: 'Land area value is zero or negative. OCR error likely.' });
        qualityScore -= 8;
      }
    }
  }

  // ── 4. Khasra number format check ────────────────────────────────────────
  const khasra = fields.khasra_number;
  if (khasra && khasra.value) {
    if (!/^\d+([\/\-]\d+)?$/.test(khasra.value.trim())) {
      warnings.push({ field: 'khasra_number', type: 'format', message: `Khasra number "${khasra.value}" has unusual format. Expected numeric like 123 or 123/2.` });
      qualityScore -= 3;
    }
  }

  // ── 5. Duplicate detection ────────────────────────────────────────────────
  if (existingRecords.length > 0 && fields.khasra_number?.value && fields.village?.value) {
    const duplicate = existingRecords.find(r =>
      r.khasra_number === fields.khasra_number.value &&
      r.village?.toLowerCase() === fields.village.value?.toLowerCase() &&
      r.district?.toLowerCase() === fields.district?.value?.toLowerCase()
    );
    if (duplicate) {
      errors.push({
        field: 'khasra_number',
        type: 'duplicate',
        message: `A record with Khasra ${fields.khasra_number.value} in village ${fields.village.value} already exists (Record #${duplicate.id}). Possible duplicate.`,
        duplicateId: duplicate.id
      });
      qualityScore -= 15;
    }
  }

  // ── 6. Recommended actions ───────────────────────────────────────────────
  if (flags.length > 0) {
    actions.push('Manual review required for flagged fields: ' + flags.map(label).join(', '));
  }
  if (errors.filter(e => e.type === 'duplicate').length > 0) {
    actions.push('Investigate potential duplicate record before approval.');
  }
  if (Object.values(fields).filter(f => f.value).length === 0) {
    actions.push('No fields extracted. Document quality may be too poor for OCR. Request a clearer scan.');
  } else {
    actions.push('Authorized verifier must review and approve before this record is considered valid.');
  }

  // ── 7. Overall quality grade ──────────────────────────────────────────────
  const score  = Math.max(0, Math.min(100, Math.round(qualityScore)));
  const grade  = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
  const status = errors.length > 0 ? 'NEEDS_REVIEW' : warnings.length > 3 ? 'NEEDS_REVIEW' : 'READY_FOR_APPROVAL';

  return {
    warnings,
    errors,
    flags,
    actions,
    qualityScore:    score,
    qualityGrade:    grade,
    suggestedStatus: status,
    disclaimer:      'OCR confidence scores reflect extraction quality only. They do not constitute legal verification of ownership or land title.',
  };
}

// ── Field label helper ────────────────────────────────────────────────────────
function label(key) {
  const labels = {
    owner:         'Owner Name',
    khasra_number: 'Khasra Number',
    khata_number:  'Khata Number',
    village:       'Village',
    district:      'District',
    state:         'State',
    land_area:     'Land Area',
    doc_number:    'Document Number',
    doc_type:      'Document Type',
  };
  return labels[key] || key;
}

module.exports = { validateExtraction, label };
