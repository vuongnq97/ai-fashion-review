'use strict';

const EVIDENCE_STATUSES = new Set([
  'verified_visual',
  'verified_multi_source',
  'description_only',
  'poster_only',
  'inferred',
  'conflict',
  'unknown',
]);

const IMAGE_ROLES = new Set([
  'hero_view', 'front_view', 'side_view', 'rear_view', 'top_view',
  'detail_view', 'usage_demo', 'mechanism_detail', 'accessories',
  'packaging', 'variant_comparison', 'before_after', 'marketing_poster',
  'lifestyle_reference', 'duplicate', 'low_quality',
]);

function requiredObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function clampScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const normalized = number > 0 && number <= 1 ? number * 100 : number;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function referenceAliases(value) {
  const raw = cleanString(value).toLocaleLowerCase('vi');
  if (!raw) return [];
  const basename = pathBasename(raw);
  const stem = basename.replace(/\.[a-z0-9]+$/iu, '');
  const compact = stem.replace(/[^\p{L}\p{N}]+/gu, '');
  const ordinal = stem.match(/(?:^|[^0-9])(\d{1,3})(?:[^0-9]|$)/u)?.[1];
  return [...new Set([raw, basename, stem, compact, ordinal ? String(Number(ordinal)) : ''].filter(Boolean))];
}

function pathBasename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop() || '';
}

function resolveInputImageId(reference, input) {
  const target = new Set(referenceAliases(reference));
  if (!target.size) return null;
  for (const image of input.images) {
    const aliases = new Set([
      ...referenceAliases(image.imageId),
      ...referenceAliases(image.name),
      ...referenceAliases(image.uri),
    ]);
    if ([...target].some(alias => aliases.has(alias))) return image.imageId;
  }
  return null;
}

function normalizeInput(filePayloads, options = {}) {
  if (!Array.isArray(filePayloads) || filePayloads.length === 0) {
    throw new TypeError('At least one product image is required');
  }
  const context = options.productContext || {};
  const images = filePayloads.map((file, index) => {
    const imageId = cleanString(file.imageId) || `img_${String(index + 1).padStart(2, '0')}`;
    const buffer = Buffer.isBuffer(file.buffer)
      ? file.buffer
      : (file.base64 ? Buffer.from(file.base64, 'base64') : null);
    return {
      imageId,
      name: cleanString(file.name) || `${imageId}.png`,
      mimeType: cleanString(file.mimeType) || 'image/png',
      source: cleanString(file.source) || 'unknown',
      uri: cleanString(file.path || file.uri),
      buffer,
      original: file,
    };
  });

  if (!images.some(image => image.buffer || image.uri)) {
    throw new TypeError('No readable product image was provided');
  }

  return {
    productName: cleanString(context.productTitle || options.productName) || null,
    description: cleanString(context.productDescription || options.description),
    productId: cleanString(context.productId || options.productId) || null,
    productUrl: cleanString(context.productUrl || options.productUrl) || null,
    images,
    optional: {
      targetAudience: options.targetAudience || null,
      preferredVoice: options.preferredVoice || null,
      requiredClaims: asArray(options.requiredClaims),
      forbiddenClaims: asArray(options.forbiddenClaims),
      brandGuidelines: options.brandGuidelines || null,
    },
  };
}

function normalizeAudit(rawAudit, input) {
  const raw = rawAudit?.assetAudit || rawAudit || {};
  const rawImages = asArray(raw.images);
  const images = input.images.map(image => {
    const item = rawImages.find(candidate => resolveInputImageId(candidate.imageId || candidate.filename || candidate.name, { images: [image] })) || {};
    const roles = asArray(item.roles).map(role => String(role).trim().toLowerCase()).filter(role => IMAGE_ROLES.has(role));
    return {
      imageId: image.imageId,
      roles: roles.length ? roles : ['low_quality'],
      contentType: cleanString(item.contentType) || 'unknown',
      visibleProducts: asArray(item.visibleProducts),
      visibleGeometry: asArray(item.visibleGeometry),
      visibleInteractions: asArray(item.visibleInteractions),
      ocrEvidence: asArray(item.ocrEvidence),
      containsMultipleVariants: item.containsMultipleVariants === true || roles.includes('variant_comparison'),
      scores: {
        productShape: clampScore(item.scores?.productShape),
        operation: clampScore(item.scores?.operation),
        material: clampScore(item.scores?.material),
        sceneStyle: clampScore(item.scores?.sceneStyle),
      },
      warnings: asArray(item.warnings).map(String),
    };
  });

  return {
    detectedProductNames: asArray(raw.detectedProductNames),
    possibleVariants: asArray(raw.possibleVariants),
    images,
    crossImageConflicts: asArray(raw.crossImageConflicts),
    recommendedCanonicalImages: asArray(raw.recommendedCanonicalImages).map(ref => resolveInputImageId(ref, input)).filter(Boolean),
    recommendedDetailImages: asArray(raw.recommendedDetailImages).map(ref => resolveInputImageId(ref, input)).filter(Boolean),
    excludedGenerationReferences: asArray(raw.excludedGenerationReferences).map(ref => resolveInputImageId(ref, input)).filter(Boolean),
    hasUnresolvableSkuConflict: raw.hasUnresolvableSkuConflict === true,
  };
}

function assertFourScenes(storyPlan) {
  requiredObject(storyPlan, 'storyPlan');
  if (!Array.isArray(storyPlan.scenes) || storyPlan.scenes.length !== 4) {
    throw new TypeError('storyPlan.scenes must contain exactly four scenes');
  }
  return storyPlan;
}

module.exports = {
  EVIDENCE_STATUSES,
  IMAGE_ROLES,
  asArray,
  assertFourScenes,
  clampScore,
  cleanString,
  normalizeAudit,
  normalizeInput,
  referenceAliases,
  resolveInputImageId,
  requiredObject,
};
