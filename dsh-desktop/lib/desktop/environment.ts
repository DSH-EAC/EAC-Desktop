'use strict';

// EAC 安装环境隔离（ADR 0004）：对固定提交的 dsh-dpx **API** 做薄适配。
//
// 纪律（ADR 0002 分层 / 核心红线）：注册表、锁、清单、环境变量治理逻辑全部
// 属于 dsh-dpx 本体，EAC 只用它的公开 JS API，不复制、不重写、不落第二套事实源。
//   - 创建/复用：`createEnvironment({ name, storageRoot, home, desktop: false, publishDiscovery: false })`
//   - 路径：`pathsFor(record.root)`
//   - 子进程变量：`runtimeEnvironment(paths, inherited, { name, registryHome })`
//
// 因此本模块的职责只有三件事：
//   1. 算出「产品数据根 + 通道」→ dpx 的 storageRoot / name / 注册表位置；
//   2. 调 dpx 完成初始化，失败则 fail closed（不回退宿主 `~/.dsh`）；
//   3. 把 dpx 返回的 runtime 环境应用到 sidecar 进程（并清掉被清理的继承变量）。
//
// 真值来源：
//   本仓库 third_party/dsh-dpx（submodule，提交见 DPX_PINNED_COMMIT）
//   打包态由 stage-resources.mjs 装配为 <resources>/dpx/src/index.js。

import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import childProcess = require('node:child_process');
import url = require('node:url');

/** dpx 的 pathsFor() 布局（字段与 dpx 一一对应，不做增删）。 */
export interface DpxPaths {
  root: string;
  npmPrefix: string;
  npmCache: string;
  dshHome: string;
  agentsHome: string;
  home: string;
  desktopHome: string;
  appData: string;
  localAppData: string;
  tmp: string;
  xdgConfig: string;
  xdgCache: string;
  xdgData: string;
  workspace: string;
  desktopState: string;
  updates: string;
  descriptor: string;
  manifest: string;
  desktopDir: string;
  desktop: string;
}

export interface EnsuredEnvironment {
  /** dpx 的 DPXEnvironment 记录（原样返回，不解释、不改写）。 */
  record: Record<string, unknown>;
  paths: DpxPaths;
  /** dpx runtimeEnvironment() 的完整结果。 */
  runtime: NodeJS.ProcessEnv;
  /** 传给 dpx 的 storageRoot（环境根的上一级）。 */
  storageRoot: string;
  /** 机器级注册表目录（dpx 的 DPX_HOME）。 */
  registryHome: string;
  name: string;
  channel: string;
  rootExistedBefore: boolean;
  /** 宿主旧 profile 只做存在性提示，绝不自动迁移/删除/覆盖。 */
  legacyDshHome: string;
  legacyProfileDetected: boolean;
}

/** dsh-dpx 固定提交：与 .gitmodules / stage-resources.mjs 保持同一事实源。 */
export const DPX_PINNED_COMMIT = '95f18221640ef36cc10e83dbfdf7c48d2744044c';
export const DPX_LICENSE = 'MIT';

export const DEFAULT_ENVIRONMENT_CHANNEL = 'beta';
export const DEFAULT_ENVIRONMENT_PRODUCT = 'Deepseek Harness EAC';
export const DEFAULT_DESKTOP_PROFILE = 'web-desktop';

/**
 * 通道规范化。
 *
 * dpx 的环境名规则是 `/^[A-Za-z][A-Za-z0-9-]{0,63}$/`（首字符必须是字母），
 * 所以这里只允许 ASCII 字母数字与 `-`，并把首字符补成字母，
 * 保证 `eac-<channel>` 一定通过 dpx 校验。
 */
export function cleanChannel(value: string | undefined): string {
  const raw = String(value ?? '').trim().toLowerCase();
  // 通道名来自构建/发布配置，是 ASCII 标识符；出现其它字符说明配置有误，
  // 此时退回默认通道，而不是把无效值「清洗」成一个看似合法的错通道
  // （否则 beta 发布会静默落到 eac-c 这种环境上）。
  if (!/^[a-z][a-z0-9-]{0,59}$/.test(raw)) return DEFAULT_ENVIRONMENT_CHANNEL;
  return raw.replace(/-+$/g, '') || DEFAULT_ENVIRONMENT_CHANNEL;
}

export function environmentChannel(env: NodeJS.ProcessEnv = process.env): string {
  return cleanChannel(env.DSH_EAC_CHANNEL);
}

/** dpx 环境名：`eac-<channel>`（字母开头，满足 dpx 的 assertEnvironmentName）。 */
export function environmentName(env: NodeJS.ProcessEnv = process.env): string {
  return `eac-${environmentChannel(env)}`;
}

function platformPath(platform: NodeJS.Platform): typeof path.win32 {
  return platform === 'win32' ? path.win32 : (path.posix as unknown as typeof path.win32);
}

/**
 * 产品数据根。
 *
 * Windows：`%LOCALAPPDATA%\Deepseek Harness EAC`；非 Windows 在产品数据根下同样布局。
 * Rust L1 只传这个根（`DSH_EAC_DATA_ROOT`）和通道，其余推导都在本模块完成。
 *
 * `DSH_EAC_DATA_ROOT` 是**权威值**：壳已经算好并显式告知，就不能再拿
 * `LOCALAPPDATA` 重新推导一遍 —— 两者不一致时（测试注入、便携启动器、
 * 用户改过 LOCALAPPDATA）重新推导会把环境建到错误的位置。
 */
export function environmentProductRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platformPath(platform);
  const declared = env.DSH_EAC_DATA_ROOT?.trim();
  if (declared) return api.resolve(declared);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const base = platform === 'win32'
    ? (env.LOCALAPPDATA || api.join(home, 'AppData', 'Local'))
    : (env.XDG_DATA_HOME || api.join(home, '.local', 'share'));
  return api.join(base, DEFAULT_ENVIRONMENT_PRODUCT);
}

/** dpx 的 storageRoot：产品数据根下的 `dpx`。 */
export function environmentStorageRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platformPath(platform);
  const explicit = env.DSH_EAC_DPX_ROOT?.trim();
  if (explicit) return api.resolve(explicit);
  return api.join(environmentProductRoot(env, platform), 'dpx');
}

/**
 * dpx 的注册表目录（DPX_HOME）。
 *
 * 与 dpx 的机器级默认保持一致：Windows `%LOCALAPPDATA%\DSH\DPX`，
 * 其它平台 `$XDG_STATE_HOME/dsh-dpx`。之所以显式传，是因为子进程的
 * `LOCALAPPDATA` 会被 dpx 隔离到环境根内，不显式指路就会得到一个空的私有注册表。
 */
export function environmentRegistryHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platformPath(platform);
  const explicit = env.DSH_EAC_DPX_REGISTRY_HOME?.trim();
  if (explicit) return api.resolve(explicit);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || api.join(home, 'AppData', 'Local');
    return api.join(localAppData, 'DSH', 'DPX');
  }
  const stateHome = env.XDG_STATE_HOME || api.join(home, '.local', 'state');
  return api.join(stateHome, 'dsh-dpx');
}

/**
 * 环境根 = `storageRoot/dsh-environments/<name>`（与 dpx environmentRoot() 同式）。
 * 仅供日志、descriptor 与诊断使用；真值仍以 dpx 返回的 `paths.root` 为准。
 */
export function environmentRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = platformPath(platform);
  return api.join(environmentStorageRoot(env, platform), 'dsh-environments', environmentName(env));
}

/** 当前生效的隔离根（优先 dpx 注入的身份变量），供 UI/诊断展示。 */
export function activeEnvironmentRoot(env: NodeJS.ProcessEnv = process.env): string {
  const declared = env.DSH_DPX_ENV_ROOT?.trim();
  if (declared) return path.resolve(declared);
  const dshHome = env.DSH_HOME?.trim();
  if (dshHome) return path.dirname(path.resolve(dshHome));
  return environmentRoot(env);
}

/** 定位固定提交的 dsh-dpx 模块文件（打包态 / 开发态 / 显式覆盖）。 */
export function dpxModuleFile(env: NodeJS.ProcessEnv = process.env): string {
  const candidates: string[] = [];
  // 显式覆盖（DSH_DPX_ROOT / DSH_RESOURCE_ROOT）是**唯一**来源：指了就只认它，
  // 缺失即失败。否则一个写错的根会被静默替换成仓库里的开发副本，让打包态
  // 假装配上了 dpx。
  const explicit = env.DSH_DPX_ROOT?.trim();
  if (explicit) {
    const file = path.join(path.resolve(explicit), 'src', 'index.js');
    if (!fs.existsSync(file)) throw new Error(`dsh-dpx 模块缺失（DSH_DPX_ROOT=${explicit}）：${file}`);
    return file;
  }
  const resourceRoot = env.DSH_RESOURCE_ROOT?.trim();
  if (resourceRoot) {
    const file = path.join(path.resolve(resourceRoot), 'dpx', 'src', 'index.js');
    if (!fs.existsSync(file)) throw new Error(`dsh-dpx 模块缺失（DSH_RESOURCE_ROOT=${resourceRoot}）：${file}`);
    return file;
  }
  // 开发态：lib/desktop → 仓库根/dsh-desktop → 仓库根 → third_party/dsh-dpx。
  candidates.push(path.resolve(__dirname, '..', '..', 'third_party', 'dsh-dpx', 'src', 'index.js'));
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'third_party', 'dsh-dpx', 'src', 'index.js'));
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error(`dsh-dpx 模块缺失（已尝试：${candidates.join(' | ')}）`);
}

/** dpx 的公开入口只允许这几种形态；避免把任意路径当模块加载。 */
function assertDpxModuleTarget(moduleFile: string): void {
  const stat = fs.statSync(moduleFile); // 缺失时抛错 → fail closed
  if (!stat.isFile()) throw new Error(`dsh-dpx 模块不是文件：${moduleFile}`);
}

interface DpxBootstrapResult {
  record: Record<string, unknown>;
  paths: DpxPaths;
  runtime: NodeJS.ProcessEnv;
}

/**
 * 在**隔离子进程**里调用 dpx API。
 *
 * 为什么用子进程：dsh-dpx 是 ESM 包（`"type": "module"`），而 sidecar 是就地编译的
 * CommonJS；动态 `import()` 无法被 tsc 降级为 `require`，直接 import 会让打包态
 * 依赖 CJS loader 的 ESM 互操作细节。子进程边界同时给了第三个好处——
 * dpx 自己抛出的错误会完整带到 stderr，不会被吞掉。
 *
 * P1 起不再写死一段脚本：`operation` 决定调用哪个 dpx API（create / diagnose /
 * repair / remove），但**所有 dpx 侧逻辑仍然只在 dpx 里**——适配层只负责
 * 传参、收 JSON、把失败原样抛出。新增动作必须走同一入口，避免出现第二套实现。
 */
type DpxOperation = 'create' | 'diagnose' | 'remove';

function runDpxCall(input: {
  moduleFile: string;
  operation: DpxOperation;
  name: string;
  storageRoot: string;
  registryHome: string;
  platform: NodeJS.Platform;
  inherited: NodeJS.ProcessEnv;
  purge?: boolean;
}): Record<string, unknown> {
  // ESM 加载器只接受 file:/data:/node: 方案；Windows 盘符路径必须转成 file URL，
  // 否则 `await import('D:\\...')` 会以 ERR_UNSUPPORTED_ESM_URL_SCHEME 失败。
  const moduleUrl = url.pathToFileURL(input.moduleFile).href;
  const call = input.operation === 'create'
    ? "const record = await dpx.createEnvironment({ name: input.name, storageRoot: input.storageRoot, home: input.registryHome, desktop: false, publishDiscovery: false, platform: input.platform });\n"
      + "const paths = dpx.pathsFor(record.root);\n"
      + "const runtime = dpx.runtimeEnvironment(paths, input.inherited, { name: record.name, registryHome: input.registryHome });\n"
      + "output = { record, paths, runtime };"
    : input.operation === 'diagnose'
      ? // 只读诊断：注册表 + 环境清单 + 环境根是否可认领。绝不写盘。
        "const registryRead = await dpx.readRegistryReport(input.registryHome);\n"
        + "const manifestRead = dpx.environmentManifestReport(dpx.environmentRoot(input.storageRoot, input.name));\n"
        + "output = {\n"
        + "  registryReadable: registryRead.registry !== undefined,\n"
        + "  registry: registryRead.registry,\n"
        + "  registryProblems: registryRead.problems.map(p => ({ code: p.code, path: p.path, message: p.message, text: dpx.describeDamage(p) })),\n"
        + "  manifest: manifestRead.manifest === undefined ? null : manifestRead.manifest,\n"
        + "  manifestPath: manifestRead.path,\n"
        + "  manifestProblem: manifestRead.read.ok ? null : { code: manifestRead.read.problem.code, path: manifestRead.read.problem.path, message: manifestRead.read.problem.message, text: dpx.describeDamage(manifestRead.read.problem) },\n"
        + "  expectedRoot: dpx.environmentRoot(input.storageRoot, input.name),\n"
        + "};"
      : // remove：dryRun 只出计划；purge 决定是否连环境根一起删。不迁移、不复制凭据。
        "const plan = await dpx.environmentRemovalPlan({ name: input.name, home: input.registryHome, purge: input.purge === true, platform: input.platform });\n"
        + "const result = await dpx.removeEnvironment({ name: input.name, home: input.registryHome, purge: input.purge === true, dryRun: false, platform: input.platform });\n"
        + "output = { plan, purged: result.purged, dryRun: false };";
  const script = [
    "import fs from 'node:fs';",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "const dpx = await import(input.moduleUrl);",
    "let output;",
    // dpx 的权威路径：失败（损坏注册表 / 非空未注册目录 / 已注册到别处）必须抛出。
    call,
    "process.stdout.write(JSON.stringify(output));",
  ].join('\n');
  const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    input: JSON.stringify({ ...input, moduleUrl }),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    // 只转发路径/身份类变量，不改写父进程语义。
    env: { ...process.env, DSH_DPX_BOOTSTRAP: '1' },
  });
  if (result.error) throw new Error(`dsh-dpx 初始化无法启动：${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    // create 保持 v1 文案（「环境初始化失败」）—— 它是最常被用户看到的失败，
    // 既有文档/测试/支持话术都按这句定位；其余动作才带动作名。
    const label = input.operation === 'create' ? '环境初始化失败' : input.operation + ' 失败';
    throw new Error(`dsh-dpx ${label}${detail ? `：${detail}` : ''}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout));
  } catch (error) {
    throw new Error(`dsh-dpx 返回了非 JSON 引导数据：${String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`dsh-dpx ${input.operation} 返回了非法数据`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * 创建或复用当前通道的 dpx 环境。
 *
 * 失败一律抛出（fail closed）：调用方不得捕获后回退到宿主 `~/.dsh`。
 */
export function ensureEacEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EnsuredEnvironment {
  const moduleFile = dpxModuleFile(env);
  assertDpxModuleTarget(moduleFile);
  const storageRoot = environmentStorageRoot(env, platform);
  const registryHome = environmentRegistryHome(env, platform);
  const name = environmentName(env);
  const expectedRoot = environmentRoot(env, platform);
  const rootExistedBefore = fs.existsSync(expectedRoot);

  const result = runDpxCall({
    moduleFile,
    operation: 'create',
    name,
    storageRoot,
    registryHome,
    platform,
    // JSON serialization loses Windows process.env's case-insensitive lookup.
    inherited: platform === 'win32' ? { ...env, PATH: env.PATH ?? env.Path } : env,
  }) as Partial<DpxBootstrapResult>;

  if (!result.record || !result.paths || !result.runtime) {
    throw new Error('dsh-dpx 引导数据不完整（缺少 record/paths/runtime）');
  }
  if (typeof result.paths.dshHome !== 'string' || typeof result.paths.root !== 'string') {
    throw new Error('dsh-dpx 引导数据缺少 paths.root/paths.dshHome');
  }
  // dpx 已保证路径与 storageRoot/name 一致；这里只做「没说谎」的断言，
  // 防止适配层被换成别的实现后静默指到别处。
  const api = platformPath(platform);
  if (api.resolve(result.paths.root) !== api.resolve(expectedRoot)) {
    throw new Error(`dsh-dpx 返回了意外的环境根：${result.paths.root}（期望 ${expectedRoot}）`);
  }
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const legacyDshHome = path.join(home, '.dsh');
  return {
    record: result.record,
    paths: result.paths,
    runtime: result.runtime,
    storageRoot,
    registryHome,
    name,
    channel: environmentChannel(env),
    rootExistedBefore,
    legacyDshHome,
    legacyProfileDetected: fs.existsSync(path.join(legacyDshHome, 'profiles', DEFAULT_DESKTOP_PROFILE)),
  };
}

/**
 * 把 dpx 的 runtime 环境应用到目标进程环境。
 *
 * dpx 的 `runtimeEnvironment()` 是**全量**结果：它按设计清掉了会被误认成宿主
 * 配置的继承变量（`NODE_OPTIONS`/`NODE_PATH`、代理、`NPM_CONFIG_PREFIX`/`NPM_CONFIG_CACHE`）。
 * 若只做赋值不清删除，父进程遗留的这些变量会继续生效，隔离就是假的。
 */
export function applyRuntimeEnvironment(runtime: NodeJS.ProcessEnv, target: NodeJS.ProcessEnv = process.env): void {
  for (const key of Object.keys(target)) {
    if (!(key in runtime)) delete target[key];
  }
  for (const [key, value] of Object.entries(runtime)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}


// ---------------------------------------------------------------------------
// P1：环境运维闭环（诊断 / 清理 / 移除）
//
// 边界（ADR 0004 + 核心红线）：修环境这件事本身属于 dsh-dpx。EAC 只做两件事：
//   1. 把 dpx 的**只读**诊断结果翻译成 UI 能显示的状态对象；
//   2. 把用户的 repair/remove 意图原样转给 dpx 的既有 API。
// EAC 不实现自己的注册表重写、不删目录、不动宿主 `~/.dsh`。
// ---------------------------------------------------------------------------

/** 单个损坏问题的可显示形态（来自 dpx describeDamage / 结构化 problem）。 */
export interface EnvironmentProblem {
  code: string;
  path: string;
  message: string;
  /** dpx 的中文描述（describeDamage），UI 直接显示这一句。 */
  text: string;
}

export interface EnvironmentDiagnosis {
  /** 产品数据根 / storageRoot / 注册表 / 期望环境根（UI 与支持人员定位用）。 */
  productRoot: string;
  storageRoot: string;
  registryHome: string;
  registryFile: string;
  expectedRoot: string;
  name: string;
  channel: string;
  /** 注册表是否可读（损坏时为 false，此时 problems 说明原因）。 */
  registryReadable: boolean;
  /** 环境根目录是否存在（存在但无清单 = 可能被外部创建/半截安装）。 */
  rootExists: boolean;
  /** 环境清单（.dpx-environment.json）是否存在且合法。 */
  manifestPresent: boolean;
  manifest: Record<string, unknown> | null;
  /** 本环境是否已登记在注册表里。 */
  registered: boolean;
  /** 全部问题（注册表 + 清单）。空数组 = 健康。 */
  problems: EnvironmentProblem[];
  /**
   * 是否允许 `removeEacEnvironment({ purge: true })`：
   * 只有「已登记」才允许 —— dpx 的移除以注册表记录为锚点，
   * 未登记的目录属于别人，EAC 不碰。
   */
  removable: boolean;
  /** 宿主旧 profile：只提示，不迁移、不删除、不覆盖。 */
  legacyDshHome: string;
  legacyProfileDetected: boolean;
}

function toProblem(raw: unknown): EnvironmentProblem {
  const value = (raw ?? {}) as { code?: unknown; path?: unknown; message?: unknown; text?: unknown };
  const code = String(value.code ?? 'unknown');
  const at = String(value.path ?? '');
  const message = String(value.message ?? '');
  const described = typeof value.text === 'string' && value.text ? value.text : '';
  return {
    code,
    path: at,
    message,
    text: described || code + '：' + at + (message ? '（' + message + '）' : ''),
  };
}

/**
 * 只读诊断当前通道的环境（不写盘、不创建、不修复）。
 *
 * 这是「损坏环境可诊断」的入口：sidecar 的 `environment.status` RPC 调它，
 * UI 拿到的是结构化状态而不是一段日志。诊断本身不因损坏而抛出 ——
 * 损坏正是它要报告的内容；只有 dpx 模块本身不可用才抛（fail closed）。
 */
export function diagnoseEacEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EnvironmentDiagnosis {
  const moduleFile = dpxModuleFile(env);
  assertDpxModuleTarget(moduleFile);
  const storageRoot = environmentStorageRoot(env, platform);
  const registryHome = environmentRegistryHome(env, platform);
  const name = environmentName(env);
  const expectedRoot = environmentRoot(env, platform);

  const result = runDpxCall({
    moduleFile,
    operation: 'diagnose',
    name,
    storageRoot,
    registryHome,
    platform,
    inherited: env,
  });

  const registryProblems = Array.isArray(result.registryProblems) ? result.registryProblems.map(toProblem) : [];
  // 可读性以 dpx 是否返回 registry 对象为准：readRegistryReport 在**缺失**时给一个
  // 空 registry（仍算可读），只有 unreadable/damaged 才给 undefined。早期实现按
  //「问题数是否为 0」判断，会把「损坏」误报成「可读」（回归测试抓到过）。
  // 注册表不可读时登记状态是「未知」而非「未登记」；两者对 removable 结论一致
  //（都拒绝移除），但 UI 文案不同，故显式置 false。
  const registryReadable = result.registryReadable === true;
  const registry = (result.registry ?? null) as { environments?: Array<{ name?: string }> } | null;
  const registered = registryReadable && Boolean(
    registry && Array.isArray(registry.environments)
    && registry.environments.some((row) => row && row.name === name),
  );
  const manifest = (result.manifest ?? null) as Record<string, unknown> | null;
  const manifestProblem = result.manifestProblem ? [toProblem(result.manifestProblem)] : [];
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const legacyDshHome = path.join(home, '.dsh');

  return {
    productRoot: environmentProductRoot(env, platform),
    storageRoot,
    registryHome,
    registryFile: path.join(registryHome, 'registry.json'),
    expectedRoot,
    name,
    channel: environmentChannel(env),
    registryReadable,
    rootExists: fs.existsSync(expectedRoot),
    manifestPresent: manifest !== null,
    manifest,
    registered,
    problems: [...registryProblems, ...manifestProblem],
    // 未登记（无论目录是否非空）一律不可移除 —— 那是别人的数据。
    removable: registered && registryReadable,
    legacyDshHome,
    legacyProfileDetected: fs.existsSync(path.join(legacyDshHome, 'profiles', DEFAULT_DESKTOP_PROFILE)),
  };
}

/** 移除计划（dry run）：UI 在执行前展示「会删什么」，避免误操作。 */
export interface EnvironmentRemovalPlan {
  name: string;
  registryFile: string;
  // exactOptionalPropertyTypes 下「可能显式赋值 undefined」必须写进类型，
  // 否则 dpx 缺字段时无法如实回传「未知」而不是编造 0。
  registryRevision: { from?: number | undefined; to?: number | undefined };
  remainingRecords?: number | undefined;
  root: { path?: string | undefined; exists?: boolean | undefined; action?: string | undefined; includes?: unknown[] | undefined };
  purge: boolean;
  /** dpx 原始计划（原样回传，UI/支持人员可展开完整细节）。 */
  raw: Record<string, unknown>;
}

export interface EnvironmentRemoveResult {
  removed: boolean;
  purged: boolean;
  plan: EnvironmentRemovalPlan | null;
  /** 环境根是否仍存在（purge=false 时应为 true）。 */
  rootStillExists: boolean;
}

function toRemovalPlan(raw: unknown, purge: boolean): EnvironmentRemovalPlan {
  const plan = (raw ?? {}) as {
    name?: unknown;
    home?: unknown;
    purge?: unknown;
    registry?: { path?: unknown; revision?: { from?: unknown; to?: unknown }; remainingRecords?: unknown };
    root?: { path?: unknown; exists?: unknown; action?: unknown; includes?: unknown[] };
  };
  return {
    name: String(plan.name ?? ''),
    registryFile: String(plan.registry?.path ?? ''),
    registryRevision: {
      from: typeof plan.registry?.revision?.from === 'number' ? plan.registry.revision.from : undefined,
      to: typeof plan.registry?.revision?.to === 'number' ? plan.registry.revision.to : undefined,
    },
    remainingRecords: typeof plan.registry?.remainingRecords === 'number' ? plan.registry.remainingRecords : undefined,
    root: {
      path: plan.root?.path === undefined ? undefined : String(plan.root.path),
      exists: typeof plan.root?.exists === 'boolean' ? plan.root.exists : undefined,
      action: plan.root?.action === undefined ? undefined : String(plan.root.action),
      includes: Array.isArray(plan.root?.includes) ? plan.root.includes : undefined,
    },
    purge,
    raw: (raw ?? {}) as Record<string, unknown>,
  };
}

/**
 * 移除当前通道的环境记录，可选 `purge` 连环境根一起删。
 *
 * 安全约束（与 dpx 的 environmentRemovalPlan 对齐）：
 *   - 只有**已登记**的环境能被移除；未登记目录（哪怕非空）一律拒绝；
 *   - 不迁移、不复制凭据、不动宿主旧 `~/.dsh`；
 *   - `purge: false` 只摘注册表记录，保留环境根数据（可人工检查/再次接管）。
 *
 * 刻意做成「显式动作」：环境损坏时默认路径仍是 fail-closed + 诊断，
 * 删除数据永远是用户显式发起的操作。
 */
export function removeEacEnvironment(
  options: { purge?: boolean; dryRun?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EnvironmentRemoveResult {
  const purge = options.purge === true;
  const dryRun = options.dryRun === true;
  const moduleFile = dpxModuleFile(env);
  assertDpxModuleTarget(moduleFile);
  const storageRoot = environmentStorageRoot(env, platform);
  const registryHome = environmentRegistryHome(env, platform);
  const name = environmentName(env);
  const expectedRoot = environmentRoot(env, platform);

  if (dryRun) {
    // dry run 只读：不调 removeEnvironment（那会真的摘记录），而是直接问 dpx 要计划。
    // 失败原样抛出 —— 未登记的环境不给计划，正是「拒绝接管」的表达。
    const moduleUrl = url.pathToFileURL(moduleFile).href;
    const script = [
      "import fs from 'node:fs';",
      "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
      "const dpx = await import(input.moduleUrl);",
      "const plan = await dpx.environmentRemovalPlan({ name: input.name, home: input.registryHome, purge: input.purge === true, platform: input.platform });",
      "process.stdout.write(JSON.stringify({ plan }));",
    ].join('\n');
    const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      input: JSON.stringify({ name, registryHome, purge, platform, moduleUrl }),
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DSH_DPX_BOOTSTRAP: '1' },
    });
    if (result.error) throw new Error('dsh-dpx 移除计划无法启动：' + result.error.message);
    if (result.status !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim();
      throw new Error('dsh-dpx 移除计划失败（未登记的环境拒绝接管）' + (detail ? '：' + detail : ''));
    }
    let parsed: { plan?: unknown };
    try {
      parsed = JSON.parse(String(result.stdout)) as { plan?: unknown };
    } catch (error) {
      throw new Error('dsh-dpx 移除计划返回了非 JSON 数据：' + String(error));
    }
    return {
      removed: false,
      purged: false,
      plan: toRemovalPlan(parsed.plan, purge),
      rootStillExists: fs.existsSync(expectedRoot),
    };
  }

  const result = runDpxCall({
    moduleFile,
    operation: 'remove',
    name,
    storageRoot,
    registryHome,
    platform,
    inherited: env,
    purge,
  });
  return {
    removed: true,
    purged: result.purged === true,
    plan: result.plan ? toRemovalPlan(result.plan, purge) : null,
    rootStillExists: fs.existsSync(expectedRoot),
  };
}
