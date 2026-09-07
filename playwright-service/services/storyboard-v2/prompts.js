'use strict';

function jsonOnly(task, schema) {
  return `${task}\nReturn valid JSON only. Required shape:\n${JSON.stringify(schema, null, 2)}`;
}

function assetAuditPrompt(input) {
  return jsonOnly(`TEXT/VISION ANALYSIS ONLY. Audit each provided product image independently.
Identify all visible SKUs, image roles, visible geometry/interactions, OCR evidence, content type, conflicts and reference suitability scores.
Do not infer hidden parts. Poster text is unverified evidence. Do not write a marketing plan.
Input product name: ${input.productName || 'unknown'}.
Image identifier map (the imageId in JSON MUST use the left-hand value exactly):
${input.images.map(image => `- ${image.imageId} => ${image.name}`).join('\n')}
Input description is context only and must not override visual conflicts.`, {
    assetAudit: { detectedProductNames: [], possibleVariants: [], images: [{ imageId: 'img_01', roles: ['hero_view'], contentType: 'photo', visibleProducts: [], visibleGeometry: [], visibleInteractions: [], ocrEvidence: [], containsMultipleVariants: false, scores: { productShape: 0, operation: 0, material: 0, sceneStyle: 0 }, warnings: [] }], crossImageConflicts: [], recommendedCanonicalImages: [], recommendedDetailImages: [], excludedGenerationReferences: [], hasUnresolvableSkuConflict: false },
  });
}

function productTruthPrompt(input, audit) {
  return jsonOnly(`Build a grounded Product Truth Profile from the asset audit and raw description.
Preserve every disagreement. Every attribute needs sources, confidence, evidence status, and channel permissions.
Never invent materials, mechanisms, certifications, safety, performance, warranty or accessories.
Use confidence scores from 0 to 100. Attribute status must be exactly one of: verified_visual, verified_multi_source, description_only, poster_only, inferred, conflict, unknown.
If a canonical SKU is confidently identified, keep disagreements in openConflicts and mark those attributes conflict; do not mark the whole profile needs_review solely because excluded claims disagree.
Description: ${input.description || '(none)'}
Asset audit: ${JSON.stringify(audit)}`, {
    productTruth: { canonicalProductName: '', canonicalVariant: '', category: 'other', subcategory: '', variantConfidence: 0, visualIdentity: { dominantColors: [], shapeSummary: '', fixedComponents: [], movingOrDetachableComponents: [], logosAllowedToRemain: [], forbiddenVisualChanges: [] }, attributes: [], supportedUseCases: [], unsupportedOrRiskyClaims: [], openConflicts: [], status: 'approved' },
  });
}

function storyPlanPrompt(truth, routing, config) {
  return jsonOnly(`Create exactly four scenes: Hook, Solution, Proof, Closing.
Use approved Product Truth evidence only. Each scene has one visual claim and one physical action.
Separate visualClaim, voiceoverClaim and postProductionCopy. Numeric/warranty/offer claims are never visualized in no-generated-text imagery.
No facial expression in faceless modes. Detached parts require a hand or support surface and mechanism evidence.
Voice target: ${config.voiceWordsPerSecondTarget} words/second for ${config.sceneDurationSeconds} seconds.
Truth: ${JSON.stringify(truth)}
Routing: ${JSON.stringify(routing)}`, {
    storyPlan: { productName: truth.canonicalProductName, centralPromise: '', targetAudience: '', scenes: [1, 2, 3, 4].map((sceneNumber, index) => ({ sceneNumber, phase: ['hook', 'solution', 'proof', 'closing'][index], marketingIntent: '', visualClaim: '', voiceoverClaim: '', postProductionCopy: '', primaryAction: '', visualDescription: '', productState: 'assembled', requiredComponents: [], humanFraming: 'hands', handsRequired: 0, handsAvailable: 2, supportingSurface: '', evidenceIds: [], durationSeconds: config.sceneDurationSeconds, fallbackScene: null })) },
  });
}

function continuityPrompt(truth, routing) {
  return jsonOnly(`Create category-appropriate continuity suggestions. Do not invent product geometry. Do not hardcode gender, skin tone, beige clothing, Scandinavian rooms, or vacuum-cleaner interactions.
Truth: ${JSON.stringify(truth)}
Routing: ${JSON.stringify(routing)}`, { environment: {}, character: {}, camera: {}, negativeRules: [] });
}

function panelPrompt(scene, continuity) {
  return `Generate ONE vertical 9:16 photorealistic ecommerce review still for Scene ${scene.sceneNumber} (${scene.phase}).
PRODUCT: preserve exact canonical silhouette, colors, proportions, materials, component positions and original physical wordmark when naturally visible. Forbidden changes: ${(continuity.product.forbiddenChanges || []).join('; ') || 'none'}.
CONTINUITY: same environment and person as the approved anchor. Environment: ${JSON.stringify(continuity.environment)}. Character: ${JSON.stringify(continuity.character)}. Camera: ${JSON.stringify(continuity.camera)}.
SCENE: visual claim: ${scene.visualClaim}. One action only: ${scene.primaryAction}. Product state: ${scene.productState}. Supporting surface: ${scene.supportingSurface || 'natural physical support'}.
TEXT POLICY: no added headline, caption, number, badge, UI, watermark or copied poster text. Preserve only an original product mark physically present.
REALISM: real contact shadows, plausible grip, correct anatomy, no floating components, no product redesign. Human framing: ${scene.humanFraming}.
Avoid: ${(continuity.negativeRules || []).join('; ')}. Output one still image only.`;
}

function contactSheetPrompt(storyPlan, continuity) {
  return coherentMasterPrompt(storyPlan, continuity, {}, {}, {});
}

function coherentMasterPrompt(storyPlan, continuity, truth, audit, input, correction = '') {
  return `Generate ONE SINGLE 16:9 MASTER STORYBOARD IMAGE. Inside it, create EXACTLY FOUR equal-width vertical cells arranged left-to-right: 1 Hook, 2 Solution, 3 Proof, 4 Closing. Do not return separate images and do not add gutters that shift cell boundaries.

GLOBAL CONSISTENCY IS THE HIGHEST PRIORITY: all four cells must show the same exact canonical product/SKU, silhouette, dimensions, colors, transparent/opaque parts, attachment mechanism, cable exit, accessories, environment, lighting, hands/person and clothing. Treat this as four consecutive frames from one shoot, not four independent concepts.

CANONICAL PRODUCT TRUTH: ${JSON.stringify(truth)}
CONTINUITY LOCK: ${JSON.stringify(continuity)}
FOUR SCENES: ${JSON.stringify(storyPlan.scenes)}
INPUT DESCRIPTION (context only; visual truth wins conflicts): ${input.description || '(none)'}
ASSET AUDIT: ${JSON.stringify(audit)}

REFERENCE POLICY: the evidence-board reference contains every received input image for analysis context. Use only canonical reference IDs from Product Truth to copy product geometry. Never blend comparison variants, poster layouts, people, typography or conflicting SKUs from the evidence board.
TEXT POLICY: no added headline, caption, number, badge, UI, watermark or poster text. Preserve only a real physical product wordmark when naturally present.
REALISM: physically possible assembly and contact, correct anatomy, no floating parts, no duplicated accessories, no product morphing. Each cell performs only its specified action.
${correction ? `PREVIOUS QA FAILED. Regenerate the entire four-cell master while applying all corrections: ${correction}` : ''}`;
}

function masterQaPrompt(storyPlan, truth, continuity) {
  return jsonOnly(`VISION QA ONLY. Inspect the generated MASTER storyboard as one image and compare it against canonical references.
It must contain exactly four equal cells in Hook, Solution, Proof, Closing order. Compare the product across all four cells: it must remain the same SKU, geometry, attachment mechanism, color, accessories, environment and person. Reject a single inconsistent cell by rejecting the whole master. Use score values from 0 to 100.
Story plan: ${JSON.stringify(storyPlan)}
Product truth: ${JSON.stringify(truth)}
Continuity: ${JSON.stringify(continuity)}`, { masterQa: { scores: { productIdentity: 0, crossPanelContinuity: 0, physicalFeasibility: 0, sceneCoverage: 0, layoutCompliance: 0, noTextCompliance: 0 }, defects: [], hardRejectReasons: [], correctionPrompt: '' } });
}

function panelQaPrompt(scene, truth, continuity) {
  return jsonOnly(`VISION QA ONLY. Compare generated panel with canonical references, continuity anchor and scene specification.
List observable defects only. Hard reject wrong SKU, wrong mechanism or floating parts. Use score values from 0 to 100.
Scene: ${JSON.stringify(scene)}
Product truth: ${JSON.stringify(truth.visualIdentity)}
Continuity: ${JSON.stringify(continuity)}`, { panelQa: { scores: { productIdentity: 0, physicalFeasibility: 0, sceneIntent: 0, continuity: 0, humanAnatomy: 0, realism: 0, noTextCompliance: 0 }, defects: [], hardRejectReasons: [], correctionPrompt: '' } });
}

function clipPrompt(scene, continuity, duration, options = {}) {
  const audioRule = options.voiceStrategy === 'provider' && scene.voiceoverClaim
    ? `OFF-SCREEN VOICE-OVER: Generate a natural Vietnamese review voice reading exactly: "${scene.voiceoverClaim}". Finish within ${duration} seconds. The person remains faceless and does not visibly speak. No music.`
    : 'No generated voice, dialogue or music; audio is added in post-production.';
  return `Create one ${duration}-second vertical 9:16 photorealistic clip starting from the approved Scene ${scene.sceneNumber} image.
Preserve exact product geometry, color, material, parts, original physical mark, environment, person, outfit and lighting.
One action only: ${scene.primaryAction}. Camera motion: gentle static push-in. Complete no other action.
No product morph, extra limb, floating component, generated text, caption, UI, watermark, fake logo or visible speaking face. ${audioRule}`;
}

function clipQaPrompt(scene) {
  return jsonOnly(`VIDEO FRAME QA ONLY for Scene ${scene.sceneNumber}. Reject product morph, changed SKU/parts, impossible mechanics, anatomy errors, face exposure in faceless mode, or generated text.`, { clipQa: { score: 0, defects: [], hardRejectReasons: [], correctionPrompt: '' } });
}

module.exports = { assetAuditPrompt, clipPrompt, clipQaPrompt, coherentMasterPrompt, contactSheetPrompt, continuityPrompt, masterQaPrompt, panelPrompt, panelQaPrompt, productTruthPrompt, storyPlanPrompt };
