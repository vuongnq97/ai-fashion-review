'use strict';

function buildContinuityPack(productTruth, routing, audit, suggested = {}, runId = '') {
  const detailReferenceIds = (audit.images || [])
    .filter(image => image.roles.some(role => ['detail_view', 'mechanism_detail'].includes(role)))
    .sort((a, b) => (b.scores?.operation || 0) - (a.scores?.operation || 0))
    .map(image => image.imageId);
  const characterEnabled = !['none'].includes(routing.humanMode);
  return {
    continuityId: `${runId || 'run'}-${productTruth.canonicalProductName}`.replace(/\s+/g, '-').toLowerCase(),
    product: {
      canonicalReferenceIds: productTruth.canonicalReferenceIds,
      detailReferenceIds,
      shapeSummary: productTruth.visualIdentity.shapeSummary,
      fixedComponents: productTruth.visualIdentity.fixedComponents,
      allowedStates: ['assembled', 'in_use', 'parked'],
      forbiddenChanges: productTruth.visualIdentity.forbiddenVisualChanges,
      logosAllowedToRemain: productTruth.visualIdentity.logosAllowedToRemain,
    },
    environment: {
      type: suggested.environment?.type || routing.environmentType,
      layout: suggested.environment?.layout || 'one coherent, physically plausible layout',
      fixedObjects: suggested.environment?.fixedObjects || [],
      floorOrSurface: suggested.environment?.floorOrSurface || 'category-appropriate real surface',
      backgroundPalette: suggested.environment?.backgroundPalette || [],
      lightDirection: suggested.environment?.lightDirection || 'consistent soft side light',
      colorTemperature: suggested.environment?.colorTemperature || 'neutral natural light',
      timeOfDay: suggested.environment?.timeOfDay || 'daytime',
    },
    character: {
      enabled: characterEnabled,
      visibility: routing.humanMode === 'hands_only' ? 'hands_only' : routing.humanMode === 'faceless_model' ? 'shoulders_down' : routing.humanMode,
      bodyDescription: suggested.character?.bodyDescription || '',
      skinTone: suggested.character?.skinTone || '',
      outfit: suggested.character?.outfit || '',
      footwear: suggested.character?.footwear || '',
      nails: suggested.character?.nails || '',
      forbiddenChanges: ['do not reveal a face in faceless mode', ...(suggested.character?.forbiddenChanges || [])],
    },
    camera: {
      captureStyle: suggested.camera?.captureStyle || 'authentic smartphone photograph',
      lensEquivalent: suggested.camera?.lensEquivalent || '24-26mm',
      exposure: suggested.camera?.exposure || 'natural auto exposure',
      depthOfField: suggested.camera?.depthOfField || 'natural smartphone depth of field',
      grain: suggested.camera?.grain || 'subtle sensor grain',
    },
    negativeRules: [
      'no added typography',
      'no copied poster text',
      'no fake logo or watermark',
      'preserve an original physical product mark when naturally visible',
      'no cartoon graphics',
      'no floating parts',
      'no duplicated limbs',
      'no product redesign',
      ...(suggested.negativeRules || []),
    ],
    sceneAnchor: null,
  };
}

function selectReferencesForScene(scene, continuityPack, input, config) {
  const byId = new Map(input.images.map(image => [image.imageId, image]));
  const ids = [];
  const add = id => { if (id && byId.has(id) && !ids.includes(id)) ids.push(id); };
  add(continuityPack.product.canonicalReferenceIds[0]);
  if (['open', 'detached'].includes(scene.productState) || scene.phase === 'proof') {
    const evidenceDetail = scene.evidenceIds.find(id => continuityPack.product.detailReferenceIds.includes(id));
    add(evidenceDetail || continuityPack.product.detailReferenceIds[0]);
  }
  const references = ids.map(id => ({ ...byId.get(id), role: id === ids[0] ? 'canonical_product' : 'mechanism_detail' }));
  if (continuityPack.sceneAnchor?.buffer || continuityPack.sceneAnchor?.imagePath) references.push({ ...continuityPack.sceneAnchor, role: 'scene_anchor' });
  if (continuityPack.characterAnchor?.buffer || continuityPack.characterAnchor?.imagePath) references.push({ ...continuityPack.characterAnchor, role: 'character_anchor' });
  return references.slice(0, config.maxImageReferencesPerCall);
}

module.exports = { buildContinuityPack, selectReferencesForScene };
