import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
const output = path.join(desktop, "release");
const stage = path.join(tmpdir(), "pulseflow-win-package");
const rootPackage = path.join(root, "package.json");
const desktopPackage = path.join(desktop, "package.json");
const beforeRoot = readFileSync(rootPackage, "utf8");
const beforeDesktop = readFileSync(desktopPackage, "utf8");

const windows = process.platform === "win32";
const wine = windows ? { status: 0 } : spawnSync("wine", ["--version"], { stdio: "ignore" });
const nsis = windows || wine.status === 0;
if (!nsis) {
  console.log("NSIS installer skipped on this machine because Wine is not installed. The Windows CI job builds the installer. SmartScreen stays enabled.");
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(path.join(desktop, "dist-electron"), path.join(stage, "dist-electron"), { recursive: true });
cpSync(path.join(desktop, "dist"), path.join(stage, "dist"), { recursive: true });
cpSync(path.join(desktop, "build"), path.join(stage, "build"), { recursive: true });

const pack = {
  name: "pulseflow",
  version: "0.1.0",
  private: true,
  type: "module",
  main: "dist-electron/main.mjs",
  author: "ZeroPulse",
  description: "Local-first workflow automation studio",
  dependencies: {},
  build: {
    appId: "com.zeropulse.pulseflow",
    productName: "PulseFlow",
    copyright: "Copyright ZeroPulse",
    electronVersion: "44.7.0",
    asar: true,
    npmRebuild: false,
    nodeGypRebuild: false,
    directories: { output, buildResources: "build" },
    files: ["dist-electron/**/*", "package.json"],
    extraResources: [
      { from: "dist", to: "ui" },
      { from: "build/icon.png", to: "icon.png" },
    ],
    win: {
      target: nsis
        ? [
            { target: "zip", arch: ["x64"] },
            { target: "nsis", arch: ["x64"] },
          ]
        : [{ target: "zip", arch: ["x64"] }],
      signAndEditExecutable: false,
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: "PulseFlow",
    },
  },
};
writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(pack, null, 2)}\n`);

const result = spawnSync("pnpm", ["exec", "electron-builder", "--win", "--x64", `--projectDir=${stage}`], {
  cwd: desktop,
  stdio: "inherit",
});

const afterRoot = readFileSync(rootPackage, "utf8");
const afterDesktop = readFileSync(desktopPackage, "utf8");
if (afterRoot !== beforeRoot) writeFileSync(rootPackage, beforeRoot);
if (afterDesktop !== beforeDesktop) writeFileSync(desktopPackage, beforeDesktop);
if (afterRoot !== beforeRoot || afterDesktop !== beforeDesktop) {
  console.error("electron-builder rewrote a repository package.json. The original file was restored.");
  process.exit(1);
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
console.log(`Windows artifacts: ${output}`);
