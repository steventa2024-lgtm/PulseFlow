import { spawn, spawnSync } from "node:child_process";

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.stdio ?? "inherit",
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(formatSpawnError(command, args, error)));
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(formatExit(command, args, code, signal)));
    });
  });
}

export function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) throw new Error(formatSpawnError(command, args, result.error));
  if (result.status !== 0) throw new Error(formatExit(command, args, result.status, result.signal));
  return result;
}

export function commandAvailable(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function formatSpawnError(command, args, error) {
  const hint =
    error.code === "ENOENT"
      ? ` "${command}" was not found. A Windows .cmd shim is not spawned by an absolute-free name.`
      : "";
  return `Failed to start ${command} (${error.code ?? "error"}): ${error.message}.${hint}\nCommand: ${command} ${args.join(" ")}`;
}

function formatExit(command, args, code, signal) {
  return `Process exited ${code ?? "null"}${signal ? ` signal ${signal}` : ""}.\nCommand: ${command} ${args.join(" ")}`;
}
