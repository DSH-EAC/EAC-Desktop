// dsh-distribution 发行版描述符（阶段 3）：打包时生成 DistributionDescriptor，
// 随资源分发到 dsh-desktop/distribution-descriptor.json。
//
// 协议：https://github.com/T-Auto/dsh-distribution（Draft，apiVersion v1alpha1）。
// 原则：只描述真实情况 —— 组件与版本全部来自 assets/SOURCES.json（插件来源
// 台账）与 dsh-desktop/package.json（内核钉版），数据位置只写已核实的路径；
// 尚未核实的资源（如会话目录布局随内核版本演进）不编造，宁可省略。
//
// ISO-005（GAP D7）：发行契约只描述**真实在包组件** —— 台账是来源审计面，
// 含 recommended/external（市场按需安装）与历史线记录，不等于随包面。插件
// 组件以装配面 stage-resources.mjs 的 BUILTIN_PLUGIN_DIRS 为唯一基准过滤；
// 其余资产要求台账声明路径在磁盘上真实存在（且不是只剩 node_modules 的空壳）。
// 修复前对 main 线台账无条件发组件，58 个组件里 47 个是发行物没有的幻影。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DSH_HOME = '~/.dsh';

// 装配脚本与本文同目录（tauri-shell/）：BUILTIN_PLUGIN_DIRS 是「哪些插件随包」
// 的权威清单（stage-resources 逐目录 fail-fast 拷贝）。解析口径与
// test/issue-415-skin-switch-retirement.test.ts 的断言一致。
const STAGE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'stage-resources.mjs');

/** 随包内置插件目录名（stage-resources.mjs 的 BUILTIN_PLUGIN_DIRS）。 */
function stagedBuiltinPluginDirs() {
  const src = readFileSync(STAGE_SCRIPT, 'utf8');
  const match = /const BUILTIN_PLUGIN_DIRS = \[([\s\S]*?)\];/.exec(src);
  if (!match) {
    // 解析失败必须 fail-fast：此处静默降级会让描述符把全部台账插件都当随包项。
    throw new Error('[descriptor] 无法解析装配面 BUILTIN_PLUGIN_DIRS，发行契约无法判定随包插件');
  }
  return new Set([...match[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

/** 台账条目声明的资产路径是否真在包（repo 根为基准；台账用 `dsh-desktop/...` 口径）。 */
function ledgerAssetIsReal(repoRoot, entry) {
  if (typeof entry.path !== 'string' || !entry.path) return false;
  const abs = path.resolve(repoRoot, entry.path);
  if (!existsSync(abs)) return false;
  if (existsSync(path.join(abs, 'package.json'))) return true; // 插件/皮肤等包形态
  // 非包资产（preset 等）：目录里除 node_modules 外至少还要有一个实体，
  // 否则只是安装残留的空壳（如已剥出源码的 openclaw-dsh-bridge）。
  try {
    return readdirSync(abs).some((name) => name !== 'node_modules');
  } catch {
    return false;
  }
}

function githubRef(repository, version) {
  // https://github.com/<owner>/<repo>[#subdir|/tree/...] -> pkg:github/<owner>/<repo>@<ref>
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/#]+)/.exec(String(repository || ''));
  if (!match) return null;
  return `pkg:github/${match[1]}/${match[2]}@${version || 'main'}`;
}

function componentRef(entry) {
  if (entry.type === 'host-fused') {
    return { ref: `builtin:eac-host/${entry.name || entry.id}`, note: '宿主融合能力，随壳分发' };
  }
  const upstream = entry.upstream || {};
  if (upstream.repository) {
    const ref = githubRef(upstream.repository, entry.version)
      || `pkg:eac-vendored/${entry.name || entry.id}@${entry.version || 'local'}`;
    return { ref, upstreamPinned: upstream.pinnedHead || upstream.refType || 'version' };
  }
  return { ref: `builtin:eac/${entry.name || entry.id}@${entry.version || 'local'}`, note: 'EAC 自研' };
}

export function genDistributionDescriptor({ ddRoot, stagedOut }) {
  const pkg = JSON.parse(readFileSync(path.join(ddRoot, 'package.json'), 'utf8'));
  const ledger = JSON.parse(readFileSync(path.join(ddRoot, 'assets', 'SOURCES.json'), 'utf8'));
  // 内核钉版：dependencies["@deepseek-ai/dsh"] = file:vendor/kernel/<ver>/...tgz
  const kernelDep = pkg.dependencies?.['@deepseek-ai/dsh'] || '';
  const kernelVersion = /deepseek-ai-dsh-([\w.\-+]+)\.tgz/.exec(kernelDep)?.[1] || 'unknown';
  const appVersion = pkg.version || 'unknown';

  // 内核/壳组件保持（发行物本体；其余组件以「真实在包」为准过滤）。
  const components = [
    { id: 'runtime', ref: `pkg:npm/@deepseek-ai/dsh@${kernelVersion}`, note: 'DeepSeek Harness 内核（vendored tarball，禁止改动）' },
    { id: 'shell', ref: `pkg:github/Ebony-Vinyl/DSH-Desktop-EAC@v${appVersion}`, dependsOn: ['runtime'], note: 'Tauri 2 桌面壳 + sidecar' },
  ];
  const builtinPluginDirs = stagedBuiltinPluginDirs();
  const repoRoot = path.dirname(ddRoot); // 台账 path 为仓库根相对（`dsh-desktop/...`）
  const skipped = [];
  for (const entry of ledger.components) {
    if (entry.line !== 'main') continue; // aio-v1 线由发行分支自带 seed 描述
    if (!['plugin', 'skin', 'preset', 'source-copy', 'seed'].includes(entry.type)) continue;
    // 插件组件：必须同时在装配清单（BUILTIN_PLUGIN_DIRS）与磁盘实物里 ——
    // 台账 main 线 45 条插件记录覆盖 recommended/external 与历史线，其中只有
    // 随包的那几条才是发行物组件。其余类型（preset/skin/source-copy/seed）：
    // 按台账声明路径核实「目录存在且不是只剩 node_modules 的空壳」。
    const inPackage = entry.type === 'plugin'
      ? builtinPluginDirs.has(path.basename(String(entry.path || ''))) && ledgerAssetIsReal(repoRoot, entry)
      : ledgerAssetIsReal(repoRoot, entry);
    if (!inPackage) {
      skipped.push(String(entry.name || entry.id));
      continue;
    }
    const { ref, ...rest } = componentRef(entry);
    components.push({ id: entry.type === 'source-copy' ? `${entry.name}#source-copy` : String(entry.name || entry.id), ref, dependsOn: ['runtime'], ...rest });
  }
  if (skipped.length) {
    console.log(`[descriptor] 台账中 ${skipped.length} 条记录不在包，未发组件（发行契约只描述真实在包组件）: ${skipped.join(', ')}`);
  }

  const descriptor = {
    apiVersion: 'distribution.dsh.dev/v1alpha1',
    kind: 'DistributionDescriptor',
    distribution: { id: 'urn:github:Ebony-Vinyl:dsh-desktop-eac', version: appVersion },
    displayName: 'Deepseek Harness EAC（全量/精简双形态，Tauri 2）',
    protocols: [
      {
        apiVersion: 'composition.distribution.dsh.dev/v1alpha1',
        kind: 'EnvironmentComposition',
        required: true,
        spec: { components },
      },
      {
        apiVersion: 'layout.distribution.dsh.dev/v1alpha1',
        kind: 'ManagedLayout',
        required: true,
        spec: {
          resources: [
            { id: 'config', role: 'config', location: { type: 'absolute-path', value: DSH_HOME }, ownership: 'exclusive', portability: 'portable', sensitivity: 'private' },
            { id: 'profile', role: 'state', location: { type: 'absolute-path', value: `${DSH_HOME}/profiles/web-desktop` }, ownership: 'exclusive', portability: 'conditional', sensitivity: 'private' },
            { id: 'extensions', role: 'extensions', location: { type: 'absolute-path', value: `${DSH_HOME}/profiles/web-desktop/node_modules` }, ownership: 'exclusive', portability: 'conditional', sensitivity: 'public' },
            { id: 'agent-presets', role: 'data', location: { type: 'absolute-path', value: `${DSH_HOME}/.agent-presets` }, ownership: 'exclusive', portability: 'portable', sensitivity: 'private' },
          ],
        },
      },
      {
        apiVersion: 'lifecycle.distribution.dsh.dev/v1alpha1',
        kind: 'EnvironmentLifecycle',
        required: false,
        spec: { states: ['available', 'active', 'inactive', 'broken', 'migrating'] },
      },
      {
        apiVersion: 'portability.distribution.dsh.dev/v1alpha1',
        kind: 'EnvironmentPortability',
        required: false,
        spec: { modes: ['clone', 'export', 'migrate'] },
      },
    ],
    'x-eac': {
      installProfiles: ['full', 'lite'],
      profileMarker: 'dsh-desktop/profile.txt',
      ledger: 'dsh-desktop/assets/SOURCES.json',
      generatedAt: new Date().toISOString(),
    },
  };

  mkdirSync(stagedOut, { recursive: true });
  writeFileSync(path.join(stagedOut, 'distribution-descriptor.json'), JSON.stringify(descriptor, null, 2) + '\n');
  return { kernelVersion, appVersion, components: components.length, skippedLedgerEntries: skipped.length };
}
