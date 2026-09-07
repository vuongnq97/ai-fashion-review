# Template 5 Storyboard/Video Pipeline V2

Pipeline V2 hiện chỉ áp dụng cho `template5` và `template5_1`. Theo quyết định rollback ngày 06/09/2026, `template5_2` (`/t52`) luôn chạy V1, kể cả khi request hoặc biến môi trường yêu cầu `pipelineVersion=v2`. `template5_3` cũng tiếp tục dùng implementation legacy.

## Bật pipeline

Canary theo request:

```json
{
  "template": "template5_1",
  "pipelineVersion": "v2",
  "qualityMode": "balanced"
}
```

Bật mặc định:

```env
STORYBOARD_PIPELINE_VERSION=v2
STORYBOARD_QUALITY_MODE=balanced
STORYBOARD_MAX_PANEL_RETRIES=2
STORYBOARD_MAX_CLIP_RETRIES=2
STORYBOARD_RUN_RETENTION_DAYS=7
STORYBOARD_MIN_IMAGE_SIDE=256
```

Rollback không cần đổi dữ liệu:

```env
STORYBOARD_PIPELINE_VERSION=v1
```

## Pipeline

```text
normalizeInput
  -> auditProductAssets
  -> buildProductTruthProfile
  -> routeCategoryAndSceneTypes
  -> createFourSceneMarketingPlan
  -> validateAndRewriteVisualScenes
  -> publishAnalysisSummaryToBot
  -> buildContinuityPack
  -> generateOneCoherentFourCellMaster
  -> qaMasterAndAllFourSlices
  -> composeStoryboardDeterministically
  -> generateSceneClips
  -> qaAndRetryClips
  -> postProcessFinalVideo
```

Các intermediate result được lưu trong `run-manifest.json`. Buffer, base64, token, cookie và query của URL được redact khỏi manifest.

Ảnh đầu vào được decode/auto-rotate sang working PNG, kiểm tra kích thước tối thiểu và loại exact duplicate. Bản gốc vẫn được giữ riêng trong thư mục run để debug. Tất cả ảnh hợp lệ được ghép thành `all-input-evidence-board.png`; model phân tích vẫn nhận từng ảnh gốc, còn image generator nhận ảnh canonical/detail ưu tiên và evidence board để có đủ ngữ cảnh.

## Quality mode

- Cả `fast`, `balanced` và `high_fidelity` đều sinh **một master chứa đủ bốn cảnh trong một image call**. Không còn sinh panel độc lập.
- `balanced`: mặc định, cho phép retry toàn bộ master theo cấu hình.
- `high_fidelity`: khi provider hỗ trợ edit, retry bằng cách edit master trước đó để giữ bố cục và nhận dạng tốt hơn.
- `/remakeN` chỉ dùng N làm trọng tâm feedback; hệ thống vẫn tạo lại toàn bộ master bốn cảnh.

Mỗi image call nhận tối đa bốn reference theo thứ tự ưu tiên: canonical product, mechanism detail, canonical bổ sung và evidence board chứa toàn bộ input.

## QA gates

Panel score:

- Product identity: 30
- Physical feasibility: 20
- Scene intent: 15
- Continuity: 15
- Human anatomy: 10
- Realism: 5
- No-text: 5

`>=85` được duyệt, `75–84` targeted retry, `<75` regenerate. Sai SKU, sai cơ cấu, vật thể lơ lửng hoặc product morph luôn bị reject.

Master QA chấm riêng product identity, tính nhất quán xuyên bốn cảnh, khả thi vật lý, đủ bốn scene, layout và no-text. Nếu master hoặc chỉ một lát cắt không đạt, hệ thống retry **toàn bộ master**, không vá riêng cảnh. Điểm provider trả theo thang 0–10 được chuẩn hóa sang 0–100.

Video generation bị chặn nếu bất kỳ panel nào chưa có `status: approved`. Clip cũng được QA và retry riêng trước khi concat.

## No-text và claim policy

`no_generated_text` cấm headline, subtitle, badge, số, UI, watermark và chữ copy từ poster. Logo/wordmark nguyên bản được giữ nếu là chi tiết vật lý của sản phẩm.

`conflict`, `inferred`, `unknown` không được dùng như fact. Numeric warranty, weight, power và promotion không được đưa vào visual claim.

## Storyboard/video output

- Nguồn sinh: `generated-master.png`, một ảnh chứa bốn cảnh nhất quán.
- Panel nguồn video: bốn lát `1080x1920` (`9:16`) được cắt/pad bằng FFmpeg từ cùng master, không gọi model tạo riêng.
- Storyboard sạch: `4320x1920` (`9:4`), ghép bằng FFmpeg.
- Với `template5`, bản `storyboard-with-copy.png` được render từ bản sạch bằng font Unicode và `drawtext`; chữ không do image model sinh.
- Video: bốn clip riêng, mặc định 4 giây/scene, ghép deterministic.
- `template5` đưa copy sang hậu kỳ.
- `template5_1` giữ clean/no-text.
- `template5_2` không đi qua các quy tắc V2 trên; luồng V1 tiếp tục tạo hai video 8 giây và voice review như trước rollback.

## API compatibility

Endpoint cũ không bị xóa. Các response được bổ sung `pipelineVersion`, `qualityMode`, `runManifest`, `status`, `qa` và `sceneNumber`. Consumer cũ có thể bỏ qua field mới.

Trong V2, `sceneCount`, `panelCount` và `clipCount` đều là 4. Không dùng `panelCount=2` để đại diện hai video ghép cảnh như V1.

## Test

```bash
cd playwright-service
npm test
```

Provider smoke test tốn quota và không chạy mặc định:

```bash
STORYBOARD_PROVIDER_SMOKE=1 \
STORYBOARD_PROVIDER_FIXTURE=/absolute/path/to/product.png \
npm run test:provider
```
