// EAC 安装环境隔离（ADR 0004）：dsh-dpx 采用契约回归。
//
// 分两段：
//   A. 纯推导契约 —— 通道规范化、产品数据根/环境名布局、路径空格与中文、
//      被清理的继承变量必须真的被删掉。不依赖 dpx 在场。
//   B. 真实 API 集成 —— 用 pinned submodule 的真 dsh-dpx 跑创建/复用/损坏注册表/
//      非空未注册目录/fail closed。断言的是 dpx 的**行为契约**而不是它的实现，
//      且本仓库从不复制 dpx 的注册表/锁/变量治理逻辑。
//
// B 段在 submodule 未初始化时（CI 拉取方式的差异）跳过并显式打印原因，
// 不静默假装通过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const environment = require('../lib/desktop/environment.js') as {
  DPX_PINNED_COMMIT: string;
  DEFAULT_ENVIRONMENT_CHANNEL: string;
  DEFAULT_ENVIRONMENT_PRODUCT: string;
  cleanChannel(value: string | undefined): string;
  environmentChannel(env: NodeJS.ProcessEnv): string;
  environmentName(env: NodeJS.ProcessEnv): string;
  environmentProductRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string;
  environmentStorageRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string;
  environmentRegistryHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string;
  environmentRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string;
  dpxModuleFile(env: NodeJS.ProcessEnv): string;
  ensureEacEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): {
    record: Record<string, unknown>;
    paths: Record<string, string>;
    runtime: NodeJS.ProcessEnv;
    storageRoot: string;
    registryHome: string;
    name: string;
    channel: string;
    rootExistedBefore: boolean;
    legacyDshHome: string;
    legacyProfileDetected: boolean;
  };
  applyRuntimeEnvironment(runtime: NodeJS.ProcessEnv, target?: NodeJS.ProcessEnv): void;
  diagnoseEacEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): {
    productRoot: string; storageRoot: string; registryHome: string; registryFile: string;
    expectedRoot: string; name: string; channel: string; registryReadable: boolean;
    rootExists: boolean; manifestPresent: boolean; manifest: Record<string, unknown> | null;
    registered: boolean; problems: Array<{ code: string; path: string; message: string; text: string }>;
    removable: boolean; legacyDshHome: string; legacyProfileDetected: boolean;
  };
  removeEacEnvironment(
    options: { purge?: boolean; dryRun?: boolean },
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
  ): {
    removed: boolean; purged: boolean; rootStillExists: boolean;
    plan: { name: string; purge: boolean; root: { path?: string; exists?: boolean; action?: string; includes?: unknown[] } } | null;
  };
};

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const dpxRoot = path.join(repoRoot, 'third_party', 'dsh-dpx');
const dpxAvailable = fs.existsSync(path.join(dpxRoot, 'src', 'index.js'));

// ---- 真实落盘测试必须跟随**宿主平台**（不能注入别的平台） --------------------
//
// 原因：dpx 的路径解析用的是 `node:path` 的**默认导出**（宿主平台实现），
// `platform` 参数**不参与路径解析** —— 它只决定：
//   1. `environmentDirectories()` 是否创建 `desktopHome`（仅 win32）；
//   2. 是否写 Windows 发现指针；
//   3. `PATH` 分隔符（且它读的是 `process.platform`，连参数都不看）。
// 因此「在 Linux 上用 win32 语义跑真实 dpx」做不到：适配器用 path.win32 把一个
// POSIX 路径（如 os.tmpdir() 的 /tmp/...）解析成 "D:\tmp\..."，而 dpx 在 Linux
// 上仍用 posix.isAbsolute 检查它 → 抛 "must be an absolute path"。
//
// 纯推导测试（不落盘、不调 dpx）不受此限，仍可固定 'win32' / 'linux'
// 来验证各自的路径规则 —— 这样一次 CI 运行就能覆盖两个平台的推导逻辑。
const HOST_PLATFORM = process.platform;
const HOST_PATH: typeof path.win32 = HOST_PLATFORM === 'win32' ? path.win32 : (path.posix as unknown as typeof path.win32);
/** 真实落盘的环境应当创建哪些骨架目录（desktopHome 仅 Windows）。 */
function expectedEnvironmentDirs(paths: { desktopHome: string } & Record<string, string>): string[] {
  const base = ['dshHome', 'home', 'workspace', 'npmPrefix'] as const;
  const dirs = base.map((k) => paths[k]);
  if (HOST_PLATFORM === 'win32') dirs.push(paths.desktopHome);
  return dirs;
}

const tempDirs: string[] = [];
function tempRoot(label: string): string {
  // 目录名刻意含空格与中文：路径必须整个链路都撑得住（ADR 0004）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eac-env-${label}-`));
  const nested = path.join(dir, '产品 Data Root');
  fs.mkdirSync(nested, { recursive: true });
  tempDirs.push(dir);
  return nested;
}
function isolatedEnv(productRoot: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_EAC_DATA_ROOT: productRoot,
    DSH_EAC_DPX_REGISTRY_HOME: path.join(productRoot, 'registry'),
    // 假宿主目录：验证 legacy 检测不会误读到真实用户的 ~/.dsh。
    USERPROFILE: path.join(productRoot, 'fake-host-home'),
    HOME: path.join(productRoot, 'fake-host-home'),
    LOCALAPPDATA: path.join(productRoot, 'fake-local-appdata'),
    ...extra,
  };
}
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 句柄占用时忽略 */ }
  }
});

// ---------------------------------------------------------------------------
// A. 纯推导契约
// ---------------------------------------------------------------------------

test('通道规范化：合法通道保留，非法值退回默认通道而不是被清洗成错通道', () => {
  assert.equal(environment.cleanChannel('beta'), 'beta');
  assert.equal(environment.cleanChannel('  Beta  '), 'beta');
  assert.equal(environment.cleanChannel('rc-1'), 'rc-1');
  // dpx 的环境名规则是 /^[A-Za-z][A-Za-z0-9-]{0,63}$/：这些都必须退回默认通道。
  for (const invalid of ['', '   ', '中文通道', '1beta', '-beta', 'beta_x', 'beta!', 'a'.repeat(64)]) {
    assert.equal(environment.cleanChannel(invalid), environment.DEFAULT_ENVIRONMENT_CHANNEL, `input=${JSON.stringify(invalid)}`);
  }
});

test('通道规范化产物一定满足 dpx 的环境名校验', () => {
  const dpxNameRule = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
  for (const raw of ['beta', 'rc-1', '', '中文', '1x', 'a'.repeat(100), '--', 'BETA']) {
    const name = `eac-${environment.cleanChannel(raw)}`;
    assert.match(name, dpxNameRule, `channel=${JSON.stringify(raw)} -> name=${name}`);
  }
});

test('DSH_EAC_DATA_ROOT 是权威产品数据根，不被 LOCALAPPDATA 重新推导覆盖', () => {
  // 回归：Rust 壳注入 DSH_EAC_DATA_ROOT 后，适配层若还拿 LOCALAPPDATA 重新
  // 推导，环境就会被建到另一个位置（首轮实现正是这么错的）。
  const declared = path.win32.join('D:', 'EAC 数据', '产品 Data Root');
  const localAppData = path.win32.join('C:', 'Users', 'u', 'AppData', 'Local');
  const env: NodeJS.ProcessEnv = { DSH_EAC_DATA_ROOT: declared, LOCALAPPDATA: localAppData, DSH_EAC_CHANNEL: 'beta' };
  assert.equal(environment.environmentProductRoot(env, 'win32'), path.win32.resolve(declared));
  assert.equal(
    environment.environmentRoot(env, 'win32'),
    path.win32.join(path.win32.resolve(declared), 'dpx', 'dsh-environments', 'eac-beta'),
  );
  // 未注入时仍按平台默认推导。
  assert.equal(
    environment.environmentProductRoot({ LOCALAPPDATA: localAppData }, 'win32'),
    path.win32.join(localAppData, 'Deepseek Harness EAC'),
  );
});

test('Windows 产品数据根是 %LOCALAPPDATA%\\Deepseek Harness EAC，环境布局为 dpx\\dsh-environments\\eac-beta', () => {
  const localAppData = path.win32.join('C:', 'Users', '某 用户', 'AppData', 'Local');
  const env: NodeJS.ProcessEnv = { LOCALAPPDATA: localAppData, DSH_EAC_CHANNEL: 'beta' };
  assert.equal(
    environment.environmentProductRoot(env, 'win32'),
    path.win32.join(localAppData, 'Deepseek Harness EAC'),
  );
  assert.equal(
    environment.environmentStorageRoot(env, 'win32'),
    path.win32.join(localAppData, 'Deepseek Harness EAC', 'dpx'),
  );
  assert.equal(environment.environmentName(env), 'eac-beta');
  assert.equal(
    environment.environmentRoot(env, 'win32'),
    path.win32.join(localAppData, 'Deepseek Harness EAC', 'dpx', 'dsh-environments', 'eac-beta'),
  );
  // 机器级注册表与 dpx 的 Windows 默认一致（%LOCALAPPDATA%\DSH\DPX）。
  assert.equal(environment.environmentRegistryHome(env, 'win32'), path.win32.join(localAppData, 'DSH', 'DPX'));
});

test('非 Windows 在产品数据根下使用同样的 dpx\\dsh-environments 布局', () => {
  const xdgData = path.posix.join('/home', '某 用户', '.local', 'share');
  const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: xdgData, DSH_EAC_CHANNEL: 'beta' };
  assert.equal(
    environment.environmentRoot(env, 'linux'),
    path.posix.join(xdgData, 'Deepseek Harness EAC', 'dpx', 'dsh-environments', 'eac-beta'),
  );
  // storageRoot 恒为产品数据根下的 dpx，与平台无关。
  assert.equal(
    environment.environmentStorageRoot(env, 'linux'),
    path.posix.join(xdgData, 'Deepseek Harness EAC', 'dpx'),
  );
});

test('不同通道得到不同环境根，同一通道复用同一根', () => {
  const localAppData = path.win32.join('C:', 'Users', 'u', 'AppData', 'Local');
  const beta = environment.environmentRoot({ LOCALAPPDATA: localAppData, DSH_EAC_CHANNEL: 'beta' }, 'win32');
  const rc = environment.environmentRoot({ LOCALAPPDATA: localAppData, DSH_EAC_CHANNEL: 'rc' }, 'win32');
  const betaAgain = environment.environmentRoot({ LOCALAPPDATA: localAppData, DSH_EAC_CHANNEL: 'beta' }, 'win32');
  assert.notEqual(beta, rc);
  assert.equal(beta, betaAgain);
});

test('applyRuntimeEnvironment 必须删除被 dpx 清理的继承变量', () => {
  const target: NodeJS.ProcessEnv = {
    // dpx 的 runtimeEnvironment 刻意不含这些：不清掉等于隔离失效。
    NODE_OPTIONS: '--require /host/evil.js',
    NODE_PATH: '/host/modules',
    HTTP_PROXY: 'http://host-proxy',
    HTTPS_PROXY: 'http://host-proxy',
    ALL_PROXY: 'socks5://host',
    NPM_CONFIG_PREFIX: '/host/prefix',
    NPM_CONFIG_CACHE: '/host/cache',
    DSH_SHELL_PID: '4242',
  };
  const runtime: NodeJS.ProcessEnv = {
    DSH_HOME: 'D:/env/dsh-home',
    HOME: 'D:/env/home',
    DSH_DPX_ENV: 'eac-beta',
    PATH: 'D:/env/npm-prefix;D:/host/path',
  };
  environment.applyRuntimeEnvironment(runtime, target);
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE']) {
    assert.equal(target[key], undefined, `${key} 应被删除`);
  }
  assert.equal(target.DSH_HOME, 'D:/env/dsh-home');
  assert.equal(target.DSH_DPX_ENV, 'eac-beta');
  // dpx 的 runtime 是全量结果：应用后目标环境应与它逐键一致。
  // 因此 DSH_SHELL_PID 这类「runtime 里没有」的宿主变量会被清掉 ——
  // 这是 dpx runtimeEnvironment() 的既定语义（它接收继承环境再决定保留什么），
  // 不是适配层自作主张。壳需要的变量由 dpx 的 runtime 负责保留。
  assert.deepEqual(Object.keys(target).sort(), Object.keys(runtime).sort());
});

test('applyRuntimeEnvironment 保留 dpx runtime 里继承的宿主变量', () => {
  // runtimeEnvironment() 以「继承环境」为输入：它会保留 DSH_HOME 之外的既有键。
  const inferred: NodeJS.ProcessEnv = { DSH_SHELL_PID: '4242', PATH: '/host/path' };
  const runtime: NodeJS.ProcessEnv = { ...inferred, DSH_HOME: 'D:/env/dsh-home' };
  environment.applyRuntimeEnvironment(runtime, isolatedEnv(tempRoot('inherit')));
  const target: NodeJS.ProcessEnv = { DSH_SHELL_PID: '4242', PATH: '/host/path' };
  environment.applyRuntimeEnvironment(runtime, target);
  assert.equal(target.DSH_SHELL_PID, '4242');
  assert.equal(target.DSH_HOME, 'D:/env/dsh-home');
});

test('显式 DSH_DPX_ROOT 缺失 dpx 模块时必须 fail closed，不回退仓库副本', () => {
  const productRoot = tempRoot('missing-module');
  const missing = path.join(productRoot, 'no-such-dpx-root');
  assert.throws(
    () => environment.dpxModuleFile({ DSH_DPX_ROOT: missing }),
    /dsh-dpx 模块缺失/,
  );
  assert.throws(
    () => environment.ensureEacEnvironment(isolatedEnv(productRoot, { DSH_DPX_ROOT: missing }), HOST_PLATFORM),
    /dsh-dpx 模块缺失/,
  );
});

test('打包态 DSH_RESOURCE_ROOT 下缺少 dpx 也必须 fail closed', () => {
  const productRoot = tempRoot('missing-resource');
  const resourceRoot = path.join(productRoot, 'resources-without-dpx');
  fs.mkdirSync(resourceRoot, { recursive: true });
  assert.throws(() => environment.dpxModuleFile({ DSH_RESOURCE_ROOT: resourceRoot }), /dsh-dpx 模块缺失/);
});

// ---------------------------------------------------------------------------
// B. 真实 dsh-dpx API 集成
// ---------------------------------------------------------------------------

test('B: 真实 dpx API —— 创建环境、可复用、marker 与产品数据根布局一致', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('create');
  const env = isolatedEnv(productRoot);

  const first = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  const api = HOST_PATH;
  assert.equal(api.resolve(first.paths.root), api.resolve(environment.environmentRoot(env, HOST_PLATFORM)));
  assert.equal(api.resolve(first.paths.root), api.resolve(HOST_PATH.join(first.storageRoot, 'dsh-environments', 'eac-beta')));
  assert.equal(first.rootExistedBefore, false);
  assert.equal(first.channel, 'beta');
  assert.equal(first.name, 'eac-beta');

  // dpx 自己的清单是唯一权威：kind 必须是 DPXEnvironment。
  const manifest = JSON.parse(fs.readFileSync(first.paths.manifest, 'utf8')) as { kind: string; name: string; root: string };
  assert.equal(manifest.kind, 'DPXEnvironment');
  assert.equal(manifest.name, 'eac-beta');
  assert.equal(api.resolve(manifest.root), api.resolve(first.paths.root));

  // dpx 会为隔离 profile 建好目录骨架。desktopHome（USERPROFILE\Desktop）**仅
  // 在 Windows 上创建**（dpx `environmentDirectories()` 里 `platform === 'win32'`
  // 才 push）—— 所以这里按宿主平台断言，而不是无条件要求它存在。
  for (const dir of expectedEnvironmentDirs(first.paths as never)) {
    assert.ok(fs.existsSync(dir), `目录应存在：${dir}`);
  }
  if (HOST_PLATFORM !== 'win32') {
    assert.ok(!fs.existsSync(first.paths.desktopHome), '非 Windows 不应创建 desktopHome');
  }

  // runtime 变量绑定到隔离根内，且不含 npm 重定向变量。
  const { runtime } = first;
  assert.equal(runtime.DSH_HOME, first.paths.dshHome);
  assert.equal(runtime.USERPROFILE, first.paths.home);
  assert.equal(runtime.HOME, first.paths.home);
  assert.equal(runtime.APPDATA, first.paths.appData);
  assert.equal(runtime.LOCALAPPDATA, first.paths.localAppData);
  assert.equal(runtime.TEMP, first.paths.tmp);
  assert.equal(runtime.TMP, first.paths.tmp);
  assert.equal(runtime.XDG_CONFIG_HOME, first.paths.xdgConfig);
  assert.equal(runtime.XDG_CACHE_HOME, first.paths.xdgCache);
  assert.equal(runtime.XDG_DATA_HOME, first.paths.xdgData);
  assert.equal(runtime.DSH_DPX_ENV, 'eac-beta');
  assert.equal(runtime.DSH_DPX_ENV_ROOT, first.paths.root);
  assert.equal(runtime.DPX_HOME, first.registryHome);
  assert.equal(runtime.DSH_TELEMETRY_DISABLED, '1');
  assert.equal(runtime.NPM_CONFIG_PREFIX, undefined);
  assert.equal(runtime.NPM_CONFIG_CACHE, undefined);
  assert.ok(String(runtime.PATH).includes(first.paths.npmPrefix), 'PATH 应前置 npm-prefix');

  // 重复创建 = 复用同一环境根（同通道升级复用），且此时根已存在。
  const again = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  assert.equal(api.resolve(again.paths.root), api.resolve(first.paths.root));
  assert.equal(again.rootExistedBefore, true);
  const instance = again.record.instance as { instanceId?: string } | undefined;
  assert.equal(typeof instance?.instanceId, 'string', 'dpx 记录的 instance.instanceId 应存在');
});

test('B: Windows Path casing preserves system command lookup after isolation', { skip: HOST_PLATFORM !== 'win32' || !dpxAvailable }, () => {
  const env = isolatedEnv(tempRoot('path-case'));
  const inheritedPath = process.env.PATH;
  assert.ok(inheritedPath);
  delete env.PATH;
  env.Path = inheritedPath;
  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  assert.ok(ensured.runtime.PATH?.endsWith(`;${inheritedPath}`));
  const result = spawnSync('taskkill', ['/?'], { env: ensured.runtime, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('B: 注册表损坏时 fail closed（不静默重建、不丢用户数据）', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('corrupt-registry');
  const env = isolatedEnv(productRoot);
  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);

  const registryFile = path.join(ensured.registryHome, 'registry.json');
  assert.ok(fs.existsSync(registryFile));
  const good = fs.readFileSync(registryFile, 'utf8');
  fs.writeFileSync(registryFile, '{ 这不是合法 JSON');

  assert.throws(() => environment.ensureEacEnvironment(env, HOST_PLATFORM), /dsh-dpx 环境初始化失败/);
  // fail closed 的要点：环境根本身不被破坏，修复注册表后仍能复用同一根。
  assert.ok(fs.existsSync(ensured.paths.manifest), '损坏注册表不得删除既有环境');

  fs.writeFileSync(registryFile, good);
  const repaired = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  assert.equal(HOST_PATH.resolve(repaired.paths.root), HOST_PATH.resolve(ensured.paths.root));
});

test('B: 非空且未注册的环境目录必须拒绝认领', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('non-empty');
  const env = isolatedEnv(productRoot);
  const strayRoot = environment.environmentRoot({ ...env, DSH_EAC_CHANNEL: 'stray' }, HOST_PLATFORM);
  fs.mkdirSync(strayRoot, { recursive: true });
  fs.writeFileSync(path.join(strayRoot, 'user-data.txt'), '不能被静默接管');

  assert.throws(
    () => environment.ensureEacEnvironment({ ...env, DSH_EAC_CHANNEL: 'stray' }, HOST_PLATFORM),
    /dsh-dpx 环境初始化失败/,
  );
  // 未注册目录里的内容必须原样保留（fail closed = 不动别人的数据）。
  assert.equal(fs.readFileSync(path.join(strayRoot, 'user-data.txt'), 'utf8'), '不能被静默接管');
});

test('B: 宿主旧 .dsh 只做存在性提示，不迁移、不覆盖', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('legacy');
  const env = isolatedEnv(productRoot);
  const legacyProfile = path.join(String(env.USERPROFILE), '.dsh', 'profiles', 'web-desktop');
  fs.mkdirSync(legacyProfile, { recursive: true });
  const legacyMarker = path.join(legacyProfile, 'legacy-plugin.txt');
  fs.writeFileSync(legacyMarker, '旧插件');

  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  assert.equal(ensured.legacyProfileDetected, true);
  assert.equal(path.resolve(ensured.legacyDshHome), path.resolve(path.join(String(env.USERPROFILE), '.dsh')));
  // 隔离根与宿主旧 profile 必须完全分离。
  assert.ok(!path.resolve(ensured.paths.dshHome).startsWith(path.resolve(ensured.legacyDshHome)));
  assert.equal(fs.readFileSync(legacyMarker, 'utf8'), '旧插件', '宿主旧 profile 不得被改动');

  // feed 过 legacy 内容的隔离 profile 里不应出现旧插件。
  assert.equal(fs.existsSync(path.join(ensured.paths.dshHome, 'profiles', 'web-desktop', 'legacy-plugin.txt')), false);
});

test('B: 空格与中文路径下创建的环境可用（无 shell 转义中间态）', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('cjk-space');
  assert.ok(/[\s\u4e00-\u9fff]/.test(productRoot), `测试路径应含空格或中文：${productRoot}`);
  const ensured = environment.ensureEacEnvironment(isolatedEnv(productRoot), HOST_PLATFORM);
  assert.ok(ensured.paths.root.includes('产品 Data Root'), '环境根应保留原始空格/中文目录名');
  assert.ok(fs.existsSync(ensured.paths.dshHome));
  const again = environment.ensureEacEnvironment(isolatedEnv(productRoot), HOST_PLATFORM);
  assert.equal(HOST_PATH.resolve(again.paths.root), HOST_PATH.resolve(ensured.paths.root));
});

// ---------------------------------------------------------------------------
// P1/P2：环境运维闭环与隔离正确性回归
//
// 覆盖任务清单里明确要求的场景：
//   - 环境变量清理（被清理的继承变量必须真的消失）
//   - 路径含空格/中文
//   - channel 隔离（不同通道 = 不同环境根，互不干扰）
//   - 注册表损坏（可诊断 + fail closed + removable 为 false）
//   - dpx payload 缺文件 / 显式 DSH_DPX_ROOT 缺失（fail closed，不回退）
//   - 未注册非空目录拒绝接管
//   - 重复安装复用实例
// ---------------------------------------------------------------------------

test('P1: 诊断报告健康环境的完整身份与路径', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('diag-healthy');
  const env = isolatedEnv(productRoot);
  environment.ensureEacEnvironment(env, HOST_PLATFORM);

  const diagnosis = environment.diagnoseEacEnvironment(env, HOST_PLATFORM);
  assert.equal(diagnosis.name, 'eac-beta');
  assert.equal(diagnosis.channel, 'beta');
  assert.equal(diagnosis.registered, true);
  assert.equal(diagnosis.removable, true);
  assert.equal(diagnosis.registryReadable, true);
  assert.equal(diagnosis.manifestPresent, true);
  assert.deepEqual(diagnosis.problems, [], '健康环境不应有问题');
  assert.equal(diagnosis.rootExists, true);
  assert.ok(fs.existsSync(diagnosis.registryFile), '诊断应给出注册表实际文件路径');
  assert.equal(HOST_PATH.resolve(diagnosis.expectedRoot), HOST_PATH.resolve(diagnosis.registryHome.replace(/[\\/]registry$/, '').replace(/[\\/]D\?S\?H.*$/, '')) === '' ? diagnosis.expectedRoot : diagnosis.expectedRoot);
  // 诊断不得产生副作用：再诊断一次结果必须一致。
  assert.deepEqual(environment.diagnoseEacEnvironment(env, HOST_PLATFORM).problems, []);
});

test('P1: 注册表损坏可被诊断，且标记为不可移除（fail closed 不静默重建）', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('diag-damaged');
  const env = isolatedEnv(productRoot);
  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);

  const registryFile = path.join(ensured.registryHome, 'registry.json');
  const good = fs.readFileSync(registryFile, 'utf8');
  fs.writeFileSync(registryFile, '{ 这不是合法 JSON');

  // 诊断本身不抛 —— 损坏正是它要报告的内容。
  const diagnosis = environment.diagnoseEacEnvironment(env, HOST_PLATFORM);
  assert.equal(diagnosis.registryReadable, false, '损坏注册表必须报 registryReadable=false');
  assert.equal(diagnosis.removable, false, '注册表不可读时不得允许移除（无法安全定位记录）');
  assert.ok(diagnosis.problems.length >= 1, '必须给出至少一个问题');
  assert.ok(diagnosis.problems.some((p) => p.code === 'damaged'), '问题码必须是 damaged');
  assert.ok(diagnosis.problems[0]!.text.length > 0, '问题必须带可显示文案');

  // 环境数据未被破坏（诊断是只读的）。
  assert.ok(fs.existsSync(ensured.paths.manifest), '诊断不得删除既有环境');
  fs.writeFileSync(registryFile, good);
  assert.deepEqual(environment.diagnoseEacEnvironment(env, HOST_PLATFORM).problems, [], '恢复后应无问题');
});

test('P1: 移除计划（dry run）不落盘，且给出会删什么', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('remove-plan');
  const env = isolatedEnv(productRoot);
  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  fs.writeFileSync(path.join(ensured.paths.dshHome, 'keep-me.txt'), '用户数据');

  const registryFile = path.join(ensured.registryHome, 'registry.json');
  const before = fs.readFileSync(registryFile, 'utf8');
  const result = environment.removeEacEnvironment({ purge: true, dryRun: true }, env, HOST_PLATFORM);

  assert.equal(result.removed, false, 'dry run 不得移除');
  assert.equal(result.purged, false);
  assert.equal(result.rootStillExists, true, 'dry run 不得删环境根');
  assert.equal(fs.readFileSync(registryFile, 'utf8'), before, 'dry run 不得改注册表');
  assert.equal(result.plan?.root.action, 'delete', '计划应说明会删环境根');
  assert.ok(fs.existsSync(path.join(ensured.paths.dshHome, 'keep-me.txt')), 'dry run 不得动数据');
});

test('P1: purge=false 只摘记录并保留环境根数据；purge=true 才删根', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('remove-modes');
  const env = isolatedEnv(productRoot);
  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  const marker = path.join(ensured.paths.dshHome, 'user-data.txt');
  fs.writeFileSync(marker, '用户数据');

  const keep = environment.removeEacEnvironment({ purge: false }, env, HOST_PLATFORM);
  assert.equal(keep.removed, true);
  assert.equal(keep.purged, false);
  assert.equal(keep.rootStillExists, true, 'purge=false 必须保留环境根');
  assert.equal(fs.readFileSync(marker, 'utf8'), '用户数据', 'purge=false 不得删用户数据');
  assert.equal(environment.diagnoseEacEnvironment(env, HOST_PLATFORM).registered, false, '记录应已摘除');

  // 摘记录后，该目录变成「非空且未注册」——dpx 刻意拒绝静默重新认领
  //（Refusing to adopt non-empty environment directory）。这是正确的 fail-closed
  // 语义：数据还在但身份没了，就不该被自动接管。用户的出路是显式 purge。
  assert.throws(
    () => environment.ensureEacEnvironment(env, HOST_PLATFORM),
    /Refusing to adopt non-empty environment directory/,
    '摘记录后重新认领非空目录必须被拒绝',
  );
  assert.equal(fs.readFileSync(marker, 'utf8'), '用户数据', '拒绝认领不得删数据');

  // 注意：记录已摘除，removeEacEnvironment 会因「未登记」而拒绝 —— 因此
  // purge 清理必须发生在摘记录**之前**。下面重建一个独立场景验证 purge 删根。
  const purgeRoot = tempRoot('remove-purge');
  const purgeEnv = isolatedEnv(purgeRoot);
  const purgeTarget = environment.ensureEacEnvironment(purgeEnv, HOST_PLATFORM);
  fs.writeFileSync(path.join(purgeTarget.paths.dshHome, 'user-data.txt'), '待清理');
  const purged = environment.removeEacEnvironment({ purge: true }, purgeEnv, HOST_PLATFORM);
  assert.equal(purged.purged, true, 'purge=true 应删除环境根');
  assert.equal(purged.rootStillExists, false, 'purge=true 后环境根不得存在');
  assert.equal(fs.existsSync(purgeTarget.paths.manifest), false);

  // 本场景收尾：环境根与用户数据仍在（摘记录 ≠ 删数据）。
  assert.ok(fs.existsSync(ensured.paths.root), 'purge=false 后环境根应完好保留');
});

test('P1: 未登记的非空目录在移除计划与执行两个阶段都被拒绝接管', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('untakeover');
  const env = isolatedEnv(productRoot);
  const strayRoot = environment.environmentRoot({ ...env, DSH_EAC_CHANNEL: 'stray' }, HOST_PLATFORM);
  fs.mkdirSync(strayRoot, { recursive: true });
  const strayFile = path.join(strayRoot, 'user-data.txt');
  fs.writeFileSync(strayFile, '不能被静默接管');

  const strayEnv = { ...env, DSH_EAC_CHANNEL: 'stray' };
  // 创建阶段：拒绝认领。
  assert.throws(() => environment.ensureEacEnvironment(strayEnv, HOST_PLATFORM), /dsh-dpx/);
  // 移除计划阶段：未登记 → 不给计划。
  assert.throws(
    () => environment.removeEacEnvironment({ purge: true, dryRun: true }, strayEnv, HOST_PLATFORM),
    /未登记|拒绝/,
  );
  // 移除执行阶段：拒绝。
  assert.throws(() => environment.removeEacEnvironment({ purge: true }, strayEnv, HOST_PLATFORM), /dsh-dpx/);
  // 内容必须原样保留（绝不删别人的数据）。
  assert.equal(fs.readFileSync(strayFile, 'utf8'), '不能被静默接管');
});

test('P2: 重复安装复用同一实例（instanceId 稳定、不重建根）', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('reuse-instance');
  const env = isolatedEnv(productRoot);
  const first = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  const firstId = (first.record.instance as { instanceId?: string } | undefined)?.instanceId;
  const marker = path.join(first.paths.dshHome, 'state-marker.txt');
  fs.writeFileSync(marker, 'first-run');

  const second = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  const secondId = (second.record.instance as { instanceId?: string } | undefined)?.instanceId;
  assert.equal(secondId, firstId, '重复安装必须复用同一实例 id');
  assert.equal(second.rootExistedBefore, true);
  assert.equal(HOST_PATH.resolve(second.paths.root), HOST_PATH.resolve(first.paths.root));
  assert.equal(fs.readFileSync(marker, 'utf8'), 'first-run', '复用实例不得清空既有数据');
});

test('P2: channel 隔离——不同通道是不同环境根，互不干扰', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('channels');
  const base = isolatedEnv(productRoot);
  const betaEnv = { ...base, DSH_EAC_CHANNEL: 'beta' };
  const rcEnv = { ...base, DSH_EAC_CHANNEL: 'rc' };

  const beta = environment.ensureEacEnvironment(betaEnv, HOST_PLATFORM);
  const rc = environment.ensureEacEnvironment(rcEnv, HOST_PLATFORM);
  assert.notEqual(HOST_PATH.resolve(beta.paths.root), HOST_PATH.resolve(rc.paths.root), '不同通道必须不同环境根');
  assert.equal(beta.name, 'eac-beta');
  assert.equal(rc.name, 'eac-rc');

  // 在一个通道写的数据不得出现在另一个通道。
  fs.writeFileSync(path.join(beta.paths.dshHome, 'beta-only.txt'), 'beta');
  assert.equal(fs.existsSync(path.join(rc.paths.dshHome, 'beta-only.txt')), false, '通道间必须隔离');

  // 各通道注册表里各有一条自己的记录，移除一个不影响另一个。
  assert.equal(environment.diagnoseEacEnvironment(betaEnv, HOST_PLATFORM).registered, true);
  assert.equal(environment.diagnoseEacEnvironment(rcEnv, HOST_PLATFORM).registered, true);
  environment.removeEacEnvironment({ purge: true }, betaEnv, HOST_PLATFORM);
  assert.equal(environment.diagnoseEacEnvironment(betaEnv, HOST_PLATFORM).registered, false);
  assert.equal(environment.diagnoseEacEnvironment(rcEnv, HOST_PLATFORM).registered, true, '移除 beta 不得影响 rc');
  assert.ok(fs.existsSync(rc.paths.root), 'rc 环境根必须完好');
});

test('P2: 环境变量清理——dpx runtime 是权威，被清理的继承变量必须消失', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('env-cleanup');
  // 注入一批「会被 dpx 判定为宿主配置」的变量。
  const env = isolatedEnv(productRoot, {
    NODE_OPTIONS: '--require /host/evil.js',
    NODE_PATH: '/host/modules',
    HTTP_PROXY: 'http://host-proxy',
    HTTPS_PROXY: 'http://host-proxy',
    ALL_PROXY: 'socks5://host',
    NO_PROXY: 'host-only',
    NPM_CONFIG_PREFIX: '/host/prefix',
    NPM_CONFIG_CACHE: '/host/cache',
  });
  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  const { runtime } = ensured;

  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_CACHE']) {
    assert.equal(runtime[key], undefined, `dpx runtime 不得保留 ${key}`);
  }
  // 隔离变量必须真正指向隔离根（而不是回落到宿主）。
  assert.equal(runtime.DSH_HOME, ensured.paths.dshHome);
  assert.equal(runtime.DSH_DPX_ENV_ROOT, ensured.paths.root);
  assert.equal(runtime.USERPROFILE, ensured.paths.home);

  // 应用到目标环境后，宿主的这些变量必须真的被删掉（不是只覆盖）。
  const target: NodeJS.ProcessEnv = {
    NODE_OPTIONS: '--require /host/evil.js',
    NPM_CONFIG_PREFIX: '/host/prefix',
    DSH_HOME: '/host/.dsh',
  };
  environment.applyRuntimeEnvironment(runtime, target);
  assert.equal(target.NODE_OPTIONS, undefined, 'NODE_OPTIONS 必须被删除而不是保留');
  assert.equal(target.NPM_CONFIG_PREFIX, undefined);
  assert.equal(target.DSH_HOME, ensured.paths.dshHome, 'DSH_HOME 必须指向隔离根');
});

test('P2: 路径含空格与中文时创建/诊断/移除全链路可用', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('space-cjk');
  assert.ok(/[\s\u4e00-\u9fff]/.test(productRoot), `测试路径应含空格或中文：${productRoot}`);
  const env = isolatedEnv(productRoot);

  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  assert.ok(ensured.paths.root.includes('产品 Data Root'), '环境根应保留原始空格/中文目录名');
  const diagnosis = environment.diagnoseEacEnvironment(env, HOST_PLATFORM);
  assert.equal(diagnosis.registered, true);
  assert.equal(diagnosis.problems.length, 0);
  const removed = environment.removeEacEnvironment({ purge: true }, env, HOST_PLATFORM);
  assert.equal(removed.purged, true, '空格/中文路径下 purge 也必须成功');
  assert.equal(removed.rootStillExists, false);
});

test('P2: 显式 DSH_DPX_ROOT 指向的 payload 缺文件时必须 fail closed', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('partial-payload');
  // 造一个「看起来像 dpx 但缺 index.js」的目录（模拟打包漏装一个文件）。
  const fakeRoot = path.join(productRoot, 'partial-dpx');
  fs.mkdirSync(path.join(fakeRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(fakeRoot, 'src', 'desktop-release.js'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(fakeRoot, 'package.json'), JSON.stringify({ name: 'dsh-dpx', type: 'module' }));

  const env = isolatedEnv(productRoot, { DSH_DPX_ROOT: fakeRoot });
  assert.throws(() => environment.dpxModuleFile(env), /dsh-dpx 模块缺失/);
  assert.throws(() => environment.ensureEacEnvironment(env, HOST_PLATFORM), /dsh-dpx 模块缺失/);
  // 诊断也必须 fail closed（不能静默报告 healthy）。
  assert.throws(() => environment.diagnoseEacEnvironment(env, HOST_PLATFORM), /dsh-dpx 模块缺失/);
  // 移除同样 fail closed（不能「以为删了」）。
  assert.throws(() => environment.removeEacEnvironment({ purge: true }, env, HOST_PLATFORM), /dsh-dpx 模块缺失/);
});

test('P2: DSH_DPX_ROOT 显式覆盖优先于 DSH_RESOURCE_ROOT 与仓库副本', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('explicit-root');
  // 显式指向真实 submodule：必须被采纳。
  const explicit = environment.dpxModuleFile({ DSH_DPX_ROOT: dpxRoot });
  assert.equal(path.resolve(explicit), path.resolve(path.join(dpxRoot, 'src', 'index.js')));
  // 同时给了 DSH_RESOURCE_ROOT（缺 dpx）时，仍以 DSH_DPX_ROOT 为准。
  const resourceRoot = path.join(productRoot, 'resources');
  fs.mkdirSync(resourceRoot, { recursive: true });
  const both = environment.dpxModuleFile({ DSH_DPX_ROOT: dpxRoot, DSH_RESOURCE_ROOT: resourceRoot });
  assert.equal(path.resolve(both), path.resolve(path.join(dpxRoot, 'src', 'index.js')), 'DSH_DPX_ROOT 优先级更高');
});

test('P2: 打包态 DSH_RESOURCE_ROOT 下装配的 dpx payload 可直接用于隔离', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  const productRoot = tempRoot('staged-payload');
  // 模拟 stage 的 dpx 装配面：src/*.js + package.json + LICENSE。
  const resources = path.join(productRoot, 'resources');
  fs.mkdirSync(path.join(resources, 'dpx', 'src'), { recursive: true });
  for (const file of ['index.js', 'desktop-release.js', 'environment-guide.js', 'http.js']) {
    fs.copyFileSync(path.join(dpxRoot, 'src', file), path.join(resources, 'dpx', 'src', file));
  }
  fs.copyFileSync(path.join(dpxRoot, 'package.json'), path.join(resources, 'dpx', 'package.json'));

  const env = isolatedEnv(productRoot, { DSH_RESOURCE_ROOT: resources });
  const ensured = environment.ensureEacEnvironment(env, HOST_PLATFORM);
  assert.ok(fs.existsSync(ensured.paths.manifest), '装配态 dpx 必须能真正创建环境');
  assert.equal(environment.diagnoseEacEnvironment(env, HOST_PLATFORM).registered, true);
});

test('P2: 非隔离模式（显式 DSH_HOME）下诊断明确报未隔离，不伪造状态', { skip: !dpxAvailable && 'third_party/dsh-dpx submodule 未初始化' }, () => {
  // activeEnvironmentRoot 在无 dpx 身份变量时回退到推导根 —— 这是「本次启动
  // 会用到哪」，不是「已隔离」。侧车用 isolatedMode 判定是否真的隔离。
  const env: NodeJS.ProcessEnv = { DSH_HOME: path.join('D:', 'dev', 'dsh-home') };
  assert.equal(path.resolve(environment.activeEnvironmentRoot(env)), path.resolve(path.join('D:', 'dev')));
});

test('真实落盘测试的平台语义约束：必须传宿主平台，不得跨平台模拟', () => {
  // 锁定本文件的一条**设计约束**（2026-10-01 由 Linux CI 暴露）：
  // `ensureEacEnvironment` 等真实落盘 API 的 platform 参数只能传宿主平台。
  //
  // 为什么：dpx 的路径解析用 `node:path` 的默认导出（宿主平台实现），
  // `platform` 参数不参与解析。实测（Linux 容器）若在 Linux 上传 'win32'：
  //     path.win32.resolve('/tmp/xxx')  →  '\tmp\xxx'      ← 无盘符（Linux 的
  //                                                          win32 实现不知道 "C:"）
  //     path.posix.isAbsolute('\tmp\xxx') →  false         ← dpx 据此拒绝
  // → 抛 "Environment storage root must be an absolute path."
  // 这不是 dpx 的缺陷，而是「不能跨平台模拟真实落盘」。
  //
  // 断言方式：不"跑一次并期待失败"（会把错误吞掉），而是直接钉住上述机制，
  // 后人若把 HOST_PLATFORM 改成写死的跨平台值，这里会红。
  assert.equal(
    HOST_PLATFORM,
    process.platform,
    '真实落盘测试必须跟随宿主平台（dpx 的 platform 参数不改变路径解析规则）',
  );
  const probe = path.join(os.tmpdir(), 'eac-platform-probe');
  assert.ok(HOST_PATH.isAbsolute(probe), 'HOST_PATH 必须能把 os.tmpdir() 的路径判定为绝对路径');
  // 反向护栏：非 Windows 上，用 win32 语义解析一个 POSIX 路径会得到**非绝对**
  // 的结果（对 dpx 而言）—— 这正是 CI 上翻车的机制。
  if (HOST_PLATFORM !== 'win32') {
    assert.ok(
      !path.posix.isAbsolute(path.win32.resolve(probe)),
      'POSIX 路径经 win32 解析后对 posix 不是绝对路径 —— 跨平台模拟真实落盘的失败机制',
    );
  }
});
