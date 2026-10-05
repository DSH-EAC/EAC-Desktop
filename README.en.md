<div align="center">

<img src="docs/assets/eac-readme-hero.svg" alt="EAC: Tauri desktop shell, Node services, official dsh kernel and DPX environments" width="920" />

# Deepseek Harness EAC

**Bring your agent to the desktop. Extend it on your terms.**

Embracing All Creation · 揽尽万象

[Download upstream release](https://github.com/DSH-EAC/EAC-Desktop/releases/latest) · [Quick start](#quick-start) · [Features](#features-and-extensions) · [Development](#development) · [中文](README.md)

[![Upstream release](https://img.shields.io/github/v/release/DSH-EAC/EAC-Desktop?style=flat-square&label=upstream&color=427bbf)](https://github.com/DSH-EAC/EAC-Desktop/releases/latest)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-4d8d9a?style=flat-square)](tauri-shell/Cargo.toml)
[![License](https://img.shields.io/badge/license-MIT-628268?style=flat-square)](LICENSE)

</div>

EAC packages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) as a desktop application. It prepares the runtime, launches the local Web UI, manages windows and processes, and provides integration boundaries for extensions. **v6 focuses on a minimal core, separate environments and optional packages.**

> **Repository relationship:** this is [says693/Deepseek-Harness-EAC](https://github.com/says693/Deepseek-Harness-EAC), a fork of [DSH-EAC/EAC-Desktop](https://github.com/DSH-EAC/EAC-Desktop). Download links point to upstream releases; they do not imply that this fork publishes its own binaries.

## Current status

Verified on **October 5, 2026**: the latest upstream stable release is **v6.0.0**, published October 4, 2026. Its public assets are Windows x64 full/lite installers and portable archives, plus checksums. The source product version is also 6.0.0; the pinned dsh kernel is **0.2.0-rc.2**.

| Area | Verified state | What it means |
| --- | --- | --- |
| Published binaries | Windows x64, full/lite Setup and portable assets | Download the files actually listed on the release |
| Packaging configuration | Windows and Linux x64/arm64; AppImage, deb and rpm for Linux | A build target is not proof of a published or locally validated binary |
| macOS | Platform code/configuration remain; absent from the current installer workflow matrix and v6.0.0 assets | Historical macOS downloads are not current release downloads |
| Skins and recommended plugins | User skins are market packages; the recommended pack remains a draft | The old collection of bundled skins and optional plugins is not a v6 default promise |

See [README maintenance notes](docs/README-MAINTENANCE.md) for source references. A release is a fixed snapshot; later main-branch changes do not appear automatically in downloaded binaries.

## Quick start

### 1. Choose a package

Visit the [latest upstream release](https://github.com/DSH-EAC/EAC-Desktop/releases/latest). These filenames are verified for **v6.0.0**; use the release page for future versions.

| Package | Filename |
| --- | --- |
| Full installer | `Deepseek-Harness-EAC-full-v6.0.0-Setup-x64.exe` |
| Full portable | `Deepseek-Harness-EAC-full-v6.0.0-x64-portable.zip` |
| Lite installer | `Deepseek-Harness-EAC-lite-v6.0.0-Setup-x64.exe` |
| Lite portable | `Deepseek-Harness-EAC-lite-v6.0.0-x64-portable.zip` |
| Checksums | `SHA256SUMS.txt` |

Full/lite describe release variants. Consult the corresponding package and release notes for enabled features; neither name proves that all historical plugins are still bundled.

Run the installer, or fully extract the portable archive before launching. Distributed packages include Node.js, npm and dsh resources, so end users do not need a separate Node installation. Windows requires WebView2; the current installer uses a download bootstrapper, so first-time setup may require network access. Cloud model requests also require connectivity and provider credentials.

<details>
<summary>Verify a Windows download</summary>

```powershell
Get-FileHash .\Deepseek-Harness-EAC-full-v6.0.0-Setup-x64.exe -Algorithm SHA256
```

Compare the full hash and filename against `SHA256SUMS.txt` from the same release.

</details>

### 2. Complete your first conversation

1. Launch the application and wait for the local dsh service and Web UI.
2. Configure your model provider and API key. Working credentials are not bundled.
3. Select a workspace, run a small task, and inspect the conversation and file changes.
4. Install and enable additional plugins through the market after checking compatibility.

### 3. Locate your data

Production Tauri startup uses a **separate DPX environment**. The old claim that desktop automatically shares the CLI's `~/.dsh` no longer describes this path.

```text
<product-data-root>/
└── dpx/dsh-environments/eac-<channel>/
    ├── .dpx-environment.json
    ├── dsh-home/                  # profiles, sessions, skills and configuration
    ├── home/
    ├── appdata/
    ├── localappdata/
    ├── tmp/
    └── workspace/
```

- Windows defaults to `%LOCALAPPDATA%\Deepseek Harness EAC`; other platforms derive their platform data directory.
- Startup configuration selects the channel. Environments are named `eac-<channel>` and reused within that channel.
- Existing host `~/.dsh` data is detected and reported, **not automatically migrated, deleted or overwritten**.
- Quit the application before backing up its actual product data root and separate project directories. Copying portable application files alone does not guarantee a complete data backup.
- DPX redirects default paths and environment variables. **It is not a filesystem sandbox**; explicit absolute paths remain governed by operating-system permissions.

See the [environment isolation ADR](docs/adr/0004-eac-install-environment-isolation.md) and [implementation](dsh-desktop/lib/desktop/environment.ts).

## Features and extensions

### Desktop core

Tauri manages native windows, the tray, single-instance behavior and exit policy. The Node sidecar handles dsh startup, process/service coordination, desktop RPC and environment initialization. EAC brings the official Web UI into a desktop workflow without implementing a second agent kernel.

### Plugins currently staged

The [resource staging script](tauri-shell/stage-resources.mjs) includes these **nine plugin directories**. This is the actual staging list, not a count of historical assets or ledger entries. Activation still depends on configuration and the release variant.

| Directory | Purpose |
| --- | --- |
| `dsh-file-changes` | Session file-change projection |
| `dsh-client-file-changes` | File-change view and restore controls |
| `dsh-compact` | Request-path context compaction and bounded overflow recovery |
| `dsh-easy-setup` | Quick setup, vision-model and persona settings |
| `dsh-unified-market` | Aggregated plugin catalog and installation management |
| `dsh-plugin-shield` | Plugin protection, snapshots, health checks and rollback controls |
| `dsh-eac-locale-compat` | English UI compatibility for older/community plugins |
| `dsh-viewport-lock` | Viewport and scrolling constraints |
| `dsh-settings-scroll-fix` | Settings-panel wheel and overflow scrolling fixes |

### Optional extensions

The [distribution ledger](.sync/plugin-distribution.json) separates **builtin**, **recommended** and **external** packages. Historical desktop pets, multi-agent tools, persona enhancements, vision tools and UI extensions should not all be treated as current default features.

The [recommended pack manifest](.sync/packs/desktop-recommended.pack.json) is currently **draft**, with an empty `plugins` array. Its `intendedPluginIds` are planned members, not an installable released pack. Check each community package's availability, kernel compatibility and license separately.

### Appearance and skins

User-facing Web UI skins and their loader have moved to optional market packages. Without an activated skin, the host retains its native appearance. Shell boot/recovery assets for the UI skin manager and `system.default` remain pinned by the [artifact lock](tauri-shell/skin-manager-artifact.lock.json), with SHA-256 checks during staging. These shell assets are distinct from a preinstalled gallery of user-selectable skins.

<details>
<summary>Repository screenshot — historical reference, not a promise of the v6 default appearance</summary>

![Historical interface screenshot retained by the repository](docs/screenshot-preview.jpg)

</details>

## Architecture

![Tauri drives the Node sidecar through RPC; the sidecar launches official dsh within a DPX environment](docs/assets/eac-readme-architecture.svg)

| Layer | Responsibility | Source |
| --- | --- | --- |
| L1 · Tauri / Rust | Windows, tray, single instance, lifecycle and native integration | [tauri-shell/src](tauri-shell/src) |
| L2 · Node / TypeScript | Boot, RPC, profiles, plugins and desktop service coordination | [sidecar](tauri-shell/sidecar), [lib/desktop](dsh-desktop/lib/desktop) |
| L3 · Official dsh | Conversations, agents, tools and Web UI | [Pinned dependencies](dsh-desktop/package.json) |
| DPX · Environment management | Environment identity, default paths and runtime variables | [dsh-dpx submodule](third_party/dsh-dpx), [adapter](dsh-desktop/lib/desktop/environment.ts) |

Environment initialization errors stop startup instead of silently switching to the host's old environment. Historical recovery-center and plugin process-isolation designs are not current API promises; read the [current-state index in ADR 0006](docs/adr/0006-minimal-core-scope.md).

## Development

### Prepare the source and toolchain

Use Git, **Node.js 24**, **pnpm 11.7.0**, and Rust stable. Windows needs C++ build tools for the Rust target; Linux needs the Tauri/WebKitGTK system dependencies. These commands follow the repository's current [installer workflow](.github/workflows/staged-runtime-artifact.yml).

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

Fetch the pinned kernel before installing dependencies: kernel dependencies refer to local tarballs under `vendor/kernel`.

### Stage and package

For Windows, from the repository root:

```sh
node tauri-shell/stage-resources.mjs --target=win32 --skip-npm
node dsh-desktop/scripts/verify-staged-runtime.mjs
cd tauri-shell
cargo fetch --locked
npx -y @tauri-apps/cli@2 build --verbose
```

On Linux, use `--target=linux`. The Ubuntu 22.04 packaging workflow installs the following dependencies and sets `APPIMAGE_EXTRACT_AND_RUN=1` for the build:

```sh
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libfuse2 rpm
```

For portable packaging, consult [make-portable.mjs](tauri-shell/make-portable.mjs) and the installer workflow. Building from source downloads dependencies; pinned offline staging does not mean the entire build works without a network.

### Validate changes

- Documentation: verify sources, relative links, section anchors and SVG rendering.
- Plugins: run `node scripts/plugin-ledger.mjs`, `node scripts/plugin-sync.mjs validate` from `dsh-desktop`, and relevant tests.
- Startup, bridge, environment or packaging: follow the required verification level in the [development skill](.agents/skills/deepseek-harness-eac-dev/SKILL.md). Type checks do not replace real installation/startup validation.

See [CONTRIBUTING.md](CONTRIBUTING.md). Upstream recently changed CI entry points; use the target branch's actual [workflow directory](.github/workflows), not historical release-workflow names.

## Frequently asked questions

**Where are my old conversations?** Check the active DPX environment and channel first. Production v6 startup does not automatically reuse host `~/.dsh`; old data remains in place. Back it up and check kernel/profile/plugin compatibility before migrating, rather than overwriting the entire new environment.

**Why is an old skin, pet or extension missing?** v6 separates default staging from optional packages. Check the market and distribution manifest; historical bundled counts are not an installation-health test.

**What should I do after a startup error?** Keep the error and logs, and record the version, platform, full/lite variant, installer/portable format and reproduction steps. `environment.status` is the diagnostic interface. Avoid deleting the whole data directory first; `environment.remove` with purge involves data removal.

**How should I upgrade?** Read the applicable release notes, back up data and projects, and use the matching package. Historical client auto-update, agent overlay and automatic rollback descriptions are not a uniform v6 promise across platforms.

## Documentation, community and credits

| Resource | Purpose |
| --- | --- |
| [Architecture decisions](docs/adr) | Layering, isolation, minimal core and distribution |
| [Fork issues](https://github.com/says693/Deepseek-Harness-EAC/issues) | Reproduction reports and improvements for this fork |
| [Upstream issues](https://github.com/DSH-EAC/EAC-Desktop/issues) | Upstream product bugs and feature discussion |
| [Upstream contributors](https://github.com/DSH-EAC/EAC-Desktop/graphs/contributors) | Desktop and ecosystem contributors |
| [Historical ecosystem credits](docs/ECOSYSTEM-CREDITS.md) | Plugin authors and skin attribution retained from the old README |

Thanks to DeepSeek Harness, [dsh-dpx](https://github.com/T-Auto/dsh-dpx), and every plugin, skin, platform and documentation contributor. The project uses the [MIT License](LICENSE); third-party components retain their own licenses. Historical skins include **CC BY-NC-SA 4.0** content, so the project's MIT license does not grant blanket commercial-use rights to those assets.

---

<div align="center"><sub>Minimal core · Separate environments · Optional extensions</sub></div>
