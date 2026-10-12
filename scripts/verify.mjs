import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const steps = [
  ["typecheck", "pnpm", ["typecheck"]],
  ["lint", "pnpm", ["exec", "eslint", ".", "--max-warnings", "0"]],
  ["test", "pnpm", ["test"]],
  ["license", "node", ["scripts/license-audit.mjs"]],
];

mkdirSync("artifacts/verification", { recursive: true });
const report = [];
let failed = false;
for (const [name, command, args] of steps) {
  const started = Date.now();
  const result = spawnSync(command, args, { encoding: "utf8" });
  const entry = {
    name,
    command: [command, ...args].join(" "),
    exitCode: result.status,
    ms: Date.now() - started,
  };
  report.push(entry);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(`artifacts/verification/${name}.log`, output);
  console.log(`${name}: exit ${result.status}`);
  if (result.status !== 0) failed = true;
}
writeFileSync("artifacts/verification/report.json", JSON.stringify({ ok: !failed, steps: report }, null, 2));
if (failed) process.exit(1);
