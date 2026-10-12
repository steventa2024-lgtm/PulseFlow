const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pulseflow", {
  version: () => ipcRenderer.invoke("pulseflow:version"),
});
