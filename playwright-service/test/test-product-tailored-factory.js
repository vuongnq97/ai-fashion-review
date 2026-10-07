const assert = require('assert');
const path = require('path');
const {
  getFactoryPromptFragment,
  detectProductSourcingSetting,
  getProductEnvironmentBible,
  buildTemplateProductMasterPrompt,
} = require('../services/template-product-storyboard');

console.log('═══════════════════════════════════════════════════════════════════════════');
console.log('🧪 TEST: FACTORY-FIRST TAILORED ENVIRONMENTS PER PRODUCT CATEGORY');
console.log('═══════════════════════════════════════════════════════════════════════════\n');

// 1. Dép Crocs / Giày dép
const footwearCase = {
  productName: 'Dép Sục Nữ Classic Lỗ Thoáng Khí Đi Mưa Êm Chân',
  categoryKey: 'footwear_accessories',
  analysis: {
    productName: 'Dép Sục Nữ Classic Lỗ Thoáng Khí Đi Mưa Êm Chân',
    categoryKey: 'footwear_accessories',
  }
};
const footwearFragment = getFactoryPromptFragment(footwearCase);
console.log('1. Footwear factory fragment:\n  ', footwearFragment);
assert(footwearFragment.includes('footwear') || footwearFragment.includes('shoe'), 'Must be a footwear/shoe workshop');
assert(footwearFragment.includes('NO blue medical smocks'), 'Must forbid blue medical smocks');

// 2. Máy làm sữa hạt / Đồ gia dụng nhà bếp
const milkMakerCase = {
  productName: 'Máy Làm Sữa Hạt OSTMARS Cối Thuỷ Tinh 1100ml PBJ-003',
  categoryKey: 'kitchenware_foodprep',
  analysis: {
    productName: 'Máy Làm Sữa Hạt OSTMARS Cối Thuỷ Tinh 1100ml PBJ-003',
    categoryKey: 'kitchenware_foodprep',
  }
};
const milkMakerFragment = getFactoryPromptFragment(milkMakerCase);
console.log('\n2. Kitchenware / Milk maker factory fragment:\n  ', milkMakerFragment);
assert(milkMakerFragment.includes('kitchen-appliance') || milkMakerFragment.includes('testing studio'), 'Must be a kitchen appliance testing/inspection facility');
assert(milkMakerFragment.includes('NOT blue surgery gowns'), 'Must forbid blue surgery gowns');

// 3. Máy hút bụi / Gia dụng
const vacuumCase = {
  productName: 'Máy Hút Bụi Cầm Tay Không Dây Đa Năng Lực Hút Khỏe',
  categoryKey: 'home_appliances',
  analysis: {
    productName: 'Máy Hút Bụi Cầm Tay Không Dây Đa Năng Lực Hút Khỏe',
    categoryKey: 'home_appliances',
  }
};
const vacuumFragment = getFactoryPromptFragment(vacuumCase);
console.log('\n3. Home appliance / Vacuum factory fragment:\n  ', vacuumFragment);
assert(vacuumFragment.includes('home-appliance') || vacuumFragment.includes('QA/QC'), 'Must be a home appliance QA/QC facility');
assert(vacuumFragment.includes('NO blue medical smocks'), 'Must forbid blue medical smocks');

// 4. Túi xách / Phụ kiện da
const bagCase = {
  productName: 'Túi Xách Da Nữ Đeo Chéo Hàng Hiệu Chuẩn Hãng',
  categoryKey: 'footwear_accessories',
  analysis: {
    productName: 'Túi Xách Da Nữ Đeo Chéo Hàng Hiệu Chuẩn Hãng',
    categoryKey: 'footwear_accessories',
  }
};
const bagFragment = getFactoryPromptFragment(bagCase);
console.log('\n4. Bag / Leather goods factory fragment:\n  ', bagFragment);
assert(bagFragment.includes('leathercraft') || bagFragment.includes('leather goods'), 'Must be leathercraft atelier');

// 4b. Beauty / Cosmetics Factory Conveyor Belt Verification
const cosmeticsConveyorCase = {
  productName: 'Son Kem Lì Mịn Môi Kháng Nước Lâu Trôi 3CE',
  categoryKey: 'beauty_cosmetics',
  analysis: {
    productName: 'Son Kem Lì Mịn Môi Kháng Nước Lâu Trôi 3CE',
    categoryKey: 'beauty_cosmetics',
  }
};
const cosmeticsFragment = getFactoryPromptFragment(cosmeticsConveyorCase);
console.log('\n4b. Cosmetics factory conveyor belt fragment:\n  ', cosmeticsFragment);
assert(cosmeticsFragment.includes('conveyor belt line'), 'Must feature an active automated conveyor belt line');
assert(cosmeticsFragment.includes('Son Kem Lì Mịn Môi Kháng Nước Lâu Trôi 3CE'), 'Conveyor belt must carry identical units of the exact product');
assert(cosmeticsFragment.includes('NO glass partition walls'), 'Must forbid glass partition walls');
assert(cosmeticsFragment.includes('NO display vitrines on walls'), 'Must forbid display vitrines');

// 5. Master Storyboard Prompt Verification
const masterPrompt = buildTemplateProductMasterPrompt(milkMakerCase);
console.log('\n5. Verifying Master Storyboard Prompt rules:');
assert(!masterPrompt.includes('multiple background workers are visibly working on the active line'), 'Must NOT mandate multiple background workers on active line');
assert(!masterPrompt.includes('mandatory in factory_showcase'), 'Must NOT mandate factory workers');
assert(masterPrompt.includes('conveyor belt line (băng chuyền sản xuất tự động)'), 'Master prompt must mandate active conveyor belt line');
assert(masterPrompt.includes('glass partition wall'), 'Negative prompt must forbid glass partition wall');
assert(masterPrompt.includes('showroom vitrines'), 'Negative prompt must forbid showroom vitrines');
assert(masterPrompt.includes('blue medical gowns'), 'Negative prompt must forbid blue medical gowns');
assert(masterPrompt.includes('surgical hairnets'), 'Negative prompt must forbid surgical hairnets');
assert(masterPrompt.includes('PRESENTER ATTIRE & WARDROBE LOCK — EXACT OUTFIT MATCH'), 'Presenter attire must lock outfit to canonical model');
console.log('   ✅ Master prompt negative rules, conveyor belt mandate & attire wardrobe lock successfully verified');

// 6. Test Handheld vs Tabletop Product Placement in Panel 1
console.log('\n6. Verifying Panel 1 Product Focus & Handheld vs Tabletop Placement:');
const {
  isProductHandheld,
  getProductPlacementRule,
  buildTemplateProductRemakePrompt,
} = require('../services/template-product-storyboard');

// 6a. Handheld test cases
const cosmeticsCase = {
  productName: 'Son Kem Lì Mịn Môi Kháng Nước Lâu Trôi 3CE',
  categoryKey: 'beauty_personal_care',
};
assert.strictEqual(isProductHandheld(cosmeticsCase), true, 'Cosmetics/lipstick must be handheld');

const crocsCase = {
  productName: 'Dép Sục Classic Lỗ Thoáng Khí',
  categoryKey: 'footwear_accessories',
};
assert.strictEqual(isProductHandheld(crocsCase), true, 'Shoes/Crocs must be handheld');

const sprayCase = {
  productName: 'Chai Xịt Thảo Mộc Tinh Dầu Ngải Cứu Giảm Đau Nhức Xương Khớp',
  categoryKey: 'health_wellness_supplements',
};
assert.strictEqual(isProductHandheld(sprayCase), true, 'Spray bottle must be handheld');

const handheldRule = getProductPlacementRule(cosmeticsCase);
assert.strictEqual(handheldRule.isHandheld, true);
assert(handheldRule.panel1Instruction.includes('HOLDING THE PRODUCT IN HER HANDS AT CHEST LEVEL'), 'Handheld rule must require holding product at chest level');
assert(handheldRule.panel1Instruction.includes('ABSOLUTELY NO waving empty hands, NO clipboard'), 'Must forbid waving empty hands and clipboard');

// 6b. Tabletop test cases
const nutMilkCase = {
  productName: 'Máy Làm Sữa Hạt Đa Năng OSTMARS 1100ml',
  categoryKey: 'kitchenware_foodprep',
};
assert.strictEqual(isProductHandheld(nutMilkCase), false, 'Nut milk maker must be tabletop');

const airFryerCase = {
  productName: 'Nồi Chiên Không Dầu Điện Tử Dung Tích 8L',
  categoryKey: 'kitchenware_foodprep',
};
assert.strictEqual(isProductHandheld(airFryerCase), false, 'Air fryer must be tabletop');

const tabletopRule = getProductPlacementRule(nutMilkCase);
assert.strictEqual(tabletopRule.isHandheld, false);
assert(tabletopRule.panel1Instruction.includes('RESTING DIRECTLY ON THE INSPECTION/SHOWCASE TABLE IN THE IMMEDIATE CENTER FOREGROUND'), 'Tabletop rule must require resting directly on the table');

// 6c. Verify Master Prompt contains Panel 1 product-focused hook
const cosmeticsMasterPrompt = buildTemplateProductMasterPrompt(cosmeticsCase);
assert(cosmeticsMasterPrompt.includes('Panel 1 (IMMEDIATE PRODUCT-FOCUSED HOOK — CRITICAL FIRST 0.5s IMPRESSION)'), 'Panel 1 header must state product-focused hook');
assert(cosmeticsMasterPrompt.includes('waist-up medium shot (DO NOT use full-body distant shot)'), 'Panel 1 must forbid full-body distant shot');
assert(cosmeticsMasterPrompt.includes('HOLDING THE PRODUCT IN HER HANDS AT CHEST LEVEL'), 'Cosmetics master prompt must require holding in hands at chest level');
assert(cosmeticsMasterPrompt.includes('waving empty hands'), 'Negative prompt must forbid waving empty hands');
assert(cosmeticsMasterPrompt.includes('holding clipboard'), 'Negative prompt must forbid holding clipboard');

const milkMasterPrompt = buildTemplateProductMasterPrompt(nutMilkCase);
assert(milkMasterPrompt.includes('RESTING DIRECTLY ON THE INSPECTION/SHOWCASE TABLE IN THE IMMEDIATE CENTER FOREGROUND'), 'Milk maker master prompt must require table placement');

// 6d. Verify Remake Prompt for Panel 1
const remake1Handheld = buildTemplateProductRemakePrompt(cosmeticsCase, 1);
assert(remake1Handheld.includes('HOLDING THE PRODUCT IN HER HANDS AT CHEST LEVEL'), 'Remake panel 1 for handheld must require holding in hands');

const remake1Tabletop = buildTemplateProductRemakePrompt(nutMilkCase, 1);
assert(remake1Tabletop.includes('RESTING DIRECTLY ON THE INSPECTION/SHOWCASE TABLE'), 'Remake panel 1 for tabletop must require table placement');

console.log('   ✅ Panel 1 Product Focus, Handheld vs Tabletop rules, and negative prompts verified 100%');

console.log('\n═══════════════════════════════════════════════════════════════════════════');
console.log('🎉 ALL PRODUCT-TAILORED FACTORY-FIRST & PANEL 1 VERIFICATIONS PASSED 100%!');
console.log('═══════════════════════════════════════════════════════════════════════════');
