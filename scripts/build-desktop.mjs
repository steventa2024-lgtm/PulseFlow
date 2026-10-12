import { createRequire } from "node:module";
import { mkdirSync, readFileSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, crc32 } from "node:zlib";
import * as esbuild from "esbuild";
import { run } from "./run-process.mjs";
import { runDesktopBootCheck } from "./desktop-boot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps/desktop");
const outDir = path.join(desktop, "dist-electron");
const sqlPath = path.join(root, "packages/storage/migrations/001_init.sql");

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function pulseIcon(size) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const radius = size * 0.36;
  for (let y = 0; y < size; y += 1) {
    const row = y * (1 + size * 4);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = x - size / 2 + 0.5;
      const dy = y - size / 2 + 0.5;
      const inside = Math.sqrt(dx * dx + dy * dy) <= radius;
      const offset = row + 1 + x * 4;
      raw[offset] = inside ? 46 : 11;
      raw[offset + 1] = inside ? 196 : 15;
      raw[offset + 2] = inside ? 182 : 22;
      raw[offset + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function icoFromPng(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

function writeIcons() {
  const buildDir = path.join(desktop, "build");
  mkdirSync(buildDir, { recursive: true });
  const png = pulseIcon(256);
  writeFileSync(path.join(buildDir, "icon.png"), png);
  writeFileSync(path.join(buildDir, "icon.ico"), icoFromPng(png, 256));
}

function migrationPlugin() {
  return {
    name: "inline-pulseflow-migration",
    setup(build) {
      build.onLoad({ filter: /packages[\\/]storage[\\/]src[\\/]index\.ts$/ }, async (args) => {
        const source = readFileSync(args.path, "utf8");
        const pattern =
          /const sqlPath = new URL\("\.\.\/migrations\/001_init\.sql", import\.meta\.url\);\s*const sql = readFileSync\(sqlPath, "utf8"\);/;
        if (!pattern.test(source)) {
          throw new Error(`Desktop bundle could not inline the migration SQL from ${args.path}`);
        }
        const sql = readFileSync(sqlPath, "utf8");
        return {
          contents: source.replace(pattern, `const sql = ${JSON.stringify(sql)};`),
          loader: "ts",
        };
      });
    },
  };
}

const desktopRequire = createRequire(path.join(desktop, "package.json"));

function packageBin(name, binName) {
  const pkgPath = desktopRequire.resolve(`${name}/package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const binField = pkg.bin;
  const relative = typeof binField === "string" ? binField : binField?.[binName];
  if (typeof relative !== "string") throw new Error(`Package ${name} does not expose a ${binName} binary`);
  return path.resolve(path.dirname(pkgPath), relative);
}

async function bundle() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const shared = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["electron"],
    plugins: [migrationPlugin()],
    logLevel: "info",
    banner: {
      js: "import { createRequire as __pulseflowCreateRequire } from 'node:module'; const require = __pulseflowCreateRequire(import.meta.url);",
    },
  };
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(desktop, "electron/main.ts")],
    outfile: path.join(outDir, "main.mjs"),
  });
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(desktop, "electron/boot-check.ts")],
    outfile: path.join(outDir, "boot-check.mjs"),
  });
  copyFileSync(path.join(desktop, "electron/preload.cjs"), path.join(outDir, "preload.cjs"));
  const main = readFileSync(path.join(outDir, "main.mjs"), "utf8");
  const boot = readFileSync(path.join(outDir, "boot-check.mjs"), "utf8");
  if (!main.includes("schema_migrations") || !boot.includes("schema_migrations")) {
    throw new Error("Desktop bundle is missing the inlined SQLite migration");
  }
  if (main.includes("001_init.sql") || boot.includes("001_init.sql")) {
    throw new Error("Desktop bundle still loads the migration from a file path");
  }
}

function electronBinary() {
  const binary = desktopRequire("electron");
  if (typeof binary !== "string") throw new Error("Could not resolve the Electron binary path");
  return binary;
}

writeIcons();
await run(process.execPath, [packageBin("vite", "vite"), "build"], { cwd: desktop });
await bundle();
await runDesktopBootCheck({ electronBinary: electronBinary(), script: path.join(outDir, "boot-check.mjs") });
console.log(`Desktop bundle ready at ${outDir}`);
