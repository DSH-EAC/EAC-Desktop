import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { togglePackage, installedPackageName } from '../assets/plugins/dsh-unified-market/lib/bundle-toggle.mjs';
import { parsePatchData } from '../lib/bundle-identity.js';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DSH_DESKTOP_RESOURCE_ROOT = desktop;
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-bundle-'));
  const name = '@example/pet';
  const pkg = path.join(dir, 'node_modules', name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: 'declared.yml' } } }));
  fs.writeFileSync(path.join(pkg, 'declared.yml'), '- insert:\n    - id: pet # actual loader id\n      name: "@example/pet"\n    - id: pet-settings\n      name: "@example/pet/settings"\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { [name]: 'github:example/pet' }, dsh: { profile: { bundles: [name] } } }));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# user choice\n- id: unrelated\n  config: { keep: true }\n');
  return { dir, name, pkg };
}

test('market toggles declared entries and retains bundle registration and user settings', () => {
  const f = fixture();
  try {
    const manifest = fs.readFileSync(path.join(f.dir, 'package.json'), 'utf8');
    for (const enabled of [false, true, false]) {
      const result = togglePackage(f.dir, f.name, enabled);
      assert.equal(result.ok, true, result.error);
      assert.deepEqual(result.entryIds, ['pet', 'pet-settings']);
      assert.equal(fs.readFileSync(path.join(f.dir, 'package.json'), 'utf8'), manifest);
      const rows = parsePatchData(fs.readFileSync(path.join(f.dir, 'cordis.patch.yml'), 'utf8')) as any[];
      assert.deepEqual(rows[0], { id: 'unrelated', config: { keep: true } });
      assert.deepEqual(rows.slice(1), [{ id: 'pet', disabled: !enabled }, { id: 'pet-settings', disabled: !enabled }]);
    }
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('market rejects unresolved metadata without guessing IDs or writing files', () => {
  const f = fixture();
  try {
    const patch = path.join(f.dir, 'cordis.patch.yml');
    const before = fs.readFileSync(patch, 'utf8');
    fs.rmSync(path.join(f.pkg, 'declared.yml'));
    assert.equal(togglePackage(f.dir, f.name, false).ok, false);
    assert.equal(togglePackage(f.dir, 'unregistered', true).ok, false);
    assert.equal(fs.readFileSync(patch, 'utf8'), before);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('market maps an installation spec to a unique package and refuses ambiguous updates', () => {
  const f = fixture();
  try {
    assert.equal(installedPackageName(f.dir, { target: 'github:example/pet', beforeDeps: {} }), f.name);
    assert.equal(installedPackageName(f.dir, { target: f.name, beforeDeps: { [f.name]: 'old' } }), f.name);
    assert.throws(() => installedPackageName(f.dir, { target: 'github:unknown/repo', beforeDeps: { [f.name]: 'old' } }), /无法唯一确定/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
