import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const blocked = [/GPL/i, /AGPL/i, /SSPL/i, /BUSL/i, /Commons Clause/i, /Sustainable Use/i];
const result = spawnSync("pnpm", ["licenses", "list", "--json"], { encoding: "utf8" });
mkdirSync("artifacts/verification", { recursive: true });
const raw = result.stdout || "{}";
writeFileSync("artifacts/verification/licenses.json", raw);
if (result.status !== 0) {
  console.error(result.stderr);
  process.exit(result.status ?? 1);
}
const parsed = JSON.parse(raw);
const rows = Array.isArray(parsed) ? parsed : Object.values(parsed);
const violations = [];
for (const row of rows) {
  const license = String(row.license ?? row.name ?? "");
  if (blocked.some((pattern) => pattern.test(license))) violations.push(row);
}
writeFileSync("artifacts/verification/license-violations.json", JSON.stringify(violations, null, 2));
if (violations.length > 0) {
  console.error("Blocked licenses found");
  console.error(JSON.stringify(violations, null, 2));
  process.exit(1);
}
console.log(`License audit passed for ${rows.length} package groups`);
