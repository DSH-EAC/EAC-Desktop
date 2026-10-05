'use strict';

import type { BundleIdentities } from './lib/bundle-identity';

// 插件管理状态合并（v4.2）：把 profile cordis.patch.yml 解析出的 entries
// 合并成管理页 / 桌宠设置可消费的行列表。纯函数，不碰磁盘 —— 磁盘读取在
// main.js 侧完成（pluginManagerReadPatch / profile package.json bundles），
// 便于单元测试直连。
//
// 语义要点（与 main.js 原实现的差异/修复）：
//  · 顶层 `- id: x` 条目与 `- insert:` 内层条目都算登记点；
//  · **任一登记点带 disabled: true 即视为禁用** —— syncCompanionPlugins
//    写默认禁用插件（如 dsh-dafeiyu）用的是 insert 内层形态，v4.2 曾只认
//    顶层条目，导致管理页把 dsh-dafeiyu 错报为「已启用」、host 端 config
//    端点不存在（桌宠加载不出 + 「未连接 DSH Host」）；
//  · hasConfig 仍只读顶层条目：insert 内层的 config 是 sync 的固定形态
//    （如 dsh-pet 行带 config），计入会把管理页开关误锁成不可切换，破坏
//    dsh-pet-settings 桌宠卡片的启停（它走同一个 setEnabled IPC）。
//
// M3/#416 三层分级（L1 builtin / L2 recommended / L3 external）：
//  · canonical 字段是 `.sync/plugin-distribution.json` 的 `distributionClass`
//    （v2 计划 §0.5 裁定，不新增 `tier`）；运行时经生成注册表拿到
//    builtin/recommended 两个集合，其余 id 一律按 L3 external 处理
//    ——「用户自行下载安装的任意插件」（非台账 id 的新装插件同此）。
//    对台账内每个 id 该推导与 ledger 的 distributionClass 逐项一致
//    （见 test/issue-416-plugin-distribution-tiers.test.ts）。
//  · L1 行默认启用且不可停用/移除（与 onboarding CORE_PLUGIN_IDS 的 IPC
//    拒绝同一语义，这里把状态提前暴露给 UI，避免出现按不动的开关）；
//  · L2 行保持可开关，并标注推荐包 id + 「安装时可选是否启用」；
//  · L3 行标注外部来源、安装默认禁用（defaultEnabled=false），可手动启用。
//  · **包名 → 标识**统一走 canonicalBundleId（见其注释）：台账包走台账 id
//    （`@dsh-eac/skin-aurora` → `dsh-eac-skin-aurora`）、内核骨架走短名、
//    未登记 scoped 包编码为稳定 ID（`@evil/dsh-pet` → `scoped-406576696c2f6473682d706574`）。禁止
//    无条件去 scope 折叠 —— 那会让冒名包借别人的 id 躲过默认禁用（#416 回归）。

/**
 * @param {Array} entries   cordis.patch.yml 解析出的条目数组
 * @param {object} ctx
 * @param {Array<{id:string,name:string}>} ctx.companion  内置配套插件清单
 * @param {Iterable<string>} [ctx.coreIds]                核心插件 id（不可移除）
 * @param {Iterable<string>} [ctx.removedIds]             用户移除的内置插件 id
 * @param {(name:string)=>string} [ctx.describe]          包名 → 描述
 * @param {Array<string>} [ctx.bundles]                   profile 的 dsh.profile.bundles
 * @param {Iterable<string>} [ctx.builtinIds]             L1 内置分级 id（生成注册表）
 * @param {Iterable<string>} [ctx.recommendedIds]         L2 推荐分级 id（生成注册表）
 * @param {string|null} [ctx.recommendedPack]             推荐包 id（UI 标注用）
 * @returns {Array<object>} 排序后的插件行
 */
// 内核 bundle 白名单（去 scope 后的短名）：dsh 官方 web profile 的骨架
// 注册点，禁用会破坏界面 → 管理页锁定为 core；bundles 里的其余条目
// （市场 / dsh plugin add 装入的第三方包）归入 other 组、可开关。
const KERNEL_BUNDLE_IDS = new Set([
  'dsh-base',
  'dsh-web-app',
  'web-app',
  'web-runtime',
  'client-modules',
]);

/** 内核骨架的**完整包名**白名单（与 KERNEL_BUNDLE_IDS 同一批注册点的包名形态）。
 *  #416 回归：包名解析不再无条件去 scope（见 canonicalBundleId），内核骨架必须
 *  按完整包名精确匹配 —— `@evil/dsh-base` / `@evil/dsh-web-app` 不是内核骨架，
 *  不得借折叠后的短名豁免「外部层默认禁用」。 */
const KERNEL_BUNDLE_PACKAGES = new Set<string>([
  ...KERNEL_BUNDLE_IDS,
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/web-app',
  '@deepseek-ai/web-runtime',
  '@deepseek-ai/client-modules',
]);

/** 生成注册表的「包名 → 条目 id」反查（canonical 事实源）。
 *  lib/desktop/plugin-sync-registry.js 是随包分发的生成产物（与 .sync 台账
 *  逐字节一致，见 test/issue-416-plugin-distribution-tiers.test.ts），
 *  entries[id].packageName 是「包名 ↔ 行/条目标识」的唯一权威映射：
 *  `@dsh-eac/skin-aurora` → `dsh-eac-skin-aurora`（**不是**去 scope 的
 *  `skin-aurora`）、`@dsh-eac/ui-skin-loader` → `dsh-ui-skin-loader`、
 *  `@vlln/dsh-navbar` → `dsh-navbar`。注册表缺失（未构建的裁剪部署）时退化为
 *  空表：除内核骨架白名单外一律按 scoped-<hex> 稳定编码处理，宁可按外部层
 *  规划（可手动启用），也不再做会撞车的去 scope 折叠。 */
const KNOWN_PACKAGE_IDS: Map<string, string> = (() => {
  const out = new Map<string, string>();
  try {
    const reg = require('./lib/desktop/plugin-sync-registry.js') as {
      PLUGIN_SYNC_REGISTRY?: { entries?: Record<string, { packageName?: string }> };
    };
    const entries = reg && reg.PLUGIN_SYNC_REGISTRY ? reg.PLUGIN_SYNC_REGISTRY.entries : undefined;
    for (const [id, info] of Object.entries(entries || {})) {
      const pkg = info && typeof info.packageName === 'string' ? info.packageName : '';
      if (id && pkg && !out.has(pkg)) out.set(pkg, id);
    }
  } catch {
    /* 注册表不可读：退化为「内核骨架白名单 + scoped-<hex> 编码」 */
  }
  return out;
})();

/** bundle 包名 → 规范标识（canonical id）。
 *  1. 台账登记过的包名（生成注册表反查）→ 台账 id（EAC/推荐/配套包的真实行 id）；
 *  2. 内核骨架包名 → 现有短名（KERNEL_BUNDLE_IDS 语义不变）；
 *  3. 其余：无 scope 的包名即 id；有 scope 的包名编码为 `scoped-<hex>`
 *     （`@evil/dsh-pet` → `scoped-406576696c2f6473682d706574`）——稳定、可落盘
 *     （scripts/plugin-manager-patch.js 的 ID_RE 只收 [A-Za-z0-9_.-]，直接拿
 *     完整包名（含 `@` `/`）会抛 TypeError），且绝不与另一个插件的 bare id、
 *     skipIds、分级表键撞车。
 *  历史缺陷（本次回归）：这里曾无条件 `slice(indexOf('/') + 1)`，把
 *  `@evil/dsh-pet` 折成配套插件 `dsh-pet`（∈ skipIds）、`@evil/dsh-navbar`
 *  折成推荐包 `dsh-navbar`（∈ 分级表）、`@evil/dsh-base` 折成内核骨架 —— 三个
 *  冒名包全部躲过默认禁用；同短名不同 scope 的包还会互相覆盖成一行。 */
function canonicalBundleId(name: string, packageIds: ReadonlyMap<string, string> = KNOWN_PACKAGE_IDS): string {
  const known = packageIds.get(name);
  if (known) return known;
  const bare = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
  if (KERNEL_BUNDLE_PACKAGES.has(name)) return bare;
  if (!name.startsWith('@') || !name.includes('/')) return name;
  // Encode the complete scoped package name instead of flattening it to
  // `<scope>-<name>`: `@a/x-y` must not collide with an unscoped `a-x-y`, and
  // `@a/x` must remain distinct from `@b/x`. Hex uses only the patch ID alphabet
  // and is injective for package names, so the persisted ID is deterministic.
  return `scoped-${Buffer.from(name, 'utf8').toString('hex')}`;
}

/** 是否内核骨架 bundle：短名（历史 id）或完整包名任一命中即算。 */
function isKernelBundle(name: string, id: string): boolean {
  return KERNEL_BUNDLE_IDS.has(id) || KERNEL_BUNDLE_PACKAGES.has(name);
}

type DistributionClass = 'builtin' | 'recommended' | 'external';

/** 分级标签（UI 兜底文案；客户端按 locale 有自己的映射）。 */
const TIER_LABELS: Record<DistributionClass, string> = {
  builtin: '内置',
  recommended: '推荐',
  external: '外部',
};

interface PluginRow {
  id: string; name: string; description: string; enabled: boolean;
  toggleable: boolean; removable: boolean; removed: boolean; core: boolean;
  /** EAC 私有维护（台账 eac-original）：不参与内置插件自动更新。 */
  privateMaintained: boolean;
  group: 'companion' | 'other' | 'core';
  /** L1/L2/L3 分级（canonical：ledger distributionClass）。 */
  distributionClass: DistributionClass;
  /** 分级标签（内置/推荐/外部）。 */
  tierLabel: string;
  /** 该分级新装时的默认状态：L1/L2 启用，L3 禁用。 */
  defaultEnabled: boolean;
  /** L2：安装后由用户选择是否启用。 */
  enableChoice: boolean;
  /** L2 的推荐包 id（其余为 null）。 */
  pack: string | null;
  entryIds?: string[];
  error?: string;
}

interface CollectCtx {
  bundleIdentities?: BundleIdentities;
  companion?: Array<{ id: string; name: string }>;
  coreIds?: Iterable<string>;
  removedIds?: Iterable<string>;
  describe?: (name: string) => string;
  bundles?: string[];
  /** 私有维护插件 id 集合（行上打 privateMaintained 标记）。 */
  privateIds?: Iterable<string>;
  /** canonical 分级映射（生成注册表 distribution.pluginClasses，来自 ledger）。 */
  distributionClasses?: Record<string, string>;
  /** 无 canonical 映射时的分级集合兜底（生成注册表 id 清单）。 */
  builtinIds?: Iterable<string>;
  recommendedIds?: Iterable<string>;
  /** 推荐包 id（L2 行标注）。 */
  recommendedPack?: string | null;
}

/** 分级推导（canonical 优先）：
 *  1. ledger 的 distributionClass（生成注册表 pluginClasses）——唯一事实源；
 *  2. 无映射时按 builtin/recommended 集合兜底，其余（含非台账新装插件）记
 *     L3 外部；
 *  3. 内核骨架（core 组）虽不在插件台账内，但属于随包分发面 → 记 L1。 */
function distributionClassOf(
  id: string,
  group: 'companion' | 'other' | 'core',
  distributionClasses?: Record<string, string>,
  builtinIds?: Set<string>,
  recommendedIds?: Set<string>,
): DistributionClass {
  const canonical = distributionClasses ? distributionClasses[id] : undefined;
  if (canonical === 'builtin' || canonical === 'recommended' || canonical === 'external') return canonical;
  if (builtinIds && builtinIds.has(id)) return 'builtin';
  if (recommendedIds && recommendedIds.has(id)) return 'recommended';
  if (group === 'core') return 'builtin';
  return 'external';
}

function collectPluginRows(entries: unknown[], ctx: CollectCtx = {}): PluginRow[] {
  const companion = Array.isArray(ctx.companion) ? ctx.companion : [];
  const companionById = new Map(companion.map((p) => [p.id, p.name]));
  const companionNames = new Set(companion.map((p) => p.name));
  const coreIds = new Set(ctx.coreIds || []);
  const removedIds = new Set(ctx.removedIds || []);
  const describe = typeof ctx.describe === 'function' ? ctx.describe : () => '';
  const bundles = Array.isArray(ctx.bundles) ? ctx.bundles : [];
  const privateIds = new Set(ctx.privateIds || []);
  const distributionClasses = ctx.distributionClasses && typeof ctx.distributionClasses === 'object'
    ? ctx.distributionClasses
    : undefined;
  const builtinIds = new Set(ctx.builtinIds || []);
  const recommendedIds = new Set(ctx.recommendedIds || []);
  const recommendedPack = typeof ctx.recommendedPack === 'string' && ctx.recommendedPack
    ? ctx.recommendedPack
    : null;

  const insertById = new Map<string, { name: string; disabled: boolean; hasDisabled: boolean }>();
  const userById = new Map<string, { name: string; disabled: boolean; hasDisabled: boolean; hasConfig: boolean }>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const ent = entry as { insert?: unknown; id?: unknown };
    if (Array.isArray(ent.insert)) {
      for (const it of (ent.insert as unknown[])) {
        if (it && typeof (it as { id?: unknown }).id === 'string') {
          const i2 = it as { id: string; name?: string; disabled?: boolean };
          insertById.set(i2.id, { name: i2.name || '', disabled: i2.disabled === true, hasDisabled: typeof i2.disabled === 'boolean' });
        }
      }
    } else if (typeof ent.id === 'string') {
      const e2 = entry as { id: string; name?: string; disabled?: boolean; config?: unknown };
      userById.set(e2.id, {
        name: e2.name || '',
        disabled: e2.disabled === true,
        hasDisabled: typeof e2.disabled === 'boolean',
        hasConfig: e2.config !== undefined && e2.config !== null,
      });
    }
  }

  const seen = new Set();
  const rows: PluginRow[] = [];
  const addRow = (id: string, name: string, group: 'companion' | 'other' | 'core', extra?: { removed?: boolean; core?: boolean }) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const user = userById.get(id);
    const insert = insertById.get(id);
    // 顶层或 insert 内层任一登记点带 disabled 即禁用（v4.2 修复点）。
    const disabled = !!(user && user.disabled) || !!(insert && insert.disabled);
    const hasConfig = !!(user && user.hasConfig);
    const isRemoved = !!(extra && extra.removed);
    const isCore = !!(extra && extra.core);
    const distributionClass = distributionClassOf(id, group, distributionClasses, builtinIds, recommendedIds);
    // L1 内置：默认启用且不可停用/移除（IPC 侧 pluginManagerSetEnabled 对
    // 同一 id 集合直接拒绝，这里同步锁定开关，避免出现按不动的控件）。
    const builtin = distributionClass === 'builtin';
    const toggleable = group !== 'core' && !isCore && !builtin && !(hasConfig && !disabled);
    rows.push({
      id,
      name: name || id,
      description: describe(name || id),
      enabled: !disabled && !isRemoved,
      toggleable: toggleable && !isRemoved,
      removable: group === 'companion' && !isCore && !builtin && !isRemoved,
      removed: isRemoved,
      core: isCore || builtin,
      privateMaintained: privateIds.has(id),
      group,
      distributionClass,
      tierLabel: TIER_LABELS[distributionClass],
      defaultEnabled: distributionClass !== 'external',
      enableChoice: distributionClass === 'recommended',
      pack: distributionClass === 'recommended' ? recommendedPack : null,
    });
    const identity = ctx.bundleIdentities?.[name];
    if (identity) {
      const row = rows[rows.length - 1]!;
      if (!identity.ok) {
        row.toggleable = false;
        row.removable = false;
        row.error = identity.error;
      } else {
        row.entryIds = identity.entryIds;
        row.enabled = !isRemoved && identity.entries.every((entry) => {
          const override = userById.get(entry.id) || insertById.get(entry.id);
          return !(override?.hasDisabled ? override.disabled : entry.disabled);
        });
        row.toggleable = !isRemoved && !isCore && !builtin;
        row.removable = !isRemoved && !isCore && !builtin;
      }
    }
  };
  for (const p of companion) {
    addRow(p.id, p.name, 'companion', { removed: removedIds.has(p.id), core: coreIds.has(p.id) });
  }
  const bundledEntryIds = new Set(Object.values(ctx.bundleIdentities || {})
    .flatMap((identity) => identity.entryIds || []));
  // bundles（dsh.profile.bundles）里除 companion 之外还有两类：内核骨架
  // （官方 web profile 的注册点，禁了界面会坏）与用户/市场装入的第三方包
  // （dsh plugin add / 市场安装同样登记进 bundles）。旧实现把后者也一律标
  // 成 core → 插件列表变成「全核心、无法关闭」（issue #212）。改为仅对
  // 白名单内的内核骨架标 core，第三方 bundle 归入 other、可开关。
  // 行 id 用 canonicalBundleId（台账 id / 内核短名 / scoped-<hex> 编码），与
  // externalDefaultDisabledPlan 落盘的 id 同一空间：冒名 scoped 包既不会
  // 顶掉同名配套行，也不会在管理页里消失。
  for (const name of bundles) {
    if (companionNames.has(name)) continue;
    const id = canonicalBundleId(name);
    if (!seen.has(id)) addRow(id, name, isKernelBundle(name, id) ? 'core' : 'other');
  }
  for (const [id, info] of insertById) if (!companionById.has(id) && !bundledEntryIds.has(id)) addRow(id, info.name, 'other');
  for (const [id, u] of userById) if (!companionById.has(id) && !bundledEntryIds.has(id)) addRow(id, u.name, 'other');
  const order = { companion: 0, other: 1, core: 2 };
  return rows.sort((a, b) => order[a.group] - order[b.group] || a.id.localeCompare(b.id));
}

interface ExternalDefaultDisabledOpts {
  bundleIdentities?: BundleIdentities;
  /** 测试/裁剪部署可显式提供包名 → canonical id 映射，模拟注册表不可读。 */
  packageIds?: ReadonlyMap<string, string>;
  /** profile 的 dsh.profile.bundles（市场 / dsh plugin add 装入的包名）。 */
  bundles?: unknown[];
  /** patch 里是否已有该 id 的登记点（用户/市场/同步写入的状态优先）。 */
  isRegistered?: (id: string) => boolean;
  /** canonical 分级映射（生成注册表 distribution.pluginClasses）。 */
  distributionClasses?: Record<string, string>;
  /** 无 canonical 映射时的分级集合兜底（生成注册表 id 清单）。 */
  builtinIds?: Iterable<string>;
  recommendedIds?: Iterable<string>;
  /** 已由其它同步面（配套插件清单）负责的 id（canonical id 或原始包名匹配）。 */
  skipIds?: Iterable<string>;
}

/**
 * L3 外部层「新装插件默认禁用」的落盘规划（纯函数）：
 * 从 profile bundles 里挑出**既非内核骨架、也不在 L1/L2 分级、且 patch
 * 里还没有登记点**的第三方插件，返回需要补写「编辑型关闭行」的 id/包名。
 * 写盘复用既有 patch 手术（scripts/plugin-manager-patch.js 的
 * togglePluginInPatch），与插件管理页的开关、市场安装后的落盘同一条路径。
 *
 * fail-open：完全没有分级知识（canonical 映射与两个集合都缺省）时返回空
 * 清单 —— 宁可不自动禁用，也不误禁用户插件。
 */
function externalDefaultDisabledPlan(o: ExternalDefaultDisabledOpts = {}): Array<{ id: string; name: string }> {
  const bundles = Array.isArray(o.bundles) ? o.bundles : [];
  const distributionClasses = o.distributionClasses && typeof o.distributionClasses === 'object'
    ? o.distributionClasses
    : undefined;
  const builtinIds = o.builtinIds === undefined ? undefined : new Set(o.builtinIds);
  const recommendedIds = o.recommendedIds === undefined ? undefined : new Set(o.recommendedIds);
  if (!distributionClasses && !builtinIds && !recommendedIds) return [];
  const isRegistered = typeof o.isRegistered === 'function' ? o.isRegistered : () => false;
  const skipIds = new Set(o.skipIds || []);
  const out: Array<{ id: string; name: string }> = [];
  const seen = new Set();
  for (const name of bundles) {
    if (typeof name !== 'string' || !name) continue;
    // identity = canonicalBundleId：台账 id / 内核短名 / 未登记 scoped 包的
    // scoped-<hex> 编码。绝不把 scope 抹掉去撞另一个插件的 bare id（#416 回归）。
    const id = canonicalBundleId(name, o.packageIds || KNOWN_PACKAGE_IDS);
    if (!id || seen.has(id) || isKernelBundle(name, id)) continue;
    // skipIds 是配套插件同步面（companion-sync）交来的排除集：按 canonical id
    // 与原始包名两边匹配，保留「配套插件不进默认禁用」的既有语义。
    if (skipIds.has(id) || skipIds.has(name)) continue;
    if (distributionClassOf(id, 'other', distributionClasses, builtinIds, recommendedIds) !== 'external') continue;
    const identity = o.bundleIdentities?.[name];
    if (o.bundleIdentities) {
      // A package identifier is a UI key, never an inferred loader entry ID.
      if (!identity?.ok || identity.entryIds.some((entryId) => isRegistered(entryId) || skipIds.has(entryId))) continue;
      seen.add(id);
      for (const entry of identity.entries) out.push({ id: entry.id, name: entry.name });
      continue;
    }
    if (isRegistered(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export = {
  collectPluginRows,
  distributionClassOf,
  externalDefaultDisabledPlan,
  canonicalBundleId,
  KERNEL_BUNDLE_IDS,
  KERNEL_BUNDLE_PACKAGES,
  TIER_LABELS,
};
