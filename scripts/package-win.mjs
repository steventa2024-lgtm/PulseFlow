import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandAvailable, runSync } from "./run-process.mjs";
import { runDesktopBootCheck } from "./desktop-boot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
const output = path.join(desktop, "release");
const stage = path.join(tmpdir(), "pulseflow-win-package");
const rootPackage = path.join(root, "package.json");
const desktopPackage = path.join(desktop, "package.json");
const beforeRoot = readFileSync(rootPackage, "utf8");
const beforeDesktop = readFileSync(desktopPackage, "utf8");
const desktopRequire = createRequire(desktopPackage);

function packageBin(name, binName) {
  const pkgPath = desktopRequire.resolve(`${name}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const binField = pkg.bin;
  const relative = typeof binField === "string" ? binField : binField?.[binName];
  if (typeof relative !== "string") throw new Error(`Package ${name} does not expose a ${binName} binary`);
  return path.resolve(path.dirname(pkgPath), relative);
}

const windows = process.platform === "win32";
const nsis = windows || commandAvailable("wine");
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
    files: [
      { from: "dist-electron", to: "dist-electron", filter: ["**/*"] },
      "package.json",
    ],
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

let failed = false;
try {
  runSync(
    process.execPath,
    [packageBin("electron-builder", "electron-builder"), "--win", "--x64", "--publish", "never", `--projectDir=${stage}`],
    { cwd: stage },
  );
  const electronBinary = desktopRequire("electron");
  if (typeof electronBinary !== "string") throw new Error("Could not resolve the Electron binary path");
  await runDesktopBootCheck({
    electronBinary,
    script: path.join(stage, "dist-electron", "boot-check.mjs"),
  });
  assertArtifacts(nsis);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  const afterRoot = readFileSync(rootPackage, "utf8");
  const afterDesktop = readFileSync(desktopPackage, "utf8");
  if (afterRoot !== beforeRoot) writeFileSync(rootPackage, beforeRoot);
  if (afterDesktop !== beforeDesktop) writeFileSync(desktopPackage, beforeDesktop);
  if (afterRoot !== beforeRoot || afterDesktop !== beforeDesktop) {
    console.error("electron-builder rewrote a repository package.json. The original file was restored.");
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`Windows artifacts: ${output}`);

function assertArtifacts(expectInstaller) {
  const zip = path.join(output, "PulseFlow-0.1.0-win.zip");
  requireFile(zip, 1_000_000);
  const unpacked = path.join(output, "win-unpacked");
  requireFile(path.join(unpacked, "resources", "ui", "index.html"), 100);
  requireFile(path.join(unpacked, "resources", "icon.png"), 100);
  const asarPath = path.join(unpacked, "resources", "app.asar");
  requireFile(asarPath, 100_000);
  const asar = createRequire(packageBin("electron-builder", "electron-builder"))("@electron/asar");
  const entries = asar.listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/").replace(/^\/+/, ""));
  for (const required of ["dist-electron/main.mjs", "dist-electron/preload.cjs", "dist-electron/boot-check.mjs"]) {
    if (!entries.includes(required)) {
      throw new Error(`Packaged app.asar is missing ${required}. Found: ${entries.join(", ") || "(empty)"}`);
    }
  }
  const packedBoot = asar.extractFile(asarPath, "dist-electron/boot-check.mjs").toString("utf8");
  if (!packedBoot.includes("schema_migrations")) {
    throw new Error("Packaged bundle is missing the inlined SQLite migration");
  }
  if (expectInstaller) {
    const installer = path.join(output, "PulseFlow Setup 0.1.0.exe");
    requireFile(installer, 1_000_000);
  }
  console.log(`Verified zip ${zip}${expectInstaller ? " and the NSIS installer" : ""}`);
}

function requireFile(file, minimumBytes) {
  if (!existsSync(file)) throw new Error(`Missing build artifact ${file}`);
  const size = statSync(file).size;
  if (size < minimumBytes) throw new Error(`Build artifact ${file} is only ${size} bytes`);
}
