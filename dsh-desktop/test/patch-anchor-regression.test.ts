import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  patchSettingsWriteFailureSource,
  patchThemeWriteConvergeSource,
  patchConfigEditorEditShortCircuitSource,
  patchAppBootReconcileGateSource,
} = require('../scripts/patch-deps.js') as Record<string, (...args: unknown[]) => string | undefined>;

// 内核产物路径（存在才跑安装树绊网；纯仓库 CI 无 node_modules 时跳过）。
const kernelRoot = join(__dirname, '..', 'node_modules', '@deepseek-ai');

// ── 夹具：逐字节取自 0.1.7-rc.2 安装产物实测（tab 缩进、LF、无语句级 void、
// undefined 为 void 0、字号边界内联字面量）。锚点漂移时对应用例必须红。──

const SETTINGS_MUTATE = [
  '\t\t\tmutate(ops, expectedRevision) {',
  '\t\t\t\tconst ownedOps = structuredClone(ops);',
  '\t\t\t\tconst generation = ++this.writeGeneration;',
  '\t\t\t\treturn this.enqueue(async () => {',
  '\t\t\t\t\tconst revision = expectedRevision ?? this.pendingRevision ?? this.getSnapshot().revision;',
  '\t\t\t\t\tconst response = await this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision);',
  '\t\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\treturn false;',
  '\t\t\t\t\t}',
  '\t\t\t\t\tif (this.disposed) return true;',
  '\t\t\t\t\tif (generation === this.writeGeneration) {',
  '\t\t\t\t\t\tthis.pendingRevision = void 0;',
  '\t\t\t\t\t\tthis.mirror.acceptView(response.value);',
  '\t\t\t\t\t} else this.pendingRevision = response.value.revision;',
  '\t\t\t\t\treturn true;',
  '\t\t\t\t});',
  '\t\t\t}',
].join('\n');

const THEME_SET_THEME = [
  '\t\t\tsetTheme(id) {',
  '\t\t\t\tif (id !== "system" && !this.themes.some((t) => t.id === id)) throw new Error(`theme "${id}" is not registered`);',
  '\t\t\t\tif (this.preference === id) return;',
  '\t\t\t\tthis.preference = id;',
  '\t\t\t\tif (isThemePreference(id)) this.host.set(THEME_PREFERENCE_FIELD, id);',
  '\t\t\t\tthis.publish();',
  '\t\t\t}',
].join('\n');

const THEME_SET_FONT = [
  '\t\t\tsetFontSize(px) {',
  '\t\t\t\tif (!Number.isInteger(px) || px < 12 || px > 17) throw new Error(`font size ${px} is outside 12..17`);',
  '\t\t\t\tif (this.fontSize === px) return;',
  '\t\t\t\tthis.fontSize = px;',
  '\t\t\t\tthis.host.set(FONT_SIZE_FIELD, px);',
  '\t\t\t\tthis.publish();',
  '\t\t\t}',
].join('\n');

const THEME_ADOPT = [
  '\t\t\t/** Adopt the scope\'s accepted durable preference without writing it back. */',
  '\t\t\tadopt() {',
  '\t\t\t\tconst section = this.host.getSnapshot().value;',
  '\t\t\t\tif (section === void 0) return;',
  '\t\t\t\tif (this.preference === section.preference && this.fontSize === section.fontSize) return;',
  '\t\t\t\tthis.preference = section.preference;',
  '\t\t\t\tthis.fontSize = section.fontSize;',
  '\t\t\t\tthis.publish();',
  '\t\t\t}',
].join('\n');

const CONFIG_EDITOR_EDIT = [
  '\t\t\t\tconst beforePatches = readProfilePatches("dsh", this.ownerContext.profileContext);',
  '\t\t\t\tawait reconcileProfilePatches(this.ownerContext.root, beforePatches, "dsh");',
  '\t\t\t\tif (!this.entries().includes(entry)) throw new Error("Configuration entry changed during reload");',
].join('\n');

const APP_BOOT_RECONCILE = [
  'async function reconcileProfilePatches(ctx, patches, binName, requiredIds = []) {',
  '\tconst entry = bootstrapIncludes.get(ctx);',
  '\tif (entry === void 0) throw new Error(`${binName}: profile reload requires the root Include entry`);',
].join('\n');

const APP_BOOT_MANIFEST_HEAD = [
  'function manifestOf(ctx, name, parentURL) {',
  '\tif (name.startsWith("cordis:")) return void 0;',
].join('\n');

const APP_BOOT_MANIFEST_HOT = '\tif (pkg !== void 0) return readManifest(pkg.manifestPath);';

// ── 锚点命中断言：每个补丁对 0.1.7-rc.2 产物形态必须命中（否则 postinstall
// 静默跳过 = 僵尸补丁，#457 修复失效且无报错）。──

test('anchor/settings: mutate 失败分支锚点唯一且命中', () => {
  // 单行锚在产物全文件唯一（回滚路径无同文）
  const matches = SETTINGS_MUTATE.match(/if \(!response\.ok\) \{/g);
  assert.ok(matches);
  assert.equal(matches.length, 1);
  assert.ok(patchSettingsWriteFailureSource(`before\n${SETTINGS_MUTATE}\nafter`));
});

test('anchor/theme: setTheme/setFontSize/adopt 三锚点命中且互不重叠', () => {
  const patched = patchThemeWriteConvergeSource(
    [THEME_SET_THEME, THEME_SET_FONT, THEME_ADOPT].join('\n'),
  );
  assert.ok(patched);
  assert.match(patched, /dsh-desktop-theme-write-converge/);
  // 旧 host.set 调用全部替换为收敛入口
  assert.doesNotMatch(patched, /this\.host\.set\(THEME_PREFERENCE_FIELD/);
  assert.doesNotMatch(patched, /this\.host\.set\(FONT_SIZE_FIELD/);
  assert.match(patched, /this\.__eacWrite\("preference", id\)/);
  assert.match(patched, /this\.__eacWrite\("fontSize", px\)/);
});

test('anchor/config-editor: 三行组合锚命中（单行在回滚路径有同文，禁用单行锚）', () => {
  const singleLine = 'await reconcileProfilePatches(this.ownerContext.root, beforePatches, "dsh");';
  // 守卫本锚点的存在理由：单行形态必须 >= 2 处（L69 写前 + L122 回滚），故禁止单行锚
  const occurrences = CONFIG_EDITOR_EDIT.match(/await reconcileProfilePatches\(this\.ownerContext\.root, beforePatches, "dsh"\);/g);
  assert.ok(occurrences);
  assert.equal(occurrences.length, 1);
  void singleLine;
  const patched = patchConfigEditorEditShortCircuitSource(`before\n${CONFIG_EDITOR_EDIT}\nafter`);
  assert.ok(patched);
  assert.match(patched, /allowSkip: true/);
});

test('anchor/app-boot: reconcile 门控 + manifestOf 记忆化锚点命中', () => {
  const patched = patchAppBootReconcileGateSource(
    [APP_BOOT_RECONCILE, APP_BOOT_MANIFEST_HEAD, APP_BOOT_MANIFEST_HOT].join('\n'),
  );
  assert.ok(patched);
  assert.match(patched, /dsh-desktop-reconcile-gate/);
  assert.match(patched, /reconcileSkip = options\.allowSkip === true && requiredIds\.length === 0/);
  assert.match(patched, /manifestOfMemo/);
});

test('transform/theme: 幂等（二次应用不再变化）', () => {
  const once = patchThemeWriteConvergeSource([THEME_SET_THEME, THEME_SET_FONT, THEME_ADOPT].join('\n'));
  assert.ok(once);
  assert.equal(patchThemeWriteConvergeSource(once), once);
});

test('transform/config-editor: 幂等', () => {
  const once = patchConfigEditorEditShortCircuitSource(CONFIG_EDITOR_EDIT);
  assert.ok(once);
  assert.equal(patchConfigEditorEditShortCircuitSource(once), once);
});

test('transform/app-boot: 幂等', () => {
  const once = patchAppBootReconcileGateSource(
    [APP_BOOT_RECONCILE, APP_BOOT_MANIFEST_HEAD, APP_BOOT_MANIFEST_HOT].join('\n'),
  );
  assert.ok(once);
  assert.equal(patchAppBootReconcileGateSource(once), once);
});

test('transform/settings: 未知上游形态显式失败（拒绝静默跳过的哑弹补丁）', () => {
  assert.equal(patchSettingsWriteFailureSource('const upstreamChanged = true;'), undefined);
  assert.equal(patchThemeWriteConvergeSource('const upstreamChanged = true;'), undefined);
  assert.equal(patchConfigEditorEditShortCircuitSource('const upstreamChanged = true;'), undefined);
  assert.equal(patchAppBootReconcileGateSource('const upstreamChanged = true;'), undefined);
});

// ── 安装树绊网：内核在位但补丁 marker 缺失 = postinstall 静默跳过 → 直接红。
// 纯仓库 CI（无内核 node_modules）自动跳过；打包/发布 CI 必有内核，必检。──
const INSTALLED_TRIPWIRE: Array<[string, string, RegExp]> = [
  ['settings-write-retry', 'dsh-client-ui-settings/lib/client.js', /dsh-desktop-settings-write-retry/],
  ['theme-write-converge', 'dsh-client-ui-theme/lib/client.js', /dsh-desktop-theme-write-converge/],
  ['config-edit-skip', 'dsh-config-editor/lib/index.js', /dsh-desktop-config-edit-reconcile-skip/],
  ['reconcile-gate', 'dsh-app-boot/lib/index.js', /dsh-desktop-reconcile-gate/],
];
for (const [name, rel, marker] of INSTALLED_TRIPWIRE) {
  test(`installed-tree/${name}: 内核在位则补丁 marker 必须在位`, () => {
    const file = join(kernelRoot, rel);
    if (!existsSync(file)) return;
    const source = readFileSync(file, 'utf8');
    assert.match(
      source,
      marker,
      `${rel} 存在但补丁未生效 —— postinstall 静默跳过了 ${name}（僵尸补丁回归）`,
    );
  });
}
