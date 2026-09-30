// ============================================================
// 1. 音色与曲谱定义
// ============================================================
// 曲谱通过 note 索引关联 NOTES；duration 始终以拍数表示。
// 休止符使用 type: "rest"，它会推进时间轴但不生成可见音块。
const NOTES = [
  { name: "Do", key: "Z", frequency: 261.63 },
  { name: "Re", key: "X", frequency: 293.66 },
  { name: "Mi", key: "C", frequency: 329.63 },
  { name: "Fa", key: "V", frequency: 349.23 },
  { name: "Sol", key: "B", frequency: 392.0 },
  { name: "La", key: "N", frequency: 440.0 },
  { name: "Si", key: "M", frequency: 493.88 },
  { name: "Do", key: ",", frequency: 523.25 },
];

const chart = [
  { note: 0, duration: 1 },
  { note: 1, duration: 0.5 },
  { note: 2, duration: 0.5 },
  { note: 3, duration: 1 },
  { note: 4, duration: 1 },
  { note: 3, duration: 0.5 },
  { note: 2, duration: 0.5 },
  { note: 1, duration: 1 },
  { note: 0, duration: 1 },
  { note: 2, duration: 1 },
  { note: 4, duration: 1 },
  { note: 6, duration: 0.5 },
  { note: 6, duration: 0.5 },
  { note: 7, duration: 1 },
  { note: 6, duration: 1 },
  { note: 4, duration: 0.5 },
  { note: 2, duration: 0.5 },
  { note: 0, duration: 1.5 },
  { note: 1, duration: 1 },
  { note: 3, duration: 1 },
  { note: 5, duration: 1 },
  { note: 7, duration: 1 },
  { note: 5, duration: 0.5 },
  { note: 3, duration: 0.5 },
  { note: 1, duration: 1 },
  { type: "rest", duration: 1 },
  { note: 3, duration: 1 },
  { note: 5, duration: 1.5 },
  { note: 1, duration: 0.5 },
  { note: 2, duration: 0.5 },
  { note: 0, duration: 2 },
];

// 演奏时间以毫秒计。基础下落速度由 BPM 和每拍像素距离推导，
// 播放倍率同时作用于曲目时钟和音块速度，维持二者同步。
const BPM = 96;
const beatMs = 60000 / BPM;
const BEAT_DISTANCE = 124;
const BASE_FALL_SPEED = BEAT_DISTANCE / beatMs;
const TRAVEL_BEATS = 4;

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
const statusElement = document.querySelector("#song-status");
const playbackRateSelect = document.querySelector("#playback-rate");

// tiles 保存尚未命中或离开演奏区的音块；曲谱进度和播放时钟共享同一时间轴。
let tiles = [];
let running = false;
let hasStarted = false;
let lastFrame = 0;
let melodyIndex = 0;
let nextBeat = 0;
let songClock = 0;
let playbackRate = 1;
let audioContext;

// ============================================================
// 3. 初始化场景
// ============================================================
// 音符索引同时决定轨道和虚拟琴键位置，确保视觉与输入映射一致。
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
    button.addEventListener("pointerdown", () => playNote(index));
    keyboard.appendChild(button);
  });
}

function buildHitZone() {
  const hitZone = document.createElement("div");
  hitZone.className = "hit-zone";
  board.appendChild(hitZone);
  // 键盘覆盖接音区域；指针事件由键盘样式重新启用。
  hitZone.appendChild(keyboard);
  return hitZone;
}

// 轨道先于接音框创建，board.children 的前八项始终对应 NOTES。
buildLanes();
const hitZone = buildHitZone();

// ============================================================
// 4. 演奏控制
// ============================================================
// 切换播放状态、同步界面提示，并在播放时启动动画帧循环。
function startGame() {
  if (!hasStarted) {
    tiles.forEach((tile) => tile.element.remove());
    tiles = [];
    melodyIndex = 0;
    nextBeat = 0;
    songClock = -TRAVEL_BEATS * beatMs;
    hasStarted = true;
  }

  running = !running;
  startButton.textContent = running ? "暂停演奏" : "继续演奏";
  statusElement.textContent = running ? "演奏中 · 跟随音符落下节奏" : "已暂停 · 准备继续";

  if (running) {
    lastFrame = performance.now();
    requestAnimationFrame(update);
  }
}

// 每帧推进统一曲目时钟、预生成音块、更新位置并清理离场音块。
function update(timestamp) {
  if (!running) return;

  const delta = Math.min(timestamp - lastFrame, 50);
  lastFrame = timestamp;
  songClock += delta * playbackRate;

  // 提前若干拍生成曲谱事件，使音块可从演奏框上方平滑进入。
  const lookAhead = beatMs * 5;
  while (nextBeat * beatMs <= songClock + lookAhead) {
    const step = chart[melodyIndex % chart.length];
    createTile(step, nextBeat * beatMs);
    melodyIndex += 1;
    nextBeat += step.duration || 1;
  }

  hitZone.classList.remove("ready");

  tiles = tiles.filter((tile) => {
    tile.y = getTileY(tile);

    if (tile.y > board.clientHeight + 100) {
      tile.element.remove();
      return false;
    }

    tile.element.style.transform = `translate(-50%, ${tile.y}px)`;
    updateHitFeedback(tile);
    return true;
  });

  requestAnimationFrame(update);
}

// ============================================================
// 5. 音块生成与位置计算
// ============================================================
// scheduledTime 表示音块在全局播放时间轴上的计划时刻。
function createTile(step, scheduledTime) {
  const isRest = step.type === "rest";
  const noteIndex = isRest ? 0 : step.note;
  const duration = step.duration || 1;

  const tile = document.createElement("button");
  tile.className = "tile";
  tile.type = "button";
  tile.setAttribute("aria-label", isRest ? "休止符" : `点击${NOTES[noteIndex].name}`);

  const lane = board.children[noteIndex];
  const width = Math.min(lane.clientWidth * 0.85, 76);
  const beatHeight = width * (2 / 3);
  const halfBeatHeight = beatHeight / 3;
  const gap = 18;

  // 普通时值由 beatHeight 映射；延音时值额外包含可见间隔 gap。
  const heightByDuration = {
    2: beatHeight * 2 + gap,
    1.5: beatHeight + halfBeatHeight + gap,
    1: beatHeight,
    0.5: halfBeatHeight,
    0.25: halfBeatHeight / 2,
  };
  const height = heightByDuration[duration] || beatHeight;

  tile.style.width = `${width}px`;
  tile.style.height = `${height}px`;
  // 固定以轨道中心为锚点；宽度调整时音块仍与对应琴键中心线对齐。
  tile.style.left = "50%";
  tile.style.top = "0px";

  if (isRest) {
    tile.remove();
    return;
  }

  // tileData 把 DOM 节点、轨道、尺寸和计划时间关联，供动画与命中逻辑使用。
  const tileData = {
    element: tile,
    noteIndex,
    y: 0,
    height,
    duration,
    isRest,
    scheduledTime,
  };

  tileData.y = getTileY(tileData);
  tile.style.transform = `translate(-50%, ${tileData.y}px)`;
  lane.appendChild(tile);

  tile.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (!isRest && isTileInHitZone(tileData)) hitTile(tileData);
  });

  tiles.push(tileData);
}

function getTileY(tile) {
  // 以接音框中心为目标位置，再根据计划时刻差推导音块当前垂直坐标。
  const speed = BASE_FALL_SPEED * playbackRate;
  const targetY = hitZone.offsetTop + (hitZone.offsetHeight - tile.height) / 2;
  return targetY - (tile.scheduledTime - songClock) * speed;
}

// ============================================================
// 6. 命中判定与反馈
// ============================================================
// 通过屏幕矩形是否相交，判断音块是否进入有效按键窗口。
function isTileInHitZone(tile) {
  const tileRect = tile.element.getBoundingClientRect();
  const zoneRect = hitZone.getBoundingClientRect();
  return tileRect.bottom >= zoneRect.top && tileRect.top <= zoneRect.bottom;
}

function updateHitFeedback(tile) {
  const ready = isTileInHitZone(tile);
  tile.element.classList.toggle("ready", ready);

  if (ready) {
    hitZone.classList.add("ready");
  }
}

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

function playNote(noteIndex) {
  ensureAudio();

  // 每次按键创建短时振荡器，以配置表中的频率播放对应音高。
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.value = NOTES[noteIndex].frequency;

  gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.22, audioContext.currentTime + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.55);

  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.56);

  // 可视琴键提供与键盘输入一致的短暂按下反馈。
  const key = keyboard.children[noteIndex];
  key.classList.add("active");
  setTimeout(() => key.classList.remove("active"), 100);

  // 仅在演奏状态下进行音块命中判断；非演奏状态仍可用于听音。
  if (running) {
    const candidate = tiles
      .filter((tile) => tile.noteIndex === noteIndex)
      .filter((tile) => isTileInHitZone(tile))
      .sort((a, b) => Math.abs(a.y - b.y))[0];

    if (candidate) {
      hitTile(candidate);
    }
  }
}

// ============================================================
// 8. 事件绑定
// ============================================================
// 播放倍率会被时钟推进和位置计算共用，不重置当前曲谱进度。
function applyPlaybackRate(value) {
  playbackRate = Number(value);
}

startButton.addEventListener("click", startGame);
playbackRateSelect.addEventListener("change", () => {
  applyPlaybackRate(playbackRateSelect.value);
});

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
    playNote(noteIndex);
  }
});
