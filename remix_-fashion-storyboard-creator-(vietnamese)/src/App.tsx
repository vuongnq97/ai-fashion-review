/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { 
  Camera, 
  Upload, 
  Settings, 
  Image as ImageIcon, 
  FileText, 
  Video, 
  Copy, 
  Download, 
  Loader2, 
  CheckCircle2,
  AlertCircle,
  Edit,
  Sparkles
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { analyzeProduct, generateStoryboardImage, generateScenePanel } from "./services/geminiService";
import { AppState, GeneratorOptions, getGridLayout } from "./types";

const MOCK_DATA: Partial<AppState> = {
  analysis: {
    type: "Giày Sneaker Thời Trang",
    materials: "Da lộn, cao su, vải lưới",
    highlights: ["Thiết kế silhouette hiện đại", "Màu sắc pastel nhã nhặn", "Đế chunky tôn dáng"],
    styling: "Streetwear, Casual, Tone-sur-tone",
    uncertainties: "Chưa rõ trọng lượng chính xác và độ thoáng khí thực tế",
    gender: "unisex"
  },
  script: [
    { id: 1, duration: "8s", voiceOver: "Bạn đang tìm một đôi sneaker vừa phong cách vừa êm ái? Đây chính là câu trả lời.", goal: "Gây ấn tượng (Hook)", visualDescription: "Cận cảnh đôi giày đặt trên nền tối tối giản, ánh sáng nghệ thuật.", cameraAction: "Slow motion zoom-in" },
    { id: 2, duration: "8s", voiceOver: "Chất liệu da lộn cao cấp kết hợp cùng đế cao su bền bỉ, mang lại sự thoải mái tối đa cho cả ngày dài.", goal: "Lợi ích sản phẩm", visualDescription: "Người mẫu Việt Nam diện giày đi dạo phố, phong cách năng động.", cameraAction: "Panning ngang theo bước chân" },
    { id: 3, duration: "8s", voiceOver: "Dễ dàng phối hợp với nhiều trang phục khác nhau. Nâng tầm phong cách của bạn ngay hôm nay!", goal: "Gợi ý phối đồ & Kêu gọi", visualDescription: "Người mẫu tạo dáng chụp ảnh lookbook, phong cách thời thượng.", cameraAction: "Góc quay rộng, xoay quanh chủ thể" }
  ],
  frameData: "Panel 1: Cận cảnh đôi giày sneaker da lộn màu pastel trên nền xám trung tính, ánh sáng studio. Panel 2: Người mẫu Việt Nam trẻ trung diện giày đi bộ trên phố cổ Hội An, ánh sáng nắng dịu. Panel 3: Người mẫu tạo dáng lookbook trong studio tối giản, diện giày cùng bộ đồ streetwear hiện đại.",
  cropperPrompt: "Tách panel 1 từ storyboard 16:9 đã upload, giữ nguyên sản phẩm, người mẫu, ánh sáng, bố cục và phong cách hình ảnh của panel đó, chuyển thành một ảnh dọc 9:16 sạch để làm start frame video. Không thêm chữ, không thêm UI, không tự diễn giải lại cảnh, không thay đổi nhận diện sản phẩm.",
  veoPrompts: [
    "Video quay đôi sneaker da lộn màu pastel, ánh sáng studio mềm mại, máy quay zoom chậm vào chi tiết đường chỉ.",
    "Video người mẫu Việt Nam đi dạo trên phố cổ Hội An, tập trung vào giày, chuyển động tự nhiên dưới nắng vàng.",
    "Video người mẫu tạo dáng lookbook thời thượng trong studio, quay từ chân lên đến thắt lưng, tập trung vào phong cách streetwear."
  ],
  storyboardImage: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?q=80&w=2070&auto=format&fit=crop"
};

export default function App() {
  const [images, setImages] = useState<string[]>([]);
  const [options, setOptions] = useState<GeneratorOptions>({
    category: "Giày / Sneakers",
    useVietnameseModel: true,
    noTextInImage: true,
    styleCuonHut: true,
    panelCount: 3,
    sceneRatio: "9:16",
    modelImage: null,
  });
  const [state, setState] = useState<AppState>({
    analysis: null,
    script: null,
    frameData: "",
    cropperPrompt: "",
    veoPrompts: [],
    storyboardImage: null,
    isLoading: false,
    error: null,
  });
  const [activeTab, setActiveTab] = useState("analysis");
  const [customPrompts, setCustomPrompts] = useState<{ [key: number]: string }>({});
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [videoUrls, setVideoUrls] = useState<{ [key: number]: string }>({});
  const [videoLoading, setVideoLoading] = useState<{ [key: number]: boolean }>({});
  const [videoErrors, setVideoErrors] = useState<{ [key: number]: string }>({});
  const [useLocalApi, setUseLocalApi] = useState<boolean>(true);
  const [localApiUrl, setLocalApiUrl] = useState<string>("https://raspiest-unprophetically-wan.ngrok-free.dev/api/generate-video");

  const finalPanelCount = state.generatedPanelCount ?? options.panelCount;
  const finalSceneRatio = state.generatedSceneRatio ?? options.sceneRatio;

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    files.forEach((file: File) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          setImages(prev => [...prev, reader.result as string]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleModelUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          setOptions(prev => ({ ...prev, modelImage: reader.result as string }));
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const generate = async () => {
    if (images.length === 0) {
      setState(prev => ({ ...prev, error: "Vui lòng upload ít nhất 1 ảnh sản phẩm." }));
      return;
    }

    const currentPanelCount = options.panelCount;
    const currentSceneRatio = options.sceneRatio;

    setState(prev => ({ 
      ...prev, 
      isLoading: true, 
      error: null,
      generatedPanelCount: currentPanelCount,
      generatedSceneRatio: currentSceneRatio,
      aiPanels: Array(currentPanelCount).fill(null),
      aiPanelsLoading: Array(currentPanelCount).fill(false)
    }));
    setActiveTab("results");
    setCustomPrompts({});
    setEditingIndex(null);
    try {
      const result = await analyzeProduct(images, options);
      setState(prev => ({
        ...prev,
        analysis: result.analysis,
        script: result.script,
        frameData: result.frameData,
        cropperPrompt: result.cropTemplate,
        veoPrompts: result.veo3Prompts,
        generatedPanelCount: currentPanelCount,
        generatedSceneRatio: currentSceneRatio,
        aiPanels: Array(currentPanelCount).fill(null),
        aiPanelsLoading: Array(currentPanelCount).fill(false)
      }));

      // Generate the actual image
      const imageUrl = await generateStoryboardImage(result, images, options);
      setState(prev => ({ 
        ...prev, 
        storyboardImage: imageUrl,
        generatedPanelCount: currentPanelCount,
        generatedSceneRatio: currentSceneRatio,
        aiPanels: Array(currentPanelCount).fill(null),
        aiPanelsLoading: Array(currentPanelCount).fill(true)
      }));
      
      // Concurrently call AI APIs to extract and upscale each individual scene panel
      const panelPromises = Array.from({ length: currentPanelCount }).map(async (_, idx) => {
        try {
          const description = result.script?.[idx]?.visualDescription || `Scene ${idx + 1}`;
          const frozenOptions = {
            ...options,
            panelCount: currentPanelCount,
            sceneRatio: currentSceneRatio,
          };
          const panelUrl = await generateScenePanel(imageUrl, idx, description, result, frozenOptions);
          
          setState(prev => {
            const currentPanels = prev.aiPanels ? [...prev.aiPanels] : Array(currentPanelCount).fill(null);
            const currentLoading = prev.aiPanelsLoading ? [...prev.aiPanelsLoading] : Array(currentPanelCount).fill(false);
            currentPanels[idx] = panelUrl;
            currentLoading[idx] = false;
            return {
              ...prev,
              aiPanels: currentPanels,
              aiPanelsLoading: currentLoading
            };
          });
        } catch (panelError) {
          console.error(`Error splitting panel ${idx + 1}:`, panelError);
          setState(prev => {
            const currentLoading = prev.aiPanelsLoading ? [...prev.aiPanelsLoading] : Array(currentPanelCount).fill(false);
            currentLoading[idx] = false;
            return {
              ...prev,
              aiPanelsLoading: currentLoading
            };
          });
        }
      });

      await Promise.all(panelPromises);
    } catch (err: any) {
      setState(prev => ({ ...prev, error: err.message }));
    } finally {
      setState(prev => ({ ...prev, isLoading: false }));
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleRegeneratePanel = async (idx: number) => {
    if (!state.storyboardImage) return;

    const finalPanelCount = state.generatedPanelCount ?? options.panelCount;
    const finalSceneRatio = state.generatedSceneRatio ?? options.sceneRatio;

    // Set individual panel loading to true
    setState(prev => {
      const currentLoading = prev.aiPanelsLoading ? [...prev.aiPanelsLoading] : Array(finalPanelCount).fill(false);
      currentLoading[idx] = true;
      return {
        ...prev,
        aiPanelsLoading: currentLoading
      };
    });
    setEditingIndex(null);

    try {
      const description = customPrompts[idx] !== undefined 
        ? customPrompts[idx] 
        : (state.script?.[idx]?.visualDescription || `Scene ${idx + 1}`);

      const frozenOptions = {
        ...options,
        panelCount: finalPanelCount,
        sceneRatio: finalSceneRatio,
      };

      const panelUrl = await generateScenePanel(state.storyboardImage, idx, description, state, frozenOptions);
      
      setState(prev => {
        const currentPanels = prev.aiPanels ? [...prev.aiPanels] : Array(finalPanelCount).fill(null);
        const currentLoading = prev.aiPanelsLoading ? [...prev.aiPanelsLoading] : Array(finalPanelCount).fill(false);
        currentPanels[idx] = panelUrl;
        currentLoading[idx] = false;
        return {
          ...prev,
          aiPanels: currentPanels,
          aiPanelsLoading: currentLoading
        };
      });
    } catch (panelError: any) {
      console.error(`Error splitting panel ${idx + 1}:`, panelError);
      setState(prev => {
        const currentLoading = prev.aiPanelsLoading ? [...prev.aiPanelsLoading] : Array(finalPanelCount).fill(false);
        currentLoading[idx] = false;
        return {
          ...prev,
          aiPanelsLoading: currentLoading,
          error: `Lỗi tạo lại Panel S${idx + 1}: ${panelError.message}`
        };
      });
    }
  };

  const getCroppedPanelBase64 = async (index: number): Promise<string> => {
    const imageUrl = state.storyboardImage;
    if (!imageUrl) throw new Error("Không có ảnh storyboard.");
    
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imageUrl;
    
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not get canvas context");

    const C_W = img.width;
    const C_H = img.height;

    const finalPanelCount = state.generatedPanelCount ?? options.panelCount;
    const { rows: gridRows, cols: gridCols } = getGridLayout(finalPanelCount);

    const P_W = C_W / gridCols;
    const P_H = C_H / gridRows;

    const rowIndex = Math.floor(index / gridCols);
    const colIndex = index % gridCols;

    const cropX = colIndex * P_W;
    const cropY = rowIndex * P_H;
    const cropWidth = P_W;
    const cropHeight = P_H;

    canvas.width = cropWidth;
    canvas.height = cropHeight;

    ctx.drawImage(
      img,
      cropX, cropY, cropWidth, cropHeight,
      0, 0, cropWidth, cropHeight
    );

    const dataUrl = canvas.toDataURL('image/png');
    return dataUrl.split(',')[1];
  };

  const handleGenerateVideo = async (idx: number) => {
    const finalSceneRatio = state.generatedSceneRatio ?? options.sceneRatio;

    setVideoLoading(prev => ({ ...prev, [idx]: true }));
    setVideoErrors(prev => ({ ...prev, [idx]: "" }));

    try {
      let base64Image = "";
      const aiImage = state.aiPanels?.[idx];

      if (aiImage) {
        if (aiImage.includes(",")) {
          base64Image = aiImage.split(",")[1];
        } else {
          base64Image = aiImage;
        }
      } else {
        base64Image = await getCroppedPanelBase64(idx);
      }

      const veoPrompt = state.veoPrompts?.[idx];
      if (!veoPrompt) {
        throw new Error("Không tìm thấy prompt tương ứng cho cảnh này.");
      }

      console.log(`Sending video generation request for panel ${idx + 1}...`);
      const targetUrl = useLocalApi ? localApiUrl : "/api/generate-video";
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          prompt: veoPrompt,
          base64Images: [base64Image],
          aspectRatio: finalSceneRatio,
          videoModelKey: "veo_3_1_i2v_lite_low_priority"
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Server API returned HTTP ${response.status}: ${errText}`);
      }

      const resData = await response.json();
      if (!resData.success || !resData.video?.base64) {
        throw new Error(resData.error || "Không nhận được video base64 từ service.");
      }

      const videoDataUrl = `data:video/mp4;base64,${resData.video.base64}`;
      setVideoUrls(prev => ({ ...prev, [idx]: videoDataUrl }));
    } catch (err: any) {
      console.error(`Error generating video for panel ${idx + 1}:`, err);
      setVideoErrors(prev => ({ ...prev, [idx]: err.message || "Lỗi không xác định khi tạo video." }));
    } finally {
      setVideoLoading(prev => ({ ...prev, [idx]: false }));
    }
  };

  const downloadPanel = async (index: number, overrideUrl?: string) => {
    const imageUrl = overrideUrl || state.storyboardImage;
    if (!imageUrl) return;
    
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imageUrl;
    
    await new Promise((resolve) => {
      img.onload = resolve;
    });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const C_W = img.width;
    const C_H = img.height;

    // Use current grid layout specs to slice perfectly
    const finalPanelCount = state.generatedPanelCount ?? options.panelCount;
    const { rows: gridRows, cols: gridCols } = getGridLayout(finalPanelCount);

    const P_W = C_W / gridCols;
    const P_H = C_H / gridRows;

    const rowIndex = Math.floor(index / gridCols);
    const colIndex = index % gridCols;

    const cropX = colIndex * P_W;
    const cropY = rowIndex * P_H;
    const cropWidth = P_W;
    const cropHeight = P_H;

    canvas.width = cropWidth;
    canvas.height = cropHeight;

    ctx.drawImage(
      img,
      cropX, cropY, cropWidth, cropHeight,
      0, 0, cropWidth, cropHeight
    );

    const link = document.createElement('a');
    link.download = `panel-${index + 1}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const downloadAllPanels = async (overrideUrl?: string) => {
    const finalPanelCount = state.generatedPanelCount ?? options.panelCount;
    for (let i = 0; i < finalPanelCount; i++) {
        const aiImage = state.aiPanels?.[i];
        if (aiImage) {
          const link = document.createElement('a');
          link.download = `panel-${i + 1}-ai.png`;
          link.href = aiImage;
          link.click();
        } else {
          await downloadPanel(i, overrideUrl);
        }
        // Small delay to ensure browser handles multiple downloads
        await new Promise(r => setTimeout(r, 300));
    }
  };

  const useMock = () => {
    setState({
      ...state,
      ...MOCK_DATA,
      isLoading: false,
      error: null,
      generatedPanelCount: 3,
      generatedSceneRatio: "9:16"
    } as AppState);
  };

  const getPanelPreviewStyle = (index: number) => {
    const finalPanelCount = state.generatedPanelCount ?? options.panelCount;
    const { rows: gridRows, cols: gridCols } = getGridLayout(finalPanelCount);

    const rowIndex = Math.floor(index / gridCols);
    const colIndex = index % gridCols;

    const bgWidthPercent = gridCols * 100;
    const bgHeightPercent = gridRows * 100;

    const bgPosX = gridCols > 1 ? (colIndex / (gridCols - 1)) * 100 : 0;
    const bgPosY = gridRows > 1 ? (rowIndex / (gridRows - 1)) * 100 : 0;

    return {
      backgroundImage: `url(${state.storyboardImage})`,
      backgroundSize: `${bgWidthPercent}% ${bgHeightPercent}%`,
      backgroundPosition: `${bgPosX}% ${bgPosY}%`,
      backgroundRepeat: 'no-repeat' as const,
    };
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased flex flex-col">
      {/* Header */}
      <header className="h-16 px-6 border-b bg-white border-slate-200 shadow-sm z-10 sticky top-0">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded flex items-center justify-center">
              <Camera className="h-4 w-4 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-800">
              AI Fashion <span className="text-indigo-600">Storyboard</span>
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 px-3 py-1 bg-slate-100 rounded-full text-[10px] font-bold uppercase tracking-wider text-slate-500">
              <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span> Gemini Connected
            </div>
            <button 
              onClick={useMock}
              className="text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-indigo-600 transition-colors cursor-pointer"
            >
              Demo
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col lg:flex-row overflow-hidden">
        {/* Left Column: Controls (Sidebar style) */}
        <aside className="w-full lg:w-80 flex flex-col border-b lg:border-b-0 lg:border-r border-slate-200 bg-white p-6 gap-6 overflow-y-auto">
          <section>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 block">Tải ảnh sản phẩm (Gửi nhiều hình)</label>
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-4 text-center hover:border-indigo-400 focus-within:border-indigo-400 cursor-pointer transition-colors bg-slate-50 relative group">
              {images.length > 0 ? (
                <div className="grid grid-cols-3 gap-2 mb-3">
                  {images.map((img, i) => (
                    <div key={i} className="relative aspect-square rounded-lg overflow-hidden border border-slate-200 group/item">
                      <img src={img} alt="Product" className="h-full w-full object-cover" />
                      <button 
                        onClick={() => setImages(images.filter((_, idx) => idx !== i))}
                        className="absolute inset-0 bg-red-500/80 flex items-center justify-center opacity-0 group-hover/item:opacity-100 transition-opacity cursor-pointer"
                        title="Xóa hình này"
                      >
                        <AlertCircle className="h-4 w-4 text-white" />
                      </button>
                    </div>
                  ))}
                  <label className="aspect-square flex cursor-pointer flex-col items-center justify-center rounded-lg bg-white border border-slate-200 hover:bg-slate-50 transition-colors">
                    <span className="text-xl text-slate-300 font-light">+</span>
                    <input type="file" className="hidden" multiple onChange={handleImageUpload} accept="image/*" />
                  </label>
                </div>
              ) : (
                <label id="upload" className="block cursor-pointer py-4">
                  <Upload className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                  <p className="text-xs font-semibold text-slate-500">Nhấn hoặc kéo nhiều hình vào đây</p>
                  <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-wider">Mô tả sản phẩm càng chi tiết càng tốt</p>
                  <input type="file" className="hidden" multiple onChange={handleImageUpload} accept="image/*" />
                </label>
              )}
              {images.length > 0 && (
                <button 
                  onClick={() => setImages([])}
                  className="mt-2 text-[10px] font-bold text-red-400 uppercase tracking-widest hover:text-red-500 transition-colors cursor-pointer"
                >
                  Xóa tất cả
                </button>
              )}
            </div>
          </section>

          <section>
            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 block">Upload Review Model (Identity Reference)</label>
            <div className="border-2 border-dashed border-slate-200 rounded-xl p-4 text-center hover:border-indigo-400 focus-within:border-indigo-400 cursor-pointer transition-colors bg-slate-50 relative group">
              {options.modelImage ? (
                <div className="relative aspect-[3/4] rounded-lg overflow-hidden border border-slate-200 group/model">
                  <img src={options.modelImage} alt="Model Reference" className="h-full w-full object-cover" />
                  <button 
                    onClick={() => setOptions(prev => ({ ...prev, modelImage: null }))}
                    className="absolute inset-0 bg-red-500/80 flex items-center justify-center opacity-0 group-hover/model:opacity-100 transition-opacity cursor-pointer"
                  >
                    <AlertCircle className="h-5 w-5 text-white" />
                  </button>
                </div>
              ) : (
                <label className="block cursor-pointer py-2">
                  <Camera className="h-6 w-6 text-slate-300 mx-auto mb-1" />
                  <p className="text-[10px] font-bold text-slate-500 uppercase">Chọn ảnh chân dung Model</p>
                  <input type="file" className="hidden" onChange={handleModelUpload} accept="image/*" />
                </label>
              )}
            </div>
          </section>

          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Loại sản phẩm (Auto-detected)</label>
              <input 
                type="text" 
                value={options.category}
                onChange={(e) => setOptions({ ...options, category: e.target.value })}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all"
                placeholder="Ví dụ: Giày Sneaker Minimalism"
              />
            </div>

            <div className="space-y-1 pt-2">
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-xs font-medium text-slate-600">Tạo người mẫu Việt</span>
                <button 
                  onClick={() => setOptions({ ...options, useVietnameseModel: !options.useVietnameseModel })}
                  className={`w-9 h-5 rounded-full relative flex items-center px-1 transition-colors cursor-pointer ${options.useVietnameseModel ? 'bg-indigo-600 justify-end' : 'bg-slate-200 justify-start'}`}
                >
                  <span className="w-3 h-3 bg-white rounded-full shadow-sm"></span>
                </button>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-xs font-medium text-slate-600">Không thêm chữ hình</span>
                <button 
                  onClick={() => setOptions({ ...options, noTextInImage: !options.noTextInImage })}
                  className={`w-9 h-5 rounded-full relative flex items-center px-1 transition-colors cursor-pointer ${options.noTextInImage ? 'bg-indigo-600 justify-end' : 'bg-slate-200 justify-start'}`}
                >
                  <span className="w-3 h-3 bg-white rounded-full shadow-sm"></span>
                </button>
              </div>
              <div className="flex items-center justify-between py-2 border-b border-slate-100">
                <span className="text-xs font-medium text-slate-600">Phong cách cuốn hút</span>
                <button 
                  onClick={() => setOptions({ ...options, styleCuonHut: !options.styleCuonHut })}
                  className={`w-9 h-5 rounded-full relative flex items-center px-1 transition-colors cursor-pointer ${options.styleCuonHut ? 'bg-indigo-600 justify-end' : 'bg-slate-200 justify-start'}`}
                >
                  <span className="w-3 h-3 bg-white rounded-full shadow-sm"></span>
                </button>
              </div>
              <div className="space-y-1.5 py-2 border-b border-slate-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600">Tỉ lệ Scene (Aspect Ratio)</span>
                  <span className="text-xs font-bold text-indigo-600">{options.sceneRatio}</span>
                </div>
                <div className="grid grid-cols-5 gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100">
                  {(["9:16", "16:9", "1:1", "4:3", "3:4"] as const).map((r) => (
                    <button
                      key={r}
                      onClick={() => setOptions(prev => ({ ...prev, sceneRatio: r }))}
                      className={`py-1.5 text-[10px] font-bold rounded-lg transition-all focus:outline-none cursor-pointer text-center ${
                        options.sceneRatio === r
                          ? "bg-indigo-600 text-white shadow-sm"
                          : "text-slate-500 hover:text-slate-700 hover:bg-slate-100/50"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2 py-4 border-b border-slate-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-600">Số lượng Panel (Cảnh)</span>
                  <span className="text-xs font-bold text-indigo-600">{options.panelCount}</span>
                </div>
                <input 
                  type="range" 
                  min="2" 
                  max="9" 
                  value={options.panelCount}
                  onChange={(e) => setOptions({ ...options, panelCount: parseInt(e.target.value) })}
                  className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
                />
                <div className="flex justify-between text-[8px] font-bold text-slate-400 uppercase tracking-widest">
                  <span>2 cảnh</span>
                  <span>9 cảnh</span>
                </div>
              </div>

              <div className="space-y-3 py-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-700">Gọi Ngrok / Local API</span>
                  <button 
                    onClick={() => setUseLocalApi(!useLocalApi)}
                    className={`w-9 h-5 rounded-full relative flex items-center px-1 transition-colors cursor-pointer ${useLocalApi ? 'bg-indigo-600 justify-end' : 'bg-slate-200 justify-start'}`}
                  >
                    <span className="w-3 h-3 bg-white rounded-full shadow-sm"></span>
                  </button>
                </div>
                {useLocalApi && (
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">URL API của bạn</label>
                    <input 
                      type="text" 
                      value={localApiUrl}
                      onChange={(e) => setLocalApiUrl(e.target.value)}
                      className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-xs font-mono focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 outline-none transition-all bg-slate-50"
                      placeholder="https://raspiest-unprophetically-wan.ngrok-free.dev/api/generate-video"
                    />
                    <p className="text-[9px] text-slate-400 leading-normal">
                      Trình duyệt sẽ gửi request trực tiếp đến URL Ngrok hoặc Local API đang chạy trên máy tính cá nhân của bạn.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <button 
            id="create-button"
            onClick={generate}
            disabled={state.isLoading}
            className="w-full py-4 bg-slate-900 text-white rounded-xl font-bold text-sm hover:bg-slate-800 disabled:opacity-50 transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-100 cursor-pointer disabled:cursor-not-allowed hover:scale-[1.01] active:scale-[0.99]"
          >
            {state.isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Đang xử lý...
              </>
            ) : (
              <>Tạo storyboard & prompt</>
            )}
          </button>

          {state.error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-100 bg-red-50 p-3 text-[10px] font-medium text-red-500 uppercase tracking-tight">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <p>{state.error}</p>
            </div>
          )}
        </aside>

        {/* Content Area */}
        <section className="flex-1 flex flex-col bg-slate-100 min-w-0">
          <nav className="bg-white border-b border-slate-200 px-6 flex items-center gap-6 sticky top-0 z-10 overflow-x-auto whitespace-nowrap scrollbar-hide">
            {[
              { id: "results", label: "Kết quả Storyboard" },
              { id: "analysis", label: "Chi tiết phân tích" },
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`py-4 text-sm font-bold transition-all border-b-2 focus:outline-none cursor-pointer ${
                  activeTab === tab.id 
                  ? "text-indigo-600 border-indigo-600" 
                  : "text-slate-400 border-transparent hover:text-slate-600"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="flex-1 p-4 lg:p-8 overflow-y-auto">
            <div className="bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden h-full flex flex-col min-h-[600px]">
              <AnimatePresence mode="wait">
                {activeTab === "analysis" && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    key="analysis"
                    className="flex-1 flex flex-col"
                  >
                    <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Phân tích chi tiết</span>
                    </div>
                    <div className="p-8 flex-1">
                      {state.analysis ? (
                        <div className="grid gap-8 sm:grid-cols-2">
                            <Section title="Loại sản phẩm" content={state.analysis.type} />
                            <Section title="Đối tượng (Gender)" content={state.analysis.gender === 'male' ? 'Nam' : state.analysis.gender === 'female' ? 'Nữ' : 'Unisex'} />
                            <Section title="Chất liệu / Màu sắc" content={state.analysis.materials} />
                            <Section title="Điểm nổi bật" content={
                              <div className="grid grid-cols-1 gap-2 mt-2">
                                {state.analysis.highlights.map((h, i) => (
                                  <div key={i} className="flex items-center gap-2 text-sm text-slate-600">
                                    <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full"></div>
                                    {h}
                                  </div>
                                ))}
                              </div>
                            } />
                            <Section title="Phong cách phối đồ" content={state.analysis.styling} />
                            <Section title="Lưu ý quan trọng" content={state.analysis.uncertainties} />
                        </div>
                      ) : <EmptyState message="Vui lòng cung cấp hình ảnh để bắt đầu phân tích." />}
                    </div>
                  </motion.div>
                )}

                {activeTab === "script" && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    key="script"
                    className="flex-1 flex flex-col"
                  >
                    <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Kịch bản Storyboard</span>
                      {state.script && (
                        <button 
                          onClick={() => copyToClipboard(state.script!.map(s => `Panel ${s.id}: ${s.voiceOver}`).join('\n'))}
                          className="px-3 py-1 bg-white border border-slate-200 rounded-lg text-[10px] font-bold uppercase text-slate-500 hover:bg-slate-50"
                        >
                          Sao chép VO
                        </button>
                      )}
                    </div>
                    <div className="p-0 flex-1 overflow-x-auto">
                      {state.script ? (
                        <table className="w-full text-left border-collapse">
                          <thead className="bg-slate-50 border-b border-slate-100">
                            <tr>
                              <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">Panel</th>
                              <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">Voice-over</th>
                              <th className="px-6 py-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">Mô tả cảnh</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-50">
                            {state.script.map((p) => (
                              <tr key={p.id} className="hover:bg-slate-50/30 transition-colors">
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <div className="flex flex-col">
                                    <span className="text-sm font-bold text-slate-700">P{p.id}</span>
                                    <span className="text-[10px] font-medium text-indigo-500 uppercase">{p.duration}</span>
                                  </div>
                                </td>
                                <td className="px-6 py-4 text-sm text-slate-600 leading-relaxed max-w-md">{p.voiceOver}</td>
                                <td className="px-6 py-4">
                                  <div className="space-y-1">
                                    <p className="text-sm text-slate-600 font-medium">{p.visualDescription}</p>
                                    <p className="text-[10px] text-slate-400 uppercase font-bold italic">{p.cameraAction}</p>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : <EmptyState message="Kịch bản chi tiết sẽ hiển thị sau khi khởi tạo." />}
                    </div>
                  </motion.div>
                )}

                {activeTab === "results" && (
                  <motion.div 
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    key="results"
                    className="flex-1 flex flex-col"
                  >
                    <div className="p-4 border-b border-slate-100 bg-slate-50/50 flex justify-between items-center sticky top-0 z-[1]">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Kết quả Storyboard & Prompts</span>
                      {state.storyboardImage && (
                        <div className="flex gap-2">
                           <button 
                            id="copy-prompt"
                             onClick={() => copyToClipboard(state.veoPrompts.map(p => p.replace(/\n/g, ' ')).join('\n\n'))}
                             className="px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-[10px] font-bold uppercase text-indigo-600 hover:bg-slate-50 flex items-center gap-2 cursor-pointer transition-colors"
                           >
                              <Copy className="h-3 w-3" /> Sao chép tất cả prompt
                           </button>
                           <button 
                             id="down-img"
                             onClick={downloadAllPanels}
                             className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-[10px] font-bold uppercase hover:bg-indigo-700 flex items-center gap-2 shadow-sm cursor-pointer transition-colors"
                           >
                              <Download className="h-3 w-3" /> Tải tất cả panel
                           </button>
                        </div>
                      )}
                    </div>
                    <div className="p-6 lg:p-10 space-y-12">
                      {state.storyboardImage ? (
                        <div className="w-full space-y-12">
                           {/* Main Storyboard */}
                           <section className="space-y-4">
                             <div className="flex items-center justify-between">
                               <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                                 <ImageIcon className="h-4 w-4 text-indigo-500" /> Storyboard Tổng Thể (16:9)
                               </h3>
                               <a 
                                 href={state.storyboardImage} 
                                 download="storyboard-full.png"
                                 className="text-[10px] font-bold text-indigo-600 uppercase hover:underline"
                               >
                                 Tải ảnh gốc
                               </a>
                             </div>
                             <div className="w-full aspect-video bg-white shadow-2xl rounded-2xl border-4 border-white overflow-hidden ring-1 ring-slate-200 group relative">
                                <img src={state.storyboardImage} alt="Final Storyboard" className="w-full h-full object-contain bg-slate-50" />
                                <div className="absolute top-4 left-4">
                                  <div className="px-2 py-1 bg-black/60 text-white text-[8px] font-bold rounded uppercase tracking-widest backdrop-blur-sm shadow-sm">
                                    {finalPanelCount} Panels Horizontal
                                  </div>
                                </div>
                             </div>
                           </section>

                           {/* Separated Panels */}
                           <section className="space-y-4">
                              <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                                <Video className="h-4 w-4 text-indigo-500" /> Tách {finalSceneRatio} Panels cho Veo 3
                              </h3>
                              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                                 {Array.from({ length: finalPanelCount }).map((_, i) => {
                                   const aiImage = state.aiPanels?.[i];
                                   const isAiLoading = state.aiPanelsLoading?.[i];

                                   return (
                                     <div key={i} className="flex flex-col gap-3 group">
                                       <div className="rounded-2xl overflow-hidden border-2 border-slate-200 bg-white shadow-sm group-hover:border-indigo-400 transition-all relative" style={{ aspectRatio: finalSceneRatio.replace(':', '/') }}>
                                         {videoLoading[i] ? (
                                           <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-slate-200 p-4 gap-2">
                                             <Loader2 className="h-8 w-8 animate-spin text-indigo-400" />
                                             <span className="text-[10px] font-bold text-center uppercase tracking-wider">Đang tạo Video...</span>
                                             <span className="text-[8px] text-slate-400 text-center">(Mất khoảng 1-2 phút)</span>
                                           </div>
                                         ) : videoUrls[i] ? (
                                           <video 
                                             src={videoUrls[i]} 
                                             className="w-full h-full object-cover bg-slate-900"
                                             autoPlay
                                             loop
                                             muted
                                             controls
                                             playsInline
                                           />
                                         ) : isAiLoading ? (
                                           <div className="w-full h-full flex flex-col items-center justify-center bg-slate-50 text-slate-400 p-4 gap-2">
                                             <Loader2 className="h-6 w-6 animate-spin text-indigo-500" />
                                             <span className="text-[10px] font-bold text-center uppercase tracking-wide">AI đang tách panel S{i+1}...</span>
                                           </div>
                                         ) : aiImage ? (
                                           <img 
                                             src={aiImage} 
                                             alt={`Panel ${i + 1}`} 
                                             className="w-full h-full object-cover bg-slate-50"
                                             referrerPolicy="no-referrer"
                                           />
                                         ) : (
                                           <div 
                                             className="w-full h-full"
                                             style={{
                                               backgroundImage: `url(${state.storyboardImage})`,
                                               ...getPanelPreviewStyle(i),
                                               backgroundRepeat: 'no-repeat'
                                             }}
                                           ></div>
                                         )}
                                         
                                         {!videoLoading[i] && (
                                           <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white gap-2">
                                             {videoUrls[i] ? (
                                               <>
                                                 <button 
                                                   onClick={() => {
                                                     const link = document.createElement('a');
                                                     link.download = `video-panel-${i + 1}.mp4`;
                                                     link.href = videoUrls[i];
                                                     link.click();
                                                   }}
                                                   className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 cursor-pointer"
                                                 >
                                                   <Download className="h-3.5 w-3.5" /> Tải Video MP4
                                                 </button>
                                                 <button 
                                                   onClick={() => {
                                                     setVideoUrls(prev => {
                                                       const next = { ...prev };
                                                       delete next[i];
                                                       return next;
                                                     });
                                                   }}
                                                   className="px-3 py-1.5 bg-red-600/80 hover:bg-red-700 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 cursor-pointer mt-1"
                                                 >
                                                   Xóa Video
                                                 </button>
                                               </>
                                             ) : (
                                               <>
                                                 <button 
                                                   onClick={async () => {
                                                     if (aiImage) {
                                                       const link = document.createElement('a');
                                                       link.download = `panel-${i + 1}-ai.png`;
                                                       link.href = aiImage;
                                                       link.click();
                                                     } else {
                                                       await downloadPanel(i);
                                                     }
                                                   }}
                                                   className="px-3 py-1.5 bg-slate-800/80 hover:bg-slate-800 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 cursor-pointer"
                                                 >
                                                   <Download className="h-3.5 w-3.5" /> {aiImage ? "Tải Panel AI" : "Tải Panel Crop"}
                                                 </button>
                                                 
                                                 <button 
                                                   onClick={() => handleGenerateVideo(i)}
                                                   className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 cursor-pointer mt-1"
                                                 >
                                                   <Video className="h-3.5 w-3.5" /> Tạo Video
                                                 </button>
                                               </>
                                             )}
                                           </div>
                                         )}
                                       </div>
                                       <div className="flex flex-col items-center text-center w-full">
                                         <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5 justify-center">
                                           Panel {i + 1}
                                         </span>
                                         <span className="text-[9px] text-slate-400 font-medium pb-2">({finalSceneRatio} Ratio)</span>

                                         {videoErrors[i] && (
                                           <div className="w-full text-left text-[9px] font-semibold text-red-500 bg-red-50 border border-red-100 p-2 rounded-xl mb-2 flex items-start gap-1">
                                             <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                                             <span>{videoErrors[i]}</span>
                                           </div>
                                         )}

                                         {editingIndex === i ? (
                                           <div className="w-full text-left space-y-2 bg-slate-50 p-2.5 rounded-xl border border-indigo-200 shadow-sm">
                                             <div className="flex items-center justify-between">
                                               <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Sửa mô tả bối cảnh</span>
                                               <span className="text-[9px] bg-indigo-50 text-indigo-600 font-bold px-1 py-0.5 rounded uppercase">Cảnh {i+1}</span>
                                             </div>
                                             <textarea
                                               value={customPrompts[i] !== undefined ? customPrompts[i] : (state.script?.[i]?.visualDescription || "")}
                                               onChange={(e) => setCustomPrompts(prev => ({ ...prev, [i]: e.target.value }))}
                                               className="w-full text-[11px] leading-relaxed bg-white border border-slate-200 rounded-lg p-2 focus:ring-1 focus:ring-indigo-500 focus:outline-none focus:border-indigo-500 font-medium text-slate-600 resize-none h-20"
                                               placeholder="Nhập mô tả cụ thể bối cảnh/hành động..."
                                             />
                                             <div className="flex justify-end gap-1.5">
                                               <button
                                                 onClick={() => setEditingIndex(null)}
                                                 className="px-2.5 py-1 bg-slate-200 hover:bg-slate-300 rounded text-[9px] font-extrabold uppercase tracking-wide text-slate-600 cursor-pointer transition-colors"
                                               >
                                                 Hủy
                                               </button>
                                               <button
                                                 onClick={() => handleRegeneratePanel(i)}
                                                 disabled={isAiLoading}
                                                 className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded text-[9px] font-extrabold uppercase tracking-wide cursor-pointer transition-colors flex items-center gap-1"
                                               >
                                                 <Sparkles className="h-2.5 w-2.5 animate-pulse" /> Tạo lại
                                               </button>
                                             </div>
                                           </div>
                                         ) : (
                                           <div className="w-full text-left text-[11px] text-slate-500 bg-slate-50 hover:bg-slate-100/70 p-2.5 rounded-xl border border-slate-200/60 flex flex-col justify-between gap-2.5 transition-colors group/prompt min-h-[76px]">
                                             <p className="line-clamp-2 leading-relaxed text-slate-600 font-medium italic">
                                               "{customPrompts[i] !== undefined ? customPrompts[i] : (state.script?.[i]?.visualDescription || `Scene ${i+1}`)}"
                                             </p>
                                             <div className="flex items-center justify-between mt-1">
                                               <button
                                                 onClick={() => {
                                                   if (customPrompts[i] === undefined) {
                                                     setCustomPrompts(prev => ({ ...prev, [i]: state.script?.[i]?.visualDescription || "" }));
                                                   }
                                                   setEditingIndex(i);
                                                 }}
                                                 className="text-[9px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 cursor-pointer"
                                               >
                                                 <Edit className="h-2.5 w-2.5" /> Sửa prompt
                                               </button>
                                               
                                               {!videoUrls[i] ? (
                                                 <button
                                                   onClick={() => handleGenerateVideo(i)}
                                                   disabled={videoLoading[i]}
                                                   className="text-[9px] font-bold text-emerald-600 hover:text-emerald-800 disabled:text-slate-400 flex items-center gap-1 cursor-pointer"
                                                 >
                                                   {videoLoading[i] ? (
                                                     <>
                                                       <Loader2 className="h-2.5 w-2.5 animate-spin" /> Đang tạo...
                                                     </>
                                                   ) : (
                                                     <>
                                                       <Video className="h-2.5 w-2.5" /> Tạo Video
                                                     </>
                                                   )}
                                                 </button>
                                               ) : (
                                                 <button
                                                   onClick={() => {
                                                     const link = document.createElement('a');
                                                     link.download = `video-panel-${i + 1}.mp4`;
                                                     link.href = videoUrls[i];
                                                     link.click();
                                                   }}
                                                   className="text-[9px] font-bold text-indigo-600 hover:text-indigo-800 flex items-center gap-1 cursor-pointer"
                                                 >
                                                   <Download className="h-2.5 w-2.5" /> Tải Video
                                                 </button>
                                               )}
                                             </div>
                                           </div>
                                         )}
                                       </div>
                                     </div>
                                   );
                                 })}
                              </div>
                            </section>

                           {/* Veo 3 Prompts */}
                           <section className="space-y-4 pt-6 border-t border-slate-100">
                             <div className="flex items-center justify-between">
                               <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                                 <FileText className="h-4 w-4 text-indigo-500" /> Prompt Veo 3 tương ứng
                               </h3>
                               <button 
                                 onClick={() => copyToClipboard(state.veoPrompts.map(p => p.replace(/\n/g, ' ')).join('\n\n'))}
                                 className="text-[10px] font-bold text-indigo-600 uppercase hover:underline cursor-pointer"
                               >
                                 Sao chép tất cả
                               </button>
                             </div>
                             <div className="bg-slate-50 rounded-2xl p-6 border border-slate-200 focus-within:border-indigo-300 transition-colors">
                               <div className="space-y-6">
                                  {state.veoPrompts.map((p, i) => {
                                    const cleanPrompt = p.replace(/\n/g, ' ');
                                    return (
                                      <div key={i} className="space-y-2">
                                        <div className="flex items-center justify-between">
                                          <span className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">Panel {i + 1} Prompt</span>
                                          <button onClick={() => copyToClipboard(cleanPrompt)} className="p-1 hover:text-indigo-600 text-slate-300 cursor-pointer transition-colors">
                                            <Copy className="h-3 w-3" />
                                          </button>
                                        </div>
                                        <p className="text-sm text-slate-600 leading-relaxed font-mono bg-white p-3 rounded-lg border border-slate-100 shadow-sm whitespace-nowrap overflow-x-auto">
                                          {cleanPrompt}
                                        </p>
                                      </div>
                                    );
                                  })}
                               </div>
                             </div>
                             <div className="p-4 rounded-xl border border-amber-100 bg-amber-50/50 text-amber-700 text-[10px] font-medium leading-relaxed">
                                * Hướng dẫn: Sử dụng ảnh Panel tương ứng làm Start Frame trong Veo 3 và dán prompt này vào để tạo video đồng nhất.
                             </div>
                           </section>

                           {/* Script Table Included here for convenience */}
                           <section className="space-y-4 pt-6 border-t border-slate-100">
                             <div className="flex items-center justify-between">
                               <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                                 <FileText className="h-4 w-4 text-indigo-500" /> Kịch bản & Voice-over
                               </h3>
                             </div>
                             <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                                <table className="w-full text-left border-collapse">
                                  <thead className="bg-slate-50/80 border-b border-slate-100">
                                    <tr>
                                      <th className="px-6 py-4 text-[9px] font-bold uppercase tracking-widest text-slate-400">P.</th>
                                      <th className="px-6 py-4 text-[9px] font-bold uppercase tracking-widest text-slate-400">Voice-over</th>
                                      <th className="px-6 py-4 text-[9px] font-bold uppercase tracking-widest text-slate-400">Ghi chú quay</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-slate-50">
                                    {state.script!.map((p) => (
                                      <tr key={p.id} className="hover:bg-slate-50/30 transition-colors">
                                        <td className="px-6 py-4 whitespace-nowrap text-xs font-bold text-slate-700">P{p.id}</td>
                                        <td className="px-6 py-4 text-xs text-slate-600 leading-relaxed italic">"{p.voiceOver}"</td>
                                        <td className="px-6 py-4">
                                          <p className="text-[10px] text-slate-500 font-medium">{p.visualDescription}</p>
                                          <p className="text-[8px] text-slate-400 uppercase font-bold">{p.cameraAction}</p>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                             </div>
                           </section>
                        </div>
                      ) : <EmptyState message={`Đang chờ tạo dữ liệu cho ${options.panelCount} panels...`} />}
                    </div>
                  </motion.div>
                )}

              </AnimatePresence>
            </div>
          </div>
        </section>
      </main>
    </div>

  );
}

function Section({ title, content }: { title: string; content: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-bold uppercase tracking-wider text-gray-400">{title}</h4>
      <div className="text-sm text-gray-700 font-medium">{content}</div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-gray-400">
      <div className="mb-4 rounded-full bg-gray-50 p-4">
        <Loader2 id="loading" className="h-10 w-10 opacity-20" />
      </div>
      <p className="text-sm text-center max-w-[200px]">{message}</p>
    </div>
  );
}
