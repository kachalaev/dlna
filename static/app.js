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

function showWatch(id) {
  history.pushState({}, "", `/watch/${id}`);
  render();
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

function metaText(video) {
  const bits = [video.ext.toUpperCase(), formatSize(video.size)];
  const duration = formatDuration(video.duration);
  if (duration) bits.push(duration);
  if (video.width && video.height) bits.push(`${video.width}×${video.height}`);
  if (video.folder) bits.push(video.folder);
  return bits.join(" · ");
}

function mountRemux(video) {
  const node = document.createElement("video");
  node.playsInline = true;
  node.preload = "auto";
  const controls = document.createElement("div");
  controls.className = "controls";
  const play = document.createElement("button");
  play.type = "button";
  play.textContent = "Смотреть";
  const time = document.createElement("span");
  time.textContent = formatDuration(0) + (video.duration ? ` / ${formatDuration(video.duration)}` : "");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.step = "1";
  const duration = video.duration || 0;
  slider.max = String(Math.max(0, Math.floor(duration)));
  slider.value = "0";
  slider.disabled = !duration;
  let offset = 0;

  function start(at) {
    offset = at;
    node.src = `/api/videos/${video.id}/stream?t=${at.toFixed(3)}`;
    node.play().catch(() => {});
    play.textContent = "Пауза";
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
    if (duration) slider.value = String(Math.min(duration, current));
    time.textContent = `${formatDuration(current)}${duration ? ` / ${formatDuration(duration)}` : ""}`;
  });
  node.addEventListener("ended", () => {
    play.textContent = "Смотреть";
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
  controls.append(play, slider, time, fullscreen);
  stage.append(node, controls);
  playerEl.append(stage);
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

async function renderPlayer(id) {
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
  playerEl.append(back, title, meta);
  if (!video.available) {
    playerEl.append(note("Файл сейчас недоступен."));
    return;
  }
  if (video.playback === "none") {
    playerEl.append(note("Файл есть в каталоге. Просмотр AVI в браузере не включён."));
    return;
  }
  if (video.playback === "direct") {
    const node = document.createElement("video");
    node.controls = true;
    node.playsInline = true;
    node.preload = "metadata";
    node.src = `/api/videos/${video.id}/stream`;
    node.addEventListener("error", () => {
      playerEl.append(note("Браузер не смог воспроизвести этот файл."));
    });
    playerEl.append(node);
    return;
  }
  mountRemux(video);
}

async function render() {
  const gen = ++renderGen;
  const route = readRoute();
  searchEl.value = route.q || "";
  if (route.watchId) {
    listingEl.hidden = true;
    crumbsEl.hidden = true;
    playerEl.hidden = false;
    await renderPlayer(route.watchId);
    return;
  }
  playerEl.hidden = true;
  playerEl.replaceChildren();
  listingEl.hidden = false;
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

window.addEventListener("popstate", () => render());
render();
refreshStatus();
setInterval(refreshStatus, 5000);
