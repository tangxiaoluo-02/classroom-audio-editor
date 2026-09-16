import { SoundTouch, SimpleFilter, WebAudioBufferSource } from "./vendor/soundtouch.min.js";

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const UNDO_LIMIT = 5;
const OPTIMIZE_SAMPLE_RATE = 22050;

const state = {
  buffer: null,
  sampleRate: null,
  undoStack: [],
  fileBaseName: "錄音",
  region: null,
};

let ws = null;
let regionsPlugin = null;
const zoomState = { fit: 20, max: 400, current: null };
// A tap on empty waveform (meant to preview a spot) still crosses the regions
// plugin's internal drag threshold on a touchscreen, so it always produces a
// "region". We can't tell a tap from a real selection until the finger lifts,
// so we track the newest not-yet-confirmed region and only decide on pointerup.
let pendingNewRegion = null;

const el = (id) => document.getElementById(id);
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return `${m}:${sec}`;
};

function toast(msg, ms = 2200) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove("show"), ms);
}

function showProgress(msg) {
  el("progressOverlay").classList.add("show");
  el("progressMsg").textContent = msg;
  setProgressPct(0);
}
function setProgressPct(pct) {
  el("progressBarFill").style.width = Math.round(pct * 100) + "%";
}
function hideProgress() {
  el("progressOverlay").classList.remove("show");
}
async function yieldToUI() {
  await new Promise((r) => setTimeout(r, 0));
}

/* ---------------- Audio buffer helpers ---------------- */

function downmixToMono(buffer) {
  if (buffer.numberOfChannels === 1) return buffer;
  const out = audioCtx.createBuffer(1, buffer.length, buffer.sampleRate);
  const outData = out.getChannelData(0);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const chData = buffer.getChannelData(ch);
    for (let i = 0; i < chData.length; i++) outData[i] += chData[i] / buffer.numberOfChannels;
  }
  return out;
}

async function resampleBuffer(buffer, targetRate) {
  if (Math.round(buffer.sampleRate) === Math.round(targetRate)) return buffer;
  const offline = new OfflineAudioContext(1, Math.ceil(buffer.duration * targetRate), targetRate);
  const src = offline.createBufferSource();
  src.buffer = buffer;
  src.connect(offline.destination);
  src.start();
  return await offline.startRendering();
}

function cloneMonoBuffer(buffer) {
  const out = audioCtx.createBuffer(1, buffer.length, buffer.sampleRate);
  out.getChannelData(0).set(buffer.getChannelData(0));
  return out;
}

function bufferFromFloat32(samples, sampleRate) {
  const out = audioCtx.createBuffer(1, samples.length, sampleRate);
  out.getChannelData(0).set(samples);
  return out;
}

function encodeWavMono(buffer) {
  const samples = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const dataSize = samples.length * 2;
  const bufOut = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bufOut);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view], { type: "audio/wav" });
}

function encodeMp3Mono(buffer, kbps = 128) {
  const samples = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const int16 = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const encoder = new lamejs.Mp3Encoder(1, sampleRate, kbps);
  const blockSize = 1152;
  const chunks = [];
  for (let i = 0; i < int16.length; i += blockSize) {
    const chunk = int16.subarray(i, i + blockSize);
    const mp3buf = encoder.encodeBuffer(chunk);
    if (mp3buf.length > 0) chunks.push(mp3buf);
  }
  const end = encoder.flush();
  if (end.length > 0) chunks.push(end);
  return new Blob(chunks, { type: "audio/mpeg" });
}

/* ---------------- Editing ops ---------------- */

function deleteRange(buffer, s, e) {
  const data = buffer.getChannelData(0);
  const out = audioCtx.createBuffer(1, data.length - (e - s), buffer.sampleRate);
  const outData = out.getChannelData(0);
  outData.set(data.subarray(0, s), 0);
  outData.set(data.subarray(e), s);
  return out;
}

function keepRange(buffer, s, e) {
  const data = buffer.getChannelData(0);
  const out = audioCtx.createBuffer(1, e - s, buffer.sampleRate);
  out.getChannelData(0).set(data.subarray(s, e));
  return out;
}

function applyFade(buffer, s, e, type) {
  const out = cloneMonoBuffer(buffer);
  const data = out.getChannelData(0);
  const len = e - s;
  if (len <= 0) return out;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const g = type === "in" ? Math.sin((t * Math.PI) / 2) : Math.cos((t * Math.PI) / 2);
    data[s + i] *= g;
  }
  return out;
}

function spliceInsert(buffer, insertBuffer, atSample) {
  const data = buffer.getChannelData(0);
  const insData = insertBuffer.getChannelData(0);
  const out = audioCtx.createBuffer(1, data.length + insData.length, buffer.sampleRate);
  const outData = out.getChannelData(0);
  outData.set(data.subarray(0, atSample), 0);
  outData.set(insData, atSample);
  outData.set(data.subarray(atSample), atSample + insData.length);
  return out;
}

async function processSoundTouch(buffer, { tempo = 1, semitones = 0 }, onProgress) {
  const stereo = audioCtx.createBuffer(2, buffer.length, buffer.sampleRate);
  stereo.copyToChannel(buffer.getChannelData(0), 0);
  stereo.copyToChannel(buffer.getChannelData(0), 1);

  const st = new SoundTouch();
  st.tempo = tempo;
  st.pitchSemitones = semitones;

  const source = new WebAudioBufferSource(stereo);
  const filter = new SimpleFilter(source, st);

  const BUF = 4096;
  const tmp = new Float32Array(BUF * 2);
  const chunks = [];
  let framesTotal = 0;
  let n;
  let iter = 0;
  const estimatedInFrames = buffer.length;
  do {
    n = filter.extract(tmp, BUF);
    if (n > 0) {
      chunks.push(tmp.slice(0, n * 2));
      framesTotal += n;
    }
    iter++;
    if (iter % 40 === 0) {
      if (onProgress) onProgress(Math.min(0.95, (source.position || 0) / estimatedInFrames));
      await yieldToUI();
    }
  } while (n > 0);

  const outMono = new Float32Array(framesTotal);
  let idx = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 2) outMono[idx++] = chunk[i];
  }
  return bufferFromFloat32(outMono, buffer.sampleRate);
}

/* ---------------- Waveform / state sync ---------------- */

function setCurrentBuffer(buf, { pushUndo = true } = {}) {
  if (pushUndo && state.buffer) {
    state.undoStack.push(state.buffer);
    if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
  }
  state.buffer = buf;
  state.region = null;
  updateUndoBtn();
  updateSelectionUI();
  renderWaveform();
}

function renderWaveform() {
  const blob = encodeWavMono(state.buffer);
  const url = URL.createObjectURL(blob);
  ws.load(url).then(() => {
    updateTimeUI();
    applyZoomBounds();
  });
}

function applyZoomBounds() {
  const containerWidth = el("waveform").clientWidth || 300;
  const dur = state.buffer.duration || 1;
  const fit = Math.max(5, containerWidth / dur);
  zoomState.fit = fit;
  zoomState.max = Math.max(fit * 3, 400);
  if (zoomState.current == null || zoomState.current < fit) zoomState.current = fit;
  if (zoomState.current > zoomState.max) zoomState.current = zoomState.max;
  ws.zoom(zoomState.current);
  syncZoomUI();
}

function syncZoomUI() {
  const slider = el("zoomSlider");
  slider.min = String(zoomState.fit);
  slider.max = String(zoomState.max);
  slider.step = String(Math.max(0.5, (zoomState.max - zoomState.fit) / 200));
  slider.value = String(zoomState.current);
  const ratio = zoomState.current / zoomState.fit;
  el("zoomLabel").textContent = ratio <= 1.02 ? "完整" : ratio.toFixed(1) + "×";
}

function setZoom(pxPerSec) {
  zoomState.current = Math.min(zoomState.max, Math.max(zoomState.fit, pxPerSec));
  ws.zoom(zoomState.current);
  syncZoomUI();
}

function updateUndoBtn() {
  el("undoBtn").disabled = state.undoStack.length === 0;
}

function updateSelectionUI() {
  const hasSel = !!state.region;
  el("selHint").hidden = hasSel;
  el("selPanel").hidden = !hasSel;
  if (hasSel) {
    const s = state.region.start, e = state.region.end;
    el("selStartTime").textContent = fmtTime(s);
    el("selEndTime").textContent = fmtTime(e);
    el("selDuration").textContent = "長度 " + fmtTime(e - s);
  }
  el("btnDelete").disabled = !hasSel;
  el("btnKeep").disabled = !hasSel;
}

function nudgeSelectionEdge(edge, delta) {
  if (!state.region || !state.buffer) return;
  const r = state.region.wsRegion;
  const MIN_GAP = 0.05;
  if (edge === "start") {
    const next = Math.max(0, Math.min(r.end - MIN_GAP, r.start + delta));
    r.setOptions({ start: next });
  } else {
    const next = Math.min(state.buffer.duration, Math.max(r.start + MIN_GAP, r.end + delta));
    r.setOptions({ end: next });
  }
  state.region = { start: r.start, end: r.end, wsRegion: r };
  updateSelectionUI();
}

function previewSelectionEdge(edge) {
  if (!state.region || !state.buffer) return;
  const t = edge === "start" ? state.region.start : state.region.end;
  const from = Math.max(0, t - 0.4);
  const to = Math.min(state.buffer.duration, t + 0.4);
  ws.play(from, to);
}

el("selPanel").addEventListener("click", (e) => {
  const nudgeBtn = e.target.closest(".nudge-btn");
  if (nudgeBtn) {
    const edge = nudgeBtn.closest(".sel-nudge-row").dataset.edge;
    nudgeSelectionEdge(edge, parseFloat(nudgeBtn.dataset.delta));
    return;
  }
  const previewBtn = e.target.closest(".sel-preview-btn");
  if (previewBtn) {
    previewSelectionEdge(previewBtn.dataset.edge);
    return;
  }
  if (e.target.closest("#clearSelBtn")) {
    if (state.region && state.region.wsRegion) state.region.wsRegion.remove();
    state.region = null;
    updateSelectionUI();
  }
});

function updateTimeUI() {
  el("curTime").textContent = fmtTime(ws.getCurrentTime());
  el("totalTime").textContent = fmtTime(ws.getDuration());
}

function selSamples() {
  if (!state.region) return null;
  const sr = state.buffer.sampleRate;
  return {
    s: Math.max(0, Math.round(state.region.start * sr)),
    e: Math.min(state.buffer.length, Math.round(state.region.end * sr)),
  };
}

/* ---------------- Init waveform ---------------- */

function initWavesurfer() {
  ws = WaveSurfer.create({
    container: "#waveform",
    waveColor: getComputedStyle(document.documentElement).getPropertyValue("--wave-color").trim(),
    progressColor: getComputedStyle(document.documentElement).getPropertyValue("--wave-progress").trim(),
    cursorColor: getComputedStyle(document.documentElement).getPropertyValue("--wave-cursor").trim(),
    height: 110,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    normalize: true,
  });
  regionsPlugin = WaveSurfer.Regions.create();
  ws.registerPlugin(regionsPlugin);
  regionsPlugin.enableDragSelection({ color: "rgba(242,166,90,0.28)" });

  const tapToleranceSec = () => 12 / (zoomState.current || zoomState.fit || 20);

  regionsPlugin.on("region-created", (r) => {
    pendingNewRegion = r;
  });
  regionsPlugin.on("region-updated", (r) => {
    if (state.region && state.region.wsRegion === r) {
      // resizing/moving an already-confirmed selection: always honor it as-is
      state.region = { start: r.start, end: r.end, wsRegion: r };
      updateSelectionUI();
    }
  });
  regionsPlugin.on("region-clicked", (r, e) => {
    e.stopPropagation();
    ws.setTime(r.start);
  });
  regionsPlugin.on("region-removed", (r) => {
    if (pendingNewRegion === r) pendingNewRegion = null;
    if (state.region && state.region.wsRegion === r) {
      state.region = null;
      updateSelectionUI();
    }
  });
  document.addEventListener("pointerup", () => {
    const r = pendingNewRegion;
    pendingNewRegion = null;
    if (!r || r.isRemoved) return;
    if (r.end - r.start < tapToleranceSec()) {
      r.remove();
      ws.setTime(r.start);
      return;
    }
    regionsPlugin.getRegions().forEach((other) => { if (other !== r) other.remove(); });
    state.region = { start: r.start, end: r.end, wsRegion: r };
    updateSelectionUI();
  });

  ws.on("timeupdate", updateTimeUI);
  ws.on("play", () => { el("playBtn").textContent = "⏸"; });
  ws.on("pause", () => { el("playBtn").textContent = "▶"; });
  ws.on("finish", () => { el("playBtn").textContent = "▶"; });

  setupEdgeAutoScroll();
}

// When a drag (new selection or resizing an edge) reaches near the left/right
// edge of the waveform while zoomed in, keep scrolling that direction AND keep
// growing the region ourselves. The regions plugin only recomputes a region's
// bounds from genuine pointermove deltas — a finger held still at the edge
// while we scroll underneath it never fires those, so the plugin never sees
// the extension unless we apply it directly.
function setupEdgeAutoScroll() {
  const EDGE_MARGIN = 44;
  const MAX_SPEED = 18;
  let dragging = false;
  let lastX = null;
  let rafId = null;

  function timeAtClientX(clientX) {
    const rect = el("waveform").getBoundingClientRect();
    const pxPerSec = zoomState.current || zoomState.fit || 20;
    const t = (ws.getScroll() + (clientX - rect.left)) / pxPerSec;
    return Math.max(0, Math.min(state.buffer ? state.buffer.duration : t, t));
  }

  function growActiveRegion(edgeSign, clientX) {
    const region = pendingNewRegion || (state.region && state.region.wsRegion);
    if (!region || region.isRemoved) return;
    const t = timeAtClientX(clientX);
    if (edgeSign > 0) {
      region.setOptions({ end: Math.max(t, region.start + 0.05) });
    } else {
      region.setOptions({ start: Math.min(t, region.end - 0.05) });
    }
    if (state.region && state.region.wsRegion === region) {
      state.region = { start: region.start, end: region.end, wsRegion: region };
      updateSelectionUI();
    }
  }

  function loop() {
    if (!dragging) { rafId = null; return; }
    const rect = el("waveform").getBoundingClientRect();
    if (lastX != null) {
      let edgeSign = 0;
      let depth = 0;
      if (lastX < rect.left + EDGE_MARGIN) {
        edgeSign = -1;
        depth = Math.min(1, (rect.left + EDGE_MARGIN - lastX) / EDGE_MARGIN);
      } else if (lastX > rect.right - EDGE_MARGIN) {
        edgeSign = 1;
        depth = Math.min(1, (lastX - (rect.right - EDGE_MARGIN)) / EDGE_MARGIN);
      }
      if (edgeSign !== 0) {
        ws.setScroll(ws.getScroll() + edgeSign * depth * MAX_SPEED);
        growActiveRegion(edgeSign, lastX);
      }
    }
    rafId = requestAnimationFrame(loop);
  }

  el("waveform").addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    if (!rafId) rafId = requestAnimationFrame(loop);
  });
  document.addEventListener("pointermove", (e) => {
    if (dragging) lastX = e.clientX;
  });
  document.addEventListener("pointerup", () => { dragging = false; lastX = null; });
  document.addEventListener("pointercancel", () => { dragging = false; lastX = null; });
}

/* ---------------- Import ---------------- */

async function loadFile(file, { asInsert = false } = {}) {
  const arrayBuffer = await file.arrayBuffer();
  const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await tmpCtx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    tmpCtx.close();
  }
  let mono = downmixToMono(decoded);
  if (!asInsert && el("optimizeToggle").checked) {
    mono = await resampleBuffer(mono, OPTIMIZE_SAMPLE_RATE);
  } else if (asInsert && state.buffer) {
    mono = await resampleBuffer(mono, state.buffer.sampleRate);
  }
  return mono;
}

el("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showProgress("讀取音檔中…");
  try {
    const mono = await loadFile(file);
    state.fileBaseName = file.name.replace(/\.[^.]+$/, "") || "錄音";
    state.buffer = mono;
    state.undoStack = [];
    state.region = null;
    zoomState.current = null;
    el("importScreen").classList.add("hidden");
    el("editorScreen").classList.add("active");
    el("title").textContent = state.fileBaseName;
    updateUndoBtn();
    updateSelectionUI();
    renderWaveform();
    maybeShowInstallBanner();
  } catch (err) {
    console.error(err);
    toast("讀取失敗，請確認是有效的音檔格式");
  } finally {
    hideProgress();
    e.target.value = "";
  }
});

/* ---------------- Transport ---------------- */

el("playBtn").addEventListener("click", () => ws.playPause());
el("backBtn").addEventListener("click", () => ws.setTime(Math.max(0, ws.getCurrentTime() - 5)));
el("fwdBtn").addEventListener("click", () => ws.setTime(Math.min(ws.getDuration(), ws.getCurrentTime() + 5)));

/* ---------------- Zoom ---------------- */

el("zoomSlider").addEventListener("input", (e) => setZoom(parseFloat(e.target.value)));
el("zoomOutBtn").addEventListener("click", () => setZoom(zoomState.current / 1.6));
el("zoomInBtn").addEventListener("click", () => setZoom(zoomState.current * 1.6));

/* ---------------- Undo ---------------- */

el("undoBtn").addEventListener("click", () => {
  if (state.undoStack.length === 0) return;
  const prev = state.undoStack.pop();
  state.buffer = prev;
  state.region = null;
  updateUndoBtn();
  updateSelectionUI();
  renderWaveform();
  toast("已復原上一步");
});

/* ---------------- Delete / Keep ---------------- */

el("btnDelete").addEventListener("click", () => {
  const sel = selSamples();
  if (!sel) return;
  setCurrentBuffer(deleteRange(state.buffer, sel.s, sel.e));
  toast("已刪除選取片段");
});

el("btnKeep").addEventListener("click", () => {
  const sel = selSamples();
  if (!sel) return;
  setCurrentBuffer(keepRange(state.buffer, sel.s, sel.e));
  toast("已保留選取片段");
});

/* ---------------- Fade ---------------- */

function doFade(type) {
  const sr = state.buffer.sampleRate;
  let s, e;
  const sel = selSamples();
  if (sel) {
    s = sel.s; e = sel.e;
  } else if (type === "in") {
    s = 0; e = Math.min(state.buffer.length, Math.round(3 * sr));
  } else {
    e = state.buffer.length; s = Math.max(0, e - Math.round(3 * sr));
  }
  setCurrentBuffer(applyFade(state.buffer, s, e, type));
  toast(type === "in" ? "已套用淡入" : "已套用淡出");
}
el("btnFadeIn").addEventListener("click", () => doFade("in"));
el("btnFadeOut").addEventListener("click", () => doFade("out"));

/* ---------------- Sheets (generic) ---------------- */

function openSheet(id) {
  el("sheetBackdrop").classList.add("open");
  el(id).classList.add("open");
}
function closeSheets() {
  el("sheetBackdrop").classList.remove("open");
  document.querySelectorAll(".sheet.open").forEach((s) => s.classList.remove("open"));
}
el("sheetBackdrop").addEventListener("click", closeSheets);
document.querySelectorAll("[data-close-sheet]").forEach((b) => b.addEventListener("click", closeSheets));

/* ---------------- Speed sheet ---------------- */

el("btnSpeed").addEventListener("click", () => {
  el("speedSlider").value = 100;
  el("speedVal").textContent = "1.00×";
  openSheet("speedSheet");
});
el("speedSlider").addEventListener("input", (e) => {
  el("speedVal").textContent = (e.target.value / 100).toFixed(2) + "×";
});
el("speedConfirm").addEventListener("click", async () => {
  const tempo = el("speedSlider").value / 100;
  closeSheets();
  showProgress("處理變速中…");
  try {
    const out = await processSoundTouch(state.buffer, { tempo, semitones: 0 }, setProgressPct);
    setCurrentBuffer(out);
    toast(`已調整速度為 ${tempo.toFixed(2)}×`);
  } catch (err) {
    console.error(err);
    toast("變速處理失敗");
  } finally {
    hideProgress();
  }
});

/* ---------------- Pitch sheet ---------------- */

el("btnPitch").addEventListener("click", () => {
  el("pitchSlider").value = 0;
  el("pitchVal").textContent = "0";
  openSheet("pitchSheet");
});
el("pitchSlider").addEventListener("input", (e) => {
  const v = parseInt(e.target.value, 10);
  el("pitchVal").textContent = (v > 0 ? "+" : "") + v;
});
el("pitchConfirm").addEventListener("click", async () => {
  const semitones = parseInt(el("pitchSlider").value, 10);
  closeSheets();
  showProgress("處理變調中…");
  try {
    const out = await processSoundTouch(state.buffer, { tempo: 1, semitones }, setProgressPct);
    setCurrentBuffer(out);
    toast(`已調整 Key ${semitones > 0 ? "+" : ""}${semitones} 半音`);
  } catch (err) {
    console.error(err);
    toast("變調處理失敗");
  } finally {
    hideProgress();
  }
});

/* ---------------- Merge / Insert sheet ---------------- */

let insertFile = null;
let insertPos = "end";

el("btnMerge").addEventListener("click", () => {
  insertFile = null;
  insertPos = "end";
  el("insertFileDrop").classList.remove("has-file");
  el("insertFileDrop").textContent = "點此選擇要插入的音檔";
  document.querySelectorAll("#insertPosGroup .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.pos === "end"));
  el("insertConfirm").disabled = true;
  openSheet("mergeSheet");
});
el("insertFileDrop").addEventListener("click", () => el("insertFileInput").click());
el("insertFileInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  insertFile = f;
  el("insertFileDrop").textContent = "已選擇：" + f.name;
  el("insertFileDrop").classList.add("has-file");
  el("insertConfirm").disabled = false;
});
document.querySelectorAll("#insertPosGroup .seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.dataset.pos === "selection" && !state.region) {
      toast("請先在波形上選取一個插入點");
      return;
    }
    insertPos = b.dataset.pos;
    document.querySelectorAll("#insertPosGroup .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });
});
el("insertConfirm").addEventListener("click", async () => {
  if (!insertFile) return;
  closeSheets();
  showProgress("讀取並合併音檔中…");
  try {
    const insBuf = await loadFile(insertFile, { asInsert: true });
    let at;
    if (insertPos === "start") at = 0;
    else if (insertPos === "selection" && state.region) at = selSamples().s;
    else at = state.buffer.length;
    setCurrentBuffer(spliceInsert(state.buffer, insBuf, at));
    toast("已插入音檔");
  } catch (err) {
    console.error(err);
    toast("插入音檔失敗");
  } finally {
    hideProgress();
  }
});

/* ---------------- Export sheet ---------------- */

let exportFormat = "wav";
el("btnExport").addEventListener("click", () => {
  el("exportFilename").value = state.fileBaseName + "_剪輯";
  document.querySelectorAll("#exportFormatGroup .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.fmt === "wav"));
  exportFormat = "wav";
  openSheet("exportSheet");
});
document.querySelectorAll("#exportFormatGroup .seg-btn").forEach((b) => {
  b.addEventListener("click", () => {
    exportFormat = b.dataset.fmt;
    document.querySelectorAll("#exportFormatGroup .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });
});
el("exportConfirm").addEventListener("click", async () => {
  const name = (el("exportFilename").value || "錄音剪輯").trim();
  closeSheets();
  showProgress("匯出中…");
  try {
    await yieldToUI();
    let blob, ext;
    if (exportFormat === "mp3") {
      blob = encodeMp3Mono(state.buffer, 128);
      ext = "mp3";
    } else {
      blob = encodeWavMono(state.buffer);
      ext = "wav";
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast("匯出完成，請至下載項目查看");
  } catch (err) {
    console.error(err);
    toast("匯出失敗");
  } finally {
    hideProgress();
  }
});

/* ---------------- Install banner (iOS) ---------------- */

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function maybeShowInstallBanner() {
  if (isStandalone()) return;
  if (!isIOS()) return;
  try {
    if (localStorage.getItem("installBannerDismissed") === "1") return;
  } catch (e) {}
  el("installBanner").classList.add("show");
}
el("installBannerClose").addEventListener("click", () => {
  el("installBanner").classList.remove("show");
  try { localStorage.setItem("installBannerDismissed", "1"); } catch (e) {}
});

/* ---------------- Boot ---------------- */

initWavesurfer();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
  // A newer service worker can take over an already-open tab mid-session (we
  // push updates often). Don't auto-reload — that would silently wipe an
  // in-progress edit — just let the user know once it's a safe time to refresh.
  let announcedUpdate = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (announcedUpdate) return;
    announcedUpdate = true;
    toast("已有新版本，建議完成目前操作、匯出後再重新整理頁面", 6000);
  });
}
