'use strict';

// L2 Node sidecar 实体化（ADR 0002；T3-a 第二阶段）。
// v6 Task 3.1（ADR 0006）：最简本体版。职责收窄为——
//   1. stdio 行分隔 JSON-RPC 分发器（协议与 ping.js 一致，Rust L1 唯一对话面）
//   2. 挂载最简本体模块（boot-server 及其基础闭包）
//   3. 白名单方法注册表（Rust 壳调用面：boot.* / chrome.init / menu.action /
//      files.* / shell.info / profile.*）
// 剥离面（插件系统 / 更新体系 / 余额 / 手机桥 / 向导 / SDK 隔离宿主）按
// ADR 0006 移出装配；代码保留在仓库原位，由 Task 3.2/3.3/4/5/6 以包接回。
//
// 纪律：stdout 只走协议帧；一切日志/兜底输出走 stderr。

import path = require('node:path');
import os = require('node:os');
import fs = require('node:fs');
import url = require('node:url');
import readline = require('node:readline');

// 资源根：开发态 tauri-shell/sidecar → 仓库根/dsh-desktop；
// 打包态 resources/sidecar → resources/dsh-desktop（少一级）。
function resolveDesktopRoot(): string {
  const upTwo = path.resolve(__dirname, '..', '..', 'dsh-desktop');
  if (fs.existsSync(path.join(upTwo, 'package.json'))) return upTwo;
  const upOne = path.resolve(__dirname, '..', 'dsh-desktop');
  if (fs.existsSync(path.join(upOne, 'package.json'))) return upOne;
  return upTwo;
}
const DSH_DESKTOP_ROOT = process.env.DSH_RESOURCE_ROOT
  ? path.join(process.env.DSH_RESOURCE_ROOT, 'dsh-desktop')
  : resolveDesktopRoot();
const LIB = (m: string): string => path.join(DSH_DESKTOP_ROOT, 'lib', 'desktop', m);

function say(s: string): void { process.stderr.write('[sidecar] ' + s + '\n'); }

// ---- 宿主语义（对齐 Electron main.js 的注入值） --------------------------
const log = (tag: string, msg: string): void => say('[' + tag + '] ' + msg);

let pkgVersion = '0.0.0';
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(DSH_DESKTOP_ROOT, 'package.json'), 'utf8')).version || pkgVersion;
} catch { /* 保持缺省 */ }

type Mod = { init: (d: unknown) => void } & Record<string, unknown>;
const mount = (name: string): Mod => require(LIB(name)) as Mod;

// ---- 安装环境隔离（ADR 0004）：必须在任何读用户目录的业务模块之前完成 ----
//
// Rust L1 只注入产品数据根（DSH_EAC_DATA_ROOT）+ 通道（DSH_EAC_CHANNEL）；
// 注册表/锁/清单/变量治理全部由 dsh-dpx 完成（本模块只做适配，不复制其逻辑）。
//
// 失败语义是 **fail closed**：初始化不了就退场，绝不回退宿主 `~/.dsh` ——
// 那正是旧 profile 污染（旧插件 pending / 白屏）的根因。退场由壳层 reader
// 广播 boot.server-died，走既有恢复/诊断链。
const isolatedMode = Boolean(process.env.DSH_EAC_DATA_ROOT || process.env.DSH_EAC_DPX_ROOT);
type EnsuredEnvironment = {
  paths: { dshHome: string; root: string };
  runtime: NodeJS.ProcessEnv;
  legacyProfileDetected: boolean;
  legacyDshHome: string;
  name: string;
  channel: string;
  rootExistedBefore: boolean;
};
type EnvironmentModule = {
  ensureEacEnvironment(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): EnsuredEnvironment;
  applyRuntimeEnvironment(runtime: NodeJS.ProcessEnv, target?: NodeJS.ProcessEnv): void;
  diagnoseEacEnvironment(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Record<string, unknown>;
  removeEacEnvironment(
    options?: { purge?: boolean; dryRun?: boolean },
    env?: NodeJS.ProcessEnv,
    platform?: NodeJS.Platform,
  ): Record<string, unknown>;
};
// 隔离模块句柄：初始化后仍要留着 —— environment.status/remove 两个运维 RPC
// 要调用同一个适配层，而不是各自再 require 一份（会出现两套事实源）。
let environmentMod: EnvironmentModule | null = null;
let ensuredEnvironment: EnsuredEnvironment | null = null;
if (isolatedMode) {
  environmentMod = require(LIB('environment')) as EnvironmentModule;
  try {
    ensuredEnvironment = environmentMod.ensureEacEnvironment();
  } catch (error) {
    // fail closed 的失败信息必须自证根因（哪一步、哪个路径），否则用户只看到
    // 白屏。这里把 dpx 的原始错误与产品数据根/注册表一起打出来。
    const detail = String((error instanceof Error && error.stack) || error);
    say('[environment] dsh-dpx 环境初始化失败（fail closed，不回退宿主 ~/.dsh）: ' + detail);
    say('[environment] 产品数据根=' + (process.env.DSH_EAC_DATA_ROOT || '(未注入)')
      + ' 通道=' + (process.env.DSH_EAC_CHANNEL || '(默认)')
      + ' 提示：可用 environment.status 诊断，或 environment.remove(purge) 清理后重装');
    process.exit(2);
  }
  // 应用 dpx 的全量 runtime（含清掉会伪装成宿主配置的继承变量）。
  environmentMod.applyRuntimeEnvironment(ensuredEnvironment.runtime, process.env);
  say('[environment] 隔离已生效：name=' + ensuredEnvironment.name
    + ' root=' + ensuredEnvironment.paths.root
    + (ensuredEnvironment.rootExistedBefore ? '（复用既有环境实例）' : '（新建环境实例）'));
}

const procMod = mount('proc');
const platformMod = mount('platform') as Mod & {
  createDesktopPlatform(): {
    userDataDir(): string;
    capabilities(): Record<string, unknown>;
  };
};
const desktopPlatform = platformMod.createDesktopPlatform();
const userDataDir = desktopPlatform.userDataDir();
const dshHome = ensuredEnvironment?.paths.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
if (ensuredEnvironment?.legacyProfileDetected) {
  say('[environment] 检测到宿主机旧 .dsh/web-desktop profile：本次启动保持隔离，只做提示，不迁移、不删除、不覆盖');
}
const pathsMod = mount('runtime-paths');
const profileMod = mount('profile');
const runtimePatchesMod = mount('runtime-patches');
const bootMod = mount('boot-server');

// v6 Task 3.3：插件治理三件套接回（ADR 0006 v3 插口契约）——
// companion-sync/guard-box 由 guard-box 依赖链引入，plugin-ops 提供插件启停。
const guardBoxMod = mount('guard-box');
const companionSyncMod = mount('companion-sync');
const pluginOpsMod = mount('plugin-ops');
// v6 Task 3.3：files.* 白名单根（files.revert / files.authorize-open 消费）。
const fileRootsMod = mount('file-roots');

// v6 Task 3.1（ADR 0006 v3 · 严格模式）：本体只保留对 dsh 的最简包装。
// capability-stubs 仅提供内部 boot glue，不注册公开降级方法。
import stubs = require('./capability-stubs');

const MOUNTED = ['proc', 'platform', 'runtime-paths', 'profile', 'guard-box', 'runtime-patches', 'companion-sync', 'plugin-ops', 'file-roots', 'boot-server'];

// 打包态判定 + 资源根：Rust 壳 spawn sidecar 时注入 DSH_SHELL_EXE /
// DSH_RESOURCE_ROOT（main.rs Sidecar::spawn）。DSH_RESOURCE_ROOT 存在即打包态；
// 开发态两者缺省 → isPackaged=false。
function isPackagedRuntime(): boolean {
  return Boolean(process.env.DSH_RESOURCE_ROOT);
}
function resourceRoot(): string {
  return process.env.DSH_RESOURCE_ROOT || '';
}

// ---- ctx 注入（与 main.js 注入块逐项对齐；GUI 类能力走兜底/委托） --------
const desktopProfileFn = profileMod.desktopProfile as () => string;
const notifyFallback = (n: { title: string; body: string }): void => {
  say('[notify] ' + n.title + ': ' + n.body);
  notify('shell.system-notification', { title: n.title, body: n.body });
};

procMod.init({ log, getDshHome: () => dshHome, getDesktopProfile: desktopProfileFn });
pathsMod.init({ log, getUserDataDir: () => userDataDir, isPackaged: () => isPackagedRuntime(), resourcesPath: () => resourceRoot(), platform: process.platform });
profileMod.init({ log, getDshHome: () => dshHome });
runtimePatchesMod.init({ log, getDshHome: () => dshHome, getUserDataDir: () => userDataDir });
// v6 Task 3.3：三件套 init（注入点与 v6 收窄面一致，见 ADR 0006 裁决项 5）。
guardBoxMod.init({
  log,
  getDshHome: () => dshHome,
  getDesktopProfile: desktopProfileFn,
  getDshBin: () => (pathsMod.dshBin as () => string)(),
});
pluginOpsMod.init({
  log,
  removeBundle: (name: string) => {
    const { removePluginPackage } = require(LIB('plugin-remove')) as typeof import('../../dsh-desktop/lib/desktop/plugin-remove');
    return removePluginPackage({
      node: (pathsMod.nodeExe as () => string)(),
      carrier: (pathsMod.dshCli as () => string)(),
      kernel: (pathsMod.dshBin as () => string)(),
      profile: desktopProfileFn(),
      name,
      cwd: userDataDir,
      env: (procMod.childEnv as () => NodeJS.ProcessEnv)(),
    });
  },
});
companionSyncMod.init({
  log,
  getDshHome: () => dshHome,
  getUserDataDir: () => userDataDir,
  // M2/#415：applyLegacySkinChoice（旧版皮肤选择迁移落位）随旧版皮肤切换
  // 一并退役；换肤由 ui-skin-loader 公约皮肤包接管。
  showMainWindow: () => say('showMainWindow (host-delegated)'),
  notify: notifyFallback,
  platform: process.platform,
});

// ---- boot-server（P2：dsh web 服务编排） --------------------------------
// settings 兼容层：与 updater.js 的 userData/settings.json 同文件同语义
// （load 回退 {}，save 2 空格缩进 + 尾换行）。
let quitting = false;

const settingsFile = path.join(userDataDir, 'settings.json');
const { readJsonFile, writeJsonAtomic } = require(path.join(DSH_DESKTOP_ROOT, 'lib', 'atomic-json.js')) as {
  readJsonFile(file: string): Record<string, unknown> | null;
  writeJsonAtomic(file: string, value: unknown): void;
};
const { verifyBundle } = require(path.join(DSH_DESKTOP_ROOT, 'bundle-integrity.js')) as {
  verifyBundle(
    nodeModulesRoot: string,
    manifest: Record<string, unknown>,
  ): {
    ok: boolean;
    damaged: Array<{ name: string; reason: string; expected?: number; actual?: number }>;
  };
};
function loadSettings(): Record<string, unknown> {
  return readJsonFile(settingsFile) ?? {};
}
function saveSettings(s: Record<string, unknown>): void {
  try { writeJsonAtomic(settingsFile, s); } catch (e) { say('保存 settings 失败: ' + String(e)); }
}

/** 无 id 的 JSON-RPC 通知帧（Rust 侧经 WS 广播给页面，并自行订阅壳层事件）。 */
function notify(method: string, params: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method, params: params == null ? {} : params }) + '\n');
}

// 全局兜底：sidecar 裸崩 = 整壳失去桥能力。unhandledRejection 记日志继续跑；
// uncaughtException 记日志后退场 —— 壳层 reader 广播 boot.server-died 走
// /died 恢复链，好过无声僵死。
process.on('unhandledRejection', (reason) => {
  log('fatal', 'unhandledRejection: ' + String((reason instanceof Error ? reason.stack : reason) || reason));
});
process.on('uncaughtException', (err) => {
  try { log('fatal', 'uncaughtException: ' + String((err && err.stack) || err)); } catch { /* 尽力而为 */ }
  process.exit(1);
});

// ---------------------------------------------------------------------------
// SYNC-005：dshDesktop.shortcuts 持久化（官方 ShortcutPersistence 内核复用）
//
// 官方权威实现 = 内核包 @deepseek-ai/dsh-client-shortcuts 的 lib/protocol.js
//（Electron 主进程同款单写者协调器：revision = 每次 accept 重新生成的 UUID、
// sequence 单调递增供客户端丢弃乱序回包、edit 先对账 revision 再做冲突分类
// 后写盘、读失败保留上次已接受文档并禁写）。本进程不重抄该逻辑，直接以
// ShortcutStorage 适配器复用 —— 绝不臆造语义。
//
//   * 包定位：dsh-desktop/node_modules/@deepseek-ai/dsh-client-shortcuts。该包
//     在生产依赖树内（@deepseek-ai/dsh → dsh-web-app → dsh-client-shortcuts，
//     npm ls 实核），打包态 npm ci --omit=dev 保留 —— 开发/打包两态都可用。
//   * ESM 导入：内核包 "type":"module"，而本文件被 tsc 编译成 commonjs，
//     import() 会被 tsc 变换成 require()（require ESM 在旧 Node 下失败）。
//     new Function 逃逸变换，保留宿主动态 import 语义（vendored node v24）。
//   * runtime='desktop'：必须与页面 dsh-client-shortcuts detectEnvironment 的
//     判定一致（data-platform 存在 → runtime='desktop'），否则
//     editShortcutDocument 的 schemaVersion/profile 键与页面注册表错位。
//   * platform：与页面 detectEnvironment 同源归一（win32→windows、darwin→macos、
//     其余→linux）。
//   * rereadBeforeWrite=true：文件适配器，写前重读 —— 外部改动（其它进程/
//     手编）先进协调器再写，单写者语义不丢更新。
//   * 落盘：userData/keybindings.json（官方路径 userData/keybindings.json）。
//     userData 权威解析复用 lib/desktop/platform.ts 的 createDesktopPlatform
//     （%APPDATA%/Deepseek Harness EAC —— 与 settings.json 同目录同源）。
//     writeJsonAtomic（tmp+rename 原子换入）落盘格式 `JSON.stringify(v,null,2)
//     +'\n'` 与官方 ShortcutPersistence.serialize 的产物逐字节一致。
//
// 推送：publish 回调 → notify('shortcuts.snapshot', snapshot) —— 无 id JSON-RPC
// 通知帧，Rust L1（Sidecar::spawn_reader）广播给所有 WS 连接；页面桥
//（bridge.ts noteSnapshot）按 sequence 门控缓存 revision 并分发给
// shortcuts.subscribe 监听者。页面重载/重连后由桥在 WS open 时主动
// call('shortcuts.state') 拉当前快照（L2 通知帧不回放）。
// ---------------------------------------------------------------------------
const importEsm = new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<Record<string, unknown>>;
const SHORTCUT_PLATFORM: 'windows' | 'macos' | 'linux' =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const keybindingsFile = path.join(userDataDir, 'keybindings.json');
// ShortcutPersistence / 快照在运行期经 ESM 默认命名空间取得（无 CJS 类型面），
// 这里只声明实际用到的窄形态。
interface ShortcutSnapshotLike {
  revision: string;
  sequence: number;
  status: string;
}
interface ShortcutPersistenceLike {
  setDefinitions(definitions: unknown): void;
  readCurrent(): Promise<ShortcutSnapshotLike>;
  edit(edit: unknown, revision: unknown): Promise<Record<string, unknown>>;
}
let shortcutPersistence: ShortcutPersistenceLike | null = null;
let shortcutProtocol: {
  parseShortcutDefinitions(value: unknown): unknown;
  parseShortcutEdit(value: unknown): unknown;
} | null = null;
let shortcutsError: string | null = null;
const shortcutsBoot: Promise<void> = (async (): Promise<void> => {
  try {
    const protocolUrl = url.pathToFileURL(path.join(
      DSH_DESKTOP_ROOT, 'node_modules', '@deepseek-ai', 'dsh-client-shortcuts', 'lib', 'protocol.js',
    )).href;
    const protocol = await importEsm(protocolUrl) as {
      ShortcutPersistence: new (
        storage: { read(): string | null; write(raw: string): void },
        runtime: 'desktop',
        platform: 'windows' | 'macos' | 'linux',
        rereadBeforeWrite: boolean,
        publish: (snapshot: ShortcutSnapshotLike) => void,
      ) => ShortcutPersistenceLike;
      parseShortcutDefinitions(value: unknown): unknown;
      parseShortcutEdit(value: unknown): unknown;
    };
    shortcutProtocol = protocol;
    shortcutPersistence = new protocol.ShortcutPersistence(
      {
        // storage.read：原文（string）或 null=缺失；其余 IO 错误向上抛 ——
        // 官方协调器据此归类 error='read'（保留上次已接受文档并禁写）。
        read: (): string | null => {
          try {
            return fs.readFileSync(keybindingsFile, 'utf8');
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw e;
          }
        },
        // storage.write：raw 是官方 serialize 产物（`JSON.stringify(document,
        // null, 2)+'\n'`）；parse 回对象交 writeJsonAtomic（同格式原子落盘）。
        write: (raw: string): void => {
          writeJsonAtomic(keybindingsFile, JSON.parse(raw));
        },
      },
      'desktop',
      SHORTCUT_PLATFORM,
      true,
      (snapshot) => { notify('shortcuts.snapshot', snapshot); },
    );
    // 启动即读盘：快照（含真实 revision）在首个消费者 get() 之前就绪，
    // 页面桥 WS open 的 shortcuts.state 拉取即刻拿到真值。
    await shortcutPersistence.readCurrent();
    log('shortcuts', 'persistence ready: ' + keybindingsFile);
  } catch (e) {
    shortcutPersistence = null;
    shortcutProtocol = null;
    shortcutsError = String((e as Error).message || e);
    log('shortcuts', 'persistence init failed（shortcuts 面按不可用降级）: ' + shortcutsError);
  }
})();
async function ensureShortcuts(): Promise<void> {
  await shortcutsBoot;
  if (!shortcutPersistence || !shortcutProtocol) {
    throw new Error('shortcuts persistence unavailable: ' + (shortcutsError || 'not initialized'));
  }
}

// ---------------------------------------------------------------------------
// SYNC-005：dshDesktop.updates 真事件源
//
// EAC 更新态来源调研（自证材料 #1）：
//   * 真实客户端更新链 = dsh-desktop/lib/desktop/client-update.js —— EAC 封装
//     自更新（checkLatest → 弹窗同意 → downloadRelease 进度 → 写入
//     settings.pendingClientUpdate={version,path,source} → 用户确认重启 →
//     client-updater.applyUpdate 替换 exe 并退出）。updater.js 是内核 overlay
//     （agent dsh 二进制）更新，不是「客户端」更新链。
//   * Tauri 壳（v6 最简本体，ADR 0006）未挂载 runClientUpdateFlow —— 检查/
//     下载流程不在本进程运行，checking/available/downloading/verifying/
//     installing 各 phase 当前没有任何真实写入点，不得伪造。
//   * 真实可观测态 = userData/settings.json 的 pendingClientUpdate（真实落盘，
//     由 client-update 下载完成后写入）：映射官方 phase='ready'（更新已就绪
//     待装）。判定门与 offerPendingClientUpdate（client-update.js:200-217）
//     逐条一致：文件仍存在 且 version > 当前应用版本；失效项按 idle。
//   * 其余一律 phase='idle' —— 当前没有进行中/就绪的客户端更新，这是真实态
//    （若 shell 层未来接回检查/下载流程（SYNC-007），在状态变化点改写
//     presentation 即可，本映射表随之扩展）。
//
// 事件源：settings.json 的真实文件变化。首个 updates.subscribe 到来才启动
// 3s 低频 stat 轮询（mtimeMs+size 变化 → 重算 presentation → 与上次推送不同
// 才 notify('updates.presentation')）；末个退订即停轮询。推送/轮询都只读
// 真实文件，绝不凭空生成进度。
// ---------------------------------------------------------------------------
const updaterMod = require(path.join(DSH_DESKTOP_ROOT, 'updater')) as {
  compareVersions(a: string, b: string): number;
};
function computeUpdatePresentation(): { phase: 'idle' | 'ready'; version?: string } {
  const s = loadSettings() as { pendingClientUpdate?: { version?: unknown; path?: unknown } };
  const pending = s.pendingClientUpdate;
  if (pending && typeof pending.version === 'string' && typeof pending.path === 'string' && pending.path !== '') {
    // offerPendingClientUpdate 同款判定门（client-update.js:208-217）：
    // 包文件消失或版本不比当前新 = 过期待办，清场按 idle。
    try {
      if (fs.existsSync(pending.path) && updaterMod.compareVersions(pending.version, pkgVersion) > 0) {
        return { phase: 'ready', version: pending.version };
      }
    } catch { /* 文件判定失败按 idle（不伪造就绪） */ }
  }
  return { phase: 'idle' };
}
let updatesWatchers = 0;
let updatesTimer: NodeJS.Timeout | null = null;
let updatesStatKey = '';
let lastUpdatePresentation = '';
function statKey(file: string): string {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs + ':' + st.size;
  } catch {
    return 'missing';
  }
}
function pushUpdatePresentation(force: boolean): void {
  const p = computeUpdatePresentation();
  const key = JSON.stringify(p);
  if (force || key !== lastUpdatePresentation) {
    lastUpdatePresentation = key;
    notify('updates.presentation', p);
  }
}
function startUpdatesPoll(): void {
  if (updatesTimer) return;
  updatesStatKey = statKey(settingsFile);
  updatesTimer = setInterval(() => {
    const key = statKey(settingsFile);
    if (key !== updatesStatKey) {
      updatesStatKey = key;
      try { pushUpdatePresentation(false); } catch (e) {
        log('updates', 'presentation push failed: ' + String((e as Error).message || e));
      }
    }
  }, 3000);
}
function stopUpdatesPoll(): void {
  if (updatesTimer) {
    clearInterval(updatesTimer);
    updatesTimer = null;
  }
}

bootMod.init({
  log,
  getUserDataDir: () => userDataDir,
  getDesktopProfile: desktopProfileFn,
  desktopProfileDir: () => (profileMod.desktopProfileDir as () => string)(),
  nodeExe: () => (pathsMod.nodeExe as () => string)(),
  dshBin: () => (pathsMod.dshBin as () => string)(),
  dshCli: () => (pathsMod.dshCli as () => string)(),
  loadSettings,
  saveSettings,
  isQuitting: () => quitting,
  onServerDied: (info: unknown) => {
    notify('boot.server-died', info);
  },
});

say('modules mounted (v6 minimal core); dshHome=' + dshHome + '; profile=' + desktopProfileFn());

// ---- SessionWatcher（保留：ADR 0006 已裁决项 1） ---------------------------
// 会话任务完成通知：2s 轮询 <dshHome>/sessions，turn/end 时经壳层系统通知
// 提醒（notifyOnTurnEnd 设置项控制，同会话 30s 限频）。输入是内核自有数据，
// 不依赖插件面 —— 属「完成一轮对话」最简路径的体验闭环。
const sessionWatcherMod = require(path.join(DSH_DESKTOP_ROOT, 'session-watcher.js')) as {
  SessionWatcher: new (opts: {
    sessionsDir: string;
    log: (tag: string, msg: string) => void;
    onTurnEnd: (info: { sessionId: string; title?: string; body?: string }) => void;
  }) => { start(): void; stop(): void };
};
let sessionWatcher: { start(): void; stop(): void } | null = null;
const turnEndNotifyAt = new Map<string, number>();
function startSessionWatcher(): void {
  if (sessionWatcher) return;
  try {
    const s = loadSettings() as { notifyOnTurnEnd?: boolean };
    if (s.notifyOnTurnEnd === false) return;
    sessionWatcher = new sessionWatcherMod.SessionWatcher({
      sessionsDir: path.join(dshHome, 'sessions'),
      log,
      onTurnEnd: (info) => {
        if (quitting) return;
        const now = Date.now();
        const last = turnEndNotifyAt.get(info.sessionId) || 0;
        if (now - last < 30000) return; // 同会话至多一条 toast / 30s
        if (turnEndNotifyAt.size >= 500) {
          const oldest = [...turnEndNotifyAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 250);
          for (const [k] of oldest) turnEndNotifyAt.delete(k);
        }
        turnEndNotifyAt.set(info.sessionId, now);
        notifyFallback({
          title: info.title || 'DSH 任务完成',
          body: info.body || '会话任务已完成',
        });
      },
    });
    sessionWatcher.start();
  } catch (e) {
    say('SessionWatcher 启动失败（不影响主流程）: ' + String(((e as Error).message) || e));
  }
}

// 前置文件树准备（v6 Task 3.3 接回版）：退役清理 → 内置插件同步 → 模块遮蔽修复。
// 与 v6 收窄面一致（ADR 0006 裁决项 5）；boot.start 与重启共用。
async function preBootSync(): Promise<void> {
  (profileMod.ensureDesktopProfileInit as () => void)();
  (companionSyncMod.retireRemovedBuiltinPluginsGated as (dir: string) => void)(
    (profileMod.desktopProfileDir as () => string)(),
  );
  (companionSyncMod.syncCompanionPlugins as () => void)();
  (companionSyncMod.healProfileModules as () => void)();
}

// 原地重启（= main.js restartWebServiceCore，v6 最简版）：前置同步 → 拉起。
async function restartWebServiceCore(): Promise<{ ok: boolean; webUrl?: string; port?: number; error?: string }> {
  const running = (bootMod.state as () => { running: boolean })().running;
  (bootMod.setIsRestarting as (v: boolean) => void)(true);
  try {
    if (!running) {
      log('service', '请求启动 dsh web 服务（未在运行）');
      await preBootSync();
      const r = await guardedStartAndWait([]);
      log('service', 'dsh web 服务已启动: ' + r.webUrl);
      notify('boot.web-ready', r);
      return { ok: true, webUrl: r.webUrl, port: r.port };
    }
    log('service', '请求重启 dsh web 服务');
    await (bootMod.killAndWaitForRestart as () => Promise<void>)();
    const r = await guardedStartAndWait([]);
    log('service', 'dsh web 服务已重启: ' + r.webUrl);
    notify('boot.web-ready', r);
    return { ok: true, webUrl: r.webUrl, port: r.port };
  } catch (e) {
    log('service', '重启失败: ' + String(((e as Error).message) || e));
    return { ok: false, error: String(((e as Error).message) || e) };
  } finally {
    (bootMod.setIsRestarting as (v: boolean) => void)(false);
  }
}

function verifyBundleIntegrity(): void {
  if (!isPackagedRuntime()) return;
  const manifestFile = path.join(DSH_DESKTOP_ROOT, 'bundle-manifest.json');
  if (!fs.existsSync(manifestFile)) {
    say('bundle integrity skipped: bundle-manifest.json missing (legacy install)');
    return;
  }
  const manifest = readJsonFile(manifestFile);
  if (!manifest || manifest.version !== 1 || !manifest.packages || typeof manifest.packages !== 'object') {
    throw new Error('bundle integrity check failed: bundle-manifest.json is invalid');
  }
  const result = verifyBundle(path.join(DSH_DESKTOP_ROOT, 'node_modules'), manifest);
  if (result.ok) {
    say('bundle integrity check passed');
    return;
  }
  const summary = result.damaged.slice(0, 10).map((item) =>
    `${item.name}: ${item.reason} (expected=${item.expected ?? 'n/a'}, actual=${item.actual ?? 'n/a'})`
  ).join('; ');
  const omitted = result.damaged.length > 10 ? `; ${result.damaged.length - 10} more` : '';
  throw new Error(`bundle integrity check failed: ${summary}${omitted}`);
}

// ---- 守护启动（v6 严格模式：无快照/事故面 —— guard-box 随插件保护中心剥出；
// overlay 失败隔离（runtime-paths 自带）保留 —— 那是 boot 链的一部分）----
async function guardedStartAndWait(overlays: string[]): Promise<{ webUrl: string; port: number }> {
  const startedWithOverlay = (pathsMod.isUsingOverlay as () => boolean)();
  try {
    let r: { webUrl: string; port: number };
    try {
      r = await (bootMod.startAndWait as (o: string[]) => Promise<{ webUrl: string; port: number }>)(overlays);
    } catch (overlayError) {
      if (!startedWithOverlay) throw overlayError;
      // 乐观优先：真实启动失败后才隔离 overlay，用内置内核重试一次。
      try { await (bootMod.stopServer as () => Promise<void>)(); }
      catch (stopError) { log('update', '停止失败 overlay 的残留进程失败: ' + String(((stopError as Error).message) || stopError)); }
      const quarantine = (pathsMod.quarantineBrokenOverlay as (reason: unknown) => { quarantined: boolean; path?: string; error?: string })(overlayError);
      log('update', '外部 DSH 启动失败，正在使用内置 DSH 重试' + (quarantine.path ? `（问题副本：${quarantine.path}）` : ''));
      try {
        r = await (bootMod.startAndWait as (o: string[]) => Promise<{ webUrl: string; port: number }>)(overlays);
      } catch (bundledError) {
        throw new Error(
          '外部 DSH 启动失败，切换内置 DSH 后仍无法启动。' +
          `外部错误：${String(((overlayError as Error).message) || overlayError)}；` +
          `内置错误：${String(((bundledError as Error).message) || bundledError)}`,
        );
      }
    }
    return r;
  } catch (e) {
    throw e;
  }
}

// ---- 方法注册表 -----------------------------------------------------------
interface RpcReq { id: number | null; method: string; params?: Record<string, unknown> }
type RpcResult = Record<string, unknown>;
type RpcParams = Record<string, unknown> | undefined;

// 图标 dataUri 模块级缓存：壳栏（bridge injectChrome）与关于页经 boot.state 读取。
let chromeIconDataUri: string | null = null;
function chromeIcon(): string {
  if (chromeIconDataUri !== null) return chromeIconDataUri;
  try {
    const buf = fs.readFileSync(path.join(DSH_DESKTOP_ROOT, 'assets', 'icon.png'));
    chromeIconDataUri = buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50
      ? 'data:image/png;base64,' + buf.toString('base64')
      : '';
  } catch { chromeIconDataUri = ''; /* 无图标不致命 */ }
  return chromeIconDataUri;
}

const methods: Record<string, (p: RpcParams) => unknown> = {
  // 壳自检（--bridge-test）与排障用：只暴露身份与挂载面，不含业务能力。
  'shell.info': (): RpcResult => ({
    sidecar: 'server.ts',
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    version: pkgVersion,
    modules: MOUNTED,
  }),
  'profile.name': (): RpcResult => ({ name: desktopProfileFn() }),
  // ---- boot.*（P2：dsh web 服务编排，Rust 壳的启动主链路） ----
  'boot.start': async (p): Promise<RpcResult> => {
    const overlays = Array.isArray(p && p.overlays) ? (p!.overlays as string[]) : [];
    verifyBundleIntegrity();
    // 前置文件树准备（v6 最简版，见 preBootSync）。
    try {
      await preBootSync();
    } catch (e) {
      say('boot 前置准备失败（继续尝试拉起服务）: ' + String(((e as Error).message) || e));
    }

    let r: { webUrl: string; port: number };
    try {
      r = await guardedStartAndWait(overlays);
    } catch (e) {
      // 崩溃循环计数随救援链剥出（v6 严格模式）：桩只记日志。
      bootFailureRecorder.recordBootFailureNow(String(((e as Error).message) || e));
      notify('boot.failed', { error: String(((e as Error).message) || e) });
      throw e;
    }
    bootFailureRecorder.clearRescueState();
    notify('boot.web-ready', r);
    // 应答必须立刻返回：boot.start 是 Rust 壳 180s 超时的同步等待点。
    setImmediate(() => {
      // 会话任务完成通知（notifyOnTurnEnd 设置项控制）。
      try { startSessionWatcher(); } catch (e) {
        say('会话监听启动失败（不影响启动）: ' + String(((e as Error).message) || e));
      }
    });
    return { ok: true, webUrl: r.webUrl, port: r.port };
  },
  'boot.stop': async (): Promise<RpcResult> => {
    await (bootMod.stopServer as () => Promise<void>)();
    return { ok: true };
  },
  // v6 Task 3.1（ADR 0006 v5）：boot.state 是壳最小控制面的唯一信息接口
  //（chrome.init 已删）—— 在服务状态之上承载壳栏/关于页所需的版本与图标，
  // 以及关窗策略 exitAction（Rust 壳 apply_exit_policy 读取）。
  'boot.state': (): RpcResult => {
    const base = (bootMod.state as () => Record<string, unknown>)();
    const s = loadSettings() as {
      closeToTray?: boolean; exitAction?: string; notifyOnTurnEnd?: boolean;
    };
    const exitAction = s.exitAction === 'ask' || s.exitAction === 'minimize' || s.exitAction === 'quit'
      ? s.exitAction
      : s.closeToTray === false ? 'quit' : s.closeToTray === true ? 'minimize' : 'ask';
    return {
      ...base,
      appVersion: pkgVersion,
      agentVersion: (pathsMod.dshVersion as () => string)(),
      agentSource: (pathsMod.dshVersionSource as () => string)(),
      iconDataUri: chromeIcon(),
      exitAction,
      // v6 Task 3.3：插件（dsh-client-file-changes）经 bridge.getInfo() 读
      // staticPort 拼静态预览 URL。静态预览服务随插件面剥出，故恒 0 ——
      // 客户端按既有契约回退宿主 /dsh-files/static/ 路由（非错误路径）。
      staticPort: 0,
      // P1：把隔离身份随 boot.state 一起给出（壳栏/关于页/支持人员定位用）。
      // 只暴露身份与路径，不在这里跑诊断 —— 诊断是 environment.status 的职责，
      // 避免每次 boot.state 都起一个 dpx 子进程。
      environment: isolatedMode && ensuredEnvironment
        ? {
          isolated: true,
          name: ensuredEnvironment.name,
          root: ensuredEnvironment.paths.root,
          dshHome: ensuredEnvironment.paths.dshHome,
          channel: ensuredEnvironment.channel,
          rootExistedBefore: ensuredEnvironment.rootExistedBefore,
          legacyProfileDetected: ensuredEnvironment.legacyProfileDetected,
        }
        : { isolated: false },
    };
  },
  // ---- SYNC-005：dshDesktop.shortcuts（官方 DesktopShortcutsApi 的主进程侧）----
  // 页面桥键面 = get/edit/recording/subscribe（persistence.d.ts）；recording 的
  // 物理键拦截暂停发生在页面层（捕获监听就在 bridge.ts），不经 sidecar。
  // 'shortcuts.state' 是桥内省拉取（非官方契约方法）：页面重载/重连后 WS 通知
  // 帧不回放，桥在 WS open 时主动拉当前快照 —— readCurrent 重读文件并按官方
  // 语义轮转 revision/sequence（客户端按 sequence 丢弃乱序）。
  'shortcuts.state': async (): Promise<RpcResult> => {
    await ensureShortcuts();
    return shortcutPersistence!.readCurrent() as unknown as RpcResult;
  },
  // 官方 get 语义（ipc.ts / client.js syncDefinitions）：先校验并安装可信目录
  //（parseShortcutDefinitions 在 IPC 入口抛畸形 —— WS 错误向上 reject，客户端
  // failRead 落 'unreadable'），再重读文件返回已接受快照。
  'shortcuts.get': async (p): Promise<RpcResult> => {
    await ensureShortcuts();
    const definitions = shortcutProtocol!.parseShortcutDefinitions(p && p.definitions);
    shortcutPersistence!.setDefinitions(definitions);
    return shortcutPersistence!.readCurrent() as unknown as RpcResult;
  },
  // 官方 edit 语义：revision 对账（不匹配 → 'stale'）、冲突分类（'conflict' +
  // issue/conflicts）、写盘成功 → 'saved'（ShortcutSaveResult 形态由内核
  // persistence 保证）。edit 畸形由 parseShortcutEdit 抛出（官方 IPC 入口同款）。
  'shortcuts.edit': async (p): Promise<RpcResult> => {
    await ensureShortcuts();
    const edit = shortcutProtocol!.parseShortcutEdit(p && p.edit);
    return shortcutPersistence!.edit(edit, p ? p.revision : undefined) as unknown as RpcResult;
  },
  // ---- SYNC-005：dshDesktop.updates（真实状态 + 真实文件变化事件源）----
  // status：settings.pendingClientUpdate（真实落盘待办）→ 'ready'+version，
  // 否则 'idle'（检查/下载流程未挂载，checking/downloading 等无真实写入点，
  // 不伪造 —— 映射依据见上方 updates 区注释）。
  'updates.status': (): RpcResult => computeUpdatePresentation(),
  // subscribe：登记远端订阅（首个订阅启动 settings.json 变化轮询），并立即
  // 推送当前 presentation（页面重载后首个监听者即刻拿到真实态）。
  'updates.subscribe': (): RpcResult => {
    updatesWatchers += 1;
    startUpdatesPoll();
    const current = computeUpdatePresentation();
    lastUpdatePresentation = JSON.stringify(current);
    notify('updates.presentation', current);
    return current;
  },
  'updates.unsubscribe': (): RpcResult => {
    updatesWatchers = Math.max(0, updatesWatchers - 1);
    if (updatesWatchers === 0) stopUpdatesPoll();
    return { ok: true };
  },
  // ---- 安装环境运维（P1：损坏环境可诊断 + 最小 repair/remove 能力）--------
  //
  // 边界（ADR 0004）：环境治理逻辑属于 dsh-dpx，这里只是**薄 RPC 适配**。
  // 非隔离模式（显式 DSH_HOME 的开发启动）下所有方法都明确回 non-isolated，
  // 而不是悄悄报一个空状态。
  'environment.status': (): RpcResult => {
    if (!isolatedMode || !environmentMod) {
      return { ok: true, isolated: false, reason: 'non-isolated（未注入 DSH_EAC_DATA_ROOT/DSH_DPX_ROOT）' };
    }
    try {
      const diagnosis = environmentMod.diagnoseEacEnvironment();
      return {
        ok: true,
        isolated: true,
        // 本次启动实际生效的环境（sidecar 真正在用的那个根）。
        active: {
          name: ensuredEnvironment?.name,
          root: ensuredEnvironment?.paths.root,
          dshHome: ensuredEnvironment?.paths.dshHome,
          channel: ensuredEnvironment?.channel,
          rootExistedBefore: ensuredEnvironment?.rootExistedBefore,
        },
        diagnosis,
        legacyProfileDetected: ensuredEnvironment?.legacyProfileDetected === true,
        legacyDshHome: ensuredEnvironment?.legacyDshHome,
        // 单一结论字段：UI 不需要自己解读 problems 数组。
        health: Array.isArray((diagnosis as { problems?: unknown[] }).problems)
          && ((diagnosis as { problems?: unknown[] }).problems as unknown[]).length === 0
          ? 'healthy' : 'damaged',
      };
    } catch (error) {
      // 诊断本身失败（dpx 模块缺失等）= 隔离不可用，如实报告，不伪装 healthy。
      return {
        ok: false,
        isolated: true,
        health: 'unavailable',
        error: String((error instanceof Error && error.message) || error),
      };
    }
  },
  // 移除本通道环境记录。purge=false 只摘记录（保留环境根数据）；purge=true
  // 连环境根一起删。dryRun=true 只返回计划、不落盘。
  //
  // 安全（P1）：只有**已登记**环境可移除；未登记目录（哪怕非空）一律拒绝，
  // 不迁移旧 .dsh、不复制凭据。删除是显式动作，默认路径仍是 fail-closed + 诊断。
  'environment.remove': (p): RpcResult => {
    if (!isolatedMode || !environmentMod) {
      return { ok: false, error: 'non-isolated：未启用安装环境隔离，无可移除的隔离环境' };
    }
    try {
      const result = environmentMod.removeEacEnvironment({
        purge: !!(p && p.purge),
        dryRun: !!(p && p.dryRun),
      });
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: String((error instanceof Error && error.message) || error) };
    }
  },
  // 兼容 v5 的 `environment.repair` 命名：当前语义等价于「重新确保环境」（幂等），
  // 真正的修复动作由 dpx 的 createEnvironment 完成（损坏注册表会 fail closed，
  // 不静默重建 —— 重写注册表属于 dpx，不属于 EAC）。
  'environment.repair': (): RpcResult => {
    if (!isolatedMode || !environmentMod) {
      return { ok: false, error: 'non-isolated：未启用安装环境隔离' };
    }
    try {
      const ensured = environmentMod.ensureEacEnvironment();
      return {
        ok: true,
        repaired: true,
        root: ensured.paths.root,
        dshHome: ensured.paths.dshHome,
        rootExistedBefore: ensured.rootExistedBefore,
        note: '环境已确保可用（dpx 幂等创建）；如需清理请使用 environment.remove',
      };
    } catch (error) {
      return {
        ok: false,
        error: String((error instanceof Error && error.message) || error),
        hint: '环境无法通过幂等创建修复（注册表损坏/目录被占用）。可用 environment.status 诊断，'
          + '或在确认数据可弃后用 environment.remove({ purge: true }) 清理后重装。',
      };
    }
  },
  // ---- 插件管理（v6 Task 3.3 接回）----------------------------------------
  // 仅供本机 Web UI 经 bridge 调用；Rust 壳不直接消费这些方法
  //（main.rs 仅测试断言出现 plugins.list）。
  'plugins.list': (): RpcResult => ({
    list: (pluginOpsMod.pluginManagerCollect as () => unknown[])(),
  }),
  'plugins.set-enabled': (p): RpcResult =>
    (pluginOpsMod.pluginManagerSetEnabled as (id: string, en: boolean) => Record<string, unknown>)(
      String((p && p.id) || ''), !!(p && p.enabled),
    ),
  'plugins.set-removed': async (p): Promise<RpcResult> =>
    await (pluginOpsMod.pluginManagerSetRemoved as (id: string, rm: boolean) => RpcResult | Promise<RpcResult>)(
      String((p && p.id) || ''), !!(p && p.removed),
    ),
  // 保护中心动作面（guard-box 真实现覆盖 v6 桩）。
  'guard.ensure': (): RpcResult => ({
    ok: !!(guardBoxMod.ensureGuard as () => unknown)(),
  }),
  'guard.action': (p): RpcResult => {
    const action = String((p && p.action) || '');
    // v6 Task 3.3 修复：插件侧 bridge.guard.action(action, value) 只传两个位置参数
    //（见 dsh-plugin-shield/lib/client.js 的 `var call = function (action, value)`），
    // 因此取参必须是 p.value —— 原实现读 p.label / p.id 会让 snapshot 丢参、
    // restore 直接失效。动作集合按 v5 对齐（保护中心 UI 的 7 个动作）。
    const value = p && p.value;
    const g = (guardBoxMod.ensureGuard as () => Record<string, (...a: unknown[]) => unknown>)();
    switch (action) {
      case 'status': {
        const st = loadSettings() as { shareWebProfile?: boolean };
        return {
          ok: true,
          profile: desktopProfileFn(),
          shareWebProfile: st.shareWebProfile === true,
          // 上限 20 条：快照/事故目录可能很长，避免一次回传压垮 UI。
          snapshots: (g.listSnapshots as () => unknown[])().slice(0, 20),
          incidents: (g.listIncidents as () => unknown[])().slice(0, 20),
          lastGood: (g.lastGoodSnapshot as () => unknown)(),
        };
      }
      case 'snapshot': {
        const s = (g.snapshot as (r: string) => unknown)(String(value || 'manual'));
        return { ok: !!s, snapshot: s };
      }
      case 'restore': {
        // 服务在跑时不允许回滚（文件被占用且随即会被重写）。
        const running = (bootMod.state as () => { running: boolean })().running;
        if (running) {
          return { ok: false, error: 'service-running', hint: '请先重启 Web 服务（或让回滚在重启间隙执行）' };
        }
        return (g.restore as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      }
      case 'check':
        return { ok: true, report: (g.healthCheck as () => unknown)() };
      case 'repair': {
        const r = (g.repair as () => { applied: unknown })();
        return { ok: true, applied: r.applied };
      }
      case 'incident':
        return (g.readIncident as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      case 'resolve-incident':
        return (g.resolveIncident as (v: unknown) => Record<string, unknown>)(value) as Record<string, unknown>;
      // 以下为 v6 特有的无 UI 消费方动作，保留以兼容既有调用方。
      case 'last-good':
        return { ok: true, snapshot: (g.lastGoodSnapshot as () => unknown)() };
      case 'diagnostics':
        return { ok: true, junctions: (g.junctionFindings as () => unknown[])() as unknown[] };
      case 'repair-junctions':
        return { ok: true, ...(g.repairJunctions as () => Record<string, unknown>)() };
      default:
        return { ok: false, error: 'unknown action' };
    }
  },
  // ---- 文件能力（v6 Task 3.3 接回；dsh-client-file-changes 消费）----
  // files.open 走 Rust L1 的 ShellExecuteW；本方法只做「授权判定」，返回
  // 归一化后的绝对路径供壳层打开（授权必须先于打开，见 main.rs files.open）。
  'files.authorize-open': (p): RpcResult => {
    let fp = (p && p.path) as string;
    if (typeof fp !== 'string' || !path.isAbsolute(fp)) return { ok: false, error: 'path must be absolute' };
    // 归一化必须先于前缀比对：原始串可携带 `..`/大小写变体/符号链接骗过
    // 字面前缀命中。realPath 跟随符号链接与 ..；叶子不存在时用已解析的父
    // 目录拼回（随后 existsSync 把关）。
    try {
      fp = fs.realpathSync(fp);
    } catch {
      try {
        fp = path.resolve(fs.realpathSync(path.dirname(fp)), path.basename(fp));
      } catch { /* 父目录也不可解析：保持原串，交给下方围栏判定 */ }
    }
    const lower = (x: string): string => (process.platform === 'win32' ? x.toLowerCase() : x);
    const skillsRoots = [
      path.join(dshHome, 'skills'),
      path.join(process.env.DSH_AGENTS_HOME || path.join(os.homedir(), '.agents'), 'skills'),
    ].map((r) => lower(path.resolve(r)));
    const fpL = lower(fp);
    const underSkillsRoot = skillsRoots.some((r) => fpL === r || fpL.startsWith(r + path.sep));
    if (!underSkillsRoot && !(fileRootsMod.isUnderFileRoots as (x: string) => boolean)(fp)) {
      return { ok: false, error: 'path outside session workspace' };
    }
    if ((fileRootsMod.DANGEROUS_EXT as RegExp).test(fp)) {
      return { ok: false, error: 'executable files are not openable from the file view' };
    }
    if (!fs.existsSync(fp)) return { ok: false, error: 'file not found' };
    return { ok: true, path: fp };
  },
  // 文件逐项还原（内容精确匹配后替换；上限与 v5 一致）。
  'files.revert': (p): RpcResult => {
    const changes = (p && p.changes) as Array<{ path?: string; oldText?: string; newText?: string }>;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 300) return { results: [] };
    const results: Record<string, unknown>[] = [];
    for (const c of changes) {
      const fp = String((c && c.path) || '');
      const oldText = String((c && c.oldText) ?? '');
      const newText = String((c && c.newText) ?? '');
      if (!path.isAbsolute(fp) || oldText.length > 400000 || newText.length > 400000) {
        results.push({ path: fp, status: 'invalid' });
        continue;
      }
      if (!(fileRootsMod.isUnderFileRoots as (x: string) => boolean)(fp)) {
        results.push({ path: fp, status: 'forbidden' });
        continue;
      }
      try {
        const exists = fs.existsSync(fp);
        const content = exists ? fs.readFileSync(fp, 'utf8') : null;
        if (oldText === '' && newText !== '') {
          if (content !== null && content === newText) { fs.rmSync(fp); results.push({ path: fp, status: 'reverted' }); }
          else results.push({ path: fp, status: content === null ? 'missing' : 'conflict' });
        } else if (newText === '' && oldText !== '') {
          if (content === null) { fs.writeFileSync(fp, oldText, 'utf8'); results.push({ path: fp, status: 'reverted' }); }
          else results.push({ path: fp, status: 'conflict' });
        } else {
          if (content !== null && content.includes(newText)) {
            const occurrences = content.split(newText).length - 1;
            fs.writeFileSync(fp, content.replace(newText, () => oldText), 'utf8');
            results.push(occurrences > 1
              ? { path: fp, status: 'reverted', occurrences, note: 'oldText 多处匹配，仅回滚第一处' }
              : { path: fp, status: 'reverted' });
          } else {
            results.push({ path: fp, status: content === null ? 'missing' : 'conflict' });
          }
        }
      } catch (e) {
        results.push({ path: fp, status: 'error', error: String(((e as Error).message) || e) });
      }
    }
    return { results };
  },
  // 注：shell.open-external 与 files.open 属 L1 域，由 Rust handle_shell_method
  // 直接拦截（ShellExecuteW），不经 sidecar。sidecar 只在内部需要打开外链时
  // 用 notify('shell.open-external') 通知壳层执行（见 clientUpdateMod.init）。
  // 拖入文件落盘（dsh-file-drop-eac 消费；上限与 data URL 校验在 plugin-ops）。
  'file-drop.save': (p): RpcResult => {
    try {
      return (pluginOpsMod.fileDropSave as (d: string, n: string) => Record<string, unknown>)(
        String((p && p.dataUrl) || ''), String((p && p.name) || '拖入文件'),
      );
    } catch (e) {
      return { ok: false, error: String(((e as Error).message) || e) };
    }
  },
  // 原地重启 Web 服务核心。
  'boot.restart': async (): Promise<RpcResult> => restartWebServiceCore(),
};

// ---- 内部 boot glue --------------------------------------------------------
const bootFailureRecorder = stubs.makeBootFailureRecorder(log);

function respond(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line: string) => { void handleLine(line); });
rl.on('close', () => { void gracefulExit(); });

async function gracefulExit(): Promise<void> {
  quitting = true;
  try { if (sessionWatcher) { sessionWatcher.stop(); sessionWatcher = null; } } catch { /* 尽力回收 */ }
  try { await (bootMod.stopServer as () => Promise<void>)(); } catch { /* 尽力回收 */ }
  process.exit(0);
}

async function handleLine(line: string): Promise<void> {
  const text = line.trim();
  if (!text) return;
  let req: RpcReq;
  try { req = JSON.parse(text); } catch {
    return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const { id, method, params } = req;
  try {
    if (method === 'ping') return respond({ jsonrpc: '2.0', id, result: { pong: true, ts: Date.now() } });
    if (method === 'shutdown') {
      respond({ jsonrpc: '2.0', id, result: { bye: true } });
      rl.close();
      return;
    }
    const fixed = methods[method];
    if (fixed) {
      const result = await fixed(params);
      return respond({ jsonrpc: '2.0', id, result: result === undefined ? null : result });
    }
    respond({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  } catch (e) {
    respond({ jsonrpc: '2.0', id, error: { code: -32000, message: String(((e as Error).message) || e) } });
  }
}
