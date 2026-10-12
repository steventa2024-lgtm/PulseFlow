// Writes a CycloneDX 1.5 SBOM of the full dependency graph to artifacts/verification/sbom.cdx.json,
// marking which components are bundled into the shipped desktop app.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const raw = JSON.parse(execFileSync('pnpm', ['licenses', 'list', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const bundledFile = path.join(root, 'apps/desktop/dist/bundled-modules.json');
const shipped = fs.existsSync(bundledFile)
  ? new Set(
      JSON.parse(fs.readFileSync(bundledFile, 'utf8'))
        .filter((p) => p.includes('node_modules'))
        .map((p) => {
          const parts = p.split('node_modules/').pop().split('/');
          return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
        }),
    )
  : new Set();

const components = [];
for (const [license, list] of Object.entries(raw)) {
  for (const p of list) {
    for (const version of p.versions) {
      const purl = `pkg:npm/${p.name.startsWith('@') ? `%40${p.name.slice(1)}` : p.name}@${version}`;
      components.push({
        type: 'library',
        'bom-ref': purl,
        name: p.name,
        version,
        purl,
        licenses: [/\s(OR|AND)\s/.test(license) || license.startsWith('(') ? { expression: license } : { license: { id: license } }],
        scope: shipped.has(p.name) || p.name === 'electron' ? 'required' : 'excluded',
        properties: [{ name: 'pulseflow:bundled', value: String(shipped.has(p.name) || p.name === 'electron') }],
      });
    }
  }
}
components.sort((a, b) => a.name.localeCompare(b.name));

const bom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: 'PulseFlow', name: 'scripts/sbom.mjs', version: pkg.version }],
    component: { type: 'application', name: 'PulseFlow', version: pkg.version, licenses: [{ license: { id: 'Apache-2.0' } }], supplier: { name: 'ZeroPulse' } },
  },
  components,
};
const out = path.join(root, 'artifacts/verification/sbom.cdx.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
console.log(`SBOM: ${components.length} components (${components.filter((c) => c.scope === 'required').length} bundled) → ${path.relative(root, out)}`);
