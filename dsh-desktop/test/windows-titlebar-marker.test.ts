import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

// 覆盖空洞回归门（v6 外壳迁移遗漏）：
//
// 内核给 Windows 自绘标题栏打标记的唯一实现是
// apps/desktop/src/preload-windows.ts 的 mark()（Electron preload）。v6 换
// Tauri 外壳后 Electron 整条链不再随包分发，Tauri 侧若不同等注入，内核所有
// `[data-windows-titlebar]` 规则与 `--dsh-windows-titlebar-height` 会静默落空。
//
// 内核 frame 已负责标题栏留白；壳层必须取消钉版皮肤的 body padding，
// 否则内容与 resize handle 多下移 36px。真实浏览器的几何与主题回归
// 见 shell-ui-compat.test.ts，本文件只锁定 document-start 注入契约。
//
// 内核的 preload-windows.client.spec.ts 只覆盖 Electron 实现，覆盖不到 Tauri
// 真实运行路径，因此这里锚定壳层注入脚本的契约。
const root = join(fileURLToPath(import.meta.url), '..', '..');
const mainRs = readFileSync(
  join(root, '..', 'tauri-shell', 'src', 'main.rs'),
  'utf8',
);

test('Tauri 注入脚本补回 Windows 自绘标题栏标记（内核 preload-windows.ts 契约）', () => {
  // 1) 标记生成函数存在，且写入内核识别的确切属性名。
  assert.match(
    mainRs,
    /fn windows_titlebar_marker_js\(\) -> String \{/,
    '缺少 windows_titlebar_marker_js() 生成函数',
  );
  assert.match(
    mainRs,
    /setAttribute\('data-windows-titlebar',''\)/,
    '标记必须写入内核读取的属性名 data-windows-titlebar',
  );

  // 2) 高度变量必须一并写入：只设属性不设变量时，内核依赖
  //    var(--dsh-windows-titlebar-height) 的 calc() 仍为 0，内容区依旧塌陷。
  assert.match(
    mainRs,
    /setProperty\('--dsh-windows-titlebar-height',h\)/,
    '必须同写 --dsh-windows-titlebar-height',
  );

  // 3) 高度值必须与壳层自绘栏高度一致。壳层 BAR_HEIGHT = 36
  //    （sidecar/bridge.ts），不是内核 Electron 版的 WINDOWS_TITLEBAR_HEIGHT=40；
  //    写错会让内核多预留 4px。
  assert.match(
    mainRs,
    /const TITLE_BAR_HEIGHT_PX: u32 = 36;/,
    '标题栏高度必须为 36，与 bridge.ts 的 BAR_HEIGHT 对齐',
  );

  // 4) 平台门控：与 preload-windows.ts 的 `process.platform !== 'win32'` 同语义，
  //    否则 macOS/Linux 会被带进 Windows 布局分支。
  assert.match(
    mainRs,
    /navigator\.platform\.indexOf\('Win'\)===0/,
    '标记必须仅 Windows 生效',
  );

  // 5) documentElement 未就绪时要有兜底（初始化脚本在 document-start 执行，
  //    此时 documentElement 可能尚不存在；preload-windows.ts 有同款判断）。
  assert.match(
    mainRs,
    /if\(!d\(\)\)\{/,
    'documentElement 缺失时必须有重试兜底',
  );
});

test('壳层让内核统一预留标题栏空间，取消重复的 body 留白', () => {
  assert.match(mainRs, /body\{\{padding-top:0 !important/,
    '钉版皮肤的 body padding 必须取消，否则与内核 frame 重复预留');
  assert.match(mainRs, /height:100% !important;max-height:100% !important/,
    'frame 必须占满视口，再由内核内部扣除标题栏空间');
  assert.match(mainRs, /\[data-dsh-title-bar-height\]\[data-windows-titlebar\]/,
    '布局覆盖只用于拥有内核 Windows 标题栏契约的壳页面');
  assert.match(mainRs, /\[data-control-name=\\?"session-root\\?"\]>\[class\*=frame\]/,
    'frame 选择器不得依赖 CSS-modules 哈希');
  assert.match(mainRs, /if\(!document\.getElementById\('\{style_id\}'\)\)/,
    '样式注入必须按 id 幂等');
});

test('标记与高度补偿在 bridge_init_script 的每次导航生效（与端口同段）', () => {
  const body = mainRs.slice(mainRs.indexOf('fn bridge_init_script'));
  // 标记与 __DSH_BRIDGE_WS__ 写在同一个 format! 串里：两者都必须在每次
  // 导航的 document-start 注入，不能只在 /loading 页面 HTML 里出现。
  assert.match(
    body,
    /\{\}\\nwindow\.__DSH_BRIDGE_WS__=/,
    '标记必须与端口注入同段，保证主窗导航到真实 Web UI 后依然生效',
  );
  assert.match(body, /windows_titlebar_marker_js\(\),/);
});

test('壳层不再依赖 Electron preload 提供该标记', () => {
  // 交付运行时里不得再出现 Electron —— 若哪天回归，说明标记可以改回内核侧
  // 实现，本门禁应随之调整。锚定 Cargo 依赖而非产物目录，避免测试依赖
  // stage-resources 是否已装配。
  const cargoToml = readFileSync(
    join(root, '..', 'tauri-shell', 'Cargo.toml'),
    'utf8',
  );
  assert.doesNotMatch(
    cargoToml,
    /electron/i,
    'Tauri 外壳不应再依赖 Electron；若引入，请复核标题栏标记的归属',
  );
});
