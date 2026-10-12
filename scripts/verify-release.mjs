// Runs every release gate and records real exit codes, durations and test counts in
// artifacts/verification/ (summary.json + summary.md). Exit code is non-zero if any required gate fails.
//
//   pnpm verify:release              all gates (desktop gates need a display; uses xvfb-run on Linux when available)
//   pnpm verify:release --package    also run the platform installer build
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'artifacts/verification');
fs.mkdirSync(out, { recursive: true });
const withPackage = process.argv.includes('--package');

const hasCmd = (c) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [c], { stdio: 'ignore' }).status === 0;
const linuxNoDisplay = process.platform === 'linux' && !process.env.DISPLAY;
const guiPrefix = linuxNoDisplay && hasCmd('xvfb-run') ? ['xvfb-run', '-a'] : [];
const guiAvailable = process.platform !== 'linux' || !!process.env.DISPLAY || guiPrefix.length > 0;
const electronArgs = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];

const steps = [
  { id: 'typecheck', cmd: ['pnpm', '-r', 'typecheck'] },
  { id: 'lint', cmd: ['pnpm', 'lint'] },
  { id: 'format', cmd: ['pnpm', 'format:check'] },
  {
    id: 'unit',
    cmd: [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--project',
      'unit',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=artifacts/verification/unit-results.json',
    ],
    report: 'unit-results.json',
  },
  {
    id: 'templates',
    cmd: [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--project',
      'templates',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=artifacts/verification/template-results.json',
    ],
    report: 'template-results.json',
  },
  {
    id: 'perf',
    cmd: [
      'pnpm',
      'exec',
      'vitest',
      'run',
      '--project',
      'perf',
      '--reporter=default',
      '--reporter=json',
      '--outputFile.json=artifacts/verification/perf-results.json',
    ],
    report: 'perf-results.json',
  },
  { id: 'build', cmd: ['pnpm', 'build'] },
  { id: 'cli-templates', cmd: ['node', '--disable-warning=ExperimentalWarning', 'apps/server/dist/cli.cjs', 'templates:test'] },
  {
    id: 'cli-doctor',
    cmd: [
      'node',
      '--disable-warning=ExperimentalWarning',
      'apps/server/dist/cli.cjs',
      'doctor',
      '--data-dir',
      path.join(os.tmpdir(), `pulseflow-doctor-${process.pid}`),
    ],
  },
  { id: 'license-audit', cmd: ['node', 'scripts/license-audit.mjs'] },
  { id: 'sbom', cmd: ['node', 'scripts/sbom.mjs'] },
  { id: 'secret-scan', fn: secretScan },
  {
    id: 'desktop-smoke',
    cmd: [...guiPrefix, 'pnpm', '--filter', '@pulseflow/desktop', 'exec', 'electron', '.', '--smoke-test', ...electronArgs],
    env: { PULSEFLOW_DATA_DIR: path.join(os.tmpdir(), `pulseflow-smoke-${process.pid}`) },
    skip: guiAvailable ? null : 'no display (install xvfb or set DISPLAY)',
  },
  {
    id: 'e2e',
    cmd: [...guiPrefix, 'pnpm', 'exec', 'playwright', 'test'],
    report: 'e2e-results.json',
    skip: guiAvailable ? null : 'no display (install xvfb or set DISPLAY)',
  },
  ...(withPackage ? [{ id: 'package', cmd: ['pnpm', process.platform === 'win32' ? 'package:win' : 'package:linux'] }] : []),
];

function secretScan() {
  const files = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const patterns = [
    [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'private key'],
    [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
    [/\bsk-[A-Za-z0-9]{32,}\b/, 'API secret key'],
    [/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, 'Telegram bot token'],
  ];
  const findings = [];
  for (const f of files) {
    if (/\.(png|ico|jpg|lock)$/.test(f) || f === 'pnpm-lock.yaml') continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    for (const [re, label] of patterns) if (re.test(text)) findings.push(`${f}: ${label}`);
  }
  const forbidden = files.filter((f) => /(^|\/)(\.env|master\.key|.*\.db)$/.test(f));
  for (const f of forbidden) findings.push(`${f}: secret/data file is tracked`);
  return { status: findings.length ? 1 : 0, output: findings.length ? findings.join('\n') : `scanned ${files.length} tracked files, no secrets found` };
}

function counts(report) {
  const file = path.join(out, report);
  if (!fs.existsSync(file)) return null;
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  if ('numTotalTests' in r)
    return { total: r.numTotalTests, passed: r.numPassedTests, failed: r.numFailedTests, skipped: r.numPendingTests + (r.numTodoTests ?? 0) };
  if (r.stats)
    return {
      total: r.stats.expected + r.stats.unexpected + r.stats.flaky + r.stats.skipped,
      passed: r.stats.expected,
      failed: r.stats.unexpected,
      skipped: r.stats.skipped,
      flaky: r.stats.flaky,
    };
  return null;
}

const results = [];
for (const s of steps) {
  process.stdout.write(`\n▶ ${s.id}\n`);
  if (s.skip) {
    results.push({ id: s.id, status: 'skipped', reason: s.skip, exitCode: null, durationMs: 0 });
    console.log(`  skipped: ${s.skip}`);
    continue;
  }
  const t = Date.now();
  let status;
  let output = '';
  if (s.fn) {
    const r = s.fn();
    status = r.status;
    output = r.output;
    console.log(output);
  } else {
    const r = spawnSync(s.cmd[0], s.cmd.slice(1), {
      cwd: root,
      env: { ...process.env, ...s.env },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
    status = r.status ?? 1;
    output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    process.stdout.write(output.split('\n').slice(-25).join('\n'));
  }
  fs.writeFileSync(path.join(out, `${s.id}.log`), output);
  results.push({
    id: s.id,
    command: s.cmd?.join(' ') ?? '(built-in)',
    status: status === 0 ? 'passed' : 'failed',
    exitCode: status,
    durationMs: Date.now() - t,
    ...(s.report ? { tests: counts(s.report) } : {}),
  });
  console.log(`\n  ${status === 0 ? 'PASS' : 'FAIL'} (exit ${status}, ${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout.trim();
const summary = {
  generatedAt: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  git: { branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), sha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 },
  ok: results.every((r) => r.status !== 'failed'),
  steps: results,
};
fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const md = [
  `# Release verification`,
  ``,
  `- Generated: ${summary.generatedAt}`,
  `- Platform: ${summary.platform}, Node ${summary.node}`,
  `- Git: ${summary.git.branch} @ ${summary.git.sha.slice(0, 12)}${summary.git.dirty ? ' (uncommitted changes)' : ''}`,
  `- Result: **${summary.ok ? 'PASS' : 'FAIL'}**`,
  ``,
  `| Gate | Status | Exit | Duration | Tests |`,
  `| --- | --- | --- | --- | --- |`,
  ...results.map(
    (r) =>
      `| ${r.id} | ${r.status}${r.reason ? ` (${r.reason})` : ''} | ${r.exitCode ?? '—'} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.tests ? `${r.tests.passed}/${r.tests.total} passed${r.tests.failed ? `, ${r.tests.failed} failed` : ''}${r.tests.skipped ? `, ${r.tests.skipped} skipped` : ''}` : ''} |`,
  ),
  ``,
].join('\n');
fs.writeFileSync(path.join(out, 'summary.md'), md);
console.log(`\n${md}`);
process.exit(summary.ok ? 0 : 1);
