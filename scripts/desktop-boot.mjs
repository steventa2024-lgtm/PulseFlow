import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function runDesktopBootCheck({ electronBinary, script, home = mkdtempSync(path.join(tmpdir(), "pulseflow-desktop-boot-")) }) {
  if (!electronBinary) throw new Error("Desktop boot check has no Electron binary");
  if (!script) throw new Error("Desktop boot check has no script");
  return new Promise((resolve, reject) => {
    const child = spawn(electronBinary, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PULSEFLOW_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Desktop boot check timed out after 30s\n${stdout}\n${stderr}`));
    }, 30_000);
    child.on("error", (error) => {
      finish(new Error(`Desktop boot check could not start Electron: ${error.message}\nBinary: ${electronBinary}`));
    });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code, signal) => {
      if (code === 0 && stdout.includes("boot-ok")) {
        console.log(stdout.trim());
        finish();
        return;
      }
      finish(
        new Error(
          `Desktop boot check failed (exit ${code ?? "null"}${signal ? ` signal ${signal}` : ""})\n${stdout}\n${stderr}`,
        ),
      );
    });
  });
}
