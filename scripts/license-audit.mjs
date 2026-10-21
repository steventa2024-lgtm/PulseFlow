// License audit: every dependency must be OSI/permissive (or explicitly reviewed), and every
// package that is bundled into the shipped app must be permissive. Writes:
//   artifacts/verification/license-audit.json
//   apps/desktop/dist/THIRD_PARTY_NOTICES.txt   (when the desktop app has been built)
//   docs/LICENSE_AUDIT.md generated section        (with --update-docs)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'artifacts/verification');
const bundledFile = path.join(root, 'apps/desktop/dist/bundled-modules.json');

const PERMISSIVE = new Set([
  'MIT',
  'MIT-0',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'Python-2.0',
  'CC-BY-4.0',
  'WTFPL',
  'Zlib',
]);
// Allowed for build-time tooling only (never bundled into the app).
const BUILD_TOOL_ONLY = new Set(['MPL-2.0']);
const DENY = [/GPL/i, /SSPL/i, /BUSL/i, /Business Source/i, /Sustainable Use/i, /Commons Clause/i, /Elastic/i, /UNLICENSED/i, /Unknown/i, /proprietary/i];
const DENY_PACKAGES = [/^n8n/, /^@n8n\//, /^n8n-nodes-/];

function options(expr) {
  return String(expr)
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/i)
    .map((s) => s.trim());
}

function classify(license, shipped) {
  if (DENY.some((re) => re.test(license)) && !options(license).some((o) => PERMISSIVE.has(o))) return 'denied';
  if (options(license).some((o) => PERMISSIVE.has(o))) return 'permissive';
  if (options(license).some((o) => BUILD_TOOL_ONLY.has(o))) return shipped ? 'denied' : 'build-tool-only';
  return 'denied';
}

function pkgNameFromPath(p) {
  const parts = p.replaceAll('\\', '/').split('node_modules/').pop().split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function licenseText(dir) {
  try {
    const f = fs.readdirSync(dir).find((n) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(n));
    return f ? fs.readFileSync(path.join(dir, f), 'utf8').trim() : null;
  } catch {
    return null;
  }
}

const raw = JSON.parse(
  execFileSync('pnpm', ['licenses', 'list', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' }),
);
const shippedNames = fs.existsSync(bundledFile)
  ? new Set(
      JSON.parse(fs.readFileSync(bundledFile, 'utf8'))
        .filter((p) => p.includes('node_modules'))
        .map(pkgNameFromPath),
    )
  : null;
if (!shippedNames) console.warn('warning: apps/desktop/dist/bundled-modules.json not found; run `pnpm build` so shipped packages can be identified');
// Electron is not bundled by esbuild but its runtime ships with the installer.
shippedNames?.add('electron');

const packages = [];
for (const [license, list] of Object.entries(raw)) {
  for (const p of list) {
    const shipped = shippedNames ? shippedNames.has(p.name) : null;
    packages.push({
      name: p.name,
      versions: p.versions,
      license,
      shipped,
      status: classify(license, !!shipped),
      homepage: p.homepage ?? null,
      path: p.paths?.[0] ?? null,
    });
  }
}
for (const p of packages) if (DENY_PACKAGES.some((re) => re.test(p.name))) p.status = 'denied';
packages.sort((a, b) => a.name.localeCompare(b.name));

const denied = packages.filter((p) => p.status === 'denied');
const shipped = packages.filter((p) => p.shipped);
const counts = packages.reduce((acc, p) => ((acc[p.license] = (acc[p.license] ?? 0) + 1), acc), {});
const report = {
  generatedAt: new Date().toISOString(),
  totalPackages: packages.length,
  shippedPackages: shipped.length,
  shippedIdentified: !!shippedNames,
  licenses: counts,
  denied: denied.map((p) => `${p.name}@${p.versions.join(',')} (${p.license})`),
  buildToolOnly: packages.filter((p) => p.status === 'build-tool-only').map((p) => `${p.name} (${p.license})`),
  packages,
};
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'license-audit.json'), `${JSON.stringify(report, null, 2)}\n`);

const distDir = path.join(root, 'apps/desktop/dist');
if (fs.existsSync(distDir) && shippedNames) {
  const own = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  const sections = shipped.map((p) => {
    const text = p.path ? licenseText(p.path) : null;
    return `${'='.repeat(78)}\n${p.name} ${p.versions.join(', ')} — ${p.license}\n${p.homepage ?? ''}\n${'-'.repeat(78)}\n${text ?? `Licensed under ${p.license}.`}\n`;
  });
  fs.writeFileSync(
    path.join(distDir, 'THIRD_PARTY_NOTICES.txt'),
    `PulseFlow by ZeroPulse — Apache-2.0\n\n${own}\n\nThird-party software bundled in this application\n(Electron/Chromium notices ship separately as LICENSES.chromium.html)\n\n${sections.join('\n')}`,
  );
}

if (process.argv.includes('--update-docs')) {
  const docs = path.join(root, 'docs/LICENSE_AUDIT.md');
  const begin = '<!-- BEGIN GENERATED -->';
  const end = '<!-- END GENERATED -->';
  const rows = shipped.map((p) => `| ${p.name} | ${p.versions.join(', ')} | ${p.license} |`).join('\n');
  const summary = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `| ${l} | ${n} |`)
    .join('\n');
  const generated = `${begin}\n_Generated by \`pnpm license:audit --update-docs\` on ${report.generatedAt.slice(0, 10)}._\n\n**${packages.length}** packages in the dependency graph (including build tools), **${shipped.length}** bundled into the app, **${denied.length}** denied.\n\n| License | Packages |\n| --- | --- |\n${summary}\n\n### Bundled into the shipped app\n\n| Package | Version | License |\n| --- | --- | --- |\n${rows}\n${end}`;
  const current = fs.existsSync(docs) ? fs.readFileSync(docs, 'utf8') : `# License audit\n\n${begin}\n${end}\n`;
  fs.writeFileSync(docs, current.replace(new RegExp(`${begin}[\\s\\S]*${end}`), generated));
}

console.log(
  `License audit: ${packages.length} packages, ${shipped.length} shipped, ${denied.length} denied, ${report.buildToolOnly.length} build-tool-only (${report.buildToolOnly.join(', ') || 'none'})`,
);
if (denied.length) {
  console.error(`Denied:\n  ${report.denied.join('\n  ')}`);
  process.exit(1);
}
