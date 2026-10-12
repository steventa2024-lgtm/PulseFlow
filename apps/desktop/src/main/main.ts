import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
  type IpcMainInvokeEvent,
  type UtilityProcess,
} from 'electron';

const DEV_RENDERER_URL = process.env.PULSEFLOW_DEV_RENDERER_URL ?? '';
const SMOKE = process.argv.includes('--smoke-test');
const debug = (msg: string) => {
  if (process.env.PULSEFLOW_DEBUG || SMOKE) console.log(`[main] ${msg}`);
};

type KeyProtection = 'os-keychain' | 'file';

interface HostState {
  child: UtilityProcess;
  url: string;
  token: string;
}

let host: HostState | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let keepInTray = true;
let quitting = false;
let keyProtection: KeyProtection = 'file';

if (process.env.PULSEFLOW_DATA_DIR) app.setPath('userData', path.resolve(process.env.PULSEFLOW_DATA_DIR));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot, (err: unknown) => fatal(err));
}

function assetPath(name: string): string {
  return path.join(__dirname, '..', 'assets', name);
}

/**
 * The credential master key is encrypted with the OS keychain (DPAPI on Windows) via safeStorage.
 * On Linux without a keyring safeStorage falls back to a hard-coded key ("basic_text"), which is
 * not protection, so we use a 0600 key file instead and report that honestly in Settings.
 */
function loadMasterKey(dataDir: string): Buffer {
  const sealed = path.join(dataDir, 'master.key.safe');
  const plain = path.join(dataDir, 'master.key');
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
  const osProtected = safeStorage.isEncryptionAvailable() && backend !== 'basic_text' && backend !== 'unknown';
  fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(sealed)) {
    keyProtection = 'os-keychain';
    return Buffer.from(safeStorage.decryptString(fs.readFileSync(sealed)), 'base64');
  }
  if (fs.existsSync(plain)) {
    const key = Buffer.from(fs.readFileSync(plain, 'utf8').trim(), 'base64');
    if (osProtected) {
      fs.writeFileSync(sealed, safeStorage.encryptString(key.toString('base64')));
      fs.rmSync(plain);
      keyProtection = 'os-keychain';
    }
    return key;
  }
  const key = crypto.randomBytes(32);
  if (osProtected) {
    fs.writeFileSync(sealed, safeStorage.encryptString(key.toString('base64')));
    keyProtection = 'os-keychain';
  } else {
    fs.writeFileSync(plain, key.toString('base64'), { mode: 0o600 });
  }
  return key;
}

function startHost(dataDir: string, masterKey: Buffer): Promise<HostState> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, '..', 'host', 'utility.cjs'), [], {
      serviceName: 'PulseFlow Host',
      stdio: 'pipe',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[host] ${d.toString()}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[host] ${d.toString()}`));
    let ready = false;
    child.on('message', (msg: { type: string; [k: string]: unknown }) => {
      if (msg.type === 'ready') {
        ready = true;
        resolve({ child, url: String(msg.url), token: String(msg.token) });
      } else if (msg.type === 'error' && !ready) {
        reject(new Error(String(msg.message)));
      } else if (msg.type === 'notify') {
        showNotification(String(msg.title), String(msg.body), msg.workflowId ? String(msg.workflowId) : undefined);
      } else if (msg.type === 'log') {
        console.log(`[host:${String(msg.level)}] ${String(msg.message)}`);
      }
    });
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`Host process exited during startup (code ${code})`));
      else if (!quitting) void onHostCrash(code);
    });
    child.postMessage({ type: 'start', dataDir, masterKey: masterKey.toString('base64'), staticDir: path.join(__dirname, '..', 'renderer') });
  });
}

async function onHostCrash(code: number): Promise<void> {
  host = null;
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'PulseFlow engine stopped',
    message: `The PulseFlow engine stopped unexpectedly (exit code ${code}).`,
    detail: 'Interrupted runs are marked as failed and durable waits resume when the engine restarts.',
    buttons: ['Restart engine', 'Quit'],
    defaultId: 0,
  });
  if (response === 1) return app.quit();
  await launchHost();
  mainWindow?.loadURL(rendererUrl());
}

function rendererUrl(): string {
  return DEV_RENDERER_URL || `${host!.url}/`;
}

function allowedOrigins(): string[] {
  const list = host ? [new URL(host.url).origin] : [];
  if (DEV_RENDERER_URL) list.push(new URL(DEV_RENDERER_URL).origin);
  return list;
}

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url;
  if (!url || !allowedOrigins().includes(new URL(url).origin)) throw new Error('Untrusted IPC sender');
}

async function launchHost(): Promise<void> {
  const dataDir = app.getPath('userData');
  host = await startHost(dataDir, loadMasterKey(dataDir));
  try {
    const res = await fetch(`${host.url}/api/settings`, { headers: { authorization: `Bearer ${host.token}` } });
    const settings = (await res.json()) as { keepRunningInTray?: boolean };
    keepInTray = settings.keepRunningInTray !== false;
  } catch {
    keepInTray = true;
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0B0F16',
    title: 'PulseFlow',
    icon: assetPath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    if (!SMOKE) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && keepInTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('did-start-loading', () => debug('did-start-loading'));
  win.webContents.on('dom-ready', () => debug('dom-ready'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => debug(`load failed ${code} ${desc} ${url}`));
  win.webContents.on('render-process-gone', (_e, d) => debug(`renderer gone: ${d.reason} (${d.exitCode})`));
  win.on('closed', () => {
    mainWindow = null;
  });
  void win.loadURL(rendererUrl());
  return win;
}

function showWindow(): void {
  if (!mainWindow) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showNotification(title: string, body: string, workflowId?: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: assetPath('icon.png') });
  n.on('click', () => {
    showWindow();
    if (workflowId) mainWindow?.webContents.send('pf:navigate', `/workflows/${workflowId}`);
  });
  n.show();
}

function createTray(): void {
  const image = nativeImage.createFromPath(assetPath('tray.png'));
  tray = new Tray(image);
  tray.setToolTip('PulseFlow');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open PulseFlow', click: () => showWindow() },
      { label: 'Executions', click: () => (showWindow(), mainWindow?.webContents.send('pf:navigate', '/executions')) },
      { type: 'separator' },
      { label: 'Quit PulseFlow', click: () => quit() },
    ]),
  );
  tray.on('click', () => showWindow());
}

function registerIpc(): void {
  ipcMain.handle('pf:connection', (e) => {
    assertTrustedSender(e);
    return {
      token: host?.token ?? null,
      shell: 'desktop',
      keyProtection,
      platform: process.platform,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    };
  });
  ipcMain.handle('pf:selectFolder', async (e, title: unknown) => {
    assertTrustedSender(e);
    const r = await dialog.showOpenDialog(mainWindow!, {
      title: typeof title === 'string' ? title.slice(0, 200) : 'Select folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('pf:selectFile', async (e, title: unknown) => {
    assertTrustedSender(e);
    const r = await dialog.showOpenDialog(mainWindow!, { title: typeof title === 'string' ? title.slice(0, 200) : 'Select file', properties: ['openFile'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle('pf:showItem', (e, p: unknown) => {
    assertTrustedSender(e);
    if (typeof p !== 'string' || !path.isAbsolute(p) || !fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle('pf:openExternal', async (e, url: unknown) => {
    assertTrustedSender(e);
    if (typeof url !== 'string') return false;
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    await shell.openExternal(u.toString());
    return true;
  });
  ipcMain.handle('pf:setKeepInTray', (e, value: unknown) => {
    assertTrustedSender(e);
    keepInTray = value === true;
    return keepInTray;
  });
}

function hardenSessions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (ev, url) => {
      if (!allowedOrigins().includes(new URL(url).origin)) ev.preventDefault();
    });
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'https:' || u.protocol === 'http:') void shell.openExternal(u.toString());
      } catch {
        /* ignore malformed URLs */
      }
      return { action: 'deny' };
    });
  });
}

async function boot(): Promise<void> {
  Menu.setApplicationMenu(null);
  hardenSessions();
  registerIpc();
  debug('launching host');
  await launchHost();
  debug(`host ready at ${host?.url}`);
  if (!SMOKE) createTray();
  mainWindow = createWindow();
  if (SMOKE) await smokeTest();
}

/** `--smoke-test`: load the UI, confirm the API answers through the renderer origin, then exit. */
async function smokeTest(): Promise<void> {
  const win = mainWindow!;
  if (win.webContents.isLoading()) await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()));
  debug('renderer loaded');
  const result = (await win.webContents.executeJavaScript(
    `new Promise((resolve) => { const t = Date.now(); (function poll() { const el = document.querySelector('[data-testid="app-ready"]'); if (el) resolve({ ok: true, title: document.title }); else if (Date.now() - t > 20000) resolve({ ok: false, body: document.body.innerText.slice(0, 500) }); else setTimeout(poll, 200); })(); })`,
  )) as { ok: boolean };
  console.log(`SMOKE ${JSON.stringify({ ...result, keyProtection, url: host?.url })}`);
  quitting = true;
  await stopHost();
  app.exit(result.ok ? 0 : 1);
}

async function stopHost(): Promise<void> {
  const h = host;
  if (!h) return;
  host = null;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      h.child.kill();
      resolve();
    }, 5000);
    h.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    h.child.postMessage({ type: 'stop' });
  });
}

function quit(): void {
  quitting = true;
  app.quit();
}

app.on('before-quit', (e) => {
  quitting = true;
  if (host) {
    e.preventDefault();
    void stopHost().then(() => app.quit());
  }
});

app.on('window-all-closed', () => {
  if (!keepInTray || !tray) quit();
});

function fatal(err: unknown): void {
  console.error(err);
  dialog.showErrorBox('PulseFlow failed to start', (err as Error).message ?? String(err));
  app.exit(1);
}
