/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ProductAnalysis {
  type: string;
  materials: string;
  highlights: string[];
  styling: string;
  uncertainties: string;
  gender: 'male' | 'female' | 'unisex';
}

export interface ScriptPanel {
  id: number;
  duration: string;
  voiceOver: string;
  goal: string;
  visualDescription: string;
  cameraAction: string;
}

export interface AppState {
  analysis: ProductAnalysis | null;
  script: ScriptPanel[] | null;
  frameData: string;
  cropperPrompt: string;
  veoPrompts: string[];
  storyboardImage: string | null;
  aiPanels?: (string | null)[];
  aiPanelsLoading?: boolean[];
  generatedPanelCount?: number;
  generatedSceneRatio?: '9:16' | '16:9' | '1:1' | '4:3' | '3:4';
  isLoading: boolean;
  error: string | null;
}

export interface GeneratorOptions {
  category: string;
  useVietnameseModel: boolean;
  noTextInImage: boolean;
  styleCuonHut: boolean;
  panelCount: number;
  sceneRatio: '9:16' | '16:9' | '1:1' | '4:3' | '3:4';
  modelImage?: string | null;
}

export function getGridLayout(panelCount: number): { rows: number; cols: number } {
  switch (panelCount) {
    case 1: return { rows: 1, cols: 1 };
    case 2: return { rows: 1, cols: 2 };
    case 3: return { rows: 1, cols: 3 };
    case 4: return { rows: 2, cols: 2 };
    case 5: return { rows: 2, cols: 3 };
    case 6: return { rows: 2, cols: 3 };
    case 7: return { rows: 3, cols: 3 };
    case 8: return { rows: 3, cols: 3 };
    case 9: return { rows: 3, cols: 3 };
    default:
      if (panelCount <= 3) return { rows: 1, cols: panelCount };
      if (panelCount === 4) return { rows: 2, cols: 2 };
      if (panelCount <= 6) return { rows: 2, cols: 3 };
      return { rows: 3, cols: 3 };
  }
}

