import { MAX_MASKS, hitTest, moveMask, normalizeMask, resizeMask } from "../core/mask-editing.js";

// Manual redaction editor (FR-009.2, FR-009.3). Runs in its own extension tab
// so page scripts never see unredacted pixels. Masks are kept in image pixels;
// the canvas shows the screenshot scaled to fit the window.

const MASK_COLOR = "#16181d";
const SELECT_COLOR = "#3a83f7";
const HANDLE_CSS = 10;
const CLOSE_DELAY_MS = 800;
const CURSORS = {
  move: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize"
};

const elements = {
  subtitle: document.querySelector('[data-role="subtitle"]'),
  status: document.querySelector('[data-role="status"]'),
  stage: document.querySelector('[data-role="stage"]'),
  canvas: document.querySelector('[data-role="canvas"]'),
  remove: document.querySelector('[data-action="delete"]'),
  cancel: document.querySelector('[data-action="cancel"]'),
  apply: document.querySelector('[data-action="apply"]')
};

const params = new URLSearchParams(location.search);
const journeyId = params.get("journey");
const frameId = params.get("frame");
const context = elements.canvas.getContext("2d");

const state = {
  image: null,
  bounds: null,
  scale: 1,
  masks: [],
  selected: -1,
  drag: null,
  busy: false,
  done: false
};

function setStatus(text, tone = "") {
  elements.status.textContent = text;
  elements.status.dataset.tone = tone;
}

function updateControls() {
  const locked = state.busy || state.done || !state.image;
  elements.apply.disabled = locked || state.masks.length === 0;
  elements.remove.disabled = locked || state.selected < 0;
  elements.cancel.disabled = state.busy;
}

async function send(command) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "clicksheet:journey", command });
    return response ?? { ok: false, error: "Clicksheet did not respond." };
  } catch (error) {
    return { ok: false, error: error?.message || "Clicksheet did not respond." };
  }
}

async function load() {
  if (!journeyId || !frameId) {
    elements.subtitle.textContent = "No screenshot selected.";
    setStatus("Open the editor from a screenshot thumbnail.", "warn");
    return;
  }

  const response = await send({ action: "screenshot", journeyId, frameId });
  if (!response.ok) {
    elements.subtitle.textContent = "Screenshot unavailable.";
    setStatus(response.error || "The screenshot could not be loaded.", "warn");
    return;
  }

  const { screenshot, frame = {}, journeyName } = response.view ?? {};
  try {
    const image = new Image();
    image.src = screenshot;
    await image.decode();
    state.image = image;
    state.bounds = { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    elements.subtitle.textContent = "Screenshot unavailable.";
    setStatus("The screenshot image could not be read.", "warn");
    return;
  }

  const label = [journeyName, frame.title || frame.pathname].filter(Boolean).join(" · ");
  elements.subtitle.textContent = label || "Screenshot";
  if (frame.title) document.title = `Redact · ${frame.title}`;
  elements.canvas.hidden = false;
  layout();
  updateControls();
  elements.canvas.focus();
}

// Fits the image inside the stage without upscaling past its natural size.
function layout() {
  if (!state.image) return;
  const { width, height } = state.bounds;
  const availableWidth = Math.max(1, elements.stage.clientWidth - 2);
  const availableHeight = Math.max(1, elements.stage.clientHeight - 2);
  state.scale = Math.min(1, availableWidth / width, availableHeight / height);

  const cssWidth = Math.max(1, Math.round(width * state.scale));
  const cssHeight = Math.max(1, Math.round(height * state.scale));
  const ratio = window.devicePixelRatio || 1;
  elements.canvas.style.width = `${cssWidth}px`;
  elements.canvas.style.height = `${cssHeight}px`;
  elements.canvas.width = Math.round(cssWidth * ratio);
  elements.canvas.height = Math.round(cssHeight * ratio);
  draw();
}

function draw() {
  if (!state.image) return;
  const { width, height } = state.bounds;
  const factorX = elements.canvas.width / width;
  const factorY = elements.canvas.height / height;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  context.setTransform(factorX, 0, 0, factorY, 0, 0);
  context.drawImage(state.image, 0, 0, width, height);

  context.fillStyle = MASK_COLOR;
  for (const mask of state.masks) context.fillRect(mask.x, mask.y, mask.width, mask.height);

  const draft = state.drag?.mode === "draw" ? normalizeMask(state.drag.rect, state.bounds) : null;
  if (draft) {
    context.fillRect(draft.x, draft.y, draft.width, draft.height);
    outline(draft, [6, 4]);
  }

  const selected = state.masks[state.selected];
  if (selected) {
    outline(selected, []);
    drawHandles(selected);
  }
}

function outline(mask, dash) {
  const unit = 1 / state.scale;
  context.save();
  context.strokeStyle = SELECT_COLOR;
  context.lineWidth = 2 * unit;
  context.setLineDash(dash.map((value) => value * unit));
  context.strokeRect(mask.x, mask.y, mask.width, mask.height);
  context.restore();
}

function drawHandles(mask) {
  const size = 8 / state.scale;
  const xs = [mask.x, mask.x + mask.width / 2, mask.x + mask.width];
  const ys = [mask.y, mask.y + mask.height / 2, mask.y + mask.height];
  context.save();
  context.fillStyle = "#ffffff";
  context.strokeStyle = SELECT_COLOR;
  context.lineWidth = 1.5 / state.scale;
  for (const x of xs) {
    for (const y of ys) {
      if (x === xs[1] && y === ys[1]) continue;
      context.fillRect(x - size / 2, y - size / 2, size, size);
      context.strokeRect(x - size / 2, y - size / 2, size, size);
    }
  }
  context.restore();
}

function toImagePoint(event) {
  const rect = elements.canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / state.scale;
  const y = (event.clientY - rect.top) / state.scale;
  return {
    x: Math.min(Math.max(x, 0), state.bounds.width),
    y: Math.min(Math.max(y, 0), state.bounds.height)
  };
}

function editable() {
  return Boolean(state.image) && !state.busy && !state.done;
}

function select(index) {
  state.selected = index;
  updateControls();
  draw();
}

function onPointerDown(event) {
  if (!editable() || event.button !== 0) return;
  event.preventDefault();
  elements.canvas.focus();
  const point = toImagePoint(event);
  const hit = hitTest(state.masks, point, HANDLE_CSS / state.scale);
  elements.canvas.setPointerCapture(event.pointerId);

  if (hit) {
    state.drag = { mode: hit.handle, index: hit.index, start: point, origin: { ...state.masks[hit.index] } };
    select(hit.index);
    return;
  }

  if (state.masks.length >= MAX_MASKS) {
    setStatus(`You can add up to ${MAX_MASKS} boxes.`, "warn");
    select(-1);
    return;
  }
  state.drag = { mode: "draw", start: point, rect: { x: point.x, y: point.y, width: 0, height: 0 } };
  select(-1);
}

function onPointerMove(event) {
  if (!state.image) return;
  const point = toImagePoint(event);
  const drag = state.drag;

  if (!drag) {
    if (!editable()) return;
    const hit = hitTest(state.masks, point, HANDLE_CSS / state.scale);
    elements.canvas.style.cursor = hit ? CURSORS[hit.handle] : "crosshair";
    return;
  }

  const dx = point.x - drag.start.x;
  const dy = point.y - drag.start.y;
  if (drag.mode === "draw") {
    drag.rect = { x: drag.start.x, y: drag.start.y, width: dx, height: dy };
  } else if (drag.mode === "move") {
    state.masks[drag.index] = moveMask(drag.origin, dx, dy, state.bounds) ?? drag.origin;
  } else {
    state.masks[drag.index] = resizeMask(drag.origin, drag.mode, dx, dy, state.bounds) ?? drag.origin;
  }
  draw();
}

function onPointerUp(event) {
  const drag = state.drag;
  if (!drag) return;
  state.drag = null;
  if (elements.canvas.hasPointerCapture(event.pointerId)) {
    elements.canvas.releasePointerCapture(event.pointerId);
  }

  if (drag.mode === "draw") {
    const mask = normalizeMask(drag.rect, state.bounds);
    if (mask) {
      state.masks.push(mask);
      state.selected = state.masks.length - 1;
      setStatus(`${state.masks.length} ${state.masks.length === 1 ? "box" : "boxes"} ready to apply.`);
    }
  }
  updateControls();
  draw();
}

function deleteSelected() {
  if (!editable() || state.selected < 0) return;
  state.masks.splice(state.selected, 1);
  state.selected = -1;
  setStatus(state.masks.length ? `${state.masks.length} ${state.masks.length === 1 ? "box" : "boxes"} ready to apply.` : "Box removed.");
  updateControls();
  draw();
}

function onKeyDown(event) {
  if (!editable() || state.drag) return;
  if (event.target instanceof HTMLButtonElement && (event.key === "Backspace" || event.key === "Delete")) return;

  if (event.key === "Delete" || event.key === "Backspace") {
    if (state.selected < 0) return;
    event.preventDefault();
    deleteSelected();
    return;
  }

  if (event.key === "Escape") {
    select(-1);
    return;
  }

  const steps = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const step = steps[event.key];
  if (!step || state.selected < 0) return;
  event.preventDefault();
  const distance = event.shiftKey ? 10 : 1;
  const current = state.masks[state.selected];
  state.masks[state.selected] = moveMask(current, step[0] * distance, step[1] * distance, state.bounds) ?? current;
  draw();
}

async function applyRedactions() {
  if (!editable() || state.masks.length === 0) return;
  state.busy = true;
  state.selected = -1;
  updateControls();
  draw();
  setStatus("Applying redactions…");

  const masks = state.masks.map(({ x, y, width, height }) => ({ x, y, width, height }));
  const response = await send({ action: "redact", journeyId, frameId, masks });
  state.busy = false;

  if (!response.ok) {
    setStatus(response.error || "The redactions could not be applied.", "warn");
    updateControls();
    return;
  }

  state.done = true;
  updateControls();
  setStatus("Redactions applied. You can close this tab.", "ok");
  setTimeout(() => window.close(), CLOSE_DELAY_MS);
}

elements.canvas.addEventListener("pointerdown", onPointerDown);
elements.canvas.addEventListener("pointermove", onPointerMove);
elements.canvas.addEventListener("pointerup", onPointerUp);
elements.canvas.addEventListener("pointercancel", onPointerUp);
elements.canvas.addEventListener("lostpointercapture", onPointerUp);
document.addEventListener("keydown", onKeyDown);
elements.remove.addEventListener("click", deleteSelected);
elements.apply.addEventListener("click", applyRedactions);
elements.cancel.addEventListener("click", () => window.close());
new ResizeObserver(() => layout()).observe(elements.stage);

updateControls();
load();
