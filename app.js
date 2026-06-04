const DATA_URL = "./data/channels.json";
const FALLBACK_URL = "./data/fallback-channels.json";
const SOURCE_BUTTON_LIMIT = 8;
const STARTUP_RECOVERY_DELAY_MS = 28000;
const PLAYBACK_STALL_DELAY_MS = 24000;
const FATAL_RECOVERY_DELAY_MS = 7000;
const RECOVERY_SETTLE_MS = 18000;
const MAX_CURRENT_SOURCE_RECOVERIES = 1;
const HTTPS_HLS_PROXY_PREFIX = "https://api.codetabs.com/v1/proxy?quest=";
const SERVICE_WORKER_URL = "./sw.js?v=20260604-12";
const HLS_PROXY_PATH = "./__hls_proxy__";
const CHANNEL_CATEGORIES = [
  { id: "all", label: "全部" },
  { id: "cctv", label: "央视" },
  { id: "satellite", label: "卫视" },
  { id: "special", label: "专题" },
  { id: "hkmt", label: "港澳台" },
  { id: "other", label: "其他" }
];

const player = document.querySelector("#player");
const videoFrame = document.querySelector(".video-frame");
const playOverlay = document.querySelector("#playOverlay");
const playPauseButton = document.querySelector("#playPauseButton");
const muteButton = document.querySelector("#muteButton");
const volumeSlider = document.querySelector("#volumeSlider");
const channelList = document.querySelector("#channelList");
const channelName = document.querySelector("#channelName");
const programName = document.querySelector("#programName");
const statusText = document.querySelector("#statusText");
const sourceHealth = document.querySelector("#sourceHealth");
const scheduleChannel = document.querySelector("#scheduleChannel");
const scheduleList = document.querySelector("#scheduleList");
const sourceList = document.querySelector("#sourceList");
const centerToast = document.querySelector("#centerToast");
const refreshButton = document.querySelector("#refreshButton");
const channelSearch = document.querySelector("#channelSearch");
const categoryTabs = document.querySelector("#categoryTabs");
const libraryButton = document.querySelector("#libraryButton");
const libraryModal = document.querySelector("#libraryModal");
const libraryCloseButton = document.querySelector("#libraryCloseButton");
const librarySearch = document.querySelector("#librarySearch");
const libraryTabs = document.querySelector("#libraryTabs");
const libraryList = document.querySelector("#libraryList");
const castButton = document.querySelector("#castButton");
const castModal = document.querySelector("#castModal");
const castCloseButton = document.querySelector("#castCloseButton");
const castChannelTitle = document.querySelector("#castChannelTitle");
const castSourceTitle = document.querySelector("#castSourceTitle");
const castPlaylistUrl = document.querySelector("#castPlaylistUrl");
const castSourceUrl = document.querySelector("#castSourceUrl");
const airplayButton = document.querySelector("#airplayButton");
const copyPlaylistButton = document.querySelector("#copyPlaylistButton");
const copySourceButton = document.querySelector("#copySourceButton");
const openPlaylistLink = document.querySelector("#openPlaylistLink");
const pageMaxButton = document.querySelector("#pageMaxButton");
const theaterButton = document.querySelector("#theaterButton");
const systemFullscreenButton = document.querySelector("#systemFullscreenButton");

const state = {
  channels: [],
  channelIndex: 0,
  sourceIndex: 0,
  hls: null,
  recoveryTimer: null,
  toastTimer: null,
  failedSources: new Set(),
  sourceRecoveries: new Map(),
  sourceLoadStartedAt: 0,
  sourceLoadToken: 0,
  nativePlaylistObjectUrl: "",
  hlsProxyWorkerReady: null,
  lastProgressAt: 0,
  lastCurrentTime: 0,
  autoplayRequested: false,
  userPaused: false,
  suppressPauseTrackingUntil: 0,
  pendingPlayIntentUntil: 0,
  guideQuery: "",
  guideCategory: "all",
  libraryQuery: "",
  libraryCategory: "all",
  libraryOpen: false,
  castOpen: false,
  pageMaximized: false,
  theaterMode: false,
  initialized: false
};

init();

async function init() {
  state.channels = await loadChannels();
  renderChannels();
  renderLibrary();
  bindControls();
  registerHlsProxyWorker();

  const savedChannel = Number(localStorage.getItem("fatfeet-tv-channel") || 0);
  const startIndex = Number.isFinite(savedChannel) ? savedChannel : 0;
  tuneTo(clamp(startIndex, 0, state.channels.length - 1), { autoplay: false });
}

async function loadChannels() {
  for (const url of [DATA_URL, FALLBACK_URL]) {
    try {
      const response = await fetch(`${url}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) continue;
      const payload = await response.json();
      const channels = Array.isArray(payload.channels) ? payload.channels : [];
      const playable = channels.filter((channel) => getChannelSources(channel).some((source) => source.status !== "bad"));
      if (playable.length) return playable;
    } catch {
      // Try the next local data file.
    }
  }

  return [];
}

function bindControls() {
  player.addEventListener("waiting", () => scheduleSourceRecovery("正在缓冲，先保持当前线路"));
  player.addEventListener("stalled", () => scheduleSourceRecovery("直播信号停顿，正在等待恢复"));
  player.addEventListener("error", () =>
    scheduleSourceRecovery("播放中断，正在重连当前线路", {
      delay: FATAL_RECOVERY_DELAY_MS,
      force: state.autoplayRequested
    })
  );
  player.addEventListener("canplay", notePlaybackProgress);
  player.addEventListener("progress", notePlaybackProgress);
  player.addEventListener("timeupdate", notePlaybackProgress);
  player.addEventListener("click", togglePlayback);
  player.addEventListener("keydown", (event) => {
    if (player.paused && [" ", "Enter", "k", "K"].includes(event.key)) queuePlaybackIntent();
  });
  player.addEventListener("play", () => {
    markPlaybackWanted();
    syncPlayOverlay();
  });
  player.addEventListener("pause", () => {
    if (isPauseTrackingSuppressed()) return;
    state.userPaused = true;
    state.autoplayRequested = false;
    state.pendingPlayIntentUntil = 0;
    clearRecoveryTimer();
    setStatus("已暂停", "warn");
    sourceHealth.textContent = `线路 ${state.sourceIndex + 1} 暂停`;
    syncPlayOverlay();
  });
  player.addEventListener("playing", () => {
    markPlaybackWanted({ watchStartup: false });
    notePlaybackProgress();
    clearRecoveryTimer();
    setStatus("播放中", "good");
    syncPlayOverlay();
  });
  player.addEventListener("volumechange", syncPlayerControls);

  playOverlay.addEventListener("click", queuePlaybackIntent);
  playPauseButton.addEventListener("click", togglePlayback);
  muteButton.addEventListener("click", toggleMuted);
  volumeSlider.addEventListener("input", updateVolumeFromSlider);
  castButton.addEventListener("click", startCasting);
  castCloseButton.addEventListener("click", () => closeCastPanel());
  castModal.addEventListener("click", (event) => {
    if (event.target === castModal) closeCastPanel();
  });
  airplayButton.addEventListener("click", startNativeAirPlay);
  copyPlaylistButton.addEventListener("click", copyPlaylistLink);
  copySourceButton.addEventListener("click", copyCurrentSourceLink);
  pageMaxButton.addEventListener("click", togglePageMaximized);
  theaterButton.addEventListener("click", toggleTheaterMode);
  systemFullscreenButton.addEventListener("click", toggleSystemFullscreen);
  document.addEventListener("fullscreenchange", syncSystemFullscreenButton);
  document.addEventListener("webkitfullscreenchange", syncSystemFullscreenButton);

  refreshButton.addEventListener("click", refreshCatalog);
  channelSearch.addEventListener("input", () => {
    state.guideQuery = channelSearch.value.trim();
    renderChannels();
  });
  libraryButton.addEventListener("click", () => openLibrary(true));
  libraryCloseButton.addEventListener("click", () => openLibrary(false));
  libraryModal.addEventListener("click", (event) => {
    if (event.target === libraryModal) openLibrary(false);
  });
  librarySearch.addEventListener("input", () => {
    state.libraryQuery = librarySearch.value.trim();
    renderLibrary();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (state.castOpen) {
      closeCastPanel();
      return;
    }
    if (state.libraryOpen) {
      openLibrary(false);
      return;
    }
    if (state.pageMaximized) togglePageMaximized();
  });
  applyViewModeState();
  syncPlayerControls();
}

function tuneTo(index, options = {}) {
  const channel = state.channels[index];
  if (!channel) {
    showToast("没有可播放频道");
    return;
  }

  if (options.autoplay) state.userPaused = false;
  state.channelIndex = index;
  state.sourceIndex = pickPreferredSource(channel);
  resetChannelFailures(channel);
  state.initialized = true;
  localStorage.setItem("fatfeet-tv-channel", String(index));

  updateNowPlaying(channel);
  renderChannels();
  if (state.libraryOpen) renderLibrary();
  renderSchedule(channel);
  renderSources(channel);
  if (state.castOpen) updateCastPanel();
  loadCurrentSource(options);
  showToast(channel.name);
}

function pickPreferredSource(channel) {
  const sources = getChannelSources(channel);
  if (!sources.length) return 0;
  const needsHttps = window.location.protocol === "https:";
  const preferred = sources.findIndex((source) => isSourceUsable(channel, source) && source.status === "ok" && (!needsHttps || source.url.startsWith("https://")));
  if (preferred >= 0) return preferred;
  const protocolSafe = sources.findIndex((source) => isSourceUsable(channel, source) && (!needsHttps || source.url.startsWith("https://")));
  if (protocolSafe >= 0) return protocolSafe;
  const anyOk = sources.findIndex((source) => isSourceUsable(channel, source) && source.status === "ok");
  if (anyOk >= 0) return anyOk;
  return 0;
}

async function loadCurrentSource({ autoplay = true } = {}) {
  const channel = state.channels[state.channelIndex];
  const source = getChannelSources(channel)[state.sourceIndex];
  if (!source) return;

  clearRecoveryTimer();
  const sourceLoadToken = ++state.sourceLoadToken;
  state.sourceLoadStartedAt = Date.now();
  state.lastProgressAt = 0;
  state.lastCurrentTime = 0;
  const shouldAutoplay = autoplay && !state.userPaused;
  state.autoplayRequested = shouldAutoplay;
  const nativeHls = !isDirectMediaSource(source) && shouldUseNativeHls(source);
  const nativeProxyingHls = nativeHls && shouldUseNativeHlsProxy(source);
  const proxyingHls = !nativeHls && shouldProxyHlsSource(source);
  syncAirPlayAttribute(source, nativeProxyingHls);
  const sourceMode = nativeProxyingHls ? " 手机代理" : nativeHls && canUseNativeAirPlay() ? " 原生" : proxyingHls ? " 代理" : "";
  setStatus(
    nativeProxyingHls
      ? "手机代理连接中"
      : nativeHls && canUseNativeAirPlay()
        ? "AirPlay 原生线路"
        : proxyingHls
          ? "线上代理连接中"
          : source.status === "ok"
            ? "连接稳定"
            : "尝试线路",
    source.status === "ok" ? "good" : "warn"
  );
  sourceHealth.textContent = `线路 ${state.sourceIndex + 1}${sourceMode}`;
  renderSources(channel);

  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }
  suppressPauseTracking();
  clearNativePlaylistObjectUrl();
  player.removeAttribute("src");
  player.load();

  if (isDirectMediaSource(source)) {
    player.src = source.url;
  } else if (nativeProxyingHls) {
    const loaded = await loadNativeProxiedHlsSource(source, sourceLoadToken);
    if (!loaded) return;
  } else if (shouldUseNativeHls(source)) {
    player.src = source.url;
  } else if (window.Hls?.isSupported()) {
    state.hls = new window.Hls({
      loader: proxyingHls ? createHttpsProxyLoader() : undefined,
      lowLatencyMode: false,
      liveSyncDurationCount: 8,
      liveMaxLatencyDurationCount: 18,
      maxBufferLength: 60,
      backBufferLength: 30
    });
    state.hls.loadSource(source.url);
    state.hls.attachMedia(player);
    state.hls.on(window.Hls.Events.ERROR, (_, data) => {
      console.warn("HLS playback error", data);
      if (data?.fatal) handleFatalHlsError(data);
    });
  } else {
    player.src = source.url;
    setStatus("浏览器可能不支持 HLS", "warn");
  }

  if (shouldAutoplay) {
    player.play().catch(() => {
      setStatus("点击播放按钮开始", "warn");
      syncPlayOverlay();
    });
  }
  syncPlayOverlay();
}

function scheduleSourceRecovery(message, options = {}) {
  if (state.userPaused) return;
  if (!options.force && player.paused && !hasPlaybackStarted() && !hasPendingPlayIntent()) return;
  clearRecoveryTimer();
  setStatus(message, "warn");
  sourceHealth.textContent = `线路 ${state.sourceIndex + 1} 缓冲`;
  const delay = options.delay || recoveryDelayForCurrentState();
  state.recoveryTimer = window.setTimeout(() => {
    recoverCurrentSourceOrSwitch(message);
  }, delay);
}

function handleFatalHlsError(data) {
  if (state.userPaused) return;

  if (data?.type === window.Hls?.ErrorTypes?.MEDIA_ERROR && state.hls?.recoverMediaError) {
    setStatus("正在恢复画面", "warn");
    state.hls.recoverMediaError();
    scheduleSourceRecovery("画面恢复中，先保持当前线路", {
      delay: RECOVERY_SETTLE_MS,
      force: state.autoplayRequested
    });
    return;
  }

  if (data?.type === window.Hls?.ErrorTypes?.NETWORK_ERROR && state.hls?.startLoad) {
    state.hls.startLoad();
  }

  scheduleSourceRecovery("线路连接中断，正在重连当前线路", {
    delay: FATAL_RECOVERY_DELAY_MS,
    force: state.autoplayRequested
  });
}

function recoverCurrentSourceOrSwitch(message) {
  if (state.userPaused) {
    clearRecoveryTimer();
    setStatus("已暂停", "warn");
    sourceHealth.textContent = `线路 ${state.sourceIndex + 1} 暂停`;
    return;
  }

  if (!player.paused && hasRecentProgress()) {
    clearRecoveryTimer();
    setStatus("播放中", "good");
    sourceHealth.textContent = `线路 ${state.sourceIndex + 1}`;
    return;
  }

  const channel = state.channels[state.channelIndex];
  const source = getChannelSources(channel)[state.sourceIndex];
  if (!source) return;

  const key = sourceKey(channel, source);
  const attempts = state.sourceRecoveries.get(key) || 0;
  if (attempts < MAX_CURRENT_SOURCE_RECOVERIES) {
    state.sourceRecoveries.set(key, attempts + 1);
    setStatus(`重连当前线路 ${attempts + 1}/${MAX_CURRENT_SOURCE_RECOVERIES}`, "warn");
    sourceHealth.textContent = `线路 ${state.sourceIndex + 1} 重连`;
    loadCurrentSource({ autoplay: true });
    state.recoveryTimer = window.setTimeout(() => {
      recoverCurrentSourceOrSwitch(message);
    }, RECOVERY_SETTLE_MS);
    return;
  }

  switchSource(`${message}，正在换线`);
}

function recoveryDelayForCurrentState() {
  if (player.paused && hasPendingPlayIntent()) return FATAL_RECOVERY_DELAY_MS;
  return hasPlaybackStarted() ? PLAYBACK_STALL_DELAY_MS : STARTUP_RECOVERY_DELAY_MS;
}

function hasPlaybackStarted() {
  return (player.currentTime || 0) > 0.5 || state.lastCurrentTime > 0.5 || player.readyState >= 2;
}

function hasRecentProgress() {
  const recentProgress = state.lastProgressAt && Date.now() - state.lastProgressAt < 6000;
  return recentProgress && player.readyState >= 2;
}

function notePlaybackProgress() {
  const currentTime = player.currentTime || 0;
  if (currentTime > state.lastCurrentTime + 0.05 || player.readyState >= 2) {
    state.lastCurrentTime = Math.max(state.lastCurrentTime, currentTime);
    state.lastProgressAt = Date.now();
  }
}

function clearRecoveryTimer() {
  if (state.recoveryTimer) {
    window.clearTimeout(state.recoveryTimer);
    state.recoveryTimer = null;
  }
}

async function loadNativeProxiedHlsSource(source, sourceLoadToken) {
  try {
    const serviceWorkerReady = await ensureHlsProxyWorkerReady();
    if (serviceWorkerReady) {
      if (sourceLoadToken !== state.sourceLoadToken) return false;
      player.src = nativeHlsProxyUrl(source.url);
      return true;
    }

    const response = await fetch(proxyHlsUrl(source.url), { cache: "no-store" });
    if (!response.ok) throw new Error(`Proxy returned ${response.status}`);

    const playlist = await response.text();
    if (!playlist.includes("#EXTM3U")) throw new Error("Proxy did not return an HLS playlist");

    const rewrittenPlaylist = rewriteHlsPlaylist(playlist, source.url);
    const playlistBlob = new Blob([rewrittenPlaylist], {
      type: "application/vnd.apple.mpegurl"
    });
    const playlistUrl = URL.createObjectURL(playlistBlob);

    if (sourceLoadToken !== state.sourceLoadToken) {
      URL.revokeObjectURL(playlistUrl);
      return false;
    }

    state.nativePlaylistObjectUrl = playlistUrl;
    player.src = playlistUrl;
    return true;
  } catch (error) {
    console.warn("Native HLS proxy failed", error);
    if (sourceLoadToken !== state.sourceLoadToken) return false;

    setStatus("手机代理连接失败", "warn");
    sourceHealth.textContent = `线路 ${state.sourceIndex + 1} 手机代理失败`;
    if (state.autoplayRequested || hasPendingPlayIntent()) {
      scheduleSourceRecovery("手机代理连接失败，正在换线", {
        delay: FATAL_RECOVERY_DELAY_MS,
        force: true
      });
    }
    return false;
  }
}

function clearNativePlaylistObjectUrl() {
  if (!state.nativePlaylistObjectUrl) return;
  URL.revokeObjectURL(state.nativePlaylistObjectUrl);
  state.nativePlaylistObjectUrl = "";
}

function registerHlsProxyWorker() {
  if (!canUseHlsProxyWorker()) return;
  ensureHlsProxyWorkerReady();
}

function canUseHlsProxyWorker() {
  return "serviceWorker" in window.navigator && window.isSecureContext;
}

function ensureHlsProxyWorkerReady() {
  if (!canUseHlsProxyWorker()) return Promise.resolve(false);
  if (state.hlsProxyWorkerReady) return state.hlsProxyWorkerReady;

  state.hlsProxyWorkerReady = window.navigator.serviceWorker
    .register(SERVICE_WORKER_URL, { scope: "./" })
    .then(async (registration) => {
      const worker = registration.installing || registration.waiting || registration.active;
      if (worker && worker.state !== "activated") {
        await waitForServiceWorkerActivation(worker);
      }

      await window.navigator.serviceWorker.ready;
      if (!window.navigator.serviceWorker.controller) {
        await waitForServiceWorkerController();
      }

      return Boolean(window.navigator.serviceWorker.controller);
    })
    .catch((error) => {
      console.warn("HLS proxy service worker unavailable", error);
      return false;
    });

  return state.hlsProxyWorkerReady;
}

function waitForServiceWorkerActivation(worker) {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 2200);
    worker.addEventListener(
      "statechange",
      () => {
        if (worker.state === "activated") {
          window.clearTimeout(timeout);
          resolve();
        }
      },
      { once: false }
    );
  });
}

function waitForServiceWorkerController() {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(resolve, 2200);
    window.navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

function nativeHlsProxyUrl(url) {
  const proxyUrl = new URL(HLS_PROXY_PATH, window.location.href);
  proxyUrl.searchParams.set("kind", "playlist");
  proxyUrl.searchParams.set("url", url);
  proxyUrl.searchParams.set("v", String(Date.now()));
  return proxyUrl.toString();
}

function queuePlaybackIntent() {
  markPlaybackWanted({ attemptPlay: true });
}

function togglePlayback() {
  if (player.paused) {
    queuePlaybackIntent();
    return;
  }

  player.pause();
}

function markPlaybackWanted({ attemptPlay = false, watchStartup = true } = {}) {
  state.userPaused = false;
  state.autoplayRequested = true;
  state.pendingPlayIntentUntil = Date.now() + FATAL_RECOVERY_DELAY_MS + 1500;

  if (attemptPlay && player.paused && typeof player.play === "function") {
    player.play().catch(() => {
      setStatus("点击播放按钮开始", "warn");
      syncPlayOverlay();
    });
  }

  if (watchStartup && !state.recoveryTimer) {
    state.recoveryTimer = window.setTimeout(() => {
      if (!state.userPaused && hasPendingPlayIntent() && (player.paused || !hasPlaybackStarted())) {
        recoverCurrentSourceOrSwitch("播放没有启动");
      }
    }, FATAL_RECOVERY_DELAY_MS);
  }

  syncPlayOverlay();
}

function hasPendingPlayIntent() {
  return Date.now() < state.pendingPlayIntentUntil;
}

function syncPlayOverlay() {
  playOverlay.hidden = !player.paused;
  syncPlayerControls();
}

function toggleMuted() {
  player.muted = !player.muted;
  if (!player.muted && Number(volumeSlider.value) === 0) {
    setPlayerVolume(0.7);
    volumeSlider.value = "0.7";
  }
  syncPlayerControls();
}

function updateVolumeFromSlider() {
  const value = Number(volumeSlider.value);
  if (Number.isFinite(value)) {
    setPlayerVolume(value);
    player.muted = value === 0;
  }
  syncPlayerControls();
}

function setPlayerVolume(value) {
  try {
    player.volume = clamp(value, 0, 1);
  } catch {
    // Some mobile browsers keep volume under hardware control.
  }
}

function syncPlayerControls() {
  const isPlaying = !player.paused;
  const isMuted = player.muted || player.volume === 0;

  playPauseButton.classList.toggle("is-playing", isPlaying);
  playPauseButton.setAttribute("aria-label", isPlaying ? "暂停" : "播放");
  playPauseButton.title = isPlaying ? "暂停" : "播放";

  muteButton.classList.toggle("is-muted", isMuted);
  muteButton.setAttribute("aria-label", isMuted ? "取消静音" : "静音");
  muteButton.title = isMuted ? "取消静音" : "静音";

  if (Number(volumeSlider.value) !== player.volume) {
    volumeSlider.value = String(player.volume);
  }
}

function suppressPauseTracking(durationMs = 900) {
  state.suppressPauseTrackingUntil = Math.max(state.suppressPauseTrackingUntil, Date.now() + durationMs);
}

function isPauseTrackingSuppressed() {
  return Date.now() < state.suppressPauseTrackingUntil;
}

function switchSource(message) {
  if (state.userPaused) return;

  const channel = state.channels[state.channelIndex];
  const sources = getChannelSources(channel);
  if (!sources.length) return;

  clearRecoveryTimer();

  markSourceFailed(channel, state.sourceIndex);
  renderChannels();
  if (state.libraryOpen) renderLibrary();

  if (sources.length <= 1) {
    setStatus("暂无备用线路", "warn");
    showToast("暂无备用线路");
    renderSources(channel);
    return;
  }

  const nextIndex = nextSourceIndex(channel, state.sourceIndex);
  if (nextIndex === null) {
    clearRecoveryTimer();
    setStatus("本频道暂无更多可用线路", "bad");
    sourceHealth.textContent = "已试完";
    showToast("本频道线路已全部尝试，可刷新列表后再试");
    renderSources(channel);
    return;
  }

  state.sourceIndex = nextIndex;
  setStatus("正在优化线路", "warn");
  showToast(message);
  loadCurrentSource({ autoplay: true });
}

function selectSource(index) {
  const channel = state.channels[state.channelIndex];
  const source = getChannelSources(channel)[index];
  if (!source) return;
  clearSourceFailure(channel, index);
  state.userPaused = false;
  state.sourceRecoveries.delete(sourceKey(channel, source));
  state.sourceIndex = index;
  setStatus(`切换到线路 ${index + 1}`, "warn");
  showToast(`线路 ${index + 1}`);
  if (state.libraryOpen) renderLibrary();
  if (state.castOpen) updateCastPanel();
  loadCurrentSource({ autoplay: true });
}

async function refreshCatalog() {
  refreshButton.disabled = true;
  refreshButton.textContent = "刷新中";
  setStatus("正在刷新列表", "warn");

  const currentId = state.channels[state.channelIndex]?.id;
  const refreshed = await loadChannels();
  if (refreshed.length) {
    state.channels = refreshed;
    const nextIndex = Math.max(0, state.channels.findIndex((channel) => channel.id === currentId));
    tuneTo(nextIndex, { autoplay: state.initialized && !state.userPaused });
    showToast("列表已刷新");
  } else {
    showToast("刷新失败，保留当前列表");
  }

  refreshButton.disabled = false;
  refreshButton.textContent = "刷新列表";
}

function nextSourceIndex(channel, currentIndex) {
  const sources = getChannelSources(channel);
  const needsHttps = window.location.protocol === "https:";
  for (let offset = 1; offset <= sources.length; offset += 1) {
    const index = (currentIndex + offset) % sources.length;
    if (isSourceUsable(channel, sources[index]) && (!needsHttps || sources[index].url.startsWith("https://"))) return index;
  }

  for (let offset = 1; offset <= sources.length; offset += 1) {
    const index = (currentIndex + offset) % sources.length;
    if (isSourceUsable(channel, sources[index])) return index;
  }

  return null;
}

function renderChannels() {
  channelList.innerHTML = "";
  renderCategoryTabs(categoryTabs, state.guideCategory, (categoryId) => {
    state.guideCategory = categoryId;
    renderChannels();
  });

  const items = getFilteredChannelItems(state.guideQuery, state.guideCategory);
  if (!items.length) {
    channelList.innerHTML = `<div class="channel-empty">没有匹配的频道</div>`;
    return;
  }

  items.forEach(({ channel, index }) => {
    const button = document.createElement("button");
    button.className = `channel-row${index === state.channelIndex ? " is-active" : ""}`;
    button.type = "button";
    button.addEventListener("click", () => tuneTo(index, { autoplay: true }));

    const sources = getChannelSources(channel);
    const availableCount = sources.filter((source) => isSourceUsable(channel, source)).length;
    const dotClass = availableCount > 0 ? "" : " warn";
    button.innerHTML = `
      <span class="channel-number">${String(index + 1).padStart(2, "0")}</span>
      <span>
        <span class="channel-title">${escapeHtml(channel.name)}</span>
        <span class="channel-meta">${escapeHtml(channel.group || "直播")} · ${availableCount}/${sources.length} 条线路</span>
      </span>
      <span class="health-dot${dotClass}"></span>
    `;
    channelList.appendChild(button);
  });

  const active = channelList.querySelector(".is-active");
  active?.scrollIntoView({ block: "nearest" });
}

function renderLibrary() {
  libraryList.innerHTML = "";
  renderCategoryTabs(libraryTabs, state.libraryCategory, (categoryId) => {
    state.libraryCategory = categoryId;
    renderLibrary();
  });

  const items = getFilteredChannelItems(state.libraryQuery, state.libraryCategory);
  if (!items.length) {
    libraryList.innerHTML = `<div class="library-empty">没有匹配的频道</div>`;
    return;
  }

  items.forEach(({ channel, index }) => {
    const button = document.createElement("button");
    button.className = `library-channel${index === state.channelIndex ? " is-active" : ""}`;
    button.type = "button";
    button.addEventListener("click", () => {
      tuneTo(index, { autoplay: true });
      openLibrary(false);
    });

    const sources = getChannelSources(channel);
    const availableCount = sources.filter((source) => isSourceUsable(channel, source)).length;
    button.innerHTML = `
      <span class="channel-number">${String(index + 1).padStart(2, "0")}</span>
      <span>
        <span class="channel-title">${escapeHtml(channel.name)}</span>
        <span class="channel-meta">${escapeHtml(channel.group || "直播")} · ${availableCount}/${sources.length} 条线路</span>
      </span>
    `;
    libraryList.appendChild(button);
  });
}

function renderCategoryTabs(container, activeId, onSelect) {
  container.innerHTML = "";
  CHANNEL_CATEGORIES.forEach((category) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `category-button${category.id === activeId ? " is-active" : ""}`;
    button.setAttribute("aria-pressed", String(category.id === activeId));
    button.textContent = category.label;
    button.addEventListener("click", () => onSelect(category.id));
    container.appendChild(button);
  });
}

function getFilteredChannelItems(query, categoryId) {
  const normalizedQuery = query.trim().toLowerCase();
  return state.channels
    .map((channel, index) => ({ channel, index }))
    .filter(({ channel, index }) => {
      if (categoryId !== "all" && channelCategoryId(channel) !== categoryId) return false;
      if (!normalizedQuery) return true;
      return channelSearchText(channel, index).includes(normalizedQuery);
    });
}

function channelSearchText(channel, index) {
  return `${index + 1} ${channel.name || ""} ${channel.group || ""} ${channel.category || ""} ${channel.current || ""}`.toLowerCase();
}

function channelCategoryId(channel) {
  const text = `${channel.name || ""} ${channel.group || ""} ${channel.category || ""}`;
  if (/CCTV-?\d|CGTN|央视|央视频道|中央/.test(text) && !/风云|剧场|怀旧|世界地理|兵器|女性时尚|台球|高尔夫|卡通|少儿|动漫|动画/.test(text)) return "cctv";
  if (/风云|剧场|怀旧|世界地理|兵器|女性时尚|台球|高尔夫|卡通|少儿|动漫|动画|金鹰|卡酷|优漫|嘉佳|哈哈|炫动|游戏风云|梨园|法治天地|劲爆体育/.test(text)) return "special";
  if (/香港|澳门|台湾|凤凰|翡翠|TVB|港台|澳视|民视|中天|东森|三立/.test(text)) return "hkmt";
  if (/卫视/.test(text)) return "satellite";
  return "other";
}

function renderSchedule(channel) {
  scheduleChannel.textContent = channel.name;
  const programs = channel.programs?.length
    ? channel.programs
    : [
        { time: "现在", title: "直播节目" },
        { time: "稍后", title: "节目单更新中" },
        { time: "全天", title: "自动切换稳定线路" }
      ];

  scheduleList.innerHTML = programs
    .slice(0, 4)
    .map(
      (program) => `
        <div class="program-row">
          <span>${escapeHtml(program.time)}</span>
          <strong>${escapeHtml(program.title)}</strong>
        </div>
      `
    )
    .join("");
}

function renderSources(channel) {
  sourceList.innerHTML = "";
  const sources = getChannelSources(channel);
  const visible = sources
    .map((source, index) => ({ source, index }))
    .slice(0, SOURCE_BUTTON_LIMIT);

  if (sources[state.sourceIndex] && !visible.some((item) => item.index === state.sourceIndex)) {
    visible.push({ source: sources[state.sourceIndex], index: state.sourceIndex });
  }

  visible.forEach(({ source, index }) => {
    const button = document.createElement("button");
    button.type = "button";
    const failed = isSourceFailed(channel, source);
    button.className = `source-row${index === state.sourceIndex ? " is-active" : ""}${failed ? " is-failed" : ""}`;
    button.disabled = false;
    button.addEventListener("click", () => selectSource(index));
    const protocol = source.url.startsWith("https://") ? "HTTPS" : "HTTP";
    const protocolLabel = shouldUseNativeHlsProxy(source) ? `${protocol} 手机代理` : shouldProxyHlsSource(source) ? `${protocol} 代理` : protocol;
    const stateLabel = failed ? "本轮失败" : source.status === "ok" ? "可用" : source.status === "bad" ? "较慢" : "未知";
    button.innerHTML = `
      <span>${index >= SOURCE_BUTTON_LIMIT ? "备用" : "线路"} ${index + 1}</span>
      <strong>${escapeHtml(stateLabel)}</strong>
      <small>${escapeHtml(protocolLabel)} · ${escapeHtml(source.origin || "来源")}</small>
    `;
    sourceList.appendChild(button);
  });

  if (!sources.length) {
    sourceList.innerHTML = `<div class="source-empty">暂无备用线路</div>`;
  }
}

function updateNowPlaying(channel) {
  channelName.textContent = channel.name;
  programName.textContent = channel.current || channel.group || "直播";
}

function openLibrary(open) {
  state.libraryOpen = open;
  libraryModal.hidden = !open;
  document.body.classList.toggle("library-open", open);

  if (open) {
    state.libraryQuery = state.guideQuery;
    state.libraryCategory = state.guideCategory;
    librarySearch.value = state.libraryQuery;
    renderLibrary();
    librarySearch.focus();
  } else {
    libraryButton.focus();
  }
}

async function startCasting() {
  const channel = state.channels[state.channelIndex];
  const source = getChannelSources(channel)[state.sourceIndex];
  if (canUseNativeAirPlay() && canDirectAirPlaySource(source)) {
    await startNativeAirPlay();
    return;
  }

  openCastPanel();
  const copied = await copyPlaylistLink({ silent: true });
  showToast(copied ? "已复制电视播放列表" : "电视播放列表");
  setStatus(canUseNativeAirPlay() ? "请选择电视播放方式" : copied ? "电视播放列表已复制" : "请复制电视播放列表", "warn");
}

function openCastPanel() {
  updateCastPanel();
  state.castOpen = true;
  castModal.hidden = false;
  document.body.classList.add("cast-open");
  copyPlaylistButton.focus();
}

function closeCastPanel() {
  state.castOpen = false;
  castModal.hidden = true;
  document.body.classList.remove("cast-open");
  castButton.focus();
}

function updateCastPanel() {
  const channel = state.channels[state.channelIndex];
  const source = getChannelSources(channel)[state.sourceIndex];
  const playlistUrl = getPlaylistUrl();
  const sourceUrl = source?.url || "";

  castChannelTitle.textContent = channel?.name || "-";
  castSourceTitle.textContent = source ? `线路 ${state.sourceIndex + 1} · ${source.origin || "来源"}` : "-";
  castPlaylistUrl.value = playlistUrl;
  castSourceUrl.value = sourceUrl;
  openPlaylistLink.href = playlistUrl;
  airplayButton.hidden = !canUseNativeAirPlay();
  airplayButton.disabled = !sourceUrl || !canUseNativeAirPlay();
  copySourceButton.disabled = !sourceUrl;
}

async function startNativeAirPlay() {
  const channel = state.channels[state.channelIndex];
  const source = getChannelSources(channel)[state.sourceIndex];
  if (!source?.url) {
    openCastPanel();
    setStatus("请先选择频道", "warn");
    showToast("请先选择频道");
    return;
  }

  if (!canUseNativeAirPlay()) {
    openCastPanel();
    setStatus("当前浏览器不支持 AirPlay", "warn");
    showToast("请用 Safari 或电视 App");
    return;
  }

  try {
    prepareNativeAirPlaySource(channel, source);
    if (state.castOpen) closeCastPanel();
    setStatus("正在打开 AirPlay", "warn");
    showToast("选择 AirPlay 设备");
    player.webkitShowPlaybackTargetPicker();
  } catch {
    openCastPanel();
    setStatus("AirPlay 打开失败", "warn");
    showToast("可用 M3U 在电视端播放");
  }
}

function prepareNativeAirPlaySource(channel, source) {
  clearRecoveryTimer();
  state.userPaused = false;
  state.autoplayRequested = true;
  state.sourceLoadStartedAt = Date.now();
  state.lastProgressAt = 0;
  state.lastCurrentTime = 0;

  if (state.hls) {
    state.hls.destroy();
    state.hls = null;
  }

  suppressPauseTracking();
  clearNativePlaylistObjectUrl();
  player.setAttribute("x-webkit-airplay", "allow");
  player.removeAttribute("src");
  player.load();
  player.src = source.url;
  player.load();
  sourceHealth.textContent = `线路 ${state.sourceIndex + 1} AirPlay`;
  renderSources(channel);
  player.play().catch(() => {
    setStatus("请选择 AirPlay 设备", "warn");
  });
}

async function copyPlaylistLink(options = {}) {
  const playlistUrl = getPlaylistUrl();
  const copied = await copyText(playlistUrl);
  if (!options.silent) {
    showToast(copied ? "已复制播放列表" : "请选择播放列表链接");
    setStatus(copied ? "播放列表已复制" : "复制失败", copied ? "good" : "warn");
  }
  return copied;
}

async function copyCurrentSourceLink() {
  const channel = state.channels[state.channelIndex];
  const source = getChannelSources(channel)[state.sourceIndex];
  if (!source?.url) {
    showToast("请先选择频道");
    setStatus("请先选择频道", "warn");
    return false;
  }

  const copied = await copyText(source.url);
  showToast(copied ? "已复制当前线路" : "请选择当前线路链接");
  setStatus(copied ? "当前线路已复制" : "复制失败", copied ? "good" : "warn");
  return copied;
}

function getPlaylistUrl() {
  return new URL("./playlist.m3u", window.location.href).toString();
}

function togglePageMaximized() {
  state.pageMaximized = !state.pageMaximized;
  if (state.pageMaximized && state.libraryOpen) openLibrary(false);
  applyViewModeState();
  showToast(state.pageMaximized ? "网页最大化" : state.theaterMode ? "影院模式" : "普通模式");
}

function toggleTheaterMode() {
  if (state.pageMaximized) state.pageMaximized = false;
  state.theaterMode = !state.theaterMode;
  applyViewModeState();
  showToast(state.theaterMode ? "影院模式" : "普通模式");
}

function applyViewModeState() {
  document.body.classList.toggle("view-page-maximized", state.pageMaximized);
  document.body.classList.toggle("view-theater", state.theaterMode && !state.pageMaximized);
  updateViewModeButtons();
}

function updateViewModeButtons() {
  pageMaxButton.classList.toggle("is-active", state.pageMaximized);
  pageMaxButton.setAttribute("aria-pressed", String(state.pageMaximized));
  pageMaxButton.setAttribute("aria-label", state.pageMaximized ? "退出网页最大化" : "网页最大化");
  pageMaxButton.title = state.pageMaximized ? "退出网页最大化" : "网页最大化";

  theaterButton.classList.toggle("is-active", state.theaterMode && !state.pageMaximized);
  theaterButton.setAttribute("aria-pressed", String(state.theaterMode && !state.pageMaximized));
  theaterButton.setAttribute("aria-label", state.theaterMode ? "退出影院模式" : "影院模式");
  theaterButton.title = state.theaterMode ? "退出影院模式" : "影院模式";

  syncSystemFullscreenButton();
}

async function toggleSystemFullscreen() {
  try {
    if (getFullscreenElement()) {
      await exitSystemFullscreen();
    } else {
      await requestSystemFullscreen();
    }
  } catch {
    showToast("浏览器没有允许全屏");
  }
  syncSystemFullscreenButton();
}

async function requestSystemFullscreen() {
  const targets = [videoFrame, player, document.documentElement].filter(Boolean);
  for (const target of targets) {
    const request =
      target.requestFullscreen ||
      target.webkitRequestFullscreen ||
      target.webkitRequestFullScreen ||
      target.msRequestFullscreen;

    if (request) {
      await request.call(target);
      return;
    }
  }

  if (player.webkitEnterFullscreen) {
    player.webkitEnterFullscreen();
    return;
  }

  showToast("当前浏览器不支持全屏");
}

async function exitSystemFullscreen() {
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen || document.msExitFullscreen;
  if (exit) await exit.call(document);
}

function getFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement || document.msFullscreenElement;
}

function syncSystemFullscreenButton() {
  const isFullscreen = Boolean(getFullscreenElement());
  systemFullscreenButton.classList.toggle("is-active", isFullscreen);
  systemFullscreenButton.setAttribute("aria-pressed", String(isFullscreen));
  systemFullscreenButton.setAttribute("aria-label", isFullscreen ? "退出电脑全屏" : "电脑全屏");
  systemFullscreenButton.title = isFullscreen ? "退出电脑全屏" : "电脑全屏";
}

function shouldProxyHlsSource(source) {
  return window.location.protocol === "https:" && source?.url?.startsWith("http://") && !isDirectMediaSource(source) && Boolean(window.Hls?.isSupported?.());
}

function shouldUseNativeHls(source) {
  if (!player.canPlayType("application/vnd.apple.mpegurl")) return false;
  if (shouldUseNativeHlsProxy(source)) return true;
  if (canUseNativeAirPlay()) return true;
  return !shouldProxyHlsSource(source);
}

function shouldUseNativeHlsProxy(source) {
  return (
    window.location.protocol === "https:" &&
    source?.url?.startsWith("http://") &&
    !isDirectMediaSource(source) &&
    isMobileNativeHlsBrowser()
  );
}

function canDirectAirPlaySource(source) {
  if (!source?.url || !canUseNativeAirPlay()) return false;
  if (shouldUseNativeHlsProxy(source)) return false;
  return source.url.startsWith("https://") || !isMobileNativeHlsBrowser();
}

function syncAirPlayAttribute(source, nativeProxyingHls) {
  player.setAttribute("x-webkit-airplay", nativeProxyingHls || !canDirectAirPlaySource(source) ? "deny" : "allow");
}

function isMobileNativeHlsBrowser() {
  const userAgent = window.navigator?.userAgent || "";
  const platform = window.navigator?.platform || "";
  const maxTouchPoints = window.navigator?.maxTouchPoints || 0;
  const isiOS = /iPad|iPhone|iPod/.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1);
  return isiOS && Boolean(player.canPlayType("application/vnd.apple.mpegurl"));
}

function canUseNativeAirPlay() {
  return typeof player.webkitShowPlaybackTargetPicker === "function";
}

function createHttpsProxyLoader() {
  const BaseLoader = window.Hls.DefaultConfig.loader;

  return class FatFeetHttpsProxyLoader {
    constructor(config) {
      this.loader = new BaseLoader(config);
    }

    get stats() {
      return this.loader.stats;
    }

    get context() {
      return this.loader.context;
    }

    load(context, config, callbacks) {
      const originalUrl = context.url;
      if (!shouldProxyUrl(originalUrl)) {
        this.loader.load(context, config, callbacks);
        return;
      }

      const proxiedContext = {
        ...context,
        url: proxyHlsUrl(originalUrl)
      };

      const proxiedCallbacks = {
        ...callbacks,
        onSuccess: (response, stats, loaderContext, networkDetails) => {
          const data = typeof response.data === "string" && response.data.includes("#EXTM3U")
            ? rewriteHlsPlaylist(response.data, originalUrl)
            : response.data;
          callbacks.onSuccess(
            {
              ...response,
              data,
              url: originalUrl
            },
            stats,
            {
              ...loaderContext,
              url: originalUrl
            },
            networkDetails
          );
        }
      };

      this.loader.load(proxiedContext, config, proxiedCallbacks);
    }

    abort() {
      this.loader.abort();
    }

    destroy() {
      this.loader.destroy();
    }
  };
}

function rewriteHlsPlaylist(text, baseUrl) {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;

      if (line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewriteHlsUrl(uri, baseUrl)}"`);
      }

      return rewriteHlsUrl(line.trim(), baseUrl);
    })
    .join("\n");
}

function rewriteHlsUrl(value, baseUrl) {
  const resolved = resolveUrl(value, baseUrl);
  return shouldProxyUrl(resolved) ? proxyHlsUrl(resolved) : resolved;
}

function proxyHlsUrl(url) {
  return `${HTTPS_HLS_PROXY_PREFIX}${encodeURIComponent(url)}`;
}

function shouldProxyUrl(url) {
  return String(url || "").startsWith("http://");
}

function resolveUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Try the legacy clipboard path below.
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-999px";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function sourceKey(channel, source) {
  return `${channel.id || channel.name}::${source.url}`;
}

function getChannelSources(channel) {
  if (!channel) return [];
  const merged = [...(channel.sources || []), ...(channel.sourcePool || [])];
  const seen = new Set();
  return merged.filter((source) => {
    if (!source?.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function isSourceFailed(channel, source) {
  return state.failedSources.has(sourceKey(channel, source));
}

function isSourceUsable(channel, source) {
  return source && source.status !== "bad" && !isSourceFailed(channel, source);
}

function isDirectMediaSource(source) {
  return source?.kind === "direct" || /\.(mp4|m4v|mov|webm|flv)($|[?#])/i.test(source?.url || "");
}

function markSourceFailed(channel, sourceIndex) {
  const source = getChannelSources(channel)[sourceIndex];
  if (!source) return;
  state.failedSources.add(sourceKey(channel, source));
}

function clearSourceFailure(channel, sourceIndex) {
  const source = getChannelSources(channel)[sourceIndex];
  if (!source) return;
  state.failedSources.delete(sourceKey(channel, source));
}

function resetChannelFailures(channel) {
  for (const source of getChannelSources(channel)) {
    state.failedSources.delete(sourceKey(channel, source));
    state.sourceRecoveries.delete(sourceKey(channel, source));
  }
}

function setStatus(text, type = "good") {
  statusText.textContent = text;
  statusText.style.color = type === "warn" ? "var(--warn)" : type === "bad" ? "var(--bad)" : "var(--accent-2)";
}

function showToast(message) {
  centerToast.textContent = message;
  centerToast.hidden = false;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    centerToast.hidden = true;
  }, 1200);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
