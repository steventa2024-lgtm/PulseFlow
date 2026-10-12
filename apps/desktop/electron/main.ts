import { app, BrowserWindow, ipcMain, Menu, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, createHost } from "@pulseflow/server";

const dev = process.env.PULSEFLOW_DEV === "1";
const here = path.dirname(fileURLToPath(import.meta.url));
let tray: Tray | undefined;
let quitting = false;

ipcMain.handle("pulseflow:version", () => ({ name: "PulseFlow", version: app.getVersion() }));

app.whenReady().then(async () => {
  const home = process.env.PULSEFLOW_HOME ?? path.join(app.getPath("userData"), "pulseflow");
  const host = await createHost(home);
  const server = await buildApp(host, {
    staticDir: dev ? undefined : path.join(process.resourcesPath, "ui"),
  });
  await server.listen({ host: "127.0.0.1", port: dev ? 8787 : 0 });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : 8787;
  if (!dev) {
    const { session: electronSession } = await import("electron");
    electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
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
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0B0F16",
    title: "PulseFlow",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(here, "preload.cjs"),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("http://127.0.0.1:") && !url.startsWith("http://localhost:")) event.preventDefault();
  });
  await window.loadURL(dev ? "http://127.0.0.1:5173" : `http://127.0.0.1:${port}`);
  window.on("close", (event) => {
    if (!quitting && host.store.getSetting("backgroundExecution", false)) {
      event.preventDefault();
      window.hide();
      if (!tray) {
        try {
          tray = new Tray(path.join(here, "../public/favicon.svg"));
          tray.setToolTip("PulseFlow");
          tray.setContextMenu(Menu.buildFromTemplate([
            { label: "Show PulseFlow", click: () => window.show() },
            { label: "Quit", click: () => { quitting = true; app.quit(); } },
          ]));
        } catch (error) {
          console.error("Tray icon is unavailable in this environment", error);
        }
      }
    }
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("will-quit", () => {
    void server.close();
    void host.close();
  });
}).catch((error: unknown) => {
  console.error(error);
  app.quit();
});
