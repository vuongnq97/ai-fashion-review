'use strict';

const { EVIDENCE_STATUSES, asArray, clampScore, cleanString } = require('./contracts');

const VISUAL_STATUSES = new Set(['verified_visual', 'verified_multi_source']);
const VOICE_STATUSES = new Set(['verified_visual', 'verified_multi_source', 'description_only']);
const NON_VISUAL_NUMERIC = /(?:\b\d+(?:[.,]\d+)?\s*(?:w|kw|kg|g|pa|kpa|mah|ml|l|cm|mm|%|tháng|năm)\b|bảo hành|chính hãng|giảm giá|ưu đãi)/iu;
const SENSITIVE_DESCRIPTION_CLAIM = /(?:điều trị|chữa|chẩn đoán|giảm cân|tuyệt đối an toàn|100% an toàn|medical|treat|cure|diagnos|weight loss|absolute safety|lợi nhuận|profit guarantee)/iu;

function canonicalRolePenalty(image) {
  const roles = new Set(image.roles || []);
  if (image.containsMultipleVariants || roles.has('variant_comparison')) return 1000;
  if (roles.has('marketing_poster')) return 600;
  if (roles.has('duplicate') || roles.has('low_quality')) return 800;
  return 0;
}

function selectCanonicalImages(audit, limit = 2) {
  const preferred = new Set(audit.recommendedCanonicalImages || []);
  const ranked = [...(audit.images || [])].sort((a, b) => {
    const aScore = (a.scores?.productShape || 0) + (preferred.has(a.imageId) ? 20 : 0) - canonicalRolePenalty(a);
    const bScore = (b.scores?.productShape || 0) + (preferred.has(b.imageId) ? 20 : 0) - canonicalRolePenalty(b);
    return bScore - aScore;
  });
  const clean = ranked.filter(image => canonicalRolePenalty(image) === 0 && (image.scores?.productShape || 0) > 0);
  const selected = (clean.length ? clean : ranked.filter(image => !image.roles?.includes('duplicate'))).slice(0, limit);
  return selected.map(image => image.imageId);
}

function normalizeAttributeName(value) {
  return cleanString(value).toLocaleLowerCase('vi').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '');
}

function normalizeComparableValue(value, unit) {
  const raw = `${value ?? ''} ${unit || ''}`.trim().toLocaleLowerCase('vi').replace(/,/g, '.');
  const numeric = raw.match(/-?\d+(?:\.\d+)?/);
  if (numeric) {
    const normalizedUnit = raw.match(/(kw|w|kg|g|kpa|pa|mah|ml|l|cm|mm|%|tháng|năm)\b/u)?.[1] || '';
    let number = Number(numeric[0]);
    let targetUnit = normalizedUnit;
    if (normalizedUnit === 'kw') { number *= 1000; targetUnit = 'w'; }
    if (normalizedUnit === 'kg') { number *= 1000; targetUnit = 'g'; }
    if (normalizedUnit === 'kpa') { number *= 1000; targetUnit = 'pa'; }
    if (normalizedUnit === 'l') { number *= 1000; targetUnit = 'ml'; }
    return `${number}:${targetUnit}`;
  }
  return raw.replace(/\s+/g, ' ');
}

function extractOcrAttributes(audit) {
  const attributes = [];
  const patterns = [
    { name: 'power', regex: /(\d+(?:[.,]\d+)?)\s*(kw|w)\b/giu },
    { name: 'weight', regex: /(\d+(?:[.,]\d+)?)\s*(kg|g)\b/giu },
    { name: 'pressure', regex: /(\d+(?:[.,]\d+)?)\s*(kpa|pa)\b/giu },
    { name: 'warranty', regex: /(\d+(?:[.,]\d+)?)\s*(tháng|năm)\b/giu },
  ];
  for (const image of audit.images || []) {
    for (const evidence of image.ocrEvidence || []) {
      const text = typeof evidence === 'string' ? evidence : String(evidence.text || evidence.value || '');
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern.regex)) {
          attributes.push({
            name: pattern.name,
            value: Number(String(match[1]).replace(',', '.')),
            unit: match[2].toLowerCase(),
            source: 'ocr',
            sourceId: image.imageId,
            raw: match[0],
          });
        }
      }
    }
  }
  return attributes;
}

function enforceAttributePolicy(attribute) {
  const status = inferAttributeStatus(attribute);
  const text = `${attribute.name || ''} ${attribute.value ?? ''} ${attribute.unit || ''}`;
  const evidence = asArray(attribute.evidence).length
    ? asArray(attribute.evidence)
    : asArray(attribute.sources).map(source => ({ source: String(source), sourceId: '', value: attribute.value ?? '' }));
  return {
    ...attribute,
    name: cleanString(attribute.name) || 'unknown',
    status,
    confidence: clampScore(attribute.confidence),
    evidence,
    allowedInVisual: VISUAL_STATUSES.has(status) && !NON_VISUAL_NUMERIC.test(text),
    allowedInVoiceover: VOICE_STATUSES.has(status) && !(status === 'description_only' && SENSITIVE_DESCRIPTION_CLAIM.test(text)),
    allowedInPostProductionCopy: VOICE_STATUSES.has(status) && !(status === 'description_only' && SENSITIVE_DESCRIPTION_CLAIM.test(text)),
  };
}

function inferAttributeStatus(attribute) {
  const direct = String(attribute.status || '').trim().toLowerCase();
  if (EVIDENCE_STATUSES.has(direct)) return direct;
  const evidenceStatus = String(attribute.evidenceStatus || attribute.verificationStatus || '').trim().toLowerCase();
  if (/conflict|disputed|contradict|mâu thuẫn/u.test(evidenceStatus)) return 'conflict';
  if (/infer|suy luận/u.test(evidenceStatus)) return 'inferred';
  if (/unknown|unverified|không rõ/u.test(evidenceStatus)) return 'unknown';
  if (/poster/u.test(evidenceStatus)) return 'poster_only';
  const sources = asArray(attribute.sources).map(source => String(source).toLowerCase());
  const hasVisual = sources.some(source => /image|visual|photo|ảnh|asset audit/u.test(source));
  if (/verified|confirmed|xác minh/u.test(evidenceStatus)) {
    return hasVisual ? 'verified_visual' : 'description_only';
  }
  return 'unknown';
}

function mergeAndResolveAttributes(rawAttributes, audit) {
  const attributes = asArray(rawAttributes).map(attribute => enforceAttributePolicy({ ...attribute }));
  for (const ocr of extractOcrAttributes(audit)) {
    const key = normalizeAttributeName(ocr.name);
    let attribute = attributes.find(item => normalizeAttributeName(item.name) === key);
    if (!attribute) {
      attribute = enforceAttributePolicy({
        name: ocr.name,
        value: ocr.value,
        unit: ocr.unit,
        status: 'poster_only',
        confidence: 50,
        evidence: [],
      });
      attributes.push(attribute);
    }
    attribute.evidence.push({ source: 'ocr', sourceId: ocr.sourceId, value: ocr.raw });
  }

  for (const attribute of attributes) {
    const comparable = new Set();
    if (attribute.value !== null && attribute.value !== undefined && attribute.value !== '') {
      comparable.add(normalizeComparableValue(attribute.value, attribute.unit));
    }
    for (const evidence of attribute.evidence || []) {
      comparable.add(normalizeComparableValue(evidence.value, attribute.unit));
    }
    comparable.delete('');
    if (comparable.size > 1) {
      attribute.status = 'conflict';
      attribute.allowedInVisual = false;
      attribute.allowedInVoiceover = false;
      attribute.allowedInPostProductionCopy = false;
    } else {
      Object.assign(attribute, enforceAttributePolicy(attribute));
    }
  }
  return attributes;
}

function buildProductTruthProfile(rawTruth, audit, input) {
  const raw = rawTruth?.productTruth || rawTruth || {};
  const canonicalReferenceIds = selectCanonicalImages(audit, 2);
  const attributes = mergeAndResolveAttributes(raw.attributes, audit);
  const openConflicts = [
    ...asArray(raw.openConflicts),
    ...attributes.filter(item => item.status === 'conflict').map(item => ({ attribute: item.name, evidence: item.evidence })),
    ...asArray(audit.crossImageConflicts),
  ];
  const variantConfidence = clampScore(raw.variantConfidence);
  const ambiguousVariant = asArray(audit.possibleVariants).length > 1 && variantConfidence < 60;
  const blocking = audit.hasUnresolvableSkuConflict || ambiguousVariant || !canonicalReferenceIds.length;
  const status = blocking
    ? 'needs_review'
    : (raw.status === 'rejected' ? 'rejected' : 'approved');

  return {
    canonicalProductName: cleanString(raw.canonicalProductName || input.productName) || 'Sản phẩm',
    canonicalVariant: cleanString(raw.canonicalVariant),
    category: cleanString(raw.category) || 'other',
    subcategory: cleanString(raw.subcategory),
    variantConfidence,
    canonicalReferenceIds,
    visualIdentity: {
      dominantColors: asArray(raw.visualIdentity?.dominantColors),
      shapeSummary: cleanString(raw.visualIdentity?.shapeSummary),
      fixedComponents: asArray(raw.visualIdentity?.fixedComponents),
      movingOrDetachableComponents: asArray(raw.visualIdentity?.movingOrDetachableComponents),
      logosAllowedToRemain: asArray(raw.visualIdentity?.logosAllowedToRemain),
      forbiddenVisualChanges: asArray(raw.visualIdentity?.forbiddenVisualChanges),
    },
    attributes,
    supportedUseCases: asArray(raw.supportedUseCases),
    unsupportedOrRiskyClaims: asArray(raw.unsupportedOrRiskyClaims),
    openConflicts,
    reviewDisposition: !blocking && raw.status === 'needs_review' ? 'continued_with_unverified_claims_excluded' : null,
    status,
  };
}

function isNonVisualClaim(value) {
  return NON_VISUAL_NUMERIC.test(String(value || ''));
}

module.exports = {
  buildProductTruthProfile,
  enforceAttributePolicy,
  extractOcrAttributes,
  inferAttributeStatus,
  isNonVisualClaim,
  mergeAndResolveAttributes,
  normalizeComparableValue,
  SENSITIVE_DESCRIPTION_CLAIM,
  selectCanonicalImages,
};
