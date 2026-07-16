const $ = (selector) => document.querySelector(selector);

const elements = {
  backendState: $("#backendState"),
  gatewayState: $("#gatewayState"),
  rosState: $("#rosState"),
  mapState: $("#mapState"),
  locState: $("#locState"),
  publishState: $("#publishState"),
  bridgeMode: $("#bridgeMode"),
  systemClock: $("#systemClock"),
  folderButton: $("#folderButton"),
  onlineButton: $("#onlineButton"),
  rectButton: $("#rectButton"),
  polygonButton: $("#polygonButton"),
  fitButton: $("#fitButton"),
  folderInput: $("#folderInput"),
  mapViewport: $("#mapViewport"),
  mapContent: $("#mapContent"),
  vectorLayer: $("#vectorLayer"),
  drawHint: $("#drawHint"),
  cursorReadout: $("#cursorReadout"),
  flagSelect: $("#flagSelect"),
  regionSelect: $("#regionSelect"),
  deleteRegionButton: $("#deleteRegionButton"),
  topicInput: $("#topicInput"),
  publishButton: $("#publishButton"),
  stopButton: $("#stopButton"),
  publishStatus: $("#publishStatus"),
  startLocButton: $("#startLocButton"),
  locProgramState: $("#locProgramState"),
  rosMasterValue: $("#rosMasterValue"),
  rosNodeValue: $("#rosNodeValue"),
  messageTypeValue: $("#messageTypeValue"),
  launchConfigValue: $("#launchConfigValue"),
  processValue: $("#processValue"),
  localizationError: $("#localizationError"),
  graphEndpoint: $("#graphEndpoint"),
  agentPrompt: $("#agentPrompt"),
  agentType: $("#agentType"),
  runAgentButton: $("#runAgentButton"),
  agentOutput: $("#agentOutput"),
  topicName: $("#topicName"),
  latValue: $("#latValue"),
  lonValue: $("#lonValue"),
  altValue: $("#altValue"),
  headingValue: $("#headingValue"),
  speedValue: $("#speedValue"),
  sourceValue: $("#sourceValue"),
  regionReadout: $("#regionReadout"),
  trajectoryCanvas: $("#trajectoryCanvas"),
  curveCanvas: $("#curveCanvas"),
  curveLegend: $("#curveLegend"),
  trajInfo: $("#trajInfo"),
  eventLog: $("#eventLog")
};

const TILE_SIZE = 256;
const MAX_HISTORY = 240;
const SVG_NS = "http://www.w3.org/2000/svg";
const CURVE_SERIES = [
  { key: "altitude", label: "高度", color: "#55b8e8", unit: "m" },
  { key: "speed", label: "速度", color: "#62d49c", unit: "m/s" },
  { key: "heading", label: "航向", color: "#e9a84a", unit: "°" }
];
const ONLINE_TILE_SOURCE = {
  label: "Esri World Imagery",
  z: 15,
  centerX: 26979,
  centerY: 12416,
  radiusX: 3,
  radiusY: 2,
  url: (z, x, y) =>
    `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
};
const DEFAULT_BOUNDS = {
  north: 40.015,
  west: 116.315,
  south: 39.835,
  east: 116.505
};

const state = {
  source: {
    type: "demo",
    width: 1600,
    height: 1000,
    bounds: DEFAULT_BOUNDS,
    z: null,
    minX: 0,
    minY: 0
  },
  view: { x: 0, y: 0, scale: 1 },
  regions: [],
  selectedRegionId: "",
  drawMode: null,
  drag: null,
  selectionEl: null,
  polygonPoints: [],
  polygonCursor: null,
  latestTelemetry: null,
  telemetryHistory: [],
  publishing: false,
  publishingStatus: null,
  localizationRunning: false,
  localizationStatus: null,
  system: null
};

init();

function init() {
  renderCurveLegend();
  renderOnlineTiles();
  bindEvents();
  connectEvents();
  loadRegions();
  loadSystemStatus();
  updateClock();
  window.setInterval(updateClock, 1000);
  requestAnimationFrame(() => {
    fitView();
    drawVisualizations();
  });
  addLog("WebUI 已启动");
  bindRailNavigation();
}

function bindEvents() {
  elements.folderButton.addEventListener("click", () => elements.folderInput.click());
  elements.onlineButton.addEventListener("click", renderOnlineTiles);
  elements.folderInput.addEventListener("change", handleFolder);
  elements.fitButton.addEventListener("click", fitView);
  elements.rectButton.addEventListener("click", () => toggleDrawMode("rectangle"));
  elements.polygonButton.addEventListener("click", () => toggleDrawMode("polygon"));

  elements.mapViewport.addEventListener("mousedown", onPointerDown);
  elements.mapViewport.addEventListener("mousemove", onPointerMove);
  elements.mapViewport.addEventListener("dblclick", onDoubleClick);
  window.addEventListener("mouseup", onPointerUp);
  elements.mapViewport.addEventListener("wheel", onWheel, { passive: false });
  elements.mapViewport.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("resize", () => {
    fitView();
    drawVisualizations();
  });

  elements.regionSelect.addEventListener("change", () => {
    state.selectedRegionId = elements.regionSelect.value;
    elements.deleteRegionButton.disabled = !state.selectedRegionId;
    renderSavedRegions();
    updateRegionReadout();
  });
  elements.flagSelect.addEventListener("change", () => {
    updateRegionReadout();
    addLog(`切换标识位: ${elements.flagSelect.value}`);
  });
  elements.topicInput.addEventListener("input", updateRegionReadout);
  elements.deleteRegionButton.addEventListener("click", deleteSelectedRegion);

  elements.publishButton.addEventListener("click", startPublishing);
  elements.stopButton.addEventListener("click", stopPublishing);
  elements.startLocButton.addEventListener("click", toggleLocalization);
  elements.runAgentButton.addEventListener("click", runAgent);

  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(drawVisualizations);
    observer.observe(elements.trajectoryCanvas.parentElement);
    observer.observe(elements.curveCanvas.parentElement);
  }
}

function toggleDrawMode(mode) {
  const nextMode = state.drawMode === mode ? null : mode;
  cancelDraft();
  state.drawMode = nextMode;
  elements.rectButton.classList.toggle("active", nextMode === "rectangle");
  elements.polygonButton.classList.toggle("active", nextMode === "polygon");
  elements.mapViewport.classList.toggle("selecting", Boolean(nextMode));
  elements.drawHint.hidden = nextMode !== "polygon";
  if (nextMode === "rectangle") addLog("矩形模式：按住左键拖动创建区域");
  if (nextMode === "polygon") addLog("多边形模式：左键添加顶点，双击闭合");
}

function cancelDraft() {
  state.drag = null;
  state.polygonPoints = [];
  state.polygonCursor = null;
  state.selectionEl?.remove();
  state.selectionEl = null;
  renderVectorLayer();
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

async function handleFolder(event) {
  const files = Array.from(event.target.files || []);
  if (!files.length) return;

  addLog(`读取文件夹: ${files.length} 个文件`);
  const metadata = await readMetadata(files);
  const tiles = buildTileSet(files);

  if (tiles) {
    renderTiles(tiles);
    setMapReady(`瓦片 z${tiles.z} / ${tiles.tiles.length}`);
    addLog(`加载瓦片: z=${tiles.z}, count=${tiles.tiles.length}`);
    return;
  }

  const imageFile = files.find((file) => /\.(png|jpe?g|webp)$/i.test(file.name));
  if (imageFile) {
    await renderSingleImage(imageFile, metadata || DEFAULT_BOUNDS);
    setMapReady("单张影像");
    addLog(`加载影像: ${imageFile.name}`);
    return;
  }

  addLog("未找到可用影像文件");
}

async function readMetadata(files) {
  const jsonFile = files.find((file) =>
    /(^|\/)(bounds|metadata|geo)\.json$/i.test(file.webkitRelativePath || file.name)
  );
  if (!jsonFile) return null;
  try {
    return normalizeBounds(JSON.parse(await jsonFile.text()));
  } catch (error) {
    addLog(`metadata 解析失败: ${error.message}`);
    return null;
  }
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

function buildTileSet(files) {
  const groups = new Map();
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name;
    const match = rel.match(/(?:^|\/)(\d+)\/(\d+)\/(\d+)\.(png|jpe?g|webp)$/i);
    if (!match) continue;
    const z = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z).push({ z, x, y, url: URL.createObjectURL(file) });
  }
  if (!groups.size) return null;
  const [z, tiles] = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length)[0];
  const xs = tiles.map((tile) => tile.x);
  const ys = tiles.map((tile) => tile.y);
  return { z, tiles, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function renderTiles(tileSet) {
  const width = (tileSet.maxX - tileSet.minX + 1) * TILE_SIZE;
  const height = (tileSet.maxY - tileSet.minY + 1) * TILE_SIZE;
  state.source = {
    type: "tiles",
    width,
    height,
    z: tileSet.z,
    minX: tileSet.minX,
    minY: tileSet.minY,
    provider: tileSet.provider || "local",
    bounds: null
  };

  elements.mapContent.innerHTML = "";
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

async function renderSingleImage(file, bounds) {
  const url = URL.createObjectURL(file);
  const size = await readImageSize(url);
  state.source = {
    type: "image",
    width: size.width,
    height: size.height,
    bounds,
    z: null,
    minX: 0,
    minY: 0
  };
  elements.mapContent.innerHTML = "";
  elements.mapContent.style.width = `${size.width}px`;
  elements.mapContent.style.height = `${size.height}px`;
  const img = document.createElement("img");
  img.className = "map-image";
  img.src = url;
  img.alt = "";
  img.style.width = `${size.width}px`;
  img.style.height = `${size.height}px`;
  elements.mapContent.append(img);
  ensureVectorLayer();
  renderSavedRegions();
  fitView();
}

function readImageSize(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = src;
  });
}

function ensureVectorLayer() {
  let layer = elements.mapContent.querySelector("#vectorLayer");
  if (!layer) {
    layer = document.createElementNS(SVG_NS, "svg");
    layer.id = "vectorLayer";
    layer.classList.add("vector-layer");
    elements.mapContent.append(layer);
  }
  layer.setAttribute("viewBox", `0 0 ${state.source.width} ${state.source.height}`);
  elements.vectorLayer = layer;
  return layer;
}

function setMapReady(label) {
  elements.mapState.classList.remove("muted");
  elements.cursorReadout.textContent = label;
}

function fitView() {
  const rect = elements.mapViewport.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = Math.min(rect.width / state.source.width, rect.height / state.source.height) * 0.94;
  state.view.scale = clamp(scale, 0.08, 4);
  state.view.x = (rect.width - state.source.width * state.view.scale) / 2;
  state.view.y = (rect.height - state.source.height * state.view.scale) / 2;
  applyTransform();
}

function applyTransform() {
  elements.mapContent.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
}

function onPointerDown(event) {
  if (event.button !== 0) return;
  const point = clampContentPoint(toContentPoint(event));

  if (state.drawMode === "polygon") {
    event.preventDefault();
    if (event.detail === 1) {
      state.polygonPoints.push(point);
      state.polygonCursor = point;
      renderVectorLayer();
    }
    return;
  }

  elements.mapViewport.classList.add("dragging");
  if (state.drawMode === "rectangle") {
    state.drag = { type: "select", start: point, current: point };
    state.selectionEl?.remove();
    state.selectionEl = document.createElement("div");
    state.selectionEl.className = "selection-box";
    state.selectionEl.dataset.name = "NEW REGION";
    elements.mapContent.append(state.selectionEl);
    updateSelectionEl();
  } else {
    state.drag = {
      type: "pan",
      startClient: { x: event.clientX, y: event.clientY },
      startView: { ...state.view }
    };
  }
}

function onPointerMove(event) {
  const point = clampContentPoint(toContentPoint(event));
  const coord = contentToLatLon(point.x, point.y);
  elements.cursorReadout.textContent = `${coord.lat.toFixed(6)}, ${coord.lon.toFixed(6)}`;

  if (state.drawMode === "polygon" && state.polygonPoints.length) {
    state.polygonCursor = point;
    renderVectorLayer();
  }
  if (!state.drag) return;
  if (state.drag.type === "select") {
    state.drag.current = point;
    updateSelectionEl();
  } else if (state.drag.type === "pan") {
    state.view.x = state.drag.startView.x + event.clientX - state.drag.startClient.x;
    state.view.y = state.drag.startView.y + event.clientY - state.drag.startClient.y;
    applyTransform();
  }
}

async function onPointerUp() {
  elements.mapViewport.classList.remove("dragging");
  if (!state.drag) return;
  if (state.drag.type === "select") {
    const box = getSelectionBox();
    state.drag = null;
    if (box && box.width >= 12 && box.height >= 12) {
      await createRegionFromBox(box);
    } else {
      state.selectionEl?.remove();
      state.selectionEl = null;
    }
    return;
  }
  state.drag = null;
}

function onDoubleClick(event) {
  if (state.drawMode !== "polygon") return;
  event.preventDefault();
  event.stopPropagation();
  finishPolygon();
}

function onWheel(event) {
  event.preventDefault();
  const rect = elements.mapViewport.getBoundingClientRect();
  const mouse = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const before = {
    x: (mouse.x - state.view.x) / state.view.scale,
    y: (mouse.y - state.view.y) / state.view.scale
  };
  const factor = event.deltaY > 0 ? 0.9 : 1.1;
  state.view.scale = clamp(state.view.scale * factor, 0.08, 8);
  state.view.x = mouse.x - before.x * state.view.scale;
  state.view.y = mouse.y - before.y * state.view.scale;
  applyTransform();
}

function onContextMenu(event) {
  event.preventDefault();
  if (state.drawMode === "polygon" && state.polygonPoints.length) {
    state.polygonPoints.pop();
    if (!state.polygonPoints.length) state.polygonCursor = null;
    renderVectorLayer();
    addLog("已撤销最后一个多边形顶点");
  }
}

function updateSelectionEl() {
  const box = getSelectionBox();
  if (!box || !state.selectionEl) return;
  Object.assign(state.selectionEl.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`
  });
}

function getSelectionBox() {
  if (!state.drag?.start || !state.drag?.current) return null;
  const left = clamp(Math.min(state.drag.start.x, state.drag.current.x), 0, state.source.width);
  const top = clamp(Math.min(state.drag.start.y, state.drag.current.y), 0, state.source.height);
  const right = clamp(Math.max(state.drag.start.x, state.drag.current.x), 0, state.source.width);
  const bottom = clamp(Math.max(state.drag.start.y, state.drag.current.y), 0, state.source.height);
  return { left, top, width: right - left, height: bottom - top };
}

async function createRegionFromBox(box) {
  const topLeft = contentToLatLon(box.left, box.top);
  const bottomRight = contentToLatLon(box.left + box.width, box.top + box.height);
  const region = buildRegionBase("rectangle");
  region.pixelBox = {
    x: round(box.left, 2),
    y: round(box.top, 2),
    width: round(box.width, 2),
    height: round(box.height, 2)
  };
  region.bbox = {
    topLeft: { lat: round(topLeft.lat, 7), lon: round(topLeft.lon, 7) },
    bottomRight: { lat: round(bottomRight.lat, 7), lon: round(bottomRight.lon, 7) }
  };
  state.selectionEl?.remove();
  state.selectionEl = null;
  await saveRegion(region);
}

async function finishPolygon() {
  const points = dedupeAdjacentPoints(state.polygonPoints);
  if (points.length < 3) {
    addLog("多边形至少需要 3 个顶点");
    return;
  }
  const coordinates = points.map((point) => {
    const coord = contentToLatLon(point.x, point.y);
    return { lat: round(coord.lat, 7), lon: round(coord.lon, 7) };
  });
  const lats = coordinates.map((point) => point.lat);
  const lons = coordinates.map((point) => point.lon);
  const region = buildRegionBase("polygon");
  region.pixelPoints = points.map((point) => ({ x: round(point.x, 2), y: round(point.y, 2) }));
  region.polygon = coordinates;
  region.bbox = {
    topLeft: { lat: Math.max(...lats), lon: Math.min(...lons) },
    bottomRight: { lat: Math.min(...lats), lon: Math.max(...lons) }
  };
  state.polygonPoints = [];
  state.polygonCursor = null;
  await saveRegion(region);
}

function buildRegionBase(shape) {
  return {
    id: `region-${Date.now()}`,
    name: `AREA-${String(state.regions.length + 1).padStart(3, "0")}`,
    shape,
    sourceType: state.source.type,
    createdAt: new Date().toISOString()
  };
}

async function saveRegion(region) {
  state.regions.push(region);
  state.selectedRegionId = region.id;
  renderSavedRegions();
  renderRegionSelect();
  updateRegionReadout();
  addLog(`创建${region.shape === "polygon" ? "多边形" : "矩形"}区域: ${region.name}`);
  try {
    await postJson("/api/regions", region);
  } catch (error) {
    state.regions = state.regions.filter((item) => item.id !== region.id);
    state.selectedRegionId = "";
    renderRegionSelect();
    renderSavedRegions();
    updateRegionReadout();
    addLog(`区域保存失败，已撤销本地区域: ${error.message}`);
  }
}

function renderSavedRegions() {
  elements.mapContent.querySelectorAll(".saved-region").forEach((node) => node.remove());
  ensureVectorLayer();
  renderVectorLayer();
  for (const region of state.regions) {
    if (!region.pixelBox || region.sourceType !== state.source.type) continue;
    const el = document.createElement("div");
    el.className = "saved-region";
    if (region.id === state.selectedRegionId) el.classList.add("selected");
    el.dataset.name = region.name;
    el.style.left = `${region.pixelBox.x}px`;
    el.style.top = `${region.pixelBox.y}px`;
    el.style.width = `${region.pixelBox.width}px`;
    el.style.height = `${region.pixelBox.height}px`;
    elements.mapContent.append(el);
  }
}

function renderVectorLayer() {
  const layer = ensureVectorLayer();
  layer.innerHTML = "";
  for (const region of state.regions) {
    if (!region.pixelPoints || region.sourceType !== state.source.type) continue;
    const polygon = document.createElementNS(SVG_NS, "polygon");
    polygon.setAttribute("points", region.pixelPoints.map((point) => `${point.x},${point.y}`).join(" "));
    polygon.setAttribute("class", region.id === state.selectedRegionId ? "region-poly region-poly-selected" : "region-poly");
    layer.append(polygon);
    const anchor = region.pixelPoints[0];
    const labelWidth = Math.max(62, region.name.length * 8 + 12);
    const bg = document.createElementNS(SVG_NS, "rect");
    bg.setAttribute("x", anchor.x + 7);
    bg.setAttribute("y", anchor.y + 7);
    bg.setAttribute("width", labelWidth);
    bg.setAttribute("height", 20);
    bg.setAttribute("class", "region-label-bg");
    layer.append(bg);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", anchor.x + 13);
    label.setAttribute("y", anchor.y + 21);
    label.setAttribute("class", "region-label");
    label.textContent = region.name;
    layer.append(label);
  }

  if (state.polygonPoints.length) {
    const preview = [...state.polygonPoints];
    if (state.polygonCursor) preview.push(state.polygonCursor);
    const polygon = document.createElementNS(SVG_NS, "polyline");
    polygon.setAttribute("points", preview.map((point) => `${point.x},${point.y}`).join(" "));
    polygon.setAttribute("class", "draft-poly");
    layer.append(polygon);
    for (const point of state.polygonPoints) {
      const vertex = document.createElementNS(SVG_NS, "circle");
      vertex.setAttribute("cx", point.x);
      vertex.setAttribute("cy", point.y);
      vertex.setAttribute("r", 4 / Math.max(state.view.scale, 0.25));
      vertex.setAttribute("class", "draft-vertex");
      layer.append(vertex);
    }
  }

  renderTrajectoryOnMap(layer);
}

function renderTrajectoryOnMap(layer) {
  const history = state.telemetryHistory;
  const points = history.filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon));
  if (points.length < 2) return;

  const pixelPoints = points.map((item) => latLonToContent(item.lat, item.lon));
  const pointsStr = pixelPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const trail = document.createElementNS(SVG_NS, "polyline");
  trail.setAttribute("points", pointsStr);
  trail.setAttribute("class", "trajectory-trail");
  layer.append(trail);

  const lastPoint = pixelPoints[pixelPoints.length - 1];
  const posMarker = document.createElementNS(SVG_NS, "circle");
  posMarker.setAttribute("cx", lastPoint.x.toFixed(1));
  posMarker.setAttribute("cy", lastPoint.y.toFixed(1));
  posMarker.setAttribute("r", 5 / Math.max(state.view.scale, 0.15));
  posMarker.setAttribute("class", "trajectory-pos");
  layer.append(posMarker);

  const posRing = document.createElementNS(SVG_NS, "circle");
  posRing.setAttribute("cx", lastPoint.x.toFixed(1));
  posRing.setAttribute("cy", lastPoint.y.toFixed(1));
  posRing.setAttribute("r", 12 / Math.max(state.view.scale, 0.15));
  posRing.setAttribute("class", "trajectory-ring");
  layer.append(posRing);

  if (pixelPoints.length > 3) {
    const firstPoint = pixelPoints[0];
    const startMark = document.createElementNS(SVG_NS, "circle");
    startMark.setAttribute("cx", firstPoint.x.toFixed(1));
    startMark.setAttribute("cy", firstPoint.y.toFixed(1));
    startMark.setAttribute("r", 3.5 / Math.max(state.view.scale, 0.15));
    startMark.setAttribute("class", "trajectory-start");
    layer.append(startMark);
  }
}

function renderRegionSelect() {
  const options = ['<option value="">未选择</option>'];
  for (const region of state.regions) {
    const shape = region.shape === "polygon" ? "多边形" : "矩形";
    options.push(`<option value="${escapeHtml(region.id)}">${escapeHtml(region.name)} · ${shape}</option>`);
  }
  elements.regionSelect.innerHTML = options.join("");
  if (!state.regions.some((region) => region.id === state.selectedRegionId)) {
    state.selectedRegionId = "";
  }
  elements.regionSelect.value = state.selectedRegionId;
  elements.deleteRegionButton.disabled = !state.selectedRegionId;
}

function updateRegionReadout() {
  const region = getSelectedRegion();
  if (!region) {
    elements.regionReadout.textContent = "未选择";
    elements.deleteRegionButton.disabled = true;
    return;
  }
  elements.deleteRegionButton.disabled = false;
  elements.regionReadout.textContent = JSON.stringify(
    {
      name: region.name,
      shape: region.shape || "rectangle",
      topic: elements.topicInput.value,
      message: {
        flag: elements.flagSelect.value,
        region: region.name
      },
      bbox: region.bbox
    },
    null,
    2
  );
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
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `Request failed: ${response.status}`);
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
    flag: elements.flagSelect.value,
    topic: elements.topicInput.value.trim() || "/selected_region",
    rateHz: 1,
    region
  };
  try {
    const response = await postJson("/api/publish/start", payload);
    state.publishingStatus = response.publishing || null;
    state.publishing = Boolean(response.publishing?.active);
    updatePublishUi(state.publishingStatus);
    addLog(`开始发布: ${payload.flag} → ${payload.topic}`);
  } catch (error) {
    addLog(`发布失败: ${error.message}`);
  }
}

async function stopPublishing() {
  try {
    await postJson("/api/publish/stop", {});
    state.publishing = false;
    state.publishingStatus = null;
    updatePublishUi(null);
    addLog("停止发布");
  } catch (error) {
    addLog(`停止发布失败: ${error.message}`);
  }
}

function updatePublishUi(publishing = state.publishingStatus) {
  const active = Boolean(publishing?.active ?? state.publishing);
  const deliveryState = publishing?.deliveryState || (active ? "RUNNING" : "IDLE");
  state.publishing = active;
  state.publishingStatus = publishing;
  elements.publishState.classList.toggle("muted", !active);
  elements.publishButton.disabled = active;
  elements.stopButton.disabled = !active && deliveryState !== "ERROR";
  elements.publishStatus.textContent = deliveryState;
  elements.publishStatus.style.color = deliveryState === "ERROR" ? "var(--red)" : active ? "var(--green)" : "";
  elements.publishStatus.title = publishing?.lastError || "";
  if (publishing?.lastError) addLog(`发布状态错误: ${publishing.lastError}`);
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
  elements.messageTypeValue.textContent = ros.messageType || "--";
  elements.messageTypeValue.title = ros.messageType || "";
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
      publishing: state.publishing,
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
  const events = new EventSource("/events");
  events.addEventListener("open", () => {
    elements.backendState.classList.remove("muted");
    addLog("SSE 已连接");
  });
  events.addEventListener("error", () => {
    elements.backendState.classList.add("muted");
    elements.gatewayState.classList.add("muted");
  });
  events.addEventListener("hello", (event) => {
    const data = JSON.parse(event.data);
    state.regions = Array.isArray(data.regions) ? data.regions : state.regions;
    state.publishingStatus = data.publishing || null;
    state.publishing = Boolean(data.publishing?.active);
    state.localizationStatus = data.localization || null;
    state.localizationRunning = Boolean(data.localization?.active);
    renderRegionSelect();
    renderSavedRegions();
    updatePublishUi(state.publishingStatus);
    updateLocalizationUi(state.localizationStatus);
    if (data.latestTelemetry) updateTelemetry(data.latestTelemetry);
    else if (data.latestTopic?.payload?.lat != null && data.latestTopic?.payload?.lon != null) {
      updateTelemetry({ topic: data.latestTopic.name, ...data.latestTopic.payload });
    }
    if (data.system) renderSystemStatus(data.system);
  });
  events.addEventListener("telemetry", (event) => updateTelemetry(JSON.parse(event.data)));
  events.addEventListener("topic", (event) => {
    const data = JSON.parse(event.data);
    elements.topicName.textContent = data.name;
    addLog(`收到话题: ${data.name}`);
  });
  events.addEventListener("publish", (event) => {
    const data = JSON.parse(event.data);
    addLog(`发布 ${data.flag || data.field}: ${data.region?.name || "region"}`);
  });
  events.addEventListener("publish-state", (event) => {
    const data = JSON.parse(event.data);
    state.publishingStatus = data;
    state.publishing = Boolean(data?.active);
    updatePublishUi(data);
  });
  events.addEventListener("localization-state", (event) => {
    const data = JSON.parse(event.data);
    state.localizationStatus = data;
    state.localizationRunning = Boolean(data?.active);
    updateLocalizationUi(data);
  });
  events.addEventListener("system-status", (event) => {
    renderSystemStatus(JSON.parse(event.data));
  });
  events.addEventListener("regions", (event) => {
    const data = JSON.parse(event.data);
    state.regions = data.regions || [];
    renderRegionSelect();
    renderSavedRegions();
    updateRegionReadout();
  });
  events.addEventListener("agent", () => addLog("Agent 结果已广播"));
}

function updateTelemetry(data) {
  state.latestTelemetry = data;
  const sample = {
    time: data.time || new Date().toISOString(),
    lat: toFiniteNumber(data.lat),
    lon: toFiniteNumber(data.lon),
    altitude: toFiniteNumber(data.altitude),
    heading: toFiniteNumber(data.heading),
    speed: toFiniteNumber(data.speed)
  };
  if (sample.lat !== null && sample.lon !== null) {
    state.telemetryHistory.push(sample);
    if (state.telemetryHistory.length > MAX_HISTORY) state.telemetryHistory.shift();
  }

  elements.topicName.textContent = data.topic || "/localization/fix";
  elements.latValue.textContent = formatNumber(data.lat, 6);
  elements.lonValue.textContent = formatNumber(data.lon, 6);
  elements.altValue.textContent = `${formatNumber(data.altitude, 1)} m`;
  elements.headingValue.textContent = `${formatNumber(data.heading, 0)}°`;
  elements.speedValue.textContent = `${formatNumber(data.speed, 2)} m/s`;
  elements.sourceValue.textContent = data.source || "--";
  elements.trajInfo.textContent = `${state.telemetryHistory.length} points · live`;
  drawVisualizations();
  renderVectorLayer();
}

function renderCurveLegend() {
  elements.curveLegend.innerHTML = CURVE_SERIES.map(
    (series) => `<span class="lg" style="color:${series.color}">${series.label}</span>`
  ).join("");
}

function drawVisualizations() {
  drawTrajectory();
  drawCurves();
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawGrid(ctx, width, height, padding) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0c1720";
  ctx.fillRect(0, 0, width, height);

  const wash = ctx.createLinearGradient(0, 0, 0, height);
  wash.addColorStop(0, "rgba(85, 184, 232, 0.035)");
  wash.addColorStop(1, "rgba(8, 16, 24, 0)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(130, 190, 220, 0.09)";
  ctx.lineWidth = 1;
  for (let x = padding; x <= width - padding; x += Math.max(38, (width - padding * 2) / 8)) {
    ctx.beginPath();
    ctx.moveTo(x, padding);
    ctx.lineTo(x, height - padding);
    ctx.stroke();
  }
  for (let y = padding; y <= height - padding; y += Math.max(28, (height - padding * 2) / 6)) {
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(width - padding, y);
    ctx.stroke();
  }
}

function drawTrajectory() {
  const { ctx, width, height } = setupCanvas(elements.trajectoryCanvas);
  const padding = 26;
  drawGrid(ctx, width, height, padding);
  const points = state.telemetryHistory.filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lon));
  if (points.length < 2) {
    drawEmptyState(ctx, width, height, "WAITING FOR POSITION");
    return;
  }
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const latRange = Math.max(maxLat - minLat, 0.00001);
  const lonRange = Math.max(maxLon - minLon, 0.00001);
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  const mapped = points.map((point) => ({
    x: padding + ((point.lon - minLon) / lonRange) * plotWidth,
    y: height - padding - ((point.lat - minLat) / latRange) * plotHeight
  }));

  const gradient = ctx.createLinearGradient(padding, 0, width - padding, 0);
  gradient.addColorStop(0, "rgba(85, 184, 232, 0.5)");
  gradient.addColorStop(1, "#8dd8f8");
  ctx.strokeStyle = gradient;
  ctx.lineWidth = 1.8;
  ctx.shadowColor = "rgba(85, 184, 232, 0.18)";
  ctx.shadowBlur = 4;
  ctx.beginPath();
  mapped.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
  ctx.stroke();
  ctx.shadowBlur = 0;

  const start = mapped[0];
  const end = mapped[mapped.length - 1];
  drawPoint(ctx, start.x, start.y, "#607381", 3.5);
  drawPoint(ctx, end.x, end.y, "#8dd8f8", 4.5);
  ctx.fillStyle = "rgba(145, 164, 178, 0.7)";
  ctx.font = "9px JetBrains Mono, SFMono-Regular, Menlo, monospace";
  ctx.fillText("START", start.x + 7, start.y - 7);
  ctx.fillStyle = "#8dd8f8";
  ctx.fillText("NOW", end.x + 7, end.y - 7);
}

function drawCurves() {
  const { ctx, width, height } = setupCanvas(elements.curveCanvas);
  const padding = 26;
  drawGrid(ctx, width, height, padding);
  const history = state.telemetryHistory;
  if (history.length < 2) {
    drawEmptyState(ctx, width, height, "WAITING FOR TELEMETRY");
    return;
  }
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;
  for (const series of CURVE_SERIES) {
    const values = history.map((item) => toFiniteNumber(item[series.key])).filter((value) => value !== null);
    if (values.length < 2) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, Math.abs(max) * 0.02, 0.01);
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let drawing = false;
    history.forEach((item, index) => {
      const value = toFiniteNumber(item[series.key]);
      if (value === null) {
        drawing = false;
        return;
      }
      const x = padding + (index / Math.max(1, history.length - 1)) * plotWidth;
      const y = height - padding - ((value - min) / range) * plotHeight;
      if (!drawing) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      drawing = true;
    });
    ctx.stroke();
    const latest = toFiniteNumber(history.at(-1)?.[series.key]);
    if (latest !== null) {
      ctx.fillStyle = series.color;
      ctx.font = "9px JetBrains Mono, SFMono-Regular, Menlo, monospace";
      ctx.fillText(`${series.label} ${latest.toFixed(series.key === "heading" ? 0 : 1)}${series.unit}`, padding + 4, padding + 12 + CURVE_SERIES.indexOf(series) * 14);
    }
  }
}

function drawEmptyState(ctx, width, height, text) {
  ctx.fillStyle = "rgba(96, 115, 129, 0.72)";
  ctx.font = "9px JetBrains Mono, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.fillText(text, width / 2, height / 2);
  ctx.textAlign = "start";
}

function drawPoint(ctx, x, y, color, radius) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

function toContentPoint(event) {
  const rect = elements.mapViewport.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left - state.view.x) / state.view.scale,
    y: (event.clientY - rect.top - state.view.y) / state.view.scale
  };
}

function clampContentPoint(point) {
  return {
    x: clamp(point.x, 0, state.source.width),
    y: clamp(point.y, 0, state.source.height)
  };
}

function contentToLatLon(x, y) {
  const px = clamp(x, 0, state.source.width);
  const py = clamp(y, 0, state.source.height);
  if (state.source.type === "tiles") {
    return tileToLatLon(state.source.minX + px / TILE_SIZE, state.source.minY + py / TILE_SIZE, state.source.z);
  }
  const bounds = state.source.bounds || DEFAULT_BOUNDS;
  return {
    lon: bounds.west + (px / state.source.width) * (bounds.east - bounds.west),
    lat: bounds.north - (py / state.source.height) * (bounds.north - bounds.south)
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
  if (state.source.type === "tiles") {
    const z = state.source.z;
    const scale = 2 ** z;
    const tileX = ((lon + 180) / 360) * scale;
    const latRad = (lat * Math.PI) / 180;
    const tileY = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * scale;
    return {
      x: (tileX - state.source.minX) * TILE_SIZE,
      y: (tileY - state.source.minY) * TILE_SIZE
    };
  }
  const bounds = state.source.bounds || DEFAULT_BOUNDS;
  return {
    x: ((lon - bounds.west) / (bounds.east - bounds.west)) * state.source.width,
    y: ((bounds.north - lat) / (bounds.north - bounds.south)) * state.source.height
  };
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
  const sidePanel = document.querySelector(".side-panel");
  const sections = sidePanel ? Array.from(sidePanel.querySelectorAll("[data-view]")) : [];

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      buttons.forEach((btn) => btn.classList.remove("active"));
      button.classList.add("active");

      const view = button.dataset.view;
      const target = sections.find((section) => section.dataset.view === view);
      if (target && sidePanel) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        target.classList.add("panel-highlight");
        setTimeout(() => target.classList.remove("panel-highlight"), 800);
      }
    });
  });
}
