// ============================================================
// 1. 音符与演奏配置
// ============================================================
// 曲谱事件由 demo.js 提供。note=0 是休止；note=1–8 对应下方 NOTES，duration 以拍数表示。
// pitch 仅用于音块上的移调提示，不参与按键音高和音轨索引计算。
const NOTES = [
  { name: "C4", key: "Z", frequency: 261.63 },
  { name: "D4", key: "X", frequency: 293.66 },
  { name: "E4", key: "C", frequency: 329.63 },
  { name: "F4", key: "V", frequency: 349.23 },
  { name: "G4", key: "B", frequency: 392.0 },
  { name: "A4", key: "N", frequency: 440.0 },
  { name: "B4", key: "M", frequency: 493.88 },
  { name: "C5", key: ",", frequency: 523.25 },
];

const SCALE_SEMITONES = [0, 2, 4, 5, 7, 9, 11, 12];
const SHARP_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// 曲谱进度、音块计划位置都以拍数计量；BPM 只负责把毫秒换算为拍数。
const MIN_BPM = 30;
const MAX_BPM = 240;
const DEFAULT_BPM = 80;
const CHART_FORMAT = "note-guide-chart";
const CHART_FORMAT_VERSION = 1;
const CHART_DATABASE_NAME = "note-guide-library";
const CHART_DATABASE_VERSION = 1;
const CHART_STORE_NAME = "charts";
const MAX_CHART_EVENTS = 10000;
// 首次开始时将时钟置于负拍数，使第一批音块能从演奏框顶部进入。
const TRAVEL_BEATS = 12;

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
      !Number.isFinite(step.duration) ||
      step.duration <= 0
    ) {
      throw new Error(`第 ${index + 1} 条事件格式无效：note 必须为 0–8，非休止符需要有效 pitch，duration 必须为正数。`);
    }
  });

  return events.map(({ note, pitch, duration }) =>
    note === 0 ? { note, duration } : { note, pitch, duration }
  );
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
const currentChartTitle = document.querySelector("#current-chart-title");
const chartTitleInput = document.querySelector("#chart-title-input");
const chartLibrarySelect = document.querySelector("#chart-library-select");
const chartLibraryStatus = document.querySelector("#chart-library-status");
const importChartInput = document.querySelector("#import-chart-input");
const saveChartButton = document.querySelector("#save-chart-button");
const importChartButton = document.querySelector("#import-chart-button");
const exportChartButton = document.querySelector("#export-chart-button");
const deleteChartButton = document.querySelector("#delete-chart-button");
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
let bpm = DEFAULT_BPM;
let repeatCount = Number(repeatCountInput.value);
let chartTitle = DEFAULT_CHART_TITLE;
let chart = DEFAULT_CHART.map((step) => ({ ...step }));
let activeChartId = null;
let savedCharts = [];
let transposeSemitones = 0;
// 鼠标按钮用 PointerEvent.button 编号记录；同时按住时各自偏移会叠加。
const heldTransposeButtons = new Set();
// 记录当前按住的音符键，以便松开或窗口失焦时清除视觉反馈。
const heldNoteKeys = new Set();
let audioContext;
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
    board.appendChild(lane);

    const button = document.createElement("button");
    button.className = "key";
    button.type = "button";
    button.innerHTML = `${note.name}<span>${note.key}</span>`;
    button.addEventListener("pointerdown", (event) => {
      // 鼠标在整个棋盘上用于临时移调；虚拟琴键仅响应触屏点按弹奏。
      if (event.pointerType !== "mouse") {
        setNoteKeyPressed(index, true);
        playNote(index);
      }
    });
    button.addEventListener("pointerup", () => setNoteKeyPressed(index, false));
    button.addEventListener("pointercancel", () => setNoteKeyPressed(index, false));
    button.addEventListener("lostpointercapture", () => setNoteKeyPressed(index, false));
    keyboard.appendChild(button);
  });
}

function buildHitZone() {
  const hitZone = document.createElement("div");
  hitZone.className = "hit-zone";
  board.appendChild(hitZone);
  // 接音框负责视觉和命中范围；虚拟键盘覆盖其上并接收触屏输入。
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
function startGame() {
  if (running) clearHeldTransposeButtons();

  if (!hasStarted || completed) {
    resetPlayback();
  }

  running = !running;
  startButton.textContent = running ? "暂停演奏" : "继续演奏";
  statusElement.textContent = running ? "演奏中 · 跟随音符落下节奏" : "已暂停 · 准备继续";
  repeatCountInput.disabled = running;
  replayButton.hidden = !hasStarted;

  if (running) {
    ensureAudio();
    lastFrame = performance.now();
    animationFrameId = requestAnimationFrame(update);
  } else {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = 0;
  }
}

function resetPlayback() {
  clearHeldTransposeButtons();
  cancelAnimationFrame(animationFrameId);
  animationFrameId = 0;
  tiles.forEach((tile) => tile.element.remove());
  tiles = [];
  melodyIndex = 0;
  nextBeat = 0;
  songClock = -TRAVEL_BEATS;
  hasStarted = true;
  completed = false;
}

function replayGame() {
  resetPlayback();
  running = true;
  startButton.textContent = "暂停演奏";
  statusElement.textContent = "演奏中 · 跟随音符落下节奏";
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
  const hitZoneTop = hitZone.offsetTop;
  const hitZoneBottom = hitZoneTop + hitZone.offsetHeight;
  const hitLine = (hitZoneTop + hitZoneBottom) / 2;
  const boardHeight = board.clientHeight;
  const laneWidths = NOTES.map((_, index) => board.children[index].clientWidth);

  // 按完整入场时长预生成，但不再排入超过本次循环遍数的事件。
  const lookAheadBeats = TRAVEL_BEATS;
  while (
    nextBeat <= songClock + lookAheadBeats &&
    nextBeat < playbackDurationBeats
  ) {
    const step = chart[melodyIndex % chart.length];
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
    startButton.textContent = "重新开始";
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
function createTile(step, scheduledBeat, hitLine, laneWidths) {
  const isRest = step.note === 0;
  const duration = step.duration || 1;

  // 休止推进外层时间轴，但不创建节点，也不占用任何音轨。
  if (isRest) return;

  // 曲谱编号从 1 起，数组/DOM 下标从 0 起，因此转换时减一。
  const noteIndex = step.note - 1;
  const tile = document.createElement("button");
  tile.className = "tile";
  tile.type = "button";
  tile.setAttribute("aria-label", `移调提示 ${step.pitch}，音轨 ${NOTES[noteIndex].name}`);
  const pitchLabel = document.createElement("span");
  pitchLabel.className = "tile-pitch";
  pitchLabel.textContent = step.pitch;
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

  // 每个 tileData 将可视节点与节拍位置关联，供帧更新、反馈和命中判断共用。
  const tileData = {
    element: tile,
    noteIndex,
    y: 0,
    height,
    beatDistance,
    duration,
    scheduledBeat,
  };

  tileData.y = getTileY(tileData, hitLine);
  tile.style.transform = `translateY(${tileData.y}px)`;
  lane.appendChild(tile);

  tile.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    // 触屏可直接点中已进入接音框的音块；鼠标不以点击音块触发弹奏。
    if (event.pointerType !== "mouse" && isTileInHitZone(tileData)) {
      hitTile(tileData);
    }
  });

  tiles.push(tileData);
}

function getTileY(tile, hitLine) {
  // 接音框中线对准事件结束拍；按结束拍与当前时钟的差值计算垂直位置。
  // height 与 duration 共用同一个 beatDistance，因此相邻事件可以首尾相接。
  const endBeat = tile.scheduledBeat + tile.duration;
  return hitLine - (endBeat - songClock) * tile.beatDistance;
}

// ============================================================
// 6. 命中判定与反馈
// ============================================================
// 音块和接音框处于同一棋盘坐标系，用逻辑坐标判断以避免逐块读取布局矩形。
function isTileInHitZone(tile) {
  const hitZoneTop = hitZone.offsetTop;
  const hitZoneBottom = hitZoneTop + hitZone.offsetHeight;
  return tile.y + tile.height >= hitZoneTop && tile.y <= hitZoneBottom;
}

function updateHitFeedback(tile, hitZoneTop, hitZoneBottom) {
  const ready = tile.y + tile.height >= hitZoneTop && tile.y <= hitZoneBottom;
  tile.element.classList.toggle("ready", ready);

  if (ready) {
    hitZone.classList.add("ready");
  }
}

// 触屏点按音块时的命中处理；普通键盘弹奏只发声，不移除音块。
function hitTile(tile) {
  // 活动列表检查可避免同一音块被重复处理。
  if (!tiles.includes(tile) || !isTileInHitZone(tile)) return;

  tile.element.classList.add("hit");
  hitZone.classList.remove("ready");
  tiles = tiles.filter((item) => item !== tile);
  setTimeout(() => tile.element.remove(), 90);
}

// ============================================================
// 7. 音频输出
// ============================================================
// 延迟创建音频上下文，以符合浏览器必须由用户手势启动音频的策略。
function ensureAudio() {
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
}

// 根据当前按住的鼠标按钮重算临时移调；松开全部按钮后偏移自然回到 0。
function updateTransposeFromHeldButtons() {
  transposeSemitones = 0;
  heldTransposeButtons.forEach((button) => {
    if (button === 0) transposeSemitones -= 12;
    if (button === 2) transposeSemitones += 12;
    if (button === 1) transposeSemitones += 1;
  });

  updateKeyboardNoteNames();
}

function clearHeldTransposeButtons() {
  if (heldTransposeButtons.size === 0) return;

  heldTransposeButtons.clear();
  updateTransposeFromHeldButtons();
}

function updateKeyboardNoteNames() {
  const scaleNotes = SCALE_SEMITONES.map((semitone) =>
    formatNoteName(60 + transposeSemitones + semitone)
  );

  Array.from(keyboard.children).forEach((key, index) => {
    key.childNodes[0].textContent = scaleNotes[index];
  });
}

function transposeButtonFromMouseEvent(event) {
  if (event.button < 0 || event.button > 2) return;

  event.preventDefault();
  if (!running) return;

  heldTransposeButtons.add(event.button);
  updateTransposeFromHeldButtons();
}

// 鼠标可以在棋盘外松开；window 级监听确保对应按钮偏移及时清除。
function releaseTransposeButton(event) {
  if (!heldTransposeButtons.delete(event.button)) return;

  updateTransposeFromHeldButtons();
}

function isInsideBoard(target) {
  return target instanceof Element && board.contains(target);
}

// 仅播放中接收棋盘鼠标按下；三种鼠标键作为移调控制，不用于鼠标弹奏。
board.addEventListener("mousedown", (event) => {
  if (running) transposeButtonFromMouseEvent(event);
});

window.addEventListener("mouseup", releaseTransposeButton);
window.addEventListener("blur", () => {
  clearHeldTransposeButtons();
  heldNoteKeys.forEach((noteIndex) => setNoteKeyPressed(noteIndex, false));
});

document.addEventListener("contextmenu", (event) => {
  // 仅在棋盘演奏移调期间拦截右键菜单，不影响页面其他区域。
  if (running && isInsideBoard(event.target)) event.preventDefault();
});

document.addEventListener("auxclick", (event) => {
  if (running && isInsideBoard(event.target)) event.preventDefault();
});

// MIDI 音高转音名，供按住移调时更新八个可视琴键标签。
function formatNoteName(midiNote) {
  const pitchClass = ((midiNote % 12) + 12) % 12;
  const octave = Math.floor(midiNote / 12) - 1;
  return `${SHARP_NOTE_NAMES[pitchClass]}${octave}`;
}

function playNote(noteIndex) {
  ensureAudio();

  // 每次输入创建短时正弦振荡器；只将鼠标临时移调应用于琴键本身的频率。
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value =
    NOTES[noteIndex].frequency * 2 ** (transposeSemitones / 12);

  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.22, audioContext.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.55);

  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.56);

}

function setNoteKeyPressed(noteIndex, pressed) {
  const key = keyboard.children[noteIndex];
  if (!key) return;

  key.classList.toggle("pressed", pressed);
  if (pressed) {
    heldNoteKeys.add(noteIndex);
  } else {
    heldNoteKeys.delete(noteIndex);
  }
}

// ============================================================
// 8. 事件绑定
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
  startButton.textContent = "开始演奏";
  repeatCountInput.disabled = false;
  replayButton.hidden = true;
}

function activateChart(record) {
  stopForChartSwitch();
  chartTitle = record.title;
  chart = validateChartEvents(record.chart);
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
    chartLibraryStatus.textContent = "导入失败：JSON 文件不能大于 2 MB。";
    return;
  }

  try {
    const parsedDocument = JSON.parse(await file.text());
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
    const chartDocument = getCurrentChartDocument();
    const fileContent = `${JSON.stringify(chartDocument, null, 2)}\n`;
    const objectUrl = URL.createObjectURL(
      new Blob([fileContent], { type: "application/json" })
    );
    const downloadLink = document.createElement("a");
    downloadLink.href = objectUrl;
    downloadLink.download = `${chartDocument.title.replace(/[\\/:*?"<>|]/g, "_")}.note-guide.json`;
    downloadLink.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    chartLibraryStatus.textContent = `已导出“${chartDocument.title}”JSON 曲谱文件。`;
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
replayButton.addEventListener("click", replayGame);
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
initializeChartLibrary();

// 空格控制播放；音名快捷键只响应首次 keydown，避免系统按键重复造成连发。
document.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault();
    startGame();
    return;
  }

  const noteIndex = NOTES.findIndex(
    (note) => note.key.toLowerCase() === event.key.toLowerCase()
  );

  if (noteIndex >= 0 && !event.repeat) {
    setNoteKeyPressed(noteIndex, true);
    playNote(noteIndex);
  }
});

document.addEventListener("keyup", (event) => {
  const noteIndex = NOTES.findIndex(
    (note) => note.key.toLowerCase() === event.key.toLowerCase()
  );

  if (noteIndex >= 0) {
    setNoteKeyPressed(noteIndex, false);
  }
});
