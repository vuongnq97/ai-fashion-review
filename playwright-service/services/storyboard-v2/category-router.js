'use strict';

const CATEGORY_POLICIES = {
  fashion: { environmentType: 'fitting room, bedroom, or suitable street setting', humanMode: 'faceless_model', proof: ['fit', 'drape', 'stitching', 'zipper', 'pocket'] },
  cosmetics: { environmentType: 'clean vanity or bright bathroom', humanMode: 'hands_only', proof: ['texture', 'amount used', 'application', 'packaging'] },
  home: { environmentType: 'relevant lived-in home area', humanMode: 'hands_only', proof: ['real use', 'visible accessory', 'visible result', 'finish'] },
  kitchen: { environmentType: 'family kitchen', humanMode: 'hands_only', proof: ['real use', 'visible before and after', 'cleaning', 'accessory'] },
  technology: { environmentType: 'work desk, creator studio, or study corner', humanMode: 'hands_only', proof: ['port', 'button', 'size', 'supported interaction'] },
  bags: { environmentType: 'dressing area, cafe, hallway, or street', humanMode: 'faceless_model', proof: ['compartment', 'closure', 'visible capacity', 'styling'] },
  footwear: { environmentType: 'dressing area, hallway, or street', humanMode: 'faceless_model', proof: ['on-feet fit', 'sole', 'stitching', 'wearing action'] },
  food: { environmentType: 'dining table or kitchen', humanMode: 'hands_only', proof: ['packaging', 'texture', 'serving'] },
  sports: { environmentType: 'appropriate training or outdoor area', humanMode: 'faceless_model', proof: ['grip', 'wearing method', 'visible construction'] },
  automotive: { environmentType: 'vehicle cabin, garage, or beside the vehicle', humanMode: 'hands_only', proof: ['evidence-backed fitment', 'installation', 'visible construction'] },
  accessories: { environmentType: 'clean lifestyle setting relevant to use', humanMode: 'hands_only', proof: ['finish', 'closure', 'scale', 'styling'] },
  baby: { environmentType: 'clean nursery or family living area', humanMode: 'hands_only', proof: ['visible construction', 'supported setup', 'size', 'cleaning access'] },
  stationery: { environmentType: 'study desk, office, or craft table', humanMode: 'hands_only', proof: ['writing or organizing action', 'finish', 'visible capacity', 'supported mechanism'] },
  decor: { environmentType: 'relevant home or gifting setting', humanMode: 'none', proof: ['finish', 'scale', 'placement', 'visible construction'] },
  other: { environmentType: 'minimal real-world setting relevant to product use', humanMode: 'hands_only', proof: ['visible finish', 'simple supported use', 'visible accessory'] },
};

const ALIASES = new Map([
  ['clothing', 'fashion'], ['apparel', 'fashion'], ['thời trang', 'fashion'],
  ['beauty', 'cosmetics'], ['skincare', 'cosmetics'], ['serum', 'cosmetics'], ['mỹ phẩm', 'cosmetics'],
  ['home appliances', 'home'], ['gia dụng', 'home'], ['household', 'home'],
  ['kitchenware', 'kitchen'], ['nhà bếp', 'kitchen'],
  ['gadgets', 'technology'], ['tech', 'technology'], ['electronics', 'technology'], ['công nghệ', 'technology'],
  ['bag', 'bags'], ['handbag', 'bags'], ['túi', 'bags'],
  ['shoe', 'footwear'], ['shoes', 'footwear'], ['giày', 'footwear'],
  ['beverage', 'food'], ['fmcg', 'food'], ['thực phẩm', 'food'],
  ['sport', 'sports'], ['outdoor', 'sports'], ['thể thao', 'sports'],
  ['car', 'automotive'], ['motorbike', 'automotive'], ['ô tô', 'automotive'],
  ['mother and baby', 'baby'], ['baby care', 'baby'], ['mẹ và bé', 'baby'], ['em bé', 'baby'],
  ['office supplies', 'stationery'], ['stationery', 'stationery'], ['văn phòng phẩm', 'stationery'],
  ['home decor', 'decor'], ['gift', 'decor'], ['đồ trang trí', 'decor'], ['quà tặng', 'decor'],
]);

function normalizeCategory(value) {
  const raw = String(value || 'other').trim().toLocaleLowerCase('vi');
  if (CATEGORY_POLICIES[raw]) return raw;
  if (ALIASES.has(raw)) return ALIASES.get(raw);
  for (const [alias, category] of ALIASES) {
    if (raw.includes(alias)) return category;
  }
  return 'other';
}

function routeCategoryAndSceneTypes(productTruth, audit, config, suggested = {}) {
  const category = normalizeCategory(suggested.category || productTruth.category);
  const policy = CATEGORY_POLICIES[category];
  const configuredHuman = config.humanMode;
  const humanMode = configuredHuman && configuredHuman !== 'auto'
    ? configuredHuman
    : (suggested.humanMode || policy.humanMode);
  const detailEvidenceIds = (audit.images || [])
    .filter(image => image.roles.some(role => ['detail_view', 'mechanism_detail', 'usage_demo'].includes(role)))
    .sort((a, b) => (b.scores?.operation || 0) - (a.scores?.operation || 0))
    .map(image => image.imageId);

  return {
    category,
    humanMode,
    environmentType: suggested.environmentType || policy.environmentType,
    proofTypes: policy.proof,
    hookCandidates: Array.isArray(suggested.hookCandidates) ? suggested.hookCandidates : [],
    solutionCandidates: Array.isArray(suggested.solutionCandidates) ? suggested.solutionCandidates : [],
    proofCandidates: Array.isArray(suggested.proofCandidates) ? suggested.proofCandidates : policy.proof,
    closingCandidates: Array.isArray(suggested.closingCandidates) ? suggested.closingCandidates : [],
    selectedEvidenceIds: [...new Set([...productTruth.canonicalReferenceIds, ...detailEvidenceIds.slice(0, 2)])],
    rejectedConcepts: Array.isArray(suggested.rejectedConcepts) ? suggested.rejectedConcepts : [],
  };
}

module.exports = { CATEGORY_POLICIES, normalizeCategory, routeCategoryAndSceneTypes };
