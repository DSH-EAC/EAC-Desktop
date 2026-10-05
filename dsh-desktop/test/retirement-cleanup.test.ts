import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runtimePaths = require('../lib/desktop/runtime-paths.js');
const companion = require('../lib/desktop/companion-sync.js');
const { parsePatchData } = require('../lib/bundle-identity.js');
const ID = 'dsh-whale-widget';
const STAMP = '.eac-copy-stamp.json';

function fixture(managed = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-retirement-'));
  const profile = path.join(root, 'profile');
  const userData = path.join(root, 'userdata');
  const plugin = path.join(profile, 'node_modules', ID);
  fs.mkdirSync(plugin, { recursive: true });
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: ID, version: '1.0.0' }));
  fs.writeFileSync(path.join(plugin, 'zz-locked.txt'), 'payload');
  if (managed) fs.writeFileSync(path.join(plugin, STAMP), JSON.stringify({ v: '1.0.0', f: 2, b: 60, h: 'abc' }));
  const patch = path.join(profile, 'cordis.patch.yml');
  const manifest = path.join(profile, 'package.json');
  const settings = path.join(userData, 'settings.json');
  fs.writeFileSync(patch, `- insert:\n    - id: ${ID}\n      name: ${ID}\n      disabled: true\n    - id: unrelated\n      name: user-package\n`);
  fs.writeFileSync(manifest, JSON.stringify({ dependencies: { [ID]: '1.0.0', 'user-package': 'link:../local' }, dsh: { profile: { bundles: [ID, 'user-package'] } } }));
  fs.writeFileSync(settings, JSON.stringify({ userPreference: 'preserve' }));
  const logs: string[] = [];
  runtimePaths.init({ log: (_: string, message: string) => logs.push(message), getUserDataDir: () => userData });
  companion.init({ log: (_: string, message: string) => logs.push(message), getDshHome: () => root, getUserDataDir: () => userData });
  return { root, profile, plugin, patch, manifest, settings, logs };
}
function json(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function cleanup(f: ReturnType<typeof fixture>) { fs.rmSync(f.root, { recursive: true, force: true }); }
function migrate(f: ReturnType<typeof fixture>) { companion.retireRemovedBuiltinPluginsGated(f.profile); }
function assertNotAligned(f: ReturnType<typeof fixture>) {
  assert.equal(json(f.settings).pluginTreeAlignedVersion, undefined);
  assert.equal(json(f.settings).userPreference, 'preserve');
}
function assertAligned(f: ReturnType<typeof fixture>) {
  assert.equal(typeof json(f.settings).pluginTreeAlignedVersion, 'string');
  assert.equal(typeof json(f.settings).pluginTreeRetiredListHash, 'string');
  assert.equal(json(f.settings).userPreference, 'preserve');
}

test('retirement removes only a stamped managed copy and is idempotent', () => {
  const f = fixture();
  try {
    migrate(f);
    assert.equal(fs.existsSync(f.plugin), false);
    assert.doesNotMatch(fs.readFileSync(f.patch, 'utf8'), /dsh-whale-widget/);
    assert.match(fs.readFileSync(f.patch, 'utf8'), /unrelated/);
    assert.equal(json(f.manifest).dependencies[ID], undefined);
    assert.deepEqual(json(f.manifest).dsh.profile.bundles, ['user-package']);
    assertAligned(f);
    const saved = fs.readFileSync(f.settings, 'utf8');
    migrate(f);
    assert.equal(fs.readFileSync(f.settings, 'utf8'), saved);
    // Explicit reinstall in the same version stays user's choice.
    fs.mkdirSync(f.plugin);
    fs.writeFileSync(path.join(f.plugin, STAMP), JSON.stringify({ v: '1.0.0', f: 1, b: 0 }));
    migrate(f);
    assert.equal(fs.existsSync(f.plugin), true);
  } finally { cleanup(f); }
});

test('unmarked and malformed-stamp community packages retain bytes and disabled choice', () => {
  for (const marker of [null, '{}', '{invalid']) {
    const f = fixture(false);
    try {
      if (marker !== null) fs.writeFileSync(path.join(f.plugin, STAMP), marker);
      const patch = fs.readFileSync(f.patch, 'utf8');
      const manifest = fs.readFileSync(f.manifest, 'utf8');
      migrate(f); migrate(f);
      assert.equal(fs.readFileSync(f.patch, 'utf8'), patch);
      assert.equal(fs.readFileSync(f.manifest, 'utf8'), manifest);
      assert.equal(fs.readFileSync(path.join(f.plugin, 'zz-locked.txt'), 'utf8'), 'payload');
    } finally { cleanup(f); }
  }
});

test('local dependency references, package substitutions and same-id user rows are preserved', () => {
  for (const mode of ['file', 'link', 'replacement', 'row']) {
    const f = fixture();
    try {
      if (mode === 'file' || mode === 'link') {
        const pkg = json(f.manifest); pkg.dependencies[ID] = mode + ':../local';
        fs.writeFileSync(f.manifest, JSON.stringify(pkg));
      } else if (mode === 'replacement') {
        fs.writeFileSync(path.join(f.plugin, 'package.json'), JSON.stringify({ name: ID, version: '2.0.0' }));
      } else {
        fs.writeFileSync(f.patch, `- id: ${ID}\n  name: user-fork\n  disabled: false\n`);
      }
      const patch = fs.readFileSync(f.patch, 'utf8');
      const manifest = fs.readFileSync(f.manifest, 'utf8');
      migrate(f);
      assert.equal(fs.existsSync(f.plugin), true, mode);
      assert.equal(fs.readFileSync(f.patch, 'utf8'), patch, mode);
      assert.equal(fs.readFileSync(f.manifest, 'utf8'), manifest, mode);
    } finally { cleanup(f); }
  }
});

test('linked package directory is never followed even when the target has a copy stamp', () => {
  const f = fixture();
  try {
    const target = path.join(f.root, 'user-fork');
    fs.renameSync(f.plugin, target);
    fs.symlinkSync(target, f.plugin, process.platform === 'win32' ? 'junction' : 'dir');
    migrate(f);
    assert.equal(fs.lstatSync(f.plugin).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(target, 'zz-locked.txt'), 'utf8'), 'payload');
    assert.equal(json(f.manifest).dependencies[ID], '1.0.0');
  } finally { cleanup(f); }
});

for (const area of ['patch', 'manifest', 'settings'] as const) {
  test(`failed ${area} atomic write does not stamp completion and can retry`, (t) => {
    const f = fixture();
    const rename = fs.renameSync;
    try {
      const blocked = f[area];
      t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
        if (String(from) === blocked || String(to) === blocked) throw Object.assign(new Error('fixture file locked'), { code: 'EPERM' });
        return rename(from, to);
      });
      migrate(f);
      assertNotAligned(f);
      assert.equal(f.logs.some((line) => line.includes('完成内置插件树对齐')), false);
      if (area !== 'settings') assert.equal(fs.existsSync(path.join(f.plugin, STAMP)), true);
      t.mock.restoreAll();
      migrate(f);
      assert.equal(fs.existsSync(f.plugin), false);
      assertAligned(f);
    } finally { t.mock.restoreAll(); cleanup(f); }
  });
}

test('partial directory cleanup retains ownership proof and retries after the lock clears', (t) => {
  const f = fixture();
  const remove = fs.rmSync;
  try {
    t.mock.method(fs, 'rmSync', (target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target) === path.join(f.plugin, 'zz-locked.txt')) throw Object.assign(new Error('fixture file locked'), { code: 'EPERM' });
      return remove(target, options);
    });
    migrate(f);
    assertNotAligned(f);
    assert.equal(fs.existsSync(path.join(f.plugin, STAMP)), true);
    assert.equal(fs.existsSync(path.join(f.plugin, 'package.json')), false, 'fixture models an interrupted recursive cleanup');
    t.mock.restoreAll();
    migrate(f);
    assert.equal(fs.existsSync(f.plugin), false);
    assertAligned(f);
  } finally { t.mock.restoreAll(); cleanup(f); }
});

test('unparseable patch remains untouched and is retried after repair', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.patch, '- insert: [');
    migrate(f);
    assertNotAligned(f);
    assert.equal(fs.readFileSync(f.patch, 'utf8'), '- insert: [');
    assert.equal(fs.existsSync(f.plugin), true);
    fs.writeFileSync(f.patch, `- id: ${ID}\n  name: ${ID}\n`);
    migrate(f);
    assertAligned(f);
    assert.equal(fs.existsSync(f.plugin), false);
  } finally { cleanup(f); }
});

test('retirement preserves matching IDs inside unrelated config, comments and !!js', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.patch, `# keep user settings\n- insert:\n    - id: unrelated\n      name: user-package\n      config:\n        # plugin-owned records are not loader rows\n        items:\n          - id: ${ID}\n            name: user-data\n            value: keep-me\n        expression: !!js "process.env.USER_CHOICE"\n    - id: ${ID} # remove only this loader row\n      name: ${ID}\n- id: unrelated\n  config:\n    nested:\n      - id: ${ID}\n        value: also-keep\n`);
    migrate(f);
    assert.equal(fs.existsSync(f.plugin), false);
    assertAligned(f);
    const after = fs.readFileSync(f.patch, 'utf8');
    assert.match(after, /# keep user settings/);
    assert.match(after, /# plugin-owned records are not loader rows/);
    assert.match(after, /!!js/);
    const entries = parsePatchData(after);
    assert.deepEqual(entries[0].insert.map((row: { id: string }) => row.id), ['unrelated']);
    assert.deepEqual(entries[0].insert[0].config.items, [{ id: ID, name: 'user-data', value: 'keep-me' }]);
    assert.deepEqual(entries[0].insert[0].config.expression, { __jsExpr: 'process.env.USER_CHOICE' });
    assert.deepEqual(entries[1].config.nested, [{ id: ID, value: 'also-keep' }]);
  } finally { cleanup(f); }
});

test('retirement removes actual multiline and flow entries without leaving empty insert operations', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.patch, `# preserve heading\n- insert:\n    -\n      id: ${ID}\n      name: ${ID}\n- { id: ${ID}, disabled: true }\n- id: unrelated\n  config: { id: ${ID}, value: keep }\n`);
    migrate(f);
    assert.equal(fs.existsSync(f.plugin), false);
    assertAligned(f);
    const after = fs.readFileSync(f.patch, 'utf8');
    assert.match(after, /# preserve heading/);
    assert.deepEqual(parsePatchData(after), [{ id: 'unrelated', config: { id: ID, value: 'keep' } }]);
  } finally { cleanup(f); }
});
