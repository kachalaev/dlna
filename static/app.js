// Edge на Windows отвечает, что умеет HLS, но наш поток не запускает.
const nativeHls = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  || (/Safari\//.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR|Android/.test(navigator.userAgent));

const listingEl = document.querySelector("#listing");
const playerEl = document.querySelector("#player");
const dock = document.querySelector("#dock");
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
  return {
    folder: params.get("path") || "",
    q: params.get("q") || "",
    play: params.get("play") || "",
  };
}

function navigateListing({ folder = "", q = "", play = "" } = {}) {
  const url = new URL("/", location.origin);
  if (q) url.searchParams.set("q", q);
  else {
    if (folder) url.searchParams.set("path", folder);
    if (play) url.searchParams.set("play", play);
  }
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
  if (!folder) {
    crumbsEl.hidden = true;
    return;
  }
  crumbsEl.hidden = false;
  const parts = folder.split("/");
  parts.forEach((part, index) => {
    if (index > 0) {
      const sep = document.createElement("span");
      sep.className = "sep";
      sep.textContent = "/";
      crumbsEl.append(sep);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = part;
    const path = parts.slice(0, index + 1).join("/");
    button.addEventListener("click", () => navigateListing({ folder: path }));
    crumbsEl.append(button);
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
  button.addEventListener("click", () => {
    if (file.playback === "audio") navigateListing({ folder: file.folder, play: String(file.id) });
    else showWatch(file.id);
  });
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

async function renderListing(folder, query, play) {
  const gen = renderGen;
  try {
    await renderListingBody(folder, query, gen, play);
  } catch (error) {
    if (gen !== renderGen) return;
    crumbsEl.hidden = true;
    listingEl.replaceChildren(note(error.message));
  }
}

function trackTitle(file) {
  return file.name.replace(/\.[^.]+$/, "");
}

const PLAYLIST_KEY = "archive-playlist";
let playlist = loadPlaylist();
let paintPlaylist = () => {};
let refillUpcoming = () => {};
let playAt = () => {};
let clearPlaylist = () => {};
let playerReady = false;

function loadPlaylist() {
  try {
    const data = JSON.parse(localStorage.getItem(PLAYLIST_KEY) || "[]");
    if (!Array.isArray(data)) return [];
    return data.filter((item) => item && item.id != null && item.name);
  } catch (_error) {
    return [];
  }
}

function savePlaylist() {
  localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlist));
}

function snapshotTrack(file) {
  return {
    id: file.id,
    name: file.name,
    ext: file.ext || "",
    duration: file.duration || null,
    folder: file.folder || "",
  };
}

function hasTrack(id) {
  return playlist.some((item) => item.id === id);
}

function markPlaylistButtons() {
  document.querySelectorAll("[data-add]").forEach((button) => {
    const present = hasTrack(Number(button.dataset.add));
    button.textContent = present ? "В плейлисте" : "Добавить";
    button.disabled = present;
  });
}

function showDock() {
  if (!playlist.length) {
    dock.hidden = true;
    document.body.classList.remove("has-dock");
    return;
  }
  bootPlayer();
  dock.hidden = false;
  document.body.classList.add("has-dock");
}

function addTracks(files) {
  let changed = false;
  files.forEach((file) => {
    if (file.playback && file.playback !== "audio") return;
    if (file.available === false) return;
    if (hasTrack(file.id)) return;
    playlist.push(snapshotTrack(file));
    changed = true;
  });
  if (changed) {
    savePlaylist();
    if (playerReady) refillUpcoming();
  }
  showDock();
  paintPlaylist();
  markPlaylistButtons();
}

function playTrackId(id) {
  const item = playlist.findIndex((track) => String(track.id) === String(id));
  if (item >= 0) playAt(item);
}

function openTrack(file, albumFiles) {
  if (!file || file.available === false) return;
  if (!playlist.length) addTracks(albumFiles);
  else if (!hasTrack(file.id)) addTracks([file]);
  playTrackId(file.id);
}

function albumSource(files, path, playId) {
  const section = document.createElement("section");
  section.className = "album-source";
  const head = document.createElement("div");
  head.className = "album-head";
  const heading = document.createElement("h2");
  heading.textContent = path ? path.split("/").pop() : "Альбом";
  const addAll = document.createElement("button");
  addAll.type = "button";
  addAll.className = "text-btn";
  addAll.textContent = "Добавить альбом";
  addAll.addEventListener("click", () => addTracks(files));
  head.append(heading, addAll);
  const rows = document.createElement("div");
  files.forEach((file) => {
    const row = document.createElement("div");
    row.className = file.available ? "row track-row" : "row track-row unavailable";
    const name = document.createElement("button");
    name.type = "button";
    name.className = "name";
    name.textContent = trackTitle(file);
    name.addEventListener("click", () => openTrack(file, files));
    const meta = document.createElement("span");
    meta.className = "row-meta";
    const bits = [file.ext.toUpperCase()];
    const duration = formatDuration(file.duration);
    if (duration) bits.push(duration);
    if (!file.available) bits.push("недоступен");
    meta.textContent = bits.join(" · ");
    const add = document.createElement("button");
    add.type = "button";
    add.className = "text-btn";
    add.dataset.add = String(file.id);
    add.textContent = hasTrack(file.id) ? "В плейлисте" : "Добавить";
    add.disabled = hasTrack(file.id) || !file.available;
    add.addEventListener("click", () => addTracks([file]));
    row.append(name, meta, add);
    rows.append(row);
  });
  section.append(head, rows);
  if (playId) {
    const file = files.find((item) => String(item.id) === String(playId));
    if (file) openTrack(file, files);
  }
  return section;
}

function bootPlayer() {
  if (playerReady) return;
  playerReady = true;
  const section = document.createElement("section");
  section.className = "album";
  const heading = document.createElement("h2");
  heading.textContent = "Плейлист";
  const now = document.createElement("p");
  now.className = "now";
  now.textContent = "Выберите запись";
  const node = document.createElement("audio");
  node.preload = "none";
  const sound = volumeControls(node);
  const controls = document.createElement("div");
  controls.className = "controls";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "play";
  setIcon(play, "play", "Слушать");
  const previous = document.createElement("button");
  previous.type = "button";
  setIcon(previous, "previous", "Предыдущая запись");
  const next = document.createElement("button");
  next.type = "button";
  setIcon(next, "next", "Следующая запись");
  const time = document.createElement("span");
  time.textContent = "0:00";
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.step = "1";
  slider.value = "0";
  slider.disabled = true;
  slider.setAttribute("aria-label", "Позиция");
  let index = -1;
  let scrubbing = false;
  let readyToAdvance = false;
  let shuffle = localStorage.getItem("archive-shuffle") === "1";
  let upcoming = [];
  let played = [];
  const heard = new Set();
  const list = document.createElement("div");
  list.className = "playlist";

  function paint() {
    const file = playlist[index];
    now.textContent = file ? trackTitle(file) : "Выберите запись";
    const duration = file && file.duration ? file.duration : node.duration;
    const known = Number.isFinite(duration) && duration > 0;
    slider.disabled = !known;
    if (known) slider.max = String(Math.floor(duration));
    list.replaceChildren(...playlist.map((track, item) => playlistRow(track, item)));
    const current = list.querySelector(".current");
    if (current) current.scrollIntoView({ block: "nearest" });
  }

  function playlistRow(track, item) {
    const row = document.createElement("div");
    row.className = item === index ? "row current" : "row";
    const pos = document.createElement("span");
    pos.className = "pos";
    pos.textContent = String(item + 1);
    const name = document.createElement("button");
    name.type = "button";
    name.className = "name";
    name.draggable = true;
    name.textContent = trackTitle(track);
    let dragged = false;
    name.addEventListener("dragstart", (event) => {
      dragged = true;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(item));
      row.classList.add("dragging");
    });
    name.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      window.setTimeout(() => {
        dragged = false;
      }, 0);
    });
    name.addEventListener("click", () => {
      if (dragged) return;
      if (item === index) play.click();
      else playAt(item);
    });
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = formatDuration(track.duration) || "";
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      row.classList.add("drop");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      row.classList.remove("drop");
      const from = Number(event.dataTransfer.getData("text/plain"));
      if (Number.isFinite(from)) moveTrack(from, item);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    setIcon(remove, "close", "Убрать из плейлиста");
    remove.addEventListener("click", () => removeTrack(item));
    row.append(pos, name, meta, remove);
    return row;
  }

  function removeTrack(item) {
    if (item < 0 || item >= playlist.length) return;
    const currentId = index >= 0 && playlist[index] ? playlist[index].id : null;
    const removed = playlist[item];
    heard.delete(removed.id);
    const upcomingIds = upcoming.map((slot) => playlist[slot] && playlist[slot].id).filter((id) => id != null && id !== removed.id);
    const playedIds = played.map((slot) => playlist[slot] && playlist[slot].id).filter((id) => id != null && id !== removed.id);
    playlist.splice(item, 1);
    if (!playlist.length) {
      clearPlaylist();
      return;
    }
    const locate = (id) => playlist.findIndex((track) => track.id === id);
    upcoming = upcomingIds.map(locate).filter((slot) => slot >= 0);
    played = playedIds.map(locate).filter((slot) => slot >= 0);
    savePlaylist();
    markPlaylistButtons();
    if (removed.id === currentId) {
      index = -1;
      playAt(Math.min(item, playlist.length - 1));
      return;
    }
    index = locate(currentId);
    paint();
  }

  function moveTrack(from, to) {
    if (from === to || from < 0 || to < 0 || from >= playlist.length) return;
    to = Math.max(0, Math.min(playlist.length - 1, to));
    const currentId = index >= 0 && playlist[index] ? playlist[index].id : null;
    const upcomingIds = upcoming.map((slot) => playlist[slot] && playlist[slot].id).filter((id) => id != null);
    const playedIds = played.map((slot) => playlist[slot] && playlist[slot].id).filter((id) => id != null);
    const [moved] = playlist.splice(from, 1);
    playlist.splice(to, 0, moved);
    index = currentId == null ? -1 : playlist.findIndex((track) => track.id === currentId);
    const locate = (id) => playlist.findIndex((track) => track.id === id);
    upcoming = upcomingIds.map(locate).filter((slot) => slot >= 0);
    played = playedIds.map(locate).filter((slot) => slot >= 0);
    savePlaylist();
    paint();
  }

  function ids() {
    return playlist.map((_track, item) => item);
  }

  function shuffledCopy(items) {
    const copy = items.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const swap = copy[i];
      const j = Math.floor(Math.random() * (i + 1));
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }

  function queueRest() {
    return ids().filter((item) => item !== index && playlist[item] && !heard.has(playlist[item].id));
  }

  refillUpcoming = () => {
    upcoming = shuffle ? shuffledCopy(queueRest()) : [];
    played = index >= 0 ? [index] : [];
  };

  function goNext() {
    if (!playlist.length) return;
    if (shuffle) {
      if (!upcoming.length) upcoming = shuffledCopy(queueRest());
      if (upcoming.length) playAt(upcoming.shift());
      else setIcon(play, "play", "Слушать");
      return;
    }
    const target = neighbor(1);
    if (target >= 0) playAt(target);
    else setIcon(play, "play", "Слушать");
  }

  function advance() {
    if (!readyToAdvance) return;
    readyToAdvance = false;
    window.setTimeout(goNext, 0);
  }

  playAt = (nextIndex, keepHistory) => {
    const file = playlist[nextIndex];
    if (!file) return;
    readyToAdvance = false;
    heard.add(file.id);
    if (shuffle && !keepHistory) {
      upcoming = upcoming.filter((item) => item !== nextIndex);
      if (!played.length || played[played.length - 1] !== nextIndex) played.push(nextIndex);
    }
    index = nextIndex;
    slider.value = "0";
    paint();
    node.src = `/api/videos/${file.id}/stream`;
    node.play().then(() => setIcon(play, "pause", "Пауза")).catch(() => setIcon(play, "play", "Слушать"));
  };

  function neighbor(delta) {
    for (let item = index + delta; item >= 0 && item < playlist.length; item += delta) return item;
    return -1;
  }
  play.addEventListener("click", () => {
    if (index < 0) {
      if (shuffle) {
        const order = upcoming.length ? upcoming.slice() : shuffledCopy(ids());
        if (!order.length) return;
        upcoming = order.slice(1);
        played = [];
        playAt(order[0]);
        return;
      }
      const first = playlist.length ? 0 : -1;
      if (first >= 0) playAt(first);
      return;
    }
    if (!node.getAttribute("src")) {
      playAt(index);
      return;
    }
    if (node.paused) node.play().catch(() => {});
    else node.pause();
  });
  previous.addEventListener("click", () => {
    if (index >= 0 && node.currentTime > 3) {
      node.currentTime = 0;
      return;
    }
    if (shuffle) {
      if (played.length > 1) {
        upcoming.unshift(index);
        played.pop();
        playAt(played[played.length - 1], true);
      }
      return;
    }
    const target = neighbor(-1);
    if (target >= 0) playAt(target);
  });
  next.addEventListener("click", () => {
    if (shuffle) {
      if (upcoming.length) playAt(upcoming.shift());
      else if (index < 0) play.click();
      return;
    }
    const target = neighbor(1);
    if (target >= 0) playAt(target);
    else if (index < 0) play.click();
  });
  node.addEventListener("play", () => {
    readyToAdvance = true;
    setIcon(play, "pause", "Пауза");
  });
  node.addEventListener("pause", () => {
    setIcon(play, "play", "Слушать");
    if (node.ended) advance();
  });
  node.addEventListener("loadedmetadata", paint);
  node.addEventListener("timeupdate", () => {
    const current = node.currentTime || 0;
    const duration = Number.isFinite(node.duration) ? node.duration : (playlist[index] && playlist[index].duration) || 0;
    if (!scrubbing && duration) slider.value = String(Math.min(duration, current));
    time.textContent = `${formatDuration(current)}${duration ? ` / ${formatDuration(duration)}` : ""}`;
  });
  node.addEventListener("ended", advance);
  node.addEventListener("error", () => {
    now.textContent = "Не удалось воспроизвести запись";
    setIcon(play, "play", "Слушать");
  });
  slider.addEventListener("pointerdown", () => {
    scrubbing = true;
  });
  slider.addEventListener("change", (event) => {
    scrubbing = false;
    if (!event.isTrusted || index < 0) return;
    node.currentTime = Number(slider.value) || 0;
  });
  const mix = document.createElement("button");
  mix.type = "button";
  setIcon(mix, "shuffle", "Случайный порядок");
  mix.setAttribute("aria-pressed", shuffle ? "true" : "false");
  mix.classList.toggle("on", shuffle);
  mix.addEventListener("click", () => {
    shuffle = !shuffle;
    localStorage.setItem("archive-shuffle", shuffle ? "1" : "0");
    mix.setAttribute("aria-pressed", shuffle ? "true" : "false");
    mix.classList.toggle("on", shuffle);
    refillUpcoming();
  });
  const tail = document.createElement("span");
  tail.className = "tail";
  tail.setAttribute("aria-hidden", "true");
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "text-btn clear";
  clear.textContent = "Очистить";
  clear.addEventListener("click", () => clearPlaylist());
  controls.append(previous, play, next, mix, slider, time, tail, ...sound, clear);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dock-close";
  setIcon(close, "close", "Очистить плейлист");
  close.addEventListener("click", () => clearPlaylist());
  section.append(close, heading, now, node, controls, list);
  dock.append(section);
  paintPlaylist = paint;
  clearPlaylist = () => {
    playlist = [];
    index = -1;
    upcoming = [];
    played = [];
    heard.clear();
    node.pause();
    node.removeAttribute("src");
    savePlaylist();
    paint();
    showDock();
    markPlaylistButtons();
  };
  if (shuffle) refillUpcoming();
  paint();
}

async function renderListingBody(folder, query, gen, play) {
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
  const audios = data.files
    .filter((file) => file.playback === "audio")
    .sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true, sensitivity: "base" }));
  const videos = data.files.filter((file) => file.playback !== "audio");
  const nodes = [];
  if (audios.length) nodes.push(albumSource(audios, data.path, play));
  const folders = data.folders.filter((item) => item.count > 0);
  nodes.push(...folders.map(folderRow), ...videos.map(fileRow));
  if (!nodes.length) {
    const scanning = statusEl.textContent.startsWith("Идёт обновление");
    nodes.push(note(scanning ? "Каталог обновляется. Файлы появятся по мере обхода." : "В этой папке пусто."));
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

function iconSvg(name) {
  const paths = {
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>',
    previous: '<path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>',
    next: '<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6z"/>',
    volume: '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12z"/>',
    muted: '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM3 9v6h4l5 5v-6.73l-9-9L4.27 3 3 4.27 7.73 9H3zm9-5-2.09 2.09L12 8.18V4z"/>',
    fullscreen: '<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>',
    exit: '<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>',
    close: '<path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/>',
    shuffle: '<path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
}

function setIcon(button, name, label) {
  button.classList.add("icon");
  button.setAttribute("aria-label", label);
  button.innerHTML = iconSvg(name);
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
    setIcon(mute, audible ? "volume" : "muted", audible ? "Без звука" : "Звук");
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
  slider.addEventListener("wheel", (event) => {
    event.preventDefault();
    const notch = event.deltaMode === 1 ? event.deltaY * 0.05 : event.deltaY / 100 * 0.05;
    const current = node.muted ? 0 : node.volume;
    const next = Math.min(1, Math.max(0, current - notch));
    if (next > 0) level = next;
    node.volume = next > 0 ? next : level;
    node.muted = next === 0;
    saveSound(level, next === 0);
    paint();
  }, { passive: false });
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
  setIcon(play, "play", "Смотреть");
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
  const heights = video.qualities || [];
  let height = heights[0] || 0;
  const maxHeight = height;
  const canDirect = video.playback === "direct" && (video.audio_tracks || []).length < 2;
  let playing = false;
  let playToken = 0;
  bindProgress(video, () => position, () => playing);

  function directNow() {
    return canDirect && (!height || height === maxHeight);
  }

  function start(at) {
    const token = ++playToken;
    position = at;
    playing = true;
    if (directNow()) {
      offset = 0;
      const playAt = () => {
        if (token !== playToken) return;
        if (at > 0) {
          const limit = Number.isFinite(node.duration) ? Math.max(0, node.duration - 0.25) : at;
          node.currentTime = Math.min(at, limit);
        }
        node.play().catch(() => {});
      };
      if (node.dataset.mode !== "direct") {
        node.dataset.mode = "direct";
        node.src = `/api/videos/${video.id}/stream`;
        node.addEventListener("loadedmetadata", playAt, { once: true });
      } else {
        playAt();
      }
    } else {
      offset = at;
      node.dataset.mode = "remux";
      const quality = height ? `&h=${height}` : "";
      node.src = nativeHls
        ? `/api/videos/${video.id}/hls.m3u8?t=${at.toFixed(3)}&a=${audio}${quality}`
        : `/api/videos/${video.id}/stream?t=${at.toFixed(3)}&a=${audio}${quality}`;
      node.play().catch(() => {});
    }
    setIcon(play, "pause", "Пауза");
    rememberNow();
    showControls();
  }

  play.addEventListener("click", () => {
    if (!node.getAttribute("src")) {
      start(Number(slider.value) || 0);
      return;
    }
    if (node.paused) {
      node.play();
      setIcon(play, "pause", "Пауза");
    } else {
      node.pause();
      setIcon(play, "play", "Смотреть");
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
    setIcon(play, "play", "Смотреть");
    playNext(video);
  });
  node.addEventListener("error", () => {
    playerEl.append(note("Не удалось начать воспроизведение. Подождите несколько секунд и нажмите «Смотреть» ещё раз."));
  });
  slider.addEventListener("change", () => start(Number(slider.value) || 0));
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  setIcon(fullscreen, "fullscreen", "На весь экран");
  const stage = document.createElement("div");
  stage.className = "stage paused awake";
  let controlsTimer = 0;
  let pointerDown = false;
  function wakeControls() {
    stage.classList.add("awake");
    window.clearTimeout(controlsTimer);
    if (pointerDown || node.paused || !node.getAttribute("src")) return;
    controlsTimer = window.setTimeout(() => {
      if (!stage.isConnected || pointerDown) return;
      stage.classList.remove("awake");
    }, 5000);
  }
  stage.wake = wakeControls;
  function showControls() {
    const paused = node.paused || !node.getAttribute("src");
    stage.classList.toggle("paused", paused);
    wakeControls();
  }
  node.addEventListener("play", showControls);
  node.addEventListener("pause", showControls);
  node.addEventListener("click", () => play.click());
  stage.addEventListener("pointermove", wakeControls);
  stage.addEventListener("pointerdown", () => {
    pointerDown = true;
    wakeControls();
  });
  stage.addEventListener("pointerup", () => {
    pointerDown = false;
    wakeControls();
  });
  stage.addEventListener("pointercancel", () => {
    pointerDown = false;
    wakeControls();
  });
  bindFullscreen(stage, node, fullscreen);
  if (previous) controls.append(previous);
  controls.append(play);
  if (next) controls.append(next);
  controls.append(slider, time, ...sound);
  const tracks = audioSelect(video, (index) => {
    audio = index;
    if (node.getAttribute("src")) start(offset + (node.currentTime || 0));
  });
  const quality = qualitySelect(video, (next) => {
    height = next;
    if (node.getAttribute("src")) start(offset + (node.currentTime || 0));
  });
  const tail = document.createElement("span");
  tail.className = "tail";
  tail.setAttribute("aria-hidden", "true");
  controls.append(tail);
  if (quality) controls.append(quality);
  if (tracks) controls.append(tracks);
  controls.append(fullscreen);
  stage.append(node, controls);
  playerEl.append(stage);
  if (autoplay) start(begin);
}

function qualitySelect(video, onChange) {
  const heights = video.qualities || [];
  if (heights.length < 2) return null;
  const select = document.createElement("select");
  select.className = "quality";
  select.setAttribute("aria-label", "Качество");
  heights.forEach((item) => {
    const option = document.createElement("option");
    option.value = String(item);
    option.textContent = `${item}p`;
    select.append(option);
  });
  select.addEventListener("change", () => onChange(Number(select.value) || heights[0]));
  return select;
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
    setIcon(button, active ? "exit" : "fullscreen", active ? "Обычный размер" : "На весь экран");
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
  if (video.playback === "audio") {
    const url = new URL("/", location.origin);
    if (video.folder) url.searchParams.set("path", video.folder);
    url.searchParams.set("play", String(video.id));
    history.replaceState({}, "", url);
    render();
    return;
  }
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
  const heights = video.qualities || [];
  if (video.playback === "direct" && (video.audio_tracks || []).length < 2 && heights.length < 2) {
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
  setIcon(previousFull, "previous", "Предыдущее");
  setIcon(nextFull, "next", "Следующее");
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
  await renderListing(route.folder, route.q, route.play);
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

document.querySelector("#home").addEventListener("click", () => navigateListing({}));

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
  const stage = playerEl.querySelector(".stage");
  if (stage && !playerEl.hidden && stage.wake) {
    const tag = event.target && event.target.tagName;
    const outsideField = (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") && !stage.contains(event.target);
    if (!outsideField) stage.wake();
  }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (playerEl.hidden) {
    const album = !dock.hidden && dock.querySelector(".album");
    if (!album) return;
    const field = event.target;
    const fieldTag = field && field.tagName;
    if (fieldTag === "INPUT" || fieldTag === "TEXTAREA" || fieldTag === "SELECT" || (field && field.isContentEditable)) return;
    if (event.key === " ") {
      if (event.repeat || (field && field.closest && field.closest("button"))) return;
      event.preventDefault();
      const albumPlay = album.querySelector(".controls .play");
      if (albumPlay) albumPlay.click();
    }
    return;
  }
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
showDock();
render();
refreshStatus();
setInterval(refreshStatus, 5000);
