const $ = (selector) => document.querySelector(selector);

const elements = {
  backendState: $("#backendState"), gatewayState: $("#gatewayState"), rosState: $("#rosState"),
  mapState: $("#mapState"), locState: $("#locState"), publishState: $("#publishState"),
  bridgeMode: $("#bridgeMode"), systemClock: $("#systemClock"),
  domFileButton: $("#domFileButton"), onlineButton: $("#onlineButton"), domLocateButton: $("#domLocateButton"),
  rectButton: $("#rectButton"), polygonButton: $("#polygonButton"), fitButton: $("#fitButton"),
  domZoomOutButton: $("#domZoomOutButton"), domNativeButton: $("#domNativeButton"), domZoomInButton: $("#domZoomInButton"),
  domZoomValue: $("#domZoomValue"), domExpandButton: $("#domExpandButton"),
  domFileInput: $("#domFileInput"),
  dsmFileButton: $("#dsmFileButton"), dsmFitButton: $("#dsmFitButton"), dsmLocateButton: $("#dsmLocateButton"),
  dsmRectButton: $("#dsmRectButton"),
  dsmZoomOutButton: $("#dsmZoomOutButton"), dsmNativeButton: $("#dsmNativeButton"), dsmZoomInButton: $("#dsmZoomInButton"),
  dsmZoomValue: $("#dsmZoomValue"), dsmExpandButton: $("#dsmExpandButton"),
  dsmFileInput: $("#dsmFileInput"),
  mapWorkspace: $(".dual-map-workspace"),
  mapViewport: $("#mapViewport"), mapContent: $("#mapContent"), vectorLayer: $("#vectorLayer"),
  dsmViewport: $("#dsmViewport"), dsmContent: $("#dsmContent"), dsmVectorLayer: $("#dsmVectorLayer"),
  drawHint: $("#drawHint"), dsmDrawHint: $("#dsmDrawHint"),
  domTrajectoryLegend: $("#domTrajectoryLegend"), dsmTrajectoryLegend: $("#dsmTrajectoryLegend"),
  cursorReadout: $("#cursorReadout"), dsmCursorReadout: $("#dsmCursorReadout"),
  domMapMeta: $("#domMapMeta"), dsmMapMeta: $("#dsmMapMeta"), dsmRangeValue: $("#dsmRangeValue"),
  groundElevationValue: $("#groundElevationValue"), flagSelect: $("#flagSelect"),
  regionSelect: $("#regionSelect"), deleteRegionButton: $("#deleteRegionButton"), topicInput: $("#topicInput"),
  publishButton: $("#publishButton"), stopButton: $("#stopButton"), publishStatus: $("#publishStatus"),
  publicationList: $("#publicationList"),
  startLocButton: $("#startLocButton"), locProgramState: $("#locProgramState"),
  rosMasterValue: $("#rosMasterValue"), rosNodeValue: $("#rosNodeValue"),
  messageTypeValue: $("#messageTypeValue"), launchConfigValue: $("#launchConfigValue"),
  processValue: $("#processValue"), localizationError: $("#localizationError"),
  graphEndpoint: $("#graphEndpoint"), agentPrompt: $("#agentPrompt"), agentType: $("#agentType"),
  runAgentButton: $("#runAgentButton"), agentOutput: $("#agentOutput"), topicName: $("#topicName"),
  latValue: $("#latValue"), lonValue: $("#lonValue"), altValue: $("#altValue"),
  headingValue: $("#headingValue"), speedValue: $("#speedValue"), sourceValue: $("#sourceValue"),
  regionReadout: $("#regionReadout"), eventLog: $("#eventLog"),
  regionConfirmDialog: $("#regionConfirmDialog"), pendingRegionSource: $("#pendingRegionSource"),
  pendingRegionName: $("#pendingRegionName"), pendingRegionCoordinates: $("#pendingRegionCoordinates"),
  confirmRegionButton: $("#confirmRegionButton")
};

const TILE_SIZE = 256;
const MAX_HISTORY = 240;
const MAX_TRAJECTORY_TOPICS = 8;
const MAX_VISIBLE_TILES = 144;
const DEFAULT_CACHED_TILE_NODES = 192;
const TILE_REFRESH_DELAY_MS = 150;
const UI_PREFERENCES_KEY = "skyforge-ui-preferences-v1";
const REGION_PALETTE = [
  { stroke: "#53d8fb", fill: "rgba(83, 216, 251, 0.12)", selectedFill: "rgba(83, 216, 251, 0.22)" },
  { stroke: "#ffc857", fill: "rgba(255, 200, 87, 0.12)", selectedFill: "rgba(255, 200, 87, 0.22)" },
  { stroke: "#70e000", fill: "rgba(112, 224, 0, 0.11)", selectedFill: "rgba(112, 224, 0, 0.21)" },
  { stroke: "#ff6b9e", fill: "rgba(255, 107, 158, 0.11)", selectedFill: "rgba(255, 107, 158, 0.21)" },
  { stroke: "#ff8c42", fill: "rgba(255, 140, 66, 0.11)", selectedFill: "rgba(255, 140, 66, 0.21)" },
  { stroke: "#45f0c1", fill: "rgba(69, 240, 193, 0.11)", selectedFill: "rgba(69, 240, 193, 0.21)" },
  { stroke: "#b892ff", fill: "rgba(184, 146, 255, 0.11)", selectedFill: "rgba(184, 146, 255, 0.21)" },
  { stroke: "#f25f5c", fill: "rgba(242, 95, 92, 0.11)", selectedFill: "rgba(242, 95, 92, 0.21)" }
];
const SECONDARY_TRAJECTORY_COLORS = [
  "#ff3b30", "#00d084", "#0066ff", "#ff9500", "#af52de", "#00bcd4", "#ff2d92"
];
const MIN_MAP_SCALE = 0.0001;
const MAX_MAP_SCALE = 32;
const SVG_NS = "http://www.w3.org/2000/svg";
const ONLINE_TILE_SOURCE = {
  label: "Esri World Imagery", z: 15, centerX: 26979, centerY: 12416, radiusX: 3, radiusY: 2,
  fingerprint: "online:esri-world-imagery:z15:26976-26982:12414-12418",
  url: (z, x, y) => `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
};
const DEFAULT_BOUNDS = { north: 40.015, west: 116.315, south: 39.835, east: 116.505 };
const createSource = (type = "demo") => ({
  type, fingerprint: `${type}:empty`, width: 1600, height: 1000, bounds: DEFAULT_BOUNDS,
  z: null, minX: 0, minY: 0, loaded: false
});

const state = {
  source: createSource(),
  view: { x: 0, y: 0, scale: 1 },
  drag: null,
  dsmSource: createSource("dsm-empty"),
  dsmView: { x: 0, y: 0, scale: 1 },
  dsmDrag: null,
  regions: [], selectedRegionId: "", drawKind: null, drawMode: null, selectionEl: null,
  polygonPoints: [], polygonCursor: null, latestTelemetry: null, telemetryHistory: [],
  publishing: false, publications: [], localizationRunning: false,
  localizationStatus: null, system: null, uploading: { dom: false, dsm: false },
  focusedMap: null, pendingRegion: null
};

const trajectoryNodes = { dom: new Map(), dsm: new Map() };
const trajectoryProjection = {
  dom: { fingerprint: null, pixels: new Map(), pending: new Set(), timer: 0, controller: null, requestId: 0 },
  dsm: { fingerprint: null, pixels: new Map(), pending: new Set(), timer: 0, controller: null, requestId: 0 }
};
const tileRefreshTimers = { dom: 0, dsm: 0 };
const wheelZoomState = {
  dom: { frame: 0, delta: 0, anchor: null },
  dsm: { frame: 0, delta: 0, anchor: null }
};
let trajectoryRaf = 0;
let telemetrySequence = 0;
let domPointerTimer = 0;
let domPointerController = null;
let domPointerRequestId = 0;
let dsmPointerTimer = 0;
let dsmPointerController = null;
let dsmPointerRequestId = 0;
let telemetryElevationTimer = 0;
let telemetryElevationController = null;
let telemetryElevationRequestId = 0;

function on(element, eventName, handler, options) {
  element?.addEventListener(eventName, handler, options);
}

function scheduleTrajectoryUpdate() {
  if (trajectoryRaf) return;
  trajectoryRaf = requestAnimationFrame(() => {
    trajectoryRaf = 0;
    updateTrajectoryElements("dom");
    updateTrajectoryElements("dsm");
  });
}

init();

async function init() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.scrollTo(0, 0);
  restoreUiPreferences();
  ensureDsmVectorLayer();
  bindEvents();
  connectEvents();
  await Promise.all([loadRegions(), loadSystemStatus()]);
  const restoredMaps = await restorePersistedMaps();
  if (!restoredMaps.dom) renderOnlineTiles();
  updateClock();
  window.setInterval(updateClock, 1000);
  requestAnimationFrame(() => {
    fitView("dom");
    fitView("dsm");
  });
  addLog("WebUI 已启动");
  bindRailNavigation();
}

function bindEvents() {
  on(elements.domFileButton, "click", () => elements.domFileInput?.click());
  on(elements.dsmFileButton, "click", () => elements.dsmFileInput?.click());
  on(elements.domFileInput, "change", (event) => handleTiffSelection("dom", event));
  on(elements.dsmFileInput, "change", (event) => handleTiffSelection("dsm", event));
  on(elements.onlineButton, "click", renderOnlineTiles);
  on(elements.domLocateButton, "click", () => centerOnLatestPosition("dom"));
  on(elements.dsmLocateButton, "click", () => centerOnLatestPosition("dsm"));
  on(elements.fitButton, "click", () => fitView("dom"));
  on(elements.dsmFitButton, "click", () => fitView("dsm"));
  on(elements.domZoomOutButton, "click", () => zoomBy("dom", 0.8));
  on(elements.domNativeButton, "click", () => setNativeScale("dom"));
  on(elements.domZoomInButton, "click", () => zoomBy("dom", 1.25));
  on(elements.dsmZoomOutButton, "click", () => zoomBy("dsm", 0.8));
  on(elements.dsmNativeButton, "click", () => setNativeScale("dsm"));
  on(elements.dsmZoomInButton, "click", () => zoomBy("dsm", 1.25));
  on(elements.domExpandButton, "click", () => toggleMapFocus("dom"));
  on(elements.dsmExpandButton, "click", () => toggleMapFocus("dsm"));
  on(elements.rectButton, "click", () => toggleDrawMode("dom", "rectangle"));
  on(elements.polygonButton, "click", () => toggleDrawMode("dom", "polygon"));
  on(elements.dsmRectButton, "click", () => toggleDrawMode("dsm", "rectangle"));

  on(elements.mapViewport, "mousedown", onPointerDown);
  on(elements.mapViewport, "mousemove", onPointerMove);
  on(elements.mapViewport, "dblclick", onDoubleClick);
  on(elements.mapViewport, "wheel", onWheel, { passive: false });
  on(elements.mapViewport, "contextmenu", onContextMenu);
  on(elements.dsmViewport, "mousedown", onDsmPointerDown);
  on(elements.dsmViewport, "mousemove", onDsmPointerMove);
  on(elements.dsmViewport, "wheel", onDsmWheel, { passive: false });
  on(window, "mouseup", onPointerUp);
  on(window, "resize", () => {
    if (state.focusedMap) fitView(state.focusedMap);
    else {
      fitView("dom");
      fitView("dsm");
    }
  });
  on(window, "scroll", () => {
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  }, { passive: true });
  on(window, "keydown", (event) => {
    if (event.key === "Escape" && state.focusedMap) toggleMapFocus(state.focusedMap);
  });

  on(elements.regionSelect, "change", () => {
    state.selectedRegionId = elements.regionSelect.value;
    saveUiPreferences();
    elements.deleteRegionButton.disabled = !state.selectedRegionId;
    renderSavedRegions();
    updateRegionReadout();
  });
  on(elements.flagSelect, "change", () => {
    saveUiPreferences();
    updateRegionReadout();
    addLog(`切换标识位: ${elements.flagSelect.value}`);
  });
  on(elements.topicInput, "input", () => {
    saveUiPreferences();
    updateRegionReadout();
  });
  on(elements.graphEndpoint, "input", saveUiPreferences);
  on(elements.agentType, "change", saveUiPreferences);
  on(elements.deleteRegionButton, "click", deleteSelectedRegion);
  on(elements.publishButton, "click", startPublishing);
  on(elements.stopButton, "click", () => stopPublishing());
  on(elements.startLocButton, "click", toggleLocalization);
  on(elements.runAgentButton, "click", runAgent);
  on(elements.confirmRegionButton, "click", validatePendingRegionName);
  on(elements.regionConfirmDialog, "close", handleRegionDialogClose);
  on(elements.regionConfirmDialog, "cancel", () => {
    state.pendingRegion = null;
  });
}

function restoreUiPreferences() {
  try {
    const preferences = JSON.parse(localStorage.getItem(UI_PREFERENCES_KEY) || "{}");
    if (preferences.flag && elements.flagSelect) elements.flagSelect.value = preferences.flag;
    if (typeof preferences.topic === "string" && elements.topicInput) elements.topicInput.value = preferences.topic;
    if (typeof preferences.graphEndpoint === "string" && elements.graphEndpoint) {
      elements.graphEndpoint.value = preferences.graphEndpoint;
    }
    if (preferences.agentType && elements.agentType) elements.agentType.value = preferences.agentType;
    if (typeof preferences.selectedRegionId === "string") state.selectedRegionId = preferences.selectedRegionId;
  } catch {
    localStorage.removeItem(UI_PREFERENCES_KEY);
  }
}

function saveUiPreferences() {
  try {
    localStorage.setItem(UI_PREFERENCES_KEY, JSON.stringify({
      flag: elements.flagSelect?.value || "GPS_FLAG",
      topic: elements.topicInput?.value || "/selected_region",
      graphEndpoint: elements.graphEndpoint?.value || "",
      agentType: elements.agentType?.value || "agent",
      selectedRegionId: elements.regionSelect?.value || state.selectedRegionId || ""
    }));
  } catch {
    // Local storage can be unavailable in hardened browser profiles.
  }
}

async function restorePersistedMaps() {
  const restored = { dom: false, dsm: false };
  try {
    const response = await fetch("/api/maps/status", { headers: { accept: "application/json" } });
    const maps = await readApiResponse(response);
    for (const kind of ["dom", "dsm"]) {
      const metadata = maps[kind];
      if (!metadata?.loaded) continue;
      renderGeoTiff(kind, metadata);
      const filename = metadata.filename || `${kind}.tif`;
      const metaElement = kind === "dsm" ? elements.dsmMapMeta : elements.domMapMeta;
      if (metaElement) {
        metaElement.textContent = `${filename} · ${metadata.width}×${metadata.height}`;
        metaElement.title = filename;
      }
      restored[kind] = true;
      addLog(`${labelForMap(kind)} 已从持久化存储恢复: ${filename}`);
    }
  } catch (error) {
    addLog(`地图恢复失败: ${error.message}`);
  }
  return restored;
}

function toggleDrawMode(kind, mode) {
  const isSameMode = state.drawKind === kind && state.drawMode === mode;
  const nextMode = isSameMode ? null : mode;
  if (nextMode && !mapParts(kind).source.loaded) {
    setUploadStatus(kind, `请先加载 ${labelForMap(kind)} 地图`, true);
    return;
  }
  cancelDraft();
  state.drawKind = nextMode ? kind : null;
  state.drawMode = nextMode;
  elements.rectButton.classList.toggle("active", kind === "dom" && nextMode === "rectangle");
  elements.polygonButton.classList.toggle("active", kind === "dom" && nextMode === "polygon");
  elements.dsmRectButton?.classList.toggle("active", kind === "dsm" && nextMode === "rectangle");
  elements.mapViewport.classList.toggle("selecting", kind === "dom" && Boolean(nextMode));
  elements.dsmViewport.classList.toggle("selecting", kind === "dsm" && Boolean(nextMode));
  elements.drawHint.hidden = !(kind === "dom" && nextMode === "polygon");
  elements.dsmDrawHint.hidden = !(kind === "dsm" && nextMode === "rectangle");
  if (nextMode === "rectangle") addLog(`${labelForMap(kind)} 矩形模式：按住左键拖动，松开后确认`);
  if (nextMode === "polygon") addLog("DOM 多边形模式：左键添加顶点，双击闭合");
}

function cancelDraft() {
  state.drag = null;
  state.dsmDrag = null;
  elements.mapViewport?.classList.remove("dragging");
  elements.dsmViewport?.classList.remove("dragging");
  state.polygonPoints = [];
  state.polygonCursor = null;
  state.selectionEl?.remove();
  state.selectionEl = null;
  renderVectorLayer("dom");
  renderVectorLayer("dsm");
}

function renderOnlineTiles() {
  const tiles = [];
  const { z, centerX, centerY, radiusX, radiusY } = ONLINE_TILE_SOURCE;
  for (let y = centerY - radiusY; y <= centerY + radiusY; y += 1) {
    for (let x = centerX - radiusX; x <= centerX + radiusX; x += 1) {
      tiles.push({ z, x, y, url: ONLINE_TILE_SOURCE.url(z, x, y) });
    }
  }

  renderTiles({
    z,
    tiles,
    minX: centerX - radiusX,
    maxX: centerX + radiusX,
    minY: centerY - radiusY,
    maxY: centerY + radiusY,
    provider: ONLINE_TILE_SOURCE.label
  });
  setMapReady("在线影像加载中");
  addLog(`加载在线瓦片: ${ONLINE_TILE_SOURCE.label}`);
}

function isTiffFile(file) {
  return /\.(?:tif|tiff|geotiff)$/i.test(file?.name || "");
}

function fileDisplayName(file) {
  return file.webkitRelativePath || file.name;
}

async function handleTiffSelection(kind, event) {
  const input = event.currentTarget;
  const files = Array.from(input?.files || []).filter(isTiffFile);
  input.value = "";
  const label = labelForMap(kind);

  if (!files.length) {
    setUploadStatus(kind, "未选择 TIFF", true);
    addLog(`${label}: 未选择 TIFF`);
    return;
  }

  const selected = files[0];
  setUploadStatus(kind, `已选择 ${fileDisplayName(selected)}`);
  await uploadGeoTiff(kind, selected);
}

async function uploadGeoTiff(kind, file) {
  if (state.uploading[kind]) return;
  const label = labelForMap(kind);
  const displayName = fileDisplayName(file);
  state.uploading[kind] = true;
  setUploadControlsDisabled(kind, true);
  setUploadStatus(kind, `上传中 · ${displayName} · ${formatBytes(file.size)}`);
  addLog(`${label} 上传开始: ${displayName} (${formatBytes(file.size)})`);

  try {
    const url = `/api/map/${kind}/upload?filename=${encodeURIComponent(file.name)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", accept: "application/json" },
      body: file
    });
    const data = await readApiResponse(response);
    const meta = data.map || data.metadata || data;
    if (!meta?.loaded) throw new Error("上传成功，但返回的地图元数据无效");
    renderGeoTiff(kind, meta);
    fitView(kind);
    const metaElement = kind === "dsm" ? elements.dsmMapMeta : elements.domMapMeta;
    if (metaElement) {
      metaElement.textContent = `${displayName} · ${meta.width}×${meta.height}`;
      metaElement.title = displayName;
    }
    setUploadStatus(kind, `已加载 ${displayName} · ${meta.width}×${meta.height}`);
    addLog(`${label} 已加载: ${displayName}, ${meta.width}×${meta.height}px, CRS: ${meta.crs || "UNKNOWN"}`);
  } catch (error) {
    setUploadStatus(kind, `上传失败 · ${error.message}`, true);
    addLog(`${label} 上传失败: ${error.message}`);
  } finally {
    state.uploading[kind] = false;
    setUploadControlsDisabled(kind, false);
  }
}

function setUploadControlsDisabled(kind, disabled) {
  const button = kind === "dsm" ? elements.dsmFileButton : elements.domFileButton;
  if (button) button.disabled = disabled;
}

function setUploadStatus(kind, message, isError = false) {
  const output = kind === "dsm" ? elements.dsmCursorReadout : elements.cursorReadout;
  if (!output) return;
  output.textContent = message;
  output.classList.toggle("error", isError);
}

async function readApiResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  let data = {};
  if (text) {
    if (contentType.includes("application/json")) {
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`服务器返回了无效 JSON (HTTP ${response.status})`);
      }
    } else {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) };
      }
    }
  }
  if (!response.ok || data.ok === false) {
    const fallback = `Request failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
    const error = new Error(data.error || data.detail || fallback);
    error.data = data;
    throw error;
  }
  return data;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function renderGeoTiff(kind, meta) {
  const isDsm = kind === "dsm";
  const content = isDsm ? elements.dsmContent : elements.mapContent;
  const width = Number(meta.width) || 1600;
  const height = Number(meta.height) || 1000;
  const fingerprint = String(meta.fingerprint || `geotiff-${kind}:${width}x${height}`);
  const source = {
    type: `geotiff-${kind}`,
    fingerprint,
    width,
    height,
    bounds: normalizeBounds(meta.bounds || DEFAULT_BOUNDS),
    z: null,
    minX: 0,
    minY: 0,
    loaded: true,
    metadata: meta,
    levels: normalizeOverviewLevels(meta, width, height),
    tileNodes: new Map(),
    activeTileKeys: new Set(),
    tileUseCounter: 0,
    maxCachedTileNodes: clamp(
      Math.floor((Number(meta.tileCacheItems) || DEFAULT_CACHED_TILE_NODES * 4) / 4),
      96,
      256
    ),
    currentLevel: null
  };
  if (isDsm) state.dsmSource = source;
  else state.source = source;

  content.innerHTML = "";
  content.dataset.sourceMode = "geotiff";
  content.style.width = `${width}px`;
  content.style.height = `${height}px`;
  const overview = document.createElement("img");
  overview.className = "map-image geotiff-overview";
  overview.alt = "";
  overview.loading = "eager";
  overview.decoding = "async";
  Object.assign(overview.style, {
    left: "0",
    top: "0",
    width: `${width}px`,
    height: `${height}px`
  });
  overview.src = `/api/map/${kind}/full.png?max_dim=2048&v=${encodeURIComponent(fingerprint)}`;
  content.append(overview);
  handleMapSourceChanged(kind);

  if (isDsm) {
    ensureDsmVectorLayer();
    renderSavedRegions();
    const elevation = meta.elevation || {};
    const min = toFiniteNumber(elevation.min);
    const max = toFiniteNumber(elevation.max);
    elements.dsmMapMeta.textContent = `${width}×${height} · ${meta.crs || "UNKNOWN"}`;
    elements.dsmRangeValue.textContent = min !== null && max !== null
      ? `${min.toFixed(1)}–${max.toFixed(1)} ${elevation.unit || "m"}` : "-- m";
    const telemetryLat = toFiniteNumber(state.latestTelemetry?.lat);
    const telemetryLon = toFiniteNumber(state.latestTelemetry?.lon);
    if (telemetryLat !== null && telemetryLon !== null) queryTelemetryElevation(telemetryLat, telemetryLon);
  } else {
    ensureVectorLayer();
    renderSavedRegions();
    elements.domMapMeta.textContent = `${width}×${height} · ${meta.crs || "UNKNOWN"}`;
    setMapReady(`DOM 已加载 · ${width}×${height} 原始分辨率`);
  }
  scheduleTileRefresh(kind, 0);
  scheduleTrajectoryUpdate();
}

function normalizeOverviewLevels(meta, sourceWidth, sourceHeight) {
  const input = Array.isArray(meta.levels) && meta.levels.length
    ? meta.levels
    : [{ level: 0, factor: 1, width: sourceWidth, height: sourceHeight, tileCols: meta.tileCols, tileRows: meta.tileRows }];
  return input.map((item, index) => {
    const factor = Math.max(1, Number(item.factor) || 1);
    const width = Math.max(1, Number(item.width) || Math.ceil(sourceWidth / factor));
    const height = Math.max(1, Number(item.height) || Math.ceil(sourceHeight / factor));
    return {
      level: item.level ?? index,
      factor,
      width,
      height,
      tileCols: Math.max(1, Number(item.tileCols) || Math.ceil(width / TILE_SIZE)),
      tileRows: Math.max(1, Number(item.tileRows) || Math.ceil(height / TILE_SIZE))
    };
  }).sort((a, b) => a.factor - b.factor);
}

function isGeoTiffSource(source) {
  return Boolean(source?.loaded && String(source.type).startsWith("geotiff-"));
}

function scheduleTileRefresh(kind, delay = TILE_REFRESH_DELAY_MS) {
  const source = mapParts(kind).source;
  if (!isGeoTiffSource(source)) return;
  window.clearTimeout(tileRefreshTimers[kind]);
  tileRefreshTimers[kind] = window.setTimeout(() => {
    tileRefreshTimers[kind] = 0;
    refreshGeoTiffTiles(kind);
  }, Math.max(0, delay));
}

function visibleTileRange(kind, level) {
  const { source, view, viewport } = mapParts(kind);
  const rect = viewport?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return null;
  const span = TILE_SIZE * level.factor;
  const rawLeft = -view.x / view.scale;
  const rawTop = -view.y / view.scale;
  const rawRight = (rect.width - view.x) / view.scale;
  const rawBottom = (rect.height - view.y) / view.scale;
  if (rawRight <= 0 || rawBottom <= 0 || rawLeft >= source.width || rawTop >= source.height) return null;
  const left = clamp(rawLeft, 0, source.width);
  const top = clamp(rawTop, 0, source.height);
  const right = clamp(rawRight, 0, source.width);
  const bottom = clamp(rawBottom, 0, source.height);
  return {
    firstCol: clamp(Math.floor(left / span) - 1, 0, level.tileCols - 1),
    lastCol: clamp(Math.floor(Math.max(left, right - 0.0001) / span) + 1, 0, level.tileCols - 1),
    firstRow: clamp(Math.floor(top / span) - 1, 0, level.tileRows - 1),
    lastRow: clamp(Math.floor(Math.max(top, bottom - 0.0001) / span) + 1, 0, level.tileRows - 1),
    centerCol: clamp(Math.floor(((left + right) / 2) / span), 0, level.tileCols - 1),
    centerRow: clamp(Math.floor(((top + bottom) / 2) / span), 0, level.tileRows - 1)
  };
}

function visibleTileCount(kind, level) {
  const range = visibleTileRange(kind, level);
  return range ? (range.lastCol - range.firstCol + 1) * (range.lastRow - range.firstRow + 1) : 0;
}

function visibleTilesForLevel(kind, level) {
  const range = visibleTileRange(kind, level);
  if (!range) return [];
  const total = (range.lastCol - range.firstCol + 1) * (range.lastRow - range.firstRow + 1);
  const tiles = [];
  const seen = new Set();
  const addTile = (col, row) => {
    const key = `${col}:${row}`;
    if (seen.has(key) || tiles.length >= MAX_VISIBLE_TILES) return;
    seen.add(key);
    tiles.push({ col, row });
  };
  if (total <= MAX_VISIBLE_TILES) {
    for (let row = range.firstRow; row <= range.lastRow; row += 1) {
      for (let col = range.firstCol; col <= range.lastCol; col += 1) addTile(col, row);
    }
    return tiles;
  }

  const maxRadius = Math.max(
    range.centerCol - range.firstCol,
    range.lastCol - range.centerCol,
    range.centerRow - range.firstRow,
    range.lastRow - range.centerRow
  );
  for (let radius = 0; radius <= maxRadius && tiles.length < MAX_VISIBLE_TILES; radius += 1) {
    const firstRow = Math.max(range.firstRow, range.centerRow - radius);
    const lastRow = Math.min(range.lastRow, range.centerRow + radius);
    const firstCol = Math.max(range.firstCol, range.centerCol - radius);
    const lastCol = Math.min(range.lastCol, range.centerCol + radius);
    for (let row = firstRow; row <= lastRow && tiles.length < MAX_VISIBLE_TILES; row += 1) {
      for (let col = firstCol; col <= lastCol && tiles.length < MAX_VISIBLE_TILES; col += 1) {
        if (radius === 0 || row === firstRow || row === lastRow || col === firstCol || col === lastCol) {
          addTile(col, row);
        }
      }
    }
  }
  return tiles;
}

function chooseOverviewLevel(kind) {
  const { source, view } = mapParts(kind);
  const levels = source.levels || [];
  if (!levels.length) return null;
  const current = levels.find((level) => level.level === source.currentLevel);
  if (current && visibleTileCount(kind, current) <= MAX_VISIBLE_TILES) {
    const renderedPixelSize = current.factor * view.scale;
    // Wider hysteresis band to prevent rapid level switching during continuous zoom
    if (renderedPixelSize >= 0.4 && renderedPixelSize <= 2.5) return current;
  }
  let index = levels.reduce((best, level, candidate) => {
    const distance = Math.abs(Math.log(Math.max(level.factor * view.scale, 0.000001)));
    const bestDistance = Math.abs(Math.log(Math.max(levels[best].factor * view.scale, 0.000001)));
    return distance < bestDistance ? candidate : best;
  }, 0);
  while (index < levels.length - 1 && visibleTileCount(kind, levels[index]) > MAX_VISIBLE_TILES) index += 1;
  return levels[index];
}

function refreshGeoTiffTiles(kind) {
  const { source, content } = mapParts(kind);
  if (!isGeoTiffSource(source) || !content) return;
  const level = chooseOverviewLevel(kind);
  if (!level) return;
  const batchId = (source.tileBatchId || 0) + 1;
  source.tileBatchId = batchId;
  const wantedTiles = visibleTilesForLevel(kind, level);
  const wantedKeys = new Set(wantedTiles.map(({ col, row }) => `${level.level}:${col}:${row}`));
  cancelStalePendingTiles(source, wantedKeys);

  // Collect old-level tiles that are already visible so we can keep them as a
  // backdrop while new tiles load, preventing black flicker on level switch.
  const previousActiveKeys = source.activeTileKeys || new Set();
  const staleFallbackKeys = new Set();
  for (const key of previousActiveKeys) {
    if (wantedKeys.has(key)) continue;
    const node = source.tileNodes.get(key);
    if (node && node.classList.contains("tile-ready")) {
      staleFallbackKeys.add(key);
    }
  }

  const overlay = content.querySelector(".vector-layer, .saved-region, .selection-box");
  let pending = 0;
  let failed = false;
  const finishBatch = () => {
    if (pending || failed || source.tileBatchId !== batchId) return;
    for (const [key, node] of source.tileNodes) {
      const active = wantedKeys.has(key);
      node.hidden = !active;
      node.dataset.active = active ? "true" : "false";
    }
    // Now that all wanted tiles are ready, remove stale fallback tiles
    for (const key of staleFallbackKeys) {
      const node = source.tileNodes.get(key);
      if (node) {
        node.hidden = true;
        node.dataset.active = "false";
      }
    }
    source.activeTileKeys = wantedKeys;
    source.currentLevel = level.level;
    content.dataset.rasterLevel = String(level.level);
    content.dataset.rasterFactor = String(level.factor);
    evictHiddenTileNodes(source, wantedKeys);
  };
  // While new tiles are pending, keep old-level tiles visible as fallback
  for (const key of staleFallbackKeys) {
    const node = source.tileNodes.get(key);
    if (node) {
      node.hidden = false;
      node.dataset.active = "true";
    }
  }
  for (const { col, row } of wantedTiles) {
    const key = `${level.level}:${col}:${row}`;
    const existing = source.tileNodes.get(key);
    if (existing) {
      touchTileNode(source, existing);
      if (!existing.classList.contains("tile-ready")) {
        pending += 1;
        let settled = false;
        const settleExisting = (success) => {
          if (settled) return;
          settled = true;
          pending -= 1;
          if (existing.dataset.cancelled === "true") {
            finishBatch();
            return;
          }
          if (success) {
            existing.classList.add("tile-ready");
            source.tileRetryCounts?.delete(key);
          } else {
            failed = true;
            source.tileNodes.delete(key);
            existing.remove();
            scheduleTileRetry(kind, source, key);
          }
          finishBatch();
        };
        existing.addEventListener("load", () => settleExisting(true), { once: true });
        existing.addEventListener("error", () => settleExisting(false), { once: true });
        if (existing.complete) queueMicrotask(() => settleExisting(existing.naturalWidth > 0));
      }
      continue;
    }
    const left = col * TILE_SIZE * level.factor;
    const top = row * TILE_SIZE * level.factor;
    const width = Math.min(TILE_SIZE, level.width - col * TILE_SIZE) * level.factor;
    const height = Math.min(TILE_SIZE, level.height - row * TILE_SIZE) * level.factor;
    if (width <= 0 || height <= 0 || left >= source.width || top >= source.height) continue;
    const img = document.createElement("img");
    img.className = "tile-img geotiff-tile";
    img.hidden = true;
    img.loading = "eager";
    img.decoding = "async";
    img.alt = "";
    Object.assign(img.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.min(width, source.width - left)}px`,
      height: `${Math.min(height, source.height - top)}px`
    });
    pending += 1;
    let settled = false;
    const settle = (success) => {
      if (settled) return;
      settled = true;
      pending -= 1;
      if (img.dataset.cancelled === "true") {
        finishBatch();
        return;
      }
      if (success) {
        img.classList.add("tile-ready");
        source.tileRetryCounts?.delete(key);
      } else {
        failed = true;
        img.classList.add("tile-error");
        source.tileNodes.delete(key);
        img.remove();
        scheduleTileRetry(kind, source, key);
      }
      finishBatch();
    };
    img.addEventListener("load", () => settle(true), { once: true });
    img.addEventListener("error", () => settle(false), { once: true });
    content.insertBefore(img, overlay);
    source.tileNodes.set(key, img);
    touchTileNode(source, img);
    img.src = `/api/map/${kind}/tile/${encodeURIComponent(level.level)}/${col}/${row}.png?v=${encodeURIComponent(source.fingerprint)}`;
    if (img.complete) queueMicrotask(() => settle(img.naturalWidth > 0));
  }
  finishBatch();
}

function cancelStalePendingTiles(source, wantedKeys) {
  for (const [key, node] of source.tileNodes) {
    if (wantedKeys.has(key) || node.classList.contains("tile-ready")) continue;
    node.dataset.cancelled = "true";
    node.removeAttribute("src");
    node.remove();
    source.tileNodes.delete(key);
    source.tileRetryCounts?.delete(key);
  }
}

function touchTileNode(source, node) {
  source.tileUseCounter = (source.tileUseCounter || 0) + 1;
  node.dataset.lastUsed = String(source.tileUseCounter);
}

function evictHiddenTileNodes(source, protectedKeys) {
  const cacheLimit = source.maxCachedTileNodes || DEFAULT_CACHED_TILE_NODES;
  if (source.tileNodes.size <= cacheLimit) return;
  const candidates = [...source.tileNodes.entries()]
    .filter(([key, node]) => !protectedKeys.has(key) && node.hidden)
    .sort((left, right) => Number(left[1].dataset.lastUsed || 0) - Number(right[1].dataset.lastUsed || 0));
  for (const [key, node] of candidates) {
    if (source.tileNodes.size <= cacheLimit) break;
    node.remove();
    source.tileNodes.delete(key);
    source.tileRetryCounts?.delete(key);
  }
}

function scheduleTileRetry(kind, source, key) {
  if (!source.tileRetryCounts) source.tileRetryCounts = new Map();
  const attempts = (source.tileRetryCounts.get(key) || 0) + 1;
  source.tileRetryCounts.set(key, attempts);
  if (attempts <= 2) scheduleTileRefresh(kind, 250 * attempts);
}

function labelForMap(kind) {
  return kind === "dsm" ? "DSM" : "DOM";
}

function normalizeBounds(input) {
  const source = input.bounds || input;
  if (Array.isArray(source) && source.length >= 4) {
    return { west: Number(source[0]), south: Number(source[1]), east: Number(source[2]), north: Number(source[3]) };
  }
  if (source.topLeft && source.bottomRight) {
    return {
      north: Number(source.topLeft.lat),
      west: Number(source.topLeft.lon ?? source.topLeft.lng),
      south: Number(source.bottomRight.lat),
      east: Number(source.bottomRight.lon ?? source.bottomRight.lng)
    };
  }
  return {
    north: Number(source.north ?? source.maxLat),
    west: Number(source.west ?? source.minLon ?? source.left),
    south: Number(source.south ?? source.minLat),
    east: Number(source.east ?? source.maxLon ?? source.right)
  };
}

function renderTiles(tileSet) {
  const width = (tileSet.maxX - tileSet.minX + 1) * TILE_SIZE;
  const height = (tileSet.maxY - tileSet.minY + 1) * TILE_SIZE;
  state.source = {
    type: "tiles",
    fingerprint: tileSet.fingerprint || ONLINE_TILE_SOURCE.fingerprint,
    width,
    height,
    z: tileSet.z,
    minX: tileSet.minX,
    minY: tileSet.minY,
    provider: tileSet.provider || "local",
    bounds: null,
    loaded: true
  };
  handleMapSourceChanged("dom");
  if (elements.domMapMeta) {
    elements.domMapMeta.textContent = tileSet.provider
      ? `${tileSet.provider} · z${tileSet.z}`
      : `LOCAL TILES · z${tileSet.z}`;
  }

  elements.mapContent.innerHTML = "";
  elements.mapContent.dataset.sourceMode = "online";
  elements.mapContent.style.width = `${width}px`;
  elements.mapContent.style.height = `${height}px`;
  let loaded = 0;
  let failed = 0;
  const updateTileStatus = () => {
    const total = tileSet.tiles.length;
    const label = tileSet.provider ? `${tileSet.provider}: ${loaded}/${total}` : `瓦片: ${loaded}/${total}`;
    setMapReady(failed ? `${label}, failed ${failed}` : label);
  };
  for (const tile of tileSet.tiles) {
    const img = document.createElement("img");
    img.className = "tile-img";
    img.loading = "lazy";
    img.decoding = "async";
    img.src = tile.url;
    img.alt = "";
    img.style.left = `${(tile.x - tileSet.minX) * TILE_SIZE}px`;
    img.style.top = `${(tile.y - tileSet.minY) * TILE_SIZE}px`;
    img.addEventListener("load", () => {
      loaded += 1;
      updateTileStatus();
    });
    img.addEventListener("error", () => {
      failed += 1;
      img.classList.add("tile-error");
      updateTileStatus();
    });
    elements.mapContent.append(img);
  }
  ensureVectorLayer();
  renderSavedRegions();
  fitView();
}

function ensureVectorLayer() {
  return ensureMapVectorLayer("dom");
}

function ensureDsmVectorLayer() {
  return ensureMapVectorLayer("dsm");
}

function ensureMapVectorLayer(kind) {
  const isDsm = kind === "dsm";
  const content = isDsm ? elements.dsmContent : elements.mapContent;
  const source = isDsm ? state.dsmSource : state.source;
  if (!content) return null;
  const id = isDsm ? "dsmVectorLayer" : "vectorLayer";
  let layer = content.querySelector(`#${id}`);
  if (!layer) {
    layer = document.createElementNS(SVG_NS, "svg");
    layer.id = id;
    layer.classList.add("vector-layer");
    content.append(layer);
  }
  layer.setAttribute("viewBox", `0 0 ${source.width} ${source.height}`);
  if (isDsm) elements.dsmVectorLayer = layer;
  else elements.vectorLayer = layer;
  renderTrajectoryOnMap(kind, layer);
  return layer;
}

function setMapReady(label) {
  elements.mapState?.classList.remove("muted");
  if (elements.cursorReadout) {
    elements.cursorReadout.textContent = label;
    elements.cursorReadout.classList.remove("error");
  }
}

function mapParts(kind) {
  const isDsm = kind === "dsm";
  return {
    source: isDsm ? state.dsmSource : state.source,
    view: isDsm ? state.dsmView : state.view,
    viewport: isDsm ? elements.dsmViewport : elements.mapViewport,
    content: isDsm ? elements.dsmContent : elements.mapContent
  };
}

function getFitScale(kind) {
  const { source, viewport } = mapParts(kind);
  const rect = viewport?.getBoundingClientRect();
  if (!rect?.width || !rect.height || !source.width || !source.height) return 1;
  return clamp(Math.min(rect.width / source.width, rect.height / source.height) * 0.94, MIN_MAP_SCALE, MAX_MAP_SCALE);
}

function fitView(kind = "dom") {
  const { source, view, viewport } = mapParts(kind);
  const rect = viewport?.getBoundingClientRect();
  if (!rect?.width || !rect.height || !source.width || !source.height) return;
  view.scale = getFitScale(kind);
  view.x = (rect.width - source.width * view.scale) / 2;
  view.y = (rect.height - source.height * view.scale) / 2;
  applyTransform(kind);
}

function applyTransform(kind = "dom") {
  const { content, view } = mapParts(kind);
  if (!content) return;
  constrainViewToViewport(kind);
  content.style.setProperty("--map-inverse-scale", String(1 / Math.max(view.scale, MIN_MAP_SCALE)));
  content.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  content.classList.toggle("native-resolution", view.scale >= 0.999);
  updateZoomIndicator(kind);
  scheduleTileRefresh(kind);
  scheduleTrajectoryUpdate();
}

function constrainViewToViewport(kind) {
  const { source, viewport, view } = mapParts(kind);
  const rect = viewport?.getBoundingClientRect();
  if (!rect?.width || !rect.height || !source.width || !source.height) return;
  const renderedWidth = source.width * view.scale;
  const renderedHeight = source.height * view.scale;
  view.x = renderedWidth <= rect.width
    ? (rect.width - renderedWidth) / 2
    : clamp(view.x, rect.width - renderedWidth, 0);
  view.y = renderedHeight <= rect.height
    ? (rect.height - renderedHeight) / 2
    : clamp(view.y, rect.height - renderedHeight, 0);
}

function updateZoomIndicator(kind) {
  const value = kind === "dsm" ? elements.dsmZoomValue : elements.domZoomValue;
  const button = kind === "dsm" ? elements.dsmNativeButton : elements.domNativeButton;
  const scale = mapParts(kind).view.scale;
  if (value) value.textContent = scale >= 0.1 ? `${Math.round(scale * 100)}%` : `${(scale * 100).toFixed(1)}%`;
  button?.classList.toggle("active", Math.abs(scale - 1) < 0.001);
}

function setScaleAtPoint(kind, nextScale, anchor = null) {
  const { viewport, view } = mapParts(kind);
  const rect = viewport?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return;
  const point = anchor || { x: rect.width / 2, y: rect.height / 2 };
  const contentPoint = {
    x: (point.x - view.x) / view.scale,
    y: (point.y - view.y) / view.scale
  };
  view.scale = clamp(nextScale, getFitScale(kind), MAX_MAP_SCALE);
  view.x = point.x - contentPoint.x * view.scale;
  view.y = point.y - contentPoint.y * view.scale;
  applyTransform(kind);
}

function zoomBy(kind, factor) {
  const { view } = mapParts(kind);
  setScaleAtPoint(kind, view.scale * factor);
}

function setNativeScale(kind) {
  setScaleAtPoint(kind, 1);
  addLog(`${labelForMap(kind)} 切换到 1:1 原始分辨率`);
}

async function centerOnLatestPosition(kind) {
  const lat = toFiniteNumber(state.latestTelemetry?.lat);
  const lon = toFiniteNumber(state.latestTelemetry?.lon);
  const { source, view, viewport } = mapParts(kind);
  const label = labelForMap(kind);
  if (lat === null || lon === null) {
    setUploadStatus(kind, "暂无有效定位数据", true);
    addLog(`${label} 回正失败: 暂无有效定位数据`);
    return;
  }
  if (!source.loaded) {
    setUploadStatus(kind, `${label} 地图尚未加载`, true);
    return;
  }

  try {
    const [point] = isGeoTiffSource(source)
      ? await requestCoordinateBatch(kind, "wgs84_to_pixel", [{ lat, lon }], source.fingerprint)
      : [latLonToContentForSource(source, lat, lon)];
    const x = toFiniteNumber(point?.x);
    const y = toFiniteNumber(point?.y);
    if (x === null || y === null) throw new Error("定位坐标转换失败");
    if (x < 0 || y < 0 || x > source.width || y > source.height) {
      throw new Error("当前位置不在地图范围内");
    }
    const rect = viewport?.getBoundingClientRect();
    if (!rect?.width || !rect.height) throw new Error("地图视口不可用");
    view.x = rect.width / 2 - x * view.scale;
    view.y = rect.height / 2 - y * view.scale;
    applyTransform(kind);
    setUploadStatus(kind, `当前位置 · ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    addLog(`${label} 已回到当前位置`);
  } catch (error) {
    setUploadStatus(kind, `回正失败 · ${error.message}`, true);
    addLog(`${label} 回正失败: ${error.message}`);
  }
}

function mapContentCenter(kind) {
  const { viewport, view } = mapParts(kind);
  const rect = viewport?.getBoundingClientRect();
  if (!rect?.width || !rect.height) return null;
  return {
    x: (rect.width / 2 - view.x) / view.scale,
    y: (rect.height / 2 - view.y) / view.scale
  };
}

function toggleMapFocus(kind) {
  if (!elements.mapWorkspace) return;
  const centers = { dom: mapContentCenter("dom"), dsm: mapContentCenter("dsm") };
  state.focusedMap = state.focusedMap === kind ? null : kind;
  elements.mapWorkspace.classList.toggle("focus-dom", state.focusedMap === "dom");
  elements.mapWorkspace.classList.toggle("focus-dsm", state.focusedMap === "dsm");
  for (const [mapKind, button] of [["dom", elements.domExpandButton], ["dsm", elements.dsmExpandButton]]) {
    const active = state.focusedMap === mapKind;
    button?.classList.toggle("active", active);
    button?.setAttribute("aria-pressed", String(active));
    const label = button?.querySelector("b");
    if (label) label.textContent = active ? "双图" : "单图";
  }
  requestAnimationFrame(() => {
    for (const mapKind of ["dom", "dsm"]) {
      const center = centers[mapKind];
      const { viewport, view } = mapParts(mapKind);
      const rect = viewport?.getBoundingClientRect();
      if (!center || !rect?.width || !rect.height) continue;
      view.x = rect.width / 2 - center.x * view.scale;
      view.y = rect.height / 2 - center.y * view.scale;
      applyTransform(mapKind);
    }
  });
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const point = clampContentPoint(toContentPoint(event));
  if (state.drawKind === "dom" && state.drawMode === "polygon") {
    event.preventDefault();
    if (event.detail === 1) {
      state.polygonPoints.push(point);
      state.polygonCursor = point;
      renderVectorLayer("dom");
    }
    return;
  }

  elements.mapViewport?.classList.add("dragging");
  if (state.drawKind === "dom" && state.drawMode === "rectangle") {
    state.drag = { type: "select", start: point, current: point };
    state.selectionEl?.remove();
    state.selectionEl = document.createElement("div");
    state.selectionEl.className = "selection-box";
    state.selectionEl.dataset.name = "NEW REGION";
    applyRegionCssVariables(state.selectionEl, nextRegionVisual());
    elements.mapContent?.append(state.selectionEl);
    updateSelectionEl("dom");
  } else {
    state.drag = { type: "pan", startClient: { x: event.clientX, y: event.clientY }, startView: { ...state.view } };
  }
}

function onPointerMove(event) {
  const point = clampContentPoint(toContentPoint(event));
  queryDomPointerCoordinates(point);
  if (state.drawKind === "dom" && state.drawMode === "polygon" && state.polygonPoints.length) {
    state.polygonCursor = point;
    renderVectorLayer("dom");
  }
  if (!state.drag) return;
  if (state.drag.type === "select") {
    state.drag.current = point;
    updateSelectionEl("dom");
  } else {
    state.view.x = state.drag.startView.x + event.clientX - state.drag.startClient.x;
    state.view.y = state.drag.startView.y + event.clientY - state.drag.startClient.y;
    applyTransform("dom");
  }
}

function onDsmPointerDown(event) {
  if (event.button !== 0) return;
  const point = clampContentPointForSource(toContentPointForMap(event, "dsm"), state.dsmSource);
  elements.dsmViewport?.classList.add("dragging");
  if (state.drawKind === "dsm" && state.drawMode === "rectangle") {
    state.dsmDrag = { type: "select", start: point, current: point };
    state.selectionEl?.remove();
    state.selectionEl = document.createElement("div");
    state.selectionEl.className = "selection-box";
    state.selectionEl.dataset.name = "NEW REGION";
    applyRegionCssVariables(state.selectionEl, nextRegionVisual());
    elements.dsmContent?.append(state.selectionEl);
    updateSelectionEl("dsm");
  } else {
    state.dsmDrag = {
      type: "pan",
      startClient: { x: event.clientX, y: event.clientY },
      startView: { ...state.dsmView }
    };
  }
}

function onDsmPointerMove(event) {
  const point = clampContentPointForSource(toContentPointForMap(event, "dsm"), state.dsmSource);
  queryDsmPointerElevation(point.x, point.y);
  if (!state.dsmDrag) return;
  if (state.dsmDrag.type === "select") {
    state.dsmDrag.current = point;
    updateSelectionEl("dsm");
  } else {
    state.dsmView.x = state.dsmDrag.startView.x + event.clientX - state.dsmDrag.startClient.x;
    state.dsmView.y = state.dsmDrag.startView.y + event.clientY - state.dsmDrag.startClient.y;
    applyTransform("dsm");
  }
}

async function onPointerUp() {
  elements.mapViewport?.classList.remove("dragging");
  elements.dsmViewport?.classList.remove("dragging");
  if (state.dsmDrag) {
    const dsmDrag = state.dsmDrag;
    const box = dsmDrag.type === "select" ? getSelectionBox("dsm") : null;
    state.dsmDrag = null;
    if (dsmDrag.type === "select") {
      if (box && box.width >= 12 && box.height >= 12) await createRegionFromBox(box, "dsm");
      else clearSelectionElement();
    } else {
      scheduleTileRefresh("dsm", 0);
    }
  }
  if (!state.drag) return;
  if (state.drag.type === "select") {
    const box = getSelectionBox("dom");
    state.drag = null;
    if (box && box.width >= 12 && box.height >= 12) await createRegionFromBox(box, "dom");
    else clearSelectionElement();
    return;
  }
  state.drag = null;
  scheduleTileRefresh("dom", 0);
}

function onDoubleClick(event) {
  if (state.drawKind !== "dom" || state.drawMode !== "polygon") return;
  event.preventDefault();
  event.stopPropagation();
  finishPolygon();
}

function zoomMap(event, kind) {
  event.preventDefault();
  const { viewport, view } = mapParts(kind);
  const rect = viewport?.getBoundingClientRect();
  if (!rect) return;
  const wheel = wheelZoomState[kind];
  const deltaMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? rect.height : 1;
  wheel.delta += clamp(event.deltaY * deltaMultiplier, -120, 120);
  wheel.anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  if (wheel.frame) return;
  wheel.frame = requestAnimationFrame(() => {
    wheel.frame = 0;
    const delta = clamp(wheel.delta, -240, 240);
    const anchor = wheel.anchor;
    wheel.delta = 0;
    wheel.anchor = null;
    setScaleAtPoint(kind, view.scale * Math.exp(-delta * 0.0015), anchor);
  });
}

function onWheel(event) {
  zoomMap(event, "dom");
}

function onDsmWheel(event) {
  zoomMap(event, "dsm");
}

function onContextMenu(event) {
  event.preventDefault();
  if (state.drawKind === "dom" && state.drawMode === "polygon" && state.polygonPoints.length) {
    state.polygonPoints.pop();
    if (!state.polygonPoints.length) state.polygonCursor = null;
    renderVectorLayer("dom");
    addLog("已撤销最后一个多边形顶点");
  }
}

function updateSelectionEl(kind) {
  const box = getSelectionBox(kind);
  if (!box || !state.selectionEl) return;
  Object.assign(state.selectionEl.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`
  });
}

function getSelectionBox(kind) {
  const drag = kind === "dsm" ? state.dsmDrag : state.drag;
  const source = mapParts(kind).source;
  if (!drag?.start || !drag?.current) return null;
  const left = clamp(Math.min(drag.start.x, drag.current.x), 0, source.width);
  const top = clamp(Math.min(drag.start.y, drag.current.y), 0, source.height);
  const right = clamp(Math.max(drag.start.x, drag.current.x), 0, source.width);
  const bottom = clamp(Math.max(drag.start.y, drag.current.y), 0, source.height);
  return { left, top, width: right - left, height: bottom - top };
}

function clearSelectionElement() {
  state.selectionEl?.remove();
  state.selectionEl = null;
}

async function createRegionFromBox(box, kind) {
  const corners = [
    { x: box.left, y: box.top },
    { x: box.left + box.width, y: box.top },
    { x: box.left + box.width, y: box.top + box.height },
    { x: box.left, y: box.top + box.height }
  ];
  clearSelectionElement();
  try {
    const coordinates = await pixelsToGeographic(kind, corners);
    const region = buildRegionBase("rectangle", kind);
    region.pixelBox = {
      x: round(box.left, 2),
      y: round(box.top, 2),
      width: round(box.width, 2),
      height: round(box.height, 2)
    };
    region.bbox = geographicBounds(coordinates);
    await requestRegionConfirmation(region);
  } catch (error) {
    if (error.name !== "AbortError" && error.name !== "StaleMapError") {
      addLog(`区域坐标转换失败: ${error.message}`);
    }
  }
}

async function finishPolygon() {
  const points = dedupeAdjacentPoints(state.polygonPoints);
  if (points.length < 3) {
    addLog("多边形至少需要 3 个顶点");
    return;
  }
  state.polygonPoints = [];
  state.polygonCursor = null;
  renderVectorLayer("dom");
  try {
    const coordinates = await pixelsToGeographic("dom", points);
    const region = buildRegionBase("polygon", "dom");
    region.pixelPoints = points.map((point) => ({ x: round(point.x, 2), y: round(point.y, 2) }));
    region.polygon = coordinates.map(explicitGeographicCoordinate);
    region.bbox = geographicBounds(coordinates);
    await requestRegionConfirmation(region);
  } catch (error) {
    if (error.name !== "AbortError" && error.name !== "StaleMapError") {
      addLog(`多边形坐标转换失败: ${error.message}`);
    }
  }
}

function geographicBounds(coordinates) {
  const lats = coordinates.map((point) => Number(point.latitude ?? point.lat));
  const lons = coordinates.map((point) => Number(point.longitude ?? point.lon));
  return {
    topLeft: { latitude: round(Math.max(...lats), 7), longitude: round(Math.min(...lons), 7) },
    bottomRight: { latitude: round(Math.min(...lats), 7), longitude: round(Math.max(...lons), 7) }
  };
}

function explicitGeographicCoordinate(point) {
  return {
    latitude: round(Number(point.latitude ?? point.lat), 7),
    longitude: round(Number(point.longitude ?? point.lon), 7)
  };
}

function buildRegionBase(shape, kind) {
  const source = mapParts(kind).source;
  const visual = nextRegionVisual();
  return {
    id: `region-${Date.now()}`,
    name: `AREA-${String(state.regions.length + 1).padStart(3, "0")}`,
    shape,
    sourceKind: kind,
    sourceType: source.type,
    mapFingerprint: source.fingerprint,
    color: visual.stroke,
    createdAt: new Date().toISOString()
  };
}

function regionVisual(region, index = 0) {
  const explicit = String(region?.color || "").toLowerCase();
  return REGION_PALETTE.find((item) => item.stroke.toLowerCase() === explicit)
    || REGION_PALETTE[index % REGION_PALETTE.length];
}

function nextRegionVisual() {
  const used = new Set(
    state.regions.map((region, index) => regionVisual(region, index).stroke.toLowerCase())
  );
  return REGION_PALETTE.find((item) => !used.has(item.stroke.toLowerCase()))
    || REGION_PALETTE[state.regions.length % REGION_PALETTE.length];
}

function applyRegionCssVariables(node, visual) {
  node.style.setProperty("--region-stroke", visual.stroke);
  node.style.setProperty("--region-fill", visual.fill);
  node.style.setProperty("--region-selected-fill", visual.selectedFill);
}

async function requestRegionConfirmation(region) {
  state.pendingRegion = region;
  const sourceLabel = labelForMap(region.sourceKind || "dom");
  if (elements.pendingRegionSource) {
    elements.pendingRegionSource.textContent = `${sourceLabel} · ${String(region.shape || "rectangle").toUpperCase()}`;
  }
  if (elements.pendingRegionName) elements.pendingRegionName.value = region.name;
  if (elements.pendingRegionCoordinates) {
    elements.pendingRegionCoordinates.textContent = JSON.stringify(
      region.shape === "polygon" ? { polygon: region.polygon, bbox: region.bbox } : { bbox: region.bbox },
      null,
      2
    );
  }
  if (elements.regionConfirmDialog?.showModal) {
    elements.regionConfirmDialog.returnValue = "cancel";
    elements.regionConfirmDialog.showModal();
    requestAnimationFrame(() => elements.pendingRegionName?.select());
    return;
  }
  const confirmed = window.confirm(`确认创建区域 ${region.name}？`);
  state.pendingRegion = null;
  if (confirmed) await persistRegion(region);
}

function validatePendingRegionName(event) {
  const name = elements.pendingRegionName?.value.trim();
  if (name) return;
  event.preventDefault();
  elements.pendingRegionName?.focus();
  addLog("区域名称不能为空");
}

async function handleRegionDialogClose() {
  const region = state.pendingRegion;
  state.pendingRegion = null;
  if (!region || elements.regionConfirmDialog?.returnValue !== "confirm") return;
  region.name = elements.pendingRegionName?.value.trim() || region.name;
  await persistRegion(region);
}

async function persistRegion(region) {
  try {
    const data = await postJson("/api/regions", region);
    state.regions = Array.isArray(data.regions) ? data.regions : [...state.regions, region];
    state.selectedRegionId = region.id;
    renderRegionSelect();
    renderSavedRegions();
    updateRegionReadout();
    addLog(`已创建 ${labelForMap(region.sourceKind || "dom")} ${region.shape === "polygon" ? "多边形" : "矩形"}区域: ${region.name}`);
  } catch (error) {
    addLog(`区域保存失败: ${error.message}`);
  }
}

function regionMatchesSource(region, source) {
  return Boolean(
    region?.sourceType === source?.type
    && region.mapFingerprint
    && source.fingerprint
    && region.mapFingerprint === source.fingerprint
  );
}

function renderSavedRegions() {
  renderSavedRegionsForMap("dom");
  renderSavedRegionsForMap("dsm");
}

function renderSavedRegionsForMap(kind) {
  const { content } = mapParts(kind);
  if (!content) return;
  content.querySelectorAll(".saved-region").forEach((node) => node.remove());
  renderVectorLayer(kind);
}

function renderVectorLayer(kind = "dom") {
  const { source, view } = mapParts(kind);
  const layer = ensureMapVectorLayer(kind);
  if (!layer) return;
  layer.innerHTML = "";
  for (const [index, region] of state.regions.entries()) {
    if (!regionMatchesSource(region, source)) continue;
    const visual = regionVisual(region, index);
    const selected = region.id === state.selectedRegionId;
    let shape = null;
    let anchor = null;
    if (Array.isArray(region.pixelPoints) && region.pixelPoints.length >= 3) {
      shape = document.createElementNS(SVG_NS, "polygon");
      shape.setAttribute("points", region.pixelPoints.map((point) => `${point.x},${point.y}`).join(" "));
      anchor = region.pixelPoints[0];
    } else if (region.pixelBox) {
      shape = document.createElementNS(SVG_NS, "rect");
      shape.setAttribute("x", region.pixelBox.x);
      shape.setAttribute("y", region.pixelBox.y);
      shape.setAttribute("width", region.pixelBox.width);
      shape.setAttribute("height", region.pixelBox.height);
      anchor = { x: region.pixelBox.x, y: region.pixelBox.y };
    }
    if (!shape || !anchor) continue;
    shape.setAttribute("class", selected ? "region-shape region-shape-selected" : "region-shape");
    shape.setAttribute("stroke", visual.stroke);
    shape.setAttribute("fill", selected ? visual.selectedFill : visual.fill);
    layer.append(shape);
    const labelWidth = Math.max(62, region.name.length * 8 + 12);
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("x", anchor.x + 7);
    bg.setAttribute("y", anchor.y + 7);
    bg.setAttribute("width", labelWidth);
    bg.setAttribute("height", 20);
    bg.setAttribute("class", "region-label-bg");
    bg.setAttribute("fill", visual.stroke);
    layer.append(bg);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", anchor.x + 13);
    label.setAttribute("y", anchor.y + 21);
    label.setAttribute("class", "region-label");
    label.setAttribute("fill", "#071018");
    label.textContent = region.name;
    layer.append(label);
  }

  if (kind === "dom" && state.drawKind === "dom" && state.polygonPoints.length) {
    const preview = [...state.polygonPoints];
    if (state.polygonCursor) preview.push(state.polygonCursor);
    const polygon = document.createElementNS(SVG_NS, "polyline");
    const visual = nextRegionVisual();
    polygon.setAttribute("points", preview.map((point) => `${point.x},${point.y}`).join(" "));
    polygon.setAttribute("class", "draft-poly");
    polygon.setAttribute("stroke", visual.stroke);
    layer.append(polygon);
    for (const point of state.polygonPoints) {
      const vertex = document.createElementNS(SVG_NS, "circle");
      vertex.setAttribute("cx", point.x);
      vertex.setAttribute("cy", point.y);
      vertex.setAttribute("r", 4 / Math.max(view.scale, 0.25));
      vertex.setAttribute("class", "draft-vertex");
      layer.append(vertex);
    }
  }

  renderTrajectoryOnMap(kind, layer);
}

function renderTrajectoryOnMap(kind, layer) {
  updateTrajectoryElements(kind, layer);
}

function primaryTrajectoryTopic() {
  return state.system?.settings?.globalposeTopic || "/self_state/globalpose";
}

function trajectoryColor(topic) {
  if (topic === primaryTrajectoryTopic()) return "var(--trajectory-color)";
  const configuredTopics = state.system?.settings?.globalposeTopics || [];
  const configuredIndex = configuredTopics.indexOf(topic);
  if (configuredIndex > 0) {
    return SECONDARY_TRAJECTORY_COLORS[(configuredIndex - 1) % SECONDARY_TRAJECTORY_COLORS.length];
  }
  let hash = 0;
  for (const character of topic) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return SECONDARY_TRAJECTORY_COLORS[Math.abs(hash) % SECONDARY_TRAJECTORY_COLORS.length];
}

function ensureTrajectoryTopicNodes(kind, layer, topic) {
  const nodeMap = trajectoryNodes[kind];
  let nodes = nodeMap.get(topic);
  if (!nodes) {
    const color = trajectoryColor(topic);
    nodes = {
      group: document.createElementNS(SVG_NS, "g"),
      trail: document.createElementNS(SVG_NS, "polyline"),
      position: document.createElementNS(SVG_NS, "circle"),
      ring: document.createElementNS(SVG_NS, "circle"),
      start: document.createElementNS(SVG_NS, "circle")
    };
    nodes.group.dataset.topic = topic;
    nodes.trail.setAttribute("class", "trajectory-trail");
    nodes.trail.style.fill = "none";
    nodes.trail.style.stroke = color;
    nodes.trail.style.strokeWidth = "var(--trajectory-width)";
    nodes.trail.style.opacity = "1";
    nodes.position.setAttribute("class", "trajectory-pos");
    nodes.position.style.fill = color;
    nodes.ring.setAttribute("class", "trajectory-ring");
    nodes.ring.style.stroke = color;
    nodes.start.setAttribute("class", "trajectory-start");
    nodes.start.style.fill = color;
    nodes.group.append(nodes.trail, nodes.position, nodes.ring, nodes.start);
    nodeMap.set(topic, nodes);
  }
  layer.append(nodes.group);
  return nodes;
}

function renderTrajectoryLegend(kind, topics) {
  const legend = kind === "dsm" ? elements.dsmTrajectoryLegend : elements.domTrajectoryLegend;
  if (!legend) return;
  legend.replaceChildren();
  for (const topic of topics) {
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    const label = document.createElement("b");
    swatch.style.background = trajectoryColor(topic);
    label.textContent = topic;
    item.append(swatch, label);
    legend.append(item);
  }
  legend.hidden = topics.length === 0;
}

function updateTrajectoryElements(kind, layerOverride = null) {
  const source = kind === "dsm" ? state.dsmSource : state.source;
  const view = kind === "dsm" ? state.dsmView : state.view;
  const cache = trajectoryProjection[kind];
  const layer = layerOverride || (kind === "dsm" ? elements.dsmVectorLayer : elements.vectorLayer);
  if (!layer) return;
  const grouped = new Map();
  if (cache.fingerprint === source.fingerprint) {
    for (const sample of state.telemetryHistory) {
      const point = cache.pixels.get(sample.id);
      if (!point) continue;
      const topic = sample.topic || primaryTrajectoryTopic();
      if (!grouped.has(topic)) grouped.set(topic, []);
      grouped.get(topic).push(point);
    }
  }
  const activeTopics = new Set(grouped.keys());
  const scale = Math.max(view.scale, 0.02);
  for (const [topic, pixelPoints] of grouped) {
    const nodes = ensureTrajectoryTopicNodes(kind, layer, topic);
    nodes.trail.setAttribute("points", pixelPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "));
    const last = pixelPoints[pixelPoints.length - 1];
    nodes.position.setAttribute("cx", last.x.toFixed(1));
    nodes.position.setAttribute("cy", last.y.toFixed(1));
    nodes.position.setAttribute("r", (5 / scale).toFixed(1));
    nodes.ring.setAttribute("cx", last.x.toFixed(1));
    nodes.ring.setAttribute("cy", last.y.toFixed(1));
    nodes.ring.setAttribute("r", (12 / scale).toFixed(1));
    if (pixelPoints.length > 3) {
      const first = pixelPoints[0];
      nodes.start.setAttribute("cx", first.x.toFixed(1));
      nodes.start.setAttribute("cy", first.y.toFixed(1));
      nodes.start.setAttribute("r", (3.5 / scale).toFixed(1));
    } else {
      nodes.start.setAttribute("r", "0");
    }
  }
  for (const [topic, nodes] of trajectoryNodes[kind]) {
    if (activeTopics.has(topic)) continue;
    nodes.group.remove();
    trajectoryNodes[kind].delete(topic);
  }
  renderTrajectoryLegend(kind, [...grouped.keys()]);
}

function handleMapSourceChanged(kind) {
  if (kind === "dom") {
    window.clearTimeout(domPointerTimer);
    domPointerController?.abort();
    domPointerRequestId += 1;
  } else {
    window.clearTimeout(dsmPointerTimer);
    dsmPointerController?.abort();
    dsmPointerRequestId += 1;
    window.clearTimeout(telemetryElevationTimer);
    telemetryElevationController?.abort();
    telemetryElevationRequestId += 1;
  }
  resetTrajectoryProjection(kind);
}

function resetTrajectoryProjection(kind) {
  const source = mapParts(kind).source;
  const cache = trajectoryProjection[kind];
  window.clearTimeout(cache.timer);
  cache.controller?.abort();
  cache.requestId += 1;
  cache.fingerprint = source.fingerprint;
  cache.pixels.clear();
  cache.pending.clear();
  cache.timer = 0;
  cache.controller = null;
  if (!source.loaded) {
    scheduleTrajectoryUpdate();
    return;
  }
  if (isGeoTiffSource(source)) {
    for (const sample of state.telemetryHistory) cache.pending.add(sample.id);
    scheduleProjectionFlush(kind, 0);
  } else {
    for (const sample of state.telemetryHistory) {
      cache.pixels.set(sample.id, latLonToContentForSource(source, sample.lat, sample.lon));
    }
    scheduleTrajectoryUpdate();
  }
}

function cacheTelemetryProjection(kind, sample) {
  const source = mapParts(kind).source;
  const cache = trajectoryProjection[kind];
  if (!source.loaded || cache.fingerprint !== source.fingerprint) return;
  if (isGeoTiffSource(source)) {
    cache.pending.add(sample.id);
    scheduleProjectionFlush(kind, 90);
  } else {
    cache.pixels.set(sample.id, latLonToContentForSource(source, sample.lat, sample.lon));
    scheduleTrajectoryUpdate();
  }
}

function scheduleProjectionFlush(kind, delay) {
  const cache = trajectoryProjection[kind];
  if (cache.timer || cache.controller || !cache.pending.size) return;
  cache.timer = window.setTimeout(() => {
    cache.timer = 0;
    flushTrajectoryProjection(kind);
  }, delay);
}

async function flushTrajectoryProjection(kind) {
  const cache = trajectoryProjection[kind];
  const source = mapParts(kind).source;
  if (cache.controller || !cache.pending.size || !isGeoTiffSource(source)) return;
  const samples = state.telemetryHistory.filter((sample) => cache.pending.has(sample.id));
  samples.forEach((sample) => cache.pending.delete(sample.id));
  if (!samples.length) return;
  const fingerprint = source.fingerprint;
  const requestId = ++cache.requestId;
  cache.controller = new AbortController();
  try {
    const points = await requestCoordinateBatch(
      kind,
      "wgs84_to_pixel",
      samples.map((sample) => ({ lat: sample.lat, lon: sample.lon })),
      fingerprint,
      cache.controller.signal
    );
    if (requestId !== cache.requestId || cache.fingerprint !== fingerprint) return;
    points.forEach((point, index) => {
      const x = toFiniteNumber(point.x);
      const y = toFiniteNumber(point.y);
      if (x !== null && y !== null) cache.pixels.set(samples[index].id, { x, y });
    });
    scheduleTrajectoryUpdate();
  } catch (error) {
    if (error.name !== "AbortError" && error.name !== "StaleMapError") {
      console.warn(`${labelForMap(kind)} trajectory projection failed`, error);
    }
  } finally {
    if (requestId === cache.requestId) cache.controller = null;
    if (cache.pending.size) scheduleProjectionFlush(kind, 180);
  }
}

async function requestCoordinateBatch(kind, direction, points, expectedFingerprint, signal) {
  const source = mapParts(kind).source;
  if (!isGeoTiffSource(source)) {
    return direction === "pixel_to_wgs84"
      ? points.map((point) => contentToLatLonForSource(source, point.x, point.y))
      : points.map((point) => latLonToContentForSource(source, point.lat, point.lon));
  }
  if (!points.length) return [];
  const response = await fetch(`/api/map/${kind}/coordinates`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ direction, points })
  });
  const data = await readApiResponse(response);
  const currentSource = mapParts(kind).source;
  if (
    currentSource.fingerprint !== expectedFingerprint
    || String(data.fingerprint || "") !== String(expectedFingerprint)
  ) {
    const error = new Error("地图数据已切换");
    error.name = "StaleMapError";
    throw error;
  }
  if (!Array.isArray(data.points) || data.points.length !== points.length) {
    throw new Error("坐标转换返回的数据数量无效");
  }
  return data.points;
}

function pixelsToGeographic(kind, points) {
  const source = mapParts(kind).source;
  return requestCoordinateBatch(kind, "pixel_to_wgs84", points, source.fingerprint);
}

function renderRegionSelect() {
  const options = ['<option value="">未选择</option>'];
  for (const region of state.regions) {
    const shape = region.shape === "polygon" ? "多边形" : "矩形";
    const source = labelForMap(regionSourceKind(region));
    options.push(`<option value="${escapeHtml(region.id)}">${escapeHtml(region.name)} · ${source} ${shape}</option>`);
  }
  elements.regionSelect.innerHTML = options.join("");
  if (!state.regions.some((region) => region.id === state.selectedRegionId)) {
    state.selectedRegionId = "";
  }
  elements.regionSelect.value = state.selectedRegionId;
  elements.deleteRegionButton.disabled = !state.selectedRegionId;
  saveUiPreferences();
}

function updateRegionReadout() {
  const region = getSelectedRegion();
  if (!region) {
    elements.regionReadout.textContent = "未选择";
    elements.deleteRegionButton.disabled = true;
    return;
  }
  elements.deleteRegionButton.disabled = false;
  elements.regionReadout.textContent = JSON.stringify(buildRegionMessage(region), null, 2);
}

function regionSourceKind(region) {
  if (region?.sourceKind === "dsm" || region?.sourceKind === "dom") return region.sourceKind;
  return String(region?.sourceType || "").includes("dsm") ? "dsm" : "dom";
}

function buildRegionMessage(region) {
  return { flag: elements.flagSelect.value, region };
}

function getSelectedRegion() {
  return state.regions.find((region) => region.id === elements.regionSelect.value) || null;
}

async function deleteSelectedRegion() {
  const region = getSelectedRegion();
  if (!region) {
    addLog("请先选择要删除的区域");
    return;
  }
  if (!window.confirm(`确定删除区域 ${region.name}？此操作会同步删除后端记录。`)) return;

  elements.deleteRegionButton.disabled = true;
  try {
    const response = await fetch(`/api/regions/${encodeURIComponent(region.id)}`, { method: "DELETE" });
    const data = await readApiResponse(response);
    state.regions = Array.isArray(data.regions) ? data.regions : state.regions.filter((item) => item.id !== region.id);
    state.selectedRegionId = "";
    renderRegionSelect();
    renderSavedRegions();
    updateRegionReadout();
    addLog(`已删除区域: ${region.name}`);
  } catch (error) {
    elements.deleteRegionButton.disabled = false;
    addLog(`删除区域失败: ${error.message}`);
  }
}

async function startPublishing() {
  const region = getSelectedRegion();
  if (!region) {
    addLog("请选择区域后发布");
    return;
  }
  const payload = {
    ...buildRegionMessage(region),
    topic: elements.topicInput.value.trim() || "/selected_region",
    rateHz: 50
  };
  try {
    const response = await postJson("/api/publish/start", payload);
    updatePublishUi(response.publications || []);
    addLog(`添加发布: ${region.name} · ${payload.flag} → ${payload.topic}`);
  } catch (error) {
    addLog(`发布失败: ${error.message}`);
  }
}

async function stopPublishing(publicationId = "") {
  try {
    const response = await postJson("/api/publish/stop", publicationId ? { publicationId } : {});
    updatePublishUi(response.publications || []);
    addLog(publicationId ? "已停止一条区域发布任务" : "已停止全部区域发布任务");
  } catch (error) {
    addLog(`停止发布失败: ${error.message}`);
  }
}

function updatePublishUi(publications = state.publications) {
  state.publications = Array.isArray(publications) ? publications : [];
  const activePublications = state.publications.filter((publication) => publication.active);
  const failedPublications = state.publications.filter((publication) => publication.deliveryState === "ERROR");
  const active = activePublications.length > 0;
  const deliveryState = failedPublications.length
    ? `${failedPublications.length} ERROR`
    : active
      ? `${activePublications.length} ACTIVE`
      : "IDLE";
  state.publishing = active;
  elements.publishState.classList.toggle("muted", !active);
  elements.publishButton.disabled = false;
  elements.stopButton.disabled = state.publications.length === 0;
  elements.publishStatus.textContent = deliveryState;
  elements.publishStatus.style.color = failedPublications.length ? "var(--red)" : active ? "var(--green)" : "";
  elements.publishStatus.title = failedPublications.map((publication) => publication.lastError).filter(Boolean).join("\n");
  renderPublicationList();
}

function renderPublicationList() {
  elements.publicationList.replaceChildren();
  if (state.publications.length === 0) {
    const empty = document.createElement("p");
    empty.className = "publication-empty";
    empty.textContent = "暂无发布任务";
    elements.publicationList.append(empty);
    return;
  }
  for (const publication of state.publications) {
    const item = document.createElement("div");
    const summary = document.createElement("div");
    const name = document.createElement("strong");
    const detail = document.createElement("small");
    const stop = document.createElement("button");
    item.className = `publication-item${publication.deliveryState === "ERROR" ? " error" : ""}`;
    summary.className = "publication-summary";
    name.textContent = `${publication.region?.name || "未命名区域"} · ${publication.deliveryState || "PENDING"}`;
    detail.textContent = `${publication.flag} → ${publication.topic} · ${publication.rateHz} Hz`;
    detail.title = detail.textContent;
    stop.className = "publication-stop";
    stop.type = "button";
    stop.textContent = "停止";
    stop.title = `停止 ${publication.region?.name || "区域"} 的发布`;
    stop.addEventListener("click", () => stopPublishing(publication.id));
    summary.append(name, detail);
    item.append(summary, stop);
    elements.publicationList.append(item);
  }
}

async function toggleLocalization() {
  const action = state.localizationRunning ? "stop" : "start";
  elements.startLocButton.disabled = true;
  elements.startLocButton.textContent = action === "start" ? "启动中..." : "停止中...";
  try {
    const response = await postJson(`/api/localization/${action}`, {});
    state.localizationStatus = response.localization || null;
    state.localizationRunning = Boolean(response.localization?.active);
    updateLocalizationUi(state.localizationStatus);
    addLog(state.localizationRunning ? "完整定位程序已启动" : "完整定位程序已停止");
    loadSystemStatus();
  } catch (error) {
    if (error.data?.localization) {
      state.localizationStatus = error.data.localization;
      state.localizationRunning = Boolean(error.data.localization.active);
      updateLocalizationUi(state.localizationStatus);
    }
    addLog(`定位程序操作失败: ${error.message}`);
  } finally {
    elements.startLocButton.disabled = false;
    updateLocalizationUi(state.localizationStatus);
  }
}

function updateLocalizationUi(localization = state.localizationStatus) {
  const status = localization || { active: state.localizationRunning };
  const lifecycle = status.state || (status.active ? "RUNNING" : "STOPPED");
  const displayLifecycle = status.mock && status.active ? "SIM / RUNNING" : lifecycle;
  state.localizationStatus = status;
  state.localizationRunning = Boolean(status.active);
  elements.locState.classList.toggle("muted", !state.localizationRunning);
  elements.startLocButton.classList.toggle("running", state.localizationRunning);
  elements.startLocButton.textContent = state.localizationRunning ? "停止定位程序" : "启动定位程序";
  elements.locProgramState.textContent = displayLifecycle;
  elements.locProgramState.classList.toggle("running", lifecycle === "RUNNING");
  elements.locProgramState.classList.toggle("error", lifecycle === "ERROR");
  const processes = Array.isArray(status.processes) ? status.processes : [];
  elements.processValue.textContent = status.mock && status.active
    ? "simulation"
    : processes.length
      ? `${processes.filter((process) => process.alive).length}/${processes.length} running`
      : state.localizationRunning
        ? "launch active"
        : "0 process";
  const launch = status.launch;
  if (launch) {
    elements.launchConfigValue.textContent = status.mock
      ? "SIMULATION"
      : launch.configured
        ? `${launch.package} / ${launch.file}`
        : "未配置";
    elements.launchConfigValue.title = launch.configured ? `${launch.package}/${launch.file}` : "";
  }
  const error = status.lastError || "";
  elements.localizationError.hidden = !error;
  elements.localizationError.textContent = error;
}

async function loadSystemStatus() {
  try {
    const response = await fetch("/api/system/status", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    renderSystemStatus(await response.json());
  } catch {
    // The Node demo backend intentionally has no ROS system endpoint.
  }
}

function renderSystemStatus(system) {
  if (!system) return;
  state.system = system;
  const gateway = system.gateway || {};
  const ros = system.ros || {};
  const simulation = Boolean(system.settings?.simulation || ros.mode === "simulation");
  elements.gatewayState.classList.toggle("muted", !gateway.online);
  elements.rosState.classList.toggle("muted", simulation || !ros.masterOnline);
  elements.bridgeMode.textContent = simulation
    ? "SIMULATION"
    : gateway.implementation === "fastapi-rospy"
      ? "ROS1 GATEWAY"
      : "DEMO";
  elements.rosMasterValue.textContent = simulation ? "SIMULATION" : ros.masterOnline ? "ONLINE" : "OFFLINE";
  elements.rosMasterValue.style.color = simulation
    ? "var(--cyan)"
    : ros.masterOnline
      ? "var(--green)"
      : "var(--red)";
  elements.rosNodeValue.textContent = simulation
    ? "MOCK TRANSPORT"
    : ros.nodeStarted
      ? ros.nodeName || "skyforge_gateway"
      : "NOT STARTED";
  elements.rosNodeValue.title = ros.lastError || "";
  const trajectoryType = ros.trajectoryMessageType || "--";
  const regionType = ros.messageType || "--";
  const trajectoryTopics = ros.topics?.globalposes || system.settings?.globalposeTopics || [primaryTrajectoryTopic()];
  elements.messageTypeValue.textContent = `${trajectoryType.split("/").pop()} + ${regionType.split("/").pop()}`;
  elements.messageTypeValue.title = `轨迹: ${trajectoryType}\n话题: ${trajectoryTopics.join(", ")}\n区域: ${regionType}`;
  if (system.localization) updateLocalizationUi(system.localization);
}

function updateClock() {
  elements.systemClock.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

async function runAgent() {
  const region = getSelectedRegion();
  const payload = {
    mode: elements.agentType.value,
    graphEndpoint: elements.graphEndpoint.value.trim(),
    prompt: elements.agentPrompt.value.trim(),
    region,
    context: {
      telemetry: state.latestTelemetry,
      trajectory: state.telemetryHistory.slice(-30),
      publications: state.publications,
      flag: elements.flagSelect.value,
      topic: elements.topicInput.value
    }
  };

  elements.agentOutput.textContent = "调用中...";
  elements.runAgentButton.disabled = true;
  try {
    const result = await postJson("/api/agent/run", payload);
    elements.agentOutput.textContent = JSON.stringify(result.result || result, null, 2);
    addLog(`${payload.mode.toUpperCase()} 调用完成`);
  } catch (error) {
    elements.agentOutput.textContent = error.message;
    addLog(`Agent 调用失败: ${error.message}`);
  } finally {
    elements.runAgentButton.disabled = false;
  }
}

async function loadRegions() {
  try {
    const response = await fetch("/api/regions");
    const data = await response.json();
    state.regions = Array.isArray(data.regions) ? data.regions : [];
    renderRegionSelect();
    renderSavedRegions();
  } catch {
    renderRegionSelect();
  }
}

function connectEvents() {
  let retryDelay = 1000;
  let eventSource = null;

  function connect() {
    if (eventSource) { try { eventSource.close(); } catch {} }
    eventSource = new EventSource("/events");

    eventSource.addEventListener("open", () => {
      retryDelay = 1000;
      elements.backendState.classList.remove("muted");
      addLog("SSE 已连接");
    });

    eventSource.addEventListener("error", () => {
      elements.backendState.classList.add("muted");
      elements.gatewayState.classList.add("muted");
      try { eventSource.close(); } catch {}
      addLog(`SSE 断开，${Math.round(retryDelay / 1000)}s 后重连`);
      setTimeout(() => {
        connect();
        loadSystemStatus();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 1.5, 15000);
    });

    eventSource.addEventListener("hello", (event) => {
      const data = JSON.parse(event.data);
      state.regions = Array.isArray(data.regions) ? data.regions : state.regions;
      state.publications = Array.isArray(data.publications)
        ? data.publications
        : data.publishing
          ? [data.publishing]
          : [];
      state.publishing = state.publications.some((publication) => publication.active);
      state.localizationStatus = data.localization || null;
      state.localizationRunning = Boolean(data.localization?.active);
      renderRegionSelect();
      renderSavedRegions();
      updatePublishUi(state.publications);
      updateLocalizationUi(state.localizationStatus);
      if (data.latestTelemetry) updateTelemetry(data.latestTelemetry);
      else if (data.latestTopic?.payload?.lat != null && data.latestTopic?.payload?.lon != null) {
        updateTelemetry({ topic: data.latestTopic.name, ...data.latestTopic.payload });
      }
      if (data.system) renderSystemStatus(data.system);
    });

    eventSource.addEventListener("telemetry", (event) => updateTelemetry(JSON.parse(event.data)));
    eventSource.addEventListener("topic", (event) => {
      const data = JSON.parse(event.data);
      elements.topicName.textContent = data.name;
    });
    eventSource.addEventListener("publish", (event) => {
      const data = JSON.parse(event.data);
      addLog(`发布 ${data.flag || data.field}: ${data.region?.name || "region"}`);
    });
    eventSource.addEventListener("publish-state", (event) => {
      const data = JSON.parse(event.data);
      updatePublishUi(Array.isArray(data?.publications) ? data.publications : []);
    });
    eventSource.addEventListener("localization-state", (event) => {
      const data = JSON.parse(event.data);
      state.localizationStatus = data;
      state.localizationRunning = Boolean(data?.active);
      updateLocalizationUi(data);
    });
    eventSource.addEventListener("system-status", (event) => {
      renderSystemStatus(JSON.parse(event.data));
    });
    eventSource.addEventListener("regions", (event) => {
      const data = JSON.parse(event.data);
      state.regions = data.regions || [];
      renderRegionSelect();
      renderSavedRegions();
      updateRegionReadout();
    });
    eventSource.addEventListener("agent", () => addLog("Agent 结果已广播"));
  }

  connect();
}

function discardTelemetrySample(sample) {
  trajectoryProjection.dom.pixels.delete(sample.id);
  trajectoryProjection.dsm.pixels.delete(sample.id);
  trajectoryProjection.dom.pending.delete(sample.id);
  trajectoryProjection.dsm.pending.delete(sample.id);
}

function makeRoomForTrajectoryTopic(topic) {
  const existingTopics = [...new Set(state.telemetryHistory.map((sample) => sample.topic))];
  if (!existingTopics.includes(topic) && existingTopics.length >= MAX_TRAJECTORY_TOPICS) {
    const oldestTopic = state.telemetryHistory[0]?.topic;
    const retained = [];
    for (const sample of state.telemetryHistory) {
      if (sample.topic === oldestTopic) discardTelemetrySample(sample);
      else retained.push(sample);
    }
    state.telemetryHistory = retained;
  }
  const topicSamples = state.telemetryHistory.filter((sample) => sample.topic === topic);
  if (topicSamples.length < MAX_HISTORY) return;
  const removeIndex = state.telemetryHistory.findIndex((sample) => sample.topic === topic);
  if (removeIndex < 0) return;
  const [removed] = state.telemetryHistory.splice(removeIndex, 1);
  discardTelemetrySample(removed);
}

function updateTelemetry(data) {
  state.latestTelemetry = data;
  const topic = data.topic || primaryTrajectoryTopic();
  const sample = {
    id: ++telemetrySequence,
    time: data.time || new Date().toISOString(),
    lat: toFiniteNumber(data.lat),
    lon: toFiniteNumber(data.lon),
    altitude: toFiniteNumber(data.altitude),
    heading: toFiniteNumber(data.heading),
    speed: toFiniteNumber(data.speed),
    topic
  };
  if (sample.lat !== null && sample.lon !== null && data.positionUpdate !== false) {
    makeRoomForTrajectoryTopic(topic);
    state.telemetryHistory.push(sample);
    cacheTelemetryProjection("dom", sample);
    cacheTelemetryProjection("dsm", sample);
  }

  if (data.positionUpdate !== false) elements.topicName.textContent = topic;
  elements.latValue.textContent = formatNumber(data.lat, 6);
  elements.lonValue.textContent = formatNumber(data.lon, 6);
  elements.altValue.textContent = `${formatNumber(data.altitude, 1)} m`;
  elements.headingValue.textContent = `${formatNumber(data.heading, 0)}°`;
  elements.speedValue.textContent = `${formatNumber(data.speed, 2)} m/s`;
  elements.sourceValue.textContent = data.source || "--";
  if (sample.lat !== null && sample.lon !== null) queryTelemetryElevation(sample.lat, sample.lon);
  scheduleTrajectoryUpdate();
}

function toContentPoint(event) {
  return toContentPointForMap(event, "dom");
}

function toContentPointForMap(event, kind) {
  const { viewport, view } = mapParts(kind);
  const rect = viewport?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: (event.clientX - rect.left - view.x) / view.scale,
    y: (event.clientY - rect.top - view.y) / view.scale
  };
}

function clampContentPoint(point) {
  return clampContentPointForSource(point, state.source);
}

function clampContentPointForSource(point, source) {
  return { x: clamp(point.x, 0, source.width), y: clamp(point.y, 0, source.height) };
}

function contentToLatLon(x, y) {
  return contentToLatLonForSource(state.source, x, y);
}

function contentToLatLonForSource(source, x, y) {
  const px = clamp(x, 0, source.width);
  const py = clamp(y, 0, source.height);
  if (source.type === "tiles") {
    return tileToLatLon(source.minX + px / TILE_SIZE, source.minY + py / TILE_SIZE, source.z);
  }
  const bounds = source.bounds || DEFAULT_BOUNDS;
  return {
    lon: bounds.west + (px / source.width) * (bounds.east - bounds.west),
    lat: bounds.north - (py / source.height) * (bounds.north - bounds.south)
  };
}

function tileToLatLon(x, y, z) {
  const scale = 2 ** z;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lon };
}

function latLonToContent(lat, lon) {
  return latLonToContentForSource(state.source, lat, lon);
}

function latLonToContentForSource(source, lat, lon) {
  if (source.type === "tiles") {
    const scale = 2 ** source.z;
    const tileX = ((lon + 180) / 360) * scale;
    const safeLat = clamp(lat, -85.05112878, 85.05112878);
    const latRad = (safeLat * Math.PI) / 180;
    const tileY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale;
    return { x: (tileX - source.minX) * TILE_SIZE, y: (tileY - source.minY) * TILE_SIZE };
  }
  const bounds = source.bounds || DEFAULT_BOUNDS;
  return {
    x: ((lon - bounds.west) / (bounds.east - bounds.west)) * source.width,
    y: ((bounds.north - lat) / (bounds.north - bounds.south)) * source.height
  };
}

function queryDomPointerCoordinates(point) {
  const source = state.source;
  if (!isGeoTiffSource(source)) {
    const coord = contentToLatLonForSource(source, point.x, point.y);
    if (elements.cursorReadout) elements.cursorReadout.textContent = `${coord.lat.toFixed(6)}, ${coord.lon.toFixed(6)}`;
    return;
  }
  const fingerprint = source.fingerprint;
  const requestId = ++domPointerRequestId;
  window.clearTimeout(domPointerTimer);
  domPointerController?.abort();
  domPointerTimer = window.setTimeout(async () => {
    domPointerController = new AbortController();
    try {
      const [coord] = await requestCoordinateBatch(
        "dom", "pixel_to_wgs84", [{ x: point.x, y: point.y }], fingerprint, domPointerController.signal
      );
      if (requestId !== domPointerRequestId || state.source.fingerprint !== fingerprint) return;
      const lat = toFiniteNumber(coord.lat);
      const lon = toFiniteNumber(coord.lon);
      if (lat !== null && lon !== null && elements.cursorReadout) {
        elements.cursorReadout.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
        elements.cursorReadout.classList.remove("error");
      }
    } catch (error) {
      if (error.name !== "AbortError" && error.name !== "StaleMapError" && requestId === domPointerRequestId) {
        setUploadStatus("dom", `坐标查询失败: ${error.message}`, true);
      }
    }
  }, 70);
}

function queryDsmPointerElevation(x, y) {
  const source = state.dsmSource;
  const fingerprint = source.fingerprint;
  const requestId = ++dsmPointerRequestId;
  elements.dsmCursorReadout?.classList.remove("error");
  if (elements.dsmCursorReadout) elements.dsmCursorReadout.textContent = "经纬度转换中 · 高程…";
  window.clearTimeout(dsmPointerTimer);
  dsmPointerController?.abort();
  if (!source.loaded) {
    if (elements.dsmCursorReadout) elements.dsmCursorReadout.textContent = "DSM 未加载";
    return;
  }
  dsmPointerTimer = window.setTimeout(async () => {
    dsmPointerController = new AbortController();
    try {
      const data = await fetchDsmElevation({ x, y }, dsmPointerController.signal);
      if (requestId !== dsmPointerRequestId || state.dsmSource.fingerprint !== fingerprint) return;
      if (data.fingerprint && String(data.fingerprint) !== String(fingerprint)) return;
      const elevation = toFiniteNumber(data.elevation);
      const lat = toFiniteNumber(data.lat);
      const lon = toFiniteNumber(data.lon);
      const coordinate = lat !== null && lon !== null ? `${lat.toFixed(6)}, ${lon.toFixed(6)}` : "经纬度不可用";
      elements.dsmCursorReadout.textContent = elevation === null
        ? `${coordinate} · ${data.error || "无高程"}`
        : `${coordinate} · ${elevation.toFixed(2)} ${data.unit || "m"}`;
    } catch (error) {
      if (error.name !== "AbortError" && requestId === dsmPointerRequestId) {
        elements.dsmCursorReadout.textContent = `高程查询失败: ${error.message}`;
        elements.dsmCursorReadout.classList.add("error");
      }
    }
  }, 100);
}

function queryTelemetryElevation(lat, lon) {
  const fingerprint = state.dsmSource.fingerprint;
  const requestId = ++telemetryElevationRequestId;
  window.clearTimeout(telemetryElevationTimer);
  telemetryElevationController?.abort();
  if (!state.dsmSource.loaded) {
    if (elements.groundElevationValue) elements.groundElevationValue.textContent = "--";
    return;
  }
  telemetryElevationTimer = window.setTimeout(async () => {
    telemetryElevationController = new AbortController();
    try {
      const data = await fetchDsmElevation({ lat, lon }, telemetryElevationController.signal);
      if (requestId !== telemetryElevationRequestId || state.dsmSource.fingerprint !== fingerprint) return;
      if (data.fingerprint && String(data.fingerprint) !== String(fingerprint)) return;
      const elevation = toFiniteNumber(data.elevation);
      elements.groundElevationValue.textContent = elevation === null ? "--" : `${elevation.toFixed(1)} ${data.unit || "m"}`;
    } catch (error) {
      if (error.name !== "AbortError" && requestId === telemetryElevationRequestId) elements.groundElevationValue.textContent = "--";
    }
  }, 350);
}

async function fetchDsmElevation(coordinates, signal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(coordinates)) params.set(key, String(value));
  const response = await fetch(`/api/map/dsm/elevation?${params}`, { signal, headers: { accept: "application/json" } });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed: ${response.status}`);
  return data;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.data = data;
    throw error;
  }
  return data;
}

function addLog(message) {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  item.innerHTML = `<time>${time}</time>${escapeHtml(message)}`;
  elements.eventLog.prepend(item);
  while (elements.eventLog.children.length > 70) elements.eventLog.lastElementChild.remove();
}

function dedupeAdjacentPoints(points) {
  return points.filter((point, index) => {
    if (!index) return true;
    const previous = points[index - 1];
    return Math.hypot(point.x - previous.x, point.y - previous.y) > 2;
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value, digits) {
  const number = toFiniteNumber(value);
  return number === null ? "--" : number.toFixed(digits);
}

function bindRailNavigation() {
  const rail = document.querySelector(".rail");
  if (!rail) return;
  const buttons = Array.from(rail.querySelectorAll(".rail-item[data-view]"));

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      buttons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      const view = button.dataset.view;
      const explicitTarget = Array.from(document.querySelectorAll("[data-rail-target]"))
        .find((node) => node.dataset.railTarget === view);
      const panelTarget = Array.from(document.querySelectorAll("[data-view]"))
        .find((node) => !node.classList.contains("rail-item") && node.dataset.view === view);
      const target = explicitTarget || panelTarget;
      if (!target) return;

      if (target.classList.contains("vehicle-hud")) {
        target.focus({ preventScroll: true });
      } else {
        const sidePanel = target.closest(".side-panel");
        if (sidePanel) {
          const panelRect = sidePanel.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          const top = sidePanel.scrollTop + targetRect.top - panelRect.top - 8;
          sidePanel.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        }
      }
      window.scrollTo(0, 0);
      target.classList.remove("panel-highlight");
      requestAnimationFrame(() => target.classList.add("panel-highlight"));
      window.setTimeout(() => target.classList.remove("panel-highlight"), 800);
    });
  });
}
