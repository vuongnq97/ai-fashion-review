import argparse
import asyncio
import base64
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

PANEL_MAX_RETRIES = int(os.environ.get("GEMINI_WEBAPI_PANEL_MAX_RETRIES", "3"))
PANEL_RETRY_DELAY = float(os.environ.get("GEMINI_WEBAPI_PANEL_RETRY_DELAY", "5"))

from gemini_webapi import GeminiClient, set_log_level


def log(message: str) -> None:
    print(f"[GeminiWebAPI] {message}", file=sys.stderr, flush=True)


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} environment variable is required")
    return value


def safe_name(value: str, fallback: str) -> str:
    stem = Path(value or fallback).stem or fallback
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", stem).strip(".-")
    return stem or fallback


def image_ext(mime_type: str) -> str:
    value = str(mime_type or "").lower()
    if "webp" in value:
        return ".webp"
    if "gif" in value:
        return ".gif"
    return ".jpg" if "jpeg" in value or "jpg" in value else ".png"


def strip_code_fence(text: str) -> str:
    cleaned = (text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    return cleaned.strip()


def parse_json_object(text: str) -> Dict[str, Any]:
    cleaned = strip_code_fence(text)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start >= 0 and end > start:
            return json.loads(cleaned[start : end + 1])
        raise


def normalize_prompt(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_template1_video_prompt(value: Any) -> str:
    prompt = normalize_prompt(value)
    prompt = re.sub(
        r"Script\s+nh[aâ]n\s+v[aậ]t\s*:[^.。]*(?:[.。]|$)",
        "Không có voice-over, không lời thoại, không phụ đề. ",
        prompt,
        flags=re.I,
    )
    prompt = re.sub(
        r"gi[oọ]ng\s+nh[aâ]n\s+v[aậ]t[^.。]*(?:[.。]|$)",
        "",
        prompt,
        flags=re.I,
    )
    if "Không có voice-over" not in prompt:
        prompt = f"{prompt} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
    return normalize_prompt(prompt)


def normalize_hashtag(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    tag = raw if raw.startswith("#") else f"#{raw}"
    tag = re.sub(r"\s+", "", tag)
    tag = re.sub(r"[^\w#]", "", tag, flags=re.UNICODE)
    tag = re.sub(r"^#+", "#", tag)
    return tag


def slug_to_hashtag(value: Any) -> str:
    raw = str(value or "")
    raw = raw.replace("đ", "d").replace("Đ", "D")
    raw = re.sub(r"[^a-zA-Z0-9]+", "", raw)
    return f"#{raw}" if raw else ""


def normalize_product_metadata(analysis: Any, category: str) -> Dict[str, Any]:
    source = analysis if isinstance(analysis, dict) else {}
    product_name = normalize_prompt(
        source.get("productName")
        or source.get("product_name")
        or source.get("name")
        or category
        or "San pham thoi trang"
    )
    provided_tags = source.get("hashtags") if isinstance(source.get("hashtags"), list) else []
    fallback_tags = [
        product_name,
        category or "Fashion product",
        source.get("type"),
        "thoi trang",
        "review san pham",
        "fashion review",
    ]

    hashtags: List[str] = []
    for value in [*provided_tags, *fallback_tags]:
        normalized = normalize_hashtag(value) or slug_to_hashtag(value)
        if normalized and normalized.lower() not in {tag.lower() for tag in hashtags}:
            hashtags.append(normalized)
        if len(hashtags) == 5:
            break

    while len(hashtags) < 5:
        hashtags.append(f"#sanpham{len(hashtags) + 1}")

    return {"productName": product_name, "hashtags": hashtags}


def template_name(options: Dict[str, Any]) -> str:
    return str(
        options.get("template")
        or options.get("storyboardTemplate")
        or options.get("promptTemplate")
        or ""
    ).strip().lower()


def is_template1(options: Dict[str, Any]) -> bool:
    return template_name(options) == "template1"


def is_template3(options: Dict[str, Any]) -> bool:
    return template_name(options) == "template3"


def resolve_panel_count(options: Dict[str, Any]) -> int:
    if is_template1(options) or is_template3(options):
        return 2
    return int(options.get("panelCount") or 3)


def format_product_context(options: Dict[str, Any]) -> str:
    ctx = options.get("productContext") if isinstance(options.get("productContext"), dict) else {}
    lines: List[str] = []
    if ctx.get("productTitle"):
        lines.append(f"Product title: {ctx.get('productTitle')}")
    if ctx.get("productId"):
        lines.append(f"Product ID: {ctx.get('productId')}")
    if ctx.get("productUrl"):
        lines.append(f"Product URL: {ctx.get('productUrl')}")
    if ctx.get("productDescription"):
        lines.append(f"Product description from TikTok Shop:\n{ctx.get('productDescription')}")
    if not lines:
        return ""
    return "\nTikTok Shop source metadata:\n" + "\n".join(lines) + "\nPrefer this metadata when it is more specific than image OCR.\n"


TEMPLATE3_REALISM_FULL = """
Photography style: authentic faceless footwear shop review captured with a normal smartphone camera, not a studio advertisement, not a 3D render, not AI-looking product art.
Smartphone camera: main 1x lens 24-28mm equivalent, vertical 9:16, auto mode, tiny hand shake, slight white-balance drift from mixed shop lighting, minor edge softness, faint sensor noise, no fake bokeh, no artificial blur.
Footwear shop setting: real shoe/sandal shop interior with shelves, shoe boxes, display stands, tiled or laminate floor, counter/table edge, everyday retail details; not home, bedroom, cafe, beach, street, or studio.
Material realism: preserve exact visible product material, color, silhouette, sole, straps/laces, logo/text, charms, pattern, stitching, proportions; show texture, weave, grain, seams, small scuffs, dust specks, fingerprints, contact shadows.
Human realism: hands/feet show pores, knuckle creases, light veins, natural skin tone variation, correct anatomy, no extra fingers, no doll-like skin.
Negative prompt: CGI look, plastic toy finish, waxy skin, fake bokeh, studio lighting setup, pastel Instagram filter, watermark, TikTok UI, captions, added text, floating product, warped sole, mismatched pair.
""".strip()


TEMPLATE3_DISPLAY_STAND_RULES = """
Template3 display support rules:
- First check whether the uploaded product reference images clearly include a shoe box or branded box that belongs with the product.
- If a matching shoe box is visible, Panel 1 may place the stationary shoe on that box.
- If no shoe box is visible, use uploaded reference asset "giadegiay-display-stand-reference.webp" only as a shoe display stand prop for the stationary shoe.
- The display stand reference is NOT the product. Never copy its shape, color, material, or details onto the footwear.
- The hand-held shoe and stationary shoe must always be the uploaded Telegram product pair with identical design, size, color, material, sole, strap/lace, logo/text, charm, pattern, stitching, and proportions.
""".strip()


TEMPLATE3_SHOP_BACKGROUND_RULES = """
Template3 shoe shop background reference rules:
- Use the uploaded reference asset named "shopgiay-background-reference.png" as the primary visual reference for the footwear shop environment, shelf style, retail mood, floor/display logic, and lighting consistency for this channel.
- The shop reference is a background/context reference only. It is NOT the product, NOT a product box, and NOT a foreground prop.
- Both storyboard panels should feel like they were shot in the same shop from this reference: coherent shelves, shoe displays, floor/counter surfaces, retail density, and mixed shop lighting.
- The shop background must remain secondary and clean; do not let shelves, boxes, signs, people, or props cover or compete with the footwear product.
- Do not copy any watermark, logo, signage text, UI, price tag, or readable store text from the shop reference into the generated image.
""".strip()


TEMPLATE3_PANEL1_HANDHELD_COMPOSITION = """
Template3 Panel 1 hand-held composition rules:
- One shoe/sandal is held in the foreground and must occupy the largest visual area in the frame, approximately 55-70% of the panel height.
- The matching other shoe/sandal stays in the background or below the held product, smaller but still fully visible with the complete form, toe/front, heel/back, side silhouette, and sole edge readable.
- The hand pose must match a real product review grip: the hand holds the product firmly at the outsole/sole edge and side body, with fingers supporting under or along the sole and the thumb stabilizing the side/upper edge.
- The hand must NOT pinch only the toe, hold only the heel, cover the laces/straps/logo/front design, flatten the product, or hide the top surface.
- The held product is tilted about 15-30 degrees, so the camera sees both the top/upper surface and one side/sole edge in the same frame.
- The top/upper, laces/straps, toe/front, side body, and a portion of the sole edge must be visible at once.
- Camera stays top-down product-review style. Do not switch to horizontal side view, low-angle, orbit, complex rotation, or face/body shot.
- Only the hand and wrist/forearm may appear when needed; no face, no full body.
- Any prop base such as a shoe box, table, chair surface, shelf surface, or display stand must remain clean, secondary, and not compete with the product.
""".strip()


TEMPLATE3_PANEL2_SOCK_RULES = """
Template3 Panel 2 footwear/sock rules:
- If the product is a closed-toe shoe such as sneaker, trainer, loafer, oxford, derby, boot, or other enclosed footwear, the wearer MUST wear appropriate clean socks for a realistic shop try-on. Choose low-cut, no-show, ankle, or crew socks based on the shoe style and outfit.
- Socks should look natural with fabric texture, slight wrinkles, and realistic compression at the ankle or shoe opening. Avoid pure plastic-white socks unless the outfit truly calls for it.
- If the product is open footwear such as sandal, slide, slipper, flip-flop, open-toe mule, or casual dép, the wearer should normally be barefoot with natural feet and toes. Do not add socks unless the product reference or styling clearly supports socks.
- The socks or bare feet must support the product and must not hide important straps, upper details, logo/text, or silhouette.
""".strip()


TEMPLATE3_PANEL1_CHOREOGRAPHY = """
Hành động:
0.0s-0.7s: Bàn tay đưa nhanh một chiếc giày/dép từ mép khung hình vào trung tâm, nâng lên phía trên chiếc còn lại đang đặt cố định. Mặt trước hoặc mặt trên hướng rõ vào camera và được giữ ngắn trong một nhịp.
0.7s-1.7s: Xoay cổ tay dứt khoát từ mặt trên sang góc ba phần tư rồi sang mặt bên để khoe thân sản phẩm, quai/dây, độ dày đế và silhouette.
1.7s-3.1s: Lật sản phẩm để toàn bộ mặt đế hướng thẳng vào camera. Đưa mặt đế gần máy hơn một chút và giữ ổn định khoảng 0.6-0.8 giây để nhìn rõ rãnh đế, logo/chữ và kết cấu.
3.1s-4.2s: Xoay nhanh từ mặt đế qua phần gót rồi sang mặt bên đối diện, giới thiệu độ cao gót, mép đế và đường cong sản phẩm bằng một chuyển động liên tục có kiểm soát.
4.2s-5.8s: Đưa sản phẩm nhanh về gần ống kính, đồng thời xoay về góc ba phần tư mặt trước. Kết thúc bằng một cận cảnh rõ nét phần thiết kế nổi bật như quai/dây, charm, họa tiết, logo hoặc phần mũi.
5.8s-7.0s: Kéo sản phẩm lùi ra xa, xoay về mặt trên và đưa về bên cạnh chiếc còn lại. Cả hai chiếc xuất hiện đầy đủ, đúng kích thước và không chồng méo lên nhau.
7.0s-8.0s: Nghiêng chiếc đang cầm khoảng 20-30 độ để vừa thấy mặt trên vừa thấy cạnh đế. Giữ pose kết thúc chắc chắn trong 1 giây.
Nhịp chuyển động: Nhanh, dứt khoát, có chủ đích. Mỗi lần xoay phải kết thúc rõ ràng trước khi chuyển sang góc tiếp theo. Không xoay chậm đều, không rung lắc ngẫu nhiên, không làm sản phẩm mềm, méo hoặc biến hình.
""".strip()


TEMPLATE1_PANEL2_CHOREOGRAPHY = """
Hành động: Các chuyển động phải dứt khoát, rõ biên độ, liên tục theo nhịp nhanh, có chủ đích; không chậm rãi, không lắc nhẹ mơ hồ, không chuyển động mềm kiểu slow motion.
0s-2s: Giữ nguyên bố cục POV top-down. Cả hai bàn chân đồng thời xoay mũi chân nhanh ra ngoài, lập tức thu vào trong, sau đó bật trở lại tư thế song song. Vị trí đứng cơ bản không thay đổi.
2s-4s: Hai chân luân phiên nhấc gót nhanh và rõ biên độ, mũi chân vẫn chạm sàn; chân trái thực hiện trước, tiếp nối ngay bằng chân phải. Sau đó cả hai chân đồng thời nhón gót một nhịp ngắn rồi hạ xuống dứt khoát.
4s-6s: Cả hai bàn chân nghiêng nhanh ra ngoài rồi bật trở lại, tiếp tục xoay chéo hai mũi chân sang hai hướng khác nhau để khoe mặt bên, quai/dây, charm, đế và silhouette.
6s-8s: Một chân xoay chéo khoảng 20-30 độ, chân còn lại giữ thẳng; cả hai chân nhón nhẹ một nhịp cuối rồi hạ xuống ngay, sau đó snap vào một pose kết thúc tự tin và giữ yên khoảng 1 giây.
Tuyệt đối không walking, không stepping forward, không đổi vị trí trong không gian, không nhảy, không low-angle, không tracking shot, không đổi bối cảnh, không đổi ánh sáng, không slow motion.
""".strip()


def build_analysis_prompt(options: Dict[str, Any]) -> str:
    panel_count = resolve_panel_count(options)
    scene_ratio = options.get("sceneRatio") or options.get("aspectRatio") or "9:16"
    category = options.get("category") or "Fashion product"
    vietnamese_model = bool(options.get("useVietnameseModel", True))
    style_fast = bool(options.get("styleCuonHut", True))
    product_context = format_product_context(options)

    if is_template1(options):
        return f"""
TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior footwear product analyst, faceless commercial storyboard director, and Veo 3 prompt writer.
Analyze the uploaded footwear product reference images and create a reusable faceless review storyboard as JSON text only.
{product_context}

Requirements:
- Template: template1 faceless footwear review.
- Category: {category}
- Panel count: exactly 2.
- Scene ratio for each panel: {scene_ratio}.
- Use the uploaded product analysis/reference images as the source of truth for product type, color, material, sole, straps/laces, logo/text, silhouette, and styling.
- Randomly choose ONE coherent real-world setting and ONE time of day for the whole storyboard. The setting can be indoor or outdoor, day or night, but it must be suitable for the product.
- Randomly choose ONE outfit styling direction for the faceless wearer in Panel 2. The outfit must fit the product, gender/styling inference, selected location, time of day, weather/season cues, and color palette.
- Do not hardcode a default outfit such as cream/beige wide pants. Use a different suitable outfit when the product and context call for it.
- Both panels must share the exact same setting, time of day, weather/season cues, surface, background logic, color palette, and lighting plan.
- Lighting must be physically consistent with the chosen setting and time of day.
- Faceless only: no visible faces, no talking host, no presenter. You may show hands, feet, lower legs, or cropped body parts only when useful.
- Panel 1 composition is mandatory: a beautiful feminine hand holds ONE sandal close to camera in the foreground, with the other sandal visible behind in the same setting. The hand must look elegant and realistic: fair/clean skin, natural feminine pose, neat glossy nude/pink manicure, correct anatomy, no extra fingers.
- Panel 2 composition is mandatory: top-down POV / first-person camera from above, looking at the wearer's feet and sandals while the wearer is sitting still or standing still in one place. No walking, no stepping forward, no low-angle shot, no tracking shot, no body movement through space.
- Panel 2 can include only small stationary foot gestures such as toe wiggle, slight ankle tilt, heel lift, or settling pose. The feet must remain in the same spot.
- No voice-over, no dialogue, no subtitles, no captions, no UI, no price, no rating, no watermark.
- Product identity must remain consistent across both panels.
- Do not ask follow-up questions.
- Return ONLY valid JSON. No markdown, no commentary.
- If you are unable to inspect the images, still return the JSON schema with best-effort assumptions. Never mention image quota, limits, usage, or settings.

JSON schema:
{{
  "analysis": {{
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "footwear type such as sneaker, sandal, mule, loafer, boot",
    "materials": "visible material and construction details",
    "highlights": ["string"],
    "styling": "who/where this footwear fits",
    "uncertainties": "visible limits or details that cannot be confirmed",
    "gender": "male|female|unisex"
  }},
  "sceneContext": {{
    "location": "one random shared location for both panels",
    "timeOfDay": "random shared time of day",
    "lighting": "lighting that matches the location and time",
    "mood": "commercial mood",
    "continuityRules": "how both panels keep the same setting and lighting"
  }},
  "outfitPlan": {{
    "styleDirection": "random outfit style that fits the product and setting",
    "visibleGarments": "only the visible cropped garments/body parts, no face",
    "colorPalette": "outfit colors that complement the footwear without copying one fixed default",
    "fitReason": "why this outfit fits the product, setting, and target wearer"
  }},
  "script": [
    {{
      "id": 1,
      "duration": "00:00-00:08",
      "goal": "Handheld hero detail",
      "visualDescription": "beautiful feminine hand holding one sandal close to camera, second sandal behind, same shared setting",
      "cameraAction": "close-up front angle, subtle handheld product showcase",
      "productFocus": "insole, upper, charms/details, strap, sole, product shape"
    }},
    {{
      "id": 2,
      "duration": "00:08-00:16",
      "goal": "Stationary POV on-foot proof",
      "visualDescription": "top-down first-person POV, wearer sitting still or standing still in one place, sandals on feet, same shared setting",
      "cameraAction": "stationary top-down POV with only tiny handheld drift, no walking/tracking",
      "productFocus": "on-foot shape, charms/details, outfit pairing, comfort impression"
    }}
  ],
  "frameData": "Combined detailed visual plan for exactly 2 panels, including the shared sceneContext.",
  "cropTemplate": "How to extract each panel cleanly while preserving the shared setting, lighting, and product identity.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1 without voice-over",
    "One single-line Vietnamese Veo 3 prompt for panel 2 without voice-over"
  ]
}}

Important:
- Do not include a voiceOver field anywhere in the JSON.
- "script" and "veo3Prompts" must contain exactly 2 items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood, Hanh dong 0s-4s and 5s-8s.
- Each veo3 prompt must explicitly say: "Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
- Panel 1 must introduce the footwear with a beautiful female hand holding one sandal close to camera; the other sandal stays behind for depth.
- Panel 2 must be top-down POV from above, with the wearer sitting still or standing still in one place; do not write walking, stepping forward, low-angle, or tracking movement.
""".strip()

    if is_template3(options):
        return f"""
TEXT-ONLY TASK. Do not generate images. Do not call image generation. Do not create a visual storyboard asset.
You are a senior footwear product analyst, faceless shop-review storyboard director, and Veo 3 prompt writer.
Analyze ONLY the uploaded footwear product reference images as the product source of truth, then create a reusable template3 storyboard as JSON text only.
{product_context}

IMPORTANT — VISUAL REALISM DIRECTION:
{TEMPLATE3_REALISM_FULL}

IMPORTANT — DISPLAY SUPPORT RULE:
{TEMPLATE3_DISPLAY_STAND_RULES}

IMPORTANT — SHOE SHOP BACKGROUND REFERENCE:
{TEMPLATE3_SHOP_BACKGROUND_RULES}

IMPORTANT — PANEL 1 HANDHELD COMPOSITION:
{TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}

IMPORTANT — PANEL 2 SOCK / BAREFOOT LOGIC:
{TEMPLATE3_PANEL2_SOCK_RULES}

Requirements:
- Template: template3 faceless footwear shop top-down review.
- Category: {category}
- Panel count: exactly 2.
- Scene ratio for each panel: {scene_ratio}.
- Use "shopgiay-background-reference.png" as the shared footwear shop background/style reference for both panels, while keeping the uploaded footwear product as the only product identity source.
- Scene context must be a real footwear shop / shoe store interior. Do not choose a home, bedroom, living room, cafe, beach, street, or studio.
- Both panels must share the exact same shop setting, time of day, surface/floor logic, background shelves, color palette, mood, and lighting plan.
- Panel 1 is mandatory: top-down smartphone camera from above, almost fixed; one shoe/sandal is held by a realistic hand/forearm for product rotation, and the matching other shoe/sandal stays stationary below/on the product base.
- Panel 1 hand pose is mandatory: the hand grips the product firmly at the sole edge and side body, fingers supporting the outsole/side, thumb stabilizing the upper/side edge; the held product is tilted 15-30 degrees so the top/upper, toe/front, straps/laces, side body, and part of the sole edge are all visible.
- Panel 1 foreground/background scale is mandatory: the held product in hand is larger and dominant in the foreground; the matching other product is smaller in the background/below but fully visible and not blocked.
- Panel 1 product base rule: if product reference images clearly show a matching shoe box, use that box; otherwise use the display stand reference asset named "giadegiay-display-stand-reference.webp" for the stationary shoe.
- Panel 2 is mandatory: template1-style top-down POV / first-person camera from above looking at the wearer trying the footwear on feet in the same footwear shop, sitting still or standing still in one place.
- Panel 2 sock logic is mandatory: if the analyzed product type is sneaker/shoe/loafer/boot/closed-toe footwear, the wearer must wear appropriate socks; if it is sandal/slide/slipper/open-toe dép, the wearer should normally be barefoot.
- No voice-over, no dialogue, no subtitles, no captions, no UI, no price, no rating, no watermark.
- Do not add text. Preserve only real existing product logo/text from the product reference if visible.
- Product identity must remain consistent across both panels.
- Return ONLY valid JSON. No markdown, no commentary.

JSON schema:
{{
  "analysis": {{
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "footwear type",
    "materials": "visible material, texture, stitching, outsole, logo/text",
    "highlights": ["string"],
    "styling": "who/where this footwear fits",
    "uncertainties": "visible limits or details that cannot be confirmed",
    "gender": "male|female|unisex",
    "hasVisibleShoeBox": true,
    "shoeBoxEvidence": "what visible product box/packaging was detected, or 'not visible'"
  }},
  "sceneContext": {{
    "location": "one random shared FOOTWEAR SHOP location for both panels",
    "timeOfDay": "random shared shop time/lighting condition",
    "lighting": "mixed shop/store lighting plan with realistic shadows and no studio look",
    "mood": "authentic, fast, commercial shop review",
    "cameraCharacteristics": "smartphone 1x lens 24-28mm, Auto mode, top-down/POV, slight hand shake, no fake bokeh",
    "continuityRules": "how both panels keep the same shop setting, lighting, shelf/floor logic, and product identity"
  }},
  "productSupportPlan": {{
    "panel1StationaryBase": "use visible matching shoe box from reference OR use giadegiay-display-stand-reference.webp if no box is visible",
    "reason": "why this support choice was selected from product references",
    "propSafety": "display stand is a prop only; product remains exactly the Telegram uploaded footwear"
  }},
  "outfitPlan": {{
    "styleDirection": "random outfit style that fits the product and shoe-shop try-on context",
    "visibleGarments": "only visible cropped garments/body parts, no face",
    "colorPalette": "outfit colors that complement the footwear",
    "fitReason": "why this outfit fits the product, shop setting, and target wearer"
  }},
  "script": [
    {{
      "id": 1,
      "duration": "00:00-00:08",
      "goal": "Top-down hand rotation hero review",
      "visualDescription": "top-down smartphone shop-review layout: one shoe/sandal held large in the foreground by a realistic hand gripping the sole edge and side body, tilted 15-30 degrees so the top/upper, toe/front, straps/laces, side body, and part of the sole edge are visible; the matching stationary shoe stays smaller below/background on the product base but fully visible; footwear shop shelves/floor visible around the surface",
      "cameraAction": "almost fixed top-down smartphone camera; movement comes from the hand: lift, wrist rotation, sole flip, close push-in, return to pair",
      "productFocus": "upper/top, side silhouette, sole tread, heel/edge, straps/laces, logo/text, charm/pattern/stitching, material texture"
    }},
    {{
      "id": 2,
      "duration": "00:08-00:16",
      "goal": "Stationary POV on-foot proof in shop",
      "visualDescription": "top-down first-person POV in the same footwear shop, wearer trying the product on feet while sitting or standing still in one place; if the product is a closed shoe/sneaker/loafer/boot the wearer has appropriate socks, if open sandal/slide/slipper/dép then barefoot",
      "cameraAction": "stationary top-down POV with only tiny handheld drift and a short push-in; no walking, no tracking",
      "productFocus": "on-foot shape, fit, detail visibility, outsole thickness, outfit pairing, realistic try-on value"
    }}
  ],
  "frameData": "Combined detailed visual plan for exactly 2 panels.",
  "cropTemplate": "How to extract each panel cleanly while preserving the shop setting, top-down/POV composition, product support, lighting, and product identity.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1 without voice-over, exactly 8 seconds, using the mandatory choreography.",
    "One single-line Vietnamese Veo 3 prompt for panel 2 without voice-over, exactly 8 seconds, template1-style POV on-foot proof."
  ]
}}

Important:
- Do not include a voiceOver field anywhere in the JSON.
- "script" and "veo3Prompts" must contain exactly 2 items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood.
- Each veo3 prompt must explicitly say: "Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
- Each veo3 prompt must include realism cues: "quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay/chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI."
- Panel 1 veo3 prompt MUST use this exact action choreography:
{TEMPLATE3_PANEL1_CHOREOGRAPHY}
- Panel 1 storyboard and panel image prompts MUST follow this hand-held composition exactly:
{TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}
- Panel 2 storyboard and video prompts MUST follow this footwear/sock rule:
{TEMPLATE3_PANEL2_SOCK_RULES}
- Panel 2 veo3 prompt MUST use this stationary POV choreography:
{TEMPLATE1_PANEL2_CHOREOGRAPHY}
""".strip()

    model_line = (
        "Use a young Vietnamese model when a human model is needed."
        if vietnamese_model
        else "Use a professional fashion model when a human model is needed."
    )
    pace_line = (
        "Voice-over must be short, punchy, curiosity-driven, 24-30 Vietnamese words per panel."
        if style_fast
        else "Voice-over must feel natural, clear, 18-24 Vietnamese words per panel."
    )

    return f"""
You are a senior fashion product analyst, storyboard director, and Veo 3 prompt writer.
Analyze the uploaded product images and create a short Vietnamese review storyboard.
{product_context}

Requirements:
- Category: {category}
- Panel count: exactly {panel_count}
- Scene ratio for each panel: {scene_ratio}
- {model_line}
- {pace_line}
- Product identity must remain consistent across all panels.
- Do not ask follow-up questions.
- Return ONLY valid JSON. No markdown, no commentary.

JSON schema:
{{
  "analysis": {{
    "productName": "Vietnamese product name inferred from the images",
    "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3", "#hashtag4", "#hashtag5"],
    "type": "string",
    "materials": "string",
    "highlights": ["string"],
    "styling": "string",
    "uncertainties": "string",
    "gender": "male|female|unisex"
  }},
  "script": [
    {{
      "id": 1,
      "duration": "00:00-00:08",
      "voiceOver": "Vietnamese voice-over",
      "goal": "Hook|Value|Twist|CTA",
      "visualDescription": "detailed visual",
      "cameraAction": "detailed camera movement"
    }}
  ],
  "frameData": "Combined detailed visual plan for all panels.",
  "cropTemplate": "How to crop/extract each panel cleanly.",
  "veo3Prompts": [
    "One single-line Vietnamese Veo 3 prompt for panel 1"
  ]
}}

Important:
- Infer "analysis.productName" from visible product information, product type, design, and labels/text in the images.
- Extract existing hashtags from the images if visible. If fewer than 5 are visible, add relevant Vietnamese/TikTok-friendly fashion hashtags until there are exactly 5.
- "analysis.hashtags" must contain exactly 5 unique hashtags, each starting with "#".
- "script" and "veo3Prompts" must contain exactly {panel_count} items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood, Action timing 0s-4s and 5s-8s, and Script nhan vat.
""".strip()


def build_storyboard_prompt(analysis: Dict[str, Any], options: Dict[str, Any]) -> str:
    panel_count = resolve_panel_count(options)
    scene_ratio = options.get("sceneRatio") or options.get("aspectRatio") or "9:16"
    no_text = bool(options.get("noTextInImage", True))
    text_rule = "No text, labels, captions, UI, logos, or watermarks inside the image." if no_text else "Avoid unnecessary text."

    if is_template1(options):
        scene_data = {
            "analysis": analysis.get("analysis", {}),
            "sceneContext": analysis.get("sceneContext", {}),
            "outfitPlan": analysis.get("outfitPlan", {}),
            "frameData": analysis.get("frameData", ""),
            "cropTemplate": analysis.get("cropTemplate", ""),
            "panels": [
                {
                    "id": item.get("id") or idx + 1,
                    "goal": item.get("goal", ""),
                    "visualDescription": item.get("visualDescription", ""),
                    "cameraAction": item.get("cameraAction", ""),
                    "productFocus": item.get("productFocus", ""),
                }
                for idx, item in enumerate(analysis.get("script") or [])
            ],
        }

        return f"""
Generate one clean faceless footwear review storyboard image from the uploaded product reference images.

Storyboard requirements:
- Exactly 2 panels arranged side by side in one single still image.
- Each panel frame is optimized for {scene_ratio} aspect ratio.
- Both panels must share the same random setting, time of day, surface, background, mood, and lighting plan from Scene plan.
- Panel 1 is a mandatory handheld hero/detail shot: beautiful feminine hand holding one sandal close to camera, other sandal behind, same shared setting.
- Panel 2 is a mandatory top-down POV on-foot shot using the randomized outfitPlan in the exact same setting. The wearer is sitting still or standing still in one place.
- Preserve product design, color, material, silhouette, logo/text, sole, straps/laces, and identity from the reference photos.
- Use realistic commercial photography, clean composition, and lighting that matches the selected setting/time.
- No visible faces. Only hands, feet, lower legs, or cropped body parts are allowed when needed.
- Do not create a walking scene, low-angle shot, tracking shot, beach-walking transition, or movement through space.
- {text_rule}
- Output must be a still photo collage. Do NOT generate or describe a video.

Scene plan:
{json.dumps(scene_data, ensure_ascii=False, indent=2)}

        Generate one still storyboard image now.
""".strip()

    if is_template3(options):
        scene_data = {
            "analysis": analysis.get("analysis", {}),
            "sceneContext": analysis.get("sceneContext", {}),
            "productSupportPlan": analysis.get("productSupportPlan", {}),
            "outfitPlan": analysis.get("outfitPlan", {}),
            "frameData": analysis.get("frameData", ""),
            "cropTemplate": analysis.get("cropTemplate", ""),
            "panels": [
                {
                    "id": item.get("id") or idx + 1,
                    "goal": item.get("goal", ""),
                    "visualDescription": item.get("visualDescription", ""),
                    "cameraAction": item.get("cameraAction", ""),
                    "productFocus": item.get("productFocus", ""),
                }
                for idx, item in enumerate(analysis.get("script") or [])
            ],
        }

        return f"""
Generate one faceless footwear shop review storyboard image from the uploaded product reference images.

CRITICAL VISUAL DIRECTION — TEMPLATE3 SHOP SMARTPHONE REALISM:
{TEMPLATE3_REALISM_FULL}

DISPLAY SUPPORT RULES:
{TEMPLATE3_DISPLAY_STAND_RULES}

SHOP BACKGROUND REFERENCE RULES:
{TEMPLATE3_SHOP_BACKGROUND_RULES}

PANEL 1 HANDHELD COMPOSITION RULES:
{TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}

PANEL 2 SOCK / BAREFOOT RULES:
{TEMPLATE3_PANEL2_SOCK_RULES}

Storyboard requirements:
- Exactly 2 panels arranged side by side in one single still image.
- Each panel frame is optimized for {scene_ratio} aspect ratio.
- Use uploaded reference asset "shopgiay-background-reference.png" as the shared shop environment reference for both panels, including shelves/display mood/floor/counter/lighting. Keep it secondary behind the product.
- Both panels must share the same real footwear shop setting, time of day, surface/floor logic, shelves/display background, mood, and lighting plan from Scene plan.
- Panel 1 is mandatory: top-down smartphone shot from above, almost fixed camera, one shoe/sandal held by a realistic hand in the foreground, larger than everything else, the matching other shoe/sandal stationary below/background on the product base.
- Panel 1 must match the reference layout idea: held product in foreground occupying about 55-70% of panel height, matching stationary pair below/background still fully visible, product support visible, shop context around the table/counter/floor.
- Panel 1 hand pose must look correct: fingers support under/along the outsole and side body, thumb stabilizes the side/upper edge, product tilted 15-30 degrees, top/upper, toe/front, straps/laces, side body, and a portion of the sole edge visible at once.
- Panel 1 must not show a pinch-only grip, heel-only grip, covered laces/straps/logo, hidden top surface, horizontal side-view camera, low-angle camera, or orbit-style composition.
- If the product references show a matching shoe box, use that box. If not, use uploaded reference asset "giadegiay-display-stand-reference.webp" only as the shoe display stand for the stationary shoe.
- Panel 2 is mandatory: template1-style top-down POV on-foot proof in the exact same shop. The wearer is sitting still or standing still in one place, no walking and no tracking.
- Panel 2 sock/barefoot logic is mandatory: if the product is a closed shoe/sneaker/loafer/boot, show appropriate socks; if the product is open sandal/slide/slipper/dép, keep the wearer barefoot unless styling clearly supports socks.
- Preserve product design, color, material, silhouette, logo/text, sole, straps/laces, charm, pattern, stitching, and identity from the product reference photos.
- No visible faces. Only hands, forearms, feet, lower legs, or cropped outfit/body parts are allowed.
- Do not create a home, bedroom, living room, cafe, beach, street, studio, low-angle shot, or movement-through-space scene.
- {text_rule} Preserve only real product logo/text that exists on the reference product.
- Output must be a still photo collage. Do NOT generate or describe a video.

Scene plan:
{json.dumps(scene_data, ensure_ascii=False, indent=2)}

Generate one still storyboard image now.
""".strip()

    return f"""
Generate one clean fashion storyboard image from the uploaded product reference images.

Storyboard requirements:
- Exactly {panel_count} panels.
- Each panel is optimized for {scene_ratio}.
- Show one coherent Vietnamese fashion product review sequence.
- Preserve product design, color, material, and identity from the references.
- Use cinematic commercial lighting, realistic fashion photography, clean composition.
- {text_rule}

Storyboard data:
{json.dumps(analysis, ensure_ascii=False)}

Generate an image. Do not return only text.
""".strip()


def build_panel_prompt(
    storyboard_available: bool,
    panel_index: int,
    panel_count: int,
    script_item: Dict[str, Any],
    veo_prompt: str,
    options: Dict[str, Any],
) -> str:
    scene_ratio = options.get("sceneRatio") or options.get("aspectRatio") or "9:16"
    source = (
        "Use the uploaded storyboard image as the main visual reference and extract/recreate only this panel."
        if storyboard_available
        else "Use the uploaded product images as visual references and create this panel directly."
    )

    if is_template1(options):
        return f"""
Generate a single polished faceless footwear commercial photograph (still image, NOT a video).

Panel: {panel_index} of {panel_count}
Aspect ratio: {scene_ratio}
Instruction:
- {source}
- Keep the product identity exactly consistent with the reference photo(s).
- Keep the shared setting, time of day, lighting, surface, and mood consistent with the storyboard scene.
- Do not show any visible face, talking person, presenter, or full-face reflection.
- Do not include text, labels, captions, UI, prices, ratings, logos added by the model, or watermarks.
- If the panel includes clothing, use the randomized outfit direction from the storyboard/shot concept; do not force cream/beige wide pants unless that was explicitly selected by outfitPlan.
- For Panel 1: show a beautiful feminine hand holding one sandal close to camera, with correct hand anatomy and neat glossy nude/pink nails; keep the second sandal behind in the same scene.
- For Panel 2: use top-down POV from above only; the wearer must be sitting still or standing still in one place. Do not show walking, stepping forward, low-angle tracking, or a moving body.
- Make it a clean vertical start frame suitable for image-to-video.

Panel data:
{json.dumps(script_item, ensure_ascii=False)}

Motion reference prompt:
{veo_prompt}

Generate exactly one still image now.
""".strip()

    if is_template3(options):
        panel_specific_rules = (
            """
- Panel 1 mandatory composition: top-down smartphone camera from above, almost fixed; one shoe/sandal is held by a realistic hand close to the camera in the foreground and is clearly larger than the matching other shoe/sandal.
- The held product should occupy about 55-70% of the panel height. The matching other shoe/sandal stays below or in the background, smaller but still fully visible with complete form.
- Hand grip must be realistic and stable: fingers support the outsole/sole edge and side body, thumb stabilizes the side/upper edge. Do not pinch only the toe, hold only the heel, cover the laces/straps/logo/front design, or hide the top surface.
- The held product must be tilted about 15-30 degrees, showing the top/upper, toe/front, straps/laces, side body, and part of the sole edge in the same image.
- If a matching shoe box appears in the product reference/storyboard, keep it as the base. If no shoe box is visible, use "giadegiay-display-stand-reference.webp" only as the shoe display stand prop for the stationary shoe.
- Do not show a face, full body, horizontal side-view camera, low-angle camera, orbit composition, TikTok UI, caption, watermark, or added logo/text.
""".strip()
            if panel_index == 1
            else """
- Panel 2 mandatory composition: top-down POV / first-person camera from above, wearer trying the footwear on feet in the exact same footwear shop.
- The wearer is sitting still or standing still in one place. Do not show walking, stepping forward, low-angle tracking, or movement through space.
- Footwear/sock logic is mandatory: if product is a closed shoe/sneaker/loafer/boot, show appropriate clean socks; if product is open sandal/slide/slipper/dép, show natural bare feet unless styling clearly supports socks.
- Use the randomized outfit direction from the storyboard/shot concept; do not force cream/beige wide pants unless outfitPlan selected it.
""".strip()
        )
        return f"""
Generate a single faceless footwear shop-review photograph that looks like an authentic smartphone camera shot (still image, NOT a video).

CRITICAL VISUAL DIRECTION — TEMPLATE3 SHOP SMARTPHONE REALISM:
{TEMPLATE3_REALISM_FULL}

DISPLAY SUPPORT RULES:
{TEMPLATE3_DISPLAY_STAND_RULES}

SHOP BACKGROUND REFERENCE RULES:
{TEMPLATE3_SHOP_BACKGROUND_RULES}

PANEL 1 HANDHELD COMPOSITION RULES:
{TEMPLATE3_PANEL1_HANDHELD_COMPOSITION}

PANEL 2 SOCK / BAREFOOT RULES:
{TEMPLATE3_PANEL2_SOCK_RULES}

Panel: {panel_index} of {panel_count}
Aspect ratio: {scene_ratio}
Instructions:
- {source}
- Keep the product identity exactly consistent with the product reference photo(s), including color, material, silhouette, sole, straps/laces, logo/text, charm, pattern, stitching, and proportions.
- Use "shopgiay-background-reference.png" as the shop environment reference for shelves/display/floor/counter/lighting, but keep it secondary and do not copy any text/watermark/signage.
- Keep the shared footwear shop setting, mixed shop lighting, floor/shelf logic, and mood consistent with the storyboard scene.
- Product material must show real texture/grain/weave/seams/scuffs/fingerprints where appropriate. Never make it glossy porcelain, waxy plastic, melted, or deformed.
- Human skin must show visible pores, knuckle creases, light veins, natural skin tone variation, correct anatomy, and no extra fingers.
{panel_specific_rules}
- Make it a vertical start frame suitable for image-to-video.

Panel data:
{json.dumps(script_item, ensure_ascii=False)}

Motion reference prompt:
{veo_prompt}

Generate exactly one still image now.
""".strip()

    return f"""
Generate a single clean start-frame image for video.

Panel: {panel_index} of {panel_count}
Aspect ratio: {scene_ratio}
Instruction:
- {source}
- Keep the product identity exactly consistent with the reference.
- Do not include text, labels, captions, UI, or watermarks.
- Make it a polished vertical fashion commercial frame suitable for Veo 3 start image.

Panel script:
{json.dumps(script_item, ensure_ascii=False)}

Veo 3 prompt for this panel:
{veo_prompt}

Generate exactly one image. Do not return only text.
""".strip()


async def save_first_image(response: Any, output_dir: Path, filename: str) -> Optional[Path]:
    images = list(getattr(response, "images", None) or [])
    if not images:
        return None

    before = {p.resolve() for p in output_dir.glob("*") if p.is_file()}
    image = images[0]
    await image.save(path=str(output_dir), filename=filename, verbose=False)
    expected = output_dir / filename
    if expected.exists():
        return expected

    after = [p for p in output_dir.glob("*") if p.is_file() and p.resolve() not in before]
    if after:
        return max(after, key=lambda p: p.stat().st_mtime)
    return None


def log_response_without_image(label: str, response: Any) -> None:
    text = str(getattr(response, "text", "") or "").strip()
    images = list(getattr(response, "images", None) or [])
    videos = list(getattr(response, "videos", None) or [])
    media = list(getattr(response, "media", None) or [])
    candidates = list(getattr(response, "candidates", None) or [])
    log(
        f"{label} returned no image "
        f"(candidates={len(candidates)}, images={len(images)}, videos={len(videos)}, media={len(media)})"
    )
    if text:
        log(f"{label} text: {text[:1000]}")
    else:
        log(f"{label} text: (empty)")


def read_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def normalize_analysis(data: Dict[str, Any], panel_count: int, options: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    options = options or {}
    use_template1 = is_template1(options)
    use_template3 = is_template3(options)
    script = data.get("script") if isinstance(data.get("script"), list) else []
    prompts = data.get("veo3Prompts") if isinstance(data.get("veo3Prompts"), list) else []

    normalized_script = []
    for idx in range(panel_count):
        item = script[idx] if idx < len(script) and isinstance(script[idx], dict) else {}
        normalized_item = {
            "id": int(item.get("id") or idx + 1),
            "duration": str(item.get("duration") or f"00:{idx * 8:02d}-00:{(idx + 1) * 8:02d}"),
            "goal": str(item.get("goal") or ""),
            "visualDescription": str(item.get("visualDescription") or ""),
            "cameraAction": str(item.get("cameraAction") or ""),
        }
        if use_template1 or use_template3:
            normalized_item["productFocus"] = str(item.get("productFocus") or "")
        else:
            normalized_item["voiceOver"] = str(item.get("voiceOver") or "")
        normalized_script.append(normalized_item)

    normalized_prompts = []
    for idx in range(panel_count):
        if idx < len(prompts):
            prompt = (
                normalize_template1_video_prompt(prompts[idx])
                if use_template1 or use_template3
                else normalize_prompt(prompts[idx])
            )
            if use_template1:
                if idx == 0:
                    prompt = normalize_prompt(
                        f"{prompt} Quy tắc bắt buộc Panel 1: tay nữ đẹp cầm một chiếc dép sát camera, móng nude/hồng bóng nhẹ, đúng giải phẫu, chiếc dép còn lại ở phía sau cùng bối cảnh."
                    )
                elif idx == 1:
                    prompt = normalize_prompt(
                        f"{prompt} Quy tắc bắt buộc Panel 2: POV top-down từ trên xuống, người mẫu đứng im hoặc ngồi im một chỗ, chỉ cử động chân nhỏ tại chỗ; tuyệt đối không đi lại, không bước tới, không low-angle, không tracking shot."
                    )
            elif use_template3:
                if idx == 0:
                    prompt = normalize_prompt(
                        f"{prompt} Quy tắc bắt buộc Panel 1 / Template3: Cảnh shop giày dép, camera smartphone top-down cố định từ trên xuống, một chiếc giày/dép được tay cầm để giới thiệu, chiếc còn lại đặt cố định trên hộp giày nếu ảnh tham chiếu có hộp; nếu không có hộp thì đặt trên giá đỡ theo reference giadegiay-display-stand-reference.webp. Sản phẩm di chuyển luôn là sản phẩm đã upload từ Telegram; giá đỡ chỉ là prop. {TEMPLATE3_PANEL1_HANDHELD_COMPOSITION} {TEMPLATE3_PANEL1_CHOREOGRAPHY} Quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người."
                    )
                elif idx == 1:
                    prompt = normalize_prompt(
                        f"{prompt} Quy tắc bắt buộc Panel 2 / Template3: POV top-down từ trên xuống trong cùng shop giày dép, người mẫu đứng im hoặc ngồi im một chỗ, không walking, không stepping forward, không low-angle, không tracking shot. {TEMPLATE3_PANEL2_SOCK_RULES} {TEMPLATE1_PANEL2_CHOREOGRAPHY} Quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người."
                    )
            normalized_prompts.append(prompt)
        else:
            item = normalized_script[idx]
            if use_template1:
                normalized_prompts.append(
                    normalize_prompt(
                        f"Tạo video review giày dép faceless 8 giây. VISUAL: {item['visualDescription']}. "
                        f"Tone & Mood: chân thực, thời trang, sạch, thương mại. "
                        f"Hành động: 0s-4s {item['cameraAction']}; 5s-8s giữ đúng bố cục cảnh, chỉ chuyển động nhỏ tại chỗ để nhấn chi tiết sản phẩm. "
                        "Nếu là cảnh POV thì nhân vật phải đứng im hoặc ngồi im một chỗ, không đi lại, không tracking shot. "
                        "Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark."
                    )
                )
            elif use_template3:
                if idx == 0:
                    normalized_prompts.append(
                        normalize_prompt(
                            f"Tạo video review giày dép faceless dài đúng 8 giây. VISUAL: Camera smartphone top-down nhìn từ trên xuống trong shop giày dép chân thực; {item['visualDescription']}; một chiếc được tay cầm giới thiệu, chiếc còn lại đặt cố định trên hộp giày nếu ảnh tham chiếu có hộp, nếu không có hộp thì đặt trên giá đỡ theo reference giadegiay-display-stand-reference.webp; giữ chính xác 100% màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm, họa tiết, đường may và tỉ lệ sản phẩm theo ảnh tham chiếu. Yêu cầu bố cục tay cầm: {TEMPLATE3_PANEL1_HANDHELD_COMPOSITION} Tone & Mood: nhanh, chân thực, thương mại, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da tay thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. {TEMPLATE3_PANEL1_CHOREOGRAPHY} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người."
                        )
                    )
                else:
                    normalized_prompts.append(
                        normalize_prompt(
                            f"Tạo video review giày dép faceless 8 giây. VISUAL: Cảnh POV top-down / first-person nhìn từ trên xuống đôi chân đang mang sản phẩm trong đúng cùng shop giày dép, {item['visualDescription']}; người mẫu đang ngồi yên hoặc đứng yên một chỗ, tuyệt đối không đi lại; giữ đúng màu sắc, form dáng, chất liệu, đế, quai/dây, logo/chữ có sẵn, charm/chi tiết trang trí và tỉ lệ sản phẩm 100% theo ảnh tham chiếu. Quy tắc tất/chân trần: {TEMPLATE3_PANEL2_SOCK_RULES} Tone & Mood: tự nhiên, shop try-on, thời trang, quay bằng điện thoại, ánh sáng shop giày dép chân thực, chất liệu sản phẩm có texture tự nhiên, da chân thật, không bokeh giả, không ánh sáng studio, không nhựa bóng kiểu AI. {TEMPLATE1_PANEL2_CHOREOGRAPHY} Không có voice-over, không lời thoại, không phụ đề, không chữ, không watermark, không lộ mặt người."
                        )
                    )
            else:
                normalized_prompts.append(
                    normalize_prompt(
                        f"Create an 8-second Vietnamese fashion review video. VISUAL: {item['visualDescription']}. "
                        f"Tone & Mood: premium, clear, engaging. Action: 0s-4s {item['cameraAction']}; "
                        f"5s-8s show product detail and model reaction. Script nhan vat: \"{item['voiceOver']}\""
                    )
                )

    data["script"] = normalized_script
    data["veo3Prompts"] = normalized_prompts
    if not isinstance(data.get("analysis"), dict):
        data["analysis"] = {}
    data["analysis"].update(
        normalize_product_metadata(data["analysis"], data["analysis"].get("type") or "Fashion product")
    )
    if (use_template1 or use_template3) and not isinstance(data.get("sceneContext"), dict):
        data["sceneContext"] = {}
    if use_template3 and not isinstance(data.get("productSupportPlan"), dict):
        data["productSupportPlan"] = {}
    if (use_template1 or use_template3) and not isinstance(data.get("outfitPlan"), dict):
        data["outfitPlan"] = {}
    data.setdefault("frameData", "")
    data.setdefault("cropTemplate", "")
    return data


async def run(request: Dict[str, Any], work_dir: Path) -> Dict[str, Any]:
    set_log_level(os.environ.get("GEMINI_WEBAPI_LOG_LEVEL", "WARNING"))
    secure_1psid = require_env("GEMINI_SECURE_1PSID")
    secure_1psidts = os.environ.get("GEMINI_SECURE_1PSIDTS", "").strip()
    cookie_path = os.environ.get("GEMINI_COOKIE_PATH")
    if cookie_path:
        os.environ["GEMINI_COOKIE_PATH"] = str(Path(cookie_path).expanduser().resolve())

    options = request.get("options") or {}
    panel_count = resolve_panel_count(options)
    options["panelCount"] = panel_count
    output_dir = work_dir / "outputs"
    input_dir = work_dir / "inputs"
    reference_dir = work_dir / "references"
    output_dir.mkdir(parents=True, exist_ok=True)
    input_dir.mkdir(parents=True, exist_ok=True)
    reference_dir.mkdir(parents=True, exist_ok=True)

    input_paths: List[Path] = []
    for idx, image in enumerate(request.get("images") or []):
        mime_type = image.get("mimeType") or "image/png"
        name = safe_name(image.get("name") or "", f"image-{idx + 1}")
        path = input_dir / f"{idx + 1:02d}-{name}{image_ext(mime_type)}"
        path.write_bytes(base64.b64decode(image.get("base64") or ""))
        input_paths.append(path)

    if not input_paths:
        raise RuntimeError("At least one input image is required")

    reference_paths: List[Path] = []
    for idx, asset in enumerate(request.get("referenceAssets") or []):
        mime_type = asset.get("mimeType") or "image/png"
        name = safe_name(asset.get("name") or asset.get("role") or "", f"reference-{idx + 1}")
        path = reference_dir / f"{idx + 1:02d}-{name}{image_ext(mime_type)}"
        path.write_bytes(base64.b64decode(asset.get("base64") or ""))
        reference_paths.append(path)

    client = GeminiClient(secure_1psid, secure_1psidts, proxy=os.environ.get("GEMINI_WEBAPI_PROXY") or None)
    await client.init(timeout=int(os.environ.get("GEMINI_WEBAPI_INIT_TIMEOUT", "60")), auto_close=True, close_delay=120, auto_refresh=True)

    try:
        models = client.list_models() or []
        if models:
            visible_models = [
                f"{getattr(model, 'model_name', '') or '?'} ({getattr(model, 'display_name', '') or '?'})"
                for model in models
            ]
            log("Available models: " + ", ".join(visible_models[:20]))

        log("Generating analysis and Veo prompts")
        analysis_prompt = build_analysis_prompt(options)
        analysis_response = await client.generate_content(
            analysis_prompt,
            files=input_paths,
            temporary=True,
            model=options.get("textModel") or os.environ.get("GEMINI_WEBAPI_TEXT_MODEL") or "unspecified",
        )
        analysis = normalize_analysis(parse_json_object(getattr(analysis_response, "text", "") or ""), panel_count, options)

        log("Generating full storyboard image")
        storyboard_prompt = build_storyboard_prompt(analysis, options)
        storyboard_response = await client.generate_content(
            storyboard_prompt,
            files=[*input_paths, *reference_paths],
            temporary=True,
            model=options.get("imageModel") or os.environ.get("GEMINI_WEBAPI_IMAGE_MODEL") or "unspecified",
        )
        storyboard_path = await save_first_image(storyboard_response, output_dir, "storyboard.png")
        if not storyboard_path:
            log_response_without_image("Storyboard image response", storyboard_response)
            raise RuntimeError("Gemini did not return a storyboard image; stopping before panel generation.")
        storyboard_b64 = read_b64(storyboard_path) if storyboard_path else None

        panel_reference_files = [storyboard_path, *reference_paths]
        # Default concurrency is 1 (sequential) because gemini_webapi uses a single
        # browser/session and Google aborts concurrent requests (error 1100).
        panel_concurrency = max(
            1,
            int(os.environ.get("GEMINI_WEBAPI_PANEL_CONCURRENCY") or "1"),
        )
        panel_semaphore = asyncio.Semaphore(panel_concurrency)
        panel_image_prompts: List[Optional[str]] = [None] * panel_count

        async def generate_panel(idx: int) -> Dict[str, Any]:
            panel_index = idx + 1
            prompt = analysis["veo3Prompts"][idx]
            last_exc: Exception = RuntimeError("Unknown error")
            for attempt in range(1, PANEL_MAX_RETRIES + 1):
                async with panel_semaphore:
                    log(
                        f"Generating panel {panel_index}/{panel_count} "
                        f"(concurrency={panel_concurrency}, attempt {attempt}/{PANEL_MAX_RETRIES})"
                    )
                    try:
                        panel_prompt = build_panel_prompt(
                            bool(storyboard_path),
                            panel_index,
                            panel_count,
                            analysis["script"][idx],
                            prompt,
                            options,
                        )
                        panel_image_prompts[idx] = panel_prompt
                        response = await client.generate_content(
                            panel_prompt,
                            files=panel_reference_files,
                            temporary=True,
                            model=options.get("imageModel") or os.environ.get("GEMINI_WEBAPI_IMAGE_MODEL") or "unspecified",
                        )
                        panel_path = await save_first_image(response, output_dir, f"panel-{panel_index}.png")
                        if not panel_path:
                            log_response_without_image(f"Panel {panel_index} image response", response)
                            raise RuntimeError(f"Gemini did not return an image for panel {panel_index}")
                        log(f"Completed panel {panel_index}/{panel_count}")
                        return {
                            "index": panel_index,
                            "prompt": prompt,
                            "imageBase64": read_b64(panel_path),
                            "mimeType": "image/png",
                            "sourcePath": str(panel_path),
                        }

                    except Exception as exc:
                        last_exc = exc
                        if attempt < PANEL_MAX_RETRIES:
                            delay = PANEL_RETRY_DELAY * attempt
                            log(f"Panel {panel_index} attempt {attempt} failed ({exc}). Retrying in {delay:.0f}s...")
                            await asyncio.sleep(delay)
                        else:
                            log(f"Panel {panel_index} failed after {PANEL_MAX_RETRIES} attempts: {exc}")
            raise last_exc

        log(
            f"Generating {panel_count} panel image(s) sequentially "
            f"(concurrency={panel_concurrency}, max_retries={PANEL_MAX_RETRIES})"
        )
        panels = await asyncio.gather(
            *(generate_panel(idx) for idx in range(panel_count))
        )
        panels = sorted(panels, key=lambda item: item["index"])

        return {
            "analysis": analysis.get("analysis", {}),
            "script": analysis["script"],
            "sceneContext": analysis.get("sceneContext", {}),
            "productSupportPlan": analysis.get("productSupportPlan", {}),
            "outfitPlan": analysis.get("outfitPlan", {}),
            "frameData": analysis.get("frameData", ""),
            "cropTemplate": analysis.get("cropTemplate", ""),
            "veo3Prompts": analysis["veo3Prompts"],
            "storyboard": {
                "imageBase64": storyboard_b64,
                "mimeType": "image/png" if storyboard_b64 else None,
                "sourcePath": str(storyboard_path) if storyboard_path else None,
            },
            "debugPrompts": {
                "analysisPrompt": analysis_prompt,
                "storyboardPrompt": storyboard_prompt,
                "panelImagePrompts": panel_image_prompts,
                "veo3Prompts": analysis["veo3Prompts"],
            },
            "panels": panels,
        }
    finally:
        try:
            await client.close()
        except Exception:
            pass


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--work-dir", required=True)
    args = parser.parse_args()

    request = json.loads(Path(args.input).read_text(encoding="utf-8"))
    result = await run(request, Path(args.work_dir))
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        log(f"ERROR: {exc}")
        raise
