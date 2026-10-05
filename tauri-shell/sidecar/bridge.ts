/// <reference lib="dom" />
'use strict';
// DSH 桌面桥（v6 Task 3.1 · 官方契约 + 壳最小控制面）：在 Tauri WebView2 里
// 暴露 window.dshDesktop（transport = 回环 WS JSON-RPC，而非 ipcRenderer）。
//
// 通道分流：
//   win.*   → Rust 壳层在 WS 中继处本地拦截（窗口控制/拖拽/开发工具）
//   boot.*  → 转发 sidecar（dsh web 进程编排）
//   通知帧（无 id）→ win.maximized / boot.web-ready 推送
//
// 页面侧 chrome：36px 玻璃栏（主窗 decorations(false)，自绘标题栏必需），
// mousedown → win.start-dragging（WebView2 无 -webkit-app-region），5s 心跳，
// 页面异常上报。
//
// 接口面收敛（ADR 0006 v5）：只保留官方 dshDesktop 契约 + 窗口控制 + boot；
// EAC 自造面全部移除，被剥能力接回见 ADR 0006「插口契约」节。
//
// 官方并列面（与 dshDesktop 同层挂在 window 上）：
//   __DSH_LOCALE__   — SYNC-002，官方 LocaleBridge（preload-app.ts:102-105）
//   __DSH_HOST_PATHS__ — SYNC-003，官方 HostPathsBridge（preload-app.ts:78-83，
//     拖放/粘贴/选取文件的真实磁盘路径 → composer @path 引用；WebView2 能力
//     边界与匹配语义见下方实现区注释）
//   __DSH_DIRECTORY_PICKER__ — SYNC-004，官方 DirectoryPickerBridge
//     （preload-app.ts:75-77，原生目录选择对话框 → 绝对路径 | null；
//     实现区注释见下方 __DSH_DIRECTORY_PICKER__ 节）
//   dshDesktop.browser — SYNC-006，官方 DesktopBrowserBridge（types.d.ts:16-23，
//     侧栏浏览器租约 acquire/release/onOpenRequested；L1 持有真实 guest 子
//     webview，<webview> 宿主元素适配 —— 实现区注释见下方 SYNC-006 节）

(function () {
  var BAR_ID = '__dsh_desktop_chrome__';
  var BAR_HEIGHT = 36;

  // SYNC-006：页面世代号（每次文档加载唯一）。WS 就绪时经 browser.page-hello
  // 上报 L1，L1 回收世代不符的 guest（官方由 webContents destroyed 收敛页面
  // 死亡后的孤儿租约，本壳以世代比对等价实现，见 main.rs 同名节）。
  var pageGeneration = (function (): string {
    try {
      var c = (window as any).crypto;
      if (c && typeof c.randomUUID === 'function') return String(c.randomUUID());
    } catch (e) { /* vm 单测无 crypto */ }
    return 'gen-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  })();

  // ---------------------------------------------------------------------------
  // data-platform（SYNC-001 · 官方 markDocumentPlatform 同语义）
  //
  // 官方 preload-platform.ts:10-17 在 <html> 标 process.platform，客户端
  // dsh-client-shortcuts 的 detectEnvironment（client.js:721-724）见到该属性即判
  // runtime='desktop'，缺失走 web 分支（桌面键位等能力全部失效）—— 这是官方
  // client 包读取的桌面壳标记。Tauri 桥运行在页面层、无 process，用
  // navigator.platform（WebView2 在 Windows 恒 'Win32'）+ userAgent 复核判定。
  // 局限：UA 可被伪造误判，但本属性由壳在 document-start 注入、先于页面脚本，
  // 页面自身没有伪造窗口期；对 shortcuts 仅影响平台专属默认键位。
  //
  // 取值域：'windows' | 'macos' | 'linux'（SYNC-001 任务卡指定，与
  // detectEnvironment 的三个归一化分支对齐）。注：官方内核实际标的是
  // process.platform（'win32'/'darwin'/'linux'），本值域对 shortcuts 等价
  //（client.js 用 /win/i、/darwin|mac|.../ 归一化）；但 ui-layout/dockkit 的
  // CSS 按 `data-platform='darwin'` 出 macOS 专属规则 —— 未来接 macOS 壳时
  // darwin 一支应改标 'darwin' 而非 'macos'。取值必须先于 setAttribute 完成
  //（markDocumentPlatform 内部先算 value 再标记）。
  // ---------------------------------------------------------------------------
  function detectShellPlatform(): 'windows' | 'macos' | 'linux' {
    var platform = '';
    var ua = '';
    try { platform = String(navigator.platform || ''); } catch (e) { /* 桥单测 vm 无 navigator */ }
    try { ua = String(navigator.userAgent || ''); } catch (e) { /* 同上 */ }
    if (/win/iu.test(platform) || /Windows NT/iu.test(ua)) return 'windows';
    if (/mac|iphone|ipad|darwin/iu.test(platform) || /Macintosh|Mac OS X/iu.test(ua)) return 'macos';
    return 'linux';
  }

  function markDocumentPlatform(): void {
    var value = detectShellPlatform();
    var root = document.documentElement as HTMLElement | null;
    if (!root) {
      // 官方同款防御：初始化脚本可能先于文档根存在执行，延迟到 DOM ready。
      document.addEventListener('DOMContentLoaded', function () { markDocumentPlatform(); }, { once: true });
      return;
    }
    root.setAttribute('data-platform', value);
  }
  markDocumentPlatform();

  // 回环 WS JSON-RPC 客户端（单源：assets/ws-jsonrpc-client.js，Rust 壳在
  // initialization_script 序列中先注入本桥）。connect/queue/call/重连逻辑
  // 只存在于单源文件；这里只做钩子接线与语义别名。
  var notifyHooks: ((method: string, params: any) => void)[] = [];
  var readyHooks: ((info: any) => void)[] = [];
  var rpc = (window as any).__DSH_WS_RPC__({
    onOpen: function () {
      // SYNC-006：页面世代报到（fire-and-forget）。L1 以此回收旧文档的孤儿
      // guest；同文档的 WS 重连世代不变 → 幂等。先于任何 browser.* 调用。
      send('browser.page-hello', { generation: pageGeneration });
      call('boot.state', {}).then(function (info) {
        try { readyHooks.forEach(function (h) { h(info); }); } catch (e) { /* boot.state 不可用不致命 */ }
      }).catch(function () { /* boot.state 不可用不致命 */ });
      // SYNC-005：拉当前快捷键快照（WS 通知帧不回放，重连/重载后 revision
      // 必须重新同步 —— 否则原生输入带着旧/占位 revision，全部被客户端按
      // revision 对账丢弃，快捷键失联）。sidecar 未就绪/旧壳时静默降级。
      call('shortcuts.state', {}).then(function (snap: unknown) {
        noteSnapshot(snap);
      }).catch(function () { /* shortcuts 持久化不可用不致命（输入按未同步丢弃） */ });
    },
  });
  rpc.onNotify(function (method: string, params: any): void {
    try { notifyHooks.forEach(function (h) { h(method, params); }); } catch (e) { /* 同上 */ }
  });

  // fire-and-forget（ipcRenderer.send 语义）：不等回复，断了就丢。
  function send(method: string, params?: unknown): void { rpc.send(method, params); }
  // invoke 语义（ipcRenderer.invoke）：Promise + 超时。
  function call(method: string, params?: unknown, timeoutMs?: number): Promise<any> { return rpc.call(method, params, timeoutMs); }
  function onNotify(fn: (method: string, params: any) => void): void { notifyHooks.push(fn); }

  // ---------------------------------------------------------------------------
  // window.dshDesktop（v6 Task 3.1 · 官方契约 + 壳最小控制面）
  //
  // 面收敛依据（ADR 0006 v5 裁决 + 2026-10-01 SYNC-007 契约勘误，勘误见
  // ADR 0006「官方契约依据」节）：只保留「官方保留的接口」——
  //   1. 官方 dshDesktop 契约 = 内核 apps/desktop/src/ipc.ts:71-81 的
  //      DshDesktopProductApi：protocolVersion / browser / keyboard /
  //      shortcuts / updates.{status,open,subscribe}（0.2.0 另增 deviceInfo）。
  //      v5 曾把契约误写为「locale()/plugins.*/updates.{check,install}」——
  //      官方全包 grep 无此三面消费者，属误读，已勘误。keyboard 为
  //      SYNC-001 接回（官方 shortcuts 包检测到 data-platform 即硬依赖），
  //      shortcuts 为 SYNC-005 接回，browser 为 SYNC-006 接回，
  //      updates.status/subscribe 为 SYNC-005 接回的真实事件源。
  //   2. 壳最小控制面：windowControls（窗口控制，主窗 decorations(false)
  //      自绘标题栏必需）+ boot（拉起/停止/查询 dsh web）。
  // 无主面（官方无、零消费者，SYNC-007 删除）：locale()（职责归官方
  //      __DSH_LOCALE__，SYNC-002）、plugins.*（与 EAC 自有 pluginManager.*
  //      重叠，官方插件管理走 host 远程面）、updates.{check,install}
  //     （官方只有 status/open/subscribe）、getPathForFile（职责归官方
  //      __DSH_HOST_PATHS__.pathFor，SYNC-003）。
  // 其余 EAC 自造面（chrome.init / menu.* / rc.* / rescue.* / recovery.* /
  // onboard.* / wizard.* / service.* / profile.* / float.* / imagePaste /
  // copyText / phoneBridge / pluginWizard / balance* / pluginUpdates）继续
  // 退役（STILL_RETIRED 锁定）；fileDrop / pluginManager / guard / getInfo /
  // revertFiles / openPath / openExternal 为 Task 3.3 接回的 EAC 自有面
  //（见下方「v6 Task 3.3 接回」区），非官方契约、非无主面。
  // ---------------------------------------------------------------------------
  function unavailable(capability: string): Promise<never> {
    return Promise.reject(new Error('capability "' + capability + '" is not bundled in the v6 minimal core'));
  }

  // ---------------------------------------------------------------------------
  // keyboard（SYNC-001 · 官方 DesktopKeyboardApi，native.d.ts 逐字段对齐）
  //
  // 强耦合背景：dsh-client-shortcuts 检测到 data-platform 即 runtime='desktop'
  // 并立即取 window.dshDesktop?.keyboard（client.js:1854-1855），缺失即
  // throw "Desktop keyboard bridge unavailable" —— data-platform 与 keyboard
  // 必须同批落地，缺一官方 shortcuts 包硬崩。
  //
  // 物理键捕获选型（SYNC-001 任务卡方案甲 · JS 层）：WebView2 无 Electron 的
  // before-input-event；方案乙（L1 accelerator）需 Win32 键盘钩子并在壳层自建
  // 键位解析与推送通道，改动面大、与页面聚焦态（本地控件优先消费）耦合困难。
  // 改为页面层 window keydown 捕获监听（capture 态、只观察上报、绝不
  // preventDefault/stopPropagation），就地组装官方 DesktopShortcutInput 分发
  // 给 subscribe 的 listener。官方客户端在 desktop 态的 DOM keydown 只喂 fixed
  // 动作（installKeyboard 的 native=true 分支，client.js:736），可配置键位一律
  // 走原生推送 —— 两通道不重复分发，与官方 Electron 形态一致。
  //
  // 已知缺口：跨文档 guest（侧边栏浏览器框 iframe/webview）聚焦时按键不冒泡
  // 到顶层 window；'iframe'/'webview' 分支按官方 preload-app.ts:21-31 的
  // activeElement 匹配集组装形态，但捕获依赖顶层 keydown 到达。完整对齐官方
  // 主进程级捕获需 L1 接管，留给后续 SYNC 任务。
  // ---------------------------------------------------------------------------

  // ShortcutRevision 运行时是 Branded<string>（编译期品牌，值即字符串）。真实
  // revision 由 sidecar 的官方 ShortcutPersistence（SYNC-005，
  // @deepseek-ai/dsh-client-shortcuts/lib/protocol.js）在每次快照 accept 时生成，
  // 经 'shortcuts.snapshot' 通知帧（及 get/edit 的快照字段）下发 —— noteSnapshot
  // 按 sequence 门控缓存。官方 installNativeKeyboard（client.js:896）会丢弃
  // revision 与其快照不一致的输入，因此原生输入必须携带缓存里的当前值；
  // 快照尚未到达（WS 未同步/旧壳）时退回占位串（该输入将被客户端丢弃，
  // 与官方「配置未就绪不分发」语义一致，绝不放行）。
  var SHORTCUT_REVISION_PLACEHOLDER = 'eac-shortcut-revision-0';
  var shortcutRevision: string | null = null;
  var shortcutSequence = -1;
  var shortcutRecording = false;
  var keyboardListeners: ((input: unknown) => void)[] = [];
  var shortcutListeners: ((snapshot: unknown) => void)[] = [];
  var keyboardCaptureInstalled = false;

  // 快照收束（SYNC-005）：notify 帧 / get/edit 回包统一入口。形态校验（revision
  // 字符串 + document 对象 + sequence 数字）挡住旧壳/畸形回包；sequence 门控
  //（官方语义「clients discard out-of-order IPC replies」）挡住 WS 通知帧与
  // 回包不同路到达造成的回退。
  function noteSnapshot(snapshot: unknown): void {
    var snap = snapshot as { revision?: unknown; sequence?: unknown; document?: unknown } | null;
    if (!snap || typeof snap.revision !== 'string' || snap.revision === ''
      || typeof snap.sequence !== 'number' || !snap.document || typeof snap.document !== 'object') return;
    if (shortcutSequence >= 0 && (snap.sequence as number) < shortcutSequence) return;
    shortcutSequence = snap.sequence as number;
    shortcutRevision = snap.revision as string;
    for (var i = 0; i < shortcutListeners.length; i++) {
      var listener = shortcutListeners[i];
      if (typeof listener !== 'function') continue;
      try { listener(snapshot); } catch (e) { /* listener 异常不断桥 */ }
    }
  }

  function emitShortcutInput(input: unknown): void {
    for (var i = 0; i < keyboardListeners.length; i++) {
      var listener = keyboardListeners[i];
      if (typeof listener !== 'function') continue;
      try { listener(input); } catch (e) { /* listener 异常不断桥 */ }
    }
  }

  // 官方 DesktopShortcutInput 组装（native.d.ts）：{ revision, kind, frameName,
  // code, secondCode?, control, alt, shift, meta, repeat }。secondCode 是双键
  // chord（如 Ctrl+K,C），单次 keydown 无从产生，按官方主进程行为省略
  //（keyboard.ts:202 仅 chord 命中时附带）。iframe/webview 分支与官方
  // preload-app.ts:21-31 同一匹配集：activeElement 命中侧边栏浏览器宿主元素
  // 即改发嵌入形态 + frameName；frameName 为空即丢弃（官方语义：无名的嵌入
  // 宿主无法回验所有权，宁可不分发）。
  function assembleShortcutInput(event: KeyboardEvent): Record<string, unknown> | null {
    var code = event.code;
    var control = !!event.ctrlKey;
    var alt = !!event.altKey;
    var shift = !!event.shiftKey;
    var meta = !!event.metaKey;
    var repeat = !!event.repeat;
    // SYNC-005：真实 revision（sidecar 官方 ShortcutPersistence 下发）；未同步
    // 时占位串 —— 客户端按 revision 不匹配丢弃，等价官方「配置未就绪不分发」。
    var revision = shortcutRevision !== null ? shortcutRevision : SHORTCUT_REVISION_PLACEHOLDER;
    var active = document.activeElement as Element | null;
    if (active && typeof active.matches === 'function' && active.isConnected) {
      // webview 分支先判（webview 宿主元素不是 HTMLIFrameElement）。
      if (active.matches('webview[data-sidebar-browser-frame]')) {
        var webviewName = active.getAttribute('name') || '';
        if (!webviewName) return null;
        return { revision: revision, kind: 'webview', frameName: webviewName, code: code, control: control, alt: alt, shift: shift, meta: meta, repeat: repeat };
      }
      if (active.matches('iframe[data-sidebar-browser-frame], iframe[data-html-preview]')) {
        var frameName = (active as HTMLIFrameElement).name || '';
        if (!frameName) return null;
        return { revision: revision, kind: 'iframe', frameName: frameName, code: code, control: control, alt: alt, shift: shift, meta: meta, repeat: repeat };
      }
    }
    return { revision: revision, kind: 'keyboard', frameName: '', code: code, control: control, alt: alt, shift: shift, meta: meta, repeat: repeat };
  }

  function onKeydownCapture(event: KeyboardEvent): void {
    // SYNC-005 recording 门：官方语义（keyboard.ts:97-102 · recording(active)）
    // —— 录制态暂停物理键拦截/原生输入分发（键位编辑器此时经 DOM 自收按键，
    // 不应再触发已配置命令）。物理捕获监听就挂在本桥，同层暂停即官方同义。
    if (shortcutRecording) return;
    var input = assembleShortcutInput(event);
    if (input === null) return;
    emitShortcutInput(input);
  }

  // 惰性安装：首个 listener 订阅才挂捕获，最后一个退订即卸 —— 打字是热路径，
  // 无消费者时不应每个按键都组装输入对象。
  function ensureKeyboardCapture(): void {
    if (keyboardCaptureInstalled) return;
    keyboardCaptureInstalled = true;
    // capture 态只保证早于页面冒泡监听观察，不拦截：本地控件（xterm/输入框）
    // 先处理属正常，本桥不做任何 consume。
    window.addEventListener('keydown', onKeydownCapture, true);
  }

  function releaseKeyboardCapture(): void {
    if (!keyboardCaptureInstalled) return;
    keyboardCaptureInstalled = false;
    window.removeEventListener('keydown', onKeydownCapture, true);
  }

  // ---------------------------------------------------------------------------
  // SYNC-005：dshDesktop.shortcuts（官方 DesktopShortcutsApi，persistence.d.ts
  // 逐字段对齐）+ dshDesktop.updates 真事件源。
  //
  // shortcuts 通道映射：get/edit 经 WS call('shortcuts.get'/'shortcuts.edit')
  // 交 sidecar 的官方 ShortcutPersistence（userData/keybindings.json 单写者、
  // revision/sequence/冲突分类全部由内核协议实现保证 —— 见 server.ts SYNC-005
  // 区注释）；快照变更由 sidecar notify('shortcuts.snapshot') 推送、本桥经
  // noteSnapshot（sequence 门控）分发给 subscribe 监听者并联动 keyboard 的
  // revision；recording 是页面层状态门（物理捕获监听就在本桥，同层暂停即
  // 官方「录制态暂停物理键拦截」语义，无需绕行 WS）。
  //
  // updates 通道映射：status 经 call('updates.status')；sidecar 以真实更新链
  // 落盘态（settings.pendingClientUpdate，client-update.js 写入）映射官方
  // DesktopUpdatePresentation（映射依据见 server.ts updates 区注释，无流时
  // 如实 idle）；subscribe 在 0→1/1→0 时 call('updates.subscribe'/
  // 'updates.unsubscribe') 交 sidecar 启停文件变化监听，状态变化经
  // notify('updates.presentation') 推送。open 保持退役 reject（既有锁定），
  // check/install 无主面已由 SYNC-007 删除（官方无此二方法，全包无消费者）。
  // ---------------------------------------------------------------------------
  var UPDATE_PHASES = ['idle', 'checking', 'available', 'downloading', 'verifying', 'installing', 'ready', 'error'];
  var updateListeners: ((presentation: unknown) => void)[] = [];
  var updateWatchers = 0;
  // 通知帧/回包统一归一：phase 不在官方枚举内（旧壳/畸形）一律按 idle 呈现，
  // 不把未知形态外泄给消费者（官方 DesktopUpdatePresentation 的 phase 是封闭
  // 枚举；settings 消费者按枚举选文案）。
  function normalizePresentation(p: unknown): unknown {
    var presentation = p as { phase?: unknown } | null;
    if (presentation && typeof presentation.phase === 'string'
      && UPDATE_PHASES.indexOf(presentation.phase) >= 0) return presentation;
    return { phase: 'idle' };
  }
  onNotify(function (method: string, params: any): void {
    try {
      if (method === 'shortcuts.snapshot') noteSnapshot(params);
      else if (method === 'updates.presentation') {
        var presentation = normalizePresentation(params);
        for (var i = 0; i < updateListeners.length; i++) {
          var listener = updateListeners[i];
          if (typeof listener !== 'function') continue;
          try { listener(presentation); } catch (e) { /* listener 异常不断桥 */ }
        }
      }
    } catch (e) { /* 通知帧畸形不炸桥 */ }
  });

  // ---------------------------------------------------------------------------
  // deviceInfo（KERN-004 · 0.2.0 新增官方契约键）
  //
  // 契约：内核 apps/desktop/src/ipc.ts:81 DshDesktopProductApi.deviceInfo ——
  //   `deviceInfo(): Promise<string>`（官方 preload-app.ts:17 即
  //   ipcRenderer.invoke 透传 Promise<string>）。
  // 官方消费者调研（0.2.0 ui-settings-account client.js:4357 contactUs）：取
  //   globalThis.dshDesktop?.deviceInfo 调用一次，结果作为 prefill_device_info
  //   拼进「联系我们」问卷 URL；桥键缺失回退 navigator.userAgent，Promise
  //   reject 回退空串。
  //
  // 形态决策（任务卡「先看官方 0.2.0 消费者怎么用它再定形态」）：官方主进程
  //   实现（0.2.0 apps/desktop/src/device-info.ts readDeviceInfo）是机器描述串
  //   —— `name=value` 字段以 '; ' 连接（platform/os/app_arch/cpu/memory_gib，
  //   来源不可用即整段省略）；ipc.ts JSDoc 明确「no hostname, user name, or
  //   serial number」。任务卡原案「壳侧稳定设备 ID（L1 持久化/userData 自持）」
  //   会把持久标识经第三方问卷（飞书表单）外泄，违背官方隐私语义 —— 不采用，
  //   对齐官方机器描述形态（任务卡同一行「对齐官方 0.2.0 语义」为准）。
  //
  // 实现位置：页面层就地组装，不经 sidecar。sidecar server.ts / Rust main.rs
  //   不在本任务改动域；且官方五字段中 cpu 型号与物理总内存无页面等价观测
  //   （hardwareConcurrency 是核数、deviceMemory 是封顶 8GiB 的分桶近似，均非
  //   官方 cpus()/totalmem() 语义，宁缺勿假），按官方 collect 语义省略；
  //   platform/os/app_arch 以 navigator.userAgent 复现，app_arch 优先取
  //   UA-CH 高熵提示（Windows-on-Arm 的 UA 兼容层仍标 Win64; x64，UA-CH 才是
  //   真实架构）。已知保真度缺口：Windows UA 大版本在 Win10/11 均冻结为
  //   NT 10.0，真实 build 号（官方 os=10.0.22000）页面层不可观测 —— 如实
  //   上报可见版本。
  //
  // 保底：platform 是官方无条件在首的字段（device-info.ts:11），本实现同构
  //   —— 任何观测失败也至少返回 platform= 一项且绝不 reject（消费者对
  //   reject 的降级是空串，比缺字段更差）。
  // ---------------------------------------------------------------------------
  function detectDevicePlatform(): string {
    // 官方标 process.platform 原值（win32/darwin/linux），与 data-platform 的
    // 归一化值域（windows/macos/linux）不同源，此处映射回官方原值。
    var normalized = detectShellPlatform();
    return normalized === 'windows' ? 'win32' : normalized === 'macos' ? 'darwin' : 'linux';
  }

  // UA 里的 OS 版本（官方 process.getSystemVersion() 的页面等价观测）：
  // Windows NT x.y / Mac OS X x_y_z / Android x.y / 常见 Linux 发行版 x.y。
  function deviceOsFromUa(ua: string): string | null {
    var m: RegExpExecArray | null;
    var v: string | undefined;
    m = /Windows NT ([0-9][0-9.]*)/.exec(ua); v = m ? m[1] : undefined; if (v) return v;
    m = /Mac OS X ([0-9][0-9_]*)/.exec(ua); v = m ? m[1] : undefined; if (v) return v.replace(/_/g, '.');
    m = /Android ([0-9][0-9.]*)/.exec(ua); v = m ? m[1] : undefined; if (v) return v;
    m = /(?:Ubuntu|Fedora|Deepin|UOS|openSUSE|Linux Mint)[ /]([0-9][0-9.]*)/.exec(ua); v = m ? m[1] : undefined; if (v) return v;
    return null; // 官方 collect 语义：来源不可用即省略
  }

  // 架构映射到官方 process.arch 值域（x64/ia32/arm64/arm）。
  function mapUaChArch(architecture: unknown, bitness: unknown): string | null {
    if (typeof architecture !== 'string' || architecture === '') return null;
    if (architecture === 'x86') {
      if (bitness === '64') return 'x64';
      if (bitness === '32') return 'ia32';
      return null;
    }
    if (architecture === 'arm') return bitness === '64' ? 'arm64' : 'arm';
    return architecture;
  }

  function deviceArchFromUa(ua: string): string | null {
    if (/arm64|aarch64/i.test(ua)) return 'arm64';
    if (/x64|win64|wow64|x86_64|amd64/i.test(ua)) return 'x64';
    if (/armv[1-7]|arm[;) ]/i.test(ua)) return 'arm';
    if (/i[3-6]86/.test(ua)) return 'ia32';
    return null;
  }

  // 组装（纯函数，vm 单测可直接断言）：官方 device-info.ts readDeviceInfo 的
  // 同构实现 —— 字段序 platform/os/app_arch/cpu/memory_gib，缺观测整段省略。
  function composeDeviceInfo(archHint: string | null): string {
    var fields = ['platform=' + detectDevicePlatform()];
    try {
      var os = deviceOsFromUa(String(navigator.userAgent || ''));
      if (os) fields.push('os=' + os);
    } catch (e) { /* 无 navigator（vm 单测）即省略 */ }
    var arch = archHint;
    if (!arch) {
      try { arch = deviceArchFromUa(String(navigator.userAgent || '')); } catch (e) { arch = null; }
    }
    if (arch) fields.push('app_arch=' + arch);
    // cpu/memory_gib：页面层无官方语义等价观测，按官方 collect 语义省略。
    return fields.join('; ');
  }

  function requestDeviceInfo(): Promise<string> {
    var uad: any = null;
    try { uad = (navigator as any).userAgentData || null; } catch (e) { /* vm 无 navigator */ }
    if (uad && typeof uad.getHighEntropyValues === 'function') {
      return uad.getHighEntropyValues(['architecture', 'bitness']).then(
        function (hints: any) {
          return composeDeviceInfo(mapUaChArch(hints && hints.architecture, hints && hints.bitness));
        },
        function () { return composeDeviceInfo(null); },
      );
    }
    return Promise.resolve(composeDeviceInfo(null));
  }

  (window as any).dshDesktop = {
    // ---- 官方 dshDesktop 契约 ----
    protocolVersion: 1,
    // SYNC-001：官方 DesktopKeyboardApi（内核 ipc.ts:74 + dsh-client-shortcuts
    // native.d.ts）。官方 shortcuts 包检测到 data-platform 即硬依赖本面
    //（client.js:1854-1855），缺失立即 throw —— 实现体见上方 keyboard 区。
    keyboard: {
      // 物理键按下推送（DesktopShortcutInput），返回 disposer —— 形态对齐官方
      // preload-app.ts:19-36（ipcRenderer.on/off 的桥层等价物）。
      subscribe: function (listener: (input: unknown) => void): () => void {
        keyboardListeners.push(listener);
        ensureKeyboardCapture();
        return function () {
          var i = keyboardListeners.indexOf(listener);
          if (i >= 0) keyboardListeners.splice(i, 1);
          if (keyboardListeners.length === 0) releaseKeyboardCapture();
        };
      },
      // 官方语义（keyboard.ts:97-102）：主进程校验 revision 仍当前、窗口聚焦、
      // 未录键、未遮挡才关窗。SYNC-005 起可对账 revision：缓存快照（sidecar
      // 官方 ShortcutPersistence）已同步且与请求不符 → 静默不关（官方对账语义，
      // 防过期快照的主人误关当前窗口）；快照未同步（旧壳/WS 未就绪）→ 透传
      // 由 L1 记录（无对账基准时不擅自拒绝）。录制态同理不关（官方「未录键」
      // 前置）。窗口聚焦前置在本桥结构上天然成立：物理捕获是页面层 keydown，
      // 页面失焦时根本收不到触发输入；遮挡检测无对应观测量，仍是已知缺口。
      closeWindow: function (revision: unknown): Promise<void> {
        if (shortcutRecording) return Promise.resolve();
        if (shortcutRevision !== null && revision !== shortcutRevision) return Promise.resolve();
        return call('win.close', { reason: 'shortcuts.closeWindow', revision: revision })
          .then(function () { /* Promise<void>：不把 win.close 的 ok 回包外泄 */ });
      },
    },
    // SYNC-005：官方 DesktopShortcutsApi（内核 ipc.ts:75 + dsh-client-shortcuts
    // persistence.d.ts 逐字段对齐）。键面恰为 get/edit/subscribe/recording；
    // 实现体见上方 SYNC-005 区注释（持久化与冲突分类在 sidecar 官方内核）。
    shortcuts: {
      // get(definitions) → ShortcutConfigSnapshot（含 revision/sequence/document/
      // status/error/usingDefaults）。目录先经 sidecar 的
      // parseShortcutDefinitions 校验（官方 IPC 入口语义：畸形即 reject，
      // 消费者 failRead 落 'unreadable'），随后 setDefinitions + readCurrent。
      get: function (definitions: unknown): Promise<unknown> {
        return call('shortcuts.get', { definitions: definitions }).then(function (snap: unknown) {
          noteSnapshot(snap);
          return snap;
        });
      },
      // edit(edit, revision) → ShortcutSaveResult（saved/stale/unreadable/
      // write-failed/not-ready/conflict + issue/conflicts，由内核 persistence
      // 分类）。回包里的最新快照同样走 noteSnapshot 联动 keyboard revision。
      edit: function (edit: unknown, revision: unknown): Promise<unknown> {
        return call('shortcuts.edit', { edit: edit, revision: revision }).then(function (result: any) {
          if (result && typeof result === 'object' && result.snapshot) noteSnapshot(result.snapshot);
          return result;
        });
      },
      // recording(active)：录制态暂停物理键拦截（onKeydownCapture 入口门）。
      // 官方 Promise<void>。
      recording: function (active: boolean): Promise<void> {
        shortcutRecording = !!active;
        return Promise.resolve();
      },
      // subscribe(listener)：快照推送（'shortcuts.snapshot' 帧 / get/edit 回包
      // / WS open 拉取，统一经 noteSnapshot 分发），返回 disposer。
      subscribe: function (listener: (snapshot: unknown) => void): () => void {
        shortcutListeners.push(listener);
        return function () {
          var i = shortcutListeners.indexOf(listener);
          if (i >= 0) shortcutListeners.splice(i, 1);
        };
      },
    },
    // KERN-004：0.2.0 新增官方契约键（ipc.ts:81 DshDesktopProductApi.deviceInfo，
    // 官方消费者 ui-settings-account client.js:4357 contactUs）—— 反馈问卷的
    // 本地机器描述。形态与实现位置决策见上方 deviceInfo 区注释。
    deviceInfo: function (): Promise<string> { return requestDeviceInfo(); },
    // SYNC-007 删除无主面 locale()/plugins.*：官方 DshDesktopProductApi 无此
    // 二面且全包零消费者 —— 语言面由官方 __DSH_LOCALE__（SYNC-002，见下方）
    // 承担，插件管理由 EAC 自有 pluginManager.*（Task 3.3 接回）承担。
    updates: {
      // SYNC-005：真实更新态（sidecar 以真实更新链落盘待办映射官方
      // DesktopUpdatePresentation，见 server.ts updates 区注释）。
      status: function (): Promise<unknown> {
        return call('updates.status', {}).then(function (p: unknown) {
          return normalizePresentation(p);
        });
      },
      // 退役语义（ADR 0006 · bridge-preload-parity.test.ts 锁定）：原生确认框
      // 与更新主面未接回，保持 reject。check/install 无主面已由 SYNC-007 删除
      //（官方无此二方法；官方消费者 DesktopUpdateSource 仅用 status/subscribe/open）。
      open: function () { return unavailable('client-update'); },
      // 订阅真实事件流：sidecar 监听 settings.json 变化（真实更新态来源），
      // 变化经 notify('updates.presentation') 推送；0→1/1→0 交 sidecar 启停
      // 监听。返回 disposer。
      subscribe: function (listener: (presentation: unknown) => void): () => void {
        updateListeners.push(listener);
        updateWatchers += 1;
        if (updateWatchers === 1) {
          call('updates.subscribe', {}).catch(function () { /* 旧壳无此方法：仅无推送 */ });
        }
        return function () {
          var i = updateListeners.indexOf(listener);
          if (i >= 0) updateListeners.splice(i, 1);
          updateWatchers -= 1;
          if (updateWatchers <= 0) {
            updateWatchers = 0;
            call('updates.unsubscribe', {}).catch(function () { /* 同上 */ });
          }
        };
      },
    },
    // ---- 壳最小控制面：窗口控制（自绘标题栏与 Rust L1 能力）----
    windowControls: {
      minimize: function () { return call('win.minimize', {}); },
      toggleMaximize: function () { return call('win.toggle-maximize', {}); },
      close: function () { return call('win.close', {}); },
      isMaximized: function () { return call('win.is-maximized', {}).then(function (r) { return !!(r && r.maximized); }); },
      reload: function () { return call('win.reload', {}); },
      toggleDevtools: function () { return call('win.devtools', {}); },
      toggleFullscreen: function () { return call('win.fullscreen', {}); },
      openInBrowser: function () { return call('win.open-browser', {}); },
      onMaximizeChange: function (cb: (maximized: boolean) => void) {
        var hook = function (method: string, params: any) {
          if (method !== 'win.maximized') return;
          try { cb(!!(params && params.maximized)); } catch (e) { /* 回调异常不断桥 */ }
        };
        notifyHooks.push(hook);
        return function () {
          var i = notifyHooks.indexOf(hook);
          if (i >= 0) notifyHooks.splice(i, 1);
        };
      },
    },
    // ---- 壳最小控制面：dsh web 服务编排 ----
    boot: {
      start: function () { return call('boot.start', {}); },
      stop: function () { return call('boot.stop', {}); },
      state: function () { return call('boot.state', {}); },
      restart: function () { return call('boot.restart', {}); },
      onStateChange: function (cb: (info: any) => void) {
        var hook = function (method: string, params: any) {
          if (method !== 'boot.web-ready') return;
          try { cb(params); } catch (e) { /* 回调异常不断桥 */ }
        };
        notifyHooks.push(hook);
        return function () {
          var i = notifyHooks.indexOf(hook);
          if (i >= 0) notifyHooks.splice(i, 1);
        };
      },
    },
    // ---- v6 Task 3.3 接回：内置插件消费的 EAC 面 ----
    // 依据 ADR 0006 v5 的接口收敛清单，这些方法族曾随最简本体剥出；
    // 现按其「插口契约」逐项接回。服务端实现见 sidecar/server.ts。
    // 配置收窄说明：仅恢复当前已接回插件实际消费的键，未恢复的
    // （menu / floatWindow / phoneBridge / pluginUpdates / imagePaste /
    //   recovery / rescue / refreshBalance / restartService 等）继续留空。
    // 依据 metaone01 2026-09-19 裁决（按 ADR 0006）：balance 转推荐插件、
    // plugin-wizard 明确不接入 —— 故 balance* 与 pluginWizard 为终态留空，
    // 由 bridge-preload-parity.test.ts 的 STILL_RETIRED 锁定不得回归。
    pluginManager: {
      list: function () {
        return call('plugins.list', {}).then(function (result: unknown) {
          // 旧插件读取 rows；保留 sidecar 的 list 和其它字段，不修改 RPC 回包。
          if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
          var snapshot = result as Record<string, unknown>;
          if (!Array.isArray(snapshot.list)) return result;
          return Object.assign({}, snapshot, { rows: snapshot.list });
        });
      },
      setEnabled: function (id: string, enabled: boolean) { return call('plugins.set-enabled', { id: id, enabled: enabled }); },
      // 外部插件卸载事务最多等待 120s；桥的超时需覆盖事务收尾。
      setRemoved: function (id: string, removed: boolean) { return call('plugins.set-removed', { id: id, removed: removed }, 130000); },
    },
    guard: {
      action: function (action: string, value?: unknown) { return call('guard.action', { action: action, value: value }); },
    },
    // P1：安装环境运维面（诊断 / 移除）。Web UI 与支持人员用这两个入口
    // 判断「本次启动是否隔离」「环境是否损坏」「如何清理」。
    // 注意：这里只暴露**只读诊断**与**显式移除**；修复语义由 dsh-dpx 的
    // 幂等创建承担，UI 不提供「静默重建注册表」这类危险动作。
    environment: {
      status: function () { return call('environment.status', {}); },
      remove: function (options?: { purge?: boolean; dryRun?: boolean }) {
        return call('environment.remove', {
          purge: !!(options && options.purge),
          dryRun: !!(options && options.dryRun),
        });
      },
      repair: function () { return call('environment.repair', {}); },
    },
    fileDrop: {
      save: function (payload: Record<string, unknown>) { return call('file-drop.save', payload || {}); },
    },
    // SYNC-007 删除无主面 getPathForFile：官方路径面是 __DSH_HOST_PATHS__.pathFor
    //（SYNC-003，见下方），本键 v5 起恒返空串、全包零消费者，已删 —— 插件一律
    // 走官方面取真实磁盘路径。
    // 壳信息（v6 语义：等同 boot.state；staticPort 恒 0，静态预览服务随
    // 插件面剥出，客户端按既有契约回退宿主路由）。
    getInfo: function () { return call('boot.state', {}); },
    // 文件还原（内容精确匹配；白名单校验在 sidecar）。
    revertFiles: function (changes: unknown) { return call('files.revert', { changes: changes }); },
    // 文件打开：L1 拦截（先经 sidecar files.authorize-open 授权，再 ShellExecuteW）。
    openPath: function (path: string) { return call('files.open', { path: path }); },
    // 外链打开：L1 拦截（ShellExecuteW）。
    openExternal: function (url: string) { return call('shell.open-external', { url: url }); },
    // SYNC-006：官方 DesktopBrowserBridge（内核 ipc.ts:73 browser: +
    // dsh-client-ui-sidebar-browser types.d.ts:16-23 逐字段对齐）。租约与
    // guest 生命周期由 L1 持有（真实子 webview，绝不伪造）；<webview> 宿主
    // 元素适配与消费者链见上方 SYNC-006 区注释。
    browser: {
      // acquire(workspace) → Promise<DesktopBrowserReservation{lease,partition}>。
      // generation 随载荷上报（页面世代，L1 孤儿回收依据）。
      acquire: function (workspace: string): Promise<{ lease: string; partition: string }> {
        return call('browser.acquire', { workspace: workspace, generation: pageGeneration }).then(function (r: any) {
          // 形态守门：官方 DesktopBrowserReservation = {lease, partition} 双
          // 非空字符串；畸形回包 reject（绝不降级为伪造租约）。
          if (!r || typeof r.lease !== 'string' || r.lease === ''
            || typeof r.partition !== 'string' || r.partition === '') {
            throw new Error('desktop browser: invalid reservation from shell');
          }
          return { lease: r.lease, partition: r.partition };
        });
      },
      // release(lease) → Promise<void>：L1 销毁 guest 后 resolve（幂等，重复
      // release / 未知 lease 不报错 —— 官方「guest 已销毁后返回」语义）。
      release: function (lease: string): Promise<void> {
        return call('browser.release', { lease: lease }).then(function () { /* Promise<void>：不外泄回包 */ });
      },
      // onOpenRequested(lease, listener) → disposer：guest 请求打开 http(s) 页
      // （window.open/target=_blank）时经 browser.open-requested 帧投递 url；
      // guest 自身恒被 L1 Deny，打开方式由消费者决定（官方同义）。
      onOpenRequested: function (lease: string, listener: (url: string) => void): () => void {
        var key = String(lease);
        var list = browserOpenListeners[key] || (browserOpenListeners[key] = []);
        list.push(listener);
        return function () {
          var arr = browserOpenListeners[key];
          if (!arr) return;
          var i = arr.indexOf(listener);
          if (i >= 0) arr.splice(i, 1);
          if (arr.length === 0) delete browserOpenListeners[key];
        };
      },
    },
    // 桥内省（壳层页面与冒烟用；不属于对外契约）。
    _call: call,
    _send: send,
    _onNotify: onNotify,
    _onReady: function (fn: (info: any) => void) { readyHooks.push(fn); },
  };
  var dshDesktop: any = (window as any).dshDesktop;

  // ---------------------------------------------------------------------------
  // __DSH_LOCALE__（SYNC-002 · 官方 LocaleBridge，preload-app.ts:102-105 逐字段
  // 对齐）
  //
  // 官方形态：read() = ipcRenderer.invoke(DESKTOP_IPC.localeBootstrap)；
  // onChange(locale) = ipcRenderer.send(DESKTOP_IPC.localeChanged, locale)
  //（fire-and-forget）。消费者 dsh-client-locale（client.js:1504-1533）：激活时
  // read() 经 parseLocaleBootstrap（client.js:18-19）严格校验 —— languages 必须
  // 是 string[]、preference 键必须存在且为 string|null，形态错即 throw
  // "locale: invalid native initialization data"；语言切换时 onChange(active) 上报。
  //
  // 通道映射：read() 经 WS call('locale.bootstrap')（Rust L1 本地拦截：返回壳
  // 持久化 preference + 系统语言标签）。languages 按 detectBrowserLocale 的
  // 浏览器侧语义（client.js:1476-1479）以 navigator.languages 优先、L1 系统标签
  // 兜底合并去重 —— WebView2 的 navigator.languages 跟随 OS 用户语言列表，与
  // 官方 app.getPreferredSystemLanguages() 等价且更完整；languages 保证非空
  //（'en' 兜底，与官方 resolveInitialLocale 的默认语言一致）。preference 透传
  // L1（string 或 null），壳无持久化时为 null（= 官方「自动选择」语义）。
  // read() 失败不降级 —— 与官方一致（invoke 失败即异常，消费者据此终止激活）。
  // onChange 经 WS send('locale.changed', {locale})（L1 拦截：持久化 preference
  // + 重建托盘菜单文案）。官方 main.ts:711 的应用菜单/平台页刷新在 EAC 无对应
  // 面（无原生应用菜单、无平台页），托盘菜单文案是语言回写的壳侧落点。
  // ---------------------------------------------------------------------------
  (window as any).__DSH_LOCALE__ = {
    read: function (): Promise<{ languages: string[]; preference: string | null }> {
      return call('locale.bootstrap', {}).then(function (r: any) {
        var languages: string[] = [];
        var seen: Record<string, boolean> = {};
        var push = function (tag: unknown): void {
          if (typeof tag !== 'string' || !tag || seen[tag]) return;
          seen[tag] = true;
          languages.push(tag);
        };
        try {
          // 浏览器侧语言优先序（detectBrowserLocale 同源）；桥单测 vm 无
          // navigator 时引用即 ReferenceError，捕获后走 L1 系统标签兜底。
          var navList = (navigator && navigator.languages) || [];
          for (var i = 0; i < navList.length; i++) push(navList[i]);
          push((navigator && navigator.language) || '');
        } catch (e) { /* 同上 */ }
        var fromShell = r && Array.isArray(r.languages) ? r.languages : [];
        for (var j = 0; j < fromShell.length; j++) push(fromShell[j]);
        if (languages.length === 0) push('en');
        return {
          languages: languages,
          preference: r && typeof r.preference === 'string' ? r.preference : null,
        };
      });
    },
    onChange: function (locale: string): void {
      send('locale.changed', { locale: locale });
    },
  };

  // ---------------------------------------------------------------------------
  // __DSH_HOST_PATHS__（SYNC-003 · 官方 HostPathsBridge，preload-app.ts:78-83 逐
  // 字段对齐）
  //
  // 官方形态：pathFor(file) = Electron webUtils.getPathForFile(file)。composer
  // 把「拖放/粘贴/选取的、有真实磁盘路径的文件」标成 @path 引用而非上传
  //（消费者 dsh-client-ui-conversation/lib/client.js:18290：path 非空且（目录
  // 或非图片）→ @path 引用；path 为空 → 上传；粘贴的字节流（截图）无真实路径
  // 必须返回 ''，官方注释原文语义）。
  //
  // WebView2 能力边界（SYNC-003 调研结论，证据见任务自证材料）：
  //   * 页面层：Chromium 的 File 没有 path 属性（Electron 专有 patch），
  //     DataTransfer/clipboardData 里的 File 只有 name/size/type —— 页面自身
  //     无从得知真实路径（WebView2Feedback #501/#3615，均未发布页面层 API）。
  //   * 宿主层：拿到「拖放」真实路径的唯一通道是在 WebView2 之前接管 OLE
  //     拖放（wry DragDropController 同款：SetAllowExternalDrop(false) + 自注册
  //     IDropTarget + CF_HDROP）。实测接管会让页面原生 HTML5 拖放整体失效
  //    （页面收不到 dragover/drop；wry 对非文件拖拽恒回 DROPEFFECT_NONE 且
  //     无事件，页内文字/图片拖拽无法恢复）—— 本壳 main.rs 特意
  //     disable_drag_drop_handler 保住页面拖放，故拖放路径本版不接管。
  //   * 选定方案（任务卡方案乙 · 剪贴板暂存）：资源管理器「复制」的文件以
  //     CF_HDROP 落在系统剪贴板，WebView2 页面 paste 事件的 clipboardData.files
  //     正是由它生成（File 的 name/size 与 L1 枚举一致）。L1 常驻剪贴板监听
  //    （main.rs 消息专用窗 + AddClipboardFormatListener + DragQueryFileW），
  //     内容变化即经 WS 广播 win.host-paths 通知帧（path/name/size/isDir 数组，
  //     绝不含伪造路径）；本桥暂存「最近一次 L1 暂存」，pathFor 按 name+size
  //     精确匹配返回真实绝对路径。
  //
  // 已知局限（SYNC-007/后续任务处置）：
  //   - 拖放（drop）：''（按上传处理，与现状一致；见上「接管代价」）；
  //   - 文件选取（picker）：WebView2 无自定义文件对话框路径 API，''；
  //   - 粘贴（paste）：已恢复 —— 复制文件粘贴 → @path；粘贴字节流 → ''；
  //   - 页面重载/重连期间 L1 会补推当前快照（main.rs 新 WS 连接推送），
  //     补推缺失时 pathFor 退化为 ''（走上传，不悬空）。
  //
  // 匹配语义：以「最近一次 win.host-paths 帧」为当前集（剪贴板内容变化即整体
  // 替换，含 L1 推空清场 —— 字节流截图上板后旧文件路径随之失效）；name 精确
  // 匹配 + size 精确匹配（目录 size 无意义，isDir 时仅按 name 匹配）；不消费
  // 表项（同一剪贴板内容可重复粘贴）；入参非 File 形态/无命中一律 ''。
  // ---------------------------------------------------------------------------
  interface HostPathEntry { path: string; name: string; size: number; isDir: boolean; }
  var hostPathEntries: HostPathEntry[] = [];
  onNotify(function (method: string, params: any): void {
    try {
      if (method !== 'win.host-paths') return;
      var files = params && params.files;
      if (!Array.isArray(files)) return;
      var next: HostPathEntry[] = [];
      for (var i = 0; i < files.length; i++) {
        var e = files[i] || {};
        // 只收 L1 真实枚举形态：path 非空字符串 + name 字符串；size 缺失按
        // -1 处理（永不可能与真实 File.size 匹配 → 恒 ''，不伪造）。
        if (typeof e.path === 'string' && e.path !== '' && typeof e.name === 'string' && e.name !== '') {
          next.push({
            path: e.path,
            name: e.name,
            size: typeof e.size === 'number' && Number.isFinite(e.size) ? e.size : -1,
            isDir: e.isDir === true,
          });
        }
      }
      hostPathEntries = next;
    } catch (e) { /* 通知帧畸形不炸桥 */ }
  });
  (window as any).__DSH_HOST_PATHS__ = {
    // 官方签名（preload-app.ts:83）：pathFor: (file: File) => string。
    // 实现按 name/size 鸭子匹配（vm 单测可喂纯对象；Chromium File 两者皆实）。
    pathFor: function (file: File): string {
      var f = file as unknown as { name?: unknown; size?: unknown } | null | undefined;
      if (!f || typeof f.name !== 'string' || typeof f.size !== 'number') return '';
      for (var i = 0; i < hostPathEntries.length; i++) {
        var entry = hostPathEntries[i];
        if (!entry) continue;
        if (entry.name !== f.name) continue;
        // 目录条目不做 size 对账（metadata.len() 对目录无意义）；文件条目
        // name+size 双匹配 —— size 相同的同名文件才可能命中，杜绝伪造。
        if (!entry.isDir && entry.size !== f.size) continue;
        return entry.path;
      }
      return '';
    },
  };

  // ---------------------------------------------------------------------------
  // __DSH_DIRECTORY_PICKER__（SYNC-004 · 官方 DirectoryPickerBridge，
  // preload-app.ts:75-77 逐字段对齐）
  //
  // 官方形态：pick() = ipcRenderer.invoke(DESKTOP_IPC.directoryPick) →
  // Promise<string | null>。主进程（directory-picker.ts:12,24）弹原生目录
  // 选择对话框 dialog.showOpenDialog(['openDirectory','createDirectory'])：
  // 用户选定 → 目录绝对路径字符串；取消 → null。消费者
  // dsh-client-ui-directory-picker-native/lib/client.js:63 —— 桥存在即走
  // desktop.pick()（原生分支），缺失才回退 Web 浏览式选目录
  //（ctx.uiWorkspace.pickDirectory()，<input webkitdirectory> 形态）。
  // 任务硬约束：本桥绝不用 Web <input type=file webkitdirectory> 冒充 ——
  // 原生对话框语义由 L1 的 tauri-plugin-dialog（IFileDialog 文件夹模式，
  // 自带「新建文件夹」）实现，见 main.rs pick_directory 注释。
  //
  // 通道映射：pick() 经 WS call('directory.pick', {})，L1 本地拦截（Rust L1
  // 与 locale.bootstrap 同一拦截点）。回包 result 直接是 string | null 标量
  //（官方 invoke 返回形态）；桥侧只做防御性归一 —— 字符串原样透传（绝对
  // 路径不做任何改写），null/非字符串一律归 null（= 官方「取消」语义，
  // 消费者据此走 onCancel）。不 try/catch 降级：调用失败（WS 断开等）按
  // 官方 invoke 失败语义向上 reject，消费者走 onError。
  //
  // 超时：call 缺省 30s 对「等用户在原生对话框里选目录」必然不够 —— 用户
  // 浏览目录超过 30s 会被误判超时（官方 invoke 无超时）。这里放宽到 30 分钟
  // 安全阀：正常交互（含离开座位）远不到该量级；超时后 promise reject，
  // L1 的在途回复因 id 已出表被客户端忽略，不留悬挂状态。
  // ---------------------------------------------------------------------------
  (window as any).__DSH_DIRECTORY_PICKER__ = {
    pick: function (): Promise<string | null> {
      return call('directory.pick', {}, 30 * 60 * 1000).then(function (r: any) {
        return typeof r === 'string' && r !== '' ? r : null;
      });
    },
  };

  // ---------------------------------------------------------------------------
  // SYNC-006：dshDesktop.browser（官方 DesktopBrowserBridge，types.d.ts:16-23
  // 逐字段对齐）+ <webview> 宿主元素适配
  //
  // 官方契约（权威类型 types.d.ts:4-23）：
  //   DesktopBrowserLeaseId = Branded<string>（运行时即主进程签发的字符串）
  //   DesktopBrowserReservation { readonly lease; readonly partition: string }
  //   acquire(workspace: string): Promise<DesktopBrowserReservation>
  //   release(lease): Promise<void>          // guest 销毁后 resolve
  //   onOpenRequested(lease, listener): () => void
  // lease/partition 的真实生命周期由 L1（main.rs「侧栏浏览器 guest 租约」节）
  // 持有：acquire 即建主窗内子 webview（per-workspace data_directory 隔离，
  // 固定 http(s) 隔离策略），release 即销毁 —— 绝不伪造租约。
  //
  // 消费者链（为什么必须有本面）：dsh-client-ui-sidebar-browser/lib/client.js:1597
  //   const desktop = carrier?.protocolVersion === 1 ? carrier.browser : void 0;
  //   keepMounted: desktop !== void 0      → 缺失即 false（切页卸载丢状态）
  //   desktop === void 0 → createIframePage（web 载体，iframe 沙箱）
  //   否则               → createElectronPage（Electron <webview> 载体）
  //
  // <webview> 适配（WebView2 无 webview 标签；customElements.define 拒绝无
  // 连字符标签名，无法注册自定义元素）：拦截 document.createElement('webview')
  //（仅该标签，其余原样透传），在 HTMLUnknownElement 上追加 Electron 同名 API
  //（ElectronWebViewImpl 的消费面）并做双向翻译：
  //   元素 → L1：browser.guest-attach（挂载，L1 回推 bootstrap dom-ready）/
  //            browser.guest-bounds（rAF 跟随 getBoundingClientRect）/
  //            browser.guest-cmd（goBack/goForward/reload/clearHistory）/
  //            browser.guest-load-url（loadURL，http(s) 白名单在 L1 复核）
  //   L1 → 元素：browser.guest-event（last-write-wins 缓存 url/title/loading/
  //            canGoBack/canGoForward + 派发 dom-ready/did-navigate/
  //            did-start-navigation/did-start-loading/did-stop-loading/
  //            page-title-updated/did-fail-load 同名事件）/
  //            browser.guest-destroyed（派发 destroyed）
  // 可见性判定（原生子 webview 恒浮于页面内容之上，必须自证顶层可见才 show，
  // 否则会盖住模态弹层）：bounds 有效 且 元素中心 elementFromPoint 命中元素
  // 自身子树 —— display:none（keepMounted 切页）/ 被浮层覆盖 / 移出视口都判
  // 不可见 → 推 w/h=0 让 L1 隐藏 guest（不销毁，状态保活）。回切即恢复。
  //
  // 已知局限（与 L1 侧一致，见 main.rs 同名节）：canGoBack/canGoForward 来自
  // L1 导航深度计数；SPA pushState 不上报 URL；加载失败无真实错误码；guest
  // 聚焦时物理键不冒泡到主窗（SYNC-001 keyboard 区已记录的缺口，本面不恶化）。
  // ---------------------------------------------------------------------------
  var browserOpenListeners: Record<string, ((url: string) => void)[]> = {};
  // 全部已适配的 <webview> 元素（按 lease 线性分派；侧栏浏览器 tab 数量级）。
  var webviewElements: any[] = [];
  var guestMountObserver: any = null;

  // 事件派生（vm 单测无 Event 构造器 → 退回普通对象；载荷键直接挂在事件上，
  // 与 Electron 事件形态一致：event.isMainFrame / event.errorCode / ...）。
  function dispatchGuestEvent(element: any, type: string, payload?: Record<string, unknown>): void {
    var event: any;
    try {
      event = typeof Event === 'function' ? new Event(type) : { type: type };
    } catch (e) { event = { type: type }; }
    if (payload) {
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) {
          try { event[key] = payload[key]; } catch (e) { /* 只读键忽略 */ }
        }
      }
    }
    try { element.dispatchEvent(event); } catch (e) { /* 元素异常不断桥 */ }
  }

  function guestsForLease(lease: unknown): any[] {
    var out: any[] = [];
    for (var i = 0; i < webviewElements.length; i++) {
      var el = webviewElements[i];
      try {
        if (el && el.__dshGuestApi && el.getAttribute && el.getAttribute('name') === lease) out.push(el);
      } catch (e) { /* 元素已死，跳过 */ }
    }
    return out;
  }

  // browser.guest-event 帧 → 缓存 + 同名 DOM 事件（官方 Electron 事件形态）。
  function handleGuestEvent(params: any): void {
    if (!params || typeof params.lease !== 'string' || typeof params.event !== 'string') return;
    var lease = params.lease;
    var targets = guestsForLease(lease);
    if (targets.length === 0) return;
    var payload: Record<string, unknown> = {};
    if (typeof params.url === 'string') payload.url = params.url;
    if (typeof params.title === 'string') payload.title = params.title;
    var names: Record<string, Record<string, unknown>> = {
      'did-start-navigation': { isMainFrame: true },
      'did-navigate-in-page': { isMainFrame: true },
      'page-title-updated': {},
      'did-fail-load': {},
    };
    if (names[params.event]) {
      var preset = names[params.event];
      for (var k in preset) payload[k] = preset[k];
    }
    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      // last-write-wins 缓存：帧内全量可观测态，getURL()/isLoading()/canGo*()
      // 的同步读数来源（Electron 是同步 IPC 读数；本壳为最近一帧快照）。
      try {
        var state = el.__dshGuestState;
        if (state) {
          if (typeof params.url === 'string') state.url = params.url;
          if (typeof params.title === 'string') state.title = params.title;
          if (typeof params.loading === 'boolean') state.loading = params.loading;
          if (typeof params.canGoBack === 'boolean') state.canGoBack = params.canGoBack;
          if (typeof params.canGoForward === 'boolean') state.canGoForward = params.canGoForward;
        }
      } catch (e) { /* 缓存失败不阻断事件 */ }
      var extra: Record<string, unknown> | undefined;
      if (params.event === 'did-fail-load') {
        extra = {
          errorCode: typeof params.errorCode === 'number' ? params.errorCode : -1,
          errorDescription: typeof params.errorDescription === 'string' ? params.errorDescription : '',
          isMainFrame: true,
        };
      }
      // 载荷传入派发（对齐本节头注「载荷键直接挂在事件上」的 Electron 事件形态）：
      // url/title 随帧挂上同名事件（did-navigate 的 event.url 此前恒 undefined，
      // 仅 did-fail-load 有载荷键），isMainFrame preset 覆盖 did-start-navigation /
      // did-navigate-in-page（消费者 client.js:1180-1210 读这两个键）；did-fail-load
      // 的 errorCode/errorDescription 保持 extra 优先（同键覆盖）。
      dispatchGuestEvent(el, params.event, extra ? Object.assign({}, payload, extra) : payload);
    }
  }

  // browser.guest-destroyed 帧 → 派发 destroyed（消费者 dropGuest → release
  // 幂等）+ 停 bounds 跟踪。
  function handleGuestDestroyed(params: any): void {
    if (!params || typeof params.lease !== 'string') return;
    var targets = guestsForLease(params.lease);
    for (var i = 0; i < targets.length; i++) {
      markGuestUnmounted(targets[i]);
      dispatchGuestEvent(targets[i], 'destroyed');
    }
  }

  onNotify(function (method: string, params: any): void {
    try {
      if (method === 'browser.guest-event') handleGuestEvent(params);
      else if (method === 'browser.open-requested') {
        var lease = params && typeof params.lease === 'string' ? params.lease : '';
        var url = params && typeof params.url === 'string' ? params.url : '';
        if (!lease || !url) return;
        var list = browserOpenListeners[lease];
        if (!list || list.length === 0) return; // 无监听者：丢弃（官方无消费者不投递）
        var snapshot = list.slice();
        for (var i = 0; i < snapshot.length; i++) {
          var listener = snapshot[i];
          if (typeof listener !== 'function') continue;
          try { listener(url); } catch (e) { /* listener 异常不断桥 */ }
        }
      } else if (method === 'browser.guest-destroyed') handleGuestDestroyed(params);
    } catch (e) { /* 通知帧畸形不炸桥 */ }
  });

  // —— bounds 跟踪：元素挂载期间每帧比对（量化 0.5px），变化才发帧 ——
  var nextFrame = function (cb: () => void): void {
    try {
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(function () { cb(); });
        return;
      }
    } catch (e) { /* vm 无 rAF */ }
    try { window.setTimeout(cb, 16); } catch (e2) { /* vm 无 setTimeout：放弃 */ }
  };

  // 世代号失效模型：stop 时推进 epoch，已排队的 tick 自行退出（免于依赖
  // cancelAnimationFrame 在各环境的可用性差异）。
  function stopGuestBoundsTracking(element: any): void {
    element.__dshBoundsTracking = false;
    element.__dshBoundsEpoch = (element.__dshBoundsEpoch || 0) + 1;
  }

  function pushGuestBounds(lease: string, x: number, y: number, w: number, h: number): void {
    send('browser.guest-bounds', { lease: lease, x: x, y: y, w: w, h: h });
  }

  function trackGuestBounds(element: any): void {
    if (element.__dshBoundsTracking) return;
    element.__dshBoundsTracking = true;
    element.__dshBoundsEpoch = (element.__dshBoundsEpoch || 0) + 1;
    var epoch = element.__dshBoundsEpoch;
    var last = '';
    var tick = function (): void {
      if (!element.__dshBoundsTracking || epoch !== element.__dshBoundsEpoch) return;
      var lease = '';
      try { lease = element.getAttribute('name') || ''; } catch (e) { /* 元素已死 */ }
      if (!lease || !element.isConnected) {
        element.__dshBoundsTracking = false;
        return;
      }
      var rect = element.getBoundingClientRect();
      var visible = rect.width >= 1 && rect.height >= 1;
      // 顶层可见自证（见节注释）：中心点命中必须落在元素子树内。
      if (visible && typeof document.elementFromPoint === 'function') {
        try {
          var hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!(hit === element || (hit && typeof element.contains === 'function' && element.contains(hit)))) visible = false;
        } catch (e) { /* 判定失败按可见处理（有 bounds 即先显示） */ }
      }
      var frame = visible
        ? (Math.round(rect.left * 2) / 2) + ',' + (Math.round(rect.top * 2) / 2) + ',' + (Math.round(rect.width * 2) / 2) + ',' + (Math.round(rect.height * 2) / 2)
        : 'hidden';
      if (frame !== last) {
        last = frame;
        if (visible) pushGuestBounds(lease, rect.left, rect.top, rect.width, rect.height);
        else pushGuestBounds(lease, 0, 0, 0, 0);
      }
      nextFrame(tick);
    };
    nextFrame(tick);
  }

  // —— 挂载/卸载观测：present() 追加 / clear()·remove() 移除 ——
  function markGuestMounted(element: any): void {
    if (element.__dshMounted) return;
    element.__dshMounted = true;
    var lease = '';
    try { lease = element.getAttribute('name') || ''; } catch (e) { /* 同上 */ }
    if (!lease) return;
    // L1 回推 bootstrap dom-ready（Electron 首个 dom-ready 的等价物；时序上
    // 必然晚于消费者 addEventListener —— present() 在监听器装完后才调用）。
    send('browser.guest-attach', { lease: lease });
    trackGuestBounds(element);
  }

  function markGuestUnmounted(element: any): void {
    if (!element.__dshMounted) return;
    element.__dshMounted = false;
    stopGuestBoundsTracking(element);
    var lease = '';
    try { lease = element.getAttribute('name') || ''; } catch (e) { /* 同上 */ }
    if (lease) pushGuestBounds(lease, 0, 0, 0, 0);
  }

  function scanGuestMutations(added: NodeList | any[], removed: NodeList | any[]): void {
    var check = function (node: any): void {
      if (!node || node.nodeType !== 1) return;
      if (node.__dshGuestApi) {
        try { if (node.isConnected) markGuestMounted(node); else markGuestUnmounted(node); } catch (e) { /* 同上 */ }
      }
      if (node.querySelectorAll) {
        var inner = node.querySelectorAll('webview');
        for (var j = 0; j < inner.length; j++) {
          var el = inner[j];
          if (el && el.__dshGuestApi) {
            try { if (el.isConnected) markGuestMounted(el); else markGuestUnmounted(el); } catch (e2) { /* 同上 */ }
          }
        }
      }
    };
    for (var i = 0; i < added.length; i++) check((added as any)[i]);
    for (var k = 0; k < removed.length; k++) check((removed as any)[k]);
  }

  function ensureGuestMountObserver(): void {
    if (guestMountObserver !== null || typeof MutationObserver === 'undefined') return;
    var target: any = null;
    try { target = document.body || document.documentElement; } catch (e) { /* vm 无 document */ }
    if (!target) {
      // document-start 早期：文档根未解析完，推迟一拍重试。
      try {
        document.addEventListener('DOMContentLoaded', function () { guestMountObserver = null; ensureGuestMountObserver(); }, { once: true });
      } catch (e2) { /* vm 无 addEventListener */ }
      return;
    }
    try {
      guestMountObserver = new MutationObserver(function (mutations: any[]): void {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          scanGuestMutations(m.addedNodes || [], m.removedNodes || []);
        }
      });
      guestMountObserver.observe(target, { childList: true, subtree: true });
    } catch (e) { guestMountObserver = null; }
  }

  // —— <webview> 元素适配（Electron 同名 API；ElectronWebViewImpl 消费面）——
  function attachWebviewApi(element: any): void {
    if (!element || element.__dshGuestApi) return;
    element.__dshGuestApi = true;
    // 同步读数缓存（L1 guest-event 帧 last-write-wins）。
    element.__dshGuestState = { url: 'about:blank', title: '', loading: false, canGoBack: false, canGoForward: false };
    webviewElements.push(element);
    var leaseOf = function (): string {
      try { return (element.getAttribute && element.getAttribute('name')) || ''; } catch (e) { return ''; }
    };
    var guard = function (): string {
      var lease = leaseOf();
      // 官方 createElement(reservation) 必设 name=lease；缺失说明消费者未走
      // 预定流程 —— 拒绝而不是猜（绝不伪造租约操作）。
      if (!lease) throw new Error('webview: missing guest lease (name attribute)');
      return lease;
    };
    // Electron <webview>.loadURL(url): Promise<void>；路由 L1 后由事件链回报
    // 状态。地址合法性（http(s)/非应用源）由 L1 复核，拒绝即 reject →
    // 消费者 commandFailed → 页内错误卡片。
    element.loadURL = function (url: unknown): Promise<void> {
      var lease = guard();
      return call('browser.guest-load-url', { lease: lease, url: String(url) })
        .then(function () { /* Promise<void>：不外泄回包 */ });
    };
    // 以下为 fire-and-forget（Electron 同步形态；越界命令 L1 忽略）。
    element.goBack = function (): void {
      send('browser.guest-cmd', { lease: guard(), cmd: 'goBack' });
    };
    element.goForward = function (): void {
      send('browser.guest-cmd', { lease: guard(), cmd: 'goForward' });
    };
    element.reload = function (): void {
      send('browser.guest-cmd', { lease: guard(), cmd: 'reload' });
    };
    element.clearHistory = function (): void {
      send('browser.guest-cmd', { lease: guard(), cmd: 'clearHistory' });
    };
    element.getURL = function (): string { return element.__dshGuestState.url; };
    element.getTitle = function (): string { return element.__dshGuestState.title; };
    element.isLoading = function (): boolean { return element.__dshGuestState.loading; };
    element.canGoBack = function (): boolean { return element.__dshGuestState.canGoBack; };
    element.canGoForward = function (): boolean { return element.__dshGuestState.canGoForward; };
    // 元素可能在观察器就绪前已挂载（present 与 createElement 同批任务）：
    // 立即补一次连接态检查。
    ensureGuestMountObserver();
    try { if (element.isConnected) markGuestMounted(element); } catch (e) { /* vm 无 isConnected */ }
  }

  (function installWebviewShim(): void {
    var doc: any = typeof document === 'undefined' ? null : document;
    if (!doc || typeof doc.createElement !== 'function') return;
    var nativeCreateElement = doc.createElement;
    // 只拦截 'webview'（消费者 ElectronWebViewImpl.createElement 的标签）。
    // 元素本体保持 HTMLUnknownElement 原始形态（视觉/DOM 行为与未适配一致），
    // 适配仅追加 API —— 拦截失败也退回原始元素，不留半适配态。
    doc.createElement = function (tag: unknown, options?: unknown): any {
      var element = nativeCreateElement.call(this, tag, options);
      try {
        if (typeof tag === 'string' && tag.toLowerCase() === 'webview') attachWebviewApi(element);
      } catch (e) { /* 适配失败退回原始元素 */ }
      return element;
    };
  })();

  // 页面异常 → 壳层日志。
  window.addEventListener('error', function (e) {
    try { send('log.page-error', { message: 'window.onerror: ' + ((e && (e.message || e.error)) || 'unknown') }); } catch (err) { /* 忽略 */ }
  });
  window.addEventListener('unhandledrejection', function (e) {
    try { send('log.page-error', { message: 'unhandledrejection: ' + String((e && (e as any).reason && ((e as any).reason.message || (e as any).reason)) || e) }); } catch (err) { /* 忽略 */ }
  });

  // ---------------------------------------------------------------------------
  // Chrome DOM（36px 玻璃栏；拖拽 = mousedown → win.start-dragging）
  // ---------------------------------------------------------------------------
  var GLYPHS = {
    min: '<svg data-control-name="system.default.window-minimize-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 6h7"/></svg>',
    max: '<svg data-control-name="system.default.window-maximize-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4"/></svg>',
    restore: '<svg data-control-name="system.default.window-restore-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M4.2 4.2V2.6h5.2v5.2H7.8"/><rect x="2.6" y="4.2" width="5.2" height="5.2" rx="1.2"/></svg>',
    close: '<svg data-control-name="system.default.window-close-icon" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8"/></svg>',
  };

  var maxBtn: HTMLElement | null = null;
  // 壳栏展示状态（来源：boot.state —— 唯一的壳信息接口）。
  var state: any = { appVersion: '', agentVersion: '', agentSource: '' };

  // WebView2 无 -webkit-app-region:drag —— mousedown 转发壳层 start_dragging。
  // 双击标题 = 最大化/还原（与系统标题栏默认行为对齐）。
  function armDrag(el: Element): void {
    var lastClick = 0;
    el.addEventListener('mousedown', function (e) {
      if ((e as MouseEvent).button !== 0) return;
      var target = e.target as HTMLElement | null;
      // 按钮上的按下不触发拖拽（关闭/最大化等仍可点击）。
      if (target && target.closest && target.closest('button')) return;
      var now = Date.now();
      if (now - lastClick < 400) {
        lastClick = 0;
        dshDesktop.windowControls.toggleMaximize().catch(function () { /* 壳层不可用时静默 */ });
        return;
      }
      lastClick = now;
      send('win.start-dragging', {});
    });
  }

  function setMaximized(isMax: boolean): void {
    if (!maxBtn) return;
    maxBtn.innerHTML = isMax ? GLYPHS.restore : GLYPHS.max;
    maxBtn.title = isMax ? '还原' : '最大化';
    maxBtn.setAttribute('aria-label', maxBtn.title);
    maxBtn.setAttribute('aria-pressed', String(isMax));
  }

  function injectUiSkin(): void {
    var manager = (window as any).__DSH_UI_SKIN_MANAGER__;
    if (manager && manager.enabled === true && manager.slots) {
      var generation = String(manager.generation);
      Object.keys(manager.slots).forEach(function (slot) {
        var id = 'dsh-ui-skin-' + slot + '-' + generation;
        if (document.getElementById(id)) return;
        var tag = document.createElement('style');
        tag.id = id;
        tag.setAttribute('data-skin-slot', slot);
        tag.setAttribute('data-skin-generation', generation);
        tag.textContent = String(manager.slots[slot] || '');
        document.head.appendChild(tag);
      });
      return;
    }
    if (document.getElementById('dsh-ui-skin')) return;
    var tag = document.createElement('style');
    tag.id = 'dsh-ui-skin';
    tag.textContent = String((window as any).__DSH_UI_SKIN_CSS__ || '');
    document.head.appendChild(tag);
  }

  // Generation-aware host bridge. Candidate styles are staged before the
  // previous generation is removed; the manager receives an explicit ack.
  (function installUiSkinTransactionBridge(): void {
    var activeGeneration = 0;
    var activeSlots: Record<string, string> = {};
    var manager = (window as any).__DSH_UI_SKIN_MANAGER__;
    if (manager && Number.isFinite(Number(manager.generation))) activeGeneration = Number(manager.generation);
    function acknowledge(generation: number, ok: boolean, error?: string): void {
      window.dispatchEvent(new CustomEvent('dsh-ui-skin-transaction-ack', {
        detail: {generation: generation, context: 'webview', ok: ok, error: error || undefined}
      }));
    }
    window.addEventListener('dsh-ui-skin-transaction', function (event: Event): void {
      var detail = (event as CustomEvent).detail || {};
      var generation = Number(detail.generation);
      var slots = detail.slots as Record<string, unknown> | undefined;
      if (!Number.isSafeInteger(generation) || generation <= activeGeneration || !slots) {
        acknowledge(generation, false, 'STALE_OR_INVALID_GENERATION');
        return;
      }
      var transactionSlots = slots;
      var staged: HTMLStyleElement[] = [];
      try {
        Object.keys(transactionSlots).forEach(function (slot): void {
          var style = document.createElement('style');
          style.id = 'dsh-ui-skin-' + slot + '-' + generation;
          style.setAttribute('data-skin-slot', slot);
          style.setAttribute('data-skin-generation', String(generation));
          style.textContent = String(transactionSlots[slot] || '');
          document.head.appendChild(style);
          staged.push(style);
        });
        Object.keys(activeSlots).forEach(function (slot): void {
          var old = document.querySelectorAll('[data-skin-slot="' + slot + '"][data-skin-generation="' + activeGeneration + '"]');
          old.forEach(function (node): void { node.remove(); });
        });
        activeSlots = Object.fromEntries(Object.keys(transactionSlots).map(function (slot): [string, string] { return [slot, String(transactionSlots[slot] || '')]; }));
        activeGeneration = generation;
        acknowledge(generation, true);
      } catch (error) {
        staged.forEach(function (style): void { style.remove(); });
        acknowledge(generation, false, error instanceof Error ? error.message : String(error));
      }
    });
  })();

  function syncHostThemeBoundary(): void {
    // 皮肤的通用锚点规则使用壳层深色文字。只在 DSH 内容边界恢复内核
    // label token，让未指定颜色的插件继承当前主题；子节点自有颜色不受影响。
    if (document.documentElement.classList.contains('eac-shell') || !document.getElementById('root')) return;
    if (!document.getElementById('__dsh_host_theme__')) {
      var style = document.createElement('style');
      style.id = '__dsh_host_theme__';
      style.textContent = 'html:not(.eac-shell) [data-dsh-host-theme][data-region][data-control-name]{color:var(--dsw-alias-label-primary, inherit)}';
      document.head.appendChild(style);
    }
  }

  function nameUiSkinAnchors(): void {
    var hostPage = !document.documentElement.classList.contains('eac-shell') && !!document.getElementById('root');
    function name(selector: string, region: string, control: string): void {
      document.querySelectorAll(selector).forEach(function (node) {
        if (node.closest('#dsh-exit-overlay')) return;
        node.setAttribute('data-region', region);
        node.setAttribute('data-control-name', control);
        if (hostPage) node.setAttribute('data-dsh-host-theme', '');
      });
    }

    name('#root, [data-slot="root"]', 'session', 'session-root');
    name('[data-conversation-scroll]', 'session', 'session-content');
    name('[data-slot="top-sidebar"]', 'top-sidebar', 'sidebar-root');
    name('[data-slot="bottom-sidebar"]', 'bottom-sidebar', 'sidebar-root');
    name('[data-slot="left-sidebar"]', 'left-sidebar', 'sidebar-root');
    name('[data-slot="right-sidebar"]', 'right-sidebar', 'sidebar-root');
    name('[role="dialog"]:not(#dsh-exit-overlay)', 'overlay', 'dialog-surface');
    name('[data-floating-ui-portal], [data-radix-popper-content-wrapper], ._7KE1Ra_menu, .ra1x4W_menu', 'overlay', 'popup-surface');

    syncHostThemeBoundary();

    document.querySelectorAll('[role="dialog"]').forEach(function (dialog) {
      dialog.querySelectorAll('[class*="navList"], [class*="options"]').forEach(function (node) {
        node.setAttribute('data-control-name', 'system.default.dialog-scroll-area');
      });
      dialog.querySelectorAll('[class*="panel"], [class*="overlay"]').forEach(function (node) {
        node.setAttribute('data-control-name', 'system.default.dialog-panel');
      });
    });
    document.querySelectorAll('._7KE1Ra_menu, .ra1x4W_menu').forEach(function (menu) {
      var composer = menu.closest('[class*="composerStack"]');
      if (composer) {
        composer.setAttribute('data-region', 'session');
        composer.setAttribute('data-control-name', 'composer');
      }
    });
  }

  // 模型选择弹层救援：菜单绝对定位向上展开（最高 360px + 8px 间距），在 hero
  // 页或矮窗口里顶部会越出滚动容器/视口被切。探到菜单顶部进入玻璃栏区（<40px）
  // 就翻转向下展开，并按触发钮下方可用空间收缩高度；菜单关闭或空间充足时还原。
  // 翻转向下后菜单会伸出 composerStack（overflow:auto）的盒子 —— 配套 CSS 用
  // :has(...) 在菜单打开时放开该容器裁剪（见 Control Package layout.css）。
  // 0.1.2 菜单哈希类 ._7KE1Ra_menu→.ra1x4W_menu（已实核安装闭包），双锚并留。
  function initPopupRescue(): void {
    var MENU_SEL = '._7KE1Ra_menu, .ra1x4W_menu';
    var FLIP_CLS = 'dsh-popup-flip';
    var BAR_EDGE = 40;
    var probeTimer: number | null = null;
    // 翻转态按菜单元素保存（WeakSet，菜单卸载即回收）：翻转与否只在菜单开起来
    // 时判定一次。绝不能根据翻转后的 r.top 还原 —— 翻转让它 ≥40，还原又让它
    // <40，会形成每 200ms 翻转↔复原的震荡（弹层自带抽搐，且导致位置随机）。
    var flippedMenus = new WeakSet<HTMLElement>();

    function probeMenus(): void {
      probeTimer = null;
      nameUiSkinAnchors();
      var menus = document.querySelectorAll(MENU_SEL);
      var anyOpen = false;
      for (var i = 0; i < menus.length; i++) {
        var menu = menus[i] as HTMLElement;
        var r = menu.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue; // 未渲染/已关闭
        anyOpen = true;
        if (!flippedMenus.has(menu) && r.top < BAR_EDGE) flippedMenus.add(menu);
        if (flippedMenus.has(menu)) {
          var trigger = menu.parentElement as HTMLElement | null;
          var below = trigger ? window.innerHeight - trigger.getBoundingClientRect().bottom - 16 : 240;
          menu.classList.add(FLIP_CLS);
          // 下限 80（而非 120）：矮窗口下触发钮本身贴近视口底，过高的下限会让
          // 菜单底部挤出视口（实测 470px 高时 120 的底超出 12px）。
          menu.style.maxHeight = String(Math.max(80, Math.min(360, below))) + 'px';
        } else {
          menu.classList.remove(FLIP_CLS);
          menu.style.maxHeight = '';
        }
      }
      // 菜单存续期间低频轮询（内容加载会改变高度/位置）。
      if (anyOpen) probeTimer = window.setTimeout(probeMenus, 200);
    }

    function scheduleProbe(): void {
      // 每个变更批次都同步 querySelectorAll 全树扫描：对话流式输出期间 DOM
      // 变更风暴会把这条热路径烧起来。菜单开/关/挪位晚一帧探测无可感知
      // 差异 —— rAF 把同帧的整批变更合并成一次探测（与页面渲染同帧节流）。
      if (probeTimer === null) probeTimer = window.requestAnimationFrame(probeMenus);
    }

    function start(): void {
      if (!document.body) return;
      new MutationObserver(scheduleProbe).observe(document.body, { childList: true, subtree: true });
      window.addEventListener('resize', scheduleProbe, { passive: true });
      scheduleProbe();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  function injectChrome(): void {
    if (document.getElementById(BAR_ID)) return;
    injectUiSkin();
    nameUiSkinAnchors();

    // 声明壳层皮肤使用的高度；Windows 内核标记由 document-start 脚本提供。
    document.documentElement.setAttribute('data-dsh-title-bar-height', String(BAR_HEIGHT));

    var bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.setAttribute('data-region', 'top-sidebar');
    bar.setAttribute('data-control-name', 'sidebar-root');
    bar.setAttribute('data-state', 'docked');
    bar.innerHTML = '\
    <div class="dch-left" data-control-name="sidebar-content">\
      <img class="dch-icon" data-control-name="window-icon" alt="" draggable="false" />\
      <span class="dch-title" data-control-name="window-title">Deepseek Harness EAC</span>\
      <span class="dch-badge" data-control-name="window-badge" hidden></span>\
    </div>\
    <div class="dch-right" data-control-name="window-actions">\
      <button class="dch-btn" data-act="min" data-control-name="window-minimize" data-state="idle" title="最小化" aria-label="最小化">' + GLYPHS.min + '</button>\
      <button class="dch-btn" data-act="max" data-control-name="window-maximize" data-state="idle" title="最大化" aria-label="最大化" aria-pressed="false">' + GLYPHS.max + '</button>\
      <button class="dch-btn dch-close" data-act="close" data-control-name="window-close" data-state="dangerous" title="关闭" aria-label="关闭">' + GLYPHS.close + '</button>\
    </div>';
    document.body.appendChild(bar);

    var badge = bar.querySelector('.dch-badge') as HTMLElement | null;
    var icon = bar.querySelector('.dch-icon') as HTMLImageElement | null;
    maxBtn = bar.querySelector('[data-act="max"]') as HTMLElement | null;

    // 只 arm bar 一层：.dch-left 是 bar 子元素，mousedown 会冒泡到 bar；
    // 两层各自持有 lastClick 闭包会让左半栏双击 toggle 两次（净零）= 双击
    // 最大化失效 + 每次按下多发一次拖拽事件。
    armDrag(bar);
    var minBtn = bar.querySelector('[data-act="min"]');
    if (minBtn) minBtn.addEventListener('click', function () { dshDesktop.windowControls.minimize(); });
    if (maxBtn) maxBtn.addEventListener('click', function () { dshDesktop.windowControls.toggleMaximize(); });
    var closeBtn = bar.querySelector('.dch-close');
    if (closeBtn) closeBtn.addEventListener('click', function () { dshDesktop.windowControls.close(); });

    // 标题栏信息（版本徽标 + 图标）：来源 boot.state —— 唯一的壳信息接口。
    // 首启重载（profile 初始化）下可能超时，失败后 logo 会停在白方块，
    // 故指数退避重试至拿到 iconDataUri。
    (function initInfo(attempt: number): void {
      dshDesktop.boot.state().then(function (info: any) {
        if (!info) return;
        state = Object.assign({}, state, info);
        if (info.appVersion) {
          if (badge) badge.textContent = 'v' + info.appVersion;
        }
        if (badge && info.agentVersion) {
          badge.title = 'agent v' + info.agentVersion + '（' + (info.agentSource || 'bundled') + '）';
          badge.hidden = false;
        }
        if (icon && info.iconDataUri) {
          icon.src = info.iconDataUri;
        } else if (attempt < 5) {
          window.setTimeout(function () { initInfo(attempt + 1); }, 1000 * attempt);
        }
      }).catch(function () {
        if (attempt < 5) window.setTimeout(function () { initInfo(attempt + 1); }, 1000 * attempt);
      });
    })(0);
    dshDesktop.windowControls.isMaximized().then(setMaximized).catch(function () { /* 壳层不可用时静默 */ });
    dshDesktop.windowControls.onMaximizeChange(setMaximized);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectChrome);
  } else {
    injectChrome();
  }

  // ---------------------------------------------------------------------------
  // 每 5s 上报页面视口（visibilitychange 回前台时立即补报）。
  // win.viewport-beat 由壳层本地拦截：WebView2 在窗口
  // 尺寸/DPI 变化事件被吞（副屏拔插、DPI 切换、启动期阻塞）时视口停留在
  // 旧尺寸 —— 窗口其余区域永不重绘（黑屏条带）、页面按旧窄视口布局，
  // 用户看到"侧边栏只剩一个图标+黑屏"的冻结画面。壳层比对该报文与窗口
  // 实际尺寸，超差即重申 webview bounds 自愈。
  // ---------------------------------------------------------------------------
  (function () {
    var beat = function () {
      try {
        send('win.viewport-beat', {
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
          src: 'main',
        });
      } catch (e) { /* 视口上报失败不致命 */ }
    };
    beat();
    setInterval(beat, 5000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') beat();
    });
  })();

  initPopupRescue();
})();
