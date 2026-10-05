# README 维护记录

核查日期：2026-10-05（Asia/Shanghai）。本文件记录文档依据，不是产品运行验收报告。

## 核查基线

- 目标 fork：`says693/Deepseek-Harness-EAC`，`main@7b2628b97ca3d073c1f31e85bbfee856b64058d5`。
- 上游：`DSH-EAC/EAC-Desktop`，`main@0a628ae82a61204fac1253931e1c7035f2e90f97`。
- GitHub compare：fork ahead 1、behind 2；差异文件为 README.md。未将上游 CI 删除直接合并入本次文档改动。
- 上游最新正式 Release：`v6.0.0`，2026-10-04T07:40:20Z。
- 上游资产：full/lite 各有 Windows x64 Setup、portable，共四个包，加 `SHA256SUMS.txt`。
- fork 的 latest-release API 返回 404，因此首页下载统一指向上游。

## 关键事实与证据

| 文档内容 | 仓库事实源 | 核对结果 |
| --- | --- | --- |
| 产品版本 | [package.json](../dsh-desktop/package.json)、[Tauri 配置](../tauri-shell/tauri.conf.json) | 6.0.0 |
| 内核 | [package.json](../dsh-desktop/package.json) | 本地 tarball 固定到 0.2.0-rc.2 |
| 真正随包插件 | [stage-resources.mjs](../tauri-shell/stage-resources.mjs) 的 BUILTIN_PLUGIN_DIRS | 9 项，不能按资产目录或分发账本数作宣传 |
| 核心桥不随包 | 同上 | eac-core-bridge 资产仍在，但装配项已退役 |
| 推荐包状态 | [推荐 pack](../.sync/packs/desktop-recommended.pack.json) | draft，plugins 为空；intendedPluginIds 仅为规划 |
| 用户皮肤外迁 | [profile.ts](../dsh-desktop/lib/desktop/profile.ts)、stage-resources.mjs | UI_SKIN_PLATFORM_PACKAGES 为空，用户皮肤不再内置 |
| 壳工件 | [skin-manager-artifact.lock.json](../tauri-shell/skin-manager-artifact.lock.json) | manager 0.1.0-preview.1、system.default 2.0.0 固定工件，装配做摘要检查 |
| 数据环境 | [environment.ts](../dsh-desktop/lib/desktop/environment.ts)、[main.rs](../tauri-shell/src/main.rs)、[ADR 0004](adr/0004-eac-install-environment-isolation.md) | 正式启动注入产品数据根与通道，使用 DPX；旧宿主数据不自动迁移 |
| 环境边界 | 同上 | 默认路径收容，不是文件系统写入沙箱；初始化失败不回退宿主 |
| 构建工具链 | [安装包工作流](../.github/workflows/staged-runtime-artifact.yml) | Node 24、pnpm 11.7.0、Rust stable，先获取内核再 ci:install |
| 构建平台 | 同上 | Windows/Linux x64/arm64；不把矩阵当作已发布资产 |
| WebView2 | [Tauri 配置](../tauri-shell/tauri.conf.json) | downloadBootstrapper，不能承诺首次安装完全离线 |
| 最简本体边界 | [ADR 0006](adr/0006-minimal-core-scope.md) 当前状态索引 | 早期设计提案不能充当现行运行契约 |

## 首页移除的过时承诺

- 固定链接到 v4/v5/AIO 历史安装包、过期包大小和重复版本宣传。
- “默认内置 10 款皮肤”“48 个插件”“与 CLI 默认共享 ~/.dsh”。
- “便携程序目录必然带走全部数据”“全平台自动更新和回退一致”。
- 仓库中已不存在的目录与旧发布工作流说明。
- 首页巨型历史致谢表、旧组织徽章和带令牌参数的外部趋势图片。

历史插件作者和皮肤许可保留在 [ECOSYSTEM-CREDITS.md](ECOSYSTEM-CREDITS.md)，不作为当前功能清单。原有截图以明确的历史标签折叠展示。

## 后续维护规则

1. 发布资产从上游 Release API/页面核对，不由文件名模式猜测。
2. 随包清单先看装配脚本，再交叉核对运行时注册与分发账本。
3. 中文和英文首页一并维护，尤其是安装、路径与版本状态。
4. 本地 SVG 使用相对引用、原生 SVG 图形与文字；不包含脚本、外部字体、foreignObject 或网络资源。
5. 构建命令在本次文档任务中仅按源码核对，未执行应用构建或桌面运行验收。
