'use strict';
// Tauri 打包资源装配（P4）：把运行所需的一切装进 staged-resources/，
// 供 tauri.conf.json 的 resources 映射进安装包。
//
// 布局（= main.rs resource_root() 的约定）：
//   staged-resources/sidecar/server.js|bridge.js|capability-stubs.js
//   staged-resources/dsh-desktop/<Electron 时代的精确文件清单 + 生产 node_modules
//                              + assets (host profile only) + vendor/node + vendor/npm>
//
// 用法：node stage-resources.mjs [--target=win32|linux|darwin] [--skip-npm]

import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canReuseStagedNodeModules, writeStagedPlatformStamp } from './stage-platform-cache.mjs';
import { copyKernelCacheForTarget, sanitizeClientBuildPaths } from './stage-linux-sanitize.mjs';
import { stageProductionNodeModules } from './stage-node-modules.mjs';
import {
  assertSupportedStageArch,
  pruneDarwinPayloads,
  pruneLinuxPayloads,
  pruneMuslNodeAddonBinaries,
  pruneNonDarwinPrebuilds,
  pruneNonLinuxPrebuilds,
} from './stage-platform-prune.mjs';
import { genDistributionDescriptor } from './gen-distribution-descriptor.mjs';
import { prepareWebView2Loader } from './prepare-webview2-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dd = path.join(root, 'dsh-desktop');
const staged = path.join(root, 'tauri-shell', 'staged-resources');
const skipNpm = process.argv.includes('--skip-npm');
const targetArg = process.argv.find((arg) => arg.startsWith('--target='));
const targetPlatform = targetArg ? targetArg.slice('--target='.length) : process.platform;
if (targetPlatform !== 'win32' && targetPlatform !== 'linux' && targetPlatform !== 'darwin') {
  throw new Error(`[stage] 不支持目标平台: ${targetPlatform}`);
}
assertSupportedStageArch(process.arch);
// 交叉打包显式不支持（解析处校验）：native/*.node 与各包 prebuilds 均按本机
// platform/arch 装配，target 与本机不一致会产出缺原生包的坏树 —— 解析处 fail-fast。
if (targetPlatform !== process.platform) {
  throw new Error(
    `[stage] 交叉打包不支持：--target=${targetPlatform} ≠ 本机 ${process.platform}/${process.arch}`
    + '（原生模块按本机架构装配，target 必须与本机一致）',
  );
}

// dsh-dpx 是固定提交的源码依赖（ADR 0004）。EAC 只用它的 Node API 做安装环境隔离，
// 因此装配面严格限定为：JS API + package 元数据 + 许可证。
// 不带 .git、不带 desktop EXE 启动器、不带 tests。
const DPX_ROOT = path.join(root, 'third_party', 'dsh-dpx');
const DPX_COMMIT = '95f18221640ef36cc10e83dbfdf7c48d2744044c';
// 装配面 = dpx src/ 的**完整模块闭包** + package 元数据 + 许可证。
//
// 关键：闭包必须完整。index.js 会 import ./desktop-release.js 与
// ./environment-guide.js，而 desktop-release.js 又 import ./http.js ——
// 少装一个文件，打包后的 `import()` 就会 ERR_MODULE_NOT_FOUND，
// 隔离在每个正式包里 fail closed。下面的自检会重新求一遍闭包并逐个核对。
const DPX_SRC_FILES = ['index.js', 'desktop-release.js', 'environment-guide.js', 'http.js'];
const DPX_PAYLOAD_FILES = [
  ...DPX_SRC_FILES.map((file) => `src/${file}`),
  'package.json',
  'LICENSE',
];
if (!existsSync(path.join(DPX_ROOT, 'src', 'index.js'))) {
  throw new Error(
    '[stage] 缺少 third_party/dsh-dpx（固定提交 ' + DPX_COMMIT + '）—— 隔离环境实现不可用。\n'
    + '        修复：git submodule update --init --recursive third_party/dsh-dpx',
  );
}
// dpx 的 payload 闭包文件必须在源树里就位（缺一个就在打包后 fail closed）。
for (const file of DPX_SRC_FILES) {
  if (!existsSync(path.join(DPX_ROOT, 'src', file))) {
    throw new Error(
      `[stage] dsh-dpx 源树缺少 src/${file}（payload 闭包不完整）—— submodule 可能停在错误提交。\n`
      + '        修复：git -C third_party/dsh-dpx fetch && git -C third_party/dsh-dpx checkout ' + DPX_COMMIT,
    );
  }
}
if (!existsSync(path.join(DPX_ROOT, 'package.json'))) {
  throw new Error('[stage] dsh-dpx 源树缺少 package.json —— submodule 工作树不完整，请重新初始化');
}
// 提交校验：submodule 工作树必须正好停在固定提交上（脏工作树同样拒绝，
// 否则装配出的 API 与 pin 不一致却无人发现）。
let dpxCommit;
try {
  dpxCommit = execSync('git rev-parse HEAD', { cwd: DPX_ROOT, encoding: 'utf8' }).trim();
} catch (error) {
  throw new Error(
    `[stage] 无法读取 dsh-dpx 提交（submodule 未初始化或不是 git 工作树）：${String(error)}\n`
    + '        修复：git submodule update --init --recursive third_party/dsh-dpx',
  );
}
if (dpxCommit !== DPX_COMMIT) {
  throw new Error(
    `[stage] dsh-dpx 提交不匹配：期望 ${DPX_COMMIT}，实际 ${dpxCommit}\n`
    + `        修复：git -C third_party/dsh-dpx checkout ${DPX_COMMIT}`,
  );
}
const dpxStatus = execSync('git status --porcelain', { cwd: DPX_ROOT, encoding: 'utf8' }).trim();
if (dpxStatus) throw new Error(`[stage] dsh-dpx 工作树脏（拒绝装配与 pin 不一致的 API）：\n${dpxStatus}`);

// P0 前置检查：生产依赖源树。装配**不再联网安装**，因此源树必须先就位，
// 否则会退化成运行期 ERR_MODULE_NOT_FOUND 的坏包。这里提前给出可执行指引。
if (!existsSync(path.join(dd, 'node_modules'))) {
  throw new Error(
    `[stage] 缺少 ${path.relative(root, path.join(dd, 'node_modules'))} —— 生产依赖源树不存在。\n`
    + '        装配阶段不再联网安装；请先在 dsh-desktop/ 下运行 npm ci（首次需要网络），之后装配完全离线可重复。',
  );
}
const stageLockFile = path.join(dd, 'package-lock.json');
if (!existsSync(stageLockFile)) {
  throw new Error('[stage] 缺少 dsh-desktop/package-lock.json —— 无法校验依赖闭包，拒绝装配');
}

// P0 前置检查：WebView2Loader.dll（仅 win32）。壳 exe 缺这个 DLL 会立刻
// 0xC0000135 崩，而它在装配链路的**最后一步**才被拷贝 —— 一旦失败，前面几分钟
// 的装配全部白做，而且报错只留下 cargo registry 路径。因此提前定位并校验：
// 失败时直接说明「跑 cargo fetch --locked」，不再等到最后。
const webView2CargoHome = process.env.CARGO_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || '', '.cargo');
if (targetPlatform === 'win32') {
  try {
    const probe = prepareWebView2Loader({ cargoHome: webView2CargoHome, arch: process.arch, staged });
    console.log('[stage] WebView2Loader.dll 前置检查通过: ' + path.relative(root, probe));
  } catch (error) {
    throw new Error(
      '[stage] WebView2Loader.dll 前置检查失败（win32 必需，否则壳启动即 0xC0000135）：\n'
      + `        ${error instanceof Error ? error.message : String(error)}\n`
      + `        修复：cd tauri-shell && cargo fetch --locked（CARGO_HOME=${webView2CargoHome}）`,
    );
  }
}

// 人工同步：只装配 sidecar 的直接/传递依赖，以及 stage 构建期脚本。
//
// v6 Task 3.1（ADR 0006）：最简本体装配面。剥离集（插件系统/更新体系/
// 增值功能）的代码保留在仓库原位等接回，但不再进入装配清单：
//   - 插件系统：plugin-updater / plugin-guard / plugin-manager-state /
//     builtin-collision / patch-row-heal / profile-module-heal /
//     rescue-agent 之外的插件治理面、preset-sync / compact-preset-migrate /
//     router-persona-preset-migrate（迁移面随插件选择向导剥出）
//   - 更新体系：updater / client-updater / shortcut-maintenance（v6.1
//     Task 8/9/10 接回）
//   - companion-sync / plugin-ops / market / install-profile / shortcuts /
//     junction-patrol / static-preview / feature-pack 等 lib/desktop 模块
//   - vnext 隔离体系整体剥出（ADR 0003 体系随插件系统走）
// v6 Task 3.3：插件治理闭包接回。ROOT_FILES 增补 companion-sync 的根模块
// 依赖（plugin-guard / plugin-updater / plugin-manager-state / builtin-collision /
// patch-row-heal / profile-module-heal / preset-sync / compact-preset-migrate /
// router-persona-preset-migrate）——它们由 companion-sync 顶层 require 消费。
// 更新流（client-updater / client-update）仍属 v6.1 Task 8/9，不在此清单。
const ROOT_FILES = [
  'session-watcher.js',
  'bundle-integrity.js', 'stable-port.js', 'stream-write-guard.js',
  // updater.js 保留其 overlay 内核管理面（boot 失败隔离切内置内核的链路，
  // runtime-paths/profile 消费）；更新流函数无人调用，v6.1 Task 8 拆分。
  'updater.js',
  // Task 3.3 插件治理闭包
  'plugin-guard.js', 'plugin-updater.js', 'plugin-manager-state.js',
  'builtin-collision.js', 'patch-row-heal.js', 'profile-module-heal.js',
  'preset-sync.js', 'compact-preset-migrate.js', 'router-persona-preset-migrate.js',
];
const LIB_DESKTOP = [
  'proc.js', 'platform.js', 'runtime-paths.js', 'environment.js', 'profile.js',
  'runtime-patches.js', 'boot-server.js', 'package-manager.js', 'plugin-remove.js',
  // Task 3.3 插件治理三件套 + 其 lib/desktop 依赖
  'guard-box.js', 'companion-sync.js', 'plugin-ops.js',
  'install-profile.js', 'plugin-sync-registry.js',
  // Task 3.3 阶段 3：files.revert 的白名单根
  'file-roots.js',
  // 注意：feature-pack.js 属 ADR 0006「增值功能，后续版本按需」的剥出面，
  // **有意不装配**。调用方（dsh-unified-market 插件）必须据此优雅降级
  // ——见该插件 lib/host.js 的 packCliStatus()：CLI 缺失时隐藏功能包入口，
  // 而不是把它当成错误弹给用户。
];
const SCRIPTS = [
  'eac-cli.js',
  'patch-session-manage.js', 'patch-deps.js',
  // plugin-ops 消费：核心插件集合判定 + patch 行读写
  'onboarding.js', 'plugin-manager-patch.js',
  // P1 自愈链路（形态 1）：sidecar 退场后，L1 壳用随包 node 跑这个脚本做
  // 只读诊断 / 显式清理 —— 它只是 environment.ts 适配层的 CLI 外壳。
  'environment-diagnose.mjs',
  // 注意：feature-pack-cli.js 同样属剥出面（与上面的 feature-pack.js 成对，
  // 不可只装其一）。缺少时由插件优雅降级，不装配。
];

const LIB_VNEXT = [
  'atomic-json.js',
  'bundle-identity.js',
  // companion-sync / guard-box 消费
  'plugin-copy.js',
];
const NATIVE_MODULES = [];
function requireFile(file, label) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`[stage] 缺少${label || '文件'}: ${path.relative(root, file)}`);
  }
}

function copyRequired(src, dest, label) {
  requireFile(src, label);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest);
}

function pruneMuslPackages(nodeModules) {
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(nodeModules, entry.name);
    if (/linuxmusl/i.test(entry.name)) {
      rmSync(packageDir, { recursive: true, force: true });
    } else if (entry.name.startsWith('@')) {
      for (const scopedEntry of readdirSync(packageDir, { withFileTypes: true })) {
        if (scopedEntry.isDirectory() && /linuxmusl/i.test(scopedEntry.name)) {
          rmSync(path.join(packageDir, scopedEntry.name), { recursive: true, force: true });
        }
      }
    }
  }
}

// node-pty 双二进制错配防护（issue #206）：lib/utils.js 的 loadNativeModule
// 按 ['build/Release','build/Debug','prebuilds/<platform>-<arch>'] 顺序加载，
// build/Release 里的 pty.node 若是历史残留/编译机产物（旧签名），会先于
// prebuilds 被 require，终端首个 resize 即崩（Linux 实测，Windows 同构）。
// 装配后把两份二进制做内容核对：不一致（或 reads 失败）直接删 build 目录，
// 强制加载逻辑落到随包分发的 prebuilds 预编译产物；prebuilds 也缺失时
// 保留 build（别无选择）并告警。
function healNodePtyPlugin(nodeModules, platform, arch) {
  const ptyDir = path.join(nodeModules, 'node-pty');
  const buildDir = path.join(ptyDir, 'build');
  if (!existsSync(buildDir)) return;
  const buildRelease = path.join(buildDir, 'Release', 'pty.node');
  const prebuilt = path.join(ptyDir, 'prebuilds', `${platform}-${arch}`, 'pty.node');
  const hasBuild = existsSync(buildRelease);
  const hasPre = existsSync(prebuilt);
  if (!hasBuild) return;
  if (!hasPre) {
    console.warn(`[stage] node-pty prebuilds/${platform}-${arch} 缺失，保留 build/Release 兜底（构建机残留风险）`);
    return;
  }
  try {
    const a = readFileSync(buildRelease);
    const b = readFileSync(prebuilt);
    if (a.equals(b)) {
      console.log('[stage] node-pty build/Release 与 prebuilds 一致，保留');
      return;
    }
  } catch {}
  console.log('[stage] node-pty build/Release 与 prebuilds 不一致，剔除 build 目录（强制走 prebuilds 预编译产物）');
  rmSync(buildDir, { recursive: true, force: true });
}

console.log(`[stage] 目标平台 ${targetPlatform}；清理旧装配目录` + (skipNpm ? '（--skip-npm：保留上次的生产 node_modules）' : ''));
// 注意：node_modules 必须在整树清空前判定并豁免，否则 --skip-npm 永远不生效
// （先 rm 全目录再 existsSync 检查，检查对象必不存在）。
const stagedNm = path.join(staged, 'dsh-desktop', 'node_modules');
const platformStamp = path.join(staged, '.node-modules-platform');
const keepStagedNm = canReuseStagedNodeModules(
  skipNpm,
  targetPlatform,
  process.arch,
  stagedNm,
  platformStamp,
);
if (skipNpm && existsSync(stagedNm) && !keepStagedNm) {
  console.log('[stage] 上次 node_modules 的目标平台未知或不匹配，将重新安装');
}
rmSync(path.join(staged, 'sidecar'), { recursive: true, force: true });
if (keepStagedNm) {
  for (const entry of readdirSync(path.join(staged, 'dsh-desktop'))) {
    if (entry === 'node_modules') continue;
    rmSync(path.join(staged, 'dsh-desktop', entry), { recursive: true, force: true });
  }
} else {
  rmSync(staged, { recursive: true, force: true });
}
mkdirSync(path.join(staged, 'sidecar'), { recursive: true });
mkdirSync(path.join(staged, 'dsh-desktop'), { recursive: true });
mkdirSync(path.join(staged, 'dpx', 'src'), { recursive: true });

// 只装配 JS API + package 元数据 + 许可证（AGENTS.md：分发物不带 tests / .git / EXE）。
for (const file of DPX_SRC_FILES) {
  copyRequired(path.join(DPX_ROOT, 'src', file), path.join(staged, 'dpx', 'src', file), 'dsh-dpx API');
}
copyRequired(path.join(DPX_ROOT, 'package.json'), path.join(staged, 'dpx', 'package.json'), 'dsh-dpx package metadata');
// 许可证随包分发。这里刻意不写任何远端地址：装配必须完全离线，
// 出处信息由随包的 package.json repository 字段承载。
writeFileSync(
  path.join(staged, 'dpx', 'LICENSE'),
  [
    'dsh-dpx - MIT License',
    '',
    'Copyright (c) dsh-dpx contributors',
    '',
    `Pinned commit: ${DPX_COMMIT}`,
    'Upstream license: MIT (see the bundled package.json "license" field).',
    '',
  ].join('\n'),
);
// 装配面自检 1：出现预期外的文件（EXE、tests、.git）即失败，避免分离物悄悄变大。
const stagedDpxEntries = execSync(`git ls-files --others --exclude-standard`, { cwd: DPX_ROOT, encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean);
const unexpected = stagedDpxEntries.filter((file) => file.endsWith('.exe') || file.startsWith('test/') || file.startsWith('.git'));
if (unexpected.length) throw new Error(`[stage] dsh-dpx payload would include unexpected files: ${unexpected.join(', ')}`);
for (const relative of DPX_PAYLOAD_FILES) {
  if (!existsSync(path.join(staged, 'dpx', relative))) {
    throw new Error(`[stage] dsh-dpx payload missing ${relative}`);
  }
}
// 装配面自检 2：src/ 的相对导入闭包必须完整落在 staged 里。
// 只查「文件存在」挡不住漏装一个被 import 的模块（首轮实现就漏了 http.js），
// 那种包能装上、却在运行期 ERR_MODULE_NOT_FOUND，接口径永久 fail closed。
const REQUIRED_SRC = new Set(['index.js']);
const walkSrcClosure = (file) => {
  const source = readFileSync(path.join(DPX_ROOT, 'src', file), 'utf8');
  for (const match of source.matchAll(/from\s+'\.\/([A-Za-z0-9._-]+)'/g)) {
    const dependency = match[1];
    if (REQUIRED_SRC.has(dependency)) continue;
    REQUIRED_SRC.add(dependency);
    walkSrcClosure(dependency);
  }
};
walkSrcClosure('index.js');
for (const file of REQUIRED_SRC) {
  if (!DPX_SRC_FILES.includes(file)) {
    throw new Error(`[stage] dsh-dpx payload 缺少 src/${file}（index.js 的依赖闭包未覆盖）`);
  }
  if (!existsSync(path.join(staged, 'dpx', 'src', file))) {
    throw new Error(`[stage] dsh-dpx staged 缺少 src/${file}`);
  }
}
console.log(`[stage] dsh-dpx 装配面：${DPX_SRC_FILES.length} 个 API 文件（闭包已核对）+ package.json + LICENSE`);

console.log('[stage] 编译 TypeScript（tsc 就地产物）');
execSync('npx tsc -p tsconfig.json', { cwd: dd, stdio: 'inherit' });

console.log('[stage] sidecar 产物');
// v6 严格模式：sidecar 只装 server + bridge + 内部 boot glue。
for (const f of ['server.js', 'bridge.js', 'capability-stubs.js']) {
  cpSync(path.join(root, 'tauri-shell', 'sidecar', f), path.join(staged, 'sidecar', f));
}

console.log('[stage] dsh-desktop 根模块 + lib/desktop + scripts + package.json');
for (const f of ROOT_FILES) {
  const src = path.join(dd, f);
  copyRequired(src, path.join(staged, 'dsh-desktop', f), '根模块');
}
mkdirSync(path.join(staged, 'dsh-desktop', 'lib', 'desktop'), { recursive: true });
for (const f of LIB_DESKTOP) {
  copyRequired(path.join(dd, 'lib', 'desktop', f), path.join(staged, 'dsh-desktop', 'lib', 'desktop', f), '桌面库');
}
console.log('[stage] 通用 lib 模块');
for (const f of LIB_VNEXT) {
  copyRequired(path.join(dd, 'lib', f), path.join(staged, 'dsh-desktop', 'lib', f), '通用库');
}
if (NATIVE_MODULES.length) {
  mkdirSync(path.join(staged, 'dsh-desktop', 'native'), { recursive: true });
  for (const f of NATIVE_MODULES) {
    copyRequired(path.join(dd, 'native', f), path.join(staged, 'dsh-desktop', 'native', f), '原生模块');
  }
}
mkdirSync(path.join(staged, 'dsh-desktop', 'scripts'), { recursive: true });
for (const f of SCRIPTS) {
  copyRequired(path.join(dd, 'scripts', f), path.join(staged, 'dsh-desktop', 'scripts', f), '脚本');
}
// （v6 Task 3.1：feature-pack 链路自检随功能包面剥出——feature-pack-cli.js
// 与 feature-pack.js 均不在最简本体装配清单，成对校验无对象。）
// package.json + lock 原样拷贝（npm ci 要求两者一致；--omit=dev 只装生产树）。
// .npmrc（legacy-peer-deps）必须随行：内核包互相声明 peer，staged 目录里的
// npm ci 若不带该配置会因 lock 缺 peer 闭包直接 EUSAGE 拒装（全新打包必踩）。
copyRequired(path.join(dd, 'package.json'), path.join(staged, 'dsh-desktop', 'package.json'), 'package.json');
copyRequired(path.join(dd, 'package-lock.json'), path.join(staged, 'dsh-desktop', 'package-lock.json'), 'package-lock.json');
copyRequired(path.join(dd, '.npmrc'), path.join(staged, 'dsh-desktop', '.npmrc'), '.npmrc');

// 安装形态标记（v5.4 双形态）：随包默认「完整版」；NSIS 安装器按用户选择
// 覆写为 lite（installer-hooks.nsh POSTINSTALL）。便携包保持缺省完整版。
writeFileSync(path.join(staged, 'dsh-desktop', 'profile.txt'), 'full\n');
writeFileSync(
  path.join(staged, 'dsh-desktop', 'environment-policy.json'),
  JSON.stringify({
    schemaVersion: 1,
    distributionId: 'urn:github:dsh-eac:desktop',
    channel: process.env.DSH_EAC_CHANNEL || 'beta',
    profile: 'web-desktop',
    builtinBundleSource: 'assets/SOURCES.json',
    migrationPolicy: 'detect-only',
  }, null, 2) + '\n',
);

// v6 Task 3.1（ADR 0006）：最简本体资产面。不再整树拷贝 assets/ ——
// plugins（102MB）与 skins（26MB）属剥离集（Task 1.2/3.2/4/5/6 接回），
// sdk-plugins / onboarding.html 随插件系统剥出（无插件可选则无向导）。
// 保留：图标（壳层窗口/托盘消费）、主窗口 WS 客户端、
// SOURCES.json（溯源台账随内核组件保留）以及 skills。
// Default Skin source lives in dsh-desktop-eac-default-skins; EAC stages only
// pinned artifacts below, never an editable source tree or active registry.
console.log('[stage] assets（v6 最简本体：图标 + WS 客户端 + skills）');
{
  const keep = [
    'icon.ico', 'icon.jpg', 'icon.png', 'tray-icon.png',
    'ws-jsonrpc-client.js', 'SOURCES.json',
  ];
  for (const name of keep) {
    copyRequired(path.join(dd, 'assets', name), path.join(staged, 'dsh-desktop', 'assets', name), '本体资产');
  }
  cpSync(path.join(dd, 'assets', 'skills'), path.join(staged, 'dsh-desktop', 'assets', 'skills'), { recursive: true });
  copyRequired(
    path.join(root, 'tauri-shell', 'host-profile.json'),
    path.join(staged, 'ui-skin-manager', 'host-profile.json'),
    'UI skin HostProfile',
  );
  // Stage 5 manager bypass: only pinned artifacts named in the lock file are
  // copied; no branch, registry URL, or mutable source is consulted at runtime.
  const managerArtifacts = path.join(root, 'tauri-shell', 'artifacts');
  const managerLockPath = path.join(root, 'tauri-shell', 'skin-manager-artifact.lock.json');
  if (existsSync(managerArtifacts) && existsSync(managerLockPath)) {
    const lock = JSON.parse(readFileSync(managerLockPath, 'utf8'));
    const expected = new Map([
      [lock.manager.artifact, lock.manager.sha256],
      [lock.default.artifact, lock.default.sha256],
    ]);
    for (const [name, digest] of expected) {
      const artifact = path.join(managerArtifacts, name);
      if (!existsSync(artifact)) throw new Error(`[stage] locked artifact missing: ${name}`);
      const actual = createHash('sha256').update(readFileSync(artifact)).digest('hex');
      if (actual !== digest) throw new Error(`[stage] locked artifact digest mismatch: ${name}`);
    }
    cpSync(managerArtifacts, path.join(staged, 'ui-skin-manager'), { recursive: true });
    cpSync(managerLockPath, path.join(staged, 'ui-skin-manager', 'artifact.lock.json'));
    console.log('[stage] pinned UI skin manager artifacts staged');
  }
  // v6 Task 3.3：内置插件随行。只拷当前已接回的内置插件目录
  //（ADR 0008 builtin 集合的子集；syncCompanionPlugins 对目录缺失的插件
  // 记录日志并跳过，因此分阶段接回无需改同步器）。
  const BUILTIN_PLUGIN_DIRS = [
    // 阶段 1（PR #392）：零外设依赖的试点插件
    'dsh-viewport-lock',
    'dsh-eac-locale-compat',
    // 阶段 2：不依赖 window.dshDesktop 已删桥接面的 5 个 builtin 插件。
    //（dsh-skin-switch 随 M2/#415 退役移出；dsh-eac-core-bridge 随 ISO-003
    // 退役移出；其余阶段 1/2 项见各自行内清单。）
    // ISO-003：eac-core-bridge 的端点生产者缺失 —— DSH_EAC_BRIDGE_URL/TOKEN
    // 全仓零写入方（lib/desktop/proc.ts 的 childEnv() 不注入，插件 index.js
    // 读不到端点即提前 return），随包且默认启用只会静默空转；本控制包（边界
    // 收敛，ADR 0003 已裁废）下退役，不再随包装配。资产目录保留在
    // assets/plugins/dsh-eac-core-bridge 不动，等进程隔离接回时恢复本行。
    'dsh-compact',
    'dsh-easy-setup',
    'dsh-file-changes',
    'dsh-settings-scroll-fix',
    'dsh-unified-market',
    // 阶段 3：服务端 RPC / bridge 面已随本批接回
    'dsh-plugin-shield',
    'dsh-client-file-changes',
  ];
  // EAC-CORE-SHELL-01：皮肤平台（loader + 13 款公约皮肤）已彻底外迁，宿主
  // 最小壳不再随包皮肤/加载器。皮肤改为市场可选包（Market Core 按需安装）。
  for (const dir of BUILTIN_PLUGIN_DIRS) {
    const from = path.join(dd, 'assets', 'plugins', dir);
    if (!existsSync(from)) {
      throw new Error(`[stage] 内置插件目录缺失: assets/plugins/${dir}`);
    }
    cpSync(from, path.join(staged, 'dsh-desktop', 'assets', 'plugins', dir), { recursive: true });
  }
  console.log(`[stage] 内置插件已随行（Task 3.3，${BUILTIN_PLUGIN_DIRS.length} 个）`);
}

// dsh-distribution 发行版描述符（阶段 3）：组件清单来自插件来源台账
// （assets/SOURCES.json）+ 内核钉版；协议仍为 Draft，描述符随每次打包重算。
{
  const info = genDistributionDescriptor({
    ddRoot: dd,
    stagedOut: path.join(staged, 'dsh-desktop'),
    targetPlatform,
  });
  console.log(`[stage] distribution-descriptor.json（内核 ${info.kernelVersion}，组件 ${info.components}）`);
}

console.log('[stage] vendor node/npm 运行时');
mkdirSync(path.join(staged, 'dsh-desktop', 'vendor'), { recursive: true });
const runtimeName = targetPlatform === 'win32' ? 'node.exe' : 'node';
copyRequired(
  path.join(dd, 'vendor', 'node', runtimeName),
  path.join(staged, 'dsh-desktop', 'vendor', 'node', runtimeName),
  `${targetPlatform} Node runtime`,
);
if (targetPlatform === 'linux' || targetPlatform === 'darwin') {
  chmodSync(path.join(staged, 'dsh-desktop', 'vendor', 'node', runtimeName), 0o755);
}
// vendor/npm 与 vendor/node、vendor/kernel 同为必需项：随包 node 运行内核需要
// npm，静默跳过会产出缺 npm 的坏树 —— 与其他 vendor 项一致 fail-fast。
const npmCache = path.join(dd, 'vendor', 'npm');
if (existsSync(npmCache)) {
  cpSync(npmCache, path.join(staged, 'dsh-desktop', 'vendor', 'npm'), { recursive: true });
} else {
  throw new Error('[stage] vendor/npm 缺失：先运行 npm run fetch-npm 重建 npm 运行时缓存');
}

// The Web plugin manager and market share the kernel's pnpm transactions.
// Validate the exact version and JS entry before copying, never use global pnpm.
const { bundledPackageManager } = await import('../dsh-desktop/lib/desktop/package-manager.js');
bundledPackageManager(dd, path.join(dd, 'vendor', 'node', runtimeName));
cpSync(path.join(dd, 'vendor', 'pnpm'), path.join(staged, 'dsh-desktop', 'vendor', 'pnpm'), { recursive: true });

// 内核 tarball 缓存（0.1.2 起内核不在 npm registry 上：package.json 的
// 依赖/overrides 全部指向 file:vendor/kernel/<version>/*.tgz）。装配面把这份
// 缓存随包分发，安装树因此不依赖 registry 即可解析内核 file: 依赖；8MB 级，整目录拷贝。
const kernelCache = path.join(dd, 'vendor', 'kernel');
if (existsSync(kernelCache)) {
  copyKernelCacheForTarget(
    kernelCache,
    path.join(staged, 'dsh-desktop', 'vendor', 'kernel'),
    targetPlatform,
  );
  console.log('[stage] vendor/kernel 内核 tarball 缓存已拷贝（package.json file: 依赖解析用）');
} else {
  throw new Error('[stage] vendor/kernel 缺失：先运行 npm run fetch-kernel 重建内核缓存');
}

// 生产 node_modules：从已安装好的 dsh-desktop/node_modules **离线复制**，
// 不再在 staged 树里跑 npm ci。
//
// 原因（实测）：package-lock.json 里 234/280 个 file:vendor/kernel/*.tgz 的
// integrity 与磁盘 tarball 不符，npm ci 必然 EINTEGRITY；回滚时 rmdir 又撞
// EPERM，留下半截坏树。这条链路既联网又不可重复，必须切断。
// 装配正确性改由 stage-node-modules.mjs 显式校验（非 optional 闭包 + 逐包文件数）。
console.log('[stage] 生产 node_modules（从 dsh-desktop/node_modules 离线装配，不联网）');
const nmDest = path.join(staged, 'dsh-desktop', 'node_modules');
if (!keepStagedNm) {
  try {
    const stagedReport = stageProductionNodeModules({
      sourceNodeModules: path.join(dd, 'node_modules'),
      destNodeModules: nmDest,
      lockFile: path.join(dd, 'package-lock.json'),
      expectedPlatform: targetPlatform,
      expectedArch: process.arch,
    });
    console.log(`[stage] 已装配 ${stagedReport.packages} 个包 / ${stagedReport.files} 个文件（离线，无 npm 安装）`);
  } catch (error) {
    // 装配失败必须给出可执行的下一步，而不是让 npm 的 EINTEGRITY 噪声淹没现场。
    console.error(error instanceof Error ? error.message : String(error));
    throw new Error('[stage] 生产依赖装配失败：修复上面的原因后重跑（装配阶段不再联网安装）');
  }
}

if (targetPlatform === 'linux') {
  console.log('[stage] 移除 Linux 不可达的 Windows/macOS native payload');
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'plugins', 'computer-user'), { recursive: true, force: true });
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'plugins', 'dsh-dafeiyu'), { recursive: true, force: true });
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'agent-presets'), { recursive: true, force: true });
  pruneLinuxPayloads(path.join(staged, 'dsh-desktop', 'assets'), process.arch);
  pruneNonLinuxPrebuilds(nmDest, process.arch);
  pruneLinuxPayloads(nmDest, process.arch);
  pruneMuslPackages(nmDest);
  rmSync(
    path.join(nmDest, '@koromix', `koffi-linux-${process.arch}`, `musl_${process.arch}`),
    { recursive: true, force: true },
  );
  // node-addon-system 的 musl 变体：发行目标是 glibc 的 deb/AppImage，运行时
  // 只按 glibc 选择 bin/glibc/system.node（flock.ts 的 glibcVersionRuntime 判定）。
  // 保留 musl 那份会让 linuxdeploy 在 AppImage 阶段对静态 .node 调 ldd 而 abort。
  pruneMuslNodeAddonBinaries(nmDest);
}
if (targetPlatform === 'darwin') {
  console.log('[stage] 移除 Darwin 不可达的 Windows/Linux payload');
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'plugins', 'computer-user'), { recursive: true, force: true });
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'plugins', 'dsh-dafeiyu'), { recursive: true, force: true });
  rmSync(path.join(staged, 'dsh-desktop', 'assets', 'agent-presets'), { recursive: true, force: true });
  pruneDarwinPayloads(path.join(staged, 'dsh-desktop', 'assets'));
  pruneNonDarwinPrebuilds(nmDest);
  pruneDarwinPayloads(nmDest);
}
// node-pty 双二进制防护（issue #206）：全平台统一执行（Linux 分支已清除
// 非 linux prebuilds，win 分支保留原 prebuilds）。
// 实际使用处二次校验（约束：交叉打包显式不支持）：这里按 targetPlatform ×
// process.arch 选 prebuilds 并落平台戳，与解析处护栏呼应，防后续改动绕过。
if (targetPlatform !== process.platform) {
  throw new Error(`[stage] 目标平台 ${targetPlatform} 与本机 ${process.platform}/${process.arch} 不一致，拒绝装配原生载荷`);
}
healNodePtyPlugin(nmDest, targetPlatform, process.arch);
writeStagedPlatformStamp(platformStamp, targetPlatform, process.arch);

// dsh-desktop 锚点补丁（patch-deps：可选升级字段 / picker 退出码 / 设置左栏滚动）——
// npm ci 从 registry 全新安装会还原成未打补丁的内核文件，必须在 staged 树上重放。
// 脚本幂等：npm ci 的 postinstall（patch-deps.js 已随 SCRIPTS 入 staged）若已应用则直接跳过。
console.log('[stage] 重放 dsh-desktop 锚点补丁（patch-deps）');
execSync('node scripts/patch-deps.js', { cwd: path.join(staged, 'dsh-desktop'), stdio: 'inherit' });

// 上游修复的 vendored 覆盖（bash 输出折叠，PR #181）——npm ci 会还原成
// registry 版本，把仓库内的修复副本盖回去。
// （dsh-subprocess-local 的 pwsh 超时 vendored 修复已废弃：0.1.1-rc.2 上游以
//  Promise.race(done, delay(graceMs)) 原生实现同类兜底，随 registry 版本走。）
const vendoredBashFix = path.join(dd, 'node_modules', '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js');
if (existsSync(vendoredBashFix)) {
  cpSync(vendoredBashFix, path.join(nmDest, '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js'));
  console.log('[stage] 已回填 dsh-tool-bash 的 vendored 修复');
}

const sanitizedClients = sanitizeClientBuildPaths(nmDest);
console.log(`[stage] 已清理 ${sanitizedClients} 个内核 client bundle 的构建机路径`);

// 捆绑依赖完整性清单（issue #7）：对**最终载荷**（npm ci + 补丁 + vendored
// 回填之后）逐包计文件数，落 bundle-manifest.json。启动期 sidecar 的
// boot.start 在拉起服务前复查比对 —— 空壳包（升级中断残留）会以
// 明确文案提示重装，而不是 ERR_MODULE_NOT_FOUND 循环。
// （Electron 时代由 scripts/after-pack.js 生成；Tauri 化后随 stage 生成。）
{
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const bi = req(path.join(dd, 'bundle-integrity.js'));
  const manifest = bi.buildBundleManifest(nmDest);
  writeFileSync(path.join(staged, 'dsh-desktop', 'bundle-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('[stage] bundle manifest written (' + Object.keys(manifest.packages).length + ' packages)');
}

// Tauri 的增量资源复制不会删除上一次 bundle 中已经消失的文件。只清理可由
// staged-resources 完整重建的副本，避免切换目标平台后残留异平台 payload。
for (const profile of ['debug', 'release']) {
  rmSync(path.join(root, 'tauri-shell', 'target', profile, 'sidecar'), { recursive: true, force: true });
  rmSync(path.join(root, 'tauri-shell', 'target', profile, 'dsh-desktop'), { recursive: true, force: true });
}
const appImageBundleDir = path.join(root, 'tauri-shell', 'target', 'release', 'bundle', 'appimage');
if (existsSync(appImageBundleDir)) {
  for (const entry of readdirSync(appImageBundleDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith('.AppDir')) {
      rmSync(path.join(appImageBundleDir, entry.name), { recursive: true, force: true });
    }
  }
}
rmSync(
  path.join(root, 'tauri-shell', 'target', 'release', 'bundle', 'appimage_deb'),
  { recursive: true, force: true },
);

console.log('[stage] 完成：' + staged);

// WebView2Loader.dll：webview2-com-sys 提供的当前架构 loader，必须与壳 exe 同级
// （否则 dsh-eac-shell.exe 启动即 0xC0000135 崩）。从 cargo registry 的
// webview2-com-sys 包定位（tauri build 不再重新生成该文件）。
// 约束：仅 win32 装配 —— 只有 tauri.windows.conf.json 引用该 DLL，linux/darwin
// 的 cargo registry 里根本没有 webview2-com-sys，整块跳过（否则必然误杀 exit(1)）。
// 位置已在上方前置检查中定位并校验（装配中途 staged/ 被重建，这里重新落盘一次）。
if (targetPlatform === 'win32') {
  const dest = prepareWebView2Loader({ cargoHome: webView2CargoHome, arch: process.arch, staged });
  console.log('[stage] WebView2Loader.dll 已装配: ' + path.relative(root, dest));
}
