import { GoogleGenAI, Type } from "@google/genai";
import { ProductAnalysis, ScriptPanel, getGridLayout } from "../types";

let _ai: GoogleGenAI | null = null;

function getAI() {
  if (!_ai) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY environment variable is required");
    }
    _ai = new GoogleGenAI({ apiKey });
  }
  return _ai;
}

export async function analyzeProduct(
  images: string[],
  options: {
    category: string;
    useVietnameseModel: boolean;
    noTextInImage: boolean;
    styleCuonHut: boolean;
    panelCount: number;
    sceneRatio: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
    modelImage?: string | null;
  }
) {
  const ai = getAI();
  const model = "gemini-3-flash-preview";
  
  const imageParts = images.map(img => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: img.split(",")[1],
    },
  }));

  if (options.modelImage) {
    imageParts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: options.modelImage.split(",")[1],
      },
    });
  }

  const paceInstruction = options.styleCuonHut 
    ? `Phong cách Cuốn hút: 24-30 từ tiếng Việt mỗi panel (tổng ${options.panelCount * 24}-${options.panelCount * 30} từ). 
       - Sử dụng câu ngắn, gãy gọn, dễ đọc nhanh.
       - Mỗi panel chỉ tập trung vào MỘT ý tưởng thuyết phục duy nhất.
       - Hook phải trực diện, đánh vào lợi ích người mua.
       - Tránh các mệnh đề dài, tính từ lặp lại hoặc từ khó phát âm.`
    : `Phong cách Tự nhiên: 18-24 từ tiếng Việt mỗi panel (tổng ${options.panelCount * 18}-${options.panelCount * 24} từ). 
       - Giọng điệu thoải mái, rõ ràng, nhịp độ vừa phải.`;

  const systemInstruction = `Bạn là một chuyên gia phân tích thời trang và biên kịch storyboard chuyên nghiệp. 
Ngôn ngữ sử dụng: Tiếng Việt.

Nhiệm vụ:
1. Phân tích sản phẩm kỹ lưỡng từ hình ảnh (loại, chất liệu, màu sắc, điểm nổi bật, phong cách). Đặc biệt, hãy đọc các chữ/nhãn trên sản phẩm hoặc phân tích kiểu dáng để xác định chính xác đối tượng mục tiêu là NAM (male), NỮ (female) hay UNISEX.
2. Tạo kịch bản review dài khoảng ${options.panelCount * 8} giây gồm ${options.panelCount} panel (mỗi panel 8 giây).
3. Quy định về Voice-over (VO):
   ${paceInstruction}
   - Cấu trúc kịch bản tổng thể: Hook → Value → Twist → CTA.
   - Yêu cầu VO: Mở đầu cực nhanh (Hook 3 giây đầu), mỗi câu đều tạo tò mò, không lan man, giữ nhịp nhanh, dễ đọc voice.
   - Mỗi panel phải xác định mục tiêu: Hook (panel 1), Insight/Value (panels giữa), CTA (panel cuối).
4. Tạo "FRAME DATA": PHẢI mô tả chi tiết hình ảnh cho từng panel (${options.panelCount} panels). Bố cục cảnh quay trong mỗi panel PHẢI được tối ưu hóa cho tỉ lệ khung hình ${options.sceneRatio}. Mỗi mô tả panel phải bao gồm: Bối cảnh, Hành động của nhân vật, và Cách sản phẩm xuất hiện.
5. Tạo ${options.panelCount} prompt Veo 3 bằng TIẾNG VIỆT hoàn chỉnh cho từng video theo cấu trúc sau:
   "Tạo video review với giọng nhân vật nữ miền Nam, Việt nam, giọng nhẹ nhàng, dễ thương. 
   VISUAL: [Mô tả visual chi tiết, loại footage phù hợp, hiệu ứng nên dùng]. Khóa ảnh sản phẩm và nhân vật không thay đổi không biến dạng, đúng chuẩn tham chiếu 100%. 
   Tone & Mood: [Kiểu cảm xúc phù hợp, thanh lịch/năng động...]. 
   Hành động: 0s - 4s: [Mô tả camera action và movement, đặc biệt không được xuất hiện chữ trên video]. 5s - 8s: [Mô tả camera action và movement, đặc biệt không được xuất hiện chữ trên video]. 
   Script nhân vật: “[Nội dung Voice-over]”"
   Quan trọng: Mỗi prompt PHẢI nằm trên đúng 1 dòng duy nhất, tuyệt đối không có ký tự xuống dòng bên trong.

Hãy trả về kết quả dưới định dạng JSON.`;

  const prompt = `Phân tích sản phẩm và tạo storyboard ${options.panelCount} panel. Danh mục: ${options.category}.
Yêu cầu:
- Nội dung kịch bản: Phải tuân thủ Hook (3s đầu), Insight chính, CTA cuối, và cảm xúc phù hợp. Format Hook → Value → Twist → CTA.
- FRAME DATA: Mô tả trực quan cực kỳ chi tiết cho ${options.panelCount} panels ở tỉ lệ ${options.sceneRatio} để dùng cho việc sinh ảnh storyboard.
- Các prompt Veo 3: Phải bằng TIẾNG VIỆT, bao gồm Visual (footage type), Tone & Mood và Script nhân vật.
- QUAN TRỌNG: Không được có bất kỳ ký tự xuống dòng nào (\\n) bên trong mỗi chuỗi prompt Veo 3.

JSON Structure:
{
  "analysis": { ... },
  "script": [...],
  "frameData": "string (A combined description of all panels, e.g., 'Panel 1: ... Panel 2: ...')",
  "cropTemplate": "string",
  "veo3Prompts": ["list of ${options.panelCount} single-line strings"]
}`;

  console.log("--- SYSTEM INSTRUCTION ---");
  console.log(systemInstruction);
  console.log("--- USER PROMPT ---");
  console.log(prompt);

  const response = await ai.models.generateContent({
    model,
    contents: {
      parts: [...imageParts, { text: prompt }],
    },
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          analysis: {
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING },
              materials: { type: Type.STRING },
              highlights: { type: Type.ARRAY, items: { type: Type.STRING } },
              styling: { type: Type.STRING },
              uncertainties: { type: Type.STRING },
              gender: { type: Type.STRING, enum: ["male", "female", "unisex"] },
            },
            required: ["type", "materials", "highlights", "styling", "uncertainties", "gender"],
          },
          script: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.NUMBER },
                duration: { type: Type.STRING },
                voiceOver: { type: Type.STRING },
                goal: { type: Type.STRING },
                visualDescription: { type: Type.STRING },
                cameraAction: { type: Type.STRING },
              },
              required: ["id", "duration", "voiceOver", "goal", "visualDescription", "cameraAction"],
            },
          },
          frameData: { type: Type.STRING },
          cropTemplate: { type: Type.STRING },
          veo3Prompts: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["analysis", "script", "frameData", "cropTemplate", "veo3Prompts"],
      },
    },
  });

  return JSON.parse(response.text || "{}");
}

export async function generateStoryboardImage(
  result: any, 
  images: string[], 
  options: { 
    noTextInImage: boolean; 
    styleCuonHut: boolean; 
    useVietnameseModel: boolean; 
    panelCount: number;
    sceneRatio: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
    modelImage?: string | null 
  }
) {
  const ai = getAI();
  const model = "gemini-3.1-flash-image-preview";
  
  const gender = result.analysis?.gender || "unisex";
  const isMale = gender === "male";
  
  let characterDesc = "";
  if (options.useVietnameseModel) {
    characterDesc = isMale ? "a handsome young Vietnamese male model" : "a beautiful young Vietnamese female model";
  } else {
    characterDesc = isMale ? "a professional male model" : "a professional female model";
  }
  
  if (gender === "unisex") {
    characterDesc = options.useVietnameseModel ? "a young Vietnamese model" : "a professional model";
  }
    
  const modelIdentityRef = options.modelImage 
    ? "USE the provided model image as identity reference. Maintain facial identity, structure, and skin tone exactly." 
    : "";

  const [sceneW, sceneH] = options.sceneRatio.split(':').map(Number);
  const sceneAspect = sceneW / sceneH;
  
  // Calculate exact grid layout according to options.panelCount:
  const gridLayout = getGridLayout(options.panelCount);
  let gridRows = gridLayout.rows;
  let gridCols = gridLayout.cols;
  let emptyCellsCount = 0;
  let layoutDescription = "";

  if (options.panelCount === 1) {
    gridRows = 1;
    gridCols = 1;
    emptyCellsCount = 0;
    layoutDescription = `LƯỚI YÊU CẦU: 1 hàng x 1 cột (chỉ có 1 ô duy nhất). KHÔNG vẽ thêm bất kỳ ô, hàng, hay cột nào khác. Không có ô trống. Chỉ chứa đúng ô Panel S1. (Exactly 1 row and 1 column. STRICTLY NO row 2, row 3, or other cells).`;
  } else if (options.panelCount === 2) {
    gridRows = 1;
    gridCols = 2;
    emptyCellsCount = 0;
    layoutDescription = `LƯỚI YÊU CẦU: 1 hàng x 2 cột (Chỉ có 2 ô ngang bằng nhau nằm cạnh nhau). TUYỆT ĐỐI NGHIÊM CẤM vẽ thêm hàng thứ hai, hàng thứ ba, hoặc ô thứ ba. Lưới chỉ chứa đúng S1 và S2 ở hàng duy nhất. (Exactly 1 horizontal row containing 2 equal panels. DO NOT generate multiple rows or 3+ panels. S1 and S2 side-by-side).`;
  } else if (options.panelCount === 3) {
    gridRows = 1;
    gridCols = 3;
    emptyCellsCount = 0;
    layoutDescription = `LƯỚI YÊU CẦU: CHỈ ĐƯỢC PHÉP vẽ 1 hàng duy nhất gồm 3 cột (Chỉ có 3 ô nằm ngang cạnh nhau: S1 | S2 | S3). TUYỆT ĐỐI NGHIÊM CẤM vẽ thêm bất kỳ hàng hay cột nào khác bên dưới hoặc bên cạnh, không vẽ thêm hàng 2, không vẽ thêm hàng 3. Lưới chỉ chứa đúng S1, S2, S3 xếp thẳng hàng ngang từ trái qua phải. (Exactly 1 horizontal row containing 3 equal panels: S1, S2, and S3 side-by-side. STRICTLY FORBIDDEN to generate multiple rows, or extra panels. Do not repeat S1, S2, S3 anywhere).`;
  } else if (options.panelCount === 4) {
    gridRows = 2;
    gridCols = 2;
    emptyCellsCount = 0;
    layoutDescription = `LƯỚI YÊU CẦU: 2 hàng x 2 cột (Tổng cộng có đúng 4 ô bằng nhau). Sắp xếp: Hàng 1 chứa S1 | S2, Hàng 2 chứa S3 | S4. Không vẽ thêm hàng thứ 3 hoặc cột thứ 3. (Exactly 2 rows and 2 columns. Row 1 has S1 & S2. Row 2 has S3 & S4. No other rows or columns).`;
  } else if (options.panelCount === 5) {
    gridRows = 2;
    gridCols = 3;
    emptyCellsCount = 1;
    layoutDescription = `LƯỚI YÊU CẦU: 2 hàng x 3 cột (Tổng cộng có chính xác 6 ô). Sắp xếp: Hàng 1 chứa S1 | S2 | S3. Hàng 2 chứa S4 | S5 | Ô cuối cùng (Hàng 2 Cột 3) hoàn toàn TRỐNG (EMPTY).
Quản lý ô trống cuối: Ô cuối cùng của hàng thứ 2 phải được tô phẳng bởi một màu xám/trắng đơn sắc phẳng lỳ không có bất kỳ vật thể hay hình nhân vật, sản phẩm nào cả. (Exactly 2 rows and 3 columns. Row 1 has S1, S2, S3. Row 2 has S4, S5, and the last cell at Hàng 2 Cột 3 MUST be completely EMPTY, filled with a flat solid neutral gray color. No visual content or label in this empty cell).`;
  } else if (options.panelCount === 6) {
    gridRows = 2;
    gridCols = 3;
    emptyCellsCount = 0;
    layoutDescription = `LƯỚI YÊU CẦU: 2 hàng x 3 cột (Tổng cộng có đúng 6 ô chứa cảnh đầy đủ). Sắp xếp: Hàng 1 chứa S1 | S2 | S3, Hàng 2 chứa S4 | S5 | S6. Không vẽ thêm hàng hay cột thứ tư nào khác. (Exactly 2 rows and 3 columns. Row 1 has S1, S2, S3. Row 2 has S4, S5, S6. No other cells).`;
  } else if (options.panelCount === 7) {
    gridRows = 3;
    gridCols = 3;
    emptyCellsCount = 2;
    layoutDescription = `LƯỚI YÊU CẦU: 3 hàng x 3 cột (Tổng cộng có chính xác 9 ô). Sắp xếp: Hàng 1 chứa S1 | S2 | S3. Hàng 2 chứa S4 | S5 | S6. Hàng 3 chứa S7 và 2 ô cuối cùng (Hàng 3 Cột 2 và Cột 3) hoàn toàn TRỐNG (EMPTY).
Quản lý ô trống cuối: 2 ô trống cuối ở hàng thứ 3 phải có nền phẳng đơn sắc xám tối giản, tuyệt đối không vẽ nhân vật hay vật thể nào vào đó. (Exactly 3 rows and 3 columns. Row 1: S1, S2, S3. Row 2: S4, S5, S6. Row 3: S7, and the 2 other cells are completely EMPTY and painted flat solid neutral gray).`;
  } else if (options.panelCount === 8) {
    gridRows = 3;
    gridCols = 3;
    emptyCellsCount = 1;
    layoutDescription = `LƯỚI YÊU CẦU: 3 hàng x 3 cột (Tổng cộng có chính xác 9 ô). Sắp xếp: Hàng 1 chứa S1 | S2 | S3. Hàng 2 chứa S4 | S5 | S6. Hàng 3 chứa S7 | S8 và ô cuối cùng (Hàng 3 Cột 3) hoàn toàn TRỐNG (EMPTY).
Quản lý ô trống cuối: Ô trống cuối cùng ở góc dưới cùng bên phải phải giữ phẳng đơn sắc xám tối giản không có bất kỳ vẽ vời gì. (Exactly 3 rows and 3 columns. Row 1: S1, S2, S3. Row 2: S4, S5, S6. Row 3: S7, S8, and the last cell is completely EMPTY and painted flat solid neutral gray).`;
  } else if (options.panelCount === 9) {
    gridRows = 3;
    gridCols = 3;
    emptyCellsCount = 0;
    layoutDescription = `LƯỚI YÊU CẦU: 3 hàng x 3 cột (Tổng cộng có đúng 9 ô chứa cảnh đầy đủ từ S1 đến S9). Sắp xếp: Hàng 1 chứa S1 | S2 | S3. Hàng 2 chứa S4 | S5 | S6. Hàng 3 chứa S7 | S8 | S9. (Exactly 3 rows and 3 columns. S1 to S9 fully populated).`;
  }

  const combinedRatio = (gridCols / gridRows) * sceneAspect;

  const standardRatios = [
    { label: "16:9", value: 16 / 9 },
    { label: "4:3", value: 4 / 3 },
    { label: "1:1", value: 1.0 },
    { label: "3:4", value: 3 / 4 },
    { label: "9:16", value: 9 / 16 },
  ];
  const closest = standardRatios.reduce((prev, curr) => 
    Math.abs(curr.value - combinedRatio) < Math.abs(prev.value - combinedRatio) ? curr : prev
  );
  const canvasAspectRatio = closest.label;

  // Generate concrete orientation description for individual cells
  let cellOrientationDescription = "";
  if (options.sceneRatio === "9:16") {
    cellOrientationDescription = `
- CẢNH ĐỨNG DỌC ĐIỆN THOẠI (PORTRAIT 9:16): TẤT CẢ mọi ô trong lưới (gồm S1, S2, S3, v.v.) bắt buộc PHẢI là hình chữ nhật ĐỨNG (DỌC), chiều dọc lớn hơn chiều rộng ngang rất nhiều. TUYỆT ĐỐI NGHIÊM CẤM vẽ cảnh nằm ngang (landscape). Mỗi ô phải có tỷ lệ 9:16 chính xác.
- PORTRAIT ASPECT RATIO MANDATE: Since options.sceneRatio is 9:16, every single story panel in the grid MUST be oriented vertically (portrait ratio of 9:16, height is almost double the width). Strictly do NOT generate landscape (horizontal) panels under any circumstances!`;
  } else if (options.sceneRatio === "3:4") {
    cellOrientationDescription = `
- CẢNH DỌC (PORTRAIT 3:4): TẤT CẢ mọi ô trong lưới (gồm S1, S2, S3, v.v.) bắt buộc PHẢI là hình chữ nhật ĐỨNG (DỌC) tỷ lệ 3:4. TUYỆT ĐỐI NGHIÊM CẤM vẽ cảnh nằm ngang (landscape). Mỗi ô phải có tỷ lệ 3:4 chính xác.
- PORTRAIT ASPECT RATIO MANDATE: Since options.sceneRatio is 3:4, every single story panel in the grid MUST be oriented vertically (portrait ratio of 3:4, height is greater than width). No landscape or horizontal panels allowed.`;
  } else if (options.sceneRatio === "16:9") {
    cellOrientationDescription = `
- CẢNH NGANG RỘNG (LANDSCAPE 16:9): TẤT CẢ mọi ô trong lưới (gồm S1, S2, S3, v.v.) bắt buộc PHẢI là hình chữ nhật NGANG (WIDESCREEN 16:9), chiều ngang rộng gấp đôi chiều cao. TUYỆT ĐỐI NGHIÊM CẤM vẽ cảnh dọc (portrait). Mỗi ô phải có tỷ lệ 16:9 chính xác.
- LANDSCAPE ASPECT RATIO MANDATE: Since options.sceneRatio is 16:9, every single story panel in the grid MUST be oriented horizontally (landscape widescreen ratio of 16:9). No vertical panel or portrait aspect allowed.`;
  } else if (options.sceneRatio === "4:3") {
    cellOrientationDescription = `
- CẢNH NGANG (LANDSCAPE 4:3): TẤT CẢ mọi ô trong lưới (gồm S1, S2, S3, v.v.) bắt buộc PHẢI là hình chữ nhật NGANG tỷ lệ 4:3. TUYỆT ĐỐI NGHIÊM CẤM vẽ cảnh dọc (portrait). Mỗi ô phải có tỷ lệ 4:3 chính xác.
- LANDSCAPE ASPECT RATIO MANDATE: Since options.sceneRatio is 4:3, every single story panel in the grid MUST be oriented horizontally (landscape ratio 4:3). No vertical panel or portrait aspect allowed.`;
  } else {
    cellOrientationDescription = `
- CẢNH VUÔNG (SQUARE 1:1): TẤT CẢ mọi ô trong lưới (gồm S1, S2, S3, v.v.) bắt buộc PHẢI là hình VUÔNG (SQUARE 1:1), chiều ngang bằng chiều cao.
- SQUARE ASPECT RATIO MANDATE: Since options.sceneRatio is 1:1, every single story panel in the grid MUST be a perfect square.`;
  }

  // Generate concrete row-by-row mapping instructions for Imagen
  let gridLayoutMap = "";
  let panelIndexForPrompt = 1;
  for (let r = 0; r < gridRows; r++) {
    const rowCells = [];
    for (let c = 0; c < gridCols; c++) {
      if (panelIndexForPrompt <= options.panelCount) {
        const scriptItem = result.script?.[panelIndexForPrompt - 1];
        const visualDesc = scriptItem?.visualDescription || `Scene ${panelIndexForPrompt}`;
        rowCells.push(`[Ô Lưới (Hàng ${r + 1}, Cột ${c + 1}): Chứa Panel S${panelIndexForPrompt} - Nội dung vẽ: ${visualDesc}]`);
        panelIndexForPrompt++;
      } else {
        rowCells.push(`[Ô Lưới (Hàng ${r + 1}, Cột ${c + 1}): HOÀN TOÀN TRỐNG (EMPTY) - Chỉ vẽ một nền phẳng đơn sắc màu xám nhạt hoặc trắng cực kì tối giản, tuyệt đối không có nhân vật, không có sản phẩm, không có hình vẽ hay bất kỳ nhãn bối cảnh nào ở đây]`);
      }
    }
    gridLayoutMap += `- Hàng ${r + 1}: ${rowCells.join(" | ")}\n`;
  }

  const textPrompt = `Tạo một hình ảnh duy nhất đại diện cho bảng Storyboard hoàn hảo, được chia thành một ma trận ô lưới (GRID) đồng đều tuyệt đối về cả kích thước và tỷ lệ theo đúng các thông số bắt buộc sau:

====================================
THÔNG SỐ LƯỚI KHUNG HÌNH BẮT BUỘC (MANDATORY GRID COMPOSITION)
====================================
- Số lượng phân cảnh (panel) cần vẽ: CHÍNH XÁC ${options.panelCount} panels. Không vẽ dư thừa.
- Cấu trúc lưới (Grid Dimension): CHÍNH XÁC ${gridRows} hàng và ${gridCols} cột (Tổng số ô trong lưới là ${gridRows * gridCols} ô).
  * Ví dụ: Nếu yêu cầu 6 panels, lưới phải là 2 hàng x 3 cột. TUYỆT ĐỐI KHÔNG TUỲ Ý VẼ THÀNH 8 Ô HOẶC 4 HÀNG x 2 CỘT! Chỉ chấp nhận đúng ${gridRows} hàng và ${gridCols} cột.
- Chi tiết sơ đồ lưới: ${layoutDescription}

====================================
HƯỚNG KHUNG HÌNH CHO MỖI Ô (CELL PORTRAIT/LANDSCAPE MANDATE)
====================================
${cellOrientationDescription}
* QUAN TRỌNG: Hãy đảm bảo hình dạng của mỗi ô trong lưới khớp 100% với mô tả tỷ lệ ở trên. Nếu yêu cầu là cảnh đứng (portrait), tuyệt đối mọi ô trong bức ảnh kết quả phải là hình đứng dập thẳng tắp!

====================================
NGHIÊM CẤM TẠO NHIỀU HÌNH / PHÂN CẢNH TRONG MỘT Ô LƯỚI (STRICT SINGLE SHOT PER CELL)
====================================
* TUYỆT ĐỐI NGHIÊM CẤM (STRICTLY FORBIDDEN) chia nhỏ một ô lưới (panel) thành nhiều hình ảnh hoặc nhiều shot quay phụ (NO horizontal/vertical split, NO collage inside a single cell).
* Mỗi ô lưới (Panel) chỉ được chứa DUY NHẤT một bức ảnh chụp, một góc máy, một bối cảnh duy nhất (EXACTLY one single unified shot per panel). S1 là 1 hình duy nhất, S2 là 1 hình duy nhất, S3 là 1 hình duy nhất. Tuyệt đối không có chuyện chia cắt nửa trên nửa dưới hay nửa trái nửa phải để vẽ 2 bối cảnh khác nhau trong cùng một Panel!

====================================
QUY TẮC PHÂN CHIA LƯỚI ĐỒNG ĐỀU TUYỆT ĐỐI (COMPULSORY UNIFORM GRID RULES)
====================================
* Ảnh tổng thể PHẢI được thiết kế thành một GRID gồm chính xác ${gridRows} hàng và ${gridCols} cột. KHÔNG ĐƯỢC PHÉP vẽ thừa cột hay thừa hàng.
* TẤT CẢ mọi ô lưới bên trong (mỗi ô chứa một panel cảnh) PHẢI có kích thước chiều ngang và chiều dọc BẰNG NHAU TUYỆT ĐỐI (IDENTICAL WIDTH AND HEIGHT FOR EVERY CELL).
* TUYỆT ĐỐI NGHIÊM CẤM việc gộp ô, gộp hàng hay co giãn lệch kích cỡ giữa các cảnh (NO merged cells, NO large hero panels). Mỗi ô có diện tích và tỷ lệ như nhau.
* BẮT BUỘC ngăn cách các ô bằng đường viền mỏng màu trắng thẳng tắp (thin white border separators, thick 8-10px) để tạo ranh giới hoàn hảo như trang truyện tranh hoặc bảng phân cảnh chuyên nghiệp.
* Sắp xếp đúng thứ tự các panel từ trái sang phải, từ trên xuống dưới theo sơ đồ:
${gridLayoutMap}

====================================
YÊU CẦU THIẾT KẾ CHO Ô LƯỚI TRỐNG (EMPTY CELLS - BẮT BUỘC)
====================================
* Đối với các ô lưới được chỉ định là "HOÀN TOÀN TRỐNG (EMPTY)": BẮT BUỘC chỉ vẽ một màu nền phẳng đơn sắc xám nhạt trung tính hoặc xám xịt nhạt tối giản không tì vết (flat solid blank silver/gray). Tuyệt đối không vẽ bất kỳ vật thể, người mẫu, sản phẩm hay phong cảnh hay bất kỳ chữ số nào vào ô trống này. Giữ cho nó hoàn toàn trống trơn, sạch sẽ.

====================================
QUY TẮC CẤM GHI CHỮ, SỐ, NHÃN VÀ KÝ TỰ (STRICT NO TEXT, NO NUMBERS, NO LABELS)
====================================
* TUYỆT ĐỐI KHÔNG ĐƯỢC PHÉP vẽ hay viết bất kỳ chữ cái, từ ngữ, con số, nhãn dán, hay ký hiệu nào lên trên toàn bộ tấm hình (ABSOLUTELY NO TEXT, NO NUMBERS, NO LETTERS, NO LABELS anywhere on the canvas).
* KHÔNG viết chữ "S1", "S2", "S3", "Panel 1", "3 PANELS HORIZONTAL", hay bất kỳ chỉ dẫn kỹ thuật nào vào trong các ô lưới. Giữ các cảnh vẽ hoàn toàn sạch sẽ, chân thực.
* KHÔNG thêm các nhãn bán hàng, nút bấm giả như "Buy Now", "Cushioning Tech", mũi tên vẽ hướng, thông số kỹ thuật (như km/h, 16km/h), giá tiền dạng "4.944.613đ", hay bất kỳ nhãn bọc, thanh sidebar thiết kế nào.
* Tấm ảnh storyboard chỉ được phép chứa các cảnh bối cảnh chụp ảnh quảng cáo/quay phim thực tế không có bất kỳ ký tự hay UI overlay nào đè lên.

====================================
CHẤT LƯỢNG MẪU & ĐỒNG NHẤT NHÂN VẬT (CHARACTER BRANDING & IDENTITY LOCK)
====================================
* Nhân vật trong cả ${options.panelCount} panel chứa cảnh phải là cùng một người với cùng khuôn mặt, cấu trúc xương và màu da (same exact person).
${modelIdentityRef}
* Tạo hình ảnh ${characterDesc}.
* Hãy thiết kế 1 bộ trang phục (outfit) mới mẻ, cao cấp, thời thượng phù hợp với quảng cáo sản phẩm theo hình sản phẩm tham chiếu: ${result.analysis?.styling || ""}.
* QUAN TRỌNG: Chỉ thiết kế outfit mới này 1 lần duy nhất và áp dụng đồng nhất cho nhân vật trong toàn bộ tất cả các panel (same outfit consistency lock: same shirt, same pants/bottom, same colors, same style). Không được phép thay đổi quần áo hay đổi màu trang phục giữa các phân cảnh để tránh mất đồng nhất!

====================================
ĐỒNG NHẤT SẢN PHẨM KHÓA CỨNG (PRODUCT LOCK)
====================================
* Sử dụng chuẩn xác 100% kiểu mẫu sản phẩm (giày/túi/áo/máy chạy bộ,...) từ hình ảnh tham chiếu được upload.
* Giữ nguyên thiết kế bối cảnh, chất liệu bề mặt, logos, màu sắc của sản phẩm trong mọi phân cảnh mà nó xuất hiện. Không được tự ý thay đổi thiết kế sản phẩm hay sáng chế nhãn hiệu mới.

====================================
STYLE & KHÔNG GIAN BỐI CẢNH (SCENE VARIATION)
====================================
* Được phép thay đổi góc quay camera, tiêu cự, chuyển động, tư thế của nhân vật, hướng ánh sáng và hậu cảnh giữa các bối cảnh khác nhau để bám sát theo phần lời bình mô tả chi tiết ở lưới layout.
* Style hình ảnh: hyper realistic, cinematic commercial photography, premium product showcase, premium brand advertisement, ultra detailed 8K.

THỨ TỰ ƯU TIÊN SỐ 1 CHO MÔ HÌNH:
1. Mỗi panel bắt buộc phải là tỷ lệ hướng ${options.sceneRatio === "9:16" ? "đứng dọc (9:16 vertical)" : options.sceneRatio === "3:4" ? "đựng dọc (3:4)" : options.sceneRatio === "16:9" ? "nằm ngang (16:9 widescreen)" : options.sceneRatio === "4:3" ? "nằm ngang (4:3)" : "hình vuông (1:1)"}. Không được quay ngang cảnh đứng!
2. Mỗi Panel chỉ được chứa đúng 1 hình chụp phân cảnh duy nhất, KHÔNG chia cắt hay ghép nhiều hình trong cùng 1 Panel.
3. TUYỆT ĐỐI KHÔNG xuất hiện bất kỳ chữ cái, chữ viết, chữ số, nhãn, nút bấm giả hay overlay nào trên toàn bộ bức ảnh.
4. Chia ảnh tổng thành một lưới kích thước chính xác ${gridRows} hàng x ${gridCols} cột hoàn toàn đồng đều, kích cỡ bằng nhau và thẳng tắp.
5. Giữ tính đồng nhất tuyệt đối về nhân vật, gương mặt mẫu, bộ đồ mẫu mặc và mẫu mã sản phẩm gốc.`;

  console.log("--- IMAGE GENERATION PROMPT ---");
  console.log(textPrompt);

  const imageParts = images.map(img => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: img.split(",")[1],
    },
  }));

  const parts: any[] = [
    ...imageParts,
    { text: textPrompt },
  ];

  if (options.modelImage) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: options.modelImage.split(",")[1],
      },
    });
  }

  const response = await ai.models.generateContent({
    model,
    contents: { parts },
    config: {
      imageConfig: {
        aspectRatio: canvasAspectRatio as any,
        imageSize: "1K",
      },
    },
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  
  throw new Error("Không thể tạo hình ảnh storyboard.");
}

export async function generateScenePanel(
  storyboardImageUrl: string,
  panelIndex: number,
  sceneDescription: string,
  result: any,
  options: {
    category: string;
    useVietnameseModel: boolean;
    noTextInImage: boolean;
    sceneRatio: "9:16" | "16:9" | "1:1" | "4:3" | "3:4";
    modelImage?: string | null;
  }
) {
  const ai = getAI();
  const model = "gemini-3.1-flash-image-preview";
  
  const gender = result.analysis.gender;
  const isMale = gender === "male";
  
  let characterDesc = "";
  if (options.useVietnameseModel) {
    characterDesc = isMale ? "a handsome young Vietnamese male model" : "a beautiful young Vietnamese female model";
  } else {
    characterDesc = isMale ? "a professional male model" : "a professional female model";
  }
  
  if (gender === "unisex") {
    characterDesc = options.useVietnameseModel ? "a young Vietnamese model" : "a professional model";
  }

  const textPrompt = `TÁCH VÀ NÂNG CẤP ĐƠN PANEL TỪ STORYBOARD CANVAS KHÁCH HÀNG CUNG CẤP

Dữ liệu đầu vào:
- Bạn nhận được một ảnh storyboard tổng thể (canvas) làm tài liệu tham chiếu gốc.
- Chúng tôi cần bạn vẽ lại phân cảnh thứ ${panelIndex + 1} thành một bức ảnh đơn lẻ đẹp, chất lượng cao, độ phân giải sắc nét.

Mô tả phân cảnh cụ thể cần vẽ lại:
* Bối cảnh và hành động: ${sceneDescription}
* Sản phẩm và phong cách: ${result.analysis?.styling || ""}
* Nhân vật: ${characterDesc}

CÁC QUY TẮC BẮT BUỘC:
1. TUYỆT ĐỐI KHÔNG GHI CHỮ SỐ (ABSOLUTELY NO TEXT / NO NUMBERS): Hãy vẽ một bức ảnh sạch sẽ 100%, tuyệt đối không có bất kỳ chữ viết, con số, nhãn dán, nhãn bọc, tên thương hiệu giả, nút bấm giả (như Buy Now), thông số, giá tiền hay ký tự nào đè lên ảnh.
2. DUY NHẤT MỘT KHUNG HÌNH (STRICTLY ONE SHOT): Tuyệt đối không chia phân cảnh thành nhiều hình nhỏ hoặc khung split screen bên trong. Giữ đúng 1 góc máy duy nhất.
3. ĐỒNG NHẤT KHUÔN MẶT VÀ CHI TIẾT GỐC: Giữ nguyên các chi tiết bối cảnh, tư thế của nhân vật, bộ trang phục và màu sắc quần áo, nét mặt và mẫu thiết kế sản phẩm chính xác như phân vùng của phân cảnh này trong storyboard mẫu đi kèm. Tuyệt đối không thay đổi kiểu tóc hoặc đổi màu trang phục.
4. ĐÚNG TỶ LỆ KHUNG HÌNH YÊU CẦU: Vẽ lại ảnh này chính xác theo tỉ lệ: ${options.sceneRatio} (độ rộng:chiều cao). Bạn có thể mở rộng nhẹ phần nền hoặc dịch chuyển nhẹ bố cục cho vừa khớp tỉ lệ khung dọc/ngang mà không làm méo hình hay mất nét gốc.

STYLE:
* hyper realistic, photorealistic, cinematic lighting, ultra-detailed TikTok shop fashion commercial photography.
`;

  const parts: any[] = [
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: storyboardImageUrl.split(",")[1],
      }
    },
    { text: textPrompt }
  ];

  if (options.modelImage) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: options.modelImage.split(",")[1],
      }
    });
  }

  const response = await ai.models.generateContent({
    model,
    contents: { parts },
    config: {
      imageConfig: {
        aspectRatio: options.sceneRatio as any,
        imageSize: "1K",
      },
    },
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  
  throw new Error(`Không thể tách độc lập panel ${panelIndex + 1}.`);
}
