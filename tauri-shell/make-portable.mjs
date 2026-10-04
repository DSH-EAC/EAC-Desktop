'use strict';
// Tauri 便携版装配（P4/R6）：把 release 构建产物打成 zip 分发包。
//
// 布局（= NSIS 安装树同构，resource_root() exe 同级解析）：
//   dsh-eac-shell.exe
//   .dsh-portable          ← 便携标记（client-updater isTauriPortable 判定）
//   sidecar/{server,bridge,rescue-integration}.js
//   dsh-desktop/<完整运行树>
//   ui-skin-manager/<皮肤管理器资源>
//   dpx/<pinned runtime isolation API>
//
// 用法：node make-portable.mjs [--out <dir>]
//   前置：tauri build 已完成（target/release/{dsh-eac-shell.exe, sidecar/, dsh-desktop/}）。
//   产物：Deepseek-Harness-EAC-<version>-portable.zip + SHA256SUMS.txt

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repo = path.resolve(shellDir, '..');
const rel = path.join(shellDir, 'target', 'release');
const version = JSON.parse(readFileSync(path.join(repo, 'dsh-desktop', 'package.json'), 'utf8')).version || '0.0.0';

const outArg = process.argv.indexOf('--out');
const outDir = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : path.join(rel, 'portable');

const exe = path.join(rel, 'dsh-eac-shell.exe');
for (const need of [exe, path.join(rel, 'sidecar', 'server.js'), path.join(rel, 'dsh-desktop', 'package.json'), path.join(rel, 'ui-skin-manager', 'resolved', 'system.default', 'snapshot.json'), path.join(rel, 'dpx', 'src', 'index.js')]) {
  if (!existsSync(need)) {
    console.error('[portable] 缺少构建产物: ' + need);
    console.error('[portable] 请先完成 tauri build（或 node stage-resources.mjs 后 cargo tauri build）');
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
const zipPath = path.join(outDir, `Deepseek-Harness-EAC-${version}-portable.zip`);
rmSync(zipPath, { force: true });

console.log('[portable] 装配暂存目录（zip 根 = 安装树同构，顶层无包裹目录）');
const staging = path.join(outDir, '.staging-portable');
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
copyFileSync(exe, path.join(staging, 'dsh-eac-shell.exe'));
writeFileSync(path.join(staging, '.dsh-portable'), '');
// WebView2Loader.dll：安装版由 tauri.windows.conf.json 把 staged-resources/ 里的
// 该文件映射到 exe 同级，便携 zip 补上以保持两形态产物面一致。实测壳 exe 已
// 静态链接 webview2（导入表无该 DLL），此文件属防御性冗余 —— 故为 best-effort：
// target/release 下存在才复制，缺失跳过（stage-resources 仅在 win32 且找到
// webview2-com-sys 时装配它，跨形态/旧缓存缺失属正常，不必 fail-fast）。
const webview2Loader = path.join(rel, 'WebView2Loader.dll');
if (existsSync(webview2Loader)) {
  copyFileSync(webview2Loader, path.join(staging, 'WebView2Loader.dll'));
  console.log('[portable] WebView2Loader.dll 已随包（与安装版产物面一致）');
}

// robocopy 退出码 0-7 均为成功语义（1=有文件复制）；execSync 对非零会抛，需容错。
function robocopy(src, dest) {
  let code = 0;
  try {
    execSync(`robocopy "${src}" "${dest}" /E /NFL /NDL /NJH /NJS /NP`, { stdio: ['ignore', 'ignore', 'ignore'], shell: 'cmd.exe' });
  } catch (e) {
    code = e.status == null ? 8 : e.status;
  }
  if (code >= 8) throw new Error(`robocopy 失败 (${code}): ${src} -> ${dest}`);
}

console.log('[portable] 复制 sidecar + dsh-desktop + ui-skin-manager（数万文件，耐心等）');
robocopy(path.join(rel, 'sidecar'), path.join(staging, 'sidecar'));
robocopy(path.join(rel, 'dsh-desktop'), path.join(staging, 'dsh-desktop'));
robocopy(path.join(rel, 'ui-skin-manager'), path.join(staging, 'ui-skin-manager'));
robocopy(path.join(rel, 'dpx'), path.join(staging, 'dpx'));

console.log('[portable] 压缩 zip（Compress-Archive，约 500MB 需几分钟）');
const psZip = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  'Compress-Archive -LiteralPath (Get-ChildItem -LiteralPath $env:P_STAGE | ForEach-Object { $_.FullName }) -DestinationPath $env:P_ZIP -Force',
  'Add-Type -AssemblyName System.IO.Compression.FileSystem',
  '$archive = [System.IO.Compression.ZipFile]::OpenRead($env:P_ZIP)',
  "try { if (-not ($archive.Entries | Where-Object { $_.FullName.Replace([char]92, [char]47) -eq 'ui-skin-manager/resolved/system.default/snapshot.json' })) { throw 'Portable ZIP is missing the skin manager snapshot' } } finally { $archive.Dispose() }",
].join('; ');
execSync('powershell -NoProfile -Command "' + psZip.replace(/"/g, '\\"') + '"', {
  env: { ...process.env, P_STAGE: staging, P_ZIP: zipPath },
  stdio: 'inherit',
});

console.log('[portable] 计算 SHA256');
const hash = createHash('sha256');
hash.update(readFileSync(zipPath));
const sha256 = hash.digest('hex').toUpperCase();
writeFileSync(path.join(outDir, 'SHA256SUMS.txt'), `${sha256}  ${path.basename(zipPath)}\n`);

console.log('[portable] 清理暂存');
rmSync(staging, { recursive: true, force: true });

const mb = (statSync(zipPath).size / 1048576).toFixed(1);
console.log(`[portable] 完成: ${zipPath} (${mb} MB)`);
console.log(`[portable] SHA256: ${sha256}`);
