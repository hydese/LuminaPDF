import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { open as openExternalUrl } from "@tauri-apps/plugin-shell";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import {
  cloneAnnotations,
  DocumentAnnotations,
  hitTestAnnotation,
  MarkupKind,
  pageToScreenCoords,
  PdfRect,
  renderPageAnnotationsCanvas,
  screenToPageCoords,
  StrokePoint,
  StudyTool,
} from "./annotationLayer";
import {
  AgmTileCacheManager,
  computeVisibleTilesPriorityQueue,
  instrumentContextWithAgmVectorPipeline,
  selectPyramidLod,
} from "./agmPipeline";
import {
  BackgroundPreset,
  classifyImageRegion,
  computeLowZoomBoost,
  DarkModeConfig,  DarkRenderingStrategy,
  downsample2xWithCoolTypeFir,
  getTargetBackgroundRgb,
  ImageClassificationReport,
  instrumentCanvasForPhotographDetection,
  isAutoHybridDefaultConfig,
  PixelBoundingBox,
  resetConfigToAutoHybrid,
  transformBufferToDarkFast,
} from "./darkModeEngine";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfPageGeometry {
  page_number: number;
  width_pt: number;
  height_pt: number;
  rotation_deg: number;
}

interface PdfDocumentMetadata {
  path: string;
  file_name: string;
  file_size_bytes: number;
  content_sha256: string;
  pdf_version: string;
  page_count: number;
  title: string | null;
  author: string | null;
  is_encrypted: boolean;
  page_geometries: PdfPageGeometry[];
}

interface BookmarkEntry {
  id: string;
  page_number: number;
  title: string;
  created_at: string;
}

type PageLayoutMode = "continuous" | "single_page";

interface DocumentReadingState {
  current_page: number;
  scroll_top_ratio: number;
  zoom_scale: number;
  fit_mode: string;
  layout_mode: PageLayoutMode;
  dark_mode_override: DarkModeConfig | null;
}

interface DocumentIdentity {
  content_sha256: string;
  file_size_bytes: number;
  page_count: number;
  last_known_path: string;
  file_name: string;
}

interface DocumentSidecar {
  schema_version: number;
  identity: DocumentIdentity;
  reading_state: DocumentReadingState;
  bookmarks: BookmarkEntry[];
  annotations: DocumentAnnotations;
  write_adjacent_sidecar: boolean;
  updated_at: string;
}

interface SidecarLoadOutcome {
  sidecar: DocumentSidecar;
  recovered_from_backup: boolean;
  matched_moved_file_from: string | null;
  external_modification_warning: string | null;
  previous_modified_hash: string | null;
}

interface OpenedPdfPayload {
  metadata: PdfDocumentMetadata;
  pdf_base64: string;
  sidecar_outcome: SidecarLoadOutcome;
}

interface RecentDocumentEntry {
  path: string;
  file_name: string;
  content_sha256: string;
  last_page: number;
  total_pages: number;
  last_opened_at: string;
}

interface AppSettingsAndSession {
  schema_version: number;
  app_theme: string;
  pen_color_migrated_v104?: boolean;
  dark_mode: DarkModeConfig;
  default_layout: PageLayoutMode;
  default_zoom: number;
  default_fit_mode: string;
  reopen_tabs_on_startup: boolean;
  last_open_tab_paths: string[];
  active_tab_path: string | null;
  recent_documents: RecentDocumentEntry[];
  window_geometry: {
    width: number;
    height: number;
    x: number | null;
    y: number | null;
    maximized: boolean;
  };
  annotation_prefs: {
    active_tool: string;
    pen_color: string;
    pen_width: number;
    highlighter_color: string;
    highlighter_width: number;
    note_color: string;
    eraser_radius: number;
  };
  auto_check_updates: boolean;
  update_manifest_url: string;
  dark_mode_shortcut: string;
}

interface BootstrapPayload {
  app_version: string;
  platform: {
    os_name: string;
    arch: string;
    primary_modifier: string;
    primary_modifier_symbol: string;
    app_data_dir: string;
  };
  settings: AppSettingsAndSession;
  startup_pdf_paths: string[];
  sample_pdf_paths: string[];
}

interface SearchMatch {
  match_index: number;
  page_number: number;
  page_match_index: number;
  char_start: number;
  char_len: number;
  snippet: string;
}

interface SearchQueryResult {
  query: string;
  total_matches: number;
  has_searchable_text: boolean;
  active_match_index: number | null;
  matches: SearchMatch[];
}

interface UpdateCheckResponse {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  release_notes: string;
  pub_date: string;
  download_url: string | null;
  expected_sha256: string | null;
  signature_present: boolean;
  status_message: string;
}

interface OutlineNode {
  title: string;
  pageNumber: number;
}

interface PositionedTextSpan {
  charStart: number;
  charEnd: number;
  pdfRect: [number, number, number, number];
}

interface DocumentTabState {
  id: string;
  metadata: PdfDocumentMetadata;
  sidecar: DocumentSidecar;
  pdfDoc: pdfjsLib.PDFDocumentProxy;
  rotationExtraDeg: number;
  undoStack: DocumentAnnotations[];
  redoStack: DocumentAnnotations[];
  navBackStack: number[];
  navForwardStack: number[];
  outline: OutlineNode[];
  pageTexts: Record<number, string>;
  pageSpans: Record<number, PositionedTextSpan[]>;
  textExtractionDone: boolean;
  searchResult: SearchQueryResult | null;
  renderedCacheOrder: number[];
  activeRenderCancels: Map<number, () => void>;
  renderQueueGeneration: number;
  lastClassification: ImageClassificationReport | null;
  openDurationMs: number;
  firstPageRenderMs: number;
  previousModifiedHash: string | null;
}

const MAX_CACHED_RENDERED_PAGES = 8;

/**
 * Text sharpness preset (Settings): Soft = -0.5, Balanced = 0, Crisp = +0.4. Added to the
 * zoom-dependent low-zoom ink boost in `renderSinglePageSlot`. Stored in localStorage.
 */
const SHARPNESS_BIAS: Record<string, number> = {
  soft: -0.5,
  balanced: 0,
  crisp: 0.4,
};
function readSharpnessPreset(): string {
  try {
    const v = window.localStorage.getItem("lumina_text_sharpness");
    return v && v in SHARPNESS_BIAS ? v : "balanced";
  } catch {
    return "balanced";
  }
}
let sharpnessBias = SHARPNESS_BIAS[readSharpnessPreset()];
const agmTileCache = new AgmTileCacheManager(64);

let appSettings: AppSettingsAndSession;
let samplePdfPaths: string[] = [];
const openTabs: Map<string, DocumentTabState> = new Map();
let activeTabId: string | null = null;
let activeTool: StudyTool = "select";
let annotColor = "#ffffff";
let strokeWidth = 2.5;
let sidecarSaveTimer: number | null = null;
let scrollRenderRaf: number | null = null;
let dmSliderRaf: number | null = null;
let zoomRerenderTimer: number | null = null;
let isProgrammaticScroll = false;
let latestDownloadUrl: string | null = null;
let isAppFullscreen = false;
let toastTimer: number | null = null;

let pendingSnipState: {
  pngDataUrl: string;
  blob: Blob;
  width: number;
  height: number;
  defaultFileName: string;
} | null = null;

function showAppToast(message: string): void {
  const toastEl = document.getElementById("app-toast");
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
  }
  toastTimer = window.setTimeout(() => {
    toastEl.classList.add("hidden");
    toastTimer = null;
  }, 2400);
}

let editingNoteState: {
  tabId: string;
  pageNumber: number;
  noteId: string | null;
  xPt: number;
  yPt: number;
} | null = null;

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getActiveTab(): DocumentTabState | null {
  if (!activeTabId) return null;
  return openTabs.get(activeTabId) || null;
}

function getEffectiveDarkMode(): DarkModeConfig {
  const tab = getActiveTab();
  if (tab && tab.sidecar.reading_state.dark_mode_override) {
    return tab.sidecar.reading_state.dark_mode_override;
  }
  return appSettings.dark_mode;
}

function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/**
 * Returns the exact hardware `devicePixelRatio` so every pixel in `.pdf-render-canvas` maps 1:1
 * to a physical monitor pixel without any fractional CSS bilinear resampling fog.
 */
function getHardwareDpr(): number {
  return window.devicePixelRatio || 1;
}

/**
 * Schedules a debounced atomic save of the active tab's sidecar.
 */
function scheduleSidecarSave(tab: DocumentTabState, immediate = false): void {
  if (sidecarSaveTimer !== null) {
    window.clearTimeout(sidecarSaveTimer);
    sidecarSaveTimer = null;
  }
  const doSave = async () => {
    try {
      await invoke("save_document_sidecar", { sidecar: tab.sidecar });
      const statusAnnot = document.getElementById("status-annot-info");
      if (statusAnnot) {
        statusAnnot.textContent = `Sidecar Saved (${countAllAnnotations(
          tab.sidecar.annotations
        )} annotations • Original PDF untouched)`;
      }
    } catch (err) {
      console.error("Failed to save sidecar:", err);
    }
  };
  if (immediate) {
    void doSave();
  } else {
    sidecarSaveTimer = window.setTimeout(() => {
      void doSave();
    }, 350);
  }
}

function countAllAnnotations(annots: DocumentAnnotations): number {
  let count = 0;
  for (const list of Object.values(annots.pages)) {
    count += list.length;
  }
  return count;
}

async function persistGlobalSettings(): Promise<void> {
  try {
    appSettings.last_open_tab_paths = Array.from(openTabs.values()).map(
      (t) => t.metadata.path
    );
    const active = getActiveTab();
    appSettings.active_tab_path = active ? active.metadata.path : null;
    await invoke("save_app_settings", { settings: appSettings });
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

/**
 * Synchronizes the application shell theme & toolbar controls with current dark mode & tab state.
 */
function syncToolbarAndThemeUI(): void {
  const dm = getEffectiveDarkMode();
  const uiTheme = appSettings?.app_theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", uiTheme);
  const selectUiTheme = document.getElementById(
    "select-app-ui-theme"
  ) as HTMLSelectElement | null;
  if (selectUiTheme) {
    selectUiTheme.value = uiTheme;
  }

  const btnDm = document.getElementById("btn-dark-mode-toggle");
  const labelDm = document.getElementById("label-dark-mode-state");
  const badgeStrategy = document.getElementById("badge-dark-strategy");
  const statusDm = document.getElementById("status-dark-mode");

  const isDarkOn = dm.enabled && dm.strategy !== "original";
  if (btnDm) {
    btnDm.classList.toggle("active", isDarkOn);
    btnDm.setAttribute("aria-pressed", String(isDarkOn));
  }
  if (labelDm) {
    labelDm.textContent = isDarkOn ? "Dark Mode: ON" : "Dark Mode: OFF";
  }

  const strategyNames: Record<DarkRenderingStrategy, string> = {
    auto: "Auto Hybrid",
    semantic_text_vector: "Text & Vector",
    scanned_adaptive: "Scanned B&W",
    scanned_color_preserve: "Scanned Color",
    original: "Original",
  };
  const isAutoDefault = isAutoHybridDefaultConfig(dm);
  if (badgeStrategy) {
    if (isAutoDefault) {
      badgeStrategy.textContent = "Auto Hybrid";
      badgeStrategy.classList.remove("hidden");
    } else {
      badgeStrategy.classList.add("hidden");
    }
  }

  const bgRgb = getTargetBackgroundRgb(dm);
  const bgHex =
    "#" +
    bgRgb.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
  if (statusDm) {
    statusDm.textContent = isDarkOn
      ? `Intelligent Dark Mode: ${strategyNames[dm.strategy]} (${bgHex}, Text ${Math.round(
          dm.text_brightness * 100
        )}%)`
      : "Display: Original PDF Colors";
  }

  (document.getElementById("select-dm-strategy") as HTMLSelectElement).value =
    dm.enabled ? dm.strategy : "original";
  (document.getElementById("select-dm-bg") as HTMLSelectElement).value =
    dm.background_preset;
  (document.getElementById("range-dm-brightness") as HTMLInputElement).value =
    String(dm.text_brightness);
  (document.getElementById("val-dm-brightness") as HTMLElement).textContent = `${Math.round(
    dm.text_brightness * 100
  )}%`;
  (document.getElementById("range-dm-contrast") as HTMLInputElement).value =
    String(dm.contrast_boost);
  (document.getElementById("val-dm-contrast") as HTMLElement).textContent = `${Math.round(
    dm.contrast_boost * 100
  )}%`;
  (document.getElementById("chk-dm-photos") as HTMLInputElement).checked =
    dm.preserve_photographs;
  (document.getElementById("chk-dm-diagrams") as HTMLInputElement).checked =
    dm.preserve_diagram_colors;

  const tab = getActiveTab();
  const pageInput = document.getElementById("input-page-num") as HTMLInputElement;
  const pageTotal = document.getElementById("label-page-total") as HTMLElement;
  const btnPrevPage = document.getElementById("btn-prev-page") as HTMLButtonElement;
  const btnNextPage = document.getElementById("btn-next-page") as HTMLButtonElement;
  const layoutLabel = document.getElementById("label-layout-mode") as HTMLElement;
  const btnBack = document.getElementById("btn-hist-back") as HTMLButtonElement;
  const btnFwd = document.getElementById("btn-hist-forward") as HTMLButtonElement;
  const btnUndo = document.getElementById("btn-undo") as HTMLButtonElement;
  const btnRedo = document.getElementById("btn-redo") as HTMLButtonElement;
  const statusDoc = document.getElementById("status-doc-name") as HTMLElement;
  const statusPerf = document.getElementById("status-perf-metrics") as HTMLElement;
  const selectZoom = document.getElementById("select-zoom") as HTMLSelectElement;

  const fsHud = document.getElementById("fs-floating-hud");
  const fsPageInput = document.getElementById(
    "fs-input-page"
  ) as HTMLInputElement | null;
  const fsPageTotal = document.getElementById("fs-label-total");
  const fsBtnPrev = document.getElementById(
    "fs-btn-prev"
  ) as HTMLButtonElement | null;
  const fsBtnNext = document.getElementById(
    "fs-btn-next"
  ) as HTMLButtonElement | null;
  const fsZoomLabel = document.getElementById("fs-label-zoom");

  if (fsHud) {
    fsHud.classList.toggle("hidden", !(isAppFullscreen && !!tab));
  }

  if (tab) {
    const curPage = tab.sidecar.reading_state.current_page;
    const totalPages = tab.metadata.page_count;
    pageInput.max = String(totalPages);
    pageInput.value = String(curPage);
    pageTotal.textContent = `/ ${totalPages}`;
    if (btnPrevPage) btnPrevPage.disabled = curPage <= 1;
    if (btnNextPage) btnNextPage.disabled = curPage >= totalPages;

    layoutLabel.textContent =
      tab.sidecar.reading_state.layout_mode === "continuous"
        ? "Continuous"
        : "Single Page";
    btnBack.disabled = tab.navBackStack.length === 0;
    btnFwd.disabled = tab.navForwardStack.length === 0;
    btnUndo.disabled = tab.undoStack.length === 0;
    btnRedo.disabled = tab.redoStack.length === 0;
    statusDoc.textContent = `${tab.metadata.file_name} (${totalPages} pages)`;
    statusPerf.textContent = `Open: ${tab.openDurationMs.toFixed(
      0
    )} ms | 1st Page: ${tab.firstPageRenderMs.toFixed(0)} ms | Cached Pages: ${
      tab.renderedCacheOrder.length
    }`;

    const baseGeom = tab.metadata.page_geometries[0];
    const effectiveScale = baseGeom
      ? computeEffectivePageScale(tab, baseGeom)
      : tab.sidecar.reading_state.zoom_scale;
    const effectivePct = Math.round(effectiveScale * 100);

    if (fsPageInput) {
      fsPageInput.max = String(totalPages);
      fsPageInput.value = String(curPage);
    }
    if (fsPageTotal) fsPageTotal.textContent = `/ ${totalPages}`;
    if (fsBtnPrev) fsBtnPrev.disabled = curPage <= 1;
    if (fsBtnNext) fsBtnNext.disabled = curPage >= totalPages;
    if (fsZoomLabel) {
      fsZoomLabel.textContent = `${effectivePct}%`;
      fsZoomLabel.title = "Click to reset zoom (Fit Width)";
    }

    if (tab.sidecar.reading_state.fit_mode === "width") {
      selectZoom.value = "fit-width";
    } else if (tab.sidecar.reading_state.fit_mode === "page") {
      selectZoom.value = "fit-page";
    } else {
      const pct = Math.round(tab.sidecar.reading_state.zoom_scale * 100);
      let customOpt = selectZoom.querySelector<HTMLOptionElement>(
        'option[data-custom-zoom="true"]'
      );
      if (!customOpt) {
        customOpt = document.createElement("option");
        customOpt.dataset.customZoom = "true";
        selectZoom.appendChild(customOpt);
      }
      customOpt.value = String(tab.sidecar.reading_state.zoom_scale);
      customOpt.textContent = `${pct}%`;
      selectZoom.value = customOpt.value;
    }
  } else {
    pageInput.value = "1";
    pageTotal.textContent = "/ 0";
    if (btnPrevPage) btnPrevPage.disabled = true;
    if (btnNextPage) btnNextPage.disabled = true;
    btnBack.disabled = true;
    btnFwd.disabled = true;
    btnUndo.disabled = true;
    btnRedo.disabled = true;
    statusDoc.textContent = "Ready — No PDF Open";
    statusPerf.textContent = "Open: -- ms | Render: -- ms";
  }
}

/**
 * Renders the top tab bar for all open documents.
 */
function renderTabsBar(): void {
  const container = document.getElementById("tabs-container")!;
  container.innerHTML = "";

  for (const tab of openTabs.values()) {
    const tabEl = document.createElement("div");
    tabEl.className = `tab-item${tab.id === activeTabId ? " active" : ""}`;
    tabEl.setAttribute("role", "tab");
    tabEl.setAttribute("aria-selected", String(tab.id === activeTabId));
    tabEl.title = tab.metadata.path;

    const titleSpan = document.createElement("span");
    titleSpan.className = "tab-title";
    titleSpan.textContent = tab.metadata.file_name;

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab-close-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close Tab (Ctrl+W)";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeTab(tab.id);
    });

    tabEl.addEventListener("click", () => {
      switchToTab(tab.id);
    });

    tabEl.appendChild(titleSpan);
    tabEl.appendChild(closeBtn);
    container.appendChild(tabEl);
  }
}

/**
 * Opens a PDF document from disk via the Rust backend, initializes its PDF.js document instance,
 * restores its sidecar state, and switches to its tab.
 */
async function openPdfByPath(filePath: string): Promise<void> {
  const normTarget = filePath.replace(/\//g, "\\").toLowerCase();
  for (const existing of openTabs.values()) {
    if (existing.metadata.path.replace(/\//g, "\\").toLowerCase() === normTarget) {
      switchToTab(existing.id);
      return;
    }
  }

  const t0 = performance.now();
  try {
    const payload = await invoke<OpenedPdfPayload>("open_pdf_document", {
      path: filePath,
    });
    const rawBytes = base64ToUint8Array(payload.pdf_base64);
    const loadingTask = pdfjsLib.getDocument({
      data: rawBytes,
      isEvalSupported: false,
      // Bundled font/CMap data: correct glyphs for non-embedded standard fonts and CJK encodings
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      useSystemFonts: true,
    });
    const pdfDoc = await loadingTask.promise;
    const openDurationMs = performance.now() - t0;

    const tabId = uid("tab");
    const tabState: DocumentTabState = {
      id: tabId,
      metadata: payload.metadata,
      sidecar: payload.sidecar_outcome.sidecar,
      pdfDoc,
      rotationExtraDeg: 0,
      undoStack: [],
      redoStack: [],
      navBackStack: [],
      navForwardStack: [],
      outline: [],
      pageTexts: {},
      pageSpans: {},
      textExtractionDone: false,
      searchResult: null,
      renderedCacheOrder: [],
      activeRenderCancels: new Map(),
      renderQueueGeneration: 0,
      lastClassification: null,
      openDurationMs,
      firstPageRenderMs: 0,
      previousModifiedHash: payload.sidecar_outcome.previous_modified_hash,
    };

    openTabs.set(tabId, tabState);

    const banner = document.getElementById("banner-warning")!;
    const bannerText = document.getElementById("banner-warning-text")!;
    const btnMigrate = document.getElementById("btn-banner-migrate")!;

    if (payload.sidecar_outcome.external_modification_warning) {
      bannerText.textContent =
        payload.sidecar_outcome.external_modification_warning;
      banner.classList.remove("hidden");
      if (payload.sidecar_outcome.previous_modified_hash) {
        btnMigrate.classList.remove("hidden");
      } else {
        btnMigrate.classList.add("hidden");
      }
    } else if (payload.sidecar_outcome.recovered_from_backup) {
      bannerText.textContent =
        "Sidecar annotation file was automatically recovered from the most recent atomic backup.";
      btnMigrate.classList.add("hidden");
      banner.classList.remove("hidden");
    } else {
      banner.classList.add("hidden");
    }

    const bootstrap = await invoke<BootstrapPayload>("get_app_bootstrap_state");
    appSettings.recent_documents = bootstrap.settings.recent_documents;

    switchToTab(tabId);
    void persistGlobalSettings();

    void loadDocumentOutline(tabState);
    void extractDocumentTextInBackground(tabState);
  } catch (err) {
    alert(`Unable to open PDF:\n${String(err)}`);
  }
}

async function loadDocumentOutline(tab: DocumentTabState): Promise<void> {
  try {
    const rawOutline = await tab.pdfDoc.getOutline();
    const nodes: OutlineNode[] = [];
    if (rawOutline && rawOutline.length > 0) {
      const walk = async (items: typeof rawOutline, depth = 0) => {
        for (const item of items) {
          let pageNum = 1;
          try {
            let dest = item.dest;
            if (typeof dest === "string") {
              dest = await tab.pdfDoc.getDestination(dest);
            }
            if (Array.isArray(dest) && dest[0]) {
              const pageIdx = await tab.pdfDoc.getPageIndex(dest[0]);
              pageNum = pageIdx + 1;
            }
          } catch {
            pageNum = 1;
          }
          const prefix = depth > 0 ? "  ".repeat(depth) + "↳ " : "";
          nodes.push({ title: `${prefix}${item.title}`, pageNumber: pageNum });
          if (item.items && item.items.length > 0) {
            await walk(item.items, depth + 1);
          }
        }
      };
      await walk(rawOutline, 0);
    }
    tab.outline = nodes;
    if (activeTabId === tab.id) {
      renderSidebarPanels();
    }
  } catch {
    tab.outline = [];
  }
}

async function extractSinglePageTextAndSpans(
  tab: DocumentTabState,
  p: number
): Promise<void> {
  if (tab.pageTexts[p] !== undefined) return;
  try {
    const page = await tab.pdfDoc.getPage(p);
    const tc = await page.getTextContent();
    const spans: PositionedTextSpan[] = [];
    let fullText = "";

    for (const item of tc.items) {
      if (!("str" in item)) continue;
      const str = item.str;
      if (!str) continue;

      if (fullText.length > 0) {
        fullText += " ";
      }
      const charStart = fullText.length;
      fullText += str;
      const charEnd = fullText.length;

      const tr = item.transform;
      const tx = Number(tr?.[4]) || 0;
      const ty = Number(tr?.[5]) || 0;
      const fontH = Math.max(
        8,
        Math.hypot(Number(tr?.[2]) || 0, Number(tr?.[3]) || 12)
      );
      const w = Math.max(4, Number(item.width) || str.length * fontH * 0.5);
      spans.push({
        charStart,
        charEnd,
        pdfRect: [tx, ty - fontH * 0.22, tx + w, ty + fontH * 0.88],
      });
    }

    tab.pageTexts[p] = fullText;
    tab.pageSpans[p] = spans;
  } catch {
    tab.pageTexts[p] = "";
    tab.pageSpans[p] = [];
  }
}

async function extractDocumentTextInBackground(
  tab: DocumentTabState
): Promise<void> {
  const total = tab.metadata.page_count;
  const startPage = Math.max(
    1,
    Math.min(total, tab.sidecar.reading_state.current_page)
  );

  const pageOrder: number[] = [startPage];
  for (let offset = 1; pageOrder.length < total; offset++) {
    if (startPage + offset <= total) pageOrder.push(startPage + offset);
    if (startPage - offset >= 1) pageOrder.push(startPage - offset);
  }

  const batchSize = 6;
  for (let i = 0; i < pageOrder.length; i += batchSize) {
    if (!openTabs.has(tab.id)) return;
    const batch = pageOrder.slice(i, i + batchSize);
    await Promise.all(batch.map((p) => extractSinglePageTextAndSpans(tab, p)));
    await new Promise((r) => window.setTimeout(r, 8));
  }
  tab.textExtractionDone = true;
}

function switchToTab(tabId: string): void {
  const prevTab = getActiveTab();
  if (prevTab && prevTab.id !== tabId) {
    scheduleSidecarSave(prevTab, true);
  }

  activeTabId = tabId;
  const tab = getActiveTab();
  renderTabsBar();

  const emptyDropzone = document.getElementById("empty-dropzone")!;
  const pagesContainer = document.getElementById("pages-scroll-container")!;

  if (!tab) {
    emptyDropzone.classList.remove("hidden");
    pagesContainer.classList.add("hidden");
    pagesContainer.innerHTML = "";
    syncToolbarAndThemeUI();
    renderSidebarPanels();
    return;
  }

  emptyDropzone.classList.add("hidden");
  pagesContainer.classList.remove("hidden");

  rebuildPageSlotsForActiveTab(true);
  syncToolbarAndThemeUI();
  renderSidebarPanels();
}

async function closeTab(tabId: string): Promise<void> {
  const tab = openTabs.get(tabId);
  if (!tab) return;

  tab.renderQueueGeneration++;
  for (const cancel of tab.activeRenderCancels.values()) {
    cancel();
  }
  await invoke("save_document_sidecar", { sidecar: tab.sidecar });
  await tab.pdfDoc.destroy();
  openTabs.delete(tabId);

  if (activeTabId === tabId) {
    const remainingIds = Array.from(openTabs.keys());
    const nextId =
      remainingIds.length > 0 ? remainingIds[remainingIds.length - 1] : null;
    if (nextId) {
      switchToTab(nextId);
    } else {
      activeTabId = null;
      switchToTab("");
    }
  } else {
    renderTabsBar();
  }
  void persistGlobalSettings();
}

/**
 * Pure-math scale calculation using pre-read `viewportWidth` and `viewportHeight`
 * so calling it inside loops NEVER triggers forced synchronous DOM reflows.
 */
function computeEffectivePageScaleWithSize(
  tab: DocumentTabState,
  geom: PdfPageGeometry,
  viewportWidth: number,
  viewportHeight: number
): number {
  const availWidth = Math.max(320, viewportWidth - 48);
  const availHeight = Math.max(240, viewportHeight - 48);

  const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
  const rotW =
    totalRot === 90 || totalRot === 270 ? geom.height_pt : geom.width_pt;
  const rotH =
    totalRot === 90 || totalRot === 270 ? geom.width_pt : geom.height_pt;

  const fitMode = tab.sidecar.reading_state.fit_mode;
  if (fitMode === "width") {
    const scale = Math.min(2.6, Math.max(0.45, availWidth / rotW));
    tab.sidecar.reading_state.zoom_scale = Number(scale.toFixed(3));
    return scale;
  }
  if (fitMode === "page") {
    const scale = Math.min(
      2.6,
      Math.max(0.35, Math.min(availWidth / rotW, availHeight / rotH))
    );
    tab.sidecar.reading_state.zoom_scale = Number(scale.toFixed(3));
    return scale;
  }
  return Math.max(0.25, Math.min(5.0, tab.sidecar.reading_state.zoom_scale));
}

function computeEffectivePageScale(
  tab: DocumentTabState,
  geom: PdfPageGeometry
): number {
  const viewportEl = document.getElementById("pdf-viewport")!;
  return computeEffectivePageScaleWithSize(
    tab,
    geom,
    viewportEl.clientWidth,
    viewportEl.clientHeight
  );
}

/**
 * Ensures `(vpW - slotW)` is an even integer whenever `slotW < vpW` so horizontal centering
 * lands on an exact integer pixel (`XX.0px`) and never triggers 0.5px GPU bilinear blur.
 */
function snapSlotWidthToViewportParity(rawW: number, vpW: number): number {
  const w = Math.max(1, Math.round(rawW));
  if (w < vpW && ((vpW - w) & 1) === 1) {
    return w + 1;
  }
  return w;
}

/**
 * Rebuilds the virtualized DOM page slots for the active tab and restores reading position.
 * Uses CSS variables `--slot-w` and `--slot-h` on `#pages-scroll-container` so resizing
 * 300+ pages during zoom happens in a single 0.05ms style update.
 */
function rebuildPageSlotsForActiveTab(restoreScroll = true): void {
  const tab = getActiveTab();
  const container = document.getElementById("pages-scroll-container")!;
  const viewportEl = document.getElementById("pdf-viewport")!;
  if (!tab) return;

  tab.renderQueueGeneration++;
  for (const cancel of tab.activeRenderCancels.values()) {
    cancel();
  }
  tab.activeRenderCancels.clear();
  tab.renderedCacheOrder = [];

  const vpW = viewportEl.clientWidth;
  const vpH = viewportEl.clientHeight;

  isProgrammaticScroll = true;
  container.innerHTML = "";

  const dm = getEffectiveDarkMode();
  const bgRgb =
    dm.enabled && dm.strategy !== "original"
      ? getTargetBackgroundRgb(dm)
      : [255, 255, 255];
  const slotBgCss = `rgb(${bgRgb[0]}, ${bgRgb[1]}, ${bgRgb[2]})`;

  const isSinglePage = tab.sidecar.reading_state.layout_mode === "single_page";
  const currentPage = Math.max(
    1,
    Math.min(tab.metadata.page_count, tab.sidecar.reading_state.current_page)
  );

  const baseGeom = tab.metadata.page_geometries[0];
  if (baseGeom) {
    const baseScale = computeEffectivePageScaleWithSize(tab, baseGeom, vpW, vpH);
    const baseRot = (baseGeom.rotation_deg + tab.rotationExtraDeg) % 360;
    const baseRotW =
      baseRot === 90 || baseRot === 270 ? baseGeom.height_pt : baseGeom.width_pt;
    const baseRotH =
      baseRot === 90 || baseRot === 270 ? baseGeom.width_pt : baseGeom.height_pt;
    const snappedBaseW = snapSlotWidthToViewportParity(baseRotW * baseScale, vpW);
    container.style.setProperty("--slot-w", `${snappedBaseW}px`);
    container.style.setProperty("--slot-h", `${Math.round(baseRotH * baseScale)}px`);
  }

  const fragment = document.createDocumentFragment();

  for (const geom of tab.metadata.page_geometries) {
    if (isSinglePage && geom.page_number !== currentPage) {
      continue;
    }

    const slot = document.createElement("div");
    slot.className = "pdf-page-slot";
    slot.dataset.pageNumber = String(geom.page_number);
    slot.style.background = slotBgCss;

    const isCustomGeom =
      baseGeom &&
      (Math.abs(geom.width_pt - baseGeom.width_pt) > 0.5 ||
        Math.abs(geom.height_pt - baseGeom.height_pt) > 0.5 ||
        geom.rotation_deg !== baseGeom.rotation_deg);

    if (isCustomGeom) {
      const scale = computeEffectivePageScaleWithSize(tab, geom, vpW, vpH);
      const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
      const rotW =
        totalRot === 90 || totalRot === 270 ? geom.height_pt : geom.width_pt;
      const rotH =
        totalRot === 90 || totalRot === 270 ? geom.width_pt : geom.height_pt;
      slot.dataset.customGeom = "1";
      slot.style.width = `${snapSlotWidthToViewportParity(rotW * scale, vpW)}px`;
      slot.style.height = `${Math.round(rotH * scale)}px`;
    }

    slot.innerHTML = `
      <canvas class="pdf-render-canvas" width="1" height="1"></canvas>
      <div class="pdf-links-layer"></div>
      <div class="pdf-search-layer"></div>
      <canvas class="pdf-annot-canvas ${
        activeTool !== "select" ? "interactive-tool" : ""
      }" width="1" height="1"></canvas>
      <div class="pdf-notes-layer"></div>
    `;

    attachAnnotationEventsToSlot(slot, tab, geom);
    fragment.appendChild(slot);
  }

  container.appendChild(fragment);

  if (restoreScroll && !isSinglePage) {
    const targetSlot = container.querySelector<HTMLElement>(
      `.pdf-page-slot[data-page-number="${currentPage}"]`
    );
    if (targetSlot) {
      viewportEl.scrollTop = Math.max(0, targetSlot.offsetTop - 16);
    }
  } else if (isSinglePage) {
    viewportEl.scrollTop = 0;
  }

  window.requestAnimationFrame(() => {
    isProgrammaticScroll = false;
  });

  renderVisiblePagesForActiveTab();
}

/**
 * Zero-Reflow, 120 FPS In-Place Anchored Zoom (`applyZoomOrResizeInPlace`):
 *
 * 1. Reads viewport geometry ONCE and updates `--slot-w` and `--slot-h` on `#pages-scroll-container`
 *    so all 300+ page slots resize in `< 0.1ms` without per-page DOM layout thrashing or offscreen
 *    canvas allocations.
 * 2. Locks `viewportEl.scrollTop` to the exact reading line on `anchorSlot` (never resets to Page 1).
 * 3. Debounces high-resolution 1:1 hardware-pixel vector re-rendering (`110ms`) and renders the
 *    centered page FIRST.
 */
function applyZoomOrResizeInPlace(focalClientY?: number): void {
  const tab = getActiveTab();
  if (!tab) return;

  const viewportEl = document.getElementById("pdf-viewport")!;
  const container = document.getElementById("pages-scroll-container")!;
  if (container.children.length === 0) {
    rebuildPageSlotsForActiveTab(true);
    return;
  }

  const vpW = viewportEl.clientWidth;
  const vpH = viewportEl.clientHeight;
  const oldScrollTop = viewportEl.scrollTop;
  const isSinglePage = tab.sidecar.reading_state.layout_mode === "single_page";

  const viewportRect = viewportEl.getBoundingClientRect();
  const focalViewportY =
    focalClientY !== undefined
      ? Math.max(0, Math.min(vpH, focalClientY - viewportRect.top))
      : vpH * 0.35;

  // 1. Identify anchor slot around current_page (reading only nearby slots, not all 300!)
  const curPage = tab.sidecar.reading_state.current_page;
  let anchorSlot =
    container.querySelector<HTMLElement>(
      `.pdf-page-slot[data-page-number="${curPage}"]`
    ) || (container.firstElementChild as HTMLElement);

  const targetDocY = oldScrollTop + focalViewportY;
  // Check a small window of +-3 pages around `curPage` to find the exact slot under `focalViewportY`
  for (
    let p = Math.max(1, curPage - 3);
    p <= Math.min(tab.metadata.page_count, curPage + 3);
    p++
  ) {
    const candidate = container.querySelector<HTMLElement>(
      `.pdf-page-slot[data-page-number="${p}"]`
    );
    if (!candidate) continue;
    const top = candidate.offsetTop;
    const bottom = top + candidate.offsetHeight;
    if (targetDocY >= top && targetDocY <= bottom + 18) {
      anchorSlot = candidate;
      break;
    }
  }

  const anchorPageNum = Number(anchorSlot.dataset.pageNumber) || curPage;
  const oldAnchorTop = anchorSlot.offsetTop;
  const oldAnchorHeight = Math.max(1, anchorSlot.offsetHeight);
  const offsetWithinSlotRatioY = Math.max(
    0,
    Math.min(1, (targetDocY - oldAnchorTop) / oldAnchorHeight)
  );

  // 2. Update CSS variables `--slot-w` and `--slot-h` ONCE on `container`
  isProgrammaticScroll = true;

  const baseGeom = tab.metadata.page_geometries[0];
  let newBaseHeight = oldAnchorHeight;
  if (baseGeom) {
    const baseScale = computeEffectivePageScaleWithSize(tab, baseGeom, vpW, vpH);
    const baseRot = (baseGeom.rotation_deg + tab.rotationExtraDeg) % 360;
    const baseRotW =
      baseRot === 90 || baseRot === 270 ? baseGeom.height_pt : baseGeom.width_pt;
    const baseRotH =
      baseRot === 90 || baseRot === 270 ? baseGeom.width_pt : baseGeom.height_pt;
    const newBaseWidth = snapSlotWidthToViewportParity(baseRotW * baseScale, vpW);
    newBaseHeight = Math.round(baseRotH * baseScale);
    container.style.setProperty("--slot-w", `${newBaseWidth}px`);
    container.style.setProperty("--slot-h", `${newBaseHeight}px`);
  }

  // Only update inline styles for any non-standard pages (`data-custom-geom="1"`)
  const customSlots = container.querySelectorAll<HTMLElement>(
    '.pdf-page-slot[data-custom-geom="1"]'
  );
  customSlots.forEach((slot) => {
    const pNum = Number(slot.dataset.pageNumber);
    const geom = tab.metadata.page_geometries[pNum - 1];
    if (!geom) return;
    const scale = computeEffectivePageScaleWithSize(tab, geom, vpW, vpH);
    const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
    const rotW =
      totalRot === 90 || totalRot === 270 ? geom.height_pt : geom.width_pt;
    const rotH =
      totalRot === 90 || totalRot === 270 ? geom.width_pt : geom.height_pt;
    slot.style.width = `${snapSlotWidthToViewportParity(rotW * scale, vpW)}px`;
    slot.style.height = `${Math.round(rotH * scale)}px`;
  });

  // 3. Immediately lock scrollTop to the exact anchored line on `anchorSlot`
  if (!isSinglePage) {
    const newAnchorTop = anchorSlot.offsetTop;
    const newAnchorHeight = anchorSlot.offsetHeight || newBaseHeight;
    const newScrollTop =
      newAnchorTop + offsetWithinSlotRatioY * newAnchorHeight - focalViewportY;
    viewportEl.scrollTop = Math.max(0, Math.round(newScrollTop));
    tab.sidecar.reading_state.current_page = anchorPageNum;
  }

  syncToolbarAndThemeUI();

  window.requestAnimationFrame(() => {
    isProgrammaticScroll = false;
  });

  // 4. Debounce crisp 1:1 hardware-pixel re-render of visible pages only
  if (zoomRerenderTimer !== null) {
    window.clearTimeout(zoomRerenderTimer);
  }
  zoomRerenderTimer = window.setTimeout(() => {
    zoomRerenderTimer = null;
    tab.renderQueueGeneration++;
    for (const cancel of tab.activeRenderCancels.values()) {
      cancel();
    }
    tab.activeRenderCancels.clear();
    tab.renderedCacheOrder = [];
    renderVisiblePagesForActiveTab();
  }, 110);
}

/**
 * Determines which page slots are inside the viewport, prioritizes the most-centered page
 * FIRST, and renders them sequentially so the UI thread never stutters.
 */
function renderVisiblePagesForActiveTab(): void {
  const tab = getActiveTab();
  if (!tab) return;

  const viewportEl = document.getElementById("pdf-viewport")!;
  const container = document.getElementById("pages-scroll-container")!;
  const slots = Array.from(
    container.querySelectorAll<HTMLElement>(".pdf-page-slot")
  );
  if (slots.length === 0) return;

  const viewTop = viewportEl.scrollTop;
  const viewBottom = viewTop + viewportEl.clientHeight;
  const preloadMargin = viewportEl.clientHeight * 0.45;
  const viewMid = (viewTop + viewBottom) * 0.5;

  const visibleWithDist: Array<{ pageNum: number; dist: number }> = [];
  let mostCenteredPage = tab.sidecar.reading_state.current_page;
  let bestCenterDist = Infinity;

  for (const slot of slots) {
    const pageNum = Number(slot.dataset.pageNumber);
    const slotTop = slot.offsetTop;
    const slotBottom = slotTop + slot.offsetHeight;
    const slotMid = (slotTop + slotBottom) * 0.5;

    const dist = Math.abs(slotMid - viewMid);
    if (dist < bestCenterDist) {
      bestCenterDist = dist;
      mostCenteredPage = pageNum;
    }

    if (
      slotBottom >= viewTop - preloadMargin &&
      slotTop <= viewBottom + preloadMargin
    ) {
      visibleWithDist.push({ pageNum, dist });
    }
  }

  if (
    !isProgrammaticScroll &&
    tab.sidecar.reading_state.layout_mode === "continuous" &&
    mostCenteredPage !== tab.sidecar.reading_state.current_page
  ) {
    tab.sidecar.reading_state.current_page = mostCenteredPage;
    (document.getElementById("input-page-num") as HTMLInputElement).value =
      String(mostCenteredPage);
    const fsInput = document.getElementById(
      "fs-input-page"
    ) as HTMLInputElement | null;
    if (fsInput) fsInput.value = String(mostCenteredPage);
    const fsPrev = document.getElementById(
      "fs-btn-prev"
    ) as HTMLButtonElement | null;
    const fsNext = document.getElementById(
      "fs-btn-next"
    ) as HTMLButtonElement | null;
    if (fsPrev) fsPrev.disabled = mostCenteredPage <= 1;
    if (fsNext) fsNext.disabled = mostCenteredPage >= tab.metadata.page_count;
    const btnPrev = document.getElementById(
      "btn-prev-page"
    ) as HTMLButtonElement | null;
    const btnNext = document.getElementById(
      "btn-next-page"
    ) as HTMLButtonElement | null;
    if (btnPrev) btnPrev.disabled = mostCenteredPage <= 1;
    if (btnNext) btnNext.disabled = mostCenteredPage >= tab.metadata.page_count;
    scheduleSidecarSave(tab, false);
  }

  // Sort by distance from viewport center so the page the user is actively reading renders FIRST
  visibleWithDist.sort((a, b) => a.dist - b.dist);
  const visiblePages = visibleWithDist.map((v) => v.pageNum);

  const pagesToRender = visiblePages.filter(
    (p) =>
      !tab.renderedCacheOrder.includes(p) && !tab.activeRenderCancels.has(p)
  );

  if (pagesToRender.length > 0) {
    const gen = tab.renderQueueGeneration;
    void (async () => {
      for (const pageNum of pagesToRender) {
        if (
          activeTabId !== tab.id ||
          tab.renderQueueGeneration !== gen ||
          tab.renderedCacheOrder.includes(pageNum) ||
          tab.activeRenderCancels.has(pageNum)
        ) {
          continue;
        }
        await renderSinglePageSlot(tab, pageNum);
        // Yield a frame between pages so scrolling & zooming stay 100% responsive
        await new Promise((r) => window.requestAnimationFrame(() => r(null)));
      }
    })();
  }

  // Evict distant pages when cache exceeds MAX_CACHED_RENDERED_PAGES
  while (tab.renderedCacheOrder.length > MAX_CACHED_RENDERED_PAGES) {
    const candidate = tab.renderedCacheOrder.find(
      (p) => !visiblePages.includes(p)
    );
    if (candidate === undefined) break;
    tab.renderedCacheOrder = tab.renderedCacheOrder.filter(
      (p) => p !== candidate
    );
    const evictSlot = container.querySelector<HTMLElement>(
      `.pdf-page-slot[data-page-number="${candidate}"]`
    );
    if (evictSlot) {
      const c = evictSlot.querySelector<HTMLCanvasElement>(".pdf-render-canvas");
      if (c) {
        renderedCanvasCache.delete(c);
        c.width = 1;
        c.height = 1;
      }
      const ac = evictSlot.querySelector<HTMLCanvasElement>(".pdf-annot-canvas");
      if (ac) {
        ac.width = 1;
        ac.height = 1;
      }
    }
  }
}

interface CachedCanvasEntry {
  pristineRgba: Uint8ClampedArray;
  workingImageData: ImageData;
  width: number;
  height: number;
  report: ImageClassificationReport;
  photoBoxes: PixelBoundingBox[];
}

const renderedCanvasCache = new WeakMap<HTMLCanvasElement, CachedCanvasEntry>();

/**
 * Updates a single rendered canvas in-place from its cached pristine RAM buffer in `< 1.5ms`
 * without calling `ctx.getImageData`. During fast slider drags (`isLiveDrag = true`), skips the
 * secondary micro-acutance pass and runs it once on slider release (`change`).
 */
function refreshCanvasDarkModeInPlace(
  renderCanvas: HTMLCanvasElement,
  dm: DarkModeConfig
): ImageClassificationReport | null {
  const cached = renderedCanvasCache.get(renderCanvas);
  if (
    !cached ||
    renderCanvas.width !== cached.width ||
    renderCanvas.height !== cached.height
  ) {
    return null;
  }
  const ctx = renderCanvas.getContext("2d", { alpha: false });
  if (!ctx) return null;

  transformBufferToDarkFast(
    cached.pristineRgba,
    cached.workingImageData.data,
    cached.width,
    cached.height,
    dm,
    cached.report,
    cached.photoBoxes
  );
  ctx.putImageData(cached.workingImageData, 0, 0);
  return cached.report;
}

/**
 * Updates currently rendered page canvases in-place when toggling Dark Mode or dragging
 * sliders. Only iterates over `tab.renderedCacheOrder` (max 8 pages, not 300 DOM nodes!).
 */
function reapplyDarkModeToActiveTabInPlace(isLiveSliderDrag = false): void {
  const tab = getActiveTab();
  if (!tab) return;
  const viewportEl = document.getElementById("pdf-viewport")!;
  const container = document.getElementById("pages-scroll-container")!;
  const dm = getEffectiveDarkMode();
  const isDark = dm.enabled && dm.strategy !== "original";
  const bgRgb = isDark ? getTargetBackgroundRgb(dm) : [255, 255, 255];
  const slotBgCss = `rgb(${bgRgb[0]}, ${bgRgb[1]}, ${bgRgb[2]})`;

  const viewTop = viewportEl.scrollTop;
  const viewBottom = viewTop + viewportEl.clientHeight;
  const vpW = viewportEl.clientWidth;
  const vpH = viewportEl.clientHeight;

  for (const pageNum of tab.renderedCacheOrder) {
    const slot = container.querySelector<HTMLElement>(
      `.pdf-page-slot[data-page-number="${pageNum}"]`
    );
    if (!slot) continue;
    slot.style.background = slotBgCss;

    if (isLiveSliderDrag) {
      const slotTop = slot.offsetTop;
      const slotBottom = slotTop + slot.offsetHeight;
      if (slotBottom < viewTop - 60 || slotTop > viewBottom + 60) {
        continue;
      }
    }

    const renderCanvas =
      slot.querySelector<HTMLCanvasElement>(".pdf-render-canvas");
    if (renderCanvas && renderedCanvasCache.has(renderCanvas)) {
      const rep = refreshCanvasDarkModeInPlace(renderCanvas, dm);
      if (rep) tab.lastClassification = rep;
      if (!isLiveSliderDrag) {
        const geom = tab.metadata.page_geometries[pageNum - 1];
        if (geom) {
          const scale = computeEffectivePageScaleWithSize(tab, geom, vpW, vpH);
          const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
          redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
        }
      }
    }
  }
}

function scheduleSliderDarkModeUpdate(): void {
  if (dmSliderRaf !== null) return;
  dmSliderRaf = window.requestAnimationFrame(() => {
    dmSliderRaf = null;
    reapplyDarkModeToActiveTabInPlace(true);
  });
}

/**
 * Renders a single PDF page slot at exact 1:1 physical hardware pixels (`getHardwareDpr()`)
 * using offscreen double-buffering so zooming never flashes blank and text is never foggy.
 */
async function renderSinglePageSlot(
  tab: DocumentTabState,
  pageNumber: number
): Promise<void> {
  const container = document.getElementById("pages-scroll-container")!;
  const slot = container.querySelector<HTMLElement>(
    `.pdf-page-slot[data-page-number="${pageNumber}"]`
  );
  if (!slot) return;

  const geom = tab.metadata.page_geometries[pageNumber - 1];
  if (!geom) return;

  let cancelled = false;
  tab.activeRenderCancels.set(pageNumber, () => {
    cancelled = true;
  });

  const tStart = performance.now();
  try {
    const pdfPage = await tab.pdfDoc.getPage(pageNumber);
    if (cancelled || activeTabId !== tab.id) return;

    const viewportEl = document.getElementById("pdf-viewport")!;
    const scale = computeEffectivePageScale(tab, geom);
    const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
    const rotW =
      totalRot === 90 || totalRot === 270 ? geom.height_pt : geom.width_pt;
    const rotH =
      totalRot === 90 || totalRot === 270 ? geom.width_pt : geom.height_pt;

    const cssWidth =
      slot.clientWidth ||
      snapSlotWidthToViewportParity(rotW * scale, viewportEl.clientWidth);
    const cssHeight = slot.clientHeight || Math.max(1, Math.round(rotH * scale));

    // Exact 1:1 physical monitor pixel dimensions for the visible canvas
    const dpr = getHardwareDpr();
    const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
    const targetHeight = Math.max(1, Math.round(cssHeight * dpr));

    // Compute visible Quadtree tiles in Viewport Space for priority scheduling & LRU caching
    const lodScale = selectPyramidLod(scale);
    const tileQueue = computeVisibleTilesPriorityQueue(
      pageNumber,
      targetWidth,
      targetHeight,
      slot.offsetLeft * dpr,
      slot.offsetTop * dpr,
      {
        xMin: viewportEl.scrollLeft * dpr,
        yMin: viewportEl.scrollTop * dpr,
        xMax: (viewportEl.scrollLeft + viewportEl.clientWidth) * dpr,
        yMax: (viewportEl.scrollTop + viewportEl.clientHeight) * dpr,
      },
      lodScale
    );

    // 2x2 Supersampling up to 2000px target width so all 1080p/1440p reading & zoomed views get
    // 4x sample precision for Type-1 LMRoman10 serifs, hairlines, and math subscripts, while
    // ultra-high 300%-500% zoom levels render natively at 1:1 hardware pixels without memory spikes
    const superFactor = targetWidth <= 2000 ? 2 : 1;
    const superW = targetWidth * superFactor;
    const superH = targetHeight * superFactor;

    const exactRenderScale = superW / rotW;
    const viewport = pdfPage.getViewport({
      scale: exactRenderScale,
      rotation: totalRot,
    });

    const backCanvas = document.createElement("canvas");
    backCanvas.width = superW;
    backCanvas.height = superH;
    const backCtx = backCanvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true,
    })!;

    const dm = getEffectiveDarkMode();
    // Apply Section 4 "Enhance Thin Lines" minimum device width clamping scaled by `superFactor`
    const restoreAgmVector = instrumentContextWithAgmVectorPipeline(
      backCtx,
      true,
      superFactor
    );
    const photoDetector = instrumentCanvasForPhotographDetection(
      backCtx,
      superW,
      superH,
      dm,
      1.0 / superFactor
    );

    const renderTask = pdfPage.render({
      canvasContext: backCtx,
      viewport,
    });

    tab.activeRenderCancels.set(pageNumber, () => {
      cancelled = true;
      renderTask.cancel();
    });

    try {
      await renderTask.promise;
    } finally {
      photoDetector.restore();
      restoreAgmVector();
    }
    if (cancelled || activeTabId !== tab.id) return;

    const lowZoomBoost = Math.max(
      -0.5,
      Math.min(1, computeLowZoomBoost(scale * dpr) + sharpnessBias)
    );
    const superData = backCtx.getImageData(0, 0, superW, superH);
    const pristineRgba = new Uint8ClampedArray(targetWidth * targetHeight * 4);

    if (superFactor === 2) {
      // Section 3: Downsample 2x -> 1x using CoolType 5-Tap FIR [1/9, 2/9, 3/9, 2/9, 1/9]
      // filter in Linear RGB (gamma = 2.2) space!
      downsample2xWithCoolTypeFir(
        superData.data,
        superW,
        superH,
        pristineRgba,
        targetWidth,
        targetHeight,
        lowZoomBoost
      );
    } else {
      pristineRgba.set(superData.data);
    }

    const workingImageData = new ImageData(targetWidth, targetHeight);
    const report = classifyImageRegion(pristineRgba, targetWidth, targetHeight);
    report.low_zoom_boost = lowZoomBoost;
    const photoBoxes = photoDetector.getPhotoBoxes();

    // Section 3: Blend Text_Linear and Bg_Linear in Linear RGB (gamma = 2.2) space
    transformBufferToDarkFast(
      pristineRgba,
      workingImageData.data,
      targetWidth,
      targetHeight,
      dm,
      report,
      photoBoxes
    );

    if (tileQueue.length > 0) {
      agmTileCache.put({
        key: tileQueue[0].key,
        pageNumber,
        lodScale,
        tileCol: tileQueue[0].tileCol,
        tileRow: tileQueue[0].tileRow,
        imageData: workingImageData,
        lastUsedAt: performance.now(),
      });
    }

    const renderCanvas = slot.querySelector<HTMLCanvasElement>(
      ".pdf-render-canvas"
    )!;
    const annotCanvas = slot.querySelector<HTMLCanvasElement>(
      ".pdf-annot-canvas"
    )!;

    renderCanvas.width = targetWidth;
    renderCanvas.height = targetHeight;
    const visCtx = renderCanvas.getContext("2d", { alpha: false })!;
    visCtx.putImageData(workingImageData, 0, 0);

    renderedCanvasCache.set(renderCanvas, {
      pristineRgba,
      workingImageData,
      width: targetWidth,
      height: targetHeight,
      report,
      photoBoxes,
    });
    tab.lastClassification = report;

    if (annotCanvas.width !== cssWidth || annotCanvas.height !== cssHeight) {
      annotCanvas.width = cssWidth;
      annotCanvas.height = cssHeight;
    }

    if (tab.firstPageRenderMs === 0) {
      tab.firstPageRenderMs = performance.now() - tStart;
    }

    if (!tab.renderedCacheOrder.includes(pageNumber)) {
      tab.renderedCacheOrder.push(pageNumber);
    }
    tab.activeRenderCancels.delete(pageNumber);

    void extractSinglePageTextAndSpans(tab, pageNumber).then(() => {
      if (tab.searchResult && tab.searchResult.total_matches > 0) {
        redrawSlotSearchHighlights(slot, tab, pageNumber, geom, scale, totalRot);
      }
    });

    await populatePageLinksLayer(slot, tab, pdfPage, scale, totalRot);
    redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
    redrawSlotSearchHighlights(slot, tab, pageNumber, geom, scale, totalRot);
    syncToolbarAndThemeUI();
  } catch (err) {
    tab.activeRenderCancels.delete(pageNumber);
    if (!cancelled) {
      console.error(`Error rendering page ${pageNumber}:`, err);
    }
  }
}

async function populatePageLinksLayer(
  slot: HTMLElement,
  tab: DocumentTabState,
  pdfPage: pdfjsLib.PDFPageProxy,
  scale: number,
  totalRot: number
): Promise<void> {
  const linksLayer = slot.querySelector<HTMLElement>(".pdf-links-layer")!;
  linksLayer.innerHTML = "";

  try {
    const annots = await pdfPage.getAnnotations();
    const viewport = pdfPage.getViewport({ scale, rotation: totalRot });

    for (const annot of annots) {
      if (annot.subtype !== "Link" || !annot.rect) continue;
      const rect = viewport.convertToViewportRectangle(annot.rect);
      const x = Math.min(rect[0], rect[2]);
      const y = Math.min(rect[1], rect[3]);
      const w = Math.abs(rect[2] - rect[0]);
      const h = Math.abs(rect[3] - rect[1]);

      const linkEl = document.createElement("a");
      linkEl.className = "pdf-link-hotspot";
      linkEl.style.left = `${x}px`;
      linkEl.style.top = `${y}px`;
      linkEl.style.width = `${w}px`;
      linkEl.style.height = `${h}px`;

      if (annot.url) {
        linkEl.title = `Open external link: ${annot.url}`;
        linkEl.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (
            annot.url.startsWith("https://") ||
            annot.url.startsWith("http://")
          ) {
            void openExternalUrl(annot.url);
          }
        });
      } else if (annot.dest) {
        linkEl.title = "Jump to destination in document";
        linkEl.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            let dest = annot.dest;
            if (typeof dest === "string") {
              dest = await tab.pdfDoc.getDestination(dest);
            }
            if (Array.isArray(dest) && dest[0]) {
              const targetIdx = await tab.pdfDoc.getPageIndex(dest[0]);
              navigateToPage(targetIdx + 1, true);
            }
          } catch (err) {
            console.error("Failed to resolve internal PDF link:", err);
          }
        });
      }

      linksLayer.appendChild(linkEl);
    }
  } catch {
    // Non-fatal
  }
}

function redrawSlotAnnotationsAndNotes(
  slot: HTMLElement,
  tab: DocumentTabState,
  geom: PdfPageGeometry,
  scale: number,
  totalRot: number
): void {
  const annotCanvas = slot.querySelector<HTMLCanvasElement>(".pdf-annot-canvas")!;
  const notesLayer = slot.querySelector<HTMLElement>(".pdf-notes-layer")!;

  const pageKey = String(geom.page_number);
  const items = tab.sidecar.annotations.pages[pageKey] || [];
  if (items.length === 0 && annotCanvas.width <= 1) {
    notesLayer.innerHTML = "";
    return;
  }

  const cssWidth = slot.clientWidth || Math.round(geom.width_pt * scale);
  const cssHeight = slot.clientHeight || Math.round(geom.height_pt * scale);
  if (annotCanvas.width !== cssWidth || annotCanvas.height !== cssHeight) {
    annotCanvas.width = cssWidth;
    annotCanvas.height = cssHeight;
  }

  const ctx = annotCanvas.getContext("2d")!;
  const dm = getEffectiveDarkMode();
  const isDark = dm.enabled && dm.strategy !== "original";

  renderPageAnnotationsCanvas(
    ctx,
    annotCanvas.width,
    annotCanvas.height,
    items,
    geom.width_pt,
    geom.height_pt,
    scale,
    totalRot,
    isDark
  );

  notesLayer.innerHTML = "";
  for (const item of items) {
    if (item.type !== "text_note") continue;
    const [sx, sy] = pageToScreenCoords(
      item.x,
      item.y,
      geom.width_pt,
      geom.height_pt,
      scale,
      totalRot
    );
    const pin = document.createElement("div");
    pin.className = "study-note-pin";
    pin.style.left = `${sx - 13}px`;
    pin.style.top = `${sy - 13}px`;
    pin.style.background = item.color || "#fbbf24";
    pin.textContent = "✎";
    pin.title = `${item.title || "Note"}: ${item.content}`;

    let dragged = false;
    pin.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (activeTool === "eraser") {
        pushUndoSnapshot(tab);
        removeAnnotationById(tab, geom.page_number, item.id);
        redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
        renderSidebarPanels();
        scheduleSidecarSave(tab);
        return;
      }
      dragged = false;
      pin.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;

      const onMove = (me: PointerEvent) => {
        if (Math.hypot(me.clientX - startX, me.clientY - startY) > 4) {
          dragged = true;
        }
        if (dragged) {
          const rect = slot.getBoundingClientRect();
          const curScale = computeEffectivePageScale(tab, geom);
          const curRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
          const [nx, ny] = screenToPageCoords(
            me.clientX - rect.left,
            me.clientY - rect.top,
            geom.width_pt,
            geom.height_pt,
            curScale,
            curRot
          );
          item.x = nx;
          item.y = ny;
          const [psx, psy] = pageToScreenCoords(
            nx,
            ny,
            geom.width_pt,
            geom.height_pt,
            curScale,
            curRot
          );
          pin.style.left = `${psx - 13}px`;
          pin.style.top = `${psy - 13}px`;
        }
      };

      const onUp = () => {
        pin.removeEventListener("pointermove", onMove);
        pin.removeEventListener("pointerup", onUp);
        if (dragged) {
          scheduleSidecarSave(tab);
        } else {
          openNoteEditorModal(tab.id, geom.page_number, item.id, item.x, item.y);
        }
      };

      pin.addEventListener("pointermove", onMove);
      pin.addEventListener("pointerup", onUp);
    });

    notesLayer.appendChild(pin);
  }
}

function redrawSlotSearchHighlights(
  slot: HTMLElement,
  tab: DocumentTabState,
  pageNumber: number,
  geom: PdfPageGeometry,
  scale: number,
  totalRot: number
): number | null {
  const searchLayer = slot.querySelector<HTMLElement>(".pdf-search-layer")!;
  searchLayer.innerHTML = "";
  if (!tab.searchResult || tab.searchResult.total_matches === 0) return null;

  const pageMatches = tab.searchResult.matches.filter(
    (m) => m.page_number === pageNumber
  );
  if (pageMatches.length === 0) return null;

  const activeGlobalIdx = tab.searchResult.active_match_index;
  const spans = tab.pageSpans[pageNumber] || [];
  let activeMatchTopPx: number | null = null;

  for (const m of pageMatches) {
    const isCurrentActive = m.match_index === activeGlobalIdx;
    const matchStart = m.char_start;
    const matchEnd = m.char_start + m.char_len;

    for (const sp of spans) {
      if (sp.charEnd <= matchStart || sp.charStart >= matchEnd) continue;

      const spanLen = Math.max(1, sp.charEnd - sp.charStart);
      const relStart = Math.max(0, (matchStart - sp.charStart) / spanLen);
      const relEnd = Math.min(1, (matchEnd - sp.charStart) / spanLen);

      const [rx0, ry0, rx1, ry1] = sp.pdfRect;
      const subX0 = rx0 + (rx1 - rx0) * relStart;
      const subX1 = rx0 + (rx1 - rx0) * relEnd;

      const topLeftY0 = geom.height_pt - ry1;
      const topLeftY1 = geom.height_pt - ry0;

      const [sx0, sy0] = pageToScreenCoords(
        subX0,
        topLeftY0,
        geom.width_pt,
        geom.height_pt,
        scale,
        totalRot
      );
      const [sx1, sy1] = pageToScreenCoords(
        subX1,
        topLeftY1,
        geom.width_pt,
        geom.height_pt,
        scale,
        totalRot
      );

      const left = Math.min(sx0, sx1) - 2;
      const top = Math.min(sy0, sy1) - 1;
      const width = Math.max(10, Math.abs(sx1 - sx0) + 4);
      const height = Math.max(12, Math.abs(sy1 - sy0) + 2);

      const hl = document.createElement("div");
      hl.className = `pdf-search-highlight${isCurrentActive ? " active" : ""}`;
      hl.style.left = `${Math.round(left)}px`;
      hl.style.top = `${Math.round(top)}px`;
      hl.style.width = `${Math.round(width)}px`;
      hl.style.height = `${Math.round(height)}px`;
      searchLayer.appendChild(hl);

      if (isCurrentActive && activeMatchTopPx === null) {
        activeMatchTopPx = top;
      }
    }
  }

  const badge = document.createElement("div");
  badge.className = "search-match-badge";
  const activeMatch =
    activeGlobalIdx !== null ? tab.searchResult.matches[activeGlobalIdx] : null;
  badge.textContent =
    activeMatch && activeMatch.page_number === pageNumber
      ? `Match ${(activeGlobalIdx ?? 0) + 1} of ${
          tab.searchResult.total_matches
        }`
      : `${pageMatches.length} match(es) on page`;
  searchLayer.appendChild(badge);

  return activeMatchTopPx;
}

function updateAllSlotsSearchHighlightsInPlace(): void {
  const tab = getActiveTab();
  if (!tab) return;
  const viewportEl = document.getElementById("pdf-viewport")!;
  const container = document.getElementById("pages-scroll-container")!;
  const vpW = viewportEl.clientWidth;
  const vpH = viewportEl.clientHeight;

  for (const pageNum of tab.renderedCacheOrder) {
    const slot = container.querySelector<HTMLElement>(
      `.pdf-page-slot[data-page-number="${pageNum}"]`
    );
    if (!slot) continue;
    const geom = tab.metadata.page_geometries[pageNum - 1];
    if (!geom) continue;
    const scale = computeEffectivePageScaleWithSize(tab, geom, vpW, vpH);
    const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
    redrawSlotSearchHighlights(slot, tab, pageNum, geom, scale, totalRot);
  }
}

function attachAnnotationEventsToSlot(
  slot: HTMLElement,
  tab: DocumentTabState,
  geom: PdfPageGeometry
): void {
  const annotCanvas = slot.querySelector<HTMLCanvasElement>(".pdf-annot-canvas")!;
  let isDrawing = false;
  let currentPoints: StrokePoint[] = [];
  let boxStartPt: [number, number] | null = null;
  let snipStartScreen: [number, number] | null = null;

  annotCanvas.addEventListener("pointerdown", (e: PointerEvent) => {
    if (activeTool === "select") return;
    e.preventDefault();
    e.stopPropagation();

    const scale = computeEffectivePageScale(tab, geom);
    const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
    const cssWidth = slot.clientWidth || Math.round(geom.width_pt * scale);
    const cssHeight = slot.clientHeight || Math.round(geom.height_pt * scale);
    if (annotCanvas.width !== cssWidth || annotCanvas.height !== cssHeight) {
      annotCanvas.width = cssWidth;
      annotCanvas.height = cssHeight;
    }

    const rect = annotCanvas.getBoundingClientRect();
    const sx = Math.max(0, Math.min(cssWidth, e.clientX - rect.left));
    const sy = Math.max(0, Math.min(cssHeight, e.clientY - rect.top));

    if (activeTool === "snip") {
      isDrawing = true;
      snipStartScreen = [sx, sy];
      annotCanvas.setPointerCapture(e.pointerId);
      return;
    }

    const [xPt, yPt] = screenToPageCoords(
      sx,
      sy,
      geom.width_pt,
      geom.height_pt,
      scale,
      totalRot
    );
    const pressure = e.pressure > 0 ? e.pressure : 0.5;

    if (activeTool === "note") {
      openNoteEditorModal(tab.id, geom.page_number, null, xPt, yPt);
      return;
    }

    pushUndoSnapshot(tab);
    isDrawing = true;
    annotCanvas.setPointerCapture(e.pointerId);

    if (activeTool === "eraser") {
      eraseAnnotationsAtPoint(tab, geom.page_number, xPt, yPt, 10.0);
      redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
      return;
    }

    if (activeTool === "highlight_text" || activeTool === "underline_text") {
      boxStartPt = [xPt, yPt];
      return;
    }

    currentPoints = [{ x: xPt, y: yPt, pressure }];
  });

  annotCanvas.addEventListener("pointermove", (e: PointerEvent) => {
    if (!isDrawing) return;
    const scale = computeEffectivePageScale(tab, geom);
    const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
    const rect = annotCanvas.getBoundingClientRect();
    const cssWidth = annotCanvas.width || slot.clientWidth;
    const cssHeight = annotCanvas.height || slot.clientHeight;
    const sx = Math.max(0, Math.min(cssWidth, e.clientX - rect.left));
    const sy = Math.max(0, Math.min(cssHeight, e.clientY - rect.top));

    if (activeTool === "snip" && snipStartScreen) {
      redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
      const rx = Math.min(snipStartScreen[0], sx);
      const ry = Math.min(snipStartScreen[1], sy);
      const rw = Math.abs(sx - snipStartScreen[0]);
      const rh = Math.abs(sy - snipStartScreen[1]);

      const ctx = annotCanvas.getContext("2d")!;
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.42)";
      ctx.fillRect(0, 0, cssWidth, ry);
      ctx.fillRect(0, ry + rh, cssWidth, Math.max(0, cssHeight - (ry + rh)));
      ctx.fillRect(0, ry, rx, rh);
      ctx.fillRect(rx + rw, ry, Math.max(0, cssWidth - (rx + rw)), rh);

      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
      ctx.setLineDash([]);

      if (rw >= 24 && rh >= 18) {
        const dpr = getHardwareDpr();
        const label = `${Math.round(rw * dpr)} × ${Math.round(rh * dpr)} px`;
        ctx.font = "600 11px Segoe UI, sans-serif";
        const tw = ctx.measureText(label).width + 12;
        const badgeY = ry > 24 ? ry - 22 : Math.min(cssHeight - 20, ry + rh + 4);
        ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
        ctx.fillRect(rx, badgeY, tw, 18);
        ctx.fillStyle = "#38bdf8";
        ctx.fillText(label, rx + 6, badgeY + 13);
      }
      ctx.restore();
      return;
    }

    const [xPt, yPt] = screenToPageCoords(
      sx,
      sy,
      geom.width_pt,
      geom.height_pt,
      scale,
      totalRot
    );
    const pressure = e.pressure > 0 ? e.pressure : 0.5;

    if (activeTool === "eraser") {
      if (eraseAnnotationsAtPoint(tab, geom.page_number, xPt, yPt, 10.0)) {
        redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
      }
      return;
    }

    if (activeTool === "pen" || activeTool === "highlighter") {
      currentPoints.push({ x: xPt, y: yPt, pressure });
      redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
      const ctx = annotCanvas.getContext("2d")!;
      ctx.save();
      ctx.strokeStyle = annotColor;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth =
        activeTool === "highlighter"
          ? Math.max(8, strokeWidth * 4.5 * scale)
          : Math.max(1, strokeWidth * scale);
      if (activeTool === "highlighter") {
        ctx.globalAlpha = 0.35;
      }
      ctx.beginPath();
      for (let i = 0; i < currentPoints.length; i++) {
        const [px, py] = pageToScreenCoords(
          currentPoints[i].x,
          currentPoints[i].y,
          geom.width_pt,
          geom.height_pt,
          scale,
          totalRot
        );
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }
  });

  annotCanvas.addEventListener("pointerup", (e: PointerEvent) => {
    if (!isDrawing) return;
    isDrawing = false;

    const scale = computeEffectivePageScale(tab, geom);
    const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
    const rect = annotCanvas.getBoundingClientRect();
    const cssWidth = annotCanvas.width || slot.clientWidth;
    const cssHeight = annotCanvas.height || slot.clientHeight;
    const sx = Math.max(0, Math.min(cssWidth, e.clientX - rect.left));
    const sy = Math.max(0, Math.min(cssHeight, e.clientY - rect.top));

    if (activeTool === "snip") {
      const start = snipStartScreen;
      snipStartScreen = null;
      // Restore clean annotation layer before compositing the snip!
      redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
      if (!start) return;

      const rx = Math.min(start[0], sx);
      const ry = Math.min(start[1], sy);
      const rw = Math.abs(sx - start[0]);
      const rh = Math.abs(sy - start[1]);
      if (rw < 8 || rh < 8) return;

      const renderCanvas =
        slot.querySelector<HTMLCanvasElement>(".pdf-render-canvas")!;
      const ratioX = renderCanvas.width / Math.max(1, cssWidth);
      const ratioY = renderCanvas.height / Math.max(1, cssHeight);

      const srcX = Math.max(0, Math.round(rx * ratioX));
      const srcY = Math.max(0, Math.round(ry * ratioY));
      const outW = Math.max(
        1,
        Math.min(renderCanvas.width - srcX, Math.round(rw * ratioX))
      );
      const outH = Math.max(
        1,
        Math.min(renderCanvas.height - srcY, Math.round(rh * ratioY))
      );

      const snipCanvas = document.createElement("canvas");
      snipCanvas.width = outW;
      snipCanvas.height = outH;
      const sCtx = snipCanvas.getContext("2d", { alpha: false })!;
      sCtx.drawImage(renderCanvas, srcX, srcY, outW, outH, 0, 0, outW, outH);
      if (annotCanvas.width > 1 && annotCanvas.height > 1) {
        sCtx.drawImage(annotCanvas, rx, ry, rw, rh, 0, 0, outW, outH);
      }

      const pngDataUrl = snipCanvas.toDataURL("image/png");
      snipCanvas.toBlob((blob) => {
        if (!blob) return;
        const baseDoc = tab.metadata.file_name.replace(/\.pdf$/i, "");
        pendingSnipState = {
          pngDataUrl,
          blob,
          width: outW,
          height: outH,
          defaultFileName: `${baseDoc}_p${geom.page_number}_snip.png`,
        };
        (
          document.getElementById("img-snip-preview") as HTMLImageElement
        ).src = pngDataUrl;
        document.getElementById("snip-dimensions-badge")!.textContent =
          `${outW} × ${outH} px`;
        document
          .getElementById("modal-snip-preview")!
          .classList.remove("hidden");
      }, "image/png");
      return;
    }

    const [xPt, yPt] = screenToPageCoords(
      sx,
      sy,
      geom.width_pt,
      geom.height_pt,
      scale,
      totalRot
    );

    const pageKey = String(geom.page_number);
    if (!tab.sidecar.annotations.pages[pageKey]) {
      tab.sidecar.annotations.pages[pageKey] = [];
    }

    if (activeTool === "pen" && currentPoints.length > 0) {
      tab.sidecar.annotations.pages[pageKey].push({
        type: "pen_stroke",
        id: uid("pen"),
        page_number: geom.page_number,
        color: annotColor,
        stroke_width: strokeWidth,
        points: currentPoints,
        created_at: new Date().toISOString(),
      });
    } else if (activeTool === "highlighter" && currentPoints.length > 0) {
      tab.sidecar.annotations.pages[pageKey].push({
        type: "highlighter_stroke",
        id: uid("hl"),
        page_number: geom.page_number,
        color: annotColor,
        stroke_width: Math.max(10, strokeWidth * 4.5),
        opacity: 0.35,
        points: currentPoints,
        created_at: new Date().toISOString(),
      });
    } else if (
      (activeTool === "highlight_text" || activeTool === "underline_text") &&
      boxStartPt
    ) {
      const rx = Math.min(boxStartPt[0], xPt);
      const ry = Math.min(boxStartPt[1], yPt);
      const rw = Math.max(12, Math.abs(xPt - boxStartPt[0]));
      const rh = Math.max(10, Math.abs(yPt - boxStartPt[1]));
      const kind: MarkupKind =
        activeTool === "highlight_text" ? "highlight" : "underline";
      const rectItem: PdfRect = { x: rx, y: ry, width: rw, height: rh };
      tab.sidecar.annotations.pages[pageKey].push({
        type: "text_markup",
        id: uid("markup"),
        page_number: geom.page_number,
        kind,
        color: annotColor,
        rects: [rectItem],
        text_snippet: `Page ${geom.page_number} ${kind}`,
        created_at: new Date().toISOString(),
      });
      boxStartPt = null;
    }

    currentPoints = [];
    redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
    renderSidebarPanels();
    syncToolbarAndThemeUI();
    scheduleSidecarSave(tab);
  });
}

function pushUndoSnapshot(tab: DocumentTabState): void {
  tab.undoStack.push(cloneAnnotations(tab.sidecar.annotations));
  if (tab.undoStack.length > 40) {
    tab.undoStack.shift();
  }
  tab.redoStack = [];
  syncToolbarAndThemeUI();
}

function redrawAllSlotsAnnotationsInPlace(): void {
  const tab = getActiveTab();
  if (!tab) return;
  const viewportEl = document.getElementById("pdf-viewport")!;
  const container = document.getElementById("pages-scroll-container")!;
  const vpW = viewportEl.clientWidth;
  const vpH = viewportEl.clientHeight;

  for (const pageNum of tab.renderedCacheOrder) {
    const slot = container.querySelector<HTMLElement>(
      `.pdf-page-slot[data-page-number="${pageNum}"]`
    );
    if (!slot) continue;
    const geom = tab.metadata.page_geometries[pageNum - 1];
    if (!geom) continue;
    const scale = computeEffectivePageScaleWithSize(tab, geom, vpW, vpH);
    const totalRot = (geom.rotation_deg + tab.rotationExtraDeg) % 360;
    redrawSlotAnnotationsAndNotes(slot, tab, geom, scale, totalRot);
  }
}

function performUndo(): void {
  const tab = getActiveTab();
  if (!tab || tab.undoStack.length === 0) return;
  tab.redoStack.push(cloneAnnotations(tab.sidecar.annotations));
  tab.sidecar.annotations = tab.undoStack.pop()!;
  redrawAllSlotsAnnotationsInPlace();
  renderSidebarPanels();
  syncToolbarAndThemeUI();
  scheduleSidecarSave(tab);
}

function performRedo(): void {
  const tab = getActiveTab();
  if (!tab || tab.redoStack.length === 0) return;
  tab.undoStack.push(cloneAnnotations(tab.sidecar.annotations));
  tab.sidecar.annotations = tab.redoStack.pop()!;
  redrawAllSlotsAnnotationsInPlace();
  renderSidebarPanels();
  syncToolbarAndThemeUI();
  scheduleSidecarSave(tab);
}

function eraseAnnotationsAtPoint(
  tab: DocumentTabState,
  pageNumber: number,
  xPt: number,
  yPt: number,
  radiusPt: number
): boolean {
  const key = String(pageNumber);
  const list = tab.sidecar.annotations.pages[key];
  if (!list || list.length === 0) return false;
  const before = list.length;
  tab.sidecar.annotations.pages[key] = list.filter(
    (item) => !hitTestAnnotation(item, xPt, yPt, radiusPt)
  );
  return tab.sidecar.annotations.pages[key].length !== before;
}

function removeAnnotationById(
  tab: DocumentTabState,
  pageNumber: number,
  id: string
): void {
  const key = String(pageNumber);
  const list = tab.sidecar.annotations.pages[key];
  if (!list) return;
  tab.sidecar.annotations.pages[key] = list.filter((item) => item.id !== id);
}

function navigateToPage(targetPage: number, recordHistory = false): void {
  const tab = getActiveTab();
  if (!tab) return;

  const clamped = Math.max(1, Math.min(tab.metadata.page_count, targetPage));
  const prevPage = tab.sidecar.reading_state.current_page;
  if (recordHistory && prevPage !== clamped) {
    tab.navBackStack.push(prevPage);
    tab.navForwardStack = [];
  }

  tab.sidecar.reading_state.current_page = clamped;

  if (tab.sidecar.reading_state.layout_mode === "single_page") {
    rebuildPageSlotsForActiveTab(true);
  } else {
    const container = document.getElementById("pages-scroll-container")!;
    const viewportEl = document.getElementById("pdf-viewport")!;
    const slot = container.querySelector<HTMLElement>(
      `.pdf-page-slot[data-page-number="${clamped}"]`
    );
    if (slot) {
      isProgrammaticScroll = true;
      viewportEl.scrollTop = Math.max(0, slot.offsetTop - 14);
      window.requestAnimationFrame(() => {
        isProgrammaticScroll = false;
      });
    }
    renderVisiblePagesForActiveTab();
  }

  syncToolbarAndThemeUI();
  scheduleSidecarSave(tab);
}

function renderSidebarPanels(): void {
  const tab = getActiveTab();
  const outlinePanel = document.getElementById("side-panel-outline")!;
  const bookmarksList = document.getElementById("bookmarks-list")!;
  const annotsList = document.getElementById("annotations-list")!;
  const recentList = document.getElementById("recent-docs-list")!;
  const sampleList = document.getElementById("sample-docs-list")!;
  const homeRecent = document.getElementById("home-recent-container")!;

  outlinePanel.innerHTML = "";
  if (!tab) {
    outlinePanel.innerHTML = `<div class="empty-side-msg">Open a PDF to view its Table of Contents.</div>`;
  } else if (tab.outline.length === 0) {
    outlinePanel.innerHTML = `<div class="empty-side-msg">No embedded outline / table of contents in this PDF.</div>`;
  } else {
    const list = document.createElement("div");
    list.className = "side-list";
    for (const node of tab.outline) {
      const btn = document.createElement("button");
      btn.className = "side-list-item";
      btn.innerHTML = `<span>${node.title}</span><span class="side-item-meta">p. ${node.pageNumber}</span>`;
      btn.addEventListener("click", () => navigateToPage(node.pageNumber, true));
      list.appendChild(btn);
    }
    outlinePanel.appendChild(list);
  }

  bookmarksList.innerHTML = "";
  if (tab && tab.sidecar.bookmarks.length > 0) {
    for (const bm of tab.sidecar.bookmarks) {
      const row = document.createElement("div");
      row.className = "side-list-item";
      row.innerHTML = `<span>🔖 ${bm.title}</span><span class="side-item-meta">p. ${bm.page_number}</span>`;
      row.addEventListener("click", () => navigateToPage(bm.page_number, true));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        tab.sidecar.bookmarks = tab.sidecar.bookmarks.filter(
          (b) => b.id !== bm.id
        );
        renderSidebarPanels();
        scheduleSidecarSave(tab);
      });
      bookmarksList.appendChild(row);
    }
  } else {
    bookmarksList.innerHTML = `<div class="empty-side-msg">No bookmarks yet. Press Ctrl+D to bookmark a page.</div>`;
  }

  annotsList.innerHTML = "";
  if (tab) {
    let any = false;
    for (const [pageStr, list] of Object.entries(
      tab.sidecar.annotations.pages
    )) {
      for (const item of list) {
        any = true;
        const row = document.createElement("button");
        row.className = "side-list-item";
        const label =
          item.type === "text_note"
            ? `✎ ${item.title || "Note"}: ${item.content.slice(0, 32)}`
            : item.type === "text_markup"
            ? `🖍 ${item.kind.toUpperCase()}`
            : item.type === "highlighter_stroke"
            ? "🖍 Highlighter Stroke"
            : "✒ Pen Stroke";
        row.innerHTML = `<span>${label}</span><span class="side-item-meta">p. ${pageStr}</span>`;
        row.addEventListener("click", () =>
          navigateToPage(Number(pageStr), true)
        );
        annotsList.appendChild(row);
      }
    }
    if (!any) {
      annotsList.innerHTML = `<div class="empty-side-msg">No annotations on this document yet.</div>`;
    }
  }

  recentList.innerHTML = "";
  homeRecent.innerHTML = "";
  if (appSettings && appSettings.recent_documents.length > 0) {
    for (const rec of appSettings.recent_documents.slice(0, 8)) {
      const btn = document.createElement("button");
      btn.className = "side-list-item";
      btn.title = rec.path;
      btn.innerHTML = `<span>📄 ${rec.file_name}</span><span class="side-item-meta">p. ${rec.last_page}/${rec.total_pages}</span>`;
      btn.addEventListener("click", () => void openPdfByPath(rec.path));
      recentList.appendChild(btn);
    }
  } else {
    recentList.innerHTML = `<div class="empty-side-msg">No recent PDFs yet.</div>`;
  }

  sampleList.innerHTML = "";
  for (const sp of samplePdfPaths) {
    const fileName = sp.split(/[\\/]/).pop() || sp;
    const btn = document.createElement("button");
    btn.className = "side-list-item";
    btn.innerHTML = `<span>🧪 ${fileName}</span><span class="side-item-meta">Open</span>`;
    btn.addEventListener("click", () => void openPdfByPath(sp));
    sampleList.appendChild(btn);
  }
}

function openNoteEditorModal(
  tabId: string,
  pageNumber: number,
  noteId: string | null,
  xPt: number,
  yPt: number
): void {
  const tab = openTabs.get(tabId);
  if (!tab) return;

  editingNoteState = { tabId, pageNumber, noteId, xPt, yPt };
  const modal = document.getElementById("modal-note-editor")!;
  const titleInput = document.getElementById("input-note-title") as HTMLInputElement;
  const contentInput = document.getElementById(
    "input-note-content"
  ) as HTMLTextAreaElement;
  const deleteBtn = document.getElementById("btn-note-delete")!;

  const list = tab.sidecar.annotations.pages[String(pageNumber)] || [];
  const existing = noteId
    ? list.find((a) => a.type === "text_note" && a.id === noteId)
    : undefined;

  if (existing && existing.type === "text_note") {
    titleInput.value = existing.title;
    contentInput.value = existing.content;
    deleteBtn.classList.remove("hidden");
  } else {
    titleInput.value = `Page ${pageNumber} Note`;
    contentInput.value = "";
    deleteBtn.classList.add("hidden");
  }

  modal.classList.remove("hidden");
  contentInput.focus();
}

function setActiveStudyTool(tool: StudyTool): void {
  activeTool = tool;
  document.querySelectorAll<HTMLElement>(".tool-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === tool);
  });
  document
    .querySelectorAll<HTMLElement>(".pdf-annot-canvas")
    .forEach((canvas) => {
      canvas.classList.toggle("interactive-tool", tool !== "select");
    });
}

function toggleIntelligentDarkMode(): void {
  const t0 = performance.now();
  const dm = getEffectiveDarkMode();
  dm.enabled = !dm.enabled;
  if (dm.enabled && dm.strategy === "original") {
    dm.strategy = "auto";
  }
  reapplyDarkModeToActiveTabInPlace(false);
  const latency = performance.now() - t0;
  const statusPerf = document.getElementById("status-perf-metrics");
  if (statusPerf) {
    statusPerf.textContent = `Dark Mode Switch: ${latency.toFixed(1)} ms`;
  }
  syncToolbarAndThemeUI();
  void persistGlobalSettings();
}

async function focusActiveSearchMatch(tab: DocumentTabState): Promise<void> {
  if (
    !tab.searchResult ||
    tab.searchResult.total_matches === 0 ||
    tab.searchResult.active_match_index === null
  ) {
    updateAllSlotsSearchHighlightsInPlace();
    return;
  }

  const activeMatch =
    tab.searchResult.matches[tab.searchResult.active_match_index];
  if (!activeMatch) return;

  const targetPage = activeMatch.page_number;
  await extractSinglePageTextAndSpans(tab, targetPage);

  if (tab.sidecar.reading_state.layout_mode === "single_page") {
    tab.sidecar.reading_state.current_page = targetPage;
    rebuildPageSlotsForActiveTab(true);
    return;
  }

  updateAllSlotsSearchHighlightsInPlace();

  const container = document.getElementById("pages-scroll-container")!;
  const viewportEl = document.getElementById("pdf-viewport")!;
  const slot = container.querySelector<HTMLElement>(
    `.pdf-page-slot[data-page-number="${targetPage}"]`
  );

  if (slot) {
    const geom = tab.metadata.page_geometries[targetPage - 1];
    const scale = geom ? computeEffectivePageScale(tab, geom) : 1.0;
    const totalRot = geom ? (geom.rotation_deg + tab.rotationExtraDeg) % 360 : 0;
    const matchY = geom
      ? redrawSlotSearchHighlights(slot, tab, targetPage, geom, scale, totalRot)
      : null;

    isProgrammaticScroll = true;
    tab.sidecar.reading_state.current_page = targetPage;
    if (matchY !== null) {
      viewportEl.scrollTop = Math.max(
        0,
        Math.round(slot.offsetTop + matchY - viewportEl.clientHeight * 0.35)
      );
    } else {
      viewportEl.scrollTop = Math.max(0, slot.offsetTop - 16);
    }
    window.requestAnimationFrame(() => {
      isProgrammaticScroll = false;
    });
    renderVisiblePagesForActiveTab();
    syncToolbarAndThemeUI();
  }
}

async function runFullTextSearch(): Promise<void> {
  const tab = getActiveTab();
  if (!tab) return;

  const query = (
    document.getElementById("input-search-query") as HTMLInputElement
  ).value;
  const caseSensitive = (
    document.getElementById("chk-search-case") as HTMLInputElement
  ).checked;
  const countLabel = document.getElementById("label-search-count")!;
  const ocrNotice = document.getElementById("search-ocr-notice")!;

  if (!query.trim()) {
    tab.searchResult = null;
    countLabel.textContent = "0 / 0";
    ocrNotice.classList.add("hidden");
    updateAllSlotsSearchHighlightsInPlace();
    return;
  }

  if (Object.keys(tab.pageTexts).length === 0) {
    countLabel.textContent = "Indexing...";
    const cur = tab.sidecar.reading_state.current_page;
    const quickPages: number[] = [];
    for (
      let p = Math.max(1, cur - 5);
      p <= Math.min(tab.metadata.page_count, cur + 20);
      p++
    ) {
      quickPages.push(p);
    }
    await Promise.all(
      quickPages.map((p) => extractSinglePageTextAndSpans(tab, p))
    );
  }

  const res = await invoke<SearchQueryResult>("search_document_text_cmd", {
    pages: tab.pageTexts,
    query,
    caseSensitive,
  });

  tab.searchResult = res;

  if (!res.has_searchable_text && tab.textExtractionDone) {
    ocrNotice.classList.remove("hidden");
    countLabel.textContent = "No text";
    updateAllSlotsSearchHighlightsInPlace();
    return;
  }
  ocrNotice.classList.add("hidden");

  if (res.total_matches === 0) {
    countLabel.textContent = tab.textExtractionDone ? "0 / 0" : "0 (indexing...)";
    updateAllSlotsSearchHighlightsInPlace();
  } else {
    const curPage = tab.sidecar.reading_state.current_page;
    let bestIdx = res.matches.findIndex((m) => m.page_number >= curPage);
    if (bestIdx < 0) bestIdx = 0;

    res.active_match_index = bestIdx;
    countLabel.textContent = `${bestIdx + 1} / ${res.total_matches}`;
    await focusActiveSearchMatch(tab);
  }
}

function stepSearchResult(forward: boolean): void {
  const tab = getActiveTab();
  if (!tab) return;
  if (!tab.searchResult || tab.searchResult.total_matches === 0) {
    void runFullTextSearch();
    return;
  }

  const total = tab.searchResult.total_matches;
  const cur = tab.searchResult.active_match_index ?? 0;
  const next = forward ? (cur + 1) % total : (cur - 1 + total) % total;
  tab.searchResult.active_match_index = next;

  const countLabel = document.getElementById("label-search-count")!;
  countLabel.textContent = `${next + 1} / ${total}`;
  void focusActiveSearchMatch(tab);
}

async function checkGitHubReleasesForUpdates(): Promise<void> {
  const statusLabel = document.getElementById("update-status-label")!;
  const detailsBox = document.getElementById("update-details-box")!;
  const btnDownload = document.getElementById("btn-download-update")!;
  const urlInput = document.getElementById(
    "input-update-manifest-url"
  ) as HTMLInputElement;

  const manifestUrl =
    urlInput.value.trim() ||
    "https://github.com/hydese/LuminaPDF/releases/latest/download/latest.json";
  appSettings.update_manifest_url = manifestUrl;
  void persistGlobalSettings();

  statusLabel.textContent = "Checking GitHub Releases...";
  btnDownload.classList.add("hidden");
  latestDownloadUrl = null;

  let fetchedManifestJson: string | null = null;

  try {
    const resp = await fetch(manifestUrl, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (resp.ok) {
      fetchedManifestJson = await resp.text();
    } else {
      const ghMatch = manifestUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
      if (ghMatch) {
        const owner = ghMatch[1];
        const repo = ghMatch[2];
        const apiResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
          { cache: "no-store", headers: { Accept: "application/vnd.github+json" } }
        );
        if (apiResp.ok) {
          const rel = (await apiResp.json()) as {
            tag_name?: string;
            published_at?: string;
            body?: string;
            assets?: Array<{ name?: string; browser_download_url?: string }>;
          };
          const exeAsset = (rel.assets || []).find((a) =>
            (a.name || "").toLowerCase().endsWith(".exe")
          );
          if (rel.tag_name && exeAsset?.browser_download_url) {
            const shaMatch = (rel.body || "").match(/\b([a-fA-F0-9]{64})\b/);
            fetchedManifestJson = JSON.stringify({
              version: rel.tag_name.replace(/^v/i, ""),
              pub_date: rel.published_at || new Date().toISOString(),
              notes: rel.body || `GitHub Release ${rel.tag_name}`,
              windows_x86_64: {
                url: exeAsset.browser_download_url,
                sha256:
                  shaMatch?.[1] ||
                  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                signature: null,
                installer_type: "nsis",
              },
            });
          }
        }
      }
    }
  } catch {
    // Offline or repository not yet public on GitHub
  }

  try {
    const res = await invoke<UpdateCheckResponse>("check_for_updates_cmd", {
      manifestJsonOverride: fetchedManifestJson,
    });
    statusLabel.textContent = res.status_message;
    detailsBox.classList.remove("hidden");
    detailsBox.textContent = `Installed: v${res.current_version} • Latest on Channel: v${res.latest_version} • ${res.release_notes}`;

    if (res.update_available && res.download_url) {
      latestDownloadUrl = res.download_url;
      btnDownload.textContent = `Download v${res.latest_version} Installer`;
      btnDownload.classList.remove("hidden");
    }
  } catch (err) {
    statusLabel.textContent = `Update check notice: ${String(err)}`;
  }
}

async function initApplication(): Promise<void> {
  const bootstrap = await invoke<BootstrapPayload>("get_app_bootstrap_state");
  appSettings = bootstrap.settings;
  samplePdfPaths = bootstrap.sample_pdf_paths;

  annotColor = appSettings.annotation_prefs.pen_color;
  strokeWidth = appSettings.annotation_prefs.pen_width;
  (document.getElementById("input-annot-color") as HTMLInputElement).value =
    annotColor;
  (document.getElementById("input-stroke-width") as HTMLInputElement).value =
    String(strokeWidth);

  (document.getElementById("about-version-text") as HTMLElement).textContent =
    bootstrap.app_version;
  (document.getElementById("about-platform-text") as HTMLElement).textContent =
    `${bootstrap.platform.os_name}-${bootstrap.platform.arch}`;
  (document.getElementById("update-status-label") as HTMLElement).textContent =
    `Up to date (v${bootstrap.app_version})`;
  (document.getElementById("chk-reopen-tabs") as HTMLInputElement).checked =
    appSettings.reopen_tabs_on_startup;
  (document.getElementById("chk-auto-updates") as HTMLInputElement).checked =
    appSettings.auto_check_updates;
  (
    document.getElementById("input-update-manifest-url") as HTMLInputElement
  ).value =
    appSettings.update_manifest_url ||
    "https://github.com/hydese/LuminaPDF/releases/latest/download/latest.json";

  syncToolbarAndThemeUI();
  renderSidebarPanels();

  if (appSettings.auto_check_updates) {
    void checkGitHubReleasesForUpdates();
  }

  if (bootstrap.startup_pdf_paths.length > 0) {
    for (const p of bootstrap.startup_pdf_paths) {
      await openPdfByPath(p);
    }
  } else if (
    appSettings.reopen_tabs_on_startup &&
    appSettings.last_open_tab_paths.length > 0
  ) {
    for (const p of appSettings.last_open_tab_paths) {
      await openPdfByPath(p);
    }
  }

  const promptOpenPdf = async () => {
    const selected = await openDialog({
      multiple: true,
      filters: [{ name: "PDF Documents", extensions: ["pdf"] }],
    });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    for (const p of paths) {
      await openPdfByPath(p);
    }
  };

  document
    .getElementById("btn-open-pdf")!
    .addEventListener("click", () => void promptOpenPdf());
  document
    .getElementById("btn-new-tab-open")!
    .addEventListener("click", () => void promptOpenPdf());
  document
    .getElementById("btn-hero-open")!
    .addEventListener("click", () => void promptOpenPdf());
  document.getElementById("btn-hero-samples")!.addEventListener("click", () => {
    if (samplePdfPaths.length > 0) {
      void openPdfByPath(samplePdfPaths[0]);
    }
  });

  document
    .getElementById("btn-export-pdf")!
    .addEventListener("click", async () => {
      const tab = getActiveTab();
      if (!tab) return;
      const defaultOut = tab.metadata.path.replace(
        /\.pdf$/i,
        "_annotated.pdf"
      );
      const outPath = await saveDialog({
        defaultPath: defaultOut,
        filters: [{ name: "PDF Document", extensions: ["pdf"] }],
      });
      if (!outPath) return;

      const isSameFile =
        outPath.replace(/\//g, "\\").toLowerCase() ===
        tab.metadata.path.replace(/\//g, "\\").toLowerCase();
      let allowOverwrite = false;
      if (isSameFile) {
        allowOverwrite = confirm(
          "Warning: You selected the original PDF file. Overwrite the original PDF with embedded annotations?"
        );
        if (!allowOverwrite) return;
      }

      try {
        const savedPath = await invoke<string>("export_annotated_pdf_cmd", {
          sourcePath: tab.metadata.path,
          outputPath: outPath,
          annotations: tab.sidecar.annotations,
          allowOverwrite,
        });
        alert(`Annotated PDF exported successfully to:\n${savedPath}`);
      } catch (err) {
        alert(`Export failed:\n${String(err)}`);
      }
    });

  let fsTopVisible = false;
  let fsLeftVisible = false;
  const topChromeWrapper = document.getElementById("top-chrome-wrapper");

  const setFsTopVisible = (show: boolean) => {
    if (fsTopVisible === show) return;
    fsTopVisible = show;
    document.body.classList.toggle("fs-show-top", show);
  };

  const setFsLeftVisible = (show: boolean) => {
    if (fsLeftVisible === show) return;
    fsLeftVisible = show;
    document.body.classList.toggle("fs-show-left", show);
  };

  document
    .getElementById("btn-toggle-sidebar")!
    .addEventListener("click", () => {
      if (isAppFullscreen) {
        setFsLeftVisible(!fsLeftVisible);
      } else {
        document.getElementById("left-sidebar")!.classList.toggle("collapsed");
        applyZoomOrResizeInPlace();
      }
    });

  document.querySelectorAll<HTMLElement>(".side-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.sideTab!;
      document
        .querySelectorAll(".side-tab-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      ["outline", "bookmarks", "annotations", "library"].forEach((name) => {
        document
          .getElementById(`side-panel-${name}`)!
          .classList.toggle("hidden", name !== target);
      });
    });
  });

  document.getElementById("btn-prev-page")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (tab) navigateToPage(tab.sidecar.reading_state.current_page - 1, false);
  });
  document.getElementById("btn-next-page")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (tab) navigateToPage(tab.sidecar.reading_state.current_page + 1, false);
  });
  document
    .getElementById("input-page-num")!
    .addEventListener("change", (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      if (!isNaN(val)) navigateToPage(val, true);
    });

  document.getElementById("btn-hist-back")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (!tab || tab.navBackStack.length === 0) return;
    const prev = tab.navBackStack.pop()!;
    tab.navForwardStack.push(tab.sidecar.reading_state.current_page);
    navigateToPage(prev, false);
  });

  document.getElementById("btn-hist-forward")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (!tab || tab.navForwardStack.length === 0) return;
    const next = tab.navForwardStack.pop()!;
    tab.navBackStack.push(tab.sidecar.reading_state.current_page);
    navigateToPage(next, false);
  });

  // Smooth Multiplicative Zoom (Initialized from current effective scale — up to 500%)
  const adjustZoom = (factor: number, focalClientY?: number) => {
    const tab = getActiveTab();
    if (!tab) return;
    const baseGeom = tab.metadata.page_geometries[0];
    const currentEffective = baseGeom
      ? computeEffectivePageScale(tab, baseGeom)
      : tab.sidecar.reading_state.zoom_scale;
    tab.sidecar.reading_state.fit_mode = "custom";
    tab.sidecar.reading_state.zoom_scale = Math.max(
      0.35,
      Math.min(5.0, Number((currentEffective * factor).toFixed(3)))
    );
    applyZoomOrResizeInPlace(focalClientY);
    scheduleSidecarSave(tab);
  };

  document
    .getElementById("btn-zoom-in")!
    .addEventListener("click", () => adjustZoom(1.15));
  document
    .getElementById("btn-zoom-out")!
    .addEventListener("click", () => adjustZoom(1 / 1.15));

  // Minimalist Bottom-Left Fullscreen HUD Controls
  document.getElementById("fs-btn-prev")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (tab) navigateToPage(tab.sidecar.reading_state.current_page - 1, false);
  });
  document.getElementById("fs-btn-next")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (tab) navigateToPage(tab.sidecar.reading_state.current_page + 1, false);
  });
  document
    .getElementById("fs-input-page")!
    .addEventListener("change", (e) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      if (!isNaN(val)) navigateToPage(val, true);
    });
  document
    .getElementById("fs-btn-zoom-in")!
    .addEventListener("click", () => adjustZoom(1.15));
  document
    .getElementById("fs-btn-zoom-out")!
    .addEventListener("click", () => adjustZoom(1 / 1.15));
  document.getElementById("fs-label-zoom")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (!tab) return;
    tab.sidecar.reading_state.fit_mode = "width";
    applyZoomOrResizeInPlace();
    scheduleSidecarSave(tab);
  });

  document.getElementById("select-zoom")!.addEventListener("change", (e) => {
    const tab = getActiveTab();
    if (!tab) return;
    const val = (e.target as HTMLSelectElement).value;
    if (val === "fit-width") {
      tab.sidecar.reading_state.fit_mode = "width";
    } else if (val === "fit-page") {
      tab.sidecar.reading_state.fit_mode = "page";
    } else {
      tab.sidecar.reading_state.fit_mode = "custom";
      tab.sidecar.reading_state.zoom_scale = parseFloat(val) || 1.15;
    }
    applyZoomOrResizeInPlace();
    scheduleSidecarSave(tab);
  });

  document
    .getElementById("btn-layout-toggle")!
    .addEventListener("click", () => {
      const tab = getActiveTab();
      if (!tab) return;
      tab.sidecar.reading_state.layout_mode =
        tab.sidecar.reading_state.layout_mode === "continuous"
          ? "single_page"
          : "continuous";
      rebuildPageSlotsForActiveTab(true);
      syncToolbarAndThemeUI();
      scheduleSidecarSave(tab);
    });

  document.getElementById("btn-rotate-page")!.addEventListener("click", () => {
    const tab = getActiveTab();
    if (!tab) return;
    tab.rotationExtraDeg = (tab.rotationExtraDeg + 90) % 360;
    applyZoomOrResizeInPlace();
  });

  document
    .getElementById("btn-dark-mode-toggle")!
    .addEventListener("click", () => toggleIntelligentDarkMode());

  const dmPopover = document.getElementById("dark-mode-popover")!;
  const btnDmSettings = document.getElementById("btn-dark-mode-settings")!;
  btnDmSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    dmPopover.classList.toggle("hidden");
  });

  document.addEventListener("pointerdown", (e) => {
    if (dmPopover.classList.contains("hidden")) return;
    const target = e.target as Node | null;
    if (
      target &&
      !dmPopover.contains(target) &&
      !btnDmSettings.contains(target)
    ) {
      dmPopover.classList.add("hidden");
    }
  });

  document
    .getElementById("btn-dm-reset-auto")!
    .addEventListener("click", () => {
      const dm = getEffectiveDarkMode();
      resetConfigToAutoHybrid(dm);
      reapplyDarkModeToActiveTabInPlace(false);
      syncToolbarAndThemeUI();
      void persistGlobalSettings();
    });

  document
    .getElementById("btn-dm-restore-original")!
    .addEventListener("click", () => {
      const dm = getEffectiveDarkMode();
      dm.enabled = false;
      reapplyDarkModeToActiveTabInPlace(false);
      syncToolbarAndThemeUI();
      void persistGlobalSettings();
    });

  document
    .getElementById("select-dm-strategy")!
    .addEventListener("change", (e) => {
      const val = (e.target as HTMLSelectElement).value as DarkRenderingStrategy;
      const dm = getEffectiveDarkMode();
      if (val === "original") {
        dm.enabled = false;
      } else {
        dm.enabled = true;
        dm.strategy = val;
      }
      reapplyDarkModeToActiveTabInPlace(false);
      syncToolbarAndThemeUI();
      void persistGlobalSettings();
    });

  document.getElementById("select-dm-bg")!.addEventListener("change", (e) => {
    const dm = getEffectiveDarkMode();
    dm.background_preset = (e.target as HTMLSelectElement)
      .value as BackgroundPreset;
    reapplyDarkModeToActiveTabInPlace(false);
    syncToolbarAndThemeUI();
    void persistGlobalSettings();
  });

  document
    .getElementById("range-dm-brightness")!
    .addEventListener("input", (e) => {
      const dm = getEffectiveDarkMode();
      dm.text_brightness = parseFloat((e.target as HTMLInputElement).value);
      syncToolbarAndThemeUI();
      scheduleSliderDarkModeUpdate();
    });
  document
    .getElementById("range-dm-brightness")!
    .addEventListener("change", () => {
      reapplyDarkModeToActiveTabInPlace(false);
      void persistGlobalSettings();
    });

  document
    .getElementById("range-dm-contrast")!
    .addEventListener("input", (e) => {
      const dm = getEffectiveDarkMode();
      dm.contrast_boost = parseFloat((e.target as HTMLInputElement).value);
      syncToolbarAndThemeUI();
      scheduleSliderDarkModeUpdate();
    });
  document
    .getElementById("range-dm-contrast")!
    .addEventListener("change", () => {
      reapplyDarkModeToActiveTabInPlace(false);
      void persistGlobalSettings();
    });

  document.getElementById("chk-dm-photos")!.addEventListener("change", (e) => {
    const dm = getEffectiveDarkMode();
    dm.preserve_photographs = (e.target as HTMLInputElement).checked;
    reapplyDarkModeToActiveTabInPlace(false);
    syncToolbarAndThemeUI();
    void persistGlobalSettings();
  });

  document
    .getElementById("chk-dm-diagrams")!
    .addEventListener("change", (e) => {
      const dm = getEffectiveDarkMode();
      dm.preserve_diagram_colors = (e.target as HTMLInputElement).checked;
      reapplyDarkModeToActiveTabInPlace(false);
      syncToolbarAndThemeUI();
      void persistGlobalSettings();
    });

  document.querySelectorAll<HTMLElement>(".tool-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setActiveStudyTool(btn.dataset.tool as StudyTool);
    });
  });

  document
    .getElementById("input-annot-color")!
    .addEventListener("input", (e) => {
      annotColor = (e.target as HTMLInputElement).value;
      appSettings.annotation_prefs.pen_color = annotColor;
    });

  document
    .getElementById("input-stroke-width")!
    .addEventListener("input", (e) => {
      strokeWidth = parseFloat((e.target as HTMLInputElement).value);
      appSettings.annotation_prefs.pen_width = strokeWidth;
    });

  document
    .getElementById("btn-undo")!
    .addEventListener("click", () => performUndo());
  document
    .getElementById("btn-redo")!
    .addEventListener("click", () => performRedo());

  const addBookmarkForCurrentPage = () => {
    const tab = getActiveTab();
    if (!tab) return;
    const p = tab.sidecar.reading_state.current_page;
    const existingIdx = tab.sidecar.bookmarks.findIndex(
      (b) => b.page_number === p
    );
    if (existingIdx >= 0) {
      tab.sidecar.bookmarks.splice(existingIdx, 1);
    } else {
      tab.sidecar.bookmarks.push({
        id: uid("bm"),
        page_number: p,
        title: `Page ${p} Bookmark`,
        created_at: new Date().toISOString(),
      });
      tab.sidecar.bookmarks.sort((a, b) => a.page_number - b.page_number);
    }
    renderSidebarPanels();
    scheduleSidecarSave(tab);
  };

  document
    .getElementById("btn-bookmark-page")!
    .addEventListener("click", addBookmarkForCurrentPage);
  document
    .getElementById("btn-add-bookmark-side")!
    .addEventListener("click", addBookmarkForCurrentPage);

  const searchBar = document.getElementById("search-bar")!;
  const btnSearchToggle = document.getElementById("btn-search-toggle")!;
  const searchInput = document.getElementById(
    "input-search-query"
  ) as HTMLInputElement;

  const openSearchBar = () => {
    searchBar.classList.remove("hidden");
    btnSearchToggle.classList.add("active");
    searchInput.focus();
    searchInput.select();
    if (searchInput.value.trim()) {
      void runFullTextSearch();
    }
  };

  const closeSearchBar = () => {
    searchBar.classList.add("hidden");
    btnSearchToggle.classList.remove("active");
    const tab = getActiveTab();
    if (tab) {
      tab.searchResult = null;
      updateAllSlotsSearchHighlightsInPlace();
    }
  };

  btnSearchToggle.addEventListener("click", () => {
    if (searchBar.classList.contains("hidden")) {
      openSearchBar();
    } else {
      closeSearchBar();
    }
  });
  document
    .getElementById("btn-search-close")!
    .addEventListener("click", closeSearchBar);
  document
    .getElementById("btn-search-run")!
    .addEventListener("click", () => void runFullTextSearch());
  searchInput.addEventListener("input", () => void runFullTextSearch());
  document
    .getElementById("chk-search-case")!
    .addEventListener("change", () => void runFullTextSearch());
  document
    .getElementById("btn-search-next")!
    .addEventListener("click", () => stepSearchResult(true));
  document
    .getElementById("btn-search-prev")!
    .addEventListener("click", () => stepSearchResult(false));

  document.getElementById("btn-note-cancel")!.addEventListener("click", () => {
    document.getElementById("modal-note-editor")!.classList.add("hidden");
    editingNoteState = null;
  });
  document.getElementById("btn-note-save")!.addEventListener("click", () => {
    if (!editingNoteState) return;
    const tab = openTabs.get(editingNoteState.tabId);
    if (!tab) return;
    pushUndoSnapshot(tab);

    const title = (
      document.getElementById("input-note-title") as HTMLInputElement
    ).value.trim();
    const content = (
      document.getElementById("input-note-content") as HTMLTextAreaElement
    ).value.trim();
    const key = String(editingNoteState.pageNumber);
    if (!tab.sidecar.annotations.pages[key]) {
      tab.sidecar.annotations.pages[key] = [];
    }

    if (editingNoteState.noteId) {
      for (const item of tab.sidecar.annotations.pages[key]) {
        if (item.type === "text_note" && item.id === editingNoteState.noteId) {
          item.title = title || "Study Note";
          item.content = content;
          item.updated_at = new Date().toISOString();
        }
      }
    } else {
      tab.sidecar.annotations.pages[key].push({
        type: "text_note",
        id: uid("note"),
        page_number: editingNoteState.pageNumber,
        x: editingNoteState.xPt,
        y: editingNoteState.yPt,
        color: "#fbbf24",
        title: title || "Study Note",
        content,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    document.getElementById("modal-note-editor")!.classList.add("hidden");
    editingNoteState = null;
    redrawAllSlotsAnnotationsInPlace();
    renderSidebarPanels();
    scheduleSidecarSave(tab);
  });

  document.getElementById("btn-note-delete")!.addEventListener("click", () => {
    if (!editingNoteState || !editingNoteState.noteId) return;
    const tab = openTabs.get(editingNoteState.tabId);
    if (!tab) return;
    pushUndoSnapshot(tab);
    removeAnnotationById(
      tab,
      editingNoteState.pageNumber,
      editingNoteState.noteId
    );
    document.getElementById("modal-note-editor")!.classList.add("hidden");
    editingNoteState = null;
    redrawAllSlotsAnnotationsInPlace();
    renderSidebarPanels();
    scheduleSidecarSave(tab);
  });

  document
    .getElementById("btn-banner-dismiss")!
    .addEventListener("click", () => {
      document.getElementById("banner-warning")!.classList.add("hidden");
    });
  document
    .getElementById("btn-banner-migrate")!
    .addEventListener("click", async () => {
      const tab = getActiveTab();
      if (!tab || !tab.previousModifiedHash) return;
      try {
        const updated = await invoke<DocumentSidecar>(
          "migrate_previous_annotations",
          {
            currentSidecar: tab.sidecar,
            previousSha256: tab.previousModifiedHash,
          }
        );
        tab.sidecar = updated;
        document.getElementById("banner-warning")!.classList.add("hidden");
        redrawAllSlotsAnnotationsInPlace();
        renderSidebarPanels();
      } catch (err) {
        alert(`Could not migrate previous annotations:\n${String(err)}`);
      }
    });

  const openSettingsModal = () => {
    const tab = getActiveTab();
    if (tab) {
      (document.getElementById("chk-adjacent-sidecar") as HTMLInputElement).checked =
        tab.sidecar.write_adjacent_sidecar;
    }
    (document.getElementById("select-app-ui-theme") as HTMLSelectElement).value =
      appSettings.app_theme === "light" ? "light" : "dark";
    document.getElementById("modal-about")!.classList.remove("hidden");
  };

  const syncFullscreenUI = (fs: boolean) => {
    isAppFullscreen = fs;
    document.body.classList.toggle("is-fullscreen", fs);
    setFsTopVisible(false);
    setFsLeftVisible(false);
    const btnFs = document.getElementById("btn-fullscreen-toggle");
    const enterIcon = document.getElementById("icon-fullscreen-enter");
    const exitIcon = document.getElementById("icon-fullscreen-exit");
    if (btnFs) {
      btnFs.classList.toggle("active", fs);
      btnFs.title = fs ? "Exit Full Screen (F11)" : "Toggle Full Screen Mode (F11)";
    }
    if (enterIcon) enterIcon.classList.toggle("hidden", fs);
    if (exitIcon) exitIcon.classList.toggle("hidden", !fs);
    syncToolbarAndThemeUI();
    window.requestAnimationFrame(() => applyZoomOrResizeInPlace());
  };

  // Apple-style edge-proximity reveal in Full Screen (zero DOM reflow, GPU-composited)
  window.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (!isAppFullscreen) return;
      const x = e.clientX;
      const y = e.clientY;

      if (!fsTopVisible) {
        if (y <= 8) {
          setFsTopVisible(true);
        }
      } else {
        const keepTopPinned =
          !dmPopover.classList.contains("hidden") ||
          (topChromeWrapper !== null &&
            document.activeElement !== null &&
            topChromeWrapper.contains(document.activeElement) &&
            (document.activeElement.tagName === "SELECT" ||
              document.activeElement.tagName === "INPUT"));
        if (y > 92 && !keepTopPinned) {
          setFsTopVisible(false);
        }
      }

      if (!fsLeftVisible) {
        if (x <= 8 && y > 86 && y < window.innerHeight - 64) {
          setFsLeftVisible(true);
        }
      } else if (x > 268) {
        setFsLeftVisible(false);
      }
    },
    { passive: true }
  );

  const toggleAppFullscreen = async () => {
    try {
      const nextFs = await invoke<boolean>("toggle_fullscreen_cmd");
      syncFullscreenUI(nextFs);
    } catch {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen().catch(() => {});
        syncFullscreenUI(true);
      } else {
        await document.exitFullscreen().catch(() => {});
        syncFullscreenUI(false);
      }
    }
  };

  document
    .getElementById("btn-fullscreen-toggle")!
    .addEventListener("click", () => void toggleAppFullscreen());
  document
    .getElementById("btn-open-settings")!
    .addEventListener("click", openSettingsModal);

  const selectSharpness = document.getElementById(
    "select-text-sharpness"
  ) as HTMLSelectElement;
  selectSharpness.value = readSharpnessPreset();
  selectSharpness.addEventListener("change", () => {
    const v =
      selectSharpness.value in SHARPNESS_BIAS
        ? selectSharpness.value
        : "balanced";
    sharpnessBias = SHARPNESS_BIAS[v];
    try {
      window.localStorage.setItem("lumina_text_sharpness", v);
    } catch {
      /* storage unavailable */
    }
    applyZoomOrResizeInPlace();
  });

  document
    .getElementById("select-app-ui-theme")!
    .addEventListener("change", (e) => {
      const val = (e.target as HTMLSelectElement).value;
      appSettings.app_theme = val === "light" ? "light" : "dark";
      syncToolbarAndThemeUI();
      void persistGlobalSettings();
    });

  document
    .getElementById("btn-reset-pen-white")!
    .addEventListener("click", () => {
      annotColor = "#ffffff";
      appSettings.annotation_prefs.pen_color = "#ffffff";
      (document.getElementById("input-annot-color") as HTMLInputElement).value =
        "#ffffff";
      void persistGlobalSettings();
      showAppToast("Default pencil color set to White (#FFFFFF)");
    });

  // Snipping Tool Preview & Export Actions
  const modalSnip = document.getElementById("modal-snip-preview")!;
  const closeSnipModal = () => {
    modalSnip.classList.add("hidden");
    pendingSnipState = null;
  };

  const copyPendingSnipToClipboard = async () => {
    if (!pendingSnipState) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": pendingSnipState.blob }),
      ]);
      closeSnipModal();
      showAppToast("Copied region snip to clipboard");
    } catch (err) {
      alert(`Could not copy snip to clipboard:\n${String(err)}`);
    }
  };

  const savePendingSnipAsPng = async () => {
    if (!pendingSnipState) return;
    const snap = pendingSnipState;
    const outPath = await saveDialog({
      defaultPath: snap.defaultFileName,
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (!outPath) return;
    try {
      await invoke<string>("save_png_snip_cmd", {
        outputPath: outPath,
        pngBase64: snap.pngDataUrl,
      });
      closeSnipModal();
      showAppToast("Saved region snip as PNG");
    } catch (err) {
      alert(`Failed to save PNG:\n${String(err)}`);
    }
  };

  document
    .getElementById("btn-snip-copy")!
    .addEventListener("click", () => void copyPendingSnipToClipboard());
  document
    .getElementById("btn-snip-save")!
    .addEventListener("click", () => void savePendingSnipAsPng());
  document
    .getElementById("btn-snip-cancel")!
    .addEventListener("click", closeSnipModal);
  document
    .getElementById("btn-close-snip")!
    .addEventListener("click", closeSnipModal);

  document
    .getElementById("btn-shortcuts-help")!
    .addEventListener("click", () => {
      document.getElementById("modal-shortcuts")!.classList.remove("hidden");
    });
  document
    .getElementById("btn-close-shortcuts")!
    .addEventListener("click", () => {
      document.getElementById("modal-shortcuts")!.classList.add("hidden");
    });

  document.getElementById("btn-close-about")!.addEventListener("click", () => {
    document.getElementById("modal-about")!.classList.add("hidden");
  });

  // Allow clicking backdrop outside `.modal-card` to dismiss modals cleanly
  for (const modalId of ["modal-about", "modal-shortcuts", "modal-snip-preview"]) {
    const mEl = document.getElementById(modalId);
    if (mEl) {
      mEl.addEventListener("pointerdown", (e) => {
        if (e.target === mEl) {
          mEl.classList.add("hidden");
          if (modalId === "modal-snip-preview") pendingSnipState = null;
        }
      });
    }
  }

  document
    .getElementById("btn-open-github-repo")!
    .addEventListener("click", () => {
      const urlInput = (
        document.getElementById("input-update-manifest-url") as HTMLInputElement
      ).value;
      const ghMatch = urlInput.match(/https:\/\/github\.com\/[^/]+\/[^/]+/i);
      const repoUrl = ghMatch
        ? `${ghMatch[0]}/releases`
        : "https://github.com/hydese/LuminaPDF/releases";
      void openExternalUrl(repoUrl);
    });

  document
    .getElementById("input-update-manifest-url")!
    .addEventListener("change", (e) => {
      appSettings.update_manifest_url = (
        e.target as HTMLInputElement
      ).value.trim();
      void persistGlobalSettings();
    });

  document
    .getElementById("btn-download-update")!
    .addEventListener("click", () => {
      if (latestDownloadUrl && latestDownloadUrl.startsWith("https://")) {
        void openExternalUrl(latestDownloadUrl);
      }
    });

  document
    .getElementById("chk-reopen-tabs")!
    .addEventListener("change", (e) => {
      appSettings.reopen_tabs_on_startup = (
        e.target as HTMLInputElement
      ).checked;
      void persistGlobalSettings();
    });
  document
    .getElementById("chk-adjacent-sidecar")!
    .addEventListener("change", (e) => {
      const tab = getActiveTab();
      if (tab) {
        tab.sidecar.write_adjacent_sidecar = (
          e.target as HTMLInputElement
        ).checked;
        scheduleSidecarSave(tab, true);
      }
    });
  document
    .getElementById("chk-auto-updates")!
    .addEventListener("change", (e) => {
      appSettings.auto_check_updates = (e.target as HTMLInputElement).checked;
      void persistGlobalSettings();
    });

  document
    .getElementById("btn-check-updates-now")!
    .addEventListener("click", () => {
      void checkGitHubReleasesForUpdates();
    });

  const viewportEl = document.getElementById("pdf-viewport")!;
  viewportEl.addEventListener("scroll", () => {
    if (scrollRenderRaf !== null) return;
    scrollRenderRaf = window.requestAnimationFrame(() => {
      scrollRenderRaf = null;
      renderVisiblePagesForActiveTab();
    });
  });

  // Ctrl + MouseWheel Smooth Focal-Point Zoom
  viewportEl.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        adjustZoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientY);
      }
    },
    { passive: false }
  );

  try {
    await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        viewportEl.classList.add("drag-over");
      } else if (event.payload.type === "drop") {
        viewportEl.classList.remove("drag-over");
        for (const p of event.payload.paths) {
          if (p.toLowerCase().endsWith(".pdf")) {
            void openPdfByPath(p);
          }
        }
      } else {
        viewportEl.classList.remove("drag-over");
      }
    });
  } catch {
    // Fallback outside Tauri webview
  }

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const isInput =
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    const mod = e.ctrlKey || e.metaKey;

    if (e.key === "F11") {
      e.preventDefault();
      void toggleAppFullscreen();
      return;
    }
    if (mod && e.key === ",") {
      e.preventDefault();
      openSettingsModal();
      return;
    }
    if (!modalSnip.classList.contains("hidden")) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeSnipModal();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void copyPendingSnipToClipboard();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void savePendingSnipAsPng();
        return;
      }
    }
    if (mod && e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      setActiveStudyTool("snip");
      showAppToast("Snipping Tool active — drag a rectangle on the PDF");
      return;
    }

    if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      toggleIntelligentDarkMode();
      return;
    }
    if (mod && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void promptOpenPdf();
      return;
    }
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openSearchBar();
      return;
    }
    if (mod && e.key.toLowerCase() === "w") {
      e.preventDefault();
      if (activeTabId) void closeTab(activeTabId);
      return;
    }
    if (mod && e.key === "Tab") {
      e.preventDefault();
      const ids = Array.from(openTabs.keys());
      if (ids.length > 1 && activeTabId) {
        const idx = ids.indexOf(activeTabId);
        const nextIdx = e.shiftKey
          ? (idx - 1 + ids.length) % ids.length
          : (idx + 1) % ids.length;
        switchToTab(ids[nextIdx]);
      }
      return;
    }

    if (isInput) {
      if (e.key === "Escape") {
        closeSearchBar();
        (target as HTMLElement).blur();
      } else if (e.key === "Enter" && target === searchInput) {
        e.preventDefault();
        stepSearchResult(!e.shiftKey);
      }
      return;
    }

    if (mod && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      adjustZoom(1.15);
    } else if (mod && e.key === "-") {
      e.preventDefault();
      adjustZoom(1 / 1.15);
    } else if (mod && e.key === "0") {
      e.preventDefault();
      const tab = getActiveTab();
      if (tab) {
        tab.sidecar.reading_state.fit_mode = "width";
        applyZoomOrResizeInPlace();
        scheduleSidecarSave(tab);
      }
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) performRedo();
      else performUndo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      performRedo();
    } else if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      addBookmarkForCurrentPage();
    } else if (mod && e.key.toLowerCase() === "b") {
      e.preventDefault();
      if (isAppFullscreen) {
        setFsLeftVisible(!fsLeftVisible);
      } else {
        document.getElementById("left-sidebar")!.classList.toggle("collapsed");
        applyZoomOrResizeInPlace();
      }
    } else if (e.key === "PageDown") {
      e.preventDefault();
      const tab = getActiveTab();
      if (tab) navigateToPage(tab.sidecar.reading_state.current_page + 1, false);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      const tab = getActiveTab();
      if (tab) navigateToPage(tab.sidecar.reading_state.current_page - 1, false);
    } else if (e.key === "Home") {
      e.preventDefault();
      navigateToPage(1, true);
    } else if (e.key === "End") {
      e.preventDefault();
      const tab = getActiveTab();
      if (tab) navigateToPage(tab.metadata.page_count, true);
    } else if (e.key === "F1" || e.key === "?") {
      e.preventDefault();
      document.getElementById("modal-shortcuts")!.classList.toggle("hidden");
    } else if (e.key === "Escape") {
      const modalAbout = document.getElementById("modal-about")!;
      const modalShort = document.getElementById("modal-shortcuts")!;
      if (!modalAbout.classList.contains("hidden")) {
        modalAbout.classList.add("hidden");
      } else if (!modalShort.classList.contains("hidden")) {
        modalShort.classList.add("hidden");
      } else if (!dmPopover.classList.contains("hidden")) {
        dmPopover.classList.add("hidden");
      } else if (!searchBar.classList.contains("hidden")) {
        closeSearchBar();
      } else if (activeTool !== "select") {
        setActiveStudyTool("select");
      } else if (isAppFullscreen) {
        void invoke<boolean>("set_fullscreen_cmd", { fullscreen: false })
          .then(() => syncFullscreenUI(false))
          .catch(() => {});
      }
    } else if (!mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "v") setActiveStudyTool("select");
      else if (k === "p") setActiveStudyTool("pen");
      else if (k === "h") setActiveStudyTool("highlighter");
      else if (k === "m") setActiveStudyTool("highlight_text");
      else if (k === "u") setActiveStudyTool("underline_text");
      else if (k === "n") setActiveStudyTool("note");
      else if (k === "e") setActiveStudyTool("eraser");
      else if (k === "s") {
        setActiveStudyTool("snip");
        showAppToast("Snipping Tool active — drag a rectangle on the PDF");
      }
    }
  });

  window.addEventListener("resize", () => {
    applyZoomOrResizeInPlace();
  });

  window.addEventListener("beforeunload", () => {
    for (const tab of openTabs.values()) {
      scheduleSidecarSave(tab, true);
    }
    void persistGlobalSettings();
  });
}

window.addEventListener("DOMContentLoaded", () => {
  void initApplication();
});
