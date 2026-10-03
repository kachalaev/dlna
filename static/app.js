const nativeHls = document.createElement("video").canPlayType("application/vnd.apple.mpegurl") !== "";

const listingEl = document.querySelector("#listing");
const playerEl = document.querySelector("#player");
const crumbsEl = document.querySelector("#crumbs");
const statusEl = document.querySelector("#status");
const searchEl = document.querySelector("#search");
const rescanBtn = document.querySelector("#rescan");

let renderGen = 0;
let lastScanning = false;

function readRoute() {
  const match = location.pathname.match(/^\/watch\/(\d+)$/);
  if (match) return { watchId: Number(match[1]) };
  const params = new URLSearchParams(location.search);
  return { folder: params.get("path") || "", q: params.get("q") || "" };
}

function navigateListing({ folder = "", q = "" } = {}) {
  const url = new URL("/", location.origin);
  if (q) url.searchParams.set("q", q);
  else if (folder) url.searchParams.set("path", folder);
  history.pushState({}, "", url);
  render();
}

function showWatch(id, options) {
  history.pushState({}, "", `/watch/${id}`);
  render(options);
}

async function playableFiles(video) {
  const data = await api(`/api/browse?path=${encodeURIComponent(video.folder)}`);
  return (data.files || []).filter((file) => file.available && file.playback !== "none");
}

async function openSibling(video, step) {
  const gen = renderGen;
  const stayFullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  let files;
  try {
    files = await playableFiles(video);
  } catch (_error) {
    return;
  }
  if (gen !== renderGen) return;
  const index = files.findIndex((file) => file.id === video.id);
  const target = index >= 0 ? files[index + step] : null;
  if (!target) return;
  history.pushState({}, "", `/watch/${target.id}`);
  await render({ autoplay: true, resume: false });
  if (!stayFullscreen || renderGen !== gen + 1) return;
  const stage = playerEl.querySelector(".stage") || playerEl.querySelector("video");
  const enter = stage && (stage.requestFullscreen || stage.webkitRequestFullscreen);
  if (enter) enter.call(stage).catch(() => {});
}

function playNext(video) {
  return openSibling(video, 1);
}

function stepButton(label, video, step) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = true;
  button.addEventListener("click", () => openSibling(video, step));
  return button;
}

async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    let message = "Ошибка запроса";
    try {
      const data = await response.json();
      if (typeof data.detail === "string") message = data.detail;
    } catch (_error) {
      /* ответ без JSON */
    }
    throw new Error(message);
  }
  const type = response.headers.get("content-type") || "";
  if (!type.includes("application/json")) return null;
  return response.json();
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ", "ТБ"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function formatWhen(seconds) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function filesLabel(count) {
  const n10 = count % 10;
  const n100 = count % 100;
  if (n10 === 1 && n100 !== 11) return `${count} файл`;
  if (n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)) return `${count} файла`;
  return `${count} файлов`;
}

function statusText(status) {
  if (status.scanning) {
    return status.files_seen
      ? `Идёт обновление каталога, уже ${status.files_seen}`
      : "Идёт обновление каталога, смотрю папки";
  }
  const parts = [];
  if (status.finished_at) {
    parts.push(`Обновлено ${new Date(status.finished_at).toLocaleString("ru-RU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })}`);
  } else {
    parts.push("Каталог ещё не обновлялся");
  }
  if (status.archive_incomplete) parts.push("часть архива сейчас недоступна");
  if (status.error) parts.push(status.error);
  return parts.join(" · ");
}

function note(text) {
  const node = document.createElement("p");
  node.className = "note";
  node.textContent = text;
  return node;
}

const RESUME_KEY = "archive-resume";
const resumeEl = document.querySelector("#resume");
let playback = null;
let resumeTick = 0;

function readResume() {
  try {
    const data = JSON.parse(localStorage.getItem(RESUME_KEY) || "");
    const time = Number(data.time);
    if (!data || !Number.isFinite(Number(data.id)) || !Number.isFinite(time) || time < 0) return null;
    return { id: Number(data.id), name: String(data.name || "Ролик"), time };
  } catch (_error) {
    return null;
  }
}

function writeResume(video, time) {
  const safe = Math.max(0, Number(time) || 0);
  const duration = Number(video.duration) || 0;
  if (duration > 30 && safe >= duration - 10) {
    localStorage.removeItem(RESUME_KEY);
    paintResume();
    return;
  }
  localStorage.setItem(RESUME_KEY, JSON.stringify({
    id: video.id,
    name: video.name,
    time: Math.round(safe),
  }));
  paintResume();
}

function startAtFor(video, resume) {
  if (!resume) return 0;
  const saved = readResume();
  if (!saved || saved.id !== video.id) return 0;
  const duration = Number(video.duration) || 0;
  if (duration > 30 && saved.time >= duration - 10) return 0;
  return saved.time;
}

function bindProgress(video, current, started) {
  playback = { video, current, started };
  resumeTick = 0;
}

function rememberNow() {
  if (!playback || !playback.started()) return;
  writeResume(playback.video, playback.current());
}

function maybeRemember() {
  const now = Date.now();
  if (now - resumeTick < 5000) return;
  resumeTick = now;
  rememberNow();
}

function paintResume() {
  const saved = readResume();
  if (!saved || readRoute().watchId) {
    resumeEl.hidden = true;
    resumeEl.replaceChildren();
    return;
  }
  const text = document.createElement("span");
  text.textContent = `${saved.name} · ${formatDuration(saved.time)}`;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Продолжить";
  button.addEventListener("click", () => showWatch(saved.id, { autoplay: true }));
  resumeEl.replaceChildren(text, button);
  resumeEl.hidden = false;
}

function renderCrumbs(folder) {
  crumbsEl.replaceChildren();
  const root = document.createElement("button");
  root.type = "button";
  root.textContent = "Архив";
  root.addEventListener("click", () => navigateListing({}));
  crumbsEl.append(root);
  if (!folder) return;
  const parts = folder.split("/");
  parts.forEach((part, index) => {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "/";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = part;
    const path = parts.slice(0, index + 1).join("/");
    button.addEventListener("click", () => navigateListing({ folder: path }));
    crumbsEl.append(sep, button);
  });
}

function fileRow(file) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = file.available ? "row" : "row unavailable";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = file.name;
  const meta = document.createElement("span");
  meta.className = "row-meta";
  const bits = [file.ext.toUpperCase(), formatSize(file.size)];
  const duration = formatDuration(file.duration);
  if (duration) bits.push(duration);
  const when = formatWhen(file.mtime);
  if (when) bits.push(when);
  if (!file.available) bits.push("недоступен");
  meta.textContent = bits.join(" · ");
  button.append(name, meta);
  button.addEventListener("click", () => showWatch(file.id));
  return button;
}

function folderRow(folder) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "row";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = folder.name;
  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = filesLabel(folder.count);
  button.append(name, meta);
  button.addEventListener("click", () => navigateListing({ folder: folder.path }));
  return button;
}

async function renderListing(folder, query) {
  const gen = renderGen;
  try {
    await renderListingBody(folder, query, gen);
  } catch (error) {
    if (gen !== renderGen) return;
    crumbsEl.hidden = true;
    listingEl.replaceChildren(note(error.message));
  }
}

async function renderListingBody(folder, query, gen) {
  if (query) {
    crumbsEl.hidden = true;
    const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
    if (gen !== renderGen) return;
    const nodes = data.files.map(fileRow);
    if (!nodes.length) nodes.push(note("Ничего не найдено."));
    if (data.truncated) nodes.push(note("Показаны первые 200 совпадений."));
    listingEl.replaceChildren(...nodes);
    return;
  }
  crumbsEl.hidden = false;
  const data = await api(`/api/browse?path=${encodeURIComponent(folder)}`);
  if (gen !== renderGen) return;
  renderCrumbs(data.path);
  const nodes = [...data.folders.map(folderRow), ...data.files.map(fileRow)];
  if (!nodes.length) {
    const scanning = statusEl.textContent.startsWith("Идёт обновление");
    nodes.push(note(scanning ? "Каталог обновляется. Файлы появятся по мере обхода." : "В этой папке нет видео."));
  }
  listingEl.replaceChildren(...nodes);
}

const VOLUME_KEY = "archive-volume";
const MUTE_KEY = "archive-muted";

function savedLevel() {
  const value = Number(localStorage.getItem(VOLUME_KEY));
  if (!Number.isFinite(value) || value <= 0 || value > 1) return 1;
  return value;
}

function savedMuted() {
  return localStorage.getItem(MUTE_KEY) === "1";
}

function saveSound(level, muted) {
  if (level > 0) localStorage.setItem(VOLUME_KEY, String(level));
  localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
}

function applySavedVolume(node) {
  node.volume = savedLevel();
  node.muted = savedMuted();
  node.addEventListener("volumechange", () => {
    if (!node.isConnected) return;
    if (node.muted || node.volume === 0) saveSound(node.volume > 0 ? node.volume : savedLevel(), true);
    else saveSound(node.volume, false);
  });
}

function volumeControls(node) {
  let level = savedLevel();
  node.volume = level;
  node.muted = savedMuted();
  const mute = document.createElement("button");
  mute.type = "button";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "volume";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.setAttribute("aria-label", "Громкость");

  function paint() {
    const audible = !node.muted && node.volume > 0;
    slider.value = String(audible ? Math.round(node.volume * 100) : 0);
    mute.textContent = audible ? "Без звука" : "Звук";
  }

  mute.addEventListener("click", () => {
    if (node.muted || node.volume === 0) {
      node.volume = level > 0 ? level : 1;
      node.muted = false;
      saveSound(node.volume, false);
    } else {
      level = node.volume;
      node.muted = true;
      saveSound(level, true);
    }
    paint();
  });
  slider.addEventListener("input", () => {
    const next = Number(slider.value) / 100;
    if (next > 0) level = next;
    node.volume = next > 0 ? next : level;
    node.muted = next === 0;
    saveSound(level, next === 0);
    paint();
  });
  paint();
  return [mute, slider];
}

function metaText(video) {
  const bits = [video.ext.toUpperCase(), formatSize(video.size)];
  const duration = formatDuration(video.duration);
  if (duration) bits.push(duration);
  if (video.width && video.height) bits.push(`${video.width}×${video.height}`);
  if (video.folder) bits.push(video.folder);
  return bits.join(" · ");
}

function mountRemux(video, { autoplay = false, previous = null, next = null, startAt = 0 } = {}) {
  const node = document.createElement("video");
  node.playsInline = true;
  node.setAttribute("playsinline", "");
  node.preload = "auto";
  const sound = volumeControls(node);
  const controls = document.createElement("div");
  controls.className = "controls";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "play";
  play.textContent = "Смотреть";
  const time = document.createElement("span");
  time.textContent = formatDuration(0) + (video.duration ? ` / ${formatDuration(video.duration)}` : "");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.step = "1";
  const duration = video.duration || 0;
  const begin = duration ? Math.min(duration, startAt) : startAt;
  slider.max = String(Math.max(0, Math.floor(duration)));
  slider.value = String(Math.floor(begin));
  slider.disabled = !duration;
  time.textContent = `${formatDuration(begin)}${duration ? ` / ${formatDuration(duration)}` : ""}`;
  let offset = 0;
  let position = begin;
  let audio = 0;
  let playing = false;
  bindProgress(video, () => position, () => playing);

  function start(at) {
    offset = at;
    position = at;
    playing = true;
    node.src = nativeHls
      ? `/api/videos/${video.id}/hls.m3u8?t=${at.toFixed(3)}&a=${audio}`
      : `/api/videos/${video.id}/stream?t=${at.toFixed(3)}&a=${audio}`;
    node.play().catch(() => {});
    play.textContent = "Пауза";
    rememberNow();
  }

  play.addEventListener("click", () => {
    if (!node.getAttribute("src")) {
      start(Number(slider.value) || 0);
      return;
    }
    if (node.paused) {
      node.play();
      play.textContent = "Пауза";
    } else {
      node.pause();
      play.textContent = "Смотреть";
    }
  });
  node.addEventListener("timeupdate", () => {
    const current = offset + (node.currentTime || 0);
    position = current;
    if (duration) slider.value = String(Math.min(duration, current));
    time.textContent = `${formatDuration(current)}${duration ? ` / ${formatDuration(duration)}` : ""}`;
    maybeRemember();
  });
  node.addEventListener("pause", rememberNow);
  node.addEventListener("seeked", rememberNow);
  node.addEventListener("ended", () => {
    play.textContent = "Смотреть";
    playNext(video);
  });
  node.addEventListener("error", () => {
    playerEl.append(note("Не удалось начать воспроизведение. Подождите несколько секунд и нажмите «Смотреть» ещё раз."));
  });
  slider.addEventListener("change", () => start(Number(slider.value) || 0));
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.textContent = "На весь экран";
  const stage = document.createElement("div");
  stage.className = "stage";
  bindFullscreen(stage, node, fullscreen);
  controls.append(play, slider, time, ...sound);
  if (previous) controls.append(previous);
  if (next) controls.append(next);
  const tracks = audioSelect(video, (index) => {
    audio = index;
    if (node.getAttribute("src")) start(offset + (node.currentTime || 0));
  });
  if (tracks) controls.append(tracks);
  controls.append(fullscreen);
  stage.append(node, controls);
  playerEl.append(stage);
  if (autoplay) start(begin);
}

function audioSelect(video, onChange) {
  const tracks = video.audio_tracks || [];
  if (tracks.length < 2) return null;
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Звуковая дорожка");
  tracks.forEach((track) => {
    const option = document.createElement("option");
    option.value = String(track.index);
    option.textContent = track.label;
    select.append(option);
  });
  select.addEventListener("change", () => onChange(Number(select.value) || 0));
  return select;
}

function bindFullscreen(stage, video, button) {
  const change = () => {
    if (!stage.isConnected) {
      document.removeEventListener("fullscreenchange", change);
      document.removeEventListener("webkitfullscreenchange", change);
      return;
    }
    const active = document.fullscreenElement === stage || document.webkitFullscreenElement === stage;
    button.textContent = active ? "Обычный размер" : "На весь экран";
  };
  button.addEventListener("click", () => {
    const active = document.fullscreenElement === stage || document.webkitFullscreenElement === stage;
    if (active) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
      return;
    }
    if (stage.requestFullscreen) {
      stage.requestFullscreen();
      return;
    }
    if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
      return;
    }
    if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
  });
  document.addEventListener("fullscreenchange", change);
  document.addEventListener("webkitfullscreenchange", change);
}

async function renderPlayer(id, { autoplay = false, resume = true } = {}) {
  const gen = renderGen;
  let video;
  try {
    video = await api(`/api/videos/${id}`);
  } catch (error) {
    if (gen !== renderGen) return;
    playerEl.replaceChildren(note(error.message));
    return;
  }
  if (gen !== renderGen) return;
  playerEl.replaceChildren();
  const back = document.createElement("button");
  back.type = "button";
  back.className = "back";
  back.textContent = "К папке";
  back.addEventListener("click", () => navigateListing({ folder: video.folder }));
  const title = document.createElement("h2");
  title.textContent = video.name;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = metaText(video);
  const previous = stepButton("Предыдущее", video, -1);
  const next = stepButton("Следующее", video, 1);
  const neighbors = document.createElement("div");
  neighbors.className = "neighbors";
  neighbors.append(previous, next);
  playerEl.append(back, title, meta, neighbors);
  playableFiles(video).then((files) => {
    if (!neighbors.isConnected) return;
    const index = files.findIndex((file) => file.id === video.id);
    previous.disabled = index <= 0;
    next.disabled = index < 0 || index >= files.length - 1;
    if (previous.fullscreenTwin) previous.fullscreenTwin.disabled = previous.disabled;
    if (next.fullscreenTwin) next.fullscreenTwin.disabled = next.disabled;
  }).catch(() => {});
  if (!video.available) {
    playerEl.append(note("Файл сейчас недоступен."));
    return;
  }
  if (video.playback === "none") {
    playerEl.append(note("Файл есть в каталоге. Просмотр AVI в браузере не включён."));
    return;
  }
  if (video.playback === "direct" && (video.audio_tracks || []).length < 2) {
    const node = document.createElement("video");
    node.controls = true;
    node.playsInline = true;
    node.setAttribute("playsinline", "");
    node.preload = "metadata";
    applySavedVolume(node);
    const startAt = startAtFor(video, resume);
    let playing = false;
    bindProgress(video, () => node.currentTime || 0, () => playing);
    node.addEventListener("play", () => {
      playing = true;
      rememberNow();
    });
    node.addEventListener("loadedmetadata", () => {
      if (startAt > 0) {
        const limit = Number.isFinite(node.duration) ? Math.max(0, node.duration - 1) : startAt;
        node.currentTime = Math.min(startAt, limit);
      }
      if (autoplay) node.play().catch(() => {});
    });
    node.addEventListener("timeupdate", maybeRemember);
    node.addEventListener("pause", rememberNow);
    node.addEventListener("seeked", rememberNow);
    node.src = `/api/videos/${video.id}/stream`;
    node.addEventListener("ended", () => playNext(video));
    node.addEventListener("error", () => {
      playerEl.append(note("Браузер не смог воспроизвести этот файл."));
    });
    playerEl.append(node);
    return;
  }
  const previousFull = stepButton("Предыдущее", video, -1);
  const nextFull = stepButton("Следующее", video, 1);
  previousFull.className = "step";
  nextFull.className = "step";
  previous.fullscreenTwin = previousFull;
  next.fullscreenTwin = nextFull;
  previousFull.disabled = previous.disabled;
  nextFull.disabled = next.disabled;
  mountRemux(video, {
    autoplay,
    previous: previousFull,
    next: nextFull,
    startAt: startAtFor(video, resume),
  });
}

async function render({ autoplay = false, resume = true } = {}) {
  const gen = ++renderGen;
  rememberNow();
  playback = null;
  const route = readRoute();
  searchEl.value = route.q || "";
  if (route.watchId) {
    listingEl.hidden = true;
    crumbsEl.hidden = true;
    playerEl.hidden = false;
    resumeEl.hidden = true;
    await renderPlayer(route.watchId, { autoplay, resume });
    return;
  }
  playerEl.hidden = true;
  playerEl.replaceChildren();
  listingEl.hidden = false;
  paintResume();
  if (gen !== renderGen) return;
  await renderListing(route.folder, route.q);
}

async function refreshStatus() {
  try {
    const status = await api("/api/status");
    const wasScanning = lastScanning;
    lastScanning = status.scanning;
    statusEl.textContent = statusText(status);
    rescanBtn.disabled = status.scanning;
    if (wasScanning && !status.scanning && !readRoute().watchId) render();
  } catch (_error) {
    statusEl.textContent = "Нет связи с сервером";
  }
}

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  navigateListing({ q: searchEl.value.trim() });
});

rescanBtn.addEventListener("click", async () => {
  rescanBtn.disabled = true;
  statusEl.textContent = "Идёт обновление каталога";
  try {
    await api("/api/scan", { method: "POST" });
    const startedAt = Date.now();
    let status = await api("/api/status");
    while (status.scanning && Date.now() - startedAt < 10 * 60 * 1000) {
      statusEl.textContent = statusText(status);
      await new Promise((resolve) => setTimeout(resolve, 400));
      status = await api("/api/status");
    }
    lastScanning = Boolean(status.scanning);
    statusEl.textContent = statusText(status);
    if (!readRoute().watchId) await render();
  } catch (_error) {
    statusEl.textContent = "Не удалось запустить обновление";
    lastScanning = false;
  }
  rescanBtn.disabled = lastScanning;
});

let seekTimer = 0;

function onPlayerKey(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (playerEl.hidden) return;
  const target = event.target;
  const tag = target && target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (target && target.isContentEditable)) return;
  const node = playerEl.querySelector("video");
  if (!node) return;
  if (event.key === " ") {
    if (event.repeat || (target && target.closest && target.closest("button"))) return;
    event.preventDefault();
    const play = playerEl.querySelector(".controls .play");
    if (play) play.click();
    else if (node.paused) node.play().catch(() => {});
    else node.pause();
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const slider = playerEl.querySelector('.controls input[type="range"]:not(.volume)');
    const delta = event.key === "ArrowLeft" ? -10 : 10;
    if (slider && !slider.disabled) {
      const next = Math.min(Number(slider.max), Math.max(0, Number(slider.value) + delta));
      slider.value = String(next);
      window.clearTimeout(seekTimer);
      seekTimer = window.setTimeout(() => {
        if (slider.isConnected) slider.dispatchEvent(new Event("change"));
      }, 280);
      return;
    }
    if (Number.isFinite(node.duration)) {
      node.currentTime = Math.min(node.duration, Math.max(0, (node.currentTime || 0) + delta));
    }
    return;
  }
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  event.preventDefault();
  const delta = event.key === "ArrowUp" ? 0.1 : -0.1;
  const slider = playerEl.querySelector("input.volume");
  const current = node.muted ? 0 : node.volume;
  const level = Math.min(1, Math.max(0, current + delta));
  if (slider) {
    slider.value = String(Math.round(level * 100));
    slider.dispatchEvent(new Event("input"));
    return;
  }
  node.muted = level === 0;
  node.volume = level === 0 ? node.volume || savedLevel() : level;
  saveSound(level === 0 ? node.volume || savedLevel() : level, level === 0);
}

window.addEventListener("pagehide", rememberNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") rememberNow();
});
document.addEventListener("keydown", onPlayerKey);
window.addEventListener("popstate", () => render());
render();
refreshStatus();
setInterval(refreshStatus, 5000);
