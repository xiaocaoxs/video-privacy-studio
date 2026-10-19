const elements = {
  uploadView: document.querySelector("#uploadView"),
  editorView: document.querySelector("#editorView"),
  resultView: document.querySelector("#resultView"),
  fileInput: document.querySelector("#fileInput"),
  dropZone: document.querySelector("#dropZone"),
  fileName: document.querySelector("#fileName"),
  fileMeta: document.querySelector("#fileMeta"),
  replaceButton: document.querySelector("#replaceButton"),
  regionCount: document.querySelector("#regionCount"),
  regionList: document.querySelector("#regionList"),
  stripMetadata: document.querySelector("#stripMetadata"),
  processButton: document.querySelector("#processButton"),
  deleteRegionButton: document.querySelector("#deleteRegionButton"),
  videoStage: document.querySelector("#videoStage"),
  sourceVideo: document.querySelector("#sourceVideo"),
  overlay: document.querySelector("#overlay"),
  playButton: document.querySelector("#playButton"),
  muteButton: document.querySelector("#muteButton"),
  timeline: document.querySelector("#timeline"),
  timeLabel: document.querySelector("#timeLabel"),
  busyOverlay: document.querySelector("#busyOverlay"),
  busyTitle: document.querySelector("#busyTitle"),
  busyText: document.querySelector("#busyText"),
  toast: document.querySelector("#toast"),
  resultVideo: document.querySelector("#resultVideo"),
  resultName: document.querySelector("#resultName"),
  downloadButton: document.querySelector("#downloadButton"),
  backButton: document.querySelector("#backButton"),
};

const state = {
  upload: null,
  regions: [],
  selectedRegion: null,
  drawing: null,
  mode: "blur",
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const remainder = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatSize(bytes) {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function showBusy(title, text) {
  elements.busyTitle.textContent = title;
  elements.busyText.textContent = text;
  elements.busyOverlay.hidden = false;
}

function hideBusy() {
  elements.busyOverlay.hidden = true;
}

let toastTimer;
function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3600);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

async function uploadVideo(file) {
  if (!file?.type.startsWith("video/")) {
    showToast("请选择支持的视频文件");
    return;
  }

  showBusy("正在读取视频", "视频仅上传到当前电脑上的本地服务");
  const formData = new FormData();
  formData.append("video", file);

  try {
    const data = await requestJson("/api/upload", { method: "POST", body: formData });
    state.upload = { ...data, size: file.size };
    state.regions = [];
    state.selectedRegion = null;
    elements.sourceVideo.src = data.url;
    elements.fileName.textContent = data.originalName;
    elements.fileMeta.textContent = `${data.width} × ${data.height} · ${formatTime(data.duration)} · ${formatSize(file.size)}`;
    elements.uploadView.hidden = true;
    elements.resultView.hidden = true;
    elements.editorView.hidden = false;
    renderRegions();
  } catch (error) {
    showToast(error.message);
  } finally {
    hideBusy();
    elements.fileInput.value = "";
  }
}

function fitVideoStage() {
  if (!state.upload) return;
  const container = elements.videoStage.parentElement;
  const maxWidth = container.clientWidth;
  const maxHeight = container.clientHeight;
  const ratio = state.upload.width / state.upload.height;
  let width = maxWidth;
  let height = width / ratio;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  elements.videoStage.style.width = `${Math.max(1, width)}px`;
  elements.videoStage.style.height = `${Math.max(1, height)}px`;
}

function renderRegions() {
  elements.overlay.innerHTML = "";
  elements.regionList.innerHTML = "";
  elements.regionCount.textContent = state.regions.length;
  elements.processButton.disabled = state.regions.length === 0;
  elements.deleteRegionButton.disabled = state.selectedRegion === null;

  state.regions.forEach((region, index) => {
    const box = document.createElement("div");
    box.className = `redaction-box${index === state.selectedRegion ? " active" : ""}`;
    box.dataset.label = `区域 ${index + 1}`;
    box.dataset.index = index;
    box.style.left = `${region.x * 100}%`;
    box.style.top = `${region.y * 100}%`;
    box.style.width = `${region.width * 100}%`;
    box.style.height = `${region.height * 100}%`;
    elements.overlay.append(box);

    const item = document.createElement("button");
    item.type = "button";
    item.className = `region-item${index === state.selectedRegion ? " active" : ""}`;
    item.dataset.index = index;
    item.innerHTML = `<span><i class="region-swatch"></i>区域 ${index + 1}</span><span>${Math.round(region.width * state.upload.width)} × ${Math.round(region.height * state.upload.height)}</span>`;
    elements.regionList.append(item);
  });
}

function selectRegion(index) {
  state.selectedRegion = Number.isInteger(index) && index >= 0 && index < state.regions.length ? index : null;
  renderRegions();
}

function pointerPosition(event) {
  const bounds = elements.overlay.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

elements.overlay.addEventListener("pointerdown", (event) => {
  const existing = event.target.closest(".redaction-box");
  if (existing) {
    selectRegion(Number(existing.dataset.index));
    return;
  }
  if (state.regions.length >= 20) {
    showToast("最多添加 20 个脱敏区域");
    return;
  }
  const start = pointerPosition(event);
  state.drawing = { start, current: start };
  elements.overlay.setPointerCapture(event.pointerId);
});

elements.overlay.addEventListener("pointermove", (event) => {
  if (!state.drawing) return;
  state.drawing.current = pointerPosition(event);
  const { start, current } = state.drawing;
  const preview = {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
  let box = elements.overlay.querySelector(".drawing-box");
  if (!box) {
    box = document.createElement("div");
    box.className = "redaction-box drawing-box";
    box.dataset.label = "新区域";
    elements.overlay.append(box);
  }
  box.style.left = `${preview.x * 100}%`;
  box.style.top = `${preview.y * 100}%`;
  box.style.width = `${preview.width * 100}%`;
  box.style.height = `${preview.height * 100}%`;
});

function finishDrawing(event) {
  if (!state.drawing) return;
  const current = pointerPosition(event);
  const start = state.drawing.start;
  const region = {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
  state.drawing = null;
  if (region.width >= 0.015 && region.height >= 0.015) {
    state.regions.push(region);
    state.selectedRegion = state.regions.length - 1;
  }
  renderRegions();
}

elements.overlay.addEventListener("pointerup", finishDrawing);
elements.overlay.addEventListener("pointercancel", () => { state.drawing = null; renderRegions(); });
elements.regionList.addEventListener("click", (event) => {
  const item = event.target.closest(".region-item");
  if (item) selectRegion(Number(item.dataset.index));
});

elements.deleteRegionButton.addEventListener("click", () => {
  if (state.selectedRegion === null) return;
  state.regions.splice(state.selectedRegion, 1);
  state.selectedRegion = null;
  renderRegions();
});

document.addEventListener("keydown", (event) => {
  if ((event.key === "Delete" || event.key === "Backspace") && state.selectedRegion !== null && event.target.tagName !== "INPUT") {
    event.preventDefault();
    elements.deleteRegionButton.click();
  }
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    document.querySelectorAll(".segment").forEach((item) => item.classList.toggle("active", item === button));
  });
});

elements.fileInput.addEventListener("change", () => uploadVideo(elements.fileInput.files[0]));
elements.replaceButton.addEventListener("click", () => elements.fileInput.click());
["dragenter", "dragover"].forEach((name) => elements.dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  elements.dropZone.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => elements.dropZone.addEventListener(name, (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("dragging");
}));
elements.dropZone.addEventListener("drop", (event) => uploadVideo(event.dataTransfer.files[0]));

elements.sourceVideo.addEventListener("loadedmetadata", () => {
  fitVideoStage();
  elements.timeLabel.textContent = `00:00 / ${formatTime(elements.sourceVideo.duration)}`;
});
elements.sourceVideo.addEventListener("timeupdate", () => {
  const duration = elements.sourceVideo.duration || 0;
  elements.timeline.value = duration ? Math.round(elements.sourceVideo.currentTime / duration * 1000) : 0;
  elements.timeLabel.textContent = `${formatTime(elements.sourceVideo.currentTime)} / ${formatTime(duration)}`;
});
elements.sourceVideo.addEventListener("play", () => elements.playButton.parentElement.classList.add("playing"));
elements.sourceVideo.addEventListener("pause", () => elements.playButton.parentElement.classList.remove("playing"));
elements.playButton.addEventListener("click", () => elements.sourceVideo.paused ? elements.sourceVideo.play() : elements.sourceVideo.pause());
elements.timeline.addEventListener("input", () => {
  elements.sourceVideo.currentTime = (Number(elements.timeline.value) / 1000) * (elements.sourceVideo.duration || 0);
});
elements.muteButton.addEventListener("click", () => {
  elements.sourceVideo.muted = !elements.sourceVideo.muted;
  elements.muteButton.style.opacity = elements.sourceVideo.muted ? ".45" : "1";
  elements.muteButton.title = elements.sourceVideo.muted ? "取消静音" : "静音";
});
window.addEventListener("resize", fitVideoStage);

function pixelRegions() {
  return state.regions.map((region) => ({
    x: Math.round(region.x * state.upload.width),
    y: Math.round(region.y * state.upload.height),
    width: Math.round(region.width * state.upload.width),
    height: Math.round(region.height * state.upload.height),
  }));
}

elements.processButton.addEventListener("click", async () => {
  showBusy("正在生成脱敏视频", "耗时取决于视频时长和分辨率，请勿关闭页面");
  try {
    const result = await requestJson("/api/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: state.upload.id,
        regions: pixelRegions(),
        mode: state.mode,
        stripMetadata: elements.stripMetadata.checked,
      }),
    });
    elements.resultVideo.src = result.url;
    elements.resultName.textContent = result.filename;
    elements.downloadButton.href = result.downloadUrl;
    elements.downloadButton.download = result.filename;
    elements.editorView.hidden = true;
    elements.resultView.hidden = false;
  } catch (error) {
    showToast(error.message);
  } finally {
    hideBusy();
  }
});

elements.backButton.addEventListener("click", () => {
  elements.resultVideo.pause();
  elements.resultView.hidden = true;
  elements.editorView.hidden = false;
  requestAnimationFrame(fitVideoStage);
});
