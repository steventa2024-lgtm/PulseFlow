import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, Tray } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, createHost, type Host } from "@pulseflow/server";

const dev = process.env.PULSEFLOW_DEV === "1";
const here = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | undefined;
let quitting = false;
let closing = false;
let mainWindow: BrowserWindow | undefined;
let host: Host | undefined;
let server: Awaited<ReturnType<typeof buildApp>> | undefined;

app.setName("PulseFlow");
app.setAppUserModelId("com.zeropulse.pulseflow");

ipcMain.handle("pulseflow:version", () => ({ name: "PulseFlow", version: app.getVersion() }));

function logLine(home: string, message: string): void {
  const dir = path.join(home, "logs");
  mkdirSync(dir, { recursive: true });
  const line = `${new Date().toISOString()} ${message}`;
  appendFileSync(path.join(dir, "desktop.log"), `${line}\n`);
  console.log(line);
}

function iconFile(): string {
  const packaged = path.join(process.resourcesPath, "icon.png");
  if (existsSync(packaged)) return packaged;
  return path.join(here, "../build/icon.png");
}

function uiDirectory(): string | undefined {
  if (dev) return undefined;
  const packaged = path.join(process.resourcesPath, "ui");
  if (existsSync(path.join(packaged, "index.html"))) return packaged;
  const besideBundle = path.join(here, "../dist");
  if (existsSync(path.join(besideBundle, "index.html"))) return besideBundle;
  return packaged;
}

function dataHome(): string {
  if (process.env.PULSEFLOW_HOME) return process.env.PULSEFLOW_HOME;
  return path.join(app.getPath("userData"), "pulseflow");
}

async function start(): Promise<void> {
  const home = dataHome();
  mkdirSync(home, { recursive: true });
  logLine(home, `PulseFlow data directory ${home}`);
  logLine(
    home,
    "Schedules run only while this process is running. Sleep, hibernate, sign-out, and power-off pause or stop them. Missed schedules follow each schedule's missed policy.",
  );
  host = await createHost(home);
  server = await buildApp(host, { staticDir: uiDirectory() });
  await server.listen({ host: "127.0.0.1", port: dev ? 8787 : 0 });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : 8787;
  logLine(home, `PULSEFLOW_READY url=http://127.0.0.1:${port}`);
  if (!dev) {
    sessionHeaders();
  }
  const icon = iconFile();
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0B0F16",
    title: "PulseFlow",
    icon: existsSync(icon) ? icon : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(here, "preload.cjs"),
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("http://localhost:")) event.preventDefault();
  });
  await window.loadURL(dev ? "http://127.0.0.1:5173" : `http://127.0.0.1:${port}`);
  window.on("close", (event) => {
    if (quitting || !host?.store.getSetting("backgroundExecution", false)) return;
    event.preventDefault();
    if (!tray) {
      try {
        const image = nativeImage.createFromPath(iconFile());
        if (image.isEmpty()) throw new Error("Tray icon file is empty");
        tray = new Tray(image);
        tray.setToolTip("PulseFlow");
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: "Show PulseFlow", click: () => window.show() },
            {
              label: "Quit",
              click: () => {
                quitting = true;
                app.quit();
              },
            },
          ]),
        );
        tray.on("click", () => window.show());
      } catch (error) {
        logLine(home, `Tray icon is unavailable, so the window stays open. ${error instanceof Error ? error.message : "unknown error"}`);
        return;
      }
    }
    window.hide();
    logLine(home, "Window hidden. Schedules continue until quit, sleep, or shutdown.");
  });
}

function sessionHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

function shutdown(): void {
  quitting = true;
  if (!host || !server || closing) return;
  closing = true;
  const currentHost = host;
  const currentServer = server;
  void currentServer
    .close()
    .then(() => currentHost.close())
    .catch((error: unknown) => {
      console.error(error);
    })
    .finally(() => {
      host = undefined;
      server = undefined;
      app.quit();
    });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("before-quit", (event) => {
    if (!host || !server || closing) return;
    event.preventDefault();
    shutdown();
  });
  app.whenReady().then(start).catch((error: unknown) => {
    console.error(error);
    app.quit();
  });
}
