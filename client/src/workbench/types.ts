export type WorkbenchViewMode = 'preview' | 'code';
export type WorkbenchInteractionMode = 'browse' | 'select' | 'multi-select' | 'region';

export interface WorkbenchCodexContext {
  type: 'code-ai:workbench-context';
  profileId: string | null;
  provider: 'codex' | 'claude' | 'gemini' | null;
  sessionKey: string | null;
  sessionId: string | null;
  routePending: boolean;
  cwd: string | null;
  authenticated: boolean;
  deviceUnlocked: boolean;
}

export interface WorkbenchSelectionMessage {
  type: 'code-ai:workbench-selections';
  selections: WorkbenchElementSelection[];
}

export interface WorkbenchRequestContextMessage {
  type: 'code-ai:workbench-request-context';
}

export interface WorkbenchFocusComposerMessage {
  type: 'code-ai:workbench-focus-composer';
}

export interface WorkbenchClearSelectionsMessage {
  type: 'code-ai:workbench-clear-selections';
}

export type WorkbenchBridgeMessage =
  | WorkbenchCodexContext
  | WorkbenchSelectionMessage
  | WorkbenchRequestContextMessage
  | WorkbenchFocusComposerMessage
  | WorkbenchClearSelectionsMessage;

export interface BrowserTabSummary {
  isCurrent: boolean;
  tabId: number;
  title: string | null;
  url: string | null;
}

export interface BrowserFrameSummary {
  capturedAt: string;
  imageId: string;
  imageUrl: string;
  streamUrl: string | null;
  tabId: number;
}

export interface BrowserElementRect {
  x: number;
  y: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface BrowserSourceHint {
  file: string;
  line: number | null;
  column: number | null;
  component: string | null;
  confidence: number;
  method: string;
}

export interface BrowserInspectedElement {
  tagName: string;
  role: string | null;
  accessibleName: string | null;
  textSnippet: string | null;
  attributes: Record<string, string>;
  rect: BrowserElementRect;
  primarySelector: string;
  selectorCandidates: Array<{ kind: string; value: string; score: number }>;
  framePath: Array<{ selector: string; src: string | null; title: string | null }>;
  shadowPath: string[];
  ancestors: Array<{ tag: string; role: string; selector: string; label: string }>;
  computedStyleSubset: Record<string, string>;
  matchedCssRules: Array<{
    selector: string;
    sourceUrl: string | null;
    media: string | null;
    declarations: Record<string, string>;
  }>;
  sourceHint: BrowserSourceHint | null;
  sensitive: boolean;
  domFingerprint: string;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
    scrollX: number;
    scrollY: number;
  };
  htmlSnippet?: string | null;
  nearbyText?: string | null;
  semanticPath?: string[];
  componentHints?: string[];
  interaction?: {
    clickable: boolean;
    editable: boolean;
    disabled: boolean;
    checked: boolean | null;
    expanded: boolean | null;
    selected: boolean | null;
    required: boolean;
    href: string | null;
    inputType: string | null;
  };
}

export interface BrowserRegionContext {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  viewport: BrowserInspectedElement['viewport'];
  textSnippet: string | null;
  elementCount: number;
  elements: Array<{
    tagName: string;
    role: string | null;
    accessibleName: string | null;
    textSnippet: string | null;
    primarySelector: string;
    rect: BrowserElementRect;
  }>;
}

export interface WorkbenchElementSelection {
  selectionId: string;
  origin?: 'workbench' | 'personal_chrome';
  kind?: 'element' | 'region';
  tabId: number;
  url: string | null;
  title: string | null;
  capturedAt: string;
  screenshotImageId: string | null;
  screenshotUrl: string | null;
  cropImageId: string | null;
  cropUrl: string | null;
  element: BrowserInspectedElement;
  region?: BrowserRegionContext | null;
}

export interface BrowserViewerState {
  currentTabId: number | null;
  currentTitle: string | null;
  currentUrl: string | null;
  frame: BrowserFrameSummary | null;
  headless: boolean;
  profileDir: string;
  sessionKey: string;
  tabs: BrowserTabSummary[];
  selection?: WorkbenchElementSelection | null;
}

export interface BrowserViewportPreset {
  id: 'desktop' | 'tablet' | 'mobile';
  label: string;
  width: number;
  height: number;
}
