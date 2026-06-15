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
    return ".jpg" if "jpeg" in mime_type or "jpg" in mime_type else ".png"


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


def build_analysis_prompt(options: Dict[str, Any]) -> str:
    panel_count = int(options.get("panelCount") or 3)
    scene_ratio = options.get("sceneRatio") or options.get("aspectRatio") or "9:16"
    category = options.get("category") or "Fashion product"
    vietnamese_model = bool(options.get("useVietnameseModel", True))
    style_fast = bool(options.get("styleCuonHut", True))

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
- "script" and "veo3Prompts" must contain exactly {panel_count} items.
- Each veo3 prompt must be one line, with no newline characters.
- Each veo3 prompt must include VISUAL, Tone & Mood, Action timing 0s-4s and 5s-8s, and Script nhan vat.
""".strip()


def build_storyboard_prompt(analysis: Dict[str, Any], options: Dict[str, Any]) -> str:
    panel_count = int(options.get("panelCount") or 3)
    scene_ratio = options.get("sceneRatio") or options.get("aspectRatio") or "9:16"
    no_text = bool(options.get("noTextInImage", True))
    text_rule = "No text, labels, captions, UI, logos, or watermarks inside the image." if no_text else "Avoid unnecessary text."

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


def read_b64(path: Path) -> str:
    return base64.b64encode(path.read_bytes()).decode("ascii")


def normalize_analysis(data: Dict[str, Any], panel_count: int) -> Dict[str, Any]:
    script = data.get("script") if isinstance(data.get("script"), list) else []
    prompts = data.get("veo3Prompts") if isinstance(data.get("veo3Prompts"), list) else []

    normalized_script = []
    for idx in range(panel_count):
        item = script[idx] if idx < len(script) and isinstance(script[idx], dict) else {}
        normalized_script.append(
            {
                "id": int(item.get("id") or idx + 1),
                "duration": str(item.get("duration") or f"00:{idx * 8:02d}-00:{(idx + 1) * 8:02d}"),
                "voiceOver": str(item.get("voiceOver") or ""),
                "goal": str(item.get("goal") or ""),
                "visualDescription": str(item.get("visualDescription") or ""),
                "cameraAction": str(item.get("cameraAction") or ""),
            }
        )

    normalized_prompts = []
    for idx in range(panel_count):
        if idx < len(prompts):
            normalized_prompts.append(normalize_prompt(prompts[idx]))
        else:
            item = normalized_script[idx]
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
    panel_count = int(options.get("panelCount") or 3)
    output_dir = work_dir / "outputs"
    input_dir = work_dir / "inputs"
    output_dir.mkdir(parents=True, exist_ok=True)
    input_dir.mkdir(parents=True, exist_ok=True)

    input_paths: List[Path] = []
    for idx, image in enumerate(request.get("images") or []):
        mime_type = image.get("mimeType") or "image/png"
        name = safe_name(image.get("name") or "", f"image-{idx + 1}")
        path = input_dir / f"{idx + 1:02d}-{name}{image_ext(mime_type)}"
        path.write_bytes(base64.b64decode(image.get("base64") or ""))
        input_paths.append(path)

    if not input_paths:
        raise RuntimeError("At least one input image is required")

    client = GeminiClient(secure_1psid, secure_1psidts, proxy=os.environ.get("GEMINI_WEBAPI_PROXY") or None)
    await client.init(timeout=int(os.environ.get("GEMINI_WEBAPI_INIT_TIMEOUT", "60")), auto_close=True, close_delay=120, auto_refresh=True)

    try:
        log("Generating analysis and Veo prompts")
        analysis_response = await client.generate_content(
            build_analysis_prompt(options),
            files=input_paths,
            temporary=True,
            model=options.get("textModel") or os.environ.get("GEMINI_WEBAPI_TEXT_MODEL") or "unspecified",
        )
        analysis = normalize_analysis(parse_json_object(getattr(analysis_response, "text", "") or ""), panel_count)

        log("Generating full storyboard image")
        storyboard_response = await client.generate_content(
            build_storyboard_prompt(analysis, options),
            files=input_paths,
            temporary=True,
            model=options.get("imageModel") or os.environ.get("GEMINI_WEBAPI_IMAGE_MODEL") or "unspecified",
        )
        storyboard_path = await save_first_image(storyboard_response, output_dir, "storyboard.png")
        if not storyboard_path:
            raise RuntimeError("Gemini did not return a storyboard image; stopping before panel generation.")
        storyboard_b64 = read_b64(storyboard_path) if storyboard_path else None

        panel_reference_files = [storyboard_path]
        # Default concurrency is 1 (sequential) because gemini_webapi uses a single
        # browser/session and Google aborts concurrent requests (error 1100).
        panel_concurrency = max(
            1,
            int(os.environ.get("GEMINI_WEBAPI_PANEL_CONCURRENCY") or "1"),
        )
        panel_semaphore = asyncio.Semaphore(panel_concurrency)

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
                        response = await client.generate_content(
                            build_panel_prompt(
                                bool(storyboard_path),
                                panel_index,
                                panel_count,
                                analysis["script"][idx],
                                prompt,
                                options,
                            ),
                            files=panel_reference_files,
                            temporary=True,
                            model=options.get("imageModel") or os.environ.get("GEMINI_WEBAPI_IMAGE_MODEL") or "unspecified",
                        )
                        panel_path = await save_first_image(response, output_dir, f"panel-{panel_index}.png")
                        if not panel_path:
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
            "frameData": analysis.get("frameData", ""),
            "cropTemplate": analysis.get("cropTemplate", ""),
            "veo3Prompts": analysis["veo3Prompts"],
            "storyboard": {
                "imageBase64": storyboard_b64,
                "mimeType": "image/png" if storyboard_b64 else None,
                "sourcePath": str(storyboard_path) if storyboard_path else None,
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
