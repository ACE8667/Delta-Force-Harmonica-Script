const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

// Values range from 0 (transparent) to 1 (opaque); null inherits `all`.
const OPACITY = Object.freeze({
  all: 1,
  frame: null,
  text: null,
  boxes: null,
  buttons: null,
});

// 整体窗口的半透明底色和一圈细边框，方便在游戏画面上确认软件窗口的边界。
const WINDOW_TINT = "rgba(17, 23, 15, 0.24)";
const WINDOW_OUTLINE = "rgba(217, 238, 138, 0.42)";

// 每个窗口的图钉（置顶）状态；默认开启。
const pinnedWindows = new WeakMap();

function isWindowPinned(window) {
  return pinnedWindows.get(window) ?? true;
}

function setWindowPinned(window, pinned) {
  pinnedWindows.set(window, pinned);
  window.setAlwaysOnTop(pinned);
  if (pinned) window.moveTop?.();
}

function getOpacity(name) {
  const override = OPACITY[name];
  const value = name === "all" || override === null ? OPACITY.all : override;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`透明度配置 ${name} 必须是 0 到 1 之间的数字。`);
  }

  return value;
}

function getOpacityPercent(name) {
  return `${getOpacity(name) * 100}%`;
}

function withSenderWindow(event, action) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow) action(senderWindow);
}

ipcMain.on("window:minimize", (event) => {
  withSenderWindow(event, (window) => window.minimize());
});

ipcMain.on("window:toggle-maximize", (event) => {
  withSenderWindow(event, (window) => {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    if (isWindowPinned(window)) window.setAlwaysOnTop(true);
  });
});

ipcMain.handle("window:toggle-pin", (event) => {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow) return false;

  const nextPinned = !isWindowPinned(senderWindow);
  setWindowPinned(senderWindow, nextPinned);
  return nextPinned;
});

ipcMain.on("window:close", (event) => {
  withSenderWindow(event, (window) => window.close());
});

function getWindowBoundsFile() {
  // 尺寸改版后换文件名，避免旧的 1120×860 记录继续生效。
  return path.join(app.getPath("userData"), "window-bounds-v2.json");
}

function readWindowBounds() {
  try {
    const bounds = JSON.parse(fs.readFileSync(getWindowBoundsFile(), "utf8"));
    const hasValidValues = ["x", "y", "width", "height"].every((key) =>
      Number.isFinite(bounds?.[key])
    );
    if (hasValidValues && bounds.width >= 240 && bounds.height >= 180) {
      return bounds;
    }
  } catch {
    // 首次启动、文件损坏或没有权限时回退到默认尺寸。
  }

  return null;
}

function saveWindowBounds(window) {
  try {
    fs.writeFileSync(getWindowBoundsFile(), JSON.stringify(window.getBounds()));
  } catch (error) {
    console.error("无法保存窗口位置：", error);
  }
}

function createWindow() {
  const savedBounds = readWindowBounds();
  const window = new BrowserWindow({
    width: savedBounds?.width ?? 560,
    height: savedBounds?.height ?? 430,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    minWidth: 240,
    minHeight: 180,
    // 图钉默认不亮；用户点图钉后才置顶，避免自动抢焦点。
    alwaysOnTop: false,
    transparent: true,
    frame: false,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 游戏在前台时保持动画帧不被 Chromium 降频。
      backgroundThrottling: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // 记住窗口位置和尺寸，方便下次直接对齐游戏按键框。
  window.on("close", () => saveWindowBounds(window));

  pinnedWindows.set(window, false);

  // 置顶由图钉控制；这里只重新应用当前图钉状态，不再定时 moveTop、不抢焦点。
  const reapplyPin = () => {
    if (!window.isDestroyed() && isWindowPinned(window)) {
      window.setAlwaysOnTop(true);
    }
  };
  window.on("blur", reapplyPin);
  window.on("focus", reapplyPin);
  window.on("show", reapplyPin);
  window.on("restore", reapplyPin);
  window.on("maximize", reapplyPin);
  window.on("unmaximize", reapplyPin);

  const opacityStyles = `:root {
    --opacity-frame: ${getOpacityPercent("frame")};
    --opacity-text: ${getOpacityPercent("text")};
    --opacity-boxes: ${getOpacityPercent("boxes")};
    --opacity-buttons: ${getOpacityPercent("buttons")};
  }
  body {
    background: ${WINDOW_TINT} !important;
  }
  body::after {
    position: fixed;
    inset: 0;
    z-index: 9999;
    border: 1px solid ${WINDOW_OUTLINE};
    content: "";
    pointer-events: none;
  }
  .hit-zone, .lane::after { background: transparent !important; }
  .window-titlebar { display: flex !important; }`;
  window.webContents.on("dom-ready", () => {
    window.webContents.insertCSS(opacityStyles).catch((error) => {
      console.error("无法应用界面透明度配置：", error);
    });
  });

  window.webContents.on("context-menu", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.loadFile(path.join(__dirname, "..", "produce", "index.html")).catch((error) => {
    console.error("无法加载音符指引页面：", error);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  console.error("桌面程序启动失败：", error);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
