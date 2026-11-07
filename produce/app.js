// ============================================================
// 1. 音符与演奏配置
// ============================================================
// 八个键的基准音名固定为 C4–C5；游戏内左键降八度、右键升八度、中键升半音。
// 曲谱事件只需要知道轨道和变调状态，目标音名由两者推导。
const NOTES = [
  { name: "C4", key: "Z", midi: 60 },
  { name: "D4", key: "X", midi: 62 },
  { name: "E4", key: "C", midi: 64 },
  { name: "F4", key: "V", midi: 65 },
  { name: "G4", key: "B", midi: 67 },
  { name: "A4", key: "N", midi: 69 },
  { name: "B4", key: "M", midi: 71 },
  { name: "C5", key: ",", midi: 72 },
];

const SHARP_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const TRANSPOSE_OFFSETS = { down: -12, center: 0, up: 12 };

// 曲谱进度、音块计划位置都以拍数计量；BPM 只负责把毫秒换算为拍数。
const MIN_BPM = 30;
const MAX_BPM = 240;
const DEFAULT_BPM = 80;
const DEFAULT_LINE_BEATS = 16;
const LINE_BEATS_STORAGE_KEY = "note-guide-line-beats";
const CHART_FORMAT = "note-guide-chart";
const CHART_FORMAT_VERSION = 1;
const CHART_DATABASE_NAME = "note-guide-library";
const CHART_DATABASE_VERSION = 1;
const CHART_STORE_NAME = "charts";
const MAX_CHART_EVENTS = 10000;
// 首次开始时将时钟置于负拍数，使第一批音块能从演奏框顶部进入。
const TRAVEL_BEATS = 12;

function formatNoteName(midiNote) {
  const pitchClass = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;
  return `${SHARP_NOTE_NAMES[pitchClass]}${octave}`;
}

function pitchToMidi(pitch) {
  if (typeof pitch !== "string") return null;
  const match = /^([A-G])(#?)(-?\d+)$/.exec(pitch);
  if (!match) return null;
  const pitchClass = SHARP_NOTE_NAMES.indexOf(`${match[1]}${match[2]}`);
  if (pitchClass < 0) return null;
  return (Number(match[3]) + 1) * 12 + pitchClass;
}

// 现有曲谱只有 pitch；用 pitch 与轨道基准音的差值反推八度变调和半音。
// 合法差值：0/+1（中音）、+12/+13（升调）、-12/-11（降调）。
function inferTranspose(step) {
  const base = NOTES[step.note - 1];
  const midi = pitchToMidi(step.pitch);
  if (!base || midi == null) return null;

  const diff = midi - base.midi;
  const octaveShift = diff >= 12 ? 12 : diff <= -12 ? -12 : 0;
  const remainder = diff - octaveShift;
  if (remainder !== 0 && remainder !== 1) return null;

  return {
    transpose: octaveShift === 12 ? "up" : octaveShift === -12 ? "down" : "center",
    semitone: remainder === 1,
  };
}

// 渲染层统一使用这个结构；以后的曲库数据可以只写 note/transpose/semitone，不写 pitch。
// transpose 缺省时继承上一块，pitch 缺省时按轨道和变调状态推导。
function normalizeChartEvent(step, previousTranspose = "center") {
  if (step.note === 0) {
    return {
      note: 0,
      duration: step.duration,
      transpose: previousTranspose,
      semitone: false,
      pitch: null,
    };
  }

  const inferred = inferTranspose(step);
  const requestedTranspose = step.transpose;
  const transpose =
    requestedTranspose === "up" || requestedTranspose === "down" || requestedTranspose === "center"
      ? requestedTranspose
      : inferred?.transpose ?? previousTranspose;
  const semitone = step.semitone ?? inferred?.semitone ?? false;
  const base = NOTES[step.note - 1];
  const offset = (TRANSPOSE_OFFSETS[transpose] ?? 0) + (semitone ? 1 : 0);

  return {
    note: step.note,
    duration: step.duration,
    transpose,
    semitone,
    pitch: formatNoteName(base.midi + offset),
  };
}

function normalizeChart(events) {
  let previousTranspose = "center";
  return events.map((step) => {
    const normalized = normalizeChartEvent(step, previousTranspose);
    if (normalized.note !== 0) previousTranspose = normalized.transpose;
    return normalized;
  });
}

function validateChartEvents(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_CHART_EVENTS) {
    throw new Error(`曲谱事件必须为 1–${MAX_CHART_EVENTS} 条。`);
  }

  events.forEach((step, index) => {
    if (
      !step ||
      typeof step !== "object" ||
      !Number.isInteger(step.note) ||
      step.note < 0 ||
      step.note > NOTES.length ||
      (step.note > 0 && (typeof step.pitch !== "string" || !/^[A-G]#?-?\d+$/.test(step.pitch))) ||
      (step.transpose != null && !["center", "up", "down"].includes(step.transpose)) ||
      (step.semitone != null && typeof step.semitone !== "boolean") ||
      !Number.isFinite(step.duration) ||
      step.duration <= 0
    ) {
      throw new Error(`第 ${index + 1} 条事件格式无效：note 必须为 0–8，非休止符需要有效 pitch，transpose 可选 center/up/down，semitone 可选布尔值，duration 必须为正数。`);
    }
  });

  return events.map(({ note, pitch, duration, transpose, semitone }) => {
    const event = note === 0 ? { note, duration } : { note, pitch, duration };
    if (transpose != null) event.transpose = transpose;
    if (semitone != null) event.semitone = semitone;
    return event;
  });
}

function validateChartDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("曲谱文件根节点必须是 JSON 对象。");
  }
  if (value.format !== CHART_FORMAT || value.version !== CHART_FORMAT_VERSION) {
    throw new Error(`不支持的曲谱格式；需要 ${CHART_FORMAT} v${CHART_FORMAT_VERSION}。`);
  }

  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title || title.length > 100) {
    throw new Error("曲谱名称必须为 1–100 个字符。");
  }
  if (!Number.isInteger(value.bpm) || value.bpm < MIN_BPM || value.bpm > MAX_BPM) {
    throw new Error(`BPM 必须是 ${MIN_BPM}–${MAX_BPM} 之间的整数。`);
  }

  return {
    format: CHART_FORMAT,
    version: CHART_FORMAT_VERSION,
    title,
    bpm: value.bpm,
    chart: validateChartEvents(value.chart),
  };
}

// ============================================================
// 2. DOM 引用与状态管理
// ============================================================
const board = document.querySelector("#board");
let keyboard = document.querySelector("#keyboard");
if (!keyboard) {
  keyboard = document.createElement("div");
  keyboard.id = "keyboard";
  keyboard.className = "keyboard";
  keyboard.setAttribute("aria-label", "八音阶键盘");
}

const startButton = document.querySelector("#start-button");
const replayButton = document.querySelector("#replay-button");
const statusElement = document.querySelector("#song-status");
const bpmInput = document.querySelector("#bpm-input");
const repeatCountInput = document.querySelector("#repeat-count-input");
const lineBeatsInput = document.querySelector("#line-beats-input");
const currentChartTitle = document.querySelector("#current-chart-title");
const chartTitleInput = document.querySelector("#chart-title-input");
const chartLibrarySelect = document.querySelector("#chart-library-select");
const chartLibraryStatus = document.querySelector("#chart-library-status");
const importChartInput = document.querySelector("#import-chart-input");
const saveChartButton = document.querySelector("#save-chart-button");
const importChartButton = document.querySelector("#import-chart-button");
const exportChartButton = document.querySelector("#export-chart-button");
const deleteChartButton = document.querySelector("#delete-chart-button");
const quickPlayButton = document.querySelector("#quick-play");
const compactToggle = document.querySelector("#compact-toggle");
const hitZoneToggle = document.querySelector("#hit-zone-toggle");
const pinToggle = document.querySelector("#pin-toggle");
const DEFAULT_CHART_TITLE = currentChartTitle.textContent.trim();
const DEFAULT_CHART = validateChartEvents(window.DEMO_CHART);

// tiles 保存尚未离场的音块节点与定位数据。
// melodyIndex/nextBeat 跟踪曲谱读取进度；songClock 是实际播放时钟。
let tiles = [];
let running = false;
let hasStarted = false;
let lastFrame = 0;
let animationFrameId = 0;
let melodyIndex = 0;
let nextBeat = 0;
let songClock = 0;
let playbackLeadBeats = TRAVEL_BEATS;
let bpm = DEFAULT_BPM;
let lineBeats = DEFAULT_LINE_BEATS;
let repeatCount = Number(repeatCountInput.value);
let chartTitle = DEFAULT_CHART_TITLE;
let chart = DEFAULT_CHART.map((step) => ({ ...step }));
let normalizedChart = normalizeChart(chart);
let activeChartId = null;
let savedCharts = [];
let lastScheduledTranspose = "center";
let completed = false;
// 曲谱总拍数随当前曲目切换动态计算。
function getChartDurationBeats() {
  return chart.reduce((total, step) => total + step.duration, 0);
}

// ============================================================
// 3. 初始化场景
// ============================================================
// NOTES 的数组下标同时作为轨道和虚拟琴键下标，保证三者一一对应。
function buildLanes() {
  NOTES.forEach((note, index) => {
    const lane = document.createElement("div");
    lane.className = "lane";
    lane.dataset.index = index;
    lane.dataset.key = note.key;
    board.appendChild(lane);

    // 琴键只作为图例；软件不发声，实际演奏在游戏内完成。
    const key = document.createElement("div");
    key.className = "key";
    key.setAttribute("aria-label", `${note.name}（${note.key}）`);
    key.innerHTML = `${note.name}<span>${note.key}</span>`;
    keyboard.appendChild(key);
  });
}

function buildHitZone() {
  const hitZone = document.createElement("div");
  hitZone.className = "hit-zone";
  board.appendChild(hitZone);
  // 接音框默认隐藏；显示时只作为视觉参考，琴键是静态图例。
  hitZone.appendChild(keyboard);
  return hitZone;
}

// 先创建八条轨道，再创建覆盖底部的接音框；前八个 board 子节点对应 NOTES。
buildLanes();
const hitZone = buildHitZone();

// ============================================================
// 4. 演奏控制
// ============================================================
// 首次开始时初始化时间轴；暂停/继续只切换循环状态，不重置曲谱进度。
function setStartLabel(text) {
  startButton.textContent = text;
  quickPlayButton.textContent = text;
}

function startGame() {
  if (!hasStarted || completed) {
    resetPlayback();
  }

  running = !running;
  setStartLabel(running ? "暂停演奏" : "继续演奏");
  statusElement.textContent = running ? "演奏中 · 跟随音块颜色变调" : "已暂停 · 准备继续";
  repeatCountInput.disabled = running;
  replayButton.hidden = !hasStarted;

  if (running) {
    lastFrame = performance.now();
    animationFrameId = requestAnimationFrame(update);
  } else {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = 0;
  }
}

function resetPlayback() {
  cancelAnimationFrame(animationFrameId);
  animationFrameId = 0;
  tiles.forEach((tile) => tile.element.remove());
  tiles = [];
  melodyIndex = 0;
  nextBeat = 0;
  // 按当前棋盘高度和轨道宽度计算入场拍数，保证第一块从棋盘上方进入。
  const laneWidth = board.children[0]?.clientWidth || 70;
  const beatDistance = Math.max(1, laneWidth * (2 / 3));
  const boardHeight = board.clientHeight || 500;
  playbackLeadBeats = Math.max(TRAVEL_BEATS, Math.ceil(boardHeight / beatDistance) + 2);
  songClock = -playbackLeadBeats;
  lastScheduledTranspose = "center";
  hasStarted = true;
  completed = false;
}

function replayGame() {
  resetPlayback();
  running = true;
  setStartLabel("暂停演奏");
  statusElement.textContent = "演奏中 · 跟随音块颜色变调";
  repeatCountInput.disabled = true;
  replayButton.hidden = false;
  lastFrame = performance.now();
  animationFrameId = requestAnimationFrame(update);
}

// 动画帧是播放时间轴的唯一推进点：按 BPM 换算拍数、预生成音块并更新位置。
function update(timestamp) {
  if (!running) return;

  const delta = Math.min(timestamp - lastFrame, 50);
  lastFrame = timestamp;
  songClock += (delta * bpm) / 60000;

  const playbackDurationBeats = getChartDurationBeats() * repeatCount;
  const boardHeight = board.clientHeight;
  const hitZoneVisible = !board.classList.contains("board--no-hit-zone");
  const hitZoneTop = hitZoneVisible ? hitZone.offsetTop : boardHeight;
  const hitZoneBottom = hitZoneVisible ? hitZoneTop + hitZone.offsetHeight : boardHeight;
  // 接音框收起时，把棋盘底边当作对齐线，由用户把窗口底边对齐游戏按键框。
  const hitLine = hitZoneVisible ? (hitZoneTop + hitZoneBottom) / 2 : boardHeight;
  const laneWidths = NOTES.map((_, index) => board.children[index].clientWidth);

  // 按当前布局计算出的入场拍数预生成，但不再排入超过本次循环遍数的事件。
  const lookAheadBeats = playbackLeadBeats;
  while (
    nextBeat <= songClock + lookAheadBeats &&
    nextBeat < playbackDurationBeats
  ) {
    const step = normalizedChart[melodyIndex % normalizedChart.length];
    createTile(step, nextBeat, hitLine, laneWidths);
    melodyIndex += 1;
    nextBeat += step.duration || 1;
  }

  hitZone.classList.remove("ready");

  tiles = tiles.filter((tile) => {
    tile.y = getTileY(tile, hitLine);

    if (tile.y > boardHeight + 100) {
      tile.element.remove();
      return false;
    }

    tile.element.style.transform = `translateY(${tile.y}px)`;
    updateHitFeedback(tile, hitZoneTop, hitZoneBottom);
    return true;
  });

  if (songClock >= playbackDurationBeats) {
    running = false;
    completed = true;
    setStartLabel("重新开始");
    statusElement.textContent = `演奏完成 · 已播放 ${repeatCount} 遍`;
    repeatCountInput.disabled = false;
    animationFrameId = 0;
    return;
  }

  animationFrameId = requestAnimationFrame(update);
}

// ============================================================
// 5. 音块生成与位置计算
// ============================================================
// scheduledBeat 是事件起拍；duration 决定事件结束拍和音块的纵向长度。
// 颜色/箭头表示当前变调状态；与上一块状态不同时加亮边框和文字。
function createTile(step, scheduledBeat, hitLine, laneWidths) {
  const isRest = step.note === 0;
  const duration = step.duration || 1;

  // 休止推进外层时间轴，但不创建节点，也不占用任何音轨。
  if (isRest) return;

  // 曲谱编号从 1 起，数组/DOM 下标从 0 起，因此转换时减一。
  const noteIndex = step.note - 1;
  const isTransposeChange = step.transpose !== lastScheduledTranspose;
  lastScheduledTranspose = step.transpose;

  const tile = document.createElement("button");
  tile.className = `tile tile--${step.transpose}`;
  tile.type = "button";
  const transposeLabel =
    step.transpose === "up" ? "升调" : step.transpose === "down" ? "降调" : "中音";
  tile.setAttribute(
    "aria-label",
    `${transposeLabel}${step.semitone ? "半音" : ""}，目标 ${step.pitch}，音轨 ${step.note}（${NOTES[noteIndex].key}）`
  );

  if (step.transpose !== "center" || isTransposeChange) {
    const transposeBadge = document.createElement("span");
    transposeBadge.className = "tile-transpose";

    const arrow = step.transpose === "up" ? "↑" : step.transpose === "down" ? "↓" : "";
    if (arrow) {
      const arrowBadge = document.createElement("span");
      arrowBadge.className = "tile-arrow";
      arrowBadge.textContent = arrow;
      transposeBadge.appendChild(arrowBadge);
    }

    if (isTransposeChange) {
      const label = document.createElement("span");
      label.className = "tile-transpose-label";
      label.textContent =
        step.transpose === "up" ? "升调" : step.transpose === "down" ? "降调" : "回中";
      transposeBadge.appendChild(label);
    }

    tile.appendChild(transposeBadge);
  }

  if (step.semitone) tile.classList.add("tile--sharp");

  if (isTransposeChange) tile.classList.add("tile--switch");

  const pitchLabel = document.createElement("span");
  pitchLabel.className = "tile-pitch";
  const sharpIndex = step.pitch.indexOf("#");
  if (sharpIndex >= 0) {
    pitchLabel.append(step.pitch.slice(0, sharpIndex));
    const sharpMark = document.createElement("span");
    sharpMark.className = "tile-pitch-sharp";
    sharpMark.textContent = "#";
    pitchLabel.appendChild(sharpMark);
    pitchLabel.append(step.pitch.slice(sharpIndex + 1));
  } else {
    pitchLabel.textContent = step.pitch;
  }
  tile.appendChild(pitchLabel);

  const lane = board.children[noteIndex];
  const width = laneWidths[noteIndex];
  const beatDistance = width * (2 / 3);
  const height = beatDistance * duration;

  tile.style.width = `${width}px`;
  tile.style.height = `${height}px`;
  // 音块铺满轨道；轨道自身的网格宽度决定音块水平边界。
  tile.style.left = "0";
  tile.style.top = "0px";

  // 每个 tileData 将可视节点与节拍位置关联，供帧更新和反馈共用。
  const tileData = {
    element: tile,
    noteIndex,
    y: 0,
    height,
    beatDistance,
    duration,
    scheduledBeat,
    transpose: step.transpose,
    semitone: step.semitone,
  };

  tileData.y = getTileY(tileData, hitLine);
  tile.style.transform = `translateY(${tileData.y}px)`;
  lane.appendChild(tile);

  tiles.push(tileData);
}

function getTileY(tile, hitLine) {
  // 接音框中线对准事件结束拍；按结束拍与当前时钟的差值计算垂直位置。
  // height 与 duration 共用同一个 beatDistance，因此相邻事件可以首尾相接。
  const endBeat = tile.scheduledBeat + tile.duration;
  return hitLine - (endBeat - songClock) * tile.beatDistance;
}

// ============================================================
// 6. 接音框反馈
// ============================================================
// 接音框默认收起；显示时只作为视觉参考，不做命中移除。
function updateHitFeedback(tile, hitZoneTop, hitZoneBottom) {
  if (board.classList.contains("board--no-hit-zone")) {
    tile.element.classList.remove("ready");
    return;
  }

  const ready = tile.y + tile.height >= hitZoneTop && tile.y <= hitZoneBottom;
  tile.element.classList.toggle("ready", ready);

  if (ready) {
    hitZone.classList.add("ready");
  }
}

// ============================================================
// 7. 事件绑定
// ============================================================
// BPM 输入限制为 30–240 的整数；更改 BPM 只改变后续时钟推进速率，不重排事件。
function applyBpm(value) {
  const nextBpm = Number(value);
  if (!Number.isInteger(nextBpm) || nextBpm < MIN_BPM || nextBpm > MAX_BPM) {
    bpmInput.setCustomValidity(`BPM 必须是 ${MIN_BPM}–${MAX_BPM} 之间的整数。`);
    bpmInput.reportValidity();
    bpmInput.value = String(bpm);
    return;
  }

  bpmInput.setCustomValidity("");
  bpm = nextBpm;
}

// 导出换行拍数；只影响 TXT 导出排版，不影响演奏。
function applyLineBeats(value) {
  const nextLineBeats = Number(value);
  if (!Number.isInteger(nextLineBeats) || nextLineBeats < 1 || nextLineBeats > 64) {
    lineBeatsInput.setCustomValidity("换行拍数必须是 1–64 的整数。");
    lineBeatsInput.reportValidity();
    lineBeatsInput.value = String(lineBeats);
    return;
  }

  lineBeatsInput.setCustomValidity("");
  lineBeats = nextLineBeats;
  try {
    localStorage.setItem(LINE_BEATS_STORAGE_KEY, String(nextLineBeats));
  } catch (error) {
    console.warn("无法保存换行拍数：", error);
  }
}

// 循环次数是正整数；播放中锁定，暂停后可修改剩余播放目标。
function applyRepeatCount(value) {
  const nextRepeatCount = Number(value);
  if (!Number.isInteger(nextRepeatCount) || nextRepeatCount < 1) {
    repeatCountInput.setCustomValidity("循环次数必须是大于或等于 1 的整数。");
    repeatCountInput.reportValidity();
    repeatCountInput.value = String(repeatCount);
    return;
  }

  repeatCountInput.setCustomValidity("");
  repeatCount = nextRepeatCount;
}

function openChartDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("当前环境不支持 IndexedDB，无法使用本地曲库。"));
      return;
    }

    const request = window.indexedDB.open(CHART_DATABASE_NAME, CHART_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHART_STORE_NAME)) {
        database.createObjectStore(CHART_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开本地曲库。"));
    request.onblocked = () => reject(new Error("本地曲库升级被其他窗口阻塞，请关闭其他程序窗口后重试。"));
  });
}

async function getSavedCharts() {
  const database = await openChartDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHART_STORE_NAME, "readonly");
    const request = transaction.objectStore(CHART_STORE_NAME).getAll();
    request.onsuccess = () => {
      database.close();
      resolve(request.result);
    };
    request.onerror = () => {
      database.close();
      reject(request.error || new Error("读取本地曲库失败。"));
    };
  });
}

async function saveChartRecord(record) {
  const database = await openChartDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHART_STORE_NAME, "readwrite");
    transaction.objectStore(CHART_STORE_NAME).put(record);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("保存曲谱失败。"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("保存曲谱事务已取消。"));
    };
  });
}

async function deleteChartRecord(id) {
  const database = await openChartDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(CHART_STORE_NAME, "readwrite");
    transaction.objectStore(CHART_STORE_NAME).delete(id);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("删除本地曲谱失败。"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error || new Error("删除曲谱事务已取消。"));
    };
  });
}

function createChartId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `chart-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createChartRecord(document, id = createChartId()) {
  return {
    id,
    ...validateChartDocument(document),
    updatedAt: Date.now(),
  };
}

function getCurrentChartDocument() {
  return validateChartDocument({
    format: CHART_FORMAT,
    version: CHART_FORMAT_VERSION,
    title: chartTitle,
    bpm,
    chart,
  });
}

function renderChartLibrary() {
  chartLibrarySelect.replaceChildren();
  const sortedCharts = [...savedCharts].sort((left, right) =>
    right.updatedAt - left.updatedAt
  );

  if (sortedCharts.length === 0) {
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "暂无本地曲谱";
    chartLibrarySelect.appendChild(emptyOption);
    chartLibrarySelect.disabled = true;
    deleteChartButton.disabled = true;
    return;
  }

  chartLibrarySelect.disabled = false;
  deleteChartButton.disabled = false;
  sortedCharts.forEach((record) => {
    const option = document.createElement("option");
    option.value = record.id;
    option.textContent = `${record.title} · ${record.bpm} BPM`;
    chartLibrarySelect.appendChild(option);
  });
  chartLibrarySelect.value = activeChartId || sortedCharts[0].id;
}

function stopForChartSwitch() {
  running = false;
  resetPlayback();
  hasStarted = false;
  setStartLabel("开始演奏");
  repeatCountInput.disabled = false;
  replayButton.hidden = true;
}

function activateChart(record) {
  stopForChartSwitch();
  chartTitle = record.title;
  chart = validateChartEvents(record.chart);
  normalizedChart = normalizeChart(chart);
  bpm = record.bpm;
  bpmInput.value = String(bpm);
  chartTitleInput.value = chartTitle;
  currentChartTitle.textContent = chartTitle;
  activeChartId = record.id;
  statusElement.textContent = "曲谱已切换 · 选择开始";
  renderChartLibrary();
}

async function initializeChartLibrary() {
  try {
    savedCharts = await getSavedCharts();
    savedCharts = savedCharts.map((record) => {
      if (!record || typeof record.id !== "string" || !record.id) {
        throw new Error("本地曲库中存在无效曲谱记录，请通过导出文件备份后检查数据。");
      }

      return {
        id: record.id,
        ...validateChartDocument(record),
        updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
      };
    });

    if (savedCharts.length > 0) {
      const latestChart = [...savedCharts].sort((left, right) =>
        right.updatedAt - left.updatedAt
      )[0];
      activateChart(latestChart);
      chartLibraryStatus.textContent = `本地曲库已加载，共 ${savedCharts.length} 首曲谱。`;
    } else {
      activeChartId = null;
      chartLibraryStatus.textContent = "本地曲库为空；可保存当前曲谱或导入 JSON 文件。";
      renderChartLibrary();
    }
  } catch (error) {
    chartLibraryStatus.textContent = `本地曲库加载失败：${error.message}`;
    console.error("本地曲库加载失败：", error);
  }
}

async function saveCurrentChart() {
  try {
    const document = getCurrentChartDocument();
    const existingRecord = savedCharts.find((record) => record.id === activeChartId);
    const record = createChartRecord(document, existingRecord?.id);
    await saveChartRecord(record);
    savedCharts = savedCharts.filter((item) => item.id !== record.id);
    savedCharts.push(record);
    activeChartId = record.id;
    currentChartTitle.textContent = document.title;
    chartTitleInput.value = document.title;
    chartLibraryStatus.textContent = `已保存“${document.title}”到本地曲库。`;
    renderChartLibrary();
  } catch (error) {
    chartLibraryStatus.textContent = `保存失败：${error.message}`;
    console.error("保存曲谱失败：", error);
  }
}

async function importChartFile(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    chartLibraryStatus.textContent = "导入失败：曲谱文件不能大于 2 MB。";
    return;
  }

  try {
    const text = await file.text();
    const looksLikeJson =
      file.name.toLowerCase().endsWith(".json") || text.trimStart().startsWith("{");
    let parsedDocument;

    if (looksLikeJson) {
      parsedDocument = JSON.parse(text);
    } else {
      if (!window.ChartText) throw new Error("TXT 曲谱解析模块未加载。");
      const parsed = window.ChartText.parse(text, { fileName: file.name });
      parsedDocument = {
        format: CHART_FORMAT,
        version: CHART_FORMAT_VERSION,
        title: parsed.title,
        bpm: parsed.bpm,
        chart: parsed.chart,
      };
    }

    const record = createChartRecord(parsedDocument);
    await saveChartRecord(record);
    savedCharts.push(record);
    activateChart(record);
    chartLibraryStatus.textContent = `已导入“${record.title}”，并保存到本地曲库。`;
  } catch (error) {
    chartLibraryStatus.textContent = `导入失败：${error.message}`;
    console.error("导入曲谱失败：", error);
  } finally {
    importChartInput.value = "";
  }
}

function exportCurrentChart() {
  try {
    if (!window.ChartText) throw new Error("TXT 曲谱解析模块未加载。");

    const chartDocument = getCurrentChartDocument();
    const fileContent = window.ChartText.serialize({
      title: chartDocument.title,
      bpm: chartDocument.bpm,
      chart: normalizeChart(chartDocument.chart),
      lineBeats,
    });
    const objectUrl = URL.createObjectURL(
      new Blob([fileContent], { type: "text/plain;charset=utf-8" })
    );
    const downloadLink = document.createElement("a");
    downloadLink.href = objectUrl;
    downloadLink.download = `${chartDocument.title.replace(/[\\/:*?"<>|]/g, "_")}.txt`;
    downloadLink.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    chartLibraryStatus.textContent = `已导出“${chartDocument.title}”TXT 曲谱文件（每 ${lineBeats} 拍换行）。`;
  } catch (error) {
    chartLibraryStatus.textContent = `导出失败：${error.message}`;
    console.error("导出曲谱失败：", error);
  }
}

async function deleteSelectedChart() {
  const record = savedCharts.find((item) => item.id === chartLibrarySelect.value);
  if (!record) return;
  if (!window.confirm(`确定从本地曲库删除“${record.title}”吗？此操作无法撤销。`)) return;

  try {
    await deleteChartRecord(record.id);
    savedCharts = savedCharts.filter((item) => item.id !== record.id);
    if (activeChartId === record.id) {
      activeChartId = null;
      chartTitle = DEFAULT_CHART_TITLE;
      chart = DEFAULT_CHART.map((step) => ({ ...step }));
      normalizedChart = normalizeChart(chart);
      bpm = DEFAULT_BPM;
      bpmInput.value = String(bpm);
      currentChartTitle.textContent = chartTitle;
      chartTitleInput.value = chartTitle;
      stopForChartSwitch();
    }
    renderChartLibrary();
    chartLibraryStatus.textContent = `已从本地曲库删除“${record.title}”。`;
  } catch (error) {
    chartLibraryStatus.textContent = `删除失败：${error.message}`;
    console.error("删除曲谱失败：", error);
  }
}

startButton.addEventListener("click", startGame);
quickPlayButton.addEventListener("click", startGame);
replayButton.addEventListener("click", replayGame);

// 图钉：切换窗口是否始终置顶；主进程返回切换后的状态。
function updatePinButton(pinned) {
  pinToggle.classList.toggle("active", pinned);
  pinToggle.setAttribute("aria-pressed", String(pinned));
  pinToggle.setAttribute("aria-label", pinned ? "取消置顶" : "置顶");
  pinToggle.title = pinned ? "取消置顶" : "置顶";
}

updatePinButton(false);

pinToggle.addEventListener("click", async () => {
  if (!window.windowControls?.togglePin) return;

  try {
    const pinned = await window.windowControls.togglePin();
    if (typeof pinned === "boolean") updatePinButton(pinned);
  } catch (error) {
    console.error("切换置顶失败：", error);
  }
});

document.querySelector("#minimize-window").addEventListener("click", () => {
  window.windowControls?.minimize();
});
document.querySelector("#maximize-window").addEventListener("click", () => {
  window.windowControls?.toggleMaximize();
});
document.querySelector("#close-window").addEventListener("click", () => {
  window.windowControls?.close();
});
bpmInput.addEventListener("change", () => {
  applyBpm(bpmInput.value);
});
repeatCountInput.addEventListener("change", () => {
  applyRepeatCount(repeatCountInput.value);
});
lineBeatsInput.addEventListener("change", () => {
  applyLineBeats(lineBeatsInput.value);
});
chartTitleInput.addEventListener("input", () => {
  chartTitle = chartTitleInput.value.trim();
  currentChartTitle.textContent = chartTitle || "未命名曲谱";
});
chartLibrarySelect.addEventListener("change", () => {
  const selectedChart = savedCharts.find((record) => record.id === chartLibrarySelect.value);
  if (selectedChart) activateChart(selectedChart);
});
saveChartButton.addEventListener("click", saveCurrentChart);
importChartButton.addEventListener("click", () => importChartInput.click());
importChartInput.addEventListener("change", () => importChartFile(importChartInput.files[0]));
exportChartButton.addEventListener("click", exportCurrentChart);
deleteChartButton.addEventListener("click", deleteSelectedChart);

// 接音框默认收起；切换布局时重置播放，避免音块在旧坐标系里跳动。
function applyHitZoneVisibility(visible) {
  board.classList.toggle("board--no-hit-zone", !visible);
  hitZoneToggle.checked = visible;
}

hitZoneToggle.addEventListener("change", () => {
  stopForChartSwitch();
  applyHitZoneVisibility(hitZoneToggle.checked);
});

// 精简模式：隐藏面板和接音框，棋盘铺满窗口，方便缩放到游戏按键框大小。
function setCompactMode(enabled) {
  stopForChartSwitch();
  document.body.classList.toggle("compact", enabled);
  compactToggle.textContent = enabled ? "退出精简" : "精简";
  if (enabled) applyHitZoneVisibility(false);
}

compactToggle.addEventListener("click", () => {
  setCompactMode(!document.body.classList.contains("compact"));
});

// 窗口缩放会改变轨道宽度和音块尺寸；停一下并清空旧音块，下次开始按新尺寸生成。
let resizeTimer = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (running || tiles.length > 0) stopForChartSwitch();
  }, 150);
});

// 折叠面板状态保存在本机，下次打开保持。
const PANEL_STATE_KEY = "note-guide-panels";

function savePanelState() {
  const state = {};
  document.querySelectorAll("details[data-panel]").forEach((panel) => {
    state[panel.id] = panel.open;
  });

  try {
    localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("无法保存面板状态：", error);
  }
}

function restorePanelState() {
  try {
    const state = JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || "{}");
    document.querySelectorAll("details[data-panel]").forEach((panel) => {
      if (typeof state[panel.id] === "boolean") panel.open = state[panel.id];
    });
  } catch (error) {
    console.warn("无法读取面板状态：", error);
  }
}

document.querySelectorAll("details[data-panel]").forEach((panel) => {
  panel.addEventListener("toggle", savePanelState);
});
restorePanelState();

// 恢复上次使用的导出换行拍数。
try {
  const savedLineBeats = Number(localStorage.getItem(LINE_BEATS_STORAGE_KEY));
  if (Number.isInteger(savedLineBeats) && savedLineBeats >= 1 && savedLineBeats <= 64) {
    lineBeats = savedLineBeats;
    lineBeatsInput.value = String(savedLineBeats);
  }
} catch (error) {
  console.warn("无法读取换行拍数：", error);
}

applyHitZoneVisibility(false);
initializeChartLibrary();

// 空格在非输入控件上控制开始/暂停；游戏内演奏不依赖软件键盘。
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space") return;
  if (event.target instanceof Element && event.target.closest("input, select, textarea, button, summary")) {
    return;
  }

  event.preventDefault();
  startGame();
});
