'use strict';
// 依赖层小补丁（幂等）：目录选择器 worker 无消息退出时，把真实退出码/信号带进
// 错误文案。由 postinstall / pack / dist 在打包前应用；匹配失败只告警不中断。
import fs = require('node:fs');
import path = require('node:path');
// 内核补丁文件一旦截断 = 用户机启动期 MODULE_NOT_FOUND/语法损坏且无自愈：
// 全部落盘走原子写（tmp + 两步换入，见 lib/atomic-json）。
import { writeFileAtomic } from '../lib/atomic-json';

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-host-directory-picker-native', 'lib', 'index.js');

const PATCH_MARKER = 'worker.on("exit", (code, signal) => {';
const OLD_RE = /worker\.on\("exit", \(\) => \{\s*settle\(\(\) => \{\s*reject\(\/\* @__PURE__ \*\/ new Error\("win32 folder dialog worker exited before reporting a result"\)\);\s*\}\);\s*\}\);/;
const NEW_BLOCK = [
  'worker.on("exit", (code, signal) => {',
  '\t\tsettle(() => {',
  '\t\t\tconst suffix = signal ? ` (signal ${signal})` : typeof code === "number" ? ` (exit code ${code})` : "";',
  '\t\t\treject(/* @__PURE__ */ new Error(`win32 folder dialog worker exited before reporting a result${suffix}`));',
  '\t\t});',
  '\t});',
].join('\n');

function patchPickerWorker(): void {
  if (!fs.existsSync(target)) {
    console.log('[patch-deps] dsh-host-directory-picker-native 不存在，跳过');
    return;
  }
  let src = fs.readFileSync(target, 'utf8');
  if (src.includes(PATCH_MARKER)) {
    console.log('[patch-deps] picker worker 退出码补丁已应用，跳过');
    return;
  }
  if (!OLD_RE.test(src)) {
    console.log('[patch-deps] picker-native 未匹配到目标代码（版本可能已更新），跳过');
    return;
  }
  src = src.replace(OLD_RE, NEW_BLOCK);
  writeFileAtomic(target, src);
  console.log('[patch-deps] 已补丁 picker-native：worker 退出上报 exit code / signal');
}

// 设置弹窗左栏导航滚动补丁：上游 dsh-client-ui-settings-general 的 .nav/.navList
// 没有滚动约束，面板 overflow:hidden 会把排到底部的插件设置条目（如 ClawBot，
// order 50）直接裁掉且无法滚动到。给 navList 加 min-height:0 + overflow-y:auto，
// 并给 nav 补底部内边距，条目多时左栏变为可滚动列表。CSS 类名前缀是内容哈希，
// 用捕获组匹配以兼容上游小版本差异；幂等标记为 CSS 注释 dsh-desktop-nav-scroll。
const NAV_SCROLL_MARKER = 'dsh-desktop-nav-scroll';
const NAV_RE = /\.([A-Za-z0-9_-]+)_nav\{box-sizing:border-box;flex-direction:column;flex:none;gap:18px;width:188px;padding:22px 12px 0;display:flex\}/;
const NAVLIST_RE = /\.([A-Za-z0-9_-]+)_navList\{flex-direction:column;gap:4px;display:flex\}/;

function patchSettingsNavScroll(): void {
  const file = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js');
  if (!fs.existsSync(file)) {
    console.log('[patch-deps] dsh-client-ui-settings-general 不存在，跳过');
    return;
  }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(NAV_SCROLL_MARKER)) {
    console.log('[patch-deps] 设置左栏滚动补丁已应用，跳过');
    return;
  }
  const navMatch = NAV_RE.exec(src);
  const navListMatch = NAVLIST_RE.exec(src);
  if (!navMatch || !navListMatch || navMatch[1] !== navListMatch[1]) {
    console.log('[patch-deps] 设置左栏未匹配到目标 CSS（上游版本可能已修复/更新），跳过');
    return;
  }
  const oldNav = navMatch[0];
  const oldNavList = navListMatch[0];
  const newNav = oldNav.replace('padding:22px 12px 0;', 'padding:22px 12px 12px;');
  const newNavList = oldNavList.replace(
    /\{flex-direction:column;gap:4px;display:flex\}$/,
    '{flex-direction:column;gap:4px;display:flex;min-height:0;overflow-y:auto;padding-bottom:10px;/*' + NAV_SCROLL_MARKER + '*/}'
  );
  src = src.replace(oldNav, newNav).replace(oldNavList, newNavList);
  writeFileAtomic(file, src);
  console.log('[patch-deps] 已补丁 settings-general：设置弹窗左栏可滚动，底部条目不再被裁掉');
}

// 设置弹窗宽度自适应 + 可拖拽拉伸补丁：上游 panel 固定 width:800px，大屏
// 主窗里右侧内容拥挤且用户无法调整。两件事：
//   1) width 改 min(75vw,1280px) —— 100vw 即主窗视口宽，弹窗跟随主窗宽度
//      伸缩（cap 1280 防大屏占比过大）；max-width calc(100vw - 48px) 保留
//      （窄窗收敛语义不变）。
//   2) overflow:hidden 放开为 auto + resize:horizontal —— 允许拖右下角
//      手柄手动调宽；panel 是 flex 容器（左栏 flex:none 固定 188px、内容
//      区 flex:1 min-width:0 自适应），panel 变宽后内容自然跟随；子树已有
//      自身滚动约束，panel 的 overflow:auto 不会产生意外滚动条；min-width
//      防拖到不可用。幂等标记 dsh-desktop-panel-resize。
const PANEL_RESIZE_MARKER = 'dsh-desktop-panel-resize';
// 0.1.7 世代：z-index → background → width → max-width → height → … → overflow。
const PANEL_RE =
  /\.([A-Za-z0-9_-]+)_panel\{(z-index:1;background:var\(--dsw-alias-bg-layer-2\);)width:800px;(max-width:[^;]+;height:[^;]+;[^{}]*?display:flex;position:relative;)overflow:hidden\}/;
// 0.2.0 世代（KERN-004）：官方重构了属性序与高度公式（width:800px → height:
// min(800px, calc(100vh - 2*max(24px, var(--dsh-frame-overlay-top,24px)))) →
// border-radius → background → max-width → box-shadow → scrollbar vars →
// display:flex;position:relative;overflow:hidden）。功能未官方化（panel 仍固定
// 800px 宽 + overflow:hidden），只做锚点适配：宽匹配块 + 守卫（display:flex;
// position:relative 与 max-width: 必须在块内，确保命中的是设置弹窗 panel 本体）。
const PANEL_RE_V2 =
  /\.([A-Za-z0-9_-]+)_panel\{([^{}]*?)width:800px;([^{}]*?)overflow:hidden\}/;

function patchSettingsPanelResize(): void {
  const file = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js');
  if (!fs.existsSync(file)) {
    console.log('[patch-deps] dsh-client-ui-settings-general 不存在，跳过');
    return;
  }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(PANEL_RESIZE_MARKER)) {
    console.log('[patch-deps] 设置弹窗宽度补丁已应用，跳过');
    return;
  }
  const m = PANEL_RE.exec(src);
  if (!m) {
    // KERN-004：0.2.0 世代锚点（属性序重构，功能未官方化 —— panel 仍固定
    // width:800px + overflow:hidden，见 PANEL_RE_V2 注释）。
    const v2 = PANEL_RE_V2.exec(src);
    const v2Pre = v2?.[2];
    const v2Post = v2?.[3];
    if (!v2 || !v2Pre || !v2Post
      || !(v2Pre + v2Post).includes('display:flex;position:relative;')
      || !(v2Pre + v2Post).includes('max-width:')) {
      console.log('[patch-deps] 设置弹窗未匹配到 panel CSS（上游版本可能已修复/更新），跳过');
      return;
    }
    const next =
      '.' + v2[1] + '_panel{' + v2[2] + 'width:min(75vw,1280px);' + v2[3] +
      'overflow:auto;resize:horizontal;min-width:640px;/*' + PANEL_RESIZE_MARKER + '*/}';
    src = src.replace(v2[0], next);
    writeFileAtomic(file, src);
    console.log('[patch-deps] 已补丁 settings-general：弹窗宽度跟随主窗（≤1280px）+ 可拖拽拉伸');
    return;
  }
  const next =
    '.' + m[1] + '_panel{' + m[2] + 'width:min(75vw,1280px);' + m[3] +
    'overflow:auto;resize:horizontal;min-width:640px;/*' + PANEL_RESIZE_MARKER + '*/}';
  src = src.replace(m[0], next);
  writeFileAtomic(file, src);
  console.log('[patch-deps] 已补丁 settings-general：弹窗宽度跟随主窗（≤1280px）+ 可拖拽拉伸');
}

// 设置写入冲突重试补丁（v2，适配 0.1.7-rc.2+ 的 ctx.remote 形态）：上游
// ConfigFormController.mutate() 遇 settings/conflict 时 recover 后直接 return
// false——用户操作被静默丢弃（EAC issue #457：主题/字号快速连点回弹的通道
// 之一）。本补丁对无显式 revision fence 的写入做一次「recover 后按最新
// revision 重试」；显式 fence（域编辑器钉版本）语义保持，冲突仍如实上报。
// 最终失败仍 return false，让调用方进入各自的错误提示分支。
// 锚点从 0.1.7-rc.2 编译产物逐字摘录，三处世代陷阱勿回退：
//   1. 传输句柄是 this.ctx.remote.settings.mutate（旧锚 this.api.* 已失配，
//      那是上一版补丁从未生效的死因之一）；
//   2. 错误码是 "settings/conflict"（斜杠；旧补丁写 settings-conflict，永远
//      为 false，重试分支形同死代码）；
//   3. 编译产物无语句级 void、undefined 为 void 0。
const SETTINGS_WRITE_MARKER = 'dsh-desktop-settings-write-retry';
const SETTINGS_WRITE_TARGET = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings',
  'lib',
  'client.js',
);
const SETTINGS_WRITE_OLD = [
  '\t\t\t\t\tif (!response.ok) {',
  '\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\treturn false;',
  '\t\t\t\t\t}',
].join('\n');
const SETTINGS_WRITE_NEW = [
  '\t\t\t\t\tif (!response.ok) {',
  `\t\t\t\t\t\t/* ${SETTINGS_WRITE_MARKER}: settings/conflict -> recover once, retry once (v2, ctx.remote) */`,
  '\t\t\t\t\t\tif (response.error !== void 0 && response.error.code === "settings/conflict" && expectedRevision === void 0 && generation === this.writeGeneration && !this.disposed) {',
  '\t\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\t\tif (!this.disposed && generation === this.writeGeneration) {',
  '\t\t\t\t\t\t\t\tconst fresh = this.getSnapshot().revision;',
  '\t\t\t\t\t\t\t\tif (fresh !== void 0 && fresh !== revision) {',
  '\t\t\t\t\t\t\t\t\tconst retried = await this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, fresh);',
  '\t\t\t\t\t\t\t\t\tif (retried.ok) {',
  '\t\t\t\t\t\t\t\t\t\tif (this.disposed) return true;',
  '\t\t\t\t\t\t\t\t\t\tif (generation === this.writeGeneration) {',
  '\t\t\t\t\t\t\t\t\t\t\tthis.pendingRevision = void 0;',
  '\t\t\t\t\t\t\t\t\t\t\tthis.mirror.acceptView(retried.value);',
  '\t\t\t\t\t\t\t\t\t\t} else this.pendingRevision = retried.value.revision;',
  '\t\t\t\t\t\t\t\t\t\treturn true;',
  '\t\t\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t\tawait this.recover(generation);',
  '\t\t\t\t\t\treturn false;',
  '\t\t\t\t\t}',
].join('\n');

function patchSettingsWriteFailureSource(source: string): string | undefined {
  if (source.includes(SETTINGS_WRITE_MARKER)) return source;
  if (!source.includes(SETTINGS_WRITE_OLD)) return undefined;
  return source.replace(SETTINGS_WRITE_OLD, SETTINGS_WRITE_NEW);
}

function patchSettingsWriteFailure(targetFile = SETTINGS_WRITE_TARGET): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-client-ui-settings 不存在，跳过');
    return false;
  }
  const source = fs.readFileSync(targetFile, 'utf8');
  const patched = patchSettingsWriteFailureSource(source);
  if (patched === source) {
    console.log('[patch-deps] 设置写入失败传播补丁已应用，跳过');
    return true;
  }
  if (patched === undefined) {
    console.log('[patch-deps] 设置写入目标代码未匹配（上游版本可能已修复/更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, patched);
  console.log('[patch-deps] 已补丁 client-ui-settings：settings/conflict 恢复后按新 revision 重试一次');
  return true;
}

// 主题写入收敛 + adopt 在途防护补丁（EAC issue #457）：上游 ThemeRuntime
// 的 setTheme/setFontSize 是乐观发布——先改内存、publish 翻 DOM，然后才
// 异步 host.set，且无视写入结果；adopt() 又会在每次设置广播时无条件把内存
// 拉回「已提交值」。快速连点时 N 笔写排队，每笔响应都把显示逐帧拉回历史值
// （闪屏/回弹）；与被回弹污染的本地值比较的同值守卫还会吞掉用户的补充点击。
// 本补丁在 ThemeRuntime 私有层做两件事（刻意不动 ConfigForm 的
// ordering/revision/recovery 公共契约）：
//   1. 每字段至多一笔在途 wire 写；飞行中的调用只更新目标值，settle 后
//      目标 ≠ 落盘值再补一笔（N 次点击 = 1 笔 wire 写，写终值）。
//   2. adopt() 按字段跳过在途字段的覆盖（其他窗口/外部编辑照常采纳）；
//      写失败回滚到该字段最后 settled 的持久值（force，绕过防护）。
// 锚点按 0.1.7-rc.2 编译产物逐字摘录，两代通用（0.2.0-rc.2 的
// client/index.ts 逐字节一致）：产物无语句级 void、undefined 编译为
// void 0、字号边界内联为字面量（边界值只在 throw 行，不在锚点内）。
const THEME_WRITE_MARKER = 'dsh-desktop-theme-write-converge';
const THEME_WRITE_TARGET = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-theme',
  'lib',
  'client.js',
);
const THEME_WRITE_EDITS: Array<[string, string]> = [
  [
    [
      '\t\t\t\tthis.preference = id;',
      '\t\t\t\tif (isThemePreference(id)) this.host.set(THEME_PREFERENCE_FIELD, id);',
      '\t\t\t\tthis.publish();',
    ].join('\n'),
    [
      '\t\t\t\tthis.preference = id;',
      '\t\t\t\tif (isThemePreference(id)) this.__eacWrite("preference", id);',
      '\t\t\t\tthis.publish();',
    ].join('\n'),
  ],
  [
    [
      '\t\t\t\tthis.fontSize = px;',
      '\t\t\t\tthis.host.set(FONT_SIZE_FIELD, px);',
      '\t\t\t\tthis.publish();',
    ].join('\n'),
    [
      '\t\t\t\tthis.fontSize = px;',
      '\t\t\t\tthis.__eacWrite("fontSize", px);',
      '\t\t\t\tthis.publish();',
    ].join('\n'),
  ],
  [
    [
      '\t\t\t/** Adopt the scope\'s accepted durable preference without writing it back. */',
      '\t\t\tadopt() {',
      '\t\t\t\tconst section = this.host.getSnapshot().value;',
      '\t\t\t\tif (section === void 0) return;',
      '\t\t\t\tif (this.preference === section.preference && this.fontSize === section.fontSize) return;',
      '\t\t\t\tthis.preference = section.preference;',
      '\t\t\t\tthis.fontSize = section.fontSize;',
      '\t\t\t\tthis.publish();',
      '\t\t\t}',
    ].join('\n'),
    [
      '\t\t\t/** Adopt the scope\'s accepted durable preference without writing it back. */',
      '\t\t\tadopt() {',
      '\t\t\t\tconst section = this.host.getSnapshot().value;',
      '\t\t\t\tif (section === void 0) return;',
      '\t\t\t\tconst pending = this.__eacPending;',
      '\t\t\t\tconst skipPreference = pending !== void 0 && pending.has("preference");',
      '\t\t\t\tconst skipFontSize = pending !== void 0 && pending.has("fontSize");',
      '\t\t\t\tlet changed = false;',
      '\t\t\t\tif (!skipPreference && this.preference !== section.preference) {',
      '\t\t\t\t\tthis.preference = section.preference;',
      '\t\t\t\t\tchanged = true;',
      '\t\t\t\t}',
      '\t\t\t\tif (!skipFontSize && this.fontSize !== section.fontSize) {',
      '\t\t\t\t\tthis.fontSize = section.fontSize;',
      '\t\t\t\t\tchanged = true;',
      '\t\t\t\t}',
      '\t\t\t\tif (changed) this.publish();',
      '\t\t\t}',
      '\t\t\t/** dsh-desktop-theme-write-converge: 每字段至多一笔在途 wire 写；飞行中的调用',
      '\t\t\t* 只更新目标值；settle 后目标漂移再补一笔；失败回滚到最后 settled 持久值。',
      '\t\t\t* __eacPending 同时是 adopt 的在途防护（EAC issue #457）。deadline 10s 与',
      '\t\t\t* skin-loader 写超时同量级，防连接挂起时 adopt 永久饥饿。 */',
      '\t\t\t__eacWrite(field, value) {',
      '\t\t\t\tif (this.__eacPending === void 0) this.__eacPending = new Map();',
      '\t\t\t\tconst pending = this.__eacPending.get(field);',
      '\t\t\t\tif (pending !== void 0) {',
      '\t\t\t\t\tpending.target = value;',
      '\t\t\t\t\treturn;',
      '\t\t\t\t}',
      '\t\t\t\tconst section = this.host.getSnapshot().value;',
      '\t\t\t\tconst settled = section === void 0 ? value : field === "preference" ? section.preference : section.fontSize;',
      '\t\t\t\tconst entry = { inFlight: true, target: value, settled, wire: value, deadline: void 0 };',
      '\t\t\t\tthis.__eacPending.set(field, entry);',
      '\t\t\t\tentry.deadline = setTimeout(() => {',
      '\t\t\t\t\tif (this.__eacPending !== void 0 && this.__eacPending.get(field) === entry) this.__eacPending.delete(field);',
      '\t\t\t\t}, 10000);',
      '\t\t\t\tconst settle = (ok) => {',
      '\t\t\t\t\tif (entry.deadline !== void 0) { clearTimeout(entry.deadline); entry.deadline = void 0; }',
      '\t\t\t\t\tconst current = this.__eacPending === void 0 ? void 0 : this.__eacPending.get(field);',
      '\t\t\t\t\tif (current !== entry) return;',
      '\t\t\t\t\tif (ok) {',
      '\t\t\t\t\t\tentry.inFlight = false;',
      '\t\t\t\t\t\tentry.settled = entry.wire;',
      '\t\t\t\t\t\tif (entry.target !== entry.wire) {',
      '\t\t\t\t\t\t\tconst next = entry.target;',
      '\t\t\t\t\t\t\tthis.__eacPending.delete(field);',
      '\t\t\t\t\t\t\tthis.__eacWrite(field, next);',
      '\t\t\t\t\t\t\treturn;',
      '\t\t\t\t\t\t}',
      '\t\t\t\t\t\tthis.__eacPending.delete(field);',
      '\t\t\t\t\t\treturn;',
      '\t\t\t\t\t}',
      '\t\t\t\t\tthis.__eacPending.delete(field);',
      '\t\t\t\t\tif (field === "preference") this.preference = entry.settled;',
      '\t\t\t\t\telse this.fontSize = entry.settled;',
      '\t\t\t\t\tthis.publish();',
      '\t\t\t\t};',
      '\t\t\t\tthis.host.set(field, value).then((ok) => settle(ok === true), () => settle(false));',
      '\t\t\t}',
    ].join('\n'),
  ],
];

function patchThemeWriteConvergeSource(source: string): string | undefined {
  if (source.includes(THEME_WRITE_MARKER)) return source;
  let out = source;
  for (const [oldText, newText] of THEME_WRITE_EDITS) {
    if (!out.includes(oldText)) return undefined;
    out = out.replace(oldText, newText);
  }
  return out;
}

function patchThemeWriteConverge(targetFile = THEME_WRITE_TARGET): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-client-ui-theme 不存在，跳过');
    return false;
  }
  const source = fs.readFileSync(targetFile, 'utf8');
  const patched = patchThemeWriteConvergeSource(source);
  if (patched === source) {
    console.log('[patch-deps] 主题写入收敛补丁已应用，跳过');
    return true;
  }
  if (patched === undefined) {
    console.log('[patch-deps] 主题写入目标代码未匹配（上游版本可能已更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, patched);
  console.log('[patch-deps] 已补丁 client-ui-theme：写入收敛 + adopt 在途防护（#457 闪屏/回弹）');
  return true;
}

// reconcile 性能三连（EAC issue #457 放大器治理）：每次 settings/mutate 都走
// configEditor.edit = 文件锁 + 写前/写后两次全量 reconcileProfilePatches +
// HMR 串行队列，全量 preflight 的 manifestOf 每行重读 package.json 且无缓存
// ——大 profile 下单笔写入拖到秒级，正是「连点后排空连发」的节拍来源。
//   a) config-editor edit() 的写前 reconcile 允许跳过（内容未变时它本就是
//      Entry.update deepEqual 早退 + 重复 config-reload 事件）；
//   b) app-boot reconcileProfilePatches 内部实现跳过（requiredIds 为空 +
//      allowSkip 显式开启才生效；回滚路径与写后 #2 永不跳）；
//   c) manifestOf 记忆化（stat 键 = path|size|mtimeMs，失败不缓存）——
//      短路的前置比较需要 prepared，没有记忆化则短路省不下 I/O。
// 三条腿共生；一致性与外部改动吸收经 0.1.7-rc.2 产物逐行审计（#2 无条件
// 兜底 + readProfilePatches 每次新读 + watcher 独立 reconcile 三重保险）。
const CONFIG_EDIT_SKIP_MARKER = 'dsh-desktop-config-edit-reconcile-skip';
const RECONCILE_GATE_MARKER = 'dsh-desktop-reconcile-gate';
const CONFIG_EDIT_TARGET = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-config-editor',
  'lib',
  'index.js',
);
const APP_BOOT_TARGET = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-app-boot',
  'lib',
  'index.js',
);
const CONFIG_EDIT_OLD = [
  '\t\t\t\tconst beforePatches = readProfilePatches("dsh", this.ownerContext.profileContext);',
  '\t\t\t\tawait reconcileProfilePatches(this.ownerContext.root, beforePatches, "dsh");',
  '\t\t\t\tif (!this.entries().includes(entry)) throw new Error("Configuration entry changed during reload");',
].join('\n');
const CONFIG_EDIT_NEW = [
  '\t\t\t\tconst beforePatches = readProfilePatches("dsh", this.ownerContext.profileContext);',
  `\t\t\t\tawait reconcileProfilePatches(this.ownerContext.root, beforePatches, "dsh", [], { allowSkip: true }); /* ${CONFIG_EDIT_SKIP_MARKER} */`,
  '\t\t\t\tif (!this.entries().includes(entry)) throw new Error("Configuration entry changed during reload");',
].join('\n');

function patchConfigEditorEditShortCircuitSource(source: string): string | undefined {
  if (source.includes(CONFIG_EDIT_SKIP_MARKER)) return source;
  if (!source.includes(CONFIG_EDIT_OLD)) return undefined;
  return source.replace(CONFIG_EDIT_OLD, CONFIG_EDIT_NEW);
}

function patchConfigEditorEditShortCircuit(targetFile = CONFIG_EDIT_TARGET): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-config-editor 不存在，跳过');
    return false;
  }
  const source = fs.readFileSync(targetFile, 'utf8');
  const patched = patchConfigEditorEditShortCircuitSource(source);
  if (patched === source) {
    console.log('[patch-deps] config-editor 短路补丁已应用，跳过');
    return true;
  }
  if (patched === undefined) {
    console.log('[patch-deps] config-editor edit() 锚点未匹配（上游版本可能已更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, patched);
  console.log('[patch-deps] 已补丁 config-editor：写前 reconcile 内容未变时短路');
  return true;
}

const APP_BOOT_RECONCILE_OLD = [
  'async function reconcileProfilePatches(ctx, patches, binName, requiredIds = []) {',
  '\tconst entry = bootstrapIncludes.get(ctx);',
  '\tif (entry === void 0) throw new Error(`${binName}: profile reload requires the root Include entry`);',
].join('\n');
const APP_BOOT_RECONCILE_NEW = [
  'async function reconcileProfilePatches(ctx, patches, binName, requiredIds = [], options = {}) {',
  '\tconst entry = bootstrapIncludes.get(ctx);',
  '\tif (entry === void 0) throw new Error(`${binName}: profile reload requires the root Include entry`);',
  `\tconst reconcileSkip = options.allowSkip === true && requiredIds.length === 0; /* ${RECONCILE_GATE_MARKER} */`,
].join('\n');
const APP_BOOT_MANIFEST_OLD = [
  'function manifestOf(ctx, name, parentURL) {',
  '\tif (name.startsWith("cordis:")) return void 0;',
].join('\n');
const APP_BOOT_MANIFEST_NEW = [
  `const manifestOfMemo = new Map(); /* ${RECONCILE_GATE_MARKER}: manifestOf memoize (stat key) */`,
  'function manifestOf(ctx, name, parentURL) {',
  '\tif (name.startsWith("cordis:")) return void 0;',
].join('\n');
const APP_BOOT_MANIFEST_HOT_OLD = '\tif (pkg !== void 0) return readManifest(pkg.manifestPath);';
const APP_BOOT_MANIFEST_HOT_NEW = [
  '\tif (pkg !== void 0) {',
  '\t\tlet stats;',
  '\t\ttry { stats = statSync(pkg.manifestPath); } catch { return readManifest(pkg.manifestPath); }',
  '\t\tconst memoKey = `${pkg.manifestPath}|${stats.size}|${stats.mtimeMs}`;',
  '\t\tconst cached = manifestOfMemo.get(memoKey);',
  '\t\tif (cached !== void 0) return cached;',
  '\t\tconst manifest = readManifest(pkg.manifestPath);',
  '\t\tmanifestOfMemo.set(memoKey, manifest);',
  '\t\treturn manifest;',
  '\t}',
].join('\n');

function patchAppBootReconcileGateSource(source: string): string | undefined {
  if (source.includes(RECONCILE_GATE_MARKER)) return source;
  let out = source;
  for (const [oldText, newText] of [
    [APP_BOOT_RECONCILE_OLD, APP_BOOT_RECONCILE_NEW],
    [APP_BOOT_MANIFEST_OLD, APP_BOOT_MANIFEST_NEW],
    [APP_BOOT_MANIFEST_HOT_OLD, APP_BOOT_MANIFEST_HOT_NEW],
  ] as Array<[string, string]>) {
    if (!out.includes(oldText)) return undefined;
    out = out.replace(oldText, newText);
  }
  return out;
}

function patchAppBootReconcileGate(targetFile = APP_BOOT_TARGET): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-app-boot 不存在，跳过');
    return false;
  }
  const source = fs.readFileSync(targetFile, 'utf8');
  const patched = patchAppBootReconcileGateSource(source);
  if (patched === source) {
    console.log('[patch-deps] reconcile 门控补丁已应用，跳过');
    return true;
  }
  if (patched === undefined) {
    console.log('[patch-deps] app-boot reconcile/manifestOf 锚点未匹配（上游版本可能已更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, patched);
  console.log('[patch-deps] 已补丁 app-boot：reconcile 短路门控 + manifestOf 记忆化');
  return true;
}

// 模型目录图片输入开关：llm-pi-ai 已支持模型级 `input: [text, image]`，
// 但 settings-models 只渲染 id/name/capacity，用户只能手改 YAML。给直接
// DeepSeek 与通用 pi-ai 两套模型表格都增加行内 switch。关闭时传 undefined，
// 复用现有 update/patch 删除字段，保留 catalog/defaultInput 的继承语义。
const MODEL_IMAGE_INPUT_MARKER_V1 = 'dsh-desktop-model-image-input';
const MODEL_IMAGE_INPUT_MARKER = 'dsh-desktop-model-image-input-v2';
const MODEL_SETTINGS_FILE = path.join(
  root,
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-models',
  'lib',
  'client.js',
);
const MODEL_IMAGE_HELPER_ANCHOR = [
  '\t\tfunction modelDrafts(value) {',
  '\t\t\tif (!Array.isArray(value)) return [];',
  '\t\t\treturn value.map((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry) ? entry : {});',
  '\t\t}',
].join('\n');
const MODEL_IMAGE_HELPER_V1 = [
  MODEL_IMAGE_HELPER_ANCHOR,
  '\t\t/** Whether one model explicitly declares native image input. */',
  '\t\tfunction modelAcceptsImage(model) {',
  '\t\t\treturn Array.isArray(model["input"]) && model["input"].includes("image");',
  '\t\t}',
  '\t\t/** Render the model-level native image-input declaration switch. */',
  '\t\tfunction ModelImageInputSwitch(props) {',
  '\t\t\tconst enabled = modelAcceptsImage(props.model);',
  '\t\t\tconst label = props.t("modelImageInput");',
  '\t\t\treturn (0, react_jsx_runtime.jsxs)("button", {',
  '\t\t\t\ttype: "button",',
  '\t\t\t\trole: "switch",',
  '\t\t\t\t"aria-checked": enabled,',
  '\t\t\t\t"aria-label": `${label} ${String(props.index + 1)}`,',
  '\t\t\t\ttitle: props.t("modelImageInputHint"),',
  '\t\t\t\tclassName: `${ModelsSection_module_css_default["modelImageSwitch"]}${enabled ? ` ${ModelsSection_module_css_default["modelImageSwitchOn"]}` : ""}`,',
  '\t\t\t\tdisabled: props.disabled,',
  '\t\t\t\tonClick: () => {',
  '\t\t\t\t\tprops.onChange(enabled ? void 0 : ["text", "image"]);',
  '\t\t\t\t},',
  '\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\tclassName: ModelsSection_module_css_default["modelImageLabel"],',
  '\t\t\t\t\tchildren: label',
  '\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\tclassName: ModelsSection_module_css_default["modelImageTrack"],',
  '\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelImageThumb"] })',
  '\t\t\t\t})]',
  '\t\t\t});',
  '\t\t}',
].join('\n');
const MODEL_IMAGE_HELPER = [
  MODEL_IMAGE_HELPER_ANCHOR,
  '\t\t/** Whether one model explicitly declares native image input. */',
  '\t\tfunction modelAcceptsImage(model) {',
  '\t\t\treturn Array.isArray(model["input"]) && model["input"].includes("image");',
  '\t\t}',
  '\t\t/** Render the model-level native image-input declaration switch. */',
  '\t\tfunction ModelImageInputSwitch(props) {',
  '\t\t\tconst enabled = modelAcceptsImage(props.model);',
  '\t\t\tconst label = props.t("modelImageInput");',
  '\t\t\treturn (0, react_jsx_runtime.jsx)("button", {',
  '\t\t\t\ttype: "button",',
  '\t\t\t\trole: "switch",',
  '\t\t\t\t"aria-checked": enabled,',
  '\t\t\t\t"aria-label": `${label} ${String(props.index + 1)}`,',
  '\t\t\t\ttitle: props.t("modelImageInputHint"),',
  '\t\t\t\tclassName: `${ModelsSection_module_css_default["modelImageSwitch"]}${enabled ? ` ${ModelsSection_module_css_default["modelImageSwitchOn"]}` : ""}`,',
  '\t\t\t\tdisabled: props.disabled,',
  '\t\t\t\tonClick: () => {',
  '\t\t\t\t\tprops.onChange(enabled ? void 0 : ["text", "image"]);',
  '\t\t\t\t},',
  '\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", {',
  '\t\t\t\t\tclassName: ModelsSection_module_css_default["modelImageTrack"],',
  '\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelImageThumb"] })',
  '\t\t\t\t})',
  '\t\t\t});',
  '\t\t}',
].join('\n');
const MODEL_IMAGE_ROW_CSS_RE =
  /\.([A-Za-z0-9_-]+)_modelRow\{grid-template-columns:minmax\(0,1\.4fr\) minmax\(0,1fr\) auto auto;align-items:center;gap:6px;display:grid\}/;
const MODEL_IMAGE_DEEPSEEK_ANCHOR = [
  '\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {',
  '\t\t\t\t\t\t\t\t\t\ttype: "button",',
  '\t\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["iconButton"],',
  '\t\t\t\t\t\t\t\t\t\t"aria-label": `${props.t("modelAdvanced")} ${String(index + 1)}`,',
].join('\n');
const MODEL_IMAGE_DEEPSEEK_INSERT = [
  '\t\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(ModelImageInputSwitch, {',
  '\t\t\t\t\t\t\t\t\t\tmodel,',
  '\t\t\t\t\t\t\t\t\t\tindex,',
  '\t\t\t\t\t\t\t\t\t\tt: props.t,',
  '\t\t\t\t\t\t\t\t\t\tdisabled: props.disabled,',
  '\t\t\t\t\t\t\t\t\t\tonChange: (input) => {',
  '\t\t\t\t\t\t\t\t\t\t\tupdate(index, "input", input);',
  '\t\t\t\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\t\t\t}),',
  MODEL_IMAGE_DEEPSEEK_ANCHOR,
].join('\n');
const MODEL_IMAGE_GENERIC_ANCHOR = [
  '\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)("button", {',
  '\t\t\t\t\t\t\t\t\ttype: "button",',
  '\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["iconButton"],',
  '\t\t\t\t\t\t\t\t\t"aria-label": `${t("modelAdvanced")} ${index + 1}`,',
].join('\n');
const MODEL_IMAGE_GENERIC_INSERT = [
  '\t\t\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(ModelImageInputSwitch, {',
  '\t\t\t\t\t\t\t\t\tmodel,',
  '\t\t\t\t\t\t\t\t\tindex,',
  '\t\t\t\t\t\t\t\t\tt,',
  '\t\t\t\t\t\t\t\t\tdisabled,',
  '\t\t\t\t\t\t\t\t\tonChange: (input) => {',
  '\t\t\t\t\t\t\t\t\t\tpatch(index, { input });',
  '\t\t\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\t\t}),',
  MODEL_IMAGE_GENERIC_ANCHOR,
].join('\n');

function modelImageSwitchCssV1(prefix: string): string {
  return [
    `.${prefix}_modelImageSwitch{height:28px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:5px;padding:0 4px;font-size:11px;line-height:18px;display:inline-flex;white-space:nowrap;/*${MODEL_IMAGE_INPUT_MARKER_V1}*/}`,
    `.${prefix}_modelImageSwitch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
    `.${prefix}_modelImageSwitch:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}`,
    `.${prefix}_modelImageSwitch:disabled{cursor:default;opacity:.4}`,
    `.${prefix}_modelImageSwitchOn{color:var(--dsw-alias-label-primary)}`,
    `.${prefix}_modelImageLabel{display:inline}`,
    `.${prefix}_modelImageTrack{background:var(--dsw-alias-border-l3);border-radius:8px;flex:none;width:28px;height:16px;padding:2px;display:block}`,
    `.${prefix}_modelImageThumb{background:var(--dsw-alias-label-primary-foreground);border-radius:50%;width:12px;height:12px;transition:transform .12s;display:block}`,
    `.${prefix}_modelImageSwitchOn .${prefix}_modelImageTrack{background:var(--dsw-alias-brand-primary)}`,
    `.${prefix}_modelImageSwitchOn .${prefix}_modelImageThumb{transform:translate(12px)}`,
    `@media (max-width:760px){.${prefix}_modelImageLabel{display:none}.${prefix}_modelImageSwitch{padding:0 2px}}`,
  ].join('');
}

function modelImageSwitchCss(prefix: string): string {
  const active = 'var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary))';
  return [
    `.${prefix}_modelImageSwitch{box-sizing:border-box;width:34px;height:28px;cursor:pointer;background:transparent;border:0;border-radius:6px;justify-content:center;align-items:center;padding:0 2px;display:inline-flex;/*${MODEL_IMAGE_INPUT_MARKER}*/}`,
    `.${prefix}_modelImageSwitch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`,
    `.${prefix}_modelImageSwitch:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3);outline:none}`,
    `.${prefix}_modelImageSwitch:disabled{cursor:default;opacity:.4}`,
    `.${prefix}_modelImageTrack{box-sizing:border-box;background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;flex:none;width:30px;height:16px;transition:background-color .12s,border-color .12s;display:block;position:relative}`,
    `.${prefix}_modelImageThumb{background:var(--dsw-alias-label-tertiary);border-radius:50%;width:10px;height:10px;transition:background-color .12s,transform .12s;display:block;position:absolute;top:2px;left:2px}`,
    `.${prefix}_modelImageSwitchOn .${prefix}_modelImageTrack{background:${active};border-color:${active}}`,
    `.${prefix}_modelImageSwitchOn .${prefix}_modelImageThumb{background:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-layer-1));transform:translate(14px)}`,
    `@media (prefers-reduced-motion:reduce){.${prefix}_modelImageTrack,.${prefix}_modelImageThumb{transition:none}}`,
  ].join('');
}

function upgradeModelImageInputSource(source: string): string | undefined {
  const prefixMatch = new RegExp(
    `\\.([A-Za-z0-9_-]+)_modelImageSwitch\\{[^}]*\\/\\*${MODEL_IMAGE_INPUT_MARKER_V1}\\*\\/\\}`,
  ).exec(source);
  const prefix = prefixMatch?.[1];
  if (!prefix) return undefined;
  const oldCss = modelImageSwitchCssV1(prefix);
  const oldLabelMapping = `\n\t\t\t"modelImageLabel": "${prefix}_modelImageLabel",`;
  if (!source.includes(oldCss) || !source.includes(MODEL_IMAGE_HELPER_V1)) return undefined;
  return source
    .replace(oldCss, modelImageSwitchCss(prefix))
    .replace(oldLabelMapping, '')
    .replace(MODEL_IMAGE_HELPER_V1, MODEL_IMAGE_HELPER);
}

function patchModelImageInputSource(source: string): string | undefined {
  if (source.includes(MODEL_IMAGE_INPUT_MARKER)) return source;
  if (source.includes(`/*${MODEL_IMAGE_INPUT_MARKER_V1}*/`)) {
    return upgradeModelImageInputSource(source);
  }
  const cssMatch = MODEL_IMAGE_ROW_CSS_RE.exec(source);
  if (!cssMatch) return undefined;
  const prefix = cssMatch[1];
  if (!prefix) return undefined;
  const mappingAnchor = `\t\t\t"modelRow": "${prefix}_modelRow",`;
  const enAnchor = '\t\t\tmodelName: "Display name",';
  const zhAnchor = '\t\t\tmodelName: "显示名称",';
  const anchors = [
    MODEL_IMAGE_HELPER_ANCHOR,
    mappingAnchor,
    MODEL_IMAGE_DEEPSEEK_ANCHOR,
    MODEL_IMAGE_GENERIC_ANCHOR,
    enAnchor,
    zhAnchor,
  ];
  if (anchors.some((anchor) => !source.includes(anchor))) return undefined;

  const rowCss = cssMatch[0].replace(
    'auto auto;align-items',
    'auto auto auto;align-items',
  );
  const mappings = [
    mappingAnchor,
    `\t\t\t"modelImageSwitch": "${prefix}_modelImageSwitch",`,
    `\t\t\t"modelImageSwitchOn": "${prefix}_modelImageSwitchOn",`,
    `\t\t\t"modelImageThumb": "${prefix}_modelImageThumb",`,
    `\t\t\t"modelImageTrack": "${prefix}_modelImageTrack",`,
  ].join('\n');

  return source
    .replace(cssMatch[0], rowCss + modelImageSwitchCss(prefix))
    .replace(mappingAnchor, mappings)
    .replace(MODEL_IMAGE_HELPER_ANCHOR, MODEL_IMAGE_HELPER)
    .replace(MODEL_IMAGE_DEEPSEEK_ANCHOR, MODEL_IMAGE_DEEPSEEK_INSERT)
    .replace(MODEL_IMAGE_GENERIC_ANCHOR, MODEL_IMAGE_GENERIC_INSERT)
    .replace(
      enAnchor,
      `${enAnchor}\n\t\t\tmodelImageInput: "Image input",\n\t\t\tmodelImageInputHint: "Enable only when both the model and gateway support image input.",`,
    )
    .replace(
      zhAnchor,
      `${zhAnchor}\n\t\t\tmodelImageInput: "图片输入",\n\t\t\tmodelImageInputHint: "仅在模型及接口均支持图片输入时开启。",`,
    );
}

function patchModelImageInputToggle(targetFile = MODEL_SETTINGS_FILE): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-client-ui-settings-models 不存在，跳过');
    return false;
  }
  const source = fs.readFileSync(targetFile, 'utf8');
  const patched = patchModelImageInputSource(source);
  if (patched === source) {
    console.log('[patch-deps] 模型图片输入开关补丁已应用，跳过');
    return true;
  }
  if (patched === undefined) {
    console.log('[patch-deps] 模型图片输入开关锚点未命中（上游版本可能已更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, patched);
  console.log('[patch-deps] 已补丁 settings-models：每个模型可独立声明原生图片输入');
  return true;
}

// 函数工具桥接兼容补丁：部分外部工具适配器忽略 JSON Schema 的 required 数组，
// 把所有 properties 错当成必填。全权限默认策略下不存在可升级的更宽模式，仍
// 暴露 sandbox_permissions/justification 会让适配器强制提交一条必然失败的同级
// 升级请求。仅在默认 danger-full-access 时不暴露这对可选字段；执行层的严格
// 升级校验不变。会话切换到较窄策略后需重载工具 schema 才会再次暴露升级字段。
// 覆盖三个工具：dsh-tool-pwsh / dsh-tool-fs / dsh-tool-bash（同为
// `defaultMode === void 0 ? [] : ESCALATION_TARGETS` 模式，缺一即漏）。
const OPTIONAL_ESCALATION_MARKER = 'dsh-desktop-optional-escalation';
const OPTIONAL_ESCALATION_TARGETS = [
  path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-pwsh', 'lib', 'index.js'),
  path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-fs', 'lib', 'index.js'),
  path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tool-bash', 'lib', 'index.js'),
];
const OPTIONAL_ESCALATION_OLD = 'defaultMode === void 0 ? [] : ESCALATION_TARGETS';
const OPTIONAL_ESCALATION_NEW = 'defaultMode === void 0 || defaultMode === "danger-full-access" ? [] : ESCALATION_TARGETS /* dsh-desktop-optional-escalation */';

function patchOptionalEscalationFields(): void {
  for (const file of OPTIONAL_ESCALATION_TARGETS) {
    if (!fs.existsSync(file)) {
      console.log('[patch-deps] 可选升级字段目标不存在，跳过：' + file);
      continue;
    }
    let src = fs.readFileSync(file, 'utf8');
    if (src.includes(OPTIONAL_ESCALATION_MARKER)) {
      console.log('[patch-deps] 可选升级字段兼容补丁已应用，跳过：' + path.basename(path.dirname(path.dirname(file))));
      continue;
    }
    if (!src.includes(OPTIONAL_ESCALATION_OLD)) {
      console.log('[patch-deps] 未匹配可选升级字段目标（上游版本可能已修复/更新），跳过：' + file);
      continue;
    }
    src = src.replace(OPTIONAL_ESCALATION_OLD, OPTIONAL_ESCALATION_NEW);
    writeFileAtomic(file, src);
    console.log('[patch-deps] 已补丁可选升级字段：' + path.basename(path.dirname(path.dirname(file))));
  }
}

// 模式选择菜单二级化补丁：agent preset 选择器把 user trust（自定义 / EAC 内置）
// 的 preset 收进「第三方模式」二级菜单（Menu 原生 submenu），官方内置（system
// trust）保留主列表。幂等 marker: dsh-desktop:third-party（preset id 规则不允许
// 冒号，不会与真实 preset id 冲突）。目标代码是编译产物，锚点失配告警跳过。
const AGENT_PRESET_MARKER = 'dsh-desktop:third-party';
const AGENT_PRESET_FILE = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-ui-agent-preset', 'lib', 'client.js');
const AGENT_PRESET_SEAT_START = 'items: state.options.map((option) => {';
const AGENT_PRESET_SEAT_TAIL = '}),\n\t\t\t\tselectedId: state.current,';
const AGENT_PRESET_ROW_START = 'items: options.map((option) => {';
const AGENT_PRESET_ROW_TAIL = '}),\n\t\t\t\tselectedId,';
const AGENT_PRESET_ZH_ANCHOR = 'presetCordisName: "创造模式",';
const AGENT_PRESET_EN_ANCHOR = 'presetCordisName: "Creator mode",';

function patchAgentPresetMenu(file?: string): boolean {
  const target = file || AGENT_PRESET_FILE;
  if (!fs.existsSync(target)) {
    console.log('[patch-deps] dsh-client-ui-agent-preset 不存在，跳过');
    return false;
  }
  let src = fs.readFileSync(target, 'utf8');
  if (src.includes(AGENT_PRESET_MARKER)) {
    console.log('[patch-deps] agent-preset 模式菜单补丁已应用，跳过');
    return true;
  }
  const seatStart = src.indexOf(AGENT_PRESET_SEAT_START);
  const seatTail = seatStart >= 0 ? src.indexOf(AGENT_PRESET_SEAT_TAIL, seatStart) : -1;
  const rowStart = src.indexOf(AGENT_PRESET_ROW_START);
  const rowTail = rowStart >= 0 ? src.indexOf(AGENT_PRESET_ROW_TAIL, rowStart) : -1;
  // KERN-004 判定：0.2.0 把设置页的 preset 行菜单官方化为内建/自定义分组卡片
  // 列表（AgentPresetSection.tsx，原生分组渲染），ROW 锚点随之消失 —— 行面
  // 官方化；composer 座位菜单（AgentPresetSeat.tsx:161 state.options.map）锚点
  // 仍在，第三方收进二级菜单的能力对 seat 面仍是真漂移。行替换改为可选：
  // 锚点在则照旧（≤0.1.7 世代），不在则 seat-only 落补丁，不再整体跳过。
  const rowApplicable = rowStart >= 0 && rowTail >= 0;
  if (seatStart < 0 || seatTail < 0 || !src.includes(AGENT_PRESET_ZH_ANCHOR) || !src.includes(AGENT_PRESET_EN_ANCHOR)) {
    console.log('[patch-deps] agent-preset 未匹配到目标代码（版本可能已更新），跳过');
    return false;
  }
  const seatBody = src.slice(seatStart + AGENT_PRESET_SEAT_START.length, seatTail);
  // composer 座位：官方保留主列表，第三方收进「第三方模式」submenu。
  // submenu 子项复用两行渲染体，但 Menu 的 submenu item 是 flex-row center，
  // 会压扁两行结构导致字体重叠 —— 给子项 item span 加内联纵向布局覆盖。
  const seatSubItemBody = seatBody.replace(
    'className: AgentPresetSeat_module_css_default.item,',
    'className: AgentPresetSeat_module_css_default.item, style: { flexDirection: "column" },'
  );
  const seatNew =
    'items: [...state.options.filter((option) => option.trust !== "user").map((option) => {' + seatBody +
    '\n\t\t\t\t}), ...(function () {\n' +
    '\t\t\t\t\tconst user = state.options.filter((option) => option.trust === "user");\n' +
    '\t\t\t\t\tif (user.length === 0) return [];\n' +
    '\t\t\t\t\treturn [{\n' +
    '\t\t\t\t\t\tid: "' + AGENT_PRESET_MARKER + '",\n' +
    '\t\t\t\t\t\tlabel: (0, react_jsx_runtime.jsxs)("span", {\n' +
    '\t\t\t\t\t\t\tclassName: AgentPresetSeat_module_css_default.item,\n' +
    '\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {\n' +
    '\t\t\t\t\t\t\t\tclassName: AgentPresetSeat_module_css_default.itemName,\n' +
    '\t\t\t\t\t\t\t\tchildren: t("menu.thirdPartyMode")\n' +
    '\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {\n' +
    '\t\t\t\t\t\t\t\tclassName: AgentPresetSeat_module_css_default.itemDesc,\n' +
    '\t\t\t\t\t\t\t\tchildren: t("menu.thirdPartyModeHint")\n' +
    '\t\t\t\t\t\t\t})]\n' +
    '\t\t\t\t\t\t}),\n' +
    '\t\t\t\t\t\tsubmenu: user.map((option) => {' + seatSubItemBody +
    '\n\t\t\t\t\t\t})\n' +
    '\t\t\t\t\t}];\n' +
    '\t\t\t\t}())],\n\t\t\t\tselectedId: state.current,';
  // 设置行（PresetMenu，纯文本 label）：同样收进 submenu，组内不再带「· 自定义」后缀。
  // 0.2.0 起该面已被官方卡片列表替代（rowApplicable=false 时整段跳过）。
  const rowBody = rowApplicable ? src.slice(rowStart + AGENT_PRESET_ROW_START.length, rowTail) : '';
  const rowNew = rowApplicable
    ? 'items: [...options.filter((option) => option.trust !== "user").map((option) => {' + rowBody +
    '\n\t\t\t\t}), ...(function () {\n' +
    '\t\t\t\t\tconst user = options.filter((option) => option.trust === "user");\n' +
    '\t\t\t\t\tif (user.length === 0) return [];\n' +
    '\t\t\t\t\treturn [{\n' +
    '\t\t\t\t\t\tid: "' + AGENT_PRESET_MARKER + '",\n' +
    '\t\t\t\t\t\tlabel: t("menu.thirdPartyMode"),\n' +
    '\t\t\t\t\t\tsubmenu: user.map((option) => {\n' +
    '\t\t\t\t\t\t\tconst name = presetDisplayText(option, t).name;\n' +
    '\t\t\t\t\t\t\treturn { id: option.id, label: name };\n' +
    '\t\t\t\t\t\t})\n' +
    '\t\t\t\t\t}];\n' +
    '\t\t\t\t}())],\n\t\t\t\tselectedId,'
    : '';
  const zhDictAdd = '\n\t\t\t"menu.thirdPartyMode": "第三方模式",\n\t\t\t"menu.thirdPartyModeHint": "自定义与 EAC 内置的 Agent 预设",';
  const enDictAdd = '\n\t\t\t"menu.thirdPartyMode": "Third-party modes",\n\t\t\t"menu.thirdPartyModeHint": "Custom and EAC-bundled agent presets",';
  // 先做 items 替换（用旧索引的 slice），再注入词典（词典锚点在 items 之前，不受 items 替换影响）
  src = src.replace(src.slice(seatStart, seatTail + AGENT_PRESET_SEAT_TAIL.length), seatNew);
  if (rowApplicable) src = src.replace(src.slice(rowStart, rowTail + AGENT_PRESET_ROW_TAIL.length), rowNew);
  src = src
    .replace(AGENT_PRESET_ZH_ANCHOR, AGENT_PRESET_ZH_ANCHOR + zhDictAdd)
    .replace(AGENT_PRESET_EN_ANCHOR, AGENT_PRESET_EN_ANCHOR + enDictAdd);
  writeFileAtomic(target, src);
  console.log(rowApplicable
    ? '[patch-deps] 已补丁 agent-preset：第三方模式收进二级菜单'
    : '[patch-deps] 已补丁 agent-preset（seat 面）：第三方模式收进二级菜单；设置行菜单已官方化为卡片列表，跳过行面');
  return true;
}

// Menu 二级菜单滚动补丁：dsh-web-frontend 主 bundle 里 primitives 的 submenu
// 容器没有高度上限，preset 较多时子菜单超出视口且不可滚动。给 submenu 容器
// 注入内联 max-height + overflow-y。rc.2 起 primitives 被打包进主 bundle
// （dsh-web-frontend/dist/assets/index-*.js，压缩变量 xxx.submenu），不再有
// 独立包 —— 目标改为扫描主 bundle。锚点：submenu.map( 前的 role:"menu",。
// 幂等 marker: dsh-desktop:menu-submenu-hover（容器整段重建）+
// --dsh-desktop-submenu-label（submenu 项两行布局）。
// ⚠️ 锚点前提：下方所有字符串锚点在目标 bundle 里必须唯一，否则替换会误伤
// 多处；新增/改动前需先 grep 确认唯一性。
const MENU_SUBMENU_HOVER_MARKER = 'dsh-desktop:menu-submenu-hover';
const MENU_SUBMENU_MAXH = 'calc(100dvh - 96px)';
// 二级菜单宽度与一级菜单对齐：submenu 容器 fit-content 会被 label 里最长的
// 不可断 token 撑到很窄（实测约 163px，一级菜单约 334px）。给 submenu 一个
// 与一级菜单接近的 min-width，描述行更舒展。
const MENU_SUBMENU_MINW = 320;
const MENU_SUBMENU_ANCHOR = 'submenu.map(';
// itemWrap 的 onMouseLeave 默认立即关闭，鼠标从一级菜单项移到二级菜单要
// 跨过二者间隙会先触发离开而缩回。改为延迟关闭（600ms，留足缓慢移动跨
// 间隙的时间），配合二级菜单自身的 onMouseEnter 取消定时器并保持，鼠标可
// 平滑滑入。定时器存 window 全局，幂等重放安全。enter 也先清定时器，防止
// 上一处 leave 排的关闭在移回时误触发。
const ITEMWRAP_LEAVE_ANCHOR = 'onMouseLeave:()=>{z(null)}';
const ITEMWRAP_LEAVE_NEW = 'onMouseLeave:()=>{clearTimeout(window.__dshMenuTimer);window.__dshMenuTimer=setTimeout(()=>z(null),600)}';
// 上一版已打 300ms 延迟的 bundle，升级锚点改为 600ms
const ITEMWRAP_LEAVE_UPGRADE_ANCHOR = 'setTimeout(()=>z(null),300)';
const ITEMWRAP_LEAVE_UPGRADE_NEW = 'setTimeout(()=>z(null),600)';
const ITEMWRAP_ENTER_ANCHOR = 'onMouseEnter:()=>{z(se?B.id:null)}';
const ITEMWRAP_ENTER_NEW = 'onMouseEnter:()=>{clearTimeout(window.__dshMenuTimer);z(se?B.id:null)}';
// submenu 自身 onMouseLeave 若立即 z(null)，从二级菜单移回一级菜单会先关掉
// 二级菜单再重开，时序不稳表现为「移回后不再展开」。改为延迟 400ms，
// 移回一级菜单时 itemWrap enter 清定时器并保持。
const SUBMENU_LEAVE_ANCHOR = 'onMouseLeave:()=>{clearTimeout(window.__dshMenuTimer);z(null)}';
const SUBMENU_LEAVE_NEW = 'onMouseLeave:()=>{clearTimeout(window.__dshMenuTimer);window.__dshMenuTimer=setTimeout(()=>z(null),400)}';
// root span 的 onPointerLeave 默认立即关闭整个菜单。二级菜单是 portal 到 body
// 的独立 DOM，鼠标从一级菜单跨过去必然离开 root span → 菜单（含二级）被立即
// 收起，表现为「二级菜单还没展开就消失」。改为走同一延迟定时器（300ms），
// 与 itemWrap / submenu 的 onMouseEnter 取消逻辑统一，鼠标可平滑滑入二级菜单。
const ROOT_POINTERLEAVE_ANCHOR = 'onPointerLeave:_?()=>{n&&A()}:void 0';
const ROOT_POINTERLEAVE_NEW = 'onPointerLeave:_?()=>{clearTimeout(window.__dshMenuTimer);window.__dshMenuTimer=setTimeout(()=>{n&&A()},300)}:void 0';
// submenu 项两行布局补丁：Menu 的 .itemLabel 默认 white-space:nowrap +
// overflow:hidden，会把 agent-preset 的两行 label（名称+描述）压扁裁成
// 字体重叠。给 submenu 项注入内联覆盖：允许换行、内容可见、item 顶部对齐。
// 幂等 marker 用 style 里的 CSS 自定义属性（React 支持 --xxx 键透传，
// 未被引用则无副作用），避免破坏 JS 语法。
const SUBMENU_ITEM_MARKER = '--dsh-desktop-submenu-label';
const SUBMENU_BTN_ANCHOR = 'f.jsxs("button",{type:"button",role:"menuitem",className:Re.item,disabled:he.disabled';
const SUBMENU_BTN_NEW = 'f.jsxs("button",{type:"button",role:"menuitem",className:Re.item,style:{alignItems:"flex-start",flexShrink:0},disabled:he.disabled';
const SUBMENU_LABEL_ANCHOR = 'f.jsx("span",{className:Re.itemLabel,children:he.label})';
const SUBMENU_LABEL_NEW = 'f.jsx("span",{className:Re.itemLabel,style:{whiteSpace:"normal",overflow:"visible","' + SUBMENU_ITEM_MARKER + '":"1"},children:he.label})';
// 0.1.2-alpha.1 产物形态（压缩变量名变为 d/Pe/fe； submenu 项才有 fe.label）。
const SUBMENU_BTN_ANCHOR_012 = 'd.jsxs("button",{type:"button",role:"menuitem",className:Pe.item,disabled:fe.disabled';
const SUBMENU_BTN_NEW_012 = 'd.jsxs("button",{type:"button",role:"menuitem",className:Pe.item,style:{alignItems:"flex-start",flexShrink:0},disabled:fe.disabled';
const SUBMENU_LABEL_ANCHOR_012 = 'd.jsx("span",{className:Pe.itemLabel,children:fe.label})';
const SUBMENU_LABEL_NEW_012 = 'd.jsx("span",{className:Pe.itemLabel,style:{whiteSpace:"normal",overflow:"visible","' + SUBMENU_ITEM_MARKER + '":"1"},children:fe.label})';
// 0.2.0 产物形态（KERN-004 第三代：l.jsxs/l.jsx + 类对象 Ee + 子项 he，新增
// "aria-keyshortcuts" 属性插在 disabled 之后 —— 锚点截到 disabled:he.disabled
// 为止不受影响）。submenu 项两行布局修复仍被 agent-preset seat 子菜单需要。
const SUBMENU_BTN_ANCHOR_020 = 'l.jsxs("button",{type:"button",role:"menuitem",className:Ee.item,disabled:he.disabled';
const SUBMENU_BTN_NEW_020 = 'l.jsxs("button",{type:"button",role:"menuitem",className:Ee.item,style:{alignItems:"flex-start",flexShrink:0},disabled:he.disabled';
const SUBMENU_LABEL_ANCHOR_020 = 'l.jsx("span",{className:Ee.itemLabel,children:he.label})';
const SUBMENU_LABEL_NEW_020 = 'l.jsx("span",{className:Ee.itemLabel,style:{whiteSpace:"normal",overflow:"visible","' + SUBMENU_ITEM_MARKER + '":"1"},children:he.label})';

function patchMenuSubmenuScroll(file?: string): boolean {
  let target: string | undefined = file;
  if (!target) {
    const dir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets');
    if (!fs.existsSync(dir)) {
      console.log('[patch-deps] dsh-web-frontend 不存在，跳过');
      return false;
    }
    const candidates = fs.readdirSync(dir).filter((f) => f.startsWith('index-') && f.endsWith('.js'));
    for (const f of candidates) {
      const full = path.join(dir, f);
      if (fs.readFileSync(full, 'utf8').includes(MENU_SUBMENU_ANCHOR)) { target = full; break; }
    }
  }
  if (!target) {
    console.log('[patch-deps] 主 bundle 未含 submenu 渲染（版本可能已更新），跳过');
    return false;
  }
  if (!fs.existsSync(target)) {
    console.log('[patch-deps] 目标 bundle 不存在，跳过');
    return false;
  }
  let src = fs.readFileSync(target, 'utf8');
  let changed = false;
  // 三个改动各自按锚点独立幂等，不再用单一 marker 门控整个 if 块——
  // 旧版 bundle 已有 hover marker 时，后续新增的 minWidth / root pointerleave
  // 改动仍要能补打上（锚点替换后原始文本消失，自然幂等）。

  // 1) submenu 容器：悬停保持 + 高度/宽度自适应（minWidth 缺失才重建整段）
  if (!src.includes('minWidth:' + MENU_SUBMENU_MINW)) {
    const submenuIdx = src.indexOf(MENU_SUBMENU_ANCHOR);
    const roleIdx = submenuIdx >= 0 ? src.lastIndexOf('role:"menu",', submenuIdx) : -1;
    // role:"menu", 必须紧邻 submenu.map（submenu 容器的 role），距离过大说明命中了别处
    if (submenuIdx < 0 || roleIdx < 0 || submenuIdx - roleIdx > 400) {
      console.log('[patch-deps] Menu submenu 未匹配到目标代码（版本可能已更新），跳过');
      return false;
    }
    // 替换 role:"menu", 到 submenu.map( 之间整段（旧版可能已注入 style + scroll marker）：
    // 二级菜单悬停保持（onMouseEnter 取消关闭定时器并重新激活，onMouseLeave 关闭），
    // 高度自适应视口（内容少自然高度，超高才滚动）、宽度对齐一级菜单，配合
    // itemWrap / root 延迟关闭让鼠标可跨过一级菜单与二级菜单之间的间隙。
    const newBlock = 'role:"menu",onMouseEnter:()=>{clearTimeout(window.__dshMenuTimer);z(B.id)},' + SUBMENU_LEAVE_NEW + ',style:{maxHeight:"' + MENU_SUBMENU_MAXH + '",overflowY:"auto",minWidth:' + MENU_SUBMENU_MINW + '},/*' + MENU_SUBMENU_HOVER_MARKER + '*/children:B.';
    src = src.slice(0, roleIdx) + newBlock + src.slice(submenuIdx);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：二级菜单悬停保持 + 高度/宽度自适应');
  }

  // 2) 一级菜单项：悬停离开延迟关闭（600ms，缓慢跨间隙不折叠）
  if (src.includes(ITEMWRAP_LEAVE_ANCHOR)) {
    src = src.replace(ITEMWRAP_LEAVE_ANCHOR, ITEMWRAP_LEAVE_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：菜单项悬停离开延迟关闭（鼠标可跨间隙滑入二级菜单）');
  } else if (src.includes(ITEMWRAP_LEAVE_UPGRADE_ANCHOR)) {
    src = src.replace(ITEMWRAP_LEAVE_UPGRADE_ANCHOR, ITEMWRAP_LEAVE_UPGRADE_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：菜单项悬停离开延迟加长到 600ms');
  }

  // 3) 菜单根：pointerleave 延迟关闭（二级菜单是 body portal，鼠标跨过去不再立即收起）
  if (src.includes(ROOT_POINTERLEAVE_ANCHOR)) {
    src = src.replace(ROOT_POINTERLEAVE_ANCHOR, ROOT_POINTERLEAVE_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：菜单根 pointerleave 延迟关闭（二级菜单不再被立即收起）');
  }

  // 4) 一级菜单项 onMouseEnter 也清定时器：从二级菜单移回时，上一处 leave 排的
  //    关闭定时器不会在移回后被误触发
  if (src.includes(ITEMWRAP_ENTER_ANCHOR)) {
    src = src.replace(ITEMWRAP_ENTER_ANCHOR, ITEMWRAP_ENTER_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：菜单项悬停进入清关闭定时器（移回二级菜单保持）');
  }

  // 5) submenu 自身 onMouseLeave 改为延迟关闭：从二级菜单移回一级菜单不再先关再开
  if (src.includes(SUBMENU_LEAVE_ANCHOR)) {
    src = src.replace(SUBMENU_LEAVE_ANCHOR, SUBMENU_LEAVE_NEW);
    changed = true;
    console.log('[patch-deps] 已补丁主 bundle：二级菜单悬停离开延迟关闭（移回一级菜单保持）');
  }
  if (!src.includes(SUBMENU_ITEM_MARKER)) {
    // 三候选：0.2.0（l/Ee/he）、rc.2（Re/he/f）与 0.1.2（Pe/fe/d）三代产物形态。
    const use020 = src.includes(SUBMENU_BTN_ANCHOR_020) && src.includes(SUBMENU_LABEL_ANCHOR_020);
    const use012 = !use020 && src.includes(SUBMENU_BTN_ANCHOR_012) && src.includes(SUBMENU_LABEL_ANCHOR_012);
    const btnAnchor = use020 ? SUBMENU_BTN_ANCHOR_020 : use012 ? SUBMENU_BTN_ANCHOR_012 : SUBMENU_BTN_ANCHOR;
    const btnNew = use020 ? SUBMENU_BTN_NEW_020 : use012 ? SUBMENU_BTN_NEW_012 : SUBMENU_BTN_NEW;
    const labelAnchor = use020 ? SUBMENU_LABEL_ANCHOR_020 : use012 ? SUBMENU_LABEL_ANCHOR_012 : SUBMENU_LABEL_ANCHOR;
    const labelNew = use020 ? SUBMENU_LABEL_NEW_020 : use012 ? SUBMENU_LABEL_NEW_012 : SUBMENU_LABEL_NEW;
    const btnIdx = src.indexOf(btnAnchor);
    const labelIdx = btnIdx >= 0 ? src.indexOf(labelAnchor, btnIdx) : -1;
    if (btnIdx < 0 || labelIdx < 0) {
      console.log('[patch-deps] Menu submenu item 未匹配到目标代码（版本可能已更新），跳过');
    } else {
      src = src.slice(0, btnIdx) + btnNew + src.slice(btnIdx + btnAnchor.length);
      const l2 = src.indexOf(labelAnchor, btnIdx);
      src = src.slice(0, l2) + labelNew + src.slice(l2 + labelAnchor.length);
      changed = true;
      console.log('[patch-deps] 已补丁主 bundle：submenu 项两行布局不再被裁剪');
    }
  }
  if (changed) writeFileAtomic(target, src);
  return true;
}

// client-modules 解析签名恢复：上游 0.1.2 已正确区分 Node 24 v2
// (parentURL, { specifier, attributes }) 与 Node 22 v1 的位置参数。旧版
// patch-deps 误把两者统一成位置参数，导致 Node 24 把包名当 URL 后静默清空
// boot graph。这里只修复已经被旧补丁改坏的安装树；上游原始实现保持不动。
const CLIENT_MODULES_RESOLVE_TARGET = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'index.js');
const CLIENT_MODULES_RESOLVE_EXPECTED = 'internal.version === "v2" ? internal.resolveSync(baseUrl, {\n\t\t\t\tspecifier: loaderName,\n\t\t\t\tattributes: {}\n\t\t\t}).url : internal.resolveSync(loaderName, baseUrl, {}).url';
const CLIENT_MODULES_RESOLVE_REVERSED = 'internal.resolveSync(loaderName, baseUrl, {}).url';
const CLIENT_MODULES_RESOLVE_PARENT_FIRST = 'internal.resolveSync(baseUrl, loaderName, {}).url';

function patchClientModulesResolve(targetFile = CLIENT_MODULES_RESOLVE_TARGET): boolean {
  if (!fs.existsSync(targetFile)) {
    console.log('[patch-deps] dsh-client-modules 不存在，跳过');
    return false;
  }
  let src = fs.readFileSync(targetFile, 'utf8');
  if (src.includes(CLIENT_MODULES_RESOLVE_EXPECTED)) {
    console.log('[patch-deps] client-modules Node 22/24 解析签名正确，跳过');
    return false;
  }
  if (src.includes(CLIENT_MODULES_RESOLVE_REVERSED)) {
    src = src.replace(CLIENT_MODULES_RESOLVE_REVERSED, CLIENT_MODULES_RESOLVE_EXPECTED);
  } else if (src.includes(CLIENT_MODULES_RESOLVE_PARENT_FIRST)) {
    src = src.replace(CLIENT_MODULES_RESOLVE_PARENT_FIRST, CLIENT_MODULES_RESOLVE_EXPECTED);
  } else {
    console.log('[patch-deps] client-modules 解析签名锚点未命中（上游可能已更新），跳过');
    return false;
  }
  writeFileAtomic(targetFile, src);
  console.log('[patch-deps] 已恢复 client-modules Node 22/24 分支解析签名（boot graph 清零修复）');
  return true;
}

function main(): void {
  patchPickerWorker();
  patchSettingsNavScroll();
  patchSettingsPanelResize();
  patchSettingsWriteFailure();
  patchThemeWriteConverge();
  patchConfigEditorEditShortCircuit();
  patchAppBootReconcileGate();
  patchModelImageInputToggle();
  patchOptionalEscalationFields();
  patchAgentPresetMenu();
  patchMenuSubmenuScroll();
  patchClientModulesResolve();
}

// 单测 require 本模块时不应改写真实 node_modules；仅命令行直接执行时跑 main()。
if (require.main === module) {
  main();
}

module.exports = {
  patchAgentPresetMenu,
  patchMenuSubmenuScroll,
  patchClientModulesResolve,
  patchModelImageInputSource,
  patchModelImageInputToggle,
  patchSettingsWriteFailureSource,
  patchSettingsWriteFailure,
  patchThemeWriteConvergeSource,
  patchThemeWriteConverge,
  patchConfigEditorEditShortCircuitSource,
  patchConfigEditorEditShortCircuit,
  patchAppBootReconcileGateSource,
  patchAppBootReconcileGate,
};
