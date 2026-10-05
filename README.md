<div align="center">

<img src="docs/assets/eac-readme-hero.svg" alt="EAC：Tauri 桌面壳、Node 服务、官方 dsh 内核与 DPX 独立环境" width="920" />

# Deepseek Harness EAC

**让 Agent 工作在桌面，让扩展各就其位。**

Embracing All Creation · 揽尽万象

[下载上游发行版](https://github.com/DSH-EAC/EAC-Desktop/releases/latest) · [快速开始](#快速开始) · [功能与扩展](#功能与扩展) · [开发指南](#开发指南) · [English](README.en.md)

[![Upstream release](https://img.shields.io/github/v/release/DSH-EAC/EAC-Desktop?style=flat-square&label=upstream&color=427bbf)](https://github.com/DSH-EAC/EAC-Desktop/releases/latest)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-4d8d9a?style=flat-square)](tauri-shell/Cargo.toml)
[![License](https://img.shields.io/badge/license-MIT-628268?style=flat-square)](LICENSE)

</div>

EAC 将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 封装为桌面应用：准备运行时、启动本地 Web UI、管理窗口与进程，并为插件和皮肤提供接入边界。**v6 的方向是精简本体、独立环境与按需扩展。**

> **仓库关系**：这里是 [says693/Deepseek-Harness-EAC](https://github.com/says693/Deepseek-Harness-EAC)，上游为 [DSH-EAC/EAC-Desktop](https://github.com/DSH-EAC/EAC-Desktop)。下载入口指向上游发布页，不代表本 fork 单独发布了安装包。

## 先看当前状态

截至 **2026-10-05**，上游最新正式 Release 为 **v6.0.0**（2026-10-04 发布），其公开资产为 Windows x64 的 full / lite 安装包、便携包与校验清单。当前源码产品版本同为 6.0.0，固定 dsh 内核为 **0.2.0-rc.2**。

| 层面 | 当前事实 | 使用时的含义 |
| --- | --- | --- |
| 已发布安装包 | v6.0.0：Windows x64，full / lite 各有 Setup 和 portable | 下载文件以该 Release 资产为准 |
| 源码打包矩阵 | Windows、Linux 均有 x64 / arm64；Linux 配置 AppImage、deb、rpm | 构建配置不等于所有平台已经发布或通过本地验收 |
| macOS | 保留平台配置与实现；不在当前安装包工作流矩阵和 v6.0.0 资产中 | 不把历史 macOS 包当作当前版本下载入口 |
| 皮肤与推荐插件 | 用户皮肤改为市场可选；推荐 pack 清单仍标记 draft | 不再承诺默认内置旧版全部皮肤、桌宠与增强插件 |

详细事实源与修订依据见 [README 维护记录](docs/README-MAINTENANCE.md)。发布包是固定快照，main 后续变化不自动进入已下载的安装包。

## 快速开始

### 1. 选择下载包

到 [上游最新 Release](https://github.com/DSH-EAC/EAC-Desktop/releases/latest) 下载。以下是 **v6.0.0** 实际资产的命名，后续版本以发布页为准：

| 选择 | 文件 |
| --- | --- |
| Full 安装版 | `Deepseek-Harness-EAC-full-v6.0.0-Setup-x64.exe` |
| Full 便携版 | `Deepseek-Harness-EAC-full-v6.0.0-x64-portable.zip` |
| Lite 安装版 | `Deepseek-Harness-EAC-lite-v6.0.0-Setup-x64.exe` |
| Lite 便携版 | `Deepseek-Harness-EAC-lite-v6.0.0-x64-portable.zip` |
| 校验清单 | `SHA256SUMS.txt` |

Full / lite 是发布资产的版本形态；具体启用项以对应包和发布说明为准。不要据此推断旧版几十个插件仍全部内置。

安装版提供安装向导；便携版需先完整解压再启动。发行包带有 Node.js / npm 与 dsh 运行资源，普通使用无需自行安装 Node。Windows 的 Tauri 窗口需要 WebView2；当前安装配置使用下载引导方式处理该依赖，因此首次安装可能需要联网。调用云端模型也需要网络与对应账户凭据。

<details>
<summary>核对 Windows 下载文件的 SHA-256</summary>

```powershell
Get-FileHash .\Deepseek-Harness-EAC-full-v6.0.0-Setup-x64.exe -Algorithm SHA256
```

将结果与同一 Release 的 `SHA256SUMS.txt` 对照，确认文件名和完整哈希一致。

</details>

### 2. 完成第一次对话

1. 启动应用，等待桌面壳启动本地 dsh 服务并打开 Web UI。
2. 按界面配置模型提供商与 API Key；产品不会随包附送可用凭据。
3. 选择工作目录，发起一项小任务，再查看会话输出与文件变更。
4. 需要更多能力时进入插件市场，检查版本要求后按需安装、启用。

### 3. 找到自己的数据

正式 Tauri 启动会进入 **DPX 独立环境**，不能套用旧版“与命令行默认共享 `~/.dsh`”的说明。

```text
<产品数据根>/
└── dpx/dsh-environments/eac-<channel>/
    ├── .dpx-environment.json
    ├── dsh-home/                  # profile、会话、skills 与配置
    ├── home/
    ├── appdata/
    ├── localappdata/
    ├── tmp/
    └── workspace/
```

- Windows 默认产品数据根：`%LOCALAPPDATA%\Deepseek Harness EAC`；非 Windows 按平台数据目录推导。
- 发布通道由启动配置决定；环境名为 `eac-<channel>`。同一通道复用环境，不同通道分开存储。
- 旧宿主 `~/.dsh` 只做检测与提示，**不会自动迁移、删除或覆盖**。
- 备份时先退出应用，备份实际产品数据根与单独的项目目录；不要假设只复制便携版程序目录就包含所有数据。
- DPX 管理默认路径与环境变量，**不是文件系统沙箱**；显式绝对路径仍受操作系统权限控制。

路径细节见 [环境隔离决策](docs/adr/0004-eac-install-environment-isolation.md) 与 [当前实现](dsh-desktop/lib/desktop/environment.ts)。

## 功能与扩展

### 桌面本体

原生窗口、托盘、单实例与退出策略由 Tauri 壳管理；Node sidecar 负责启动 dsh、进程与服务编排、桌面 RPC 和环境初始化。应用把官方 Web UI 放进桌面工作流，而不是另写一套 Agent 内核。

### 当前随包装配的插件

下面列出 [资源装配脚本](tauri-shell/stage-resources.mjs) 中的 **9 个实际目录**。它们不是旧资产目录数量或历史插件账本的机械复制；功能是否启用仍取决于配置和所在发行包。

| 插件目录 | 作用 |
| --- | --- |
| `dsh-file-changes` | 会话文件变更的数据投影 |
| `dsh-client-file-changes` | 文件变更视图与还原入口 |
| `dsh-compact` | 请求路径上的上下文压缩与有限溢出恢复 |
| `dsh-easy-setup` | 快速配置、视觉模型与人设相关设置入口 |
| `dsh-unified-market` | 聚合插件目录与安装管理入口 |
| `dsh-plugin-shield` | 插件保护中心、快照、体检与回滚入口 |
| `dsh-eac-locale-compat` | 旧版及社区插件的英文界面兼容 |
| `dsh-viewport-lock` | 页面视口与滚动约束 |
| `dsh-settings-scroll-fix` | 设置面板滚轮与溢出滚动修复 |

### 按需扩展

插件分为 **builtin、recommended、external** 三类，见 [分发账本](.sync/plugin-distribution.json)。桌宠、多智能体、人设增强、视觉与界面增强等历史生态能力不能一概视为当前默认功能。

推荐集合 [desktop-recommended.pack.json](.sync/packs/desktop-recommended.pack.json) 目前是 **draft**，实际 `plugins` 数组为空；其中的 `intendedPluginIds` 表示计划成员，不是已经可以安装的整合包。社区包的可用性、兼容内核与许可要按具体包核对。

### 外观与皮肤

用户 Web UI 皮肤及加载器已外迁为市场可选包，未激活时保持宿主原生外观。壳层启动与恢复所需的 UI skin manager / `system.default` 工件仍由 [锁文件](tauri-shell/skin-manager-artifact.lock.json) 管理并在装配时校验 SHA-256；这与“预装一组可切换的用户皮肤”是两回事。

<details>
<summary>查看仓库保留的界面预览（历史截图，不作为 v6 默认外观承诺）</summary>

![仓库保留的历史界面截图](docs/screenshot-preview.jpg)

</details>

## 架构

![EAC 三层架构与 DPX 环境：Tauri 通过 RPC 驱动 sidecar，sidecar 在 DPX 环境中启动官方 dsh](docs/assets/eac-readme-architecture.svg)

| 层 | 责任 | 主要位置 |
| --- | --- | --- |
| L1 · Tauri / Rust | 窗口、托盘、单实例、生命周期与桌面集成 | [tauri-shell/src](tauri-shell/src) |
| L2 · Node / TypeScript | 启动、RPC、profile、插件与桌面服务编排 | [sidecar](tauri-shell/sidecar)、[lib/desktop](dsh-desktop/lib/desktop) |
| L3 · 官方 dsh | 对话、Agent、工具与 Web UI | [固定内核依赖](dsh-desktop/package.json) |
| DPX · 环境管理 | 环境身份、默认路径与运行时变量 | [dsh-dpx 子模块](third_party/dsh-dpx)、[适配层](dsh-desktop/lib/desktop/environment.ts) |

环境初始化失败会报错并退出启动流程，不切回宿主旧环境掩盖故障。架构历史中的“恢复中心”“插件进程隔离”不能直接当作当前接口承诺；有效边界以 [ADR 0006 的当前状态索引](docs/adr/0006-minimal-core-scope.md) 为准。

## 开发指南

### 准备源码与工具链

使用 Git、**Node.js 24**、**pnpm 11.7.0** 与 Rust stable。Windows 需要对应 Rust 目标的 C++ 构建工具；Linux 需要 WebKitGTK / Tauri 系统依赖。下面的命令对应仓库当前 [安装包工作流](.github/workflows/staged-runtime-artifact.yml)。

```sh
git clone --recurse-submodules https://github.com/says693/Deepseek-Harness-EAC.git
cd Deepseek-Harness-EAC
git submodule update --init --recursive
node tauri-shell/check-dpx-pin.mjs
npm install --global pnpm@11.7.0

cd dsh-desktop
node scripts/fetch-kernel.js
npm run ci:install
npm run typecheck
npm run build
npm run fetch-runtime
npm test
cd ..
```

必须先获取固定内核工件，再安装依赖；`package.json` 中的内核依赖指向本地 `vendor/kernel` tarball，跳过这一步会使依赖安装缺少输入。

### 装配与打包

Windows 在仓库根目录执行：

```sh
node tauri-shell/stage-resources.mjs --target=win32 --skip-npm
node dsh-desktop/scripts/verify-staged-runtime.mjs
cd tauri-shell
cargo fetch --locked
npx -y @tauri-apps/cli@2 build --verbose
```

Linux 把装配目标改为 `--target=linux`。当前 Ubuntu 22.04 工作流安装以下依赖，并在构建时设置 `APPIMAGE_EXTRACT_AND_RUN=1`：

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libfuse2 rpm
```

上述是安装包构建入口，便携包装配见 [make-portable.mjs](tauri-shell/make-portable.mjs) 与安装包工作流。源码构建需要网络获取依赖；“锁定工件装配”不等于整条构建链无需联网。

### 修改后如何验证

- 文档改动：校对来源、相对路径、章节锚点与 SVG 渲染。
- 插件改动：运行 `node scripts/plugin-ledger.mjs`、`node scripts/plugin-sync.mjs validate`（在 `dsh-desktop` 内），以及相关测试。
- 启动、桥接、环境和打包改动：按 [开发技能](.agents/skills/deepseek-harness-eac-dev/SKILL.md) 执行对应检查；类型检查不代替实际安装与启动验收。

贡献规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。上游近期调整了 CI 入口，勿依照历史文档假定某个发布工作流仍存在；以目标分支实际 [工作流目录](.github/workflows) 为准。

## 常见问题

**旧会话为什么没有自动出现？** 先确认当前 DPX 环境与通道。v6 正式启动不直接复用宿主 `~/.dsh`，旧数据仍留在原处。迁移前备份并核对内核、profile 和插件兼容性，避免整目录覆盖。

**为什么旧皮肤、桌宠或某个增强功能不见了？** v6 把默认装配与可选生态拆开了。检查市场与分发清单，不要按旧版 README 的内置数量判断安装是否损坏。

**启动失败时先做什么？** 保存错误信息和日志，记录版本、平台、full/lite、安装版/便携版以及发生步骤；环境诊断接口为 `environment.status`。不要先删除整个数据目录，`environment.remove` 的 purge 操作会涉及数据清理。

**如何升级？** 先查看对应 Release 说明，备份当前数据与项目，再使用适用的安装包。旧版客户端自动更新、Agent overlay 与自动回退说明不作为 v6 全平台统一承诺。

## 文档、社区与致谢

| 入口 | 内容 |
| --- | --- |
| [架构决策](docs/adr) | 分层、环境隔离、最小本体与插件分发 |
| [问题反馈](https://github.com/says693/Deepseek-Harness-EAC/issues) | 本 fork 的复现与改进建议 |
| [上游问题](https://github.com/DSH-EAC/EAC-Desktop/issues) | 上游产品的缺陷与功能讨论 |
| [上游贡献者](https://github.com/DSH-EAC/EAC-Desktop/graphs/contributors) | 桌面客户端与生态贡献 |
| [历史生态致谢](docs/ECOSYSTEM-CREDITS.md) | 原 README 的插件作者与皮肤来源记录 |

感谢 DeepSeek Harness、[dsh-dpx](https://github.com/T-Auto/dsh-dpx) 以及所有插件、皮肤、平台移植和文档贡献者。主项目使用 [MIT License](LICENSE)；第三方组件保留各自许可。历史皮肤中含 **CC BY-NC-SA 4.0** 内容，不能因本项目为 MIT 就统一视作可商用。

---

<div align="center"><sub>精简本体 · 独立环境 · 按需扩展</sub></div>
