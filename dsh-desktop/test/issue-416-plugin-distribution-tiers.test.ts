import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// M3/#416 三层分级的运行时与 UI 契约。裁定（v2 计划 §0.5）：以既有
// `.sync/plugin-distribution.json` 的 `distributionClass` 为 canonical，
// 不新增 `tier` 字段 —— 行为落在三处：
//   1. 生成注册表（plugin-sync-registry）把 distributionClass 带到运行时；
//   2. 插件管理行（plugin-manager-state）暴露分级 + 内置行锁定 +
//      外部行默认禁用规划（companion-sync 走既有 patch 手术落盘）；
//   3. 插件管理 UI（dsh-plugin-manager/lib/client.js）按分级分组/打标签。
// 外部插件默认禁用复用既有「插件市场安装路径」与「插件管理 IPC」，不新增安装器。

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8');
const json = <T>(...parts: string[]): T => JSON.parse(read(...parts)) as T;

const ledgerText = read('.sync', 'plugin-distribution.json');
const ledger = json<{ plugins: { id: string; distributionClass: string }[] }>('.sync', 'plugin-distribution.json');
const policies = json<{ pluginDistribution: { expectedCounts: Record<string, number> } }>('.sync', 'policies.json');

const state = await import('../plugin-manager-state.js');
const registry = await import('../lib/desktop/plugin-sync-registry.js');
const { expectedRegistryText } = await import('../scripts/plugin-sync.mjs');

const opsSource = read('dsh-desktop', 'lib', 'desktop', 'plugin-ops.ts');
const syncSource = read('dsh-desktop', 'lib', 'desktop', 'companion-sync.ts');
// EAC-CORE-SHELL-01：EAC 版 dsh-plugin-manager 已退役（与内核同名遮蔽）。
// 分级 UI 契约改锚在保留的行模型源（plugin-manager-state.ts）上。
const rowModelSource = read('dsh-desktop', 'plugin-manager-state.ts');
const marketHost = read('dsh-desktop', 'assets', 'plugins', 'dsh-unified-market', 'lib', 'host.js');

const classes = registry.PLUGIN_DISTRIBUTION_CLASSES as Record<string, string>;
const RECOMMENDED_PACK = 'dev.dsh-eac.desktop-recommended';

function classCounts(): Record<string, number> {
  const out: Record<string, number> = { builtin: 0, recommended: 0, external: 0 };
  for (const value of Object.values(classes)) out[value] = (out[value] || 0) + 1;
  return out;
}

function rows(entries: unknown[], ctx: Record<string, unknown>): any[] {
  return state.collectPluginRows(entries, ctx) as any[];
}

// ---------------------------------------------------------------------------
// 1. canonical 字段与生成注册表
// ---------------------------------------------------------------------------

test('distribution ledger keeps distributionClass as the only tier field (#416 ruling)', () => {
  assert.doesNotMatch(ledgerText, /"tier"\s*:/, '不得引入 tier 字段（v2 §0.5 裁定）');
  const allowed = new Set(['builtin', 'recommended', 'external']);
  for (const entry of ledger.plugins) {
    assert.ok(allowed.has(entry.distributionClass), `${entry.id} 的 distributionClass 非法: ${entry.distributionClass}`);
  }
  const schema = read('.sync', 'plugin-distribution.schema.json');
  assert.doesNotMatch(schema, /"tier"/, 'schema 不得声明 tier');
  const counts = { builtin: 0, recommended: 0, external: 0 } as Record<string, number>;
  for (const entry of ledger.plugins) counts[entry.distributionClass] += 1;
  assert.deepEqual(counts, policies.pluginDistribution.expectedCounts,
    'policies.expectedCounts 必须与 ledger 分级计数一致');
});

test('generated registry carries the ledger classes into the runtime', () => {
  assert.ok(classes && typeof classes === 'object', 'PLUGIN_DISTRIBUTION_CLASSES 必须由生成器产出');
  assert.deepEqual(classCounts(), policies.pluginDistribution.expectedCounts);
  for (const entry of ledger.plugins) {
    assert.equal(classes[entry.id], entry.distributionClass, `${entry.id} 的分级必须与 ledger 一致`);
  }
  assert.equal(registry.RECOMMENDED_PACK_ID, RECOMMENDED_PACK);
  assert.deepEqual(
    registry.RECOMMENDED_PACK_PLUGIN_IDS,
    ledger.plugins.filter((p) => p.distributionClass === 'recommended').map((p) => p.id).sort(),
    '推荐 id 清单与 ledger 的 recommended 集合一致',
  );
});

test('committed generated registry is byte-identical to the ledger-derived text', () => {
  // 生成产物零漂移：内容只由 .sync 三件套（manifest / distribution / 推荐包
  // draft）决定，与插件目录树无关，所以精简树里同样可验证（严格路径
  // `generate-registry --check` 需要完整目录树，见 expectedRegistryText 注释）。
  const expected = expectedRegistryText(root) as string;
  assert.equal(read('dsh-desktop', 'lib', 'desktop', 'plugin-sync-registry.ts'), expected,
    'plugin-sync-registry.ts 必须与 ledger 推导文本逐字节一致（重新生成而非手改）');
});

test('runtime class resolution reproduces the ledger for every entry', () => {
  for (const entry of ledger.plugins) {
    assert.equal(
      state.distributionClassOf(entry.id, 'other', classes),
      entry.distributionClass,
      `${entry.id} 的运行时分级必须等于 ledger 的 distributionClass`,
    );
  }
  // 非台账 id：内核骨架按内置，其余第三方一律外部（L3）。
  assert.equal(state.distributionClassOf('dsh-web-app', 'core', classes), 'builtin');
  assert.equal(state.distributionClassOf('brand-new-community-plugin', 'other', classes), 'external');
});

// ---------------------------------------------------------------------------
// 2. 行分级（纯函数）
// ---------------------------------------------------------------------------

test('builtin rows are default-enabled, non-disableable and labelled', () => {
  // coreIds 刻意留空：锁定必须来自 distributionClass，而不是调用方注入的核心集合。
  // ISO-004：样例从 balance（实物不存在，已改判 recommended）换成仍随包的 builtin。
  const [row] = rows([], {
    companion: [{ id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' }],
    distributionClasses: classes,
    recommendedPack: RECOMMENDED_PACK,
  });
  assert.equal(row.distributionClass, 'builtin');
  assert.equal(row.tierLabel, '内置');
  assert.equal(row.enabled, true, '内置行默认启用');
  assert.equal(row.defaultEnabled, true);
  assert.equal(row.toggleable, false, '内置行不可停用');
  assert.equal(row.removable, false, '内置行不可移除');
  // 存量/手改的 disabled 行同样保持锁定（IPC 侧也拒绝停用内置插件）。
  const [locked] = rows([{ id: 'file-changes', disabled: true }], {
    companion: [{ id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' }],
    distributionClasses: classes,
  });
  assert.equal(locked.toggleable, false);
  assert.equal(locked.distributionClass, 'builtin');
});

test('recommended rows stay installable and enable-choice aware', () => {
  const [row] = rows([], {
    companion: [{ id: 'dsh-navbar', name: '@vlln/dsh-navbar' }],
    distributionClasses: classes,
    recommendedPack: RECOMMENDED_PACK,
  });
  assert.equal(row.distributionClass, 'recommended');
  assert.equal(row.tierLabel, '推荐');
  assert.equal(row.enableChoice, true, '推荐插件安装后由用户选择是否启用');
  assert.equal(row.pack, RECOMMENDED_PACK);
  assert.equal(row.defaultEnabled, true);
  assert.equal(row.toggleable, true, '推荐插件保持可开关');
});

test('external rows are labelled and default-disabled', () => {
  const [row] = rows([], {
    bundles: ['dsh-community-thing'],
    distributionClasses: classes,
    recommendedPack: RECOMMENDED_PACK,
  });
  assert.equal(row.distributionClass, 'external');
  assert.equal(row.tierLabel, '外部');
  assert.equal(row.defaultEnabled, false, '外部插件新装默认禁用');
  assert.equal(row.enableChoice, false);
  assert.equal(row.pack, null);
  assert.equal(row.toggleable, true, '外部插件可手动启用');
  // 已登记且被关闭的外部插件：行显示关闭，但开关可用（手动启用）。
  const [off] = rows([{ id: 'dsh-community-thing', name: 'dsh-community-thing', disabled: true }], {
    bundles: ['dsh-community-thing'],
    distributionClasses: classes,
  });
  assert.equal(off.distributionClass, 'external');
  assert.equal(off.enabled, false);
  assert.equal(off.toggleable, true);
});

test('kernel skeleton bundle rows classify as builtin', () => {
  const [row] = rows([], { bundles: ['@deepseek-ai/dsh-web-app'], distributionClasses: classes });
  assert.equal(row.distributionClass, 'builtin');
  assert.equal(row.toggleable, false);
});

// ---------------------------------------------------------------------------
// 3. 外部层默认禁用的落盘规划（纯函数；写盘复用既有 patch 手术）
// ---------------------------------------------------------------------------

test('external default-disable plan targets only new third-party bundles', () => {
  const plan = state.externalDefaultDisabledPlan({
    bundles: [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'dsh-community-thing',
      '@scope/other-thing',
      'dsh-navbar',
      'file-changes',
    ],
    // 登记判定跟着 canonical id 走：@scope/other-thing 使用无碰撞编码。
    isRegistered: (id: string) => id === 'scoped-4073636f70652f6f746865722d7468696e67',
    distributionClasses: classes,
    // 配套插件 skipIds（ISO-004：样例换成仍随包的 builtin 行 id）。
    // 注：`@vlln/dsh-navbar` 这类「scoped 包名 → 台账 id」反查随随包清单收敛
    // （45→10）失效——推荐包资产不在仓库，packageName 无处登记，canonical 会
    // 退化为 scoped-<hex>；此处用裸 id `dsh-navbar` 取证分级表的推荐类。
    skipIds: ['file-changes'],
  }) as { id: string; name: string }[];
  assert.deepEqual(plan, [{ id: 'dsh-community-thing', name: 'dsh-community-thing' }],
    '内核骨架 / 已登记 / 推荐与内置 / 配套插件都不进默认禁用清单');
});

test('external default-disable plan is empty without distribution knowledge', () => {
  const plan = state.externalDefaultDisabledPlan({
    bundles: ['dsh-community-thing'],
    isRegistered: () => false,
  }) as { id: string; name: string }[];
  assert.deepEqual(plan, [], '缺少分级表时不得擅自禁用第三方插件（fail-open）');
});

// ---------------------------------------------------------------------------
// 3b. #416 回归：scoped 包名不得折成 bare id 与别的插件 / skipIds / 分级表撞车
// ---------------------------------------------------------------------------
//
// 缺陷（修前）：identity 由 `name.slice(name.indexOf('/') + 1)` 无条件去 scope
// 得到 —— `@evil/dsh-pet` 折成配套插件 id `dsh-pet`（∈ skipIds）、
// `@evil/dsh-navbar` 折成推荐包 `dsh-navbar`（∈ recommended 分级表）、
// `@evil/dsh-base` 折成内核骨架 `dsh-base`。三个冒名包因此全部躲过「外部层
// 默认禁用」；同短名不同 scope 的两个包（`@a/thing` / `@b/thing`）还会塌成
// 同一行。修复后 identity 用「生成注册表的 canonical 包名 → 台账 id 反查 +
// 内核骨架包名白名单 + 未知 scoped 包规范化全名（`@evil/dsh-pet` →
// `scoped-406576696c2f6473682d706574`）」，既有落盘 id 又能落盘（plugin-manager-patch 的 ID_RE）。

test('#416 回归：scoped 冒名包不得借 bare id 躲过外部层默认禁用', () => {
  const plan = state.externalDefaultDisabledPlan({
    // 四个冒名包分别瞄准：配套插件 skipIds、推荐分级、内核骨架、内核骨架
    bundles: ['@evil/dsh-pet', '@evil/dsh-navbar', '@evil/dsh-base', '@evil/dsh-web-app'],
    isRegistered: () => false,
    distributionClasses: classes,
    builtinIds: registry.DISTRIBUTION_BUILTIN_PLUGIN_IDS,
    recommendedIds: registry.RECOMMENDED_PACK_PLUGIN_IDS,
    skipIds: ['dsh-pet', 'dsh-navbar', 'dsh-base', 'dsh-web-app'],
  }) as { id: string; name: string }[];
  assert.deepEqual(plan, [
    { id: 'scoped-406576696c2f6473682d62617365', name: '@evil/dsh-base' },
    { id: 'scoped-406576696c2f6473682d6e6176626172', name: '@evil/dsh-navbar' },
    { id: 'scoped-406576696c2f6473682d706574', name: '@evil/dsh-pet' },
    { id: 'scoped-406576696c2f6473682d7765622d617070', name: '@evil/dsh-web-app' },
  ], '冒名 scoped 包必须各自成行：不得被配套 skipIds / 推荐分级 / 内核骨架白名单豁免');
  for (const ext of plan) {
    assert.match(ext.id, /^[A-Za-z0-9_.-]+$/,
      '落盘 id 必须能过 plugin-manager-patch 的 ID_RE（@ 与 / 会被直接拒绝）');
  }
});

test('#416 回归：scoped 包的规范化 id 落盘时不动同名配套行', async () => {
  const { togglePluginInPatch } = await import('../scripts/plugin-manager-patch.js') as {
    togglePluginInPatch(text: string, id: string, enabled: boolean, name?: string): string;
  };
  const before = [
    '# profile patch',
    '- insert:',
    '    - id: dsh-pet',
    "      name: 'dsh-pet'",
    '      config:',
    '        size: 260',
    '      disabled: true',
    '',
  ].join('\n');
  const plan = state.externalDefaultDisabledPlan({
    bundles: ['@evil/dsh-pet'],
    isRegistered: () => false,
    distributionClasses: classes,
  }) as { id: string; name: string }[];
    assert.deepEqual(plan.map((p) => p.id), ['scoped-406576696c2f6473682d706574'], '冒名包必须自成一个规划行');
  let after = before;
  for (const ext of plan) after = togglePluginInPatch(after, ext.id, false, ext.name);
  assert.match(after, /- id: scoped-406576696c2f6473682d706574\n {2}name: '@evil\/dsh-pet'\n {2}disabled: true/,
    '规划必须能经既有 patch 手术落盘编码后的 id');
  assert.match(after, /- id: dsh-pet\n/, '配套插件 dsh-pet 的行不得被折掉的 id 命中并改写');
  assert.match(after, /config:\n {8}size: 260/, '配套行的 config 必须原样保留');
  assert.equal((after.match(/disabled: true/g) || []).length, 2,
    'companion 行保持原样：新增且仅新增一条冒名包的关闭行');
});

test('#416 回归：不同 scope 的同名包不再互相塌成一行', () => {
  const plan = state.externalDefaultDisabledPlan({
    bundles: ['@a/thing', '@b/thing'],
    isRegistered: () => false,
    distributionClasses: classes,
  }) as { id: string; name: string }[];
  assert.deepEqual(plan, [
    { id: 'scoped-40612f7468696e67', name: '@a/thing' },
    { id: 'scoped-40622f7468696e67', name: '@b/thing' },
  ], '同短名不同 scope 是两个不同插件，必须各自进默认禁用清单');
  const listed = rows([], { bundles: ['@a/thing', '@b/thing'], distributionClasses: classes });
  assert.deepEqual(listed.map((r) => r.id), ['scoped-40612f7468696e67', 'scoped-40622f7468696e67'], '管理页也必须给出两行');
  assert.ok(listed.every((r) => r.distributionClass === 'external' && r.defaultEnabled === false),
    '两个包都按 L3 外部层标注且默认禁用');
});

test('#416 回归：canonical 包名解析（已知包走台账 id，未知 scoped 规范化全名）', () => {
  const canonical = state.canonicalBundleId as (name: string) => string;
  assert.equal(canonical('@deepseek-ai/dsh-client-file-changes'), 'client-file-changes',
    '已登记 scoped 包的行 id 走台账 id，不是去 scope 的短名');
  assert.equal(canonical('@deepseek-ai/dsh-file-changes'), 'file-changes', '已登记 scoped 包的行 id 走台账 id');
  assert.equal(canonical('@deepseek-ai/dsh-web-app'), 'dsh-web-app', '内核骨架保持现有短名语义');
  // ISO-004：随包清单收敛（45→10）后，反查表只剩随包 10 条 —— 推荐包资产不在
  // 仓库，scoped 包名按无碰撞编码落盘；其分级仍由 canonical 分级表（ledger）给出。
  assert.equal(canonical('@vlln/dsh-navbar'), 'scoped-40766c6c6e2f6473682d6e6176626172',
    '已移出随包清单的推荐包不再折成裸 id（除非反查表重新登记它的 packageName）');
  assert.equal(state.distributionClassOf('dsh-navbar', 'other', classes), 'recommended',
    '推荐包的 canonical 分级不受随包清单收敛影响（裸 id 仍在分级表里）');
  assert.equal(canonical('@evil/dsh-navbar'), 'scoped-406576696c2f6473682d6e6176626172', '未登记 scoped 包使用无碰撞编码，绝不折成别人的 id');
  assert.equal(canonical('dsh-community-thing'), 'dsh-community-thing', '无 scope 包名即 id');
});

test('#416 回归：已知包（内置 / 推荐包）不被当成外部层规划', () => {
  const plan = state.externalDefaultDisabledPlan({
    // ISO-004：随包清单收敛后 scoped 反查表只剩随包 10 条，推荐包改用
    // canonical 分级表里的裸 id 取证（'dsh-navbar' ∈ recommended）。
    bundles: ['@deepseek-ai/dsh-file-changes', 'dsh-navbar', '@deepseek-ai/dsh-web-app'],
    isRegistered: () => false,
    distributionClasses: classes,
    builtinIds: registry.DISTRIBUTION_BUILTIN_PLUGIN_IDS,
    recommendedIds: registry.RECOMMENDED_PACK_PLUGIN_IDS,
    // 刻意不给 skipIds：canonical 分级必须自己立得住（跳过只靠分级表与内核白名单）
  }) as { id: string; name: string }[];
  assert.deepEqual(plan, [], '内置包 / 推荐包 / 内核骨架都不得进默认禁用清单');
});

test('#416 回归：注册表缺失时，companion 的 raw/bare/canonical 三种 id 都能排除', () => {
  const plan = state.externalDefaultDisabledPlan({
    // 空 packageIds 模拟裁剪部署/启动时注册表不可读；此时 canonicalBundleId
    // 会退化为 scope-name，但 companion-sync 传入三种形式的 skipIds。
    packageIds: new Map(),
    bundles: ['@deepseek-ai/dsh-balance', '@dsh-eac/skin-miku', '@evil/dsh-pet'],
    isRegistered: () => false,
    distributionClasses: {},
    builtinIds: [],
    recommendedIds: [],
    skipIds: [
      '@deepseek-ai/dsh-balance', 'balance', 'deepseek-ai-dsh-balance',
      '@dsh-eac/skin-miku', 'dsh-eac-skin-miku',
      '@evil/dsh-pet', 'scoped-406576696c2f6473682d706574',
    ],
  }) as { id: string; name: string }[];
  assert.deepEqual(plan, [], '注册表缺失时内置/配套包不得被误写 disabled 行');
});

// ---------------------------------------------------------------------------
// 4. 运行时接线（source-level contract）
// ---------------------------------------------------------------------------

/** 源码契约断言：失败时只报缺失模式，不整文件回显。 */
function has(source: string, pattern: RegExp, message: string): void {
  assert.ok(pattern.test(source), message + '（缺失模式 ' + String(pattern) + '）');
}

test('plugin-ops feeds the ledger classes into rows and keeps builtin toggles refused', () => {
  has(opsSource, /PLUGIN_DISTRIBUTION_CLASSES/, 'plugin-ops 必须消费生成注册表的 canonical 分级表');
  has(opsSource, /distributionClasses\s*:\s*PLUGIN_DISTRIBUTION_CLASSES/, 'canonical 分级表必须注入 collectPluginRows');
  has(opsSource, /recommendedPack\s*:\s*RECOMMENDED_PACK_ID/, '推荐包 id 必须注入行（来自 ledger）');
  has(opsSource, /CORE_PLUGIN_IDS\.has\(id\)[\s\S]{0,120}核心插件不可停用/, '内置（核心）插件的停用拒绝必须保留');
});

test('companion-sync applies external defaults through shared YAML identity handling', () => {
  has(syncSource, /externalDefaultDisabledPlan/, 'companion-sync 必须消费默认禁用规划');
  has(syncSource, /registeredPatchEntryIds\(patch\)/, '用户选择必须按 YAML 条目读取');
  has(syncSource, /toggleBundleInPatch\(patch,/, '默认禁用必须复用包启停的 YAML 写入路径');
  has(syncSource, /默认关闭（可在「设置 → 插件 → 管理」启用）/, '默认禁用需要可诊断的启动日志');
});

// ---------------------------------------------------------------------------
// 5. UI 契约（source-level）
// ---------------------------------------------------------------------------

test('plugin row model labels builtin/recommended/external', () => {
  has(rowModelSource, /TIER_LABELS/, '行模型必须提供三层分级标签');
  has(rowModelSource, /builtin:\s*'[^']*'/, '必须提供内置分级标签');
  has(rowModelSource, /recommended:\s*'[^']*'/, '必须提供推荐分级标签');
  has(rowModelSource, /external:\s*'[^']*'/, '必须提供外部分级标签');
  has(rowModelSource, /distributionClass/, '行模型必须携带 distributionClass');
  has(rowModelSource, /tierLabel:/, '行模型必须暴露 tierLabel');
});

// ---------------------------------------------------------------------------
// 6. 外部插件的常规安装路径（市场）默认禁用
// ---------------------------------------------------------------------------

test('market install path defaults non-shell-managed installs to disabled', () => {
  has(marketHost, /function isExternalInstall\(profile, pkgName\)/, '外部判定必须复用壳写入的内置清单标记');
  has(marketHost, /return !readBuiltinPlugins\(profile\)\.includes\(name\)/, '非壳同步面的包 = 外部插件');
  has(marketHost, /installDefaultDisabled = isExternalInstall\(op\.profile, pkgName\)/,
    '外部安装必须默认禁用');
  has(marketHost, /installDefaultDisabled && !Object\.hasOwn\(op\.beforeDeps, pkgName\)/,
    '更新必须保留用户启停选择');
  has(marketHost, /togglePackage\(profileDir\(op\.profile\), pkgName, false\)/,
    '禁用必须应用真实包条目；卸载由内核事务负责');
  has(marketHost, /外部插件默认禁用[\s\S]{0,80}设置 → 插件 → 管理/, '安装输出必须告知默认禁用与手动启用位置');
  has(marketHost, /hotCtx !== null && !installDefaultDisabled/, '默认禁用的外部插件不得热挂载（否则绕过关闭行立即生效）');
});
