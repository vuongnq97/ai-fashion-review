'use strict';

/**
 * Danh mục các câu kêu gọi hành động (CTA) gắn trên giỏ hàng TikTok (anchor displayName).
 * Quy định TikTok: displayName tối đa 30 ký tự.
 * Mọi câu trong danh sách đều đảm bảo ngắn gọn (12 - 25 ký tự) và kích thích tỷ lệ click (CTR).
 */

const GENERAL_CTA_POOL = [
  'Mua ở đây nè',
  'Đang khuyến mãi ở đây',
  'Deal hot ở đây nè',
  'Săn deal tại đây',
  'Xem giá ưu đãi ở đây',
  'Mua ngay tại đây nè',
  'Bấm giỏ hàng ở đây nha',
  'Chính hãng mua ở đây',
  'Giá sốc hôm nay ở đây',
  'Ưu đãi độc quyền ở đây',
  'Chốt deal tại đây nè',
  'Săn mã giảm giá ở đây',
  'Giỏ hàng có sẵn ở đây',
  'Hàng chuẩn mua ở đây',
  'Săn sale sốc ở đây nè',
  'Đang giảm giá ở đây',
  'Mua chính hãng tại đây',
  'Xem khuyến mãi ở đây',
  'Bấm vào đây mua ngay nha',
  'Ưu đãi hời mua ở đây'
];

const FASHION_CTA_POOL = [
  'Mẫu hot mua ở đây',
  'Xem bảng size ở đây',
  'Săn mẫu xinh ở đây nè',
  'Mang siêu êm mua ở đây',
  'Form chuẩn mua ở đây',
  'Mặc tôn dáng ở đây nè',
  'Mẫu mới về ở đây nha',
  'Hàng đẹp mua ở đây',
  'Phối đồ xinh ở đây nè',
  'Chất vải xịn ở đây',
  'Giày êm chân mua ở đây',
  'Mẫu hot trend ở đây nè'
];

const BEAUTY_CTA_POOL = [
  'Chính hãng 100% ở đây',
  'Da căng bóng mua ở đây',
  'Dưỡng ẩm sâu ở đây nè',
  'Săn combo giá hời ở đây',
  'Bí quyết da đẹp ở đây',
  'Hàng chuẩn auth ở đây',
  'Trắng sáng da ở đây nè',
  'Mùi thơm lâu mua ở đây',
  'Chăm da đẹp ở đây nha',
  'Mỹ phẩm chính hãng ở đây',
  'Kem chính hãng ở đây',
  'Son màu xinh ở đây nè'
];

const TECH_CTA_POOL = [
  'Chính hãng bảo hành ở đây',
  'Đồ tiện ích mua ở đây',
  'Công nghệ mới ở đây nè',
  'Dùng cực thích ở đây',
  'Bền bỉ tiện lợi ở đây',
  'Sạc siêu nhanh ở đây',
  'Đổi trả 7 ngày ở đây',
  'Hàng chuẩn bảo hành ở đây',
  'Món đồ thông minh ở đây'
];

const HOME_CTA_POOL = [
  'Gia dụng thông minh ở đây',
  'Tiện ích mỗi ngày ở đây',
  'Nâng tầm không gian ở đây',
  'Bền đẹp tiện lợi ở đây',
  'Nhà cửa gọn gàng ở đây',
  'Chính hãng mua ở đây',
  'Đồ bếp tiện ích ở đây',
  'Bếp gọn xinh mua ở đây',
  'Tiện lợi cho nhà ở đây'
];

const FASHION_KEYWORDS = ['áo', 'quần', 'váy', 'đầm', 'giày', 'dép', 'guốc', 'túi', 'ví', 'balo', 'kính', 'thời trang', 'fashion', 'shoes', 'boots', 'sneaker', 'sandal', 'sơ mi', 'polo', 'khoác', 'hoodie'];
const BEAUTY_KEYWORDS = ['kem', 'son', 'serum', 'toner', 'da', 'mặt', 'dưỡng', 'chống nắng', 'nước hoa', 'mỹ phẩm', 'cosmetics', 'beauty', 'skincare', 'tẩy trang', 'sữa rửa mặt', 'trang điểm', 'makeup', 'phấn'];
const TECH_KEYWORDS = ['sạc', 'tai nghe', 'pin', 'đèn', 'điện thoại', 'máy tính', 'cáp', 'loa', 'gadget', 'tech', 'smart', 'thông minh', 'bluetooth', 'usb', 'cảm ứng', 'đồng hồ'];
const HOME_KEYWORDS = ['nồi', 'chảo', 'bình', 'ly', 'cốc', 'ga', 'gối', 'nệm', 'đèn ngủ', 'kệ', 'máy hút', 'gia dụng', 'nhà bếp', 'kitchen', 'home', 'appliances', 'lifestyle', 'decor'];

/**
 * Sinh prompt hướng dẫn chi tiết kèm đầy đủ các ví dụ CTA cho AI phân tích sản phẩm.
 * Đảm bảo AI tạo ra cartAnchorText khớp chính xác với nội dung và đặc tính sản phẩm.
 */
function buildCartCtaPromptGuide() {
  return `
TIÊU CHUẨN TẠO CTA GIỎ HÀNG TIKTOK (cartAnchorText):
- Bạn PHẢI tạo 1 câu kêu gọi hành động (Call To Action - CTA) ngắn gọn để gắn trực tiếp lên nút giỏ hàng TikTok (Anchor Display Name).
- BẮT BUỘC TUÂN THỦ: TỐI ĐA 30 KÝ TỰ. TUYỆT ĐỐI KHÔNG DÙNG EMOJI, ICON HOẶC KÝ HIỆU MŨI TÊN (TikTok Shop sẽ cấm/bóc giỏ hàng nếu có emoji!).
- PHÙ HỢP CHÍNH XÁC NỘI DUNG SẢN PHẨM: Câu CTA phải gắn liền với điểm bán hàng độc nhất (USP), công năng, hoặc lợi ích chính của sản phẩm vừa phân tích. Tuyệt đối KHÔNG đưa câu chung chung hoặc random không phù hợp.
- Bảng ví dụ tham khảo theo từng nhóm ngành hàng để AI lựa chọn hoặc sáng tạo tương tự:
  * Thời trang / Giày dép / Túi xách:
    - "Mang siêu êm mua ở đây"
    - "Mặc tôn dáng ở đây nè"
    - "Form chuẩn mua ở đây"
    - "Mẫu hot mua ở đây"
    - "Xem bảng size ở đây"
    - "Săn mẫu xinh ở đây nè"
    - "Chất vải xịn ở đây"
    - "Giày êm chân mua ở đây"
    - "Mẫu mới về ở đây nha"
  * Mỹ phẩm / Skincare / Làm đẹp:
    - "Da căng bóng mua ở đây"
    - "Dưỡng ẩm sâu ở đây nè"
    - "Bí quyết da đẹp ở đây"
    - "Trắng sáng da ở đây nè"
    - "Chính hãng 100% ở đây"
    - "Săn combo giá hời ở đây"
    - "Mùi thơm lâu mua ở đây"
    - "Chăm da đẹp ở đây nha"
    - "Son màu xinh ở đây nè"
  * Đồ công nghệ / Phụ kiện / Điện tử:
    - "Đồ tiện ích mua ở đây"
    - "Chính hãng bảo hành ở đây"
    - "Bền bỉ tiện lợi ở đây"
    - "Sạc siêu nhanh ở đây"
    - "Công nghệ mới ở đây nè"
    - "Đổi trả 7 ngày ở đây"
    - "Dùng cực thích ở đây"
  * Đồ gia dụng / Nhà bếp / Đời sống:
    - "Gia dụng thông minh ở đây"
    - "Tiện ích mỗi ngày ở đây"
    - "Bếp gọn xinh mua ở đây"
    - "Nâng tầm không gian ở đây"
    - "Nhà cửa gọn gàng ở đây"
    - "Đồ bếp tiện ích ở đây"
    - "Bền đẹp tiện lợi ở đây"
  * Deal hot / Ưu đãi mua sắm chung:
    - "Mua ở đây nè"
    - "Đang khuyến mãi ở đây"
    - "Deal hot ở đây nè"
    - "Săn deal tại đây"
    - "Xem giá ưu đãi ở đây"
    - "Mua ngay tại đây nè"
    - "Bấm giỏ hàng ở đây nha"
    - "Săn sale sốc ở đây nè"
    - "Ưu đãi độc quyền ở đây"
- Hãy tạo ra đúng 1 câu cartAnchorText (<= 30 ký tự, không emoji) hấp dẫn, kích thích người xem bấm mua nhất cho sản phẩm này.`.trim();
}

/**
 * Loại bỏ toàn bộ emoji, icon, ký tự mũi tên đặc biệt để tránh bị TikTok bóc giỏ hàng
 */
function cleanCartAnchorText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\u{1F600}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F300}-\u{1F5FF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}\u{2190}-\u{21FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 30);
}

/**
 * Lấy câu CTA gắn giỏ hàng TikTok. Ưu tiên text đã được AI phân tích cho sản phẩm.
 * @param {object} productInfo
 * @param {object} analysisData
 * @returns {string} Text CTA tối đa 30 ký tự
 */
function getCartAnchorText(productInfo = {}, analysisData = {}) {
  // Ưu tiên cao nhất: Text CTA do AI phân tích sản phẩm tạo ra
  const aiCta = analysisData?.cartAnchorText ||
    analysisData?.analysis?.cartAnchorText ||
    analysisData?.cartCTA ||
    productInfo?.cartAnchorText;

  if (aiCta && typeof aiCta === 'string' && aiCta.trim()) {
    const cleaned = cleanCartAnchorText(aiCta);
    if (cleaned) return cleaned;
  }

  // Fallback: Quét từ khóa để chọn từ pool phù hợp
  const category = (analysisData?.category || productInfo?.category || '').toLowerCase();
  const textToScan = [
    productInfo?.title || '',
    productInfo?.productTitle || '',
    productInfo?.productName || '',
    analysisData?.productName || '',
    analysisData?.product_name || '',
    category
  ].join(' ').toLowerCase();

  let specificPool = [];

  if (category.includes('beauty') || category.includes('cosmetic') || BEAUTY_KEYWORDS.some(k => textToScan.includes(k))) {
    specificPool = BEAUTY_CTA_POOL;
  } else if (category.includes('fashion') || category.includes('shoe') || FASHION_KEYWORDS.some(k => textToScan.includes(k))) {
    specificPool = FASHION_CTA_POOL;
  } else if (category.includes('tech') || category.includes('gadget') || TECH_KEYWORDS.some(k => textToScan.includes(k))) {
    specificPool = TECH_CTA_POOL;
  } else if (category.includes('home') || category.includes('kitchen') || category.includes('appliance') || HOME_KEYWORDS.some(k => textToScan.includes(k))) {
    specificPool = HOME_CTA_POOL;
  }

  // Kết hợp: ưu tiên ngành hàng phù hợp, xen kẽ các câu CTA chung hot deal
  const combinedPool = specificPool.length > 0
    ? [...specificPool, ...specificPool, ...GENERAL_CTA_POOL]
    : GENERAL_CTA_POOL;

  const picked = combinedPool[Math.floor(Math.random() * combinedPool.length)] || 'Mua ở đây nè';
  return cleanCartAnchorText(picked);
}

module.exports = {
  buildCartCtaPromptGuide,
  getCartAnchorText,
  cleanCartAnchorText,
  GENERAL_CTA_POOL,
  FASHION_CTA_POOL,
  BEAUTY_CTA_POOL,
  TECH_CTA_POOL,
  HOME_CTA_POOL
};
