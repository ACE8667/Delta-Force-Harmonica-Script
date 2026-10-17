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
  });
});

ipcMain.on("window:close", (event) => {
  withSenderWindow(event, (window) => window.close());
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 720,
    minHeight: 640,
    alwaysOnTop: true,
    transparent: true,
    frame: false,
    backgroundColor: "#00000000",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const opacityStyles = `:root {
    --opacity-frame: ${getOpacityPercent("frame")};
    --opacity-text: ${getOpacityPercent("text")};
    --opacity-boxes: ${getOpacityPercent("boxes")};
    --opacity-buttons: ${getOpacityPercent("buttons")};
  }
  body, .hit-zone, .lane::after { background: transparent !important; }
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
