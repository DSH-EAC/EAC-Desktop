'use strict';

// 配套 dsh 插件同步（ADR 0002 L2 业务服务层；Wave 2 收官自 companion-sync.js
// 类型化迁出，行为零变更）：注入 web profile：余额小部件 + 文件更改追踪/
// 还原 + 内置插件治理。
// M2/#415：旧版用户可见皮肤切换（dsh-skin-switch + assets/skins 目录播种）
// 已整体退役 —— 换肤职责后由公约皮肤平台承接（该平台亦已于 EAC-CORE-SHELL-01
// 外迁为市场可选包）；壳层 ui-skin manager 的 boot/recovery 回退资源不受本
// 退役影响（ADR 0010）。
// ISO-005 运行时清单收敛：COMPANION_PLUGINS 只登记「随包实物」—— 装配面
// tauri-shell/stage-resources.mjs 的 BUILTIN_PLUGIN_DIRS 是唯一基准（当前 9
// 项，每项在 assets/plugins 下有同名目录）。已不随包的插件不在本清单留空转项：
// 旧 profile 残留的行/包副本由 RETIRED_BUILTIN_PLUGINS 兜底清理（见下方清单），
// 用户仍需要时经市场按需安装（recommended/external 分级见 .sync 账本）。
// 皮肤平台（`@dsh-eac/ui-skin-loader` + 13 款公约皮肤包）已于 EAC-CORE-SHELL-01
// 外迁为市场可选包，同样只留 RETIRED 兜底；无皮肤激活 = 宿主原生观感。

import path = require('node:path');
import fs = require('node:fs');
import os = require('node:os');
import crypto = require('node:crypto');
import { isMap, isSeq, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { updCtx, APP_ROOT } from './runtime-paths';
import { isLiteDisabled, readInstallProfile } from './install-profile';
import { desktopProfile, desktopProfileDir, ensureDesktopProfileInit, BUNDLED_BUILTIN_PLUGINS } from './profile';
import { ensureGuard } from './guard-box';
import { applySessionManageFix } from './runtime-patches';
import { pluginCapabilityDetails } from './platform';
import { writeFileAtomic } from '../atomic-json.js';
import { parsePatchData, registeredPatchEntryIds, resolveBundleIdentities, toggleBundleInPatch } from '../bundle-identity';
import { PLUGIN_UPDATE_SOURCES as GENERATED_PLUGIN_UPDATE_SOURCES } from './plugin-sync-registry';
// 未类型化依赖（Wave 3 收编），先以窄签名消费。
const updater = require('../../updater') as {
  loadSettings(c: ReturnType<typeof updCtx>): { removedPlugins?: unknown };
  saveSettings(c: ReturnType<typeof updCtx>, s: unknown): void;
  compareVersions(a: string, b: string): number;
};
const pluginUpdater = require('../../plugin-updater') as {
  versionOfDir(dir: string): string | null;
};
const { healProfileModuleShadowing } = require('../../profile-module-heal') as {
  healProfileModuleShadowing(home: string, profile: string): string[];
};
// M3/#416 L3：外部层（第三方/社区）新装插件默认禁用 —— 规划是纯函数
// （plugin-manager-state），落盘复用插件管理页同一套 patch 手术
// （scripts/plugin-manager-patch.js），不新增安装器。
const { externalDefaultDisabledPlan, canonicalBundleId } = require('../../plugin-manager-state') as {
  externalDefaultDisabledPlan(o: {
    bundles?: unknown[];
    bundleIdentities?: ReturnType<typeof resolveBundleIdentities>;
    isRegistered?: (id: string) => boolean;
    distributionClasses?: Record<string, string>;
    builtinIds?: Iterable<string>;
    recommendedIds?: Iterable<string>;
    skipIds?: Iterable<string>;
  }): Array<{ id: string; name: string }>;
  canonicalBundleId(name: string): string;
};
import {
  DISTRIBUTION_BUILTIN_PLUGIN_IDS,
  RECOMMENDED_PACK_PLUGIN_IDS,
  PLUGIN_DISTRIBUTION_CLASSES,
} from './plugin-sync-registry';
const {
  configLinesFor,
  healSoulMdPatchRow,
  healRowConfig,
  removeBundledRowDuplicates,
  collectBundleEntryIds,
} = require('../../patch-row-heal') as {
  configLinesFor(config: unknown): string;
  healSoulMdPatchRow(patch: string): { healed: unknown[]; patch: string };
  healRowConfig(patch: string, id: string, config: unknown): { healed: unknown[]; patch: string };
  removeBundledRowDuplicates(patch: string, rowIds: Record<string, string>, bundled: unknown[], declared: Set<string>): { removed: string[]; patch: string };
  collectBundleEntryIds(bundled: unknown[], nodeModulesDir: string): Set<string>;
};
const { syncBundledPresets, ensureDefaultAgentPreset } = require('../../preset-sync') as {
  syncBundledPresets(src: string, dst: string, log: (m: string) => void): { installed: string[] };
  ensureDefaultAgentPreset(home: string, name: string, log: (m: string) => void): string;
};
const { migrateManagedCompactPresets } = require('../../compact-preset-migrate') as {
  migrateManagedCompactPresets(dir: string, log: (m: string) => void): { status: string; file: string }[];
};
const { migrateManagedRouterPersonaPresets } = require('../../router-persona-preset-migrate') as {
  migrateManagedRouterPersonaPresets(
    assetsDir: string,
    presetsDir: string,
    log: (m: string) => void,
  ): { status: string; file: string }[];
};
const { hasEntryId } = require('../../scripts/plugin-manager-patch') as {
  hasEntryId(patch: string, id: string): boolean;
};

/** 注入接口：由宿主（Electron main / Tauri sidecar）在启动时提供。 */
export interface CompanionSyncCtx {
  log(tag: string, msg: string): void;
  getDshHome(): string | null;
  getUserDataDir(): string;
  showMainWindow(): void;
  notify(n: { title: string; body: string; icon?: string; onClick?: () => void }): void;
  platform?: NodeJS.Platform;
}

let ctx!: CompanionSyncCtx;
export function init(d: CompanionSyncCtx): void { ctx = d || ({} as CompanionSyncCtx); }

export interface CompanionPluginDef {
  id: string;
  name: string;
  dir?: string;
  disabled?: boolean;
  config?: unknown;
}

interface PendingRow {
  id: string;
  name: string;
  disabled: boolean;
  config?: unknown;
}

// 运行时登记面 = 随包实物（基准见文件头）：每项都必须能解析出
// assets/plugins/<dir> 实物目录。实物不在包却在清单里的条目，每次启动只会
// 留一条「配套插件源目录无效，跳过」的空转日志 —— ISO-005 起本清单与装配面
// 1:1（9 项），收敛前登记的 35 项不再随包，旧 profile 迁移见下方 RETIRED 清单。
//
// 绝不能写进 profile package.json 依赖 —— pnpm 安装会 hoist @deepseek-ai
// 核心包形成模块双实例（Symbol 冲突，插件命名空间注册失效，即
// "设置命名空间不可用" 故障的根因）。
export const COMPANION_PLUGINS: CompanionPluginDef[] = [
  // 会话文件更改投影（fileChanges）：折叠 tool/result 的 meta.diffs，为「文件」
  // 视图与回退提供数据。
  { id: 'file-changes', name: '@deepseek-ai/dsh-file-changes' },
  // 「文件」视图：会话文件更改追踪 + 一键还原（数据来自上面的投影，还原由
  // 壳层执行）。
  { id: 'client-file-changes', name: '@deepseek-ai/dsh-client-file-changes' },
  // 统一插件市场（dsh-unified-market，内置）：聚合精选目录
  // （awesome-dsh-plugin.com）+ GitHub dsh-plugin 生态 + npm 检索三源；
  // EAC 特化（web-desktop profile），试装验证 + 冲突预检 + 后台自动更新 +
  // 自动更新排队与启动消费 + 市场自更新。取代曾被内置的 webui-market /
  // zat-market / 旧 npm 市场（各自 profile 定位错误或重复，已从清单移除）。
  { id: 'unified-market', name: 'dsh-unified-market', dir: 'dsh-unified-market' },
  // 设置页快速配置：视觉模型提供商/模型一键选择、soul.md 人设可视化编辑、
  // 从 Codex / Claude Code 目录一键迁移 skills。
  { id: 'easy-setup', name: '@deepseek-ai/dsh-easy-setup' },
  // 旧版/社区客户端插件的英文兼容层：跟随官方 locale 状态翻译固定 UI
  // 文案，不触碰会话、代码、终端、编辑器或用户输入。作为界面底座始终启用。
  { id: 'eac-locale-compat', name: 'dsh-eac-locale-compat', dir: 'dsh-eac-locale-compat' },
  // 视口钳制（文档级滚动根治）：html/body overflow:hidden + 稳定契约
  // （data-phase/data-conversation-scroll）hero 居中兜底。纯客户端 CSS，
  // 随内核页面加载 —— 桌面壳 / 浏览器 / 手机端三端同源生效，不再依赖
  // 桌面壳垫片与 CSS Modules 哈希类（内核更新换哈希即失效的旧方案）。
  { id: 'viewport-lock', name: 'dsh-viewport-lock', dir: 'dsh-viewport-lock' },
  // 请求路径自动压缩：在模型请求前按真实 Token 压力调用 DSH 原生压缩
  // 引擎；上下文溢出时最多压缩并重试原请求一次，不再模拟输入 /compact。
  { id: 'compact', name: 'dsh-compact', dir: 'dsh-compact' },
  // 插件保护中心 UI：快照列表/一键回滚/健康检查/事故报告，经桌面壳
  // IPC（guard:action）驱动 plugin-guard.js 引擎。
  { id: 'plugin-shield', name: 'dsh-plugin-shield', dir: 'dsh-plugin-shield' },
  // 设置面板滚轮修复：不绑定 CSS Modules 哈希类名，按设置页语义与真实
  // overflow 尺寸识别导航/内容滚动区；MutationObserver 跟随动态内容，卸载时
  // 完整清理样式、标记与监听器。纯客户端实现（host 半边 no-op）。
  { id: 'settings-scroll-fix', name: 'dsh-settings-scroll-fix', dir: 'dsh-settings-scroll-fix' },
  // —— 已不随包的插件（ISO-005 收敛出本清单）：不再登记 ——
  // 收敛前本清单 44 项，其中 35 项自 v6 Task 3.1 剥出 assets/plugins 后已无实物
  //（每次启动只留一条「配套插件源目录无效，跳过」）。它们不再随包，改由市场按需
  // 安装（.sync/plugin-distribution.json：15 recommended + 20 external）；旧
  // profile 残留的行/包副本/依赖由下方 RETIRED_BUILTIN_PLUGINS 兜底清理。
  // ISO-003：VNext Core Bridge（eac-core-bridge）已退役 —— 它曾在此默认启用，
  // 但端点由 sidecar 注入的前提从未成立：DSH_EAC_BRIDGE_URL/TOKEN 全仓零
  // 写入方（lib/desktop/proc.ts 的 childEnv() 不注入），插件读不到端点即提前
  // return，随包且默认启用只会静默空转（ADR 0003 已随 ADR 0006 裁废）。
  // 本清单不再登记它；历史 profile 的行/包副本/依赖由 RETIRED_BUILTIN_PLUGINS
  // 兜底清理（资产目录保留在 assets/plugins/dsh-eac-core-bridge 待接回）。
  // EAC-CORE-SHELL-01：皮肤平台（loader + 13 款公约皮肤）已外迁为市场可选包，
  // 同样只留 RETIRED 兜底（见下方清单）。
];

export function companionPluginsForPlatform(platform: NodeJS.Platform = 'win32'): CompanionPluginDef[] {
  const capabilities = pluginCapabilityDetails(platform);
  return COMPANION_PLUGINS.filter((plugin) => capabilities[plugin.id]?.status !== 'unavailable');
}

// 更新源唯一来自 generated registry；此导出保留给旧调用方。
export const PLUGIN_UPDATE_SOURCES: Record<string, { npm?: string; github?: string }> = GENERATED_PLUGIN_UPDATE_SOURCES;
// ---------------------------------------------------------------------------
// 私有维护插件（自动更新黑名单，SOURCES.json 台账驱动）：
//
// 台账 origin=eac-original 的 main 线插件由 EAC 私有维护（外部匹配审计的
// best-match 即 EAC 主仓库本体），没有可钉的外部上游发版——自动更新要么把
// EAC 适配冲掉，要么更新到无从校验的来源。黑名单在此生成，pluginUpdateSources
// 是唯一漏斗：即使将来误把私有插件登记进 PLUGIN_UPDATE_SOURCES 也会被强制
// 过滤（sidecar server.ts 的「检测」与「应用更新」两条路都经过它）。
//
// fail-open 取舍：台账不可读时黑名单为空、不过滤（见
// privateMaintainedPluginNames）——该状态下上述「误登记也无效」的保证暂不
// 成立。私有插件本就不在 PLUGIN_UPDATE_SOURCES 白名单里，过滤是纵深防御。
// ---------------------------------------------------------------------------

let privateMaintainedCache: Set<string> | null = null;

/** 台账 origin=eac-original 的 main 线插件包名集合（自动更新黑名单）。
 *
 *  fail-open：台账缺失/损坏时返回空集、不过滤——此时本函数不是强制点，
 *  「误登记 PLUGIN_UPDATE_SOURCES 也会被强制过滤」的保证暂不成立（私有插件
 *  本就不在白名单里，过滤为纵深防御）。仅缓存成功读取的结果，失败不落缓存，
 *  文件恢复后下次调用即生效。 */
export function privateMaintainedPluginNames(): Set<string> {
  if (privateMaintainedCache) return privateMaintainedCache;
  const names = new Set<string>();
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'assets', 'SOURCES.json'), 'utf8')) as {
      components?: { line?: string; type?: string; origin?: string; name?: string }[];
    };
    for (const c of ledger.components || []) {
      if (c.line === 'main' && c.type === 'plugin' && c.origin === 'eac-original' && c.name) names.add(c.name);
    }
    privateMaintainedCache = names;
  } catch (err) {
    console.warn('[plugin-update] SOURCES.json 读取失败，自动更新黑名单未生效（fail-open）: ' + String((err as Error).message || err));
  }
  return names;
}

// ---------------------------------------------------------------------------
// 内置插件「移除」跳过清单（settings.removedPlugins）：被 plugin-ops 与
// syncCompanionPlugins 共用，故置于本模块（打破循环依赖）。
// ---------------------------------------------------------------------------

export function removedPluginIds(): Set<string> {
  try {
    const s = updater.loadSettings(updCtx());
    return new Set(Array.isArray(s.removedPlugins) ? s.removedPlugins as string[] : []);
  } catch { return new Set(); }
}

export function saveRemovedPluginIds(ids: Set<string>): void {
  const c = updCtx();
  const s = updater.loadSettings(c) as Record<string, unknown>;
  s.removedPlugins = Array.from(ids);
  updater.saveSettings(c, s);
}

/** 内置 bundle 插件播种（纯函数，可单测）：确保 profile package.json 的
 *  dsh.profile.bundles 包含 BUNDLED_BUILTIN_PLUGINS。幂等：缺失则追加并写回
 * （保持 JSON 缩进 2 + 尾换行，与 ensureDesktopProfileInit 出厂格式一致），
 * 已有（用户市场安装 / dsh plugin add / 曾经播种过）则不动。返回变化标记与
 * 播种后的 bundles 数组。失败不抛异常：返回 { changed: false, bundles: [] }。 */
export function seedBundledPlugins(profileDir: string): { changed: boolean; bundles: unknown[] } {
  let bundled: unknown[] = [];
  try {
    const pkgDsh = readJsonFile(path.join(profileDir, 'package.json'))?.dsh as Record<string, unknown> | undefined;
    const prof = pkgDsh?.profile as Record<string, unknown> | undefined;
    bundled = Array.isArray(prof?.bundles) ? prof.bundles : [];
  } catch { bundled = []; }
  const orig = bundled.slice();
  let changed = false;
  for (const bundleName of BUNDLED_BUILTIN_PLUGINS) {
    if (!bundled.includes(bundleName)) { bundled.push(bundleName); changed = true; }
  }
  if (changed) {
    try {
      const pkgFile = path.join(profileDir, 'package.json');
      const pkg = readJsonFile(pkgFile);
      if (pkg && typeof pkg === 'object') {
        const pkgRec = pkg as Record<string, unknown>;
        const dsh = (pkgRec.dsh || (pkgRec.dsh = {})) as Record<string, unknown>;
        const prof = (dsh.profile || (dsh.profile = {})) as Record<string, unknown>;
        prof.bundles = bundled;
        fs.writeFileSync(pkgFile, JSON.stringify(pkgRec, null, 2) + '\n');
      } else {
        changed = false;
        bundled = orig;
      }
    } catch {
      changed = false;
      bundled = orig;
    }
  }
  return { changed, bundles: bundled };
}

/** 把内置插件表 + 更新源注册表合并成 plugin-updater 的 sources 输入。
 *  私有维护插件（台账 eac-original）在此强制过滤——这是更新源的唯一漏斗。 */
export function pluginUpdateSources(): { id: string; name: string; assetsDir: string; update: { npm?: string; github?: string } }[] {
  const removed = removedPluginIds();
  const platform = ctx?.platform ?? 'win32';
  const available = new Set(companionPluginsForPlatform(platform).map((plugin) => plugin.id));
  const privateNames = privateMaintainedPluginNames();
  const blocked: string[] = [];
  const out: { id: string; name: string; assetsDir: string; update: { npm?: string; github?: string } }[] = [];
  for (const p of COMPANION_PLUGINS) {
    if (!available.has(p.id)) continue;
    const update = PLUGIN_UPDATE_SOURCES[p.id];
    if (!update) continue;
    if (removed.has(p.id)) continue;
    if (privateNames.has(p.name)) { blocked.push(p.id); continue; }
    const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() as string : p.name);
    const assetsDir = path.join(APP_ROOT, 'assets', 'plugins', dirName);
    if (!fs.existsSync(path.join(assetsDir, 'package.json'))) continue;
    out.push({ id: p.id, name: p.name, assetsDir, update });
  }
  if (blocked.length) {
    console.warn('[plugin-update] 私有维护插件不参与自动更新，已从更新源过滤: ' + blocked.join(', '));
  }
  return out;
}

/**
 * 市场同名残留的「第三方证据」判定（纯函数，可单测）。
 *
 * 三条证据任一成立才算残留：市场版依赖（非 link:/file: 自建链接）、
 * **非应用播种**的 bundles 条目、非自写 patch 行。
 *
 * ISO-005：bundles 条目只有在「不是应用自己播种的」时才是证据 —— 应用播种
 * 清单是 BUNDLED_BUILTIN_PLUGINS（profile.ts，当前为空数组：随包插件走配套
 * 行/包拷贝路径，不经 bundles 播种）。若沿用旧口径，应用自己播种过的条目会
 * 被误判成市场残留并触发「接管」手术（剥 bundles 条目 + 建保护快照）。
 */
export function marketDuplicateEvidence(o: {
  name: string;
  dependencySpec?: unknown;
  inBundles?: boolean;
  foreignPatchRows?: boolean;
  appSeededBundles?: Iterable<string>;
}): boolean {
  const spec = o.dependencySpec;
  if (spec && !String(spec).startsWith('link:') && !String(spec).startsWith('file:')) return true;
  if (o.inBundles === true) {
    const seeded = new Set(o.appSeededBundles ?? BUNDLED_BUILTIN_PLUGINS);
    if (!seeded.has(o.name)) return true;
  }
  return o.foreignPatchRows === true;
}

/** 内置插件当前生效的源目录：覆盖层（已更新版本）优先，资产版本回退。 */export function builtinPluginSourceDir(dirName: string): string {
  const assets = path.join(APP_ROOT, 'assets', 'plugins', dirName);
  const overlay = path.join(ctx.getUserDataDir(), 'builtin-plugin-updates', dirName);
  if (!fs.existsSync(path.join(overlay, 'package.json'))) return assets;
  if (!fs.existsSync(path.join(assets, 'package.json'))) return overlay;
  // 覆盖层版本 >= 资产版本才优先：应用自身升级后，新资产自动接管覆盖层。
  const vOverlay = pluginUpdater.versionOfDir(overlay);
  const vAssets = pluginUpdater.versionOfDir(assets);
  // 覆盖层版本不可读（半写坏档）时回退资产版本：否则损坏的旧覆盖层永久
  // 遮蔽新资产，该插件停在坏版本且每次启动被压住。
  if (!vOverlay) return assets;
  if (vAssets && updater.compareVersions(vOverlay, vAssets) < 0) return assets;
  return overlay;
}

// M2/#415：assets/skins/ 皮肤包目录播种已随旧版皮肤切换退役
// —— assets/skins 自 v6 起已不存在，皮肤平台自 EAC-CORE-SHELL-01 起是市场
// 可选包（按需安装即写 profile bundles），不再有资产目录播种。

import { COPY_STAMP, copyPluginPackage, readJsonFile } from '../plugin-copy.js';

export {
  COPY_STAMP,
  EXTRA_PACKAGE_FILES,
  pluginCopyEntries,
  pluginStampOf,
  pluginCopyIsComplete,
  copyPluginPackage,
  readJsonFile,
} from '../plugin-copy.js';

// pnpm（dsh plugin add / 插件市场）hoist 进 profile node_modules 的
// @deepseek-ai 核心包真实拷贝，会遮蔽 <home>/profiles/node_modules 里指向
// 随应用分发的安装闭包 junction，形成模块双实例：Symbol 身份不一致，
// 作用域注册失效（如 "deployment:persona is already registered"），
// 模型列表刷新、模式切换、工作区添加等全部瘫痪。启动时清掉这些
// 遮蔽拷贝，让解析回落到 junction —— 与宿主同源、全局单实例。
export function healProfileModules(): void {
  try {
    const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
    const removed = healProfileModuleShadowing(home, desktopProfile());
    if (removed.length) ctx.log('boot', '已清理 profile node_modules 中遮蔽安装闭包的包拷贝: ' + removed.join(', '));
  } catch (err) {
    ctx.log('boot', '清理 profile 模块遮蔽失败: ' + (err as Error).message);
  }
}

// M2/#415 迁移清理：旧链（AIO ≤ 9.6.3 的 assets/skins 目录播种）留在老
// profile 里的 10 款旧桌面皮肤 —— 包名 `@linxin666|@dsh-external/
// dsh-client-ui-skin-*`，patch 行 id 取皮肤包清单里声明的 wiring.id
//（`ui-skin-*`，insert 内层行）。旧链退役后这些行指向的包不再随包分发：
// 「行在包不在」让 loader 找不到 entry、「包在行不在」残留旧皮肤继续加载，
// 两者都会拖垮插件树。清理按**精确 id + 精确包名**逐条进行（不是作用域/前缀
// 级联删除）：`@linxin666` / `@dsh-external` 下市场安装的其他插件必须留存；
// 公约皮肤平台（包 `@dsh-eac/ui-skin-loader` + `@dsh-eac/skin-*`，行
// `dsh-ui-skin-loader` + `dsh-eac-skin-*`）自 EAC-CORE-SHELL-01 外迁为市场可选
// 包，与旧链一样只由下方 RETIRED 清单按精确条目兜底清理。
// （契约测试锚定本清单与 RETIRED_BUILTIN_PLUGINS 的并集，勿改前缀语义。）
export const LEGACY_UI_SKIN_RESIDUE: { id: string; name: string }[] = [
  { id: 'ui-skin-blue-fantasy', name: '@linxin666/dsh-client-ui-skin-blue-fantasy' },
  { id: 'ui-skin-dragon-heir', name: '@linxin666/dsh-client-ui-skin-dragon-heir' },
  { id: 'ui-skin-maid-atelier', name: '@dsh-external/dsh-client-ui-skin-maid-atelier' },
  { id: 'ui-skin-miku', name: '@linxin666/dsh-client-ui-skin-miku' },
  { id: 'ui-skin-minecraft', name: '@linxin666/dsh-client-ui-skin-minecraft' },
  { id: 'ui-skin-qq98', name: '@linxin666/dsh-client-ui-skin-qq98' },
  { id: 'ui-skin-ths', name: '@linxin666/dsh-client-ui-skin-ths' },
  { id: 'ui-skin-trading', name: '@linxin666/dsh-client-ui-skin-trading' },
  { id: 'ui-skin-whale-song', name: '@linxin666/dsh-client-ui-skin-whale-song' },
  { id: 'ui-skin-xp', name: '@linxin666/dsh-client-ui-skin-xp' },
];

// 曾内置、现已从内置清单移除的插件。老用户 profile 可能残留其 patch 行、
// node_modules 副本与 package.json 依赖：行在包被清会拖垮插件树，包在行在则
// 退役插件继续加载。旧市场还会与 dsh-unified-market 重复注册 /api/dsh-market，
// 使 dsh web 以 code=1 退出。启动时统一清理这些精确的历史内置条目。
// 旧链皮肤残留（LEGACY_UI_SKIN_RESIDUE）走同一套清理与同一道升级对齐门控：
// 清单内容变化会改指纹，升级后首次启动必然重跑一次迁移。
// （契约测试锚定字面量 `const RETIRED_BUILTIN_PLUGINS = [`，勿加内联注解。）
export const RETIRED_BUILTIN_PLUGINS = [
  { id: 'auto-compact', name: 'dsh-auto-compact' },
  { id: 'plugin-marketplace', name: '@deepseek-ai/dsh-plugin-marketplace' },
  { id: 'dsh-market-plugin', name: '@sanqi-normal/dsh-webui-market-plugin' },
  { id: 'zat-market', name: 'zat-dsh-engine' },
  // 5.1.1：按用户要求移除内置「第三方模型思考强度」插件
  //（reasoning_effort 控件）。老 profile 的 patch 行/包副本由退役清理兜底。
  { id: 'third-party-thinking', name: '@deepseek-ai/dsh-third-party-thinking' },
  // dsh-tool-vision 自 4.5.0 起被 picturereader 取代但从未列入退役清单：
  // 老 profile 残留的行+包副本会在设置页注册一张「视觉模型」卡，其
  // settings 命名空间在新内核上失效，点开即空白页。
  { id: 'tool-vision', name: 'dsh-tool-vision' },
  // 按用户要求移除「普通/高级」分栏（nav-custom 是该分栏唯一写入者，
  // 见 test/settings-groups-standdown.test.ts 的单写者契约改判）。
  { id: 'settings-nav-custom', name: 'dsh-settings-nav-custom' },
  // 旧 dsh-file-drop 会同时接管普通文件和图片拖放，与 EAC 特化版并存时
  // 会重复注入内容并让官方图片遮罩停留。由 file-drop-eac 完整取代。
  { id: 'file-drop', name: 'dsh-file-drop' },
  // M2/#415：旧版用户可见皮肤切换（设置页「皮肤」tab，host 半边以
  // Typert Remote 改写 cordis.patch.yml 的 ui-skin-* 激活行）随换肤职责
  // 移交 ui-skin-loader 公约皮肤包而退役。老 profile 残留的 patch 行/
  // 包副本由退役清理兜底，避免「行在包被清」拖垮插件树。壳层 ui-skin
  // manager 的 boot/recovery 回退资源不受影响（ADR 0010）。
  { id: 'skin-switch', name: '@deepseek-ai/dsh-skin-switch' },
  // M2/#415：旧链播种的 10 款 `ui-skin-*` 皮肤残留（见上方迁移清单）。
  ...LEGACY_UI_SKIN_RESIDUE,
  // EAC-CORE-SHELL-01：M2/#415 曾随包预装的皮肤平台（loader + 13 款公约
  // 皮肤）已外迁为市场可选包。老 profile 残留的 bundles 成员 / patch 行 /
  // 包副本由本清单兜底清理，避免「行在包被清」或 bundles 成员指空拖垮
  // 插件树。皮肤改由 Market Core 安装（安装即写 profile bundles）。
  { id: 'dsh-ui-skin-loader', name: '@dsh-eac/ui-skin-loader' },
  { id: 'dsh-eac-skin-aurora', name: '@dsh-eac/skin-aurora' },
  { id: 'dsh-eac-skin-blue-fantasy', name: '@dsh-eac/skin-blue-fantasy' },
  { id: 'dsh-eac-skin-deep-whale-day-night', name: '@dsh-eac/skin-deep-whale-day-night' },
  { id: 'dsh-eac-skin-dragon-heir', name: '@dsh-eac/skin-dragon-heir' },
  { id: 'dsh-eac-skin-inkwash', name: '@dsh-eac/skin-inkwash' },
  { id: 'dsh-eac-skin-maid-atelier', name: '@dsh-eac/skin-maid-atelier' },
  { id: 'dsh-eac-skin-miku', name: '@dsh-eac/skin-miku' },
  { id: 'dsh-eac-skin-minecraft', name: '@dsh-eac/skin-minecraft' },
  { id: 'dsh-eac-skin-qq98', name: '@dsh-eac/skin-qq98' },
  { id: 'dsh-eac-skin-ths', name: '@dsh-eac/skin-ths' },
  { id: 'dsh-eac-skin-trading', name: '@dsh-eac/skin-trading' },
  { id: 'dsh-eac-skin-whale-song', name: '@dsh-eac/skin-whale-song' },
  { id: 'dsh-eac-skin-xp', name: '@dsh-eac/skin-xp' },
  // EAC-CORE-SHELL-01：3 个与内核同名/官方已内置的插件退役。
  //  - plugin-manager / terminal 与内核 0.2.0 同名，会遮蔽官方包
  //    （terminal 的官方版提供 ctx.terminals，EAC 版不提供）；
  //  - file-drop-eac 的拖放 → @path 能力官方已内置。
  { id: 'plugin-manager', name: '@deepseek-ai/dsh-plugin-manager' },
  { id: 'terminal', name: '@deepseek-ai/dsh-terminal' },
  { id: 'file-drop-eac', name: 'dsh-file-drop-eac' },
  // ISO-003：VNext Core Bridge 退役 —— 端点生产者缺失（DSH_EAC_BRIDGE_URL/
  // TOKEN 全仓零写入方，lib/desktop/proc.ts 的 childEnv() 不注入），该插件
  // 随包且默认启用却只静默空转；ADR 0003 已随 ADR 0006 裁废，进程隔离接回
  // 前不再随包/默认启用。老 profile 的行/包副本/依赖项由本清单兜底清理；
  // 资产目录保留在 assets/plugins/dsh-eac-core-bridge 等接回。
  { id: 'eac-core-bridge', name: 'dsh-eac-core-bridge' },
  // —— ISO-005：运行时清单收敛（44 → 9）后不再随包、也不再登记的 35 项 ——
  // 依据：ADR 0006 最简本体（v6 Task 3.1 剥出 assets/plugins 全量资产），
  // ISO-005 以装配面 stage-resources.mjs 的 BUILTIN_PLUGIN_DIRS（9 项）为唯一
  // 基准收敛运行时清单；这 35 项改由市场按需安装（.sync/plugin-distribution.json：
  // 15 recommended + 20 external），但老 profile（≤5.4.1 曾全部随包）里的
  // patch 行 / node_modules 包副本 / package.json 依赖仍指向已不在包体的包 ——
  // 「行在包不在」会让 loader 找不到 entry 拖垮插件树，也会与市场安装的推荐版
  // 撞成 duplicate loader entry id。这里逐条按**精确 id + 精确包名**兜底清理
  //（不做作用域/前缀级联删除，市场安装的同作用域其他插件必须留存）：id 是
  // patch 行 id，name 是 node_modules 目录名与依赖键（与 COMPANION_PLUGINS
  // 收敛前的登记值一致，已与 assets/SOURCES.json 的台账包名逐条核对）。
  // 分发分级：15 项 official recommended（官方推荐包成员，市场按需安装）。
  { id: 'balance', name: '@deepseek-ai/dsh-balance' },
  { id: 'better-sidebar', name: 'dsh-better-sidebar' },
  { id: 'change-review', name: 'dsh-change-review' },
  { id: 'composer-dynamic-island', name: 'dsh-composer-dynamic-island' },
  { id: 'conversation-tweaks', name: '@deepseek-ai/dsh-conversation-tweaks' },
  { id: 'dock-settings', name: 'dsh-dock-settings' },
  { id: 'dsh-navbar', name: '@vlln/dsh-navbar' },
  { id: 'dsh-raw-html', name: 'dsh-raw-html' },
  { id: 'dsh-session-manager', name: 'dsh-session-manager' },
  { id: 'message-rewind', name: 'dsh-message-rewind' },
  { id: 'mobile-fix', name: 'dsh-web-mobile-fix' },
  { id: 'offpeak', name: 'dsh-offpeak' },
  { id: 'picturereader', name: 'picturereader' },
  { id: 'prompt-custom', name: '@deepseek-ai/dsh-prompt-custom' },
  { id: 'soul-md', name: 'dsh-soul-md' },
  // 分发分级：20 项 external（第三方/社区，市场或独立包按需安装）。
  { id: 'agent-teams', name: '@nanmicoder/dsh-agent-teams' },
  { id: 'computer-user', name: 'computer-user' },
  { id: 'dsh-dafeiyu', name: 'dsh-dafeiyu' },
  { id: 'dsh-feature-toggles', name: 'dsh-feature-toggles' },
  { id: 'dsh-pet', name: 'dsh-pet' },
  { id: 'dsh-pet-settings', name: 'dsh-pet-settings' },
  { id: 'dsh-phone', name: 'dsh-phone' },
  { id: 'dsh-stt', name: '@deepseek-ai/dsh-stt' },
  { id: 'dsh-undo', name: 'dsh-undo-savepoint' },
  { id: 'dsh-webui-prompt-optimizer', name: 'dsh-webui-prompt-optimizer' },
  { id: 'dsh-whale-widget', name: 'dsh-whale-widget' },
  { id: 'float-window', name: '@deepseek-ai/dsh-float-window' },
  { id: 'font-custom', name: 'dsh-font-custom' },
  { id: 'image-paste', name: 'dsh-image-paste' },
  { id: 'meow-smooth', name: 'meow-smooth' },
  { id: 'openclaw-bridge', name: '@deepseek-ai/dsh-openclaw-bridge' },
  { id: 'plugin-wizard', name: 'dsh-plugin-wizard' },
  { id: 'settings-groups', name: 'dsh-settings-groups' },
  { id: 'side-session', name: '@dsh-external/dsh-side-session' },
  { id: 'think-zh-expand-eac', name: 'dsh-think-zh-expand-eac' },
];

// A package name alone is not provenance: users may reinstall retired plugins
// from the community. Only an intact EAC copy stamp authorizes this migration.
function managedRetiredCopy(profileDirP: string, name: string, dependency: unknown): string | null {
  if (typeof dependency === 'string' && /^(?:file|link|workspace):/i.test(dependency)) return null;
  const modules = path.join(profileDirP, 'node_modules');
  const directory = path.join(modules, ...name.split('/'));
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const expected = path.join(fs.realpathSync(modules), ...name.split('/'));
  if (fs.realpathSync(directory).toLowerCase() !== expected.toLowerCase()) return null;
  let rawStamp: string;
  try { rawStamp = fs.readFileSync(path.join(directory, COPY_STAMP), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let stamp: Record<string, unknown>;
  try { stamp = JSON.parse(rawStamp); } catch { return null; }
  if (!stamp || typeof stamp.v !== 'string' || !Number.isSafeInteger(stamp.f)
    || (stamp.f as number) < 1 || !Number.isSafeInteger(stamp.b) || (stamp.b as number) < 0) return null;
  // A partially removed managed package may already have lost package.json.
  // Retaining the stamp until last makes that interrupted cleanup retryable.
  let manifest: Record<string, unknown> | null = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }
  if (manifest && (manifest.name !== name || String(manifest.version ?? '') !== stamp.v)) return null;
  return rawStamp;
}

function retiredPatchRows(value: unknown, id: string): Array<{ name?: unknown }> {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('用户补丁必须是列表');
  return value.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    return [row, ...(Array.isArray(row.insert) ? row.insert : [])]
      .filter((entry) => entry && typeof entry === 'object' && entry.id === id);
  });
}

/** Only loader operations and their insert lists own IDs; nested config is user data. */
function removeRetiredPatchRows(text: string, id: string): string {
  const doc: Document = parseDocument(text, {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
  });
  if (!doc.contents && !doc.errors.length) return text;
  if (doc.errors.length || !isSeq(doc.contents)) throw new Error('用户补丁 YAML 无法解析');
  let changed = false;
  doc.contents.items = doc.contents.items.filter((item) => {
    if (!isMap(item)) return true;
    const omit = (): false => {
      if (item.commentBefore) doc.commentBefore = [doc.commentBefore, item.commentBefore].filter(Boolean).join('\n');
      changed = true;
      return false;
    };
    if (item.get('id') === id) return omit();
    const insert = item.get('insert');
    if (isSeq(insert)) {
      insert.items = insert.items.filter((entry) => {
        if (isMap(entry) && entry.get('id') === id) { changed = true; return false; }
        return true;
      });
      if (insert.items.length === 0 && item.items.length === 1) return omit();
    }
    return true;
  });
  return changed ? doc.toString() : text;
}

function removeManagedRetiredCopy(directory: string, rawStamp: string): void {
  // Do not let recursive removal erase our ownership proof before a locked file
  // fails. Every child path comes from this verified package directory.
  for (const entry of fs.readdirSync(directory)) {
    if (entry !== COPY_STAMP) fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
  fs.unlinkSync(path.join(directory, COPY_STAMP));
  try { fs.rmdirSync(directory); }
  catch (error) {
    try { fs.writeFileSync(path.join(directory, COPY_STAMP), rawStamp); } catch { /* retain original failure */ }
    throw error;
  }
}

function retireRemovedBuiltinPlugins(profileDirP: string): boolean {
  const patchFile = path.join(profileDirP, 'cordis.patch.yml');
  const packageFile = path.join(profileDirP, 'package.json');
  let complete = true;
  for (const plugin of RETIRED_BUILTIN_PLUGINS) {
    try {
      let pkg: Record<string, any> = {};
      try { pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const rawStamp = managedRetiredCopy(profileDirP, plugin.name, pkg.dependencies?.[plugin.name]);
      if (rawStamp === null) continue;
      let text: string | null = null;
      try { text = fs.readFileSync(patchFile, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (text !== null) {
        const rows = retiredPatchRows(parsePatchData(text), plugin.id);
        // A same-id entry naming a different package belongs to the user.
        if (rows.some((row) => typeof row.name === 'string' && row.name !== plugin.name)) continue;
        const patched = removeRetiredPatchRows(text, plugin.id);
        if (retiredPatchRows(parsePatchData(patched), plugin.id).length > 0) {
          throw new Error(`无法安全移除退役插件行 ${plugin.id}`);
        }
        if (patched !== text) writeFileAtomic(patchFile, patched);
      }
      let changed = false;
      if (pkg.dependencies && Object.hasOwn(pkg.dependencies, plugin.name)) {
        delete pkg.dependencies[plugin.name];
        changed = true;
      }
      const bundles = pkg?.dsh?.profile?.bundles;
      if (Array.isArray(bundles)) {
        const next = bundles.filter((entry: unknown) => entry !== plugin.name);
        if (next.length !== bundles.length) {
          pkg.dsh.profile.bundles = next;
          changed = true;
        }
      }
      if (changed) writeFileAtomic(packageFile, JSON.stringify(pkg, null, 2) + '\n');
      removeManagedRetiredCopy(path.join(profileDirP, 'node_modules', ...plugin.name.split('/')), rawStamp);
      ctx.log('boot', `已清理受管退役插件 ${plugin.id}`);
    } catch (error) {
      complete = false;
      ctx.log('boot', `清理退役插件 ${plugin.id} 未完成，下次启动重试: ${String((error as Error).message || error)}`);
    }
  }
  return complete;
}

// 安全模式守卫：<home>/guard/safe-mode.json active 时，配套插件的 patch 行
// 追加必须停摆——否则「安全模式重启」后 sync 会把全部插件行写回 patch，
// 下一次服务重启时安全模式被静默击穿（快照恢复前用户始终处于假安全模式）。
// 插件包文件拷贝不受影响（加载由 patch 行驱动，拷贝只是让文件就位）。
function safeModeActive(): boolean {
  try {
    const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
    const st = JSON.parse(fs.readFileSync(path.join(home, 'guard', 'safe-mode.json'), 'utf8')) as { active?: boolean };
    return st?.active === true;
  } catch {
    return false;
  }
}

// 退役清理的「升级对齐门控」（issue #74）：删除性手术只在「应用版本变化」
// 或「退役清单本身变化」（新增退役目标）后的首次启动执行一次 —— 升级时清掉
// 上一版本退役插件残留，同一版本内用户手动恢复/调整的插件树（管理页开关、
// 市场安装的同类包）不再被每次启动强制改写。settings 键 pluginTreeAlignedVersion
// 记录已对齐的应用版本，pluginTreeRetiredListHash 记录已对齐的清单内容：
// 只比对版本会让同版本内新列入的退役条目永远清不到（5.1.0 实测踩坑）。
function retiredListHash(): string {
  return crypto.createHash('sha256').update(JSON.stringify({ policy: 'managed-copy-v2', plugins: RETIRED_BUILTIN_PLUGINS })).digest('hex');
}
export function retireRemovedBuiltinPluginsGated(profileDirP: string): void {
  let version = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version?: string };
    version = typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    // 读不到版本时退回无条件清理（旧语义）。
  }
  if (!version) {
    retireRemovedBuiltinPlugins(profileDirP);
    return;
  }
  try {
    const c = updCtx();
    const settings = updater.loadSettings(c) as Record<string, unknown>;
    const hash = retiredListHash();
    if (settings && settings.pluginTreeAlignedVersion === version && settings.pluginTreeRetiredListHash === hash) {
      ctx.log('boot', `已在本版本（${version}）对齐过内置插件树，跳过退役清理（用户调整优先）`);
      return;
    }
    if (!retireRemovedBuiltinPlugins(profileDirP)) return;
    const next = settings && typeof settings === 'object'
      ? { ...settings, pluginTreeAlignedVersion: version, pluginTreeRetiredListHash: hash }
      : { pluginTreeAlignedVersion: version, pluginTreeRetiredListHash: hash };
    // saveSettings swallows write errors; the migration must observe durability.
    writeFileAtomic(path.join(c.userDataDir, 'settings.json'), JSON.stringify(next, null, 2) + '\n');
    ctx.log('boot', `已在本版本（${version}）完成内置插件树对齐`);
  } catch (err) {
    ctx.log('boot', '插件树对齐未完成，下次启动重试: ' + String(err));
  }
}

export function syncCompanionPlugins(): void {
  const platform = ctx.platform ?? 'win32';
  const inSafeMode = safeModeActive();
  if (inSafeMode) ctx.log('boot', '安全模式激活中：跳过配套插件 patch 行同步（退出安全模式后恢复）');
  // 安装形态（v5.4 单发行版双形态）：精简版只改「新行」默认启停，
  // 已有注册行不重写、用户选择优先（见 lib/desktop/install-profile.ts）。
  const installProfile = readInstallProfile(APP_ROOT);
  if (installProfile === 'lite') ctx.log('boot', '安装形态 = 精简版：随包插件均为核心集（默认启用），无默认停用项（设置 → 插件 → 管理 可自行启停）');
  try {
    const home = ctx.getDshHome() || path.join(os.homedir(), '.dsh');
    // 桌面专属 profile 必须先存在（未知 profile 不会被 dsh 自动初始化）。
    ensureDesktopProfileInit();
    // 清理已退役内置插件在 profile 的残留，避免
    // 「行在包被清」拖垮插件树或退役插件继续加载。
    retireRemovedBuiltinPluginsGated(desktopProfileDir());
    // V4 运行时补丁（幂等，随启动 / 服务重启 / agent 更新后重放）：
    //  · 对话删除/归档 —— dsh-session-manager 插件的全链路前置依赖；
    applySessionManageFix();
    const profileDirP = desktopProfileDir();
    // 内置社区 agent preset（anchored-standard：首请求锚定 Minimal 工具对，
    // 首次工具调用/回复后开放完整 Standard 目录）：安装到用户 preset 根。
    // preset 不进插件树，坏 preset 不会拖垮启动；已存在则跳过（用户手装
    // 或改过的版本优先），见 preset-sync.js。
    if (platform === 'win32') {
      const bundledPresetsDir = path.join(APP_ROOT, 'assets', 'agent-presets');
      const installedPresetsDir = path.join(home, '.agent-presets');
      const presetsSynced = syncBundledPresets(
        bundledPresetsDir,
        installedPresetsDir,
        (m) => ctx.log('boot', m)
      );
      if (presetsSynced.installed.length) ctx.log('boot', '已安装内置 agent preset: ' + presetsSynced.installed.join(', '));
      const compactPresetResults = migrateManagedCompactPresets(
        installedPresetsDir,
        (m) => ctx.log('boot', m)
      );
      const compactPresetMigrated = compactPresetResults
        .filter((result) => result.status === 'migrated')
        .map((result) => path.basename(path.dirname(result.file)));
      if (compactPresetMigrated.length) {
        ctx.log('boot', '已将内置 agent preset 迁移到 dsh-compact: ' + compactPresetMigrated.join(', '));
      }
      const routerPersonaResults = migrateManagedRouterPersonaPresets(
        bundledPresetsDir,
        installedPresetsDir,
        (m) => ctx.log('boot', m)
      );
      const routerPersonaMigrated = routerPersonaResults
        .filter((result) => result.status === 'migrated')
        .map((result) => path.basename(path.dirname(result.file)));
      if (routerPersonaMigrated.length) {
        ctx.log('boot', '已修复内置 Router preset 的人设卡组合: ' + routerPersonaMigrated.join(', '));
      }
      // 默认 preset 指到内置的 anchored-standard（用户已在 settings.yaml 写过
      // default 则一律保留）。失败只降级为官方默认 preset，不影响启动。
      const defaultResult = ensureDefaultAgentPreset(home, 'anchored-standard', (m) => ctx.log('boot', m));
      if (defaultResult === 'set') ctx.log('boot', '已设置默认 agent preset: anchored-standard');
      else if (defaultResult === 'kept') ctx.log('boot', '用户已设置默认 agent preset，保持不变');
    } else {
      ctx.log('boot', 'Linux 使用上游默认 agent preset；未同步 Windows PowerShell/Git Bash 调优 preset');
    }
    fs.mkdirSync(path.join(profileDirP, 'node_modules'), { recursive: true });
    const pending: PendingRow[] = [];
    const removedIds = removedPluginIds();
    // 市场残留预检的共享输入（循环外读一次）：9 个随包配套插件逐个 dupPreCheck
    // 会把 profile package.json 与 cordis.patch.yml 各重读一遍（~68 次读）。
    // 迁移手术本身会改写这两个文件 —— 手术后的插件重读一次（按需失效）。
    let precheckPkg = readJsonFile(path.join(profileDirP, 'package.json'));
    let precheckPatch = '';
    try { precheckPatch = fs.readFileSync(path.join(profileDirP, 'cordis.patch.yml'), 'utf8'); } catch { /* 缺省空 */ }
    // V4.2：用户曾从市场安装过与内置插件同名的包时，写包前先迁移残留
    // （package.json 依赖/bundles + patch 行），让内置版干净接管，避免
    // duplicate loader entry；完成后系统通知告知「插件树变化」。
    const migratedBuiltins: { name: string; dep: boolean; rows: number }[] = [];
    for (const p of companionPluginsForPlatform(platform)) {
      // V4.2：用户移除过的内置插件不再复制/登记（见 pluginManagerSetRemoved）。
      if (removedIds.has(p.id)) {
        ctx.log('boot', `已按用户选择跳过被移除的内置插件: ${p.id}`);
        continue;
      }
      // 非 @deepseek-ai 作用域的配套包用显式 dir 指定 assets/plugins 下的目录名；
      // 回退解析按「最后一个路径段」取（@scope/name → name；无 scope → 原名）。
      // V4 修复：旧回退是 name.slice('@deepseek-ai/'.length) —— 对无 scope 的
      // 长包名会截出错误目录（dsh-session-manager → 'manager'），该插件被
      // 静默跳过（行与包都不落盘）。
      const dirName = p.dir || (p.name.includes('/') ? p.name.split('/').pop() as string : p.name);
      // V4.3：覆盖层优先 —— 用户更新过的内置插件从 <userData>/builtin-plugin-updates
      // 拷贝（不被资产版本还原）；应用升级后资产版本更新则自动接管。
      const src = builtinPluginSourceDir(dirName);
      if (!fs.existsSync(path.join(src, 'package.json'))) {
        ctx.log('boot', `配套插件源目录无效，跳过: ${p.id} → ${src}`);
        continue;
      }
      try {
        const { removeMarketDuplicate, patchHasForeignRows } = require('../../builtin-collision') as {
          removeMarketDuplicate(profileDir: string, name: string, o: { log(m: string): void }): { changed: boolean; ok: boolean; removedDep: unknown[]; removedRows: unknown[] };
          patchHasForeignRows(patchText: string, name: string): boolean;
        };
        // 市场同名包残留预检（v4.2，用户反馈问题 5）：只有「非应用自写」证据
        // （package.json 依赖/bundles 或非自写 patch 行）才算残留。共享输入
        // 来自循环外的单次读取；迁移手术后两个文件都变了，重读一次。
        const dupPreCheck = (() => {
          try {
            const deps = precheckPkg && (precheckPkg.dependencies as Record<string, unknown> | undefined);
            const dsh = precheckPkg && (precheckPkg.dsh as Record<string, unknown> | undefined);
            const prof = dsh && (dsh.profile as Record<string, unknown> | undefined);
            const inBundles = !!(prof && Array.isArray(prof.bundles)
              && (prof.bundles as string[]).includes(p.name));
            return marketDuplicateEvidence({
              name: p.name,
              dependencySpec: deps ? deps[p.name] : undefined,
              inBundles,
              // 只认「非应用自写」的登记行：sync 的 insert 内层行、插件管理/向导
              // togglePluginInPatch 写的（带「关闭」标记注释的）顶层行都是应用自己
              // 的启停状态，不是市场残留。否则 v4.4 首次向导的取消勾选会在同一启动
              // 里被剥离后按注册表默认回写（dsh-dafeiyu 等默认启用插件被静默重新
              // 启用），且每次启动产生「剥离-回写」空转与孤儿 `- insert:` 行堆积。
              foreignPatchRows: patchHasForeignRows(precheckPatch, p.name),
            });
          } catch { return false; }
        })();
        if (dupPreCheck) {
          // 先快照（保护中心）：迁移属于配置面手术，出问题可一键回滚。
          ensureGuard().snapshot('builtin-migrate:' + p.id);
          // 只在确有市场残留证据时才动手术。v4.2 曾无条件执行迁移 —— 它的
          // 「剥离-回写」对无重复用户是空转，且会把应用自写的行（向导/插件
          // 管理的 disabled 行、sync 自己的 insert 行）一并剥掉后按注册表
          // 默认回写：v4.4 首次向导的取消勾选被静默重新启用，孤儿 insert
          // 行每次启动堆积。
          const migrated = removeMarketDuplicate(profileDirP, p.name, { log: (m) => ctx.log('boot', m) });
          if (migrated.changed && migrated.ok) {
            migratedBuiltins.push({ name: p.name, dep: migrated.removedDep.length > 0, rows: migrated.removedRows.length });
            ctx.log('boot', `内置插件 ${p.name} 已接管市场同名包（移除依赖 ${migrated.removedDep.length} 个、patch 行 ${migrated.removedRows.length} 个）`);
            // 迁移改写了两个文件：后续插件的预检必须看到新内容。
            precheckPkg = readJsonFile(path.join(profileDirP, 'package.json'));
            try { precheckPatch = fs.readFileSync(path.join(profileDirP, 'cordis.patch.yml'), 'utf8'); } catch { precheckPatch = ''; }
          }
        }
      } catch (err) {
        ctx.log('boot', `内置插件同名迁移失败(${p.id}): ${String(((err as Error).message) || err)}`);
      }
      copyPluginPackage(profileDirP, src, p.name);
      // p.disabled: true 的配套插件默认以禁用行注册（如 dsh-pet 页面桌宠），
      // 用户可在「设置 → 插件 → 管理」里启用；已有行不重写，用户选择优先。
      // 精简版：LITE_DEFAULT_DISABLED 命中的配套插件同样默认以禁用行注册。
      pending.push({ id: p.id, name: p.name, disabled: p.disabled === true || isLiteDisabled(p.id, installProfile), config: p.config });
    }
    if (migratedBuiltins.length) {
      try {
        const names = migratedBuiltins.map((m) => m.name).join('、');
        ctx.notify({
          title: '内置插件已接管同名市场包',
          body: `检测到市场安装的重复包，已改用内置版本（${names}）。插件树已自动整理，本次启动生效。`,
          icon: path.join(APP_ROOT, 'assets', 'icon.png'),
          onClick: () => ctx.showMainWindow(),
        });
      } catch (err) {
        ctx.log('boot', '内置接管通知发送失败: ' + (err as Error).message);
      }
    }
    // M2/#415：旧版「assets/skins 目录 → profile 皮肤行」播种已退役。
    // 皮肤平台自 EAC-CORE-SHELL-01 外迁为市场可选包（按需安装，安装即写
    // profile bundles）；无皮肤激活 = 宿主原生观感。
    // 内置插件清单标记：插件市场据此把目录里的同名插件标为「已内置」并
    // 拒绝重复安装 —— 内置包每次启动都被重新同步，市场覆盖安装会产生
    // duplicate loader entry / 模块双实例，必须从源头拦截。
    try {
      const builtinNames = pending.map((p) => p.name);
      const marker = path.join(profileDirP, '.dsh-builtin-plugins.json');
      const prev = readJsonFile(marker);
      const next = { names: builtinNames, updatedAt: new Date().toISOString() };
      if (!prev || JSON.stringify(prev.names) !== JSON.stringify(next.names)) {
        writeFileAtomic(marker, JSON.stringify(next, null, 2) + '\n');
      }
    } catch (err) {
      ctx.log('boot', '写入内置插件清单失败: ' + (err as Error).message);
    }
    ensurePluginHostDeps(profileDirP);
    // 配套插件的宿主依赖兜底（真实目录，非链接）。rc.2 起 dsh-app-boot 首启会
// 重建 <home>/profiles/node_modules 共享层：dev 时代指向宿主工程的符号链接
// 与历史手工副本会被清掉，而 web-app 闭包不传递依赖 schemastery ——
// better-sidebar / dsh-side-session 等 require 它会 ERR_MODULE_NOT_FOUND
// 拖垮整个插件树（dsh web 退出码 1，「DSH 服务已停止」）。共享层归内核管
// 理随时可能重建；插件层 <profile>/node_modules 不会被重建，在这里落真实
// 副本（版本戳幂等，升级版本变化才重拷）。
function ensurePluginHostDeps(profileDirP: string): void {
  const copied = new Set<string>();
  const ensureCopy = (rel: string, depth: number): void => {
    if (depth > 4 || copied.has(rel)) return;
    const src = path.join(APP_ROOT, 'node_modules', rel);
    const srcPj = path.join(src, 'package.json');
    const srcPkg = readJsonFile(srcPj);
    const version = srcPkg && typeof srcPkg.version === 'string' ? srcPkg.version : '';
    if (!version) return;
    copied.add(rel);
    const dest = path.join(profileDirP, 'node_modules', rel);
    const stamp = path.join(dest, '.eac-host-dep.json');
    const prev = readJsonFile(stamp);
    const fresh = prev && prev.version === version && fs.existsSync(path.join(dest, 'package.json'));
    if (!fresh) {
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(src, dest, { recursive: true });
        fs.writeFileSync(stamp, JSON.stringify({ version, at: new Date().toISOString() }, null, 2) + '\n');
        ctx.log('boot', `已落位插件宿主依赖 ${rel}@${version}（真实目录，重建免疫）`);
      } catch (err) {
        ctx.log('boot', `宿主依赖落位失败 ${rel}: ` + String(((err as Error).message) || err));
        return;
      }
    }
    // 递归落位该包的 dependencies（应用树已提升的同名包；共享层若另有供应，
    // 插件层的副本同版本族不冲突，以插件树自洽优先）。
    const deps = (srcPkg && srcPkg.dependencies) as Record<string, string> | undefined;
    if (deps && typeof deps === 'object') {
      for (const dep of Object.keys(deps)) {
        if (fs.existsSync(path.join(APP_ROOT, 'node_modules', dep, 'package.json'))) {
          ensureCopy(dep, depth + 1);
        }
      }
    }
  };
  ensureCopy('schemastery', 0);
  // web-push（meow-smooth 通知 host 半边的运行时依赖；动态 import，缺省时
  // 该插件优雅降级为仅页面内提醒 —— 这里落位让系统推送开箱即用）。
  ensureCopy('web-push', 0);
  // cosmokit 只在共享层没有时兜底（避免遮蔽内核闭包内的配套版本）。
  const sharedRoot = path.join(ctx.getDshHome() || path.join(os.homedir(), '.dsh'), 'profiles', 'node_modules');
  const sharedCosmo = path.join(sharedRoot, '@deepseek-ai', 'cosmokit');
  if (!fs.existsSync(sharedCosmo)) {
    ensureCopy(path.join('@deepseek-ai', 'cosmokit'), 0);
  }
  // 与 cosmokit 同策：共享层已有就不落位，避免遮蔽内核闭包内的配套版本；
  // 全新隔离 home（共享层尚未由内核重建）时兜底落位 —— 下游是声明
  // schemastery 依赖的插件（scoped 与裸名两种，见冲突审计）。
  const sharedSchemastery = path.join(sharedRoot, '@deepseek-ai', 'schemastery');
  if (!fs.existsSync(sharedSchemastery)) {
    ensureCopy(path.join('@deepseek-ai', 'schemastery'), 0);
  }
}

// 注册到 profile 的 patch 层（幂等：已有行不重写，用户选择的皮肤/disabled 状态保留）。
    const patchFile = path.join(profileDirP, 'cordis.patch.yml');
    let patch = '';
    try { patch = fs.readFileSync(patchFile, 'utf8'); } catch { patch = ''; }
    let changed = false;
    // 先修存量坏行：v2.0.0 写入的 soul-md 行缺 config.path（见 patch-row-heal.js
    // 头注释），不修则升级用户仍会 “dsh web 启动失败 (退出码 1)”。
    const healed = healSoulMdPatchRow(patch);
    if (healed.healed.length) {
      patch = healed.patch;
      changed = true;
      ctx.log('boot', '已修复 profile patch 中缺 config.path 的 soul-md 行');
    }
    // V4：修复 v3.1.0 及以前写出的「无 config 的 dsh-pet 行」（loader 传
    // undefined → dsh-pet 读 config.fullRoot 崩 → 插件树整体加载失败）。
    const healedPet = healRowConfig(patch, 'dsh-pet', { size: 260, position: 'bottom-right' });
    if (healedPet.healed.length) {
      patch = healedPet.patch;
      changed = true;
      ctx.log('boot', '已修复 profile patch 中缺 config 的 dsh-pet 行（v3 存量坏行）');
    }
    // 内核 0.1.2 隐私开关：官方 deepseek 适配器随请求上报活动插件包名/版本
    // （plugin-package-inventory-deepseek，默认 enabled: true）。桌面端默认
    // 关闭。该行在 dsh-base bundle 层已存在（overlay 不能再 insert —— 会
    // duplicate loader entry id 拖垮插件树），config 覆盖必须在 bundle 装载
    // 前由 --patch overlay 语义达成：本函数写「编辑型」覆盖行（- id + config，
    // 不在 - insert 列表内 = 对既有行改 config，cordis.patch 的标准编辑语义）。
    // 幂等：已有编辑行则跳过。
    // 幂等按 entry id 判定：可手工编辑的 YAML 用精确正则判「已存在」，
    // 用户重排引号/注释/缩进即失配 → 追加第二条同 id 编辑行（cordis 行为
    // 未定义）。hasEntryId 与本文件其余 patch 行逻辑同一判定。
    if (!hasEntryId(patch, 'plugin-package-inventory-deepseek')) {
      const privacyRow = '- id: plugin-package-inventory-deepseek\n  name: \'@deepseek-ai/dsh-plugin-package-inventory-deepseek\'\n  config:\n    enabled: false\n';
      patch = patch.replace(/\s*$/, '\n') + privacyRow;
      changed = true;
      ctx.log('boot', '已默认关闭内核插件名单上报（0.1.2 隐私开关，编辑型覆盖行）');
    }
    // 市场安装（dsh plugin add）会把插件登记进 package.json 的
    // dsh.profile.bundles，加载时执行其包内 patch 挂载行；若 overlay 里
    // 也有一行（syncCompanionPlugins 写的），整个插件树会以
    // “duplicate loader entry id” 崩溃。清掉 overlay 重复行（包内行保留）。
    let bundled: unknown[] = [];
    // 内置 bundle 插件播种（DESKTOP_PROFILE_BUNDLES 只影响全新 profile，存量
    // profile 的 bundles 在这里幂等补齐）：缺失则追加，已有（用户市场安装 /
    // dsh plugin add / 曾经播种过）则不动；仅在有变化时写回。纯函数
    // seedBundledPlugins 见本文件（可单测）。
    try {
      const seeded = seedBundledPlugins(profileDirP);
      bundled = seeded.bundles;
      if (seeded.changed) {
        ctx.log('boot', '已播种内置 bundle 插件到 profile: ' + BUNDLED_BUILTIN_PLUGINS.join(', '));
      }
    } catch (err) {
      bundled = [];
      ctx.log('boot', '播种内置 bundle 插件失败: ' + String(((err as Error).message) || err));
    }
    // 同一 entry id 被两处声明（bundle 的包内 patch + overlay 的配套行）会以
    // “duplicate loader entry id” 拖垮整个插件树。旧逻辑只按「包名 ∈ bundles」
    // 匹配，git/fork/link 安装的插件包名与配套行包名不符时永远删不掉（issue
    // #16）。这里再解析每个 bundle 包实际声明的 entry id 集合：overlay 中 id
    // 已被任一 bundle 声明（无论包名如何）即视为重复。
    const declaredBundleIds = collectBundleEntryIds(bundled, path.join(profileDirP, 'node_modules'));
    const rowIds: Record<string, string> = {};
    for (const p of COMPANION_PLUGINS) rowIds[p.id] = p.name;
    const deduped = removeBundledRowDuplicates(patch, rowIds, bundled, declaredBundleIds);
    if (deduped.removed.length) {
      patch = deduped.patch;
      changed = true;
      ctx.log('boot', '已移除与 bundle 登记重复的 patch 行: ' + deduped.removed.join(', '));
    }
    // 安全模式下不回写配套行（见 safeModeActive 注释）；退役清理与去重照常。
    for (const p of inSafeMode ? [] : pending) {
      if (hasEntryId(patch, p.id)) continue;
      // 已在 bundle 列表里的插件由其包内 patch 挂载，overlay 不能再写行
      // （会 duplicate loader entry id，拖垮整个插件树）。issue #16：
      // 补充按 entry id 判断 —— git/fork 插件包名不同但 id 相同同样要跳过，
      // 否则每次启动把崩溃行写回，用户删掉也没用。
      if (bundled.includes(p.name) || declaredBundleIds.has(p.id)) continue;
      let block = `- insert:\n    - id: ${p.id}\n      name: '${p.name}'\n`;
      if (p.config) block += configLinesFor(p.config);
      if (p.disabled) block += `      disabled: true\n`;
      // 替换锚定与检测一致：裸 /\[\]/m 会命中更早位置的内联 []
      //（如 config 行的 key: []），把块插错位置造成 YAML 损坏。
      if (/^\s*\[\]\s*$/m.test(patch)) patch = patch.replace(/^\s*\[\]\s*$/m, block);
      else if (patch.trim() === '') patch = '# dsh web profile patch（由 DSH Desktop 维护）\n' + block;
      else patch = patch.replace(/\s*$/, '\n') + block;
      changed = true;
    }
    // M3/#416 L3：外部层默认禁用。新装进 profile bundles 的第三方包（既非
    // 内核骨架，也不在 L1/L2 分级）若 patch 里还没有登记点，就补写「编辑型
    // 关闭行」—— 与插件管理页开关、市场安装后的落盘是同一手术；已有登记点
    // （用户启用过的裸行、市场写入的行）一律保留，用户选择优先。这样
    // `dsh plugin add` 这类 CLI 安装路径也落在「装完默认禁用、手动启用」的
    // 语义内。安全模式不写（与配套行一致）；分级表缺失时规划为空（fail-open）。
    // ISO-005：随包配套插件已由本函数负责预装，不进这一步。规划的 id 空间是
    // bundle 包名的短名（`@deepseek-ai/dsh-file-changes` → `dsh-file-changes`），
    // 与配套行的行 id（`file-changes`）不同名，因此必须把包名/行 id/canonical
    // 三种形式都显式排除 —— 否则随包插件会被写一条 `disabled: true` 行，既把
    // 内置包误标成「外部/默认禁用」，又与包自己的补丁层形成 duplicate loader
    // entry id 风险。
    const companionBundleIds = COMPANION_PLUGINS.flatMap((p) => [
      p.name,
      p.id,
      canonicalBundleId(p.name),
    ]);
    const registeredIds = registeredPatchEntryIds(patch);
    const externalDefaults = inSafeMode ? [] : externalDefaultDisabledPlan({
      bundles: bundled,
      bundleIdentities: resolveBundleIdentities(profileDirP, bundled.filter((name): name is string => typeof name === 'string')),
      isRegistered: (id: string) => registeredIds.has(id),
      distributionClasses: PLUGIN_DISTRIBUTION_CLASSES,
      builtinIds: DISTRIBUTION_BUILTIN_PLUGIN_IDS,
      recommendedIds: RECOMMENDED_PACK_PLUGIN_IDS,
      skipIds: companionBundleIds,
    });
    if (externalDefaults.length) {
      patch = toggleBundleInPatch(patch, {
        ok: true, entries: externalDefaults.map((entry) => ({ ...entry, disabled: false })),
        entryIds: externalDefaults.map((entry) => entry.id),
      }, false);
      changed = true;
      for (const ext of externalDefaults) ctx.log('boot', `外部插件默认关闭（可在「设置 → 插件 → 管理」启用）: ${ext.id}`);
    }
    if (changed) {
      // 顺带清理历史遗留的孤儿 `- insert:` 行（v4.2/4.3 每次启动「剥离-回写」
      // 残留的空块；对 cordis 无效果，仅文件卫生）。强制一次写盘，之后幂等。
      const lines = patch.split(/\r?\n/);
      const cleaned = lines.filter((line, idx) => {
        if (!/^[ \t]*- insert:\s*$/.test(line)) return true;
        let k = idx + 1;
        while (k < lines.length && lines[k]!.trim() === '') k += 1;
        return k < lines.length && /^[ \t]+- /.test(lines[k]!);
      }).join('\n');
      if (cleaned !== patch) {
        patch = cleaned;
        ctx.log('boot', '已清理 profile patch 中的孤儿 - insert: 行');
      }
      // 原子写（对齐上方 retireRemovedBuiltinPlugins 的 writeFileAtomic）：
      // boot 最关键的一次 patch 重写，中断截断 = 插件树校验失败 → 启动死亡循环。
      writeFileAtomic(patchFile, patch);
      ctx.log('boot', '已同步配套插件/皮肤到 web profile: ' + pending.map((p) => p.id).join(', '));
    }
  } catch (err) {
    ctx.log('boot', '同步配套插件失败: ' + (err as Error).message);
  }
}
