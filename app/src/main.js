const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen } = window.__TAURI__.event;
import { mapCropToNative } from "./export-scale.mjs";

// ----- State -----
let currentTool = "circle";
let currentColor = "#FF3B30";
let currentWidth = 4;
let markerCounter = 1;
let dimActive = false;
let isDrawing = false;
let drawStart = null;
let freehandPoints = [];
let annotations = [];
let backgroundImage = null;
let bgOffsetX = 0,
  bgOffsetY = 0,
  bgDrawW = 0,
  bgDrawH = 0;
let selectionPhase = false;
let selStart = null,
  selCurrent = null;
let cropSrc = null;
let windowContext = null;
let overlayActive = false;
let isSaving = false;

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const textInput = document.getElementById("text-input");
const toolbar = document.getElementById("toolbar");

// ----- Canvas setup -----
// On HiDPI displays, the logical size (window.innerWidth) differs from physical pixels.
// We size the canvas to physical pixels for crisp rendering, then scale the context
// so all drawing coordinates use logical pixels.
const dpr = window.devicePixelRatio || 1;

function computeBgLayout() {
  if (!backgroundImage) return;
  const logicalW = window.innerWidth;
  const logicalH = window.innerHeight;
  const logicalImgW = backgroundImage.naturalWidth / dpr;
  const logicalImgH = backgroundImage.naturalHeight / dpr;
  const scale = Math.min(logicalW / logicalImgW, logicalH / logicalImgH, 1);
  bgDrawW = logicalImgW * scale;
  bgDrawH = logicalImgH * scale;
  bgOffsetX = Math.round((logicalW - bgDrawW) / 2);
  bgOffsetY = Math.round((logicalH - bgDrawH) / 2);
}

function resizeCanvas() {
  const logicalW = window.innerWidth;
  const logicalH = window.innerHeight;
  canvas.width = logicalW * dpr;
  canvas.height = logicalH * dpr;
  canvas.style.width = logicalW + "px";
  canvas.style.height = logicalH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  computeBgLayout();
  render();
}
window.addEventListener("resize", resizeCanvas);

// ----- Init -----
async function init() {
  resizeCanvas();

  await startCaptureSession();

  await listen("snap://start", async () => {
    await startCaptureSession();
  });
}

function resetSessionState() {
  currentTool = "circle";
  currentColor = "#FF3B30";
  currentWidth = 4;
  markerCounter = 1;
  dimActive = false;
  isDrawing = false;
  drawStart = null;
  freehandPoints = [];
  annotations = [];
  selectionPhase = false;
  selStart = null;
  selCurrent = null;
  cropSrc = null;
  overlayActive = false;
  isSaving = false;

  textInput.style.display = "none";
  textInput.value = "";

  document.querySelectorAll(".tool-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tool === "circle");
  });
  document.querySelectorAll(".color-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.color === "#FF3B30");
  });
  document.querySelectorAll(".width-btn").forEach((btn, i) => {
    btn.classList.toggle("active", i === 1);
  });
  document.getElementById("btn-dim").classList.remove("active");
  toolbar.classList.remove("visible");
}

async function startCaptureSession() {
  resetSessionState();

  try {
    // Capture window context before anything else
    windowContext = await invoke("get_active_window_context");
  } catch (e) {
    console.warn("Could not capture window context:", e);
    windowContext = {
      window_title: null,
      url: null,
      window_class: null,
      pid: null,
    };
  }

  try {
    // Capture screen BEFORE showing window
    await invoke("capture_screen");
    const captureBase64 = await invoke("read_capture_base64");

    // Show window and force fullscreen
    const win = getCurrentWindow();
    await win.show();
    await win.setFullscreen(true);
    await win.setFocus();

    // Wait a tick for the window to resize, then set up canvas
    await new Promise((r) => setTimeout(r, 100));
    resizeCanvas();

    await loadBackgroundImage(captureBase64);
  } catch (e) {
    console.error("Screen capture failed:", e);
    await getCurrentWindow().show();
    showError("Screen capture failed: " + e);
    setTimeout(() => closeOverlay(), 3000);
    return;
  }

  overlayActive = true;

  if (navigator.userAgent.includes("Mac")) {
    selectionPhase = false;
    canvas.style.cursor = "default";
    toolbar.classList.add("visible");
  } else {
    selectionPhase = true;
    canvas.style.cursor = "crosshair";
  }
}

function showError(msg) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.fillStyle = "rgba(0,0,0,0.85)";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#FF3B30";
  ctx.font =
    "bold 20px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(msg, w / 2, h / 2);
  ctx.font = "14px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.fillText("Closing in 3 seconds...", w / 2, h / 2 + 30);
}

function loadBackgroundImage(base64Data) {
  return new Promise((resolve, reject) => {
    backgroundImage = null;
    render();

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      backgroundImage = img;
      computeBgLayout();
      render();
      resolve();
    };
    img.onerror = reject;
    img.src = "data:image/png;base64," + base64Data;
  });
}

// ----- Render -----
function render() {
  const logicalW = window.innerWidth;
  const logicalH = window.innerHeight;
  ctx.clearRect(0, 0, logicalW, logicalH);

  if (backgroundImage) {
    if (selectionPhase) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.drawImage(backgroundImage, bgOffsetX, bgOffsetY, bgDrawW, bgDrawH);
      ctx.restore();

      if (selStart && selCurrent) {
        const r = selNormalized();
        if (r.w > 1 && r.h > 1) {
          const sx =
            ((r.x - bgOffsetX) / bgDrawW) * backgroundImage.naturalWidth;
          const sy =
            ((r.y - bgOffsetY) / bgDrawH) * backgroundImage.naturalHeight;
          const sw = (r.w / bgDrawW) * backgroundImage.naturalWidth;
          const sh = (r.h / bgDrawH) * backgroundImage.naturalHeight;
          ctx.drawImage(backgroundImage, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
          ctx.strokeStyle = "white";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 3]);
          ctx.strokeRect(r.x, r.y, r.w, r.h);
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(0,0,0,0.65)";
          ctx.fillRect(r.x, r.y - 22, 74, 18);
          ctx.fillStyle = "white";
          ctx.font = "11px -apple-system, sans-serif";
          ctx.fillText(
            `${Math.round(r.w)} × ${Math.round(r.h)}`,
            r.x + 4,
            r.y - 8,
          );
        }
      } else {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        const label = "Drag to select region";
        ctx.font = "15px -apple-system, sans-serif";
        const tw = ctx.measureText(label).width;
        ctx.fillRect(
          logicalW / 2 - tw / 2 - 12,
          logicalH / 2 - 20,
          tw + 24,
          32,
        );
        ctx.fillStyle = "white";
        ctx.textAlign = "center";
        ctx.fillText(label, logicalW / 2, logicalH / 2 + 1);
        ctx.textAlign = "start";
      }
      return;
    }

    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, logicalW, logicalH);
    if (cropSrc) {
      ctx.drawImage(
        backgroundImage,
        cropSrc.x,
        cropSrc.y,
        cropSrc.w,
        cropSrc.h,
        bgOffsetX,
        bgOffsetY,
        bgDrawW,
        bgDrawH,
      );
    } else {
      ctx.drawImage(backgroundImage, bgOffsetX, bgOffsetY, bgDrawW, bgDrawH);
    }
  }

  if (dimActive) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.3)";
    ctx.fillRect(0, 0, logicalW, logicalH);
  }

  for (const a of annotations) {
    renderAnnotation(a);
  }
}

function selNormalized() {
  const x = Math.min(selStart.x, selCurrent.x);
  const y = Math.min(selStart.y, selCurrent.y);
  const w = Math.abs(selCurrent.x - selStart.x);
  const h = Math.abs(selCurrent.y - selStart.y);
  return { x, y, w, h };
}

function commitSelection(x, y, w, h) {
  cropSrc = {
    x: ((x - bgOffsetX) / bgDrawW) * backgroundImage.naturalWidth,
    y: ((y - bgOffsetY) / bgDrawH) * backgroundImage.naturalHeight,
    w: (w / bgDrawW) * backgroundImage.naturalWidth,
    h: (h / bgDrawH) * backgroundImage.naturalHeight,
  };
  bgOffsetX = 0;
  bgOffsetY = 0;
  bgDrawW = window.innerWidth;
  bgDrawH = window.innerHeight;
  selectionPhase = false;
  selStart = null;
  selCurrent = null;
  canvas.style.cursor = "default";
  toolbar.classList.add("visible");
  render();
}

function renderAnnotation(a) {
  ctx.save();
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.strokeWidth || currentWidth;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  switch (a.type) {
    case "circle":
      ctx.beginPath();
      ctx.ellipse(
        a.cx,
        a.cy,
        Math.abs(a.rx),
        Math.abs(a.ry),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;

    case "rect":
      ctx.strokeRect(a.x, a.y, a.width, a.height);
      // Subtle fill
      ctx.fillStyle = a.color + "1A"; // 10% opacity
      ctx.fillRect(a.x, a.y, a.width, a.height);
      break;

    case "arrow":
      drawArrow(a.fromX, a.fromY, a.toX, a.toY, a.color, a.strokeWidth);
      break;

    case "freehand":
      if (a.points.length < 2) break;
      ctx.beginPath();
      ctx.moveTo(a.points[0].x, a.points[0].y);
      // Smooth the path with quadratic curves for a buttery feel
      for (let i = 1; i < a.points.length - 1; i++) {
        const midX = (a.points[i].x + a.points[i + 1].x) / 2;
        const midY = (a.points[i].y + a.points[i + 1].y) / 2;
        ctx.quadraticCurveTo(a.points[i].x, a.points[i].y, midX, midY);
      }
      // Last point
      const last = a.points[a.points.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      break;

    case "text":
      const fontSize = a.fontSize || 16;
      ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      // Dark outline for readability on any background
      ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.strokeText(a.content, a.x, a.y);
      ctx.fillText(a.content, a.x, a.y);
      break;

    case "marker":
      const r = a.radius || 16;
      // Shadow for depth
      ctx.shadowColor = "rgba(0,0,0,0.4)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = "transparent";
      // White number
      ctx.fillStyle = "#FFFFFF";
      ctx.font = `bold ${r}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(a.number), a.x, a.y);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
      break;
  }

  ctx.restore();
}

function drawArrowOn(c, fromX, fromY, toX, toY, color, width) {
  const headLen = 12 + width;
  const angle = Math.atan2(toY - fromY, toX - fromX);
  c.strokeStyle = color;
  c.lineWidth = width;
  c.beginPath();
  c.moveTo(fromX, fromY);
  c.lineTo(toX, toY);
  c.stroke();
  c.fillStyle = color;
  c.beginPath();
  c.moveTo(toX, toY);
  c.lineTo(
    toX - headLen * Math.cos(angle - Math.PI / 6),
    toY - headLen * Math.sin(angle - Math.PI / 6),
  );
  c.lineTo(
    toX - headLen * Math.cos(angle + Math.PI / 6),
    toY - headLen * Math.sin(angle + Math.PI / 6),
  );
  c.closePath();
  c.fill();
}

function drawArrow(fromX, fromY, toX, toY, color, width) {
  const headLen = 12 + width;
  const angle = Math.atan2(toY - fromY, toX - fromX);

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();

  // Arrowhead
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(
    toX - headLen * Math.cos(angle - Math.PI / 6),
    toY - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    toX - headLen * Math.cos(angle + Math.PI / 6),
    toY - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

// ----- Mouse events -----
canvas.addEventListener("mousedown", (e) => {
  if (e.target !== canvas) return;
  const x = e.offsetX;
  const y = e.offsetY;

  if (selectionPhase) {
    selStart = { x, y };
    selCurrent = { x, y };
    return;
  }

  if (currentTool === "text") {
    showTextInput(x, y);
    return;
  }

  if (currentTool === "marker") {
    annotations.push({
      type: "marker",
      x,
      y,
      number: markerCounter++,
      color: currentColor,
      radius: 16,
    });
    render();
    return;
  }

  isDrawing = true;
  drawStart = { x, y };

  if (currentTool === "freehand") {
    freehandPoints = [{ x, y }];
  }
});

canvas.addEventListener("mousemove", (e) => {
  if (selectionPhase) {
    if (selStart) {
      selCurrent = { x: e.offsetX, y: e.offsetY };
      render();
    }
    return;
  }
  if (!isDrawing) return;
  const x = e.offsetX;
  const y = e.offsetY;

  if (currentTool === "freehand") {
    freehandPoints.push({ x, y });
    // Live preview
    render();
    ctx.save();
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(freehandPoints[0].x, freehandPoints[0].y);
    for (let i = 1; i < freehandPoints.length - 1; i++) {
      const midX = (freehandPoints[i].x + freehandPoints[i + 1].x) / 2;
      const midY = (freehandPoints[i].y + freehandPoints[i + 1].y) / 2;
      ctx.quadraticCurveTo(
        freehandPoints[i].x,
        freehandPoints[i].y,
        midX,
        midY,
      );
    }
    const last = freehandPoints[freehandPoints.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Live preview for shape tools
  render();
  ctx.save();
  ctx.strokeStyle = currentColor;
  ctx.lineWidth = currentWidth;

  if (currentTool === "circle") {
    const rx = Math.abs(x - drawStart.x) / 2;
    const ry = e.shiftKey ? rx : Math.abs(y - drawStart.y) / 2;
    const cx = drawStart.x + (x - drawStart.x) / 2;
    const cy = drawStart.y + (y - drawStart.y) / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else if (currentTool === "rect") {
    let w = x - drawStart.x;
    let h = e.shiftKey ? w : y - drawStart.y;
    ctx.strokeRect(drawStart.x, drawStart.y, w, h);
    // Preview fill
    ctx.fillStyle = currentColor + "1A";
    ctx.fillRect(drawStart.x, drawStart.y, w, h);
  } else if (currentTool === "arrow") {
    drawArrow(drawStart.x, drawStart.y, x, y, currentColor, currentWidth);
  }

  ctx.restore();
});

canvas.addEventListener("mouseup", (e) => {
  if (selectionPhase) {
    if (selStart) {
      const r = selNormalized();
      if (r.w > 10 && r.h > 10) {
        commitSelection(r.x, r.y, r.w, r.h);
      } else {
        selStart = null;
        selCurrent = null;
        render();
      }
    }
    return;
  }
  if (!isDrawing) return;
  isDrawing = false;

  const x = e.offsetX;
  const y = e.offsetY;

  if (currentTool === "circle") {
    const rx = Math.abs(x - drawStart.x) / 2;
    const ry = e.shiftKey ? rx : Math.abs(y - drawStart.y) / 2;
    const cx = drawStart.x + (x - drawStart.x) / 2;
    const cy = drawStart.y + (y - drawStart.y) / 2;
    if (rx > 2 || ry > 2) {
      annotations.push({
        type: "circle",
        cx,
        cy,
        rx,
        ry,
        color: currentColor,
        strokeWidth: currentWidth,
      });
    }
  } else if (currentTool === "rect") {
    let w = x - drawStart.x;
    let h = e.shiftKey ? w : y - drawStart.y;
    if (Math.abs(w) > 2 || Math.abs(h) > 2) {
      annotations.push({
        type: "rect",
        x: drawStart.x,
        y: drawStart.y,
        width: w,
        height: h,
        color: currentColor,
        strokeWidth: currentWidth,
      });
    }
  } else if (currentTool === "arrow") {
    const dist = Math.hypot(x - drawStart.x, y - drawStart.y);
    if (dist > 5) {
      annotations.push({
        type: "arrow",
        fromX: drawStart.x,
        fromY: drawStart.y,
        toX: x,
        toY: y,
        color: currentColor,
        strokeWidth: currentWidth,
      });
    }
  } else if (currentTool === "freehand") {
    if (freehandPoints.length > 2) {
      // Simplify the path — keep every Nth point for smoother storage
      const simplified = simplifyPoints(freehandPoints, 2);
      annotations.push({
        type: "freehand",
        points: simplified,
        color: currentColor,
        strokeWidth: currentWidth,
      });
    }
    freehandPoints = [];
  }

  drawStart = null;
  render();
});

// Point simplification — reduces density while keeping shape
function simplifyPoints(points, tolerance) {
  if (points.length < 3) return [...points];
  const result = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const dist = Math.hypot(points[i].x - prev.x, points[i].y - prev.y);
    if (dist >= tolerance) {
      result.push(points[i]);
    }
  }
  result.push(points[points.length - 1]);
  return result;
}

// ----- Text input -----
function showTextInput(x, y) {
  textInput.style.display = "block";
  textInput.style.left = x + "px";
  textInput.style.top = y + "px";
  textInput.style.color = currentColor;
  textInput.value = "";
  textInput.focus();

  textInput._x = x;
  textInput._y = y;
}

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const content = textInput.value.trim();
    if (content) {
      annotations.push({
        type: "text",
        x: textInput._x,
        y: textInput._y + 16, // offset for baseline
        content,
        color: currentColor,
        fontSize: 16,
      });
    }
    textInput.style.display = "none";
    textInput.value = "";
    render();
    e.stopPropagation();
  } else if (e.key === "Escape") {
    textInput.style.display = "none";
    textInput.value = "";
    e.stopPropagation();
  }
});

// ----- Toolbar events -----
document.querySelectorAll(".tool-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".tool-btn")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentTool = btn.dataset.tool;
  });
});

document.querySelectorAll(".color-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".color-btn")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentColor = btn.dataset.color;
  });
});

document.querySelectorAll(".width-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".width-btn")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentWidth = parseInt(btn.dataset.width);
  });
});

document.getElementById("btn-dim").addEventListener("click", () => {
  dimActive = !dimActive;
  document.getElementById("btn-dim").classList.toggle("active", dimActive);
  render();
});

document.getElementById("btn-undo").addEventListener("click", undo);
document.getElementById("btn-clear").addEventListener("click", clearAll);
document.getElementById("btn-save").addEventListener("click", save);

// ----- Toolbar dragging -----
let toolbarDragging = false;
let toolbarOffset = { x: 0, y: 0 };

document.getElementById("toolbar-drag").addEventListener("mousedown", (e) => {
  toolbarDragging = true;
  const rect = toolbar.getBoundingClientRect();
  toolbarOffset.x = e.clientX - rect.left;
  toolbarOffset.y = e.clientY - rect.top;
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener("mousemove", (e) => {
  if (!toolbarDragging) return;
  let newX = e.clientX - toolbarOffset.x;
  let newY = e.clientY - toolbarOffset.y;
  // Keep within viewport
  const tRect = toolbar.getBoundingClientRect();
  newX = Math.max(0, Math.min(newX, window.innerWidth - tRect.width));
  newY = Math.max(0, Math.min(newY, window.innerHeight - tRect.height));
  toolbar.style.left = newX + "px";
  toolbar.style.top = newY + "px";
  toolbar.style.transform = "none";
});

document.addEventListener("mouseup", () => {
  toolbarDragging = false;
});

// ----- Keyboard shortcuts -----
document.addEventListener("keydown", (e) => {
  // Ignore if typing in text input
  if (textInput.style.display === "block") return;

  switch (e.key) {
    case "Enter":
      e.preventDefault();
      save();
      return;
    case "Escape":
      if (isDrawing) {
        isDrawing = false;
        drawStart = null;
        freehandPoints = [];
        render();
      } else {
        closeOverlay();
      }
      return;
  }

  switch (e.key.toLowerCase()) {
    case "c":
      selectTool("circle");
      break;
    case "r":
      selectTool("rect");
      break;
    case "a":
      selectTool("arrow");
      break;
    case "f":
      selectTool("freehand");
      break;
    case "t":
      selectTool("text");
      break;
    case "n":
      selectTool("marker");
      break;
    case "d":
      dimActive = !dimActive;
      document.getElementById("btn-dim").classList.toggle("active", dimActive);
      render();
      break;
    case "z":
      if (e.ctrlKey || e.metaKey) {
        undo();
        e.preventDefault();
      }
      break;
    // enter and escape handled above
  }
});

function selectTool(tool) {
  currentTool = tool;
  document.querySelectorAll(".tool-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === tool);
  });
}

// ----- Actions -----
function undo() {
  if (annotations.length > 0) {
    const removed = annotations.pop();
    if (removed.type === "marker") {
      markerCounter = Math.max(1, markerCounter - 1);
    }
    render();
  }
}

function clearAll() {
  annotations = [];
  markerCounter = 1;
  render();
}

async function closeOverlay() {
  // Tell the Rust backend the overlay is no longer active
  try {
    await invoke("mark_overlay_closed");
  } catch (_) {}

  // Windows: always single-shot — destroy the overlay window after each use.
  await getCurrentWindow().destroy();
}

async function save() {
  if (isSaving) return;
  isSaving = true;

  // Visual feedback — flash the save button
  const saveBtn = document.getElementById("btn-save");
  saveBtn.classList.add("saving");

  // Build sidecar metadata
  const metadata = {
    timestamp: new Date().toISOString(),
    source: {
      window_title: windowContext?.window_title || null,
      url: windowContext?.url || null,
      window_class: windowContext?.window_class || null,
      pid: windowContext?.pid || null,
      display: "primary",
      resolution: [window.screen.width, window.screen.height],
    },
    annotations: annotations.map((a) => {
      switch (a.type) {
        case "circle":
          return {
            type: "circle",
            center: [a.cx, a.cy],
            radius: [a.rx, a.ry],
            color: a.color,
            label: null,
          };
        case "rect":
          return {
            type: "rect",
            position: [a.x, a.y],
            size: [a.width, a.height],
            color: a.color,
            label: null,
          };
        case "arrow":
          return {
            type: "arrow",
            from: [a.fromX, a.fromY],
            to: [a.toX, a.toY],
            color: a.color,
            label: null,
          };
        case "freehand":
          return {
            type: "freehand",
            points: a.points,
            color: a.color,
            label: null,
          };
        case "text":
          return {
            type: "text",
            position: [a.x, a.y],
            content: a.content,
            color: a.color,
          };
        case "marker":
          return {
            type: "marker",
            position: [a.x, a.y],
            number: a.number,
            color: a.color,
          };
        default:
          return a;
      }
    }),
  };

  // Export annotated image:
  // 1. Read the raw capture file as bytes via Rust (avoids tainted canvas issue)
  // 2. Draw it onto a fresh offscreen canvas
  // 3. Draw annotations on top
  // 4. Export as base64 at native capture resolution
  let imageBase64 = null;
  if (annotations.length > 0) {
    try {
      // Load the capture as a clean data URL to avoid canvas tainting
      const captureBase64 = await invoke("read_capture_base64");
      const cleanImg = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = "data:image/png;base64," + captureBase64;
      });

      const previewW = backgroundImage.naturalWidth;
      const previewH = backgroundImage.naturalHeight;
      const nativeW = cleanImg.naturalWidth;
      const nativeH = cleanImg.naturalHeight;

      const nativeCrop = cropSrc
        ? mapCropToNative(cropSrc, {
            previewWidth: previewW,
            previewHeight: previewH,
            nativeWidth: nativeW,
            nativeHeight: nativeH,
          })
        : null;

      const exportCanvas = document.createElement("canvas");
      const exportW = nativeCrop ? nativeCrop.w : nativeW;
      const exportH = nativeCrop ? nativeCrop.h : nativeH;
      exportCanvas.width = exportW;
      exportCanvas.height = exportH;
      const ectx = exportCanvas.getContext("2d");

      if (nativeCrop) {
        ectx.drawImage(
          cleanImg,
          nativeCrop.x,
          nativeCrop.y,
          nativeCrop.w,
          nativeCrop.h,
          0,
          0,
          exportW,
          exportH,
        );
      } else {
        ectx.drawImage(cleanImg, 0, 0);
      }

      const nativeScaleX = exportW / window.innerWidth;
      const nativeScaleY = exportH / window.innerHeight;
      ectx.save();
      ectx.setTransform(nativeScaleX, 0, 0, nativeScaleY, 0, 0);
      ectx.beginPath();
      ectx.rect(0, 0, window.innerWidth, window.innerHeight);
      ectx.clip();

      // Draw annotations
      for (const a of annotations) {
        ectx.save();
        ectx.strokeStyle = a.color;
        ectx.fillStyle = a.color;
        ectx.lineWidth = a.strokeWidth || currentWidth;
        ectx.lineCap = "round";
        ectx.lineJoin = "round";
        switch (a.type) {
          case "circle":
            ectx.beginPath();
            ectx.ellipse(
              a.cx,
              a.cy,
              Math.abs(a.rx),
              Math.abs(a.ry),
              0,
              0,
              Math.PI * 2,
            );
            ectx.stroke();
            break;
          case "rect":
            ectx.strokeRect(a.x, a.y, a.width, a.height);
            ectx.fillStyle = a.color + "1A";
            ectx.fillRect(a.x, a.y, a.width, a.height);
            break;
          case "arrow":
            drawArrowOn(
              ectx,
              a.fromX,
              a.fromY,
              a.toX,
              a.toY,
              a.color,
              a.strokeWidth,
            );
            break;
          case "freehand":
            if (a.points.length >= 2) {
              ectx.beginPath();
              ectx.moveTo(a.points[0].x, a.points[0].y);
              for (let i = 1; i < a.points.length - 1; i++) {
                const midX = (a.points[i].x + a.points[i + 1].x) / 2;
                const midY = (a.points[i].y + a.points[i + 1].y) / 2;
                ectx.quadraticCurveTo(a.points[i].x, a.points[i].y, midX, midY);
              }
              ectx.lineTo(
                a.points[a.points.length - 1].x,
                a.points[a.points.length - 1].y,
              );
              ectx.stroke();
            }
            break;
          case "text":
            ectx.font = `bold ${a.fontSize || 16}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
            ectx.strokeStyle = "rgba(0,0,0,0.8)";
            ectx.lineWidth = 3;
            ectx.lineJoin = "round";
            ectx.strokeText(a.content, a.x, a.y);
            ectx.fillText(a.content, a.x, a.y);
            break;
          case "marker":
            const r = a.radius || 16;
            ectx.beginPath();
            ectx.arc(a.x, a.y, r, 0, Math.PI * 2);
            ectx.fill();
            ectx.fillStyle = "#FFFFFF";
            ectx.font = `bold ${r}px sans-serif`;
            ectx.textAlign = "center";
            ectx.textBaseline = "middle";
            ectx.fillText(String(a.number), a.x, a.y);
            break;
        }
        ectx.restore();
      }
      ectx.restore();
      const dataUrl = exportCanvas.toDataURL("image/png");
      imageBase64 = dataUrl.split(",")[1];
    } catch (e) {
      // Canvas export failed — fall through to save raw capture
    }
  }

  try {
    await invoke("save_annotation", {
      metadataJson: JSON.stringify(metadata, null, 2),
      imageBase64: imageBase64,
    });
  } catch (e) {
    console.error("Save failed:", e);
    isSaving = false;
    saveBtn.classList.remove("saving");
    ctx.save();
    ctx.fillStyle = "rgba(255, 59, 48, 0.9)";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(
      "Save failed: " + e,
      window.innerWidth / 2,
      window.innerHeight - 40,
    );
    ctx.restore();
    return;
  }

  await closeOverlay();
}

// ----- Boot -----
init();
