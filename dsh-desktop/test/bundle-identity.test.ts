import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePatchData, registeredPatchEntryIds, resolveBundleIdentity, resolveBundleIdentities, toggleBundleInPatch } from '../lib/bundle-identity.js';
import state from '../plugin-manager-state.js';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'eac-bundle-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('default-disable registration honors quoted YAML IDs and ignores comments and nested user data', () => {
  const ids = registeredPatchEntryIds('# id: comment-only\n- id: "pet" # user choice\n  disabled: false\n  config: { id: nested-data }\n- insert: [{ id: pet-settings, name: settings }]\n');
  assert.deepEqual([...ids], ['pet', 'pet-settings']);
  assert.deepEqual([...registeredPatchEntryIds('# no rows\n')], []);
});

function bundle(root: string, name: string, patches: Record<string, string>, declared: unknown = Object.keys(patches)) {
  const dir = join(root, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: declared } } }));
  for (const [filename, text] of Object.entries(patches)) {
    mkdirSync(join(dir, filename, '..'), { recursive: true });
    writeFileSync(join(dir, filename), text);
  }
  return dir;
}

test('declared patch paths resolve commented and multiline IDs without evaluating !!js', (t) => {
  const root = fixture(t);
  bundle(root, 'dsh-pet', {
    'config/first.yml': '- insert:\n    - id: pet # actual loader ID\n      name: dsh-pet\n      config: !!js "throw new Error()"\n',
    'second.yml': '- insert:\n    -\n      id: pet-controls\n      name: dsh-pet/controls\n      disabled: true\n',
  });
  const identity = resolveBundleIdentity(root, 'dsh-pet');
  assert.equal(identity.ok, true);
  if (!identity.ok) return;
  assert.deepEqual(identity.entryIds, ['pet', 'pet-controls']);
  assert.equal(identity.entries[1].disabled, true);
});

test('missing, invalid and escaping declarations never guess IDs from package names', (t) => {
  const root = fixture(t);
  bundle(root, 'empty', { 'patch.yml': '- id: existing\n  disabled: false\n' });
  bundle(root, 'broken', { 'patch.yml': '[invalid' });
  bundle(root, 'escape', {}, '../outside.yml');
  writeFileSync(join(root, 'node_modules', 'outside.yml'), '- insert:\n    - id: escaped\n      name: escape\n');
  for (const name of ['missing', 'empty', 'broken', 'escape', '../outside', '--help', '@-scope/name', '@scope/-name']) {
    assert.equal(resolveBundleIdentity(root, name).ok, false, name);
  }
});

test('scoped packages retain distinct UI IDs and shared loader ownership is refused', (t) => {
  const root = fixture(t);
  for (const name of ['dsh-pet', '@other/dsh-pet']) {
    bundle(root, name, { 'patch.yml': `- insert:\n    - id: pet\n      name: ${JSON.stringify(name)}\n` });
  }
  const identities = resolveBundleIdentities(root, ['dsh-pet', '@other/dsh-pet']);
  assert.equal(identities['dsh-pet'].ok, false);
  assert.equal(identities['@other/dsh-pet'].ok, false);
  const rows = state.collectPluginRows([], { bundles: Object.keys(identities), bundleIdentities: identities });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.ok(rows.every((row) => !row.toggleable && row.error));
});

test('same basename packages with separate declarations never toggle or merge each other', (t) => {
  const root = fixture(t);
  bundle(root, '@a/pet', { 'patch.yml': '- insert:\n    - id: a-pet\n      name: "@a/pet"\n' });
  bundle(root, '@b/pet', { 'patch.yml': '- insert:\n    - id: b-pet\n      name: "@b/pet"\n' });
  const identities = resolveBundleIdentities(root, ['@a/pet', '@b/pet']);
  const first = identities['@a/pet'];
  assert.ok(first.ok);
  const patch = toggleBundleInPatch('[]\n', first, false);
  const rows = state.collectPluginRows(parsePatchData(patch) as unknown[], {
    bundles: ['@a/pet', '@b/pet'], bundleIdentities: identities,
  });
  assert.equal(rows.find((row) => row.name === '@a/pet')?.enabled, false);
  assert.equal(rows.find((row) => row.name === '@b/pet')?.enabled, true);
  assert.equal(rows.length, 2);
});

test('toggles use every actual entry, preserve configuration and override default disabled', (t) => {
  const root = fixture(t);
  bundle(root, 'dsh-pet', { 'patch.yml': '- insert:\n    - id: pet\n      name: dsh-pet\n    - id: pet-controls\n      name: dsh-pet/controls\n      disabled: true\n' });
  const identity = resolveBundleIdentity(root, 'dsh-pet');
  assert.ok(identity.ok);
  const initial = '# keep my note\n- id: pet\n  disabled: false\n  config:\n    size: 190\n- id: unrelated\n  config: !!js "process.env.KEEP"\n';
  const off = toggleBundleInPatch(initial, identity, false);
  const on = toggleBundleInPatch(off, identity, true);
  assert.match(on, /# keep my note/);
  assert.match(on, /!!js/);
  const parsed = parsePatchData(on) as Array<Record<string, unknown>>;
  assert.equal(parsed.find((row) => row.id === 'pet')?.disabled, false);
  assert.equal(parsed.find((row) => row.id === 'pet-controls')?.disabled, false);
  assert.deepEqual(parsed.find((row) => row.id === 'pet')?.config, { size: 190 });
  assert.equal(toggleBundleInPatch(on, identity, true), on);
  const identities = { 'dsh-pet': identity };
  const before = state.collectPluginRows([], { bundles: ['dsh-pet'], bundleIdentities: identities });
  assert.equal(before[0].enabled, false);
  const after = state.collectPluginRows(parsed, { bundles: ['dsh-pet'], bundleIdentities: identities });
  assert.equal(after.find((row) => row.id === 'dsh-pet')?.enabled, true);
  assert.equal(after.filter((row) => row.name.startsWith('dsh-pet')).length, 1);
  assert.throws(() => toggleBundleInPatch('- id: pet\n  name: other-package\n', identity, false), /归属冲突/);
  assert.throws(() => toggleBundleInPatch('- id: !!js "pet"\n  disabled: false\n', identity, false), /静态解析/);
});

test('default-disable planner expands real declarations and preserves existing user choice', (t) => {
  const root = fixture(t);
  bundle(root, 'example', { 'patch.yml': '- insert:\n    - id: one\n      name: example\n    - id: two\n      name: example/client\n' });
  const bundleIdentities = resolveBundleIdentities(root, ['example', 'missing']);
  const options = { bundles: ['example', 'missing'], bundleIdentities, distributionClasses: { example: 'external', missing: 'external' } };
  assert.deepEqual(state.externalDefaultDisabledPlan(options), [{ id: 'one', name: 'example' }, { id: 'two', name: 'example/client' }]);
  assert.deepEqual(state.externalDefaultDisabledPlan({ ...options, isRegistered: (id: string) => id === 'one' }), []);
});

test('plugin operations reject unresolved identities without writes and delegate external uninstall', async (t) => {
  const home = fixture(t);
  const profileDir = join(home, 'profiles', 'web-desktop');
  mkdirSync(profileDir, { recursive: true });
  bundle(profileDir, 'dsh-pet', { 'patch.yml': '- insert:\n    - id: pet\n      name: dsh-pet\n' });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['dsh-pet', 'missing'] } } }));
  const patchFile = join(profileDir, 'cordis.patch.yml');
  writeFileSync(patchFile, '# user patch\n[]\n');
  const profile = await import('../lib/desktop/profile.js');
  const runtime = await import('../lib/desktop/runtime-paths.js');
  const ops = await import('../lib/desktop/plugin-ops.js');
  runtime.init({ log() {}, getUserDataDir: () => home });
  profile.init({ log() {}, getDshHome: () => home });
  const removed: string[] = [];
  ops.init({ log() {}, removeBundle: async (name: string) => { removed.push(name); return { ok: true, restartRequired: true }; } });
  assert.equal(ops.pluginManagerSetEnabled('missing', false).ok, false);
  assert.equal(readFileSync(patchFile, 'utf8'), '# user patch\n[]\n');
  assert.equal(ops.pluginManagerSetEnabled('not-a-plugin', true).ok, false);
  assert.equal(readFileSync(patchFile, 'utf8'), '# user patch\n[]\n');
  assert.equal(ops.pluginManagerSetEnabled('dsh-pet', false).ok, true);
  const written = parsePatchData(readFileSync(patchFile, 'utf8')) as Array<Record<string, unknown>>;
  assert.deepEqual(written, [{ id: 'pet', disabled: true }]);
  assert.equal((await ops.pluginManagerSetRemoved('dsh-pet', true)).ok, true);
  assert.deepEqual(removed, ['dsh-pet']);
});

test('shared parent node_modules supplies core ownership without copying core into the profile', (t) => {
  const root = fixture(t);
  const profiles = join(root, 'profiles');
  const profileDir = join(profiles, 'web-desktop');
  mkdirSync(profileDir, { recursive: true });
  bundle(profiles, '@deepseek-ai/dsh-base', {
    'core.yml': '- insert:\n    - id: permission\n      name: "@deepseek-ai/dsh-sandbox-policy"\n',
  });
  bundle(profileDir, 'external', { 'patch.yml': '- insert:\n    - id: permission\n      name: external\n' });
  assert.equal(resolveBundleIdentity(profileDir, '@deepseek-ai/dsh-base').ok, true);
  const identities = resolveBundleIdentities(profileDir, ['@deepseek-ai/dsh-base', 'external']);
  assert.equal(identities.external.ok, false);
  assert.match(identities.external.error || '', /冲突/);
});

test('dynamic identifiers stay inert and unresolved core prevents external mutations', (t) => {
  const root = fixture(t);
  bundle(root, 'dynamic-id', { 'patch.yml': '- insert:\n    - id: !!js "pet"\n      name: dynamic-id\n' });
  bundle(root, 'dynamic-name', { 'patch.yml': '- insert:\n    - id: pet\n      name: !!js "dynamicName"\n' });
  assert.equal(resolveBundleIdentity(root, 'dynamic-id').ok, false);
  assert.equal(resolveBundleIdentity(root, 'dynamic-name').ok, false);
  bundle(root, 'external', { 'patch.yml': '- insert:\n    - id: permission\n      name: external\n' });
  const identities = resolveBundleIdentities(root, ['@deepseek-ai/dsh-base', 'external']);
  assert.equal(identities.external.ok, false);
  assert.match(identities.external.error || '', /核心插件元数据不可用/);
  assert.deepEqual(state.externalDefaultDisabledPlan({
    bundles: ['external'], bundleIdentities: identities, distributionClasses: { external: 'external' },
  }), []);
  assert.deepEqual(parsePatchData('- config: !!js "doNotRun()"\n'), [{ config: { __jsExpr: 'doNotRun()' } }]);
});
