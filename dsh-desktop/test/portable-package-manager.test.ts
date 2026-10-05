import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { bundledPackageManager, PNPM_VERSION } from '../lib/desktop/package-manager.js';
import { copyBundledPnpm } from '../scripts/fetch-pnpm.js';
import { removePluginPackage } from '../lib/desktop/plugin-remove.js';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eac 包管理 '));
  const pnpm = path.join(root, 'vendor', 'pnpm');
  fs.mkdirSync(path.join(pnpm, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pnpm, 'package.json'), JSON.stringify({ version: PNPM_VERSION }));
  fs.writeFileSync(path.join(pnpm, 'bin', 'pnpm.cjs'), "console.log('fixture-pnpm');\n");
  fs.writeFileSync(path.join(pnpm, 'bin', 'pnpm.mjs'), '');
  fs.mkdirSync(path.join(pnpm, 'dist'));
  fs.writeFileSync(path.join(pnpm, 'dist', 'pnpm.mjs'), '');
  return { root, pnpm };
}

test('portable package manager invokes an absolute JS entry without ambient pnpm', () => {
  const { root } = fixture();
  try {
    const inv = bundledPackageManager(root, process.execPath);
    assert.deepEqual(inv.args, [path.join(root, 'vendor', 'pnpm', 'bin', 'pnpm.cjs')]);
    const result = spawnSync(inv.command, inv.args, { encoding: 'utf8', env: { ...process.env, PATH: '' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'fixture-pnpm');
    assert.equal(Object.values(inv.env)[0].split(path.delimiter)[0], path.dirname(process.execPath));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing or wrong pnpm fails clearly without global fallback', () => {
  const { root, pnpm } = fixture();
  try {
    fs.writeFileSync(path.join(pnpm, 'package.json'), '{"version":"0.0.0"}');
    assert.throws(() => bundledPackageManager(root, process.execPath), /must be 11\.7\.0/);
    assert.throws(() => copyBundledPnpm(pnpm, path.join(root, 'copy')), /Expected pnpm/);
    fs.writeFileSync(path.join(pnpm, 'package.json'), JSON.stringify({ version: PNPM_VERSION }));
    fs.rmSync(path.join(pnpm, 'dist', 'pnpm.mjs'));
    assert.throws(() => bundledPackageManager(root, process.execPath), /Bundled pnpm/);
    fs.rmSync(pnpm, { recursive: true, force: true });
    assert.throws(() => bundledPackageManager(root, process.execPath), /Bundled pnpm is missing/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('carrier preserves CLI arguments, selected overlay and pnpm configuration', () => {
  const { root, pnpm } = fixture();
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'lib', 'desktop'), { recursive: true });
    for (const file of ['scripts/eac-cli.js', 'lib/desktop/package-manager.js']) {
      fs.copyFileSync(path.join(desktop, file), path.join(root, file));
    }
    const kernel = path.join(root, 'selected overlay.mjs');
    fs.writeFileSync(kernel, 'export async function runCli(options) { console.log(JSON.stringify({ options, args: process.argv.slice(2), kernel: process.env.DSH_EAC_KERNEL_BIN, carrier: process.env.DSH_BIN })); }');
    const carrier = path.join(root, 'scripts', 'eac-cli.js');
    const args = ['plugin', '--profile', 'web-desktop', 'remove', '@example/pet'];
    const result = spawnSync(process.execPath, [carrier, ...args], {
      encoding: 'utf8', env: { ...process.env, PATH: '', DSH_EAC_KERNEL_BIN: kernel },
    });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.deepEqual(actual.args, args);
    assert.equal(actual.kernel, kernel);
    assert.equal(actual.carrier, carrier);
    assert.equal(actual.options.packageManager.command, process.execPath);
    assert.deepEqual(actual.options.packageManager.args, [path.join(pnpm, 'bin', 'pnpm.cjs')]);
    fs.rmSync(path.join(pnpm, 'bin', 'pnpm.cjs'));
    const missing = spawnSync(process.execPath, [carrier, ...args], { encoding: 'utf8', env: { ...process.env, DSH_EAC_KERNEL_BIN: kernel } });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Bundled pnpm/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('market reinvocation recognizes the EAC carrier before an unrelated DSH_BIN', () => {
  const source = fs.readFileSync(path.join(desktop, 'assets/plugins/dsh-unified-market/lib/host.js'), 'utf8');
  const start = source.indexOf('function dshInvoke(');
  const end = source.indexOf('/** The resolved CLI entry', start);
  const carrier = path.join('C:', '包 目录', 'scripts', 'eac-cli.js');
  const context = vm.createContext({ process: { execPath: 'node.exe', execArgv: [], argv: ['node.exe', carrier], env: { DSH_BIN: 'wrong.js' }, cwd: () => '' }, existsSync: () => false, dirname: path.dirname });
  vm.runInContext(source.slice(start, end), context);
  const inv = JSON.parse(JSON.stringify(vm.runInContext('dshInvoke()', context)));
  assert.deepEqual(inv.args, [carrier]);
});

test('external removal uses the carrier transaction with exact package and profile arguments', async () => {
  const { root } = fixture();
  try {
    const carrier = path.join(root, 'remove.cjs');
    const capture = path.join(root, 'invocation.json');
    fs.writeFileSync(carrier, 'require("node:fs").writeFileSync(process.env.CAPTURE, JSON.stringify({args:process.argv.slice(2),kernel:process.env.DSH_EAC_KERNEL_BIN}));');
    const result = await removePluginPackage({ node: process.execPath, carrier, kernel: 'selected-kernel', profile: 'web-desktop', name: '@example/pet', cwd: root, env: { ...process.env, CAPTURE: capture } });
    assert.deepEqual(result, { ok: true, restartRequired: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { args: ['plugin', '--profile', 'web-desktop', 'remove', '@example/pet'], kernel: 'selected-kernel' });
    fs.writeFileSync(carrier, 'process.exit(2);');
    const failure = await removePluginPackage({ node: process.execPath, carrier, kernel: 'selected-kernel', profile: 'web-desktop', name: '@example/pet', cwd: root, env: process.env });
    assert.equal(failure.ok, false);
    assert.match(failure.error || '', /exit 2/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
