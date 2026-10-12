import { contextBridge, ipcRenderer } from 'electron';

/** The only native capabilities the renderer gets. Every channel is validated in the main process. */
const bridge = {
  connection: () => ipcRenderer.invoke('pf:connection'),
  selectFolder: (title?: string) => ipcRenderer.invoke('pf:selectFolder', title),
  selectFile: (title?: string) => ipcRenderer.invoke('pf:selectFile', title),
  showItemInFolder: (p: string) => ipcRenderer.invoke('pf:showItem', p),
  openExternal: (url: string) => ipcRenderer.invoke('pf:openExternal', url),
  setKeepInTray: (value: boolean) => ipcRenderer.invoke('pf:setKeepInTray', value),
  onNavigate: (fn: (route: string) => void) => {
    const listener = (_e: unknown, route: unknown) => {
      if (typeof route === 'string' && route.startsWith('/')) fn(route);
    };
    ipcRenderer.on('pf:navigate', listener);
    return () => ipcRenderer.off('pf:navigate', listener);
  },
};

contextBridge.exposeInMainWorld('pulseflow', bridge);

export type PulseFlowBridge = typeof bridge;
