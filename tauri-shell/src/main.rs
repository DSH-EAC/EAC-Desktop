// release 构建隐藏控制台：release 的 exe 为 windows 子系统，双击启动不再弹出
// 标题为 exe 路径的命令行窗口（debug 保留控制台便于看 eprintln 诊断）。
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

// Deepseek Harness EAC — Tauri ShellHost（ADR 0002 L1；P2 GUI 主链路）
//
// 运行模式：
//   dsh-eac-shell               → 窗口 + 托盘 + sidecar 常驻 + WS 桥 + boot.start
//   dsh-eac-shell --bridge-test → 无 GUI，stdio JSON-RPC 驱动 server.js 冒烟
//
// 架构对应（docs/adr/0002）：
//   Rust 本体    = L1（窗口/托盘/WS 回环桥/生命周期/导航编排/壳层方法拦截）
//   Node sidecar = L2（tauri-shell/sidecar/server.js + bridge.js：挂载
//                  lib/desktop/* 全部模块 + boot-server 服务编排 + 桥方法面）
//   dsh 内核     = L3（零改动）
//
// 启动序列：
//   1. spawn sidecar（stdio JSON-RPC）+ 绑定 127.0.0.1:19873（WS + HTTP 同端口）
//   2. 主窗先加载壳层加载页 /loading（即起即见，initialization_script 注入桥）
//   3. boot.start → sidecar 拉起 dsh web（稳定端口 + 受限端口重试 + 探针竞争）
//   4. webUrl 回传 → 主窗导航到真实 Web UI
//   5. boot.web-ready（原地重启）→ 重新导航；boot.server-died → /died 页
//
// WS 桥（127.0.0.1:19873）方法分流：
//   壳层本地拦截（本文件 handle_shell_method）：
//     win.minimize / win.toggle-maximize / win.close / win.is-maximized /
//     win.start-dragging（send）/ win.viewport-beat（send，视口失同步自愈）/
//     win.maximized（通知推送）
//     menu.action 的纯壳动作（reload / devtools / fullscreen / quit / open-browser）
//     log.page-error（send，壳层记录）
//     directory.pick（SYNC-004，原生目录选择对话框 → 绝对路径 | null）
//   其余 → sidecar（chrome.init / service.restart / boot.* / P3 渐进收编面）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock};

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as ABufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex as AMutex};
use tokio_tungstenite::tungstenite::Message;

const BRIDGE_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/bridge-bundle.js"));
const WS_PORT: u16 = 19873;

// 安装环境隔离（ADR 0004）：产品数据根名 + 默认发布通道。
const EAC_PRODUCT_NAME: &str = "Deepseek Harness EAC";
const DEFAULT_EAC_CHANNEL: &str = "beta";

// The manager path is the v6 default. DSH_UI_SKIN_MANAGER_ROLLBACK is a
// one-release emergency switch for operators; it only selects the embedded fallback
// recovery styles and never restores the removed EAC source tree.
const SKIN_MANAGER_LOCK: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/skin-manager-artifact.lock.json"
));
static CHINESE_UI: OnceLock<bool> = OnceLock::new();

// 桥端口回退：19873 被占（他程序占用/异常残留监听）时向上探测 25 个候选，
// 全失败退回 OS 分配（端口 0）。实际端口必须先于任何窗口 URL 定稿
//（loading/died 与主窗口都指向这里），故绑定挪到 setup 任务最前面。
// 页面侧注入的 __DSH_BRIDGE_WS__ 恒为 ws_port()；ws-jsonrpc-client.js 里的
// 19873 仅为无注入环境的兜底默认值，不与本机制耦合。
static WS_PORT_EFFECTIVE: AtomicU16 = AtomicU16::new(WS_PORT);
static PACKAGED_RESOURCE_ROOT: OnceLock<PathBuf> = OnceLock::new();

fn ws_port() -> u16 {
    WS_PORT_EFFECTIVE.load(Ordering::SeqCst)
}

/// Windows 内核布局为自绘标题栏预留一次空间。内核 frame 的 padding、
/// resize handle 和 overlay 共同读取 `--dsh-windows-titlebar-height`。
/// 钉版皮肤另给 body 加了 36px padding，不能与这套布局同时生效：否则
/// 内容和 resize handle 都从 y=72 开始，而壳栏实际只占 y=0..36。
/// 壳层覆盖自己的 body 补偿，让内核统一管理内容区；不修改钉版皮肤。
const TITLE_BAR_HEIGHT_PX: u32 = 36;

/// 壳层自有样式表 id：补偿规则与标记同源，便于排查与幂等。
const TITLE_BAR_STYLE_ID: &str = "__dsh_title_bar_fix__";

/// Windows 自绘标题栏标记 + 布局补偿（内核 preload-windows.ts 的 mark() 同语义）。
///
/// 必须与端口注入写在同一次 document-start 注入里：主窗会从壳层 /loading
/// 导航到内核 Web UI，页面上下文重建后属性与样式都不能丢。
fn windows_titlebar_marker_js() -> String {
    format!(
        "if(navigator.platform.indexOf('Win')===0){{\
var h='{height}px';\
var d=function(){{var r=document.documentElement;\
if(!r)return false;\
r.setAttribute('data-windows-titlebar','');\
r.style.setProperty('--dsh-windows-titlebar-height',h);\
r.setAttribute('data-dsh-title-bar-height','{height}');\
r.style.setProperty('--dsh-title-bar-height',h);\
if(!document.getElementById('{style_id}')){{var s=document.createElement('style');\
s.id='{style_id}';\
s.textContent='html[data-dsh-title-bar-height][data-windows-titlebar] body{{padding-top:0 !important}}html[data-dsh-title-bar-height][data-windows-titlebar] [data-control-name=\"session-root\"]>[class*=frame]{{height:100% !important;max-height:100% !important}}';\
(document.head||r).appendChild(s)}}\
return true}};\
if(!d()){{if(document.readyState==='loading'){{document.addEventListener('DOMContentLoaded',d,{{once:true}})}}else{{document.addEventListener('readystatechange',function h(){{if(d()){{document.removeEventListener('readystatechange',h)}}}})}}}}}}",
        height = TITLE_BAR_HEIGHT_PX,
        style_id = TITLE_BAR_STYLE_ID,
    )
}

/// 生成带实际桥端口的 WebView 初始化脚本。
///
/// 主窗首屏 /loading 会通过页面 HTML 注入端口，但导航到真实 Web UI
/// 后页面上下文会重建；仅注入裸 BRIDGE_JS 会让客户端退回固定的
/// 19873，端口发生回退时窗口控制全部失效。标记同样必须在每次导航的
/// document-start 注入，故与端口写在同一段初始化脚本里。
fn bridge_init_script() -> String {
    let manager_active = ui_skin_manager_snapshot().is_some();
    let skin_css = if manager_active {
        "\"\"".to_string()
    } else {
        serde_json::to_string(&ui_skin_css_bundle()).unwrap_or_else(|_| "\"\"".to_string())
    };
    let manager = ui_skin_manager_bootstrap_json();
    format!(
        "{}\nwindow.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';\n{}window.__DSH_UI_SKIN_CSS__={};\nwindow.__DSH_UI_SKIN_MANAGER__={};\n{}",
        windows_titlebar_marker_js(),
        ws_port(),
        shell_invoke_bridge_js(),
        skin_css,
        manager,
        BRIDGE_JS,
    )
}

/// 壳层页面专用的 `invoke` 绑定（`window.dshShell.invoke`）。
///
/// 为什么需要它：`/died` 页要调 L1 的 `diagnose_environment` /
/// `repair_environment` 做环境自愈，但 Tauri 的 `window.__TAURI__` 只在启用
/// `app.withGlobalTauri` 时才存在 —— 而本壳**刻意不开**它。
///
/// 底层 IPC `window.__TAURI_INTERNALS__.invoke` 是**无条件注入**的
///（tauri manager/webview.rs 的 main_frame_script，与 withGlobalTauri 无关），
/// 所以这里只做一层薄包装。
///
/// **真实边界（勿误读）**：注入发生在同一个 `main` 窗口的 initialization_script，
/// 而内核 Web UI 也是在这个窗口里 `win.navigate` 过去的 —— 因此内核页面
/// **同样能看到 `window.dshShell`**。它的实际收益只是：
///   1. 比开 `withGlobalTauri` 少暴露整个 `__TAURI__` 命名空间（面更小）；
///   2. 真正拦住内核页面的是 **ACL**：`capabilities/default.json` 的
///      `remote.urls` 只授权壳桥的 origin（`http://127.0.0.1:<壳桥端口>/*`），
///      内核 UI 在**另一个端口**上，origin 不匹配 → 拿不到任何 `allow-*` 权限。
/// 即：**安全边界靠 ACL 的 origin 匹配，不靠「注入给谁」**。若要进一步收紧，
/// 应改为按 URL 注入（Tauri 支持按导航注入），而非依赖命名空间大小。
fn shell_invoke_bridge_js() -> &'static str {
    "window.dshShell=window.dshShell||{};\
     window.dshShell.invoke=function(cmd,args){\
       var t=window.__TAURI_INTERNALS__;\
       if(!t||typeof t.invoke!=='function'){\
         return Promise.reject(new Error('shell invoke unavailable: __TAURI_INTERNALS__ missing'));\
       }\
       return t.invoke(cmd,args||{});\
     };\n"
}

fn locale_tag_is_chinese(tag: &str) -> bool {
    tag.trim()
        .split(['-', '_'])
        .next()
        .is_some_and(|primary| primary.eq_ignore_ascii_case("zh"))
}

#[cfg(windows)]
fn detect_chinese_ui_language() -> bool {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    let mut locale = [0u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(locale.as_mut_ptr(), locale.len() as i32) };
    if len <= 1 {
        return false;
    }
    locale_tag_is_chinese(&String::from_utf16_lossy(&locale[..len as usize - 1]))
}

#[cfg(not(windows))]
fn detect_chinese_ui_language() -> bool {
    ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .flat_map(|value| value.split(':').map(str::to_owned).collect::<Vec<_>>())
        .any(|tag| locale_tag_is_chinese(tag.split('.').next().unwrap_or(&tag)))
}

fn use_chinese_ui() -> bool {
    *CHINESE_UI.get_or_init(detect_chinese_ui_language)
}

fn ui_text<'a>(zh: &'a str, en: &'a str) -> &'a str {
    if use_chinese_ui() {
        zh
    } else {
        en
    }
}

#[cfg(test)]
mod shell_tests {
    use super::{
        is_sidecar_respawn_request, locale_tag_is_chinese, locale_tag_is_well_formed,
        shell_http_status, ui_skin_asset, ui_skin_manager_enabled, ui_skin_manager_snapshot,
        verified_resource_root, WS_PORT,
    };
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static SKIN_MANAGER_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn recognizes_chinese_locale_variants_only() {
        assert!(locale_tag_is_chinese("zh-CN"));
        assert!(locale_tag_is_chinese("zh_Hant_TW"));
        assert!(!locale_tag_is_chinese("en-US"));
        assert!(!locale_tag_is_chinese("ja-JP"));
        assert!(!locale_tag_is_chinese(""));
    }

    #[test]
    fn locale_tag_gate_matches_official_id_pattern() {
        // 官方 LOCALE_ID_PATTERN：^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$。
        assert!(locale_tag_is_well_formed("zh"));
        assert!(locale_tag_is_well_formed("en"));
        assert!(locale_tag_is_well_formed("zh-CN"));
        assert!(locale_tag_is_well_formed("zh-Hant-TW"));
        assert!(!locale_tag_is_well_formed("z")); // 主段过短
        assert!(!locale_tag_is_well_formed("chineseee")); // 主段 9 > 8
        assert!(!locale_tag_is_well_formed("zh_ CN")); // 非法字符
        assert!(!locale_tag_is_well_formed(""));
        assert!(!locale_tag_is_well_formed("zh_CN")); // 下划线不是分隔符
        assert!(locale_tag_is_well_formed("zh-C")); // 子段 1-8 位均合法（含 1）
        assert!(!locale_tag_is_well_formed("zh-CNbbbbbbbbb")); // 子段 >8
    }

    #[test]
    fn resource_root_is_canonical_and_complete() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("dsh-resource-root-{}-{nonce}", std::process::id()));
        fs::create_dir_all(root.join("sidecar")).expect("create sidecar fixture");
        fs::create_dir_all(root.join("dsh-desktop")).expect("create desktop fixture");
        fs::write(root.join("sidecar").join("server.js"), "").expect("write sidecar fixture");

        let verified = verified_resource_root(&root).expect("valid resource root");
        assert!(verified.is_absolute());
        assert_eq!(verified.file_name(), root.file_name());
        #[cfg(windows)]
        assert!(!verified.to_string_lossy().starts_with(r"\\?\"));

        fs::remove_file(root.join("sidecar").join("server.js")).expect("remove sidecar fixture");
        assert!(verified_resource_root(&root).is_none());
        fs::remove_dir_all(root).expect("remove resource fixture");
    }

    #[test]
    fn only_boot_start_can_respawn_sidecar() {
        assert!(is_sidecar_respawn_request("boot.start"));
        assert!(!is_sidecar_respawn_request("rescue.safe-mode"));
        assert!(!is_sidecar_respawn_request("chrome.init"));
        assert!(!is_sidecar_respawn_request("plugins.list"));
    }

    #[test]
    fn manager_is_enabled_by_default_and_rollback_selects_embedded_fallback() {
        let _env_lock = SKIN_MANAGER_ENV_LOCK.lock().expect("skin manager env lock");
        std::env::remove_var("DSH_UI_SKIN_MANAGER");
        std::env::remove_var("DSH_UI_SKIN_MANAGER_ROLLBACK");
        assert!(ui_skin_manager_enabled());
        let snapshot = ui_skin_manager_snapshot().expect("pinned snapshot");
        assert_eq!(snapshot.package, "system.default");
        assert_eq!(snapshot.generation, 1);
        assert_eq!(snapshot.assets["control/layout.css"], "control-layout.css");
        std::env::set_var("DSH_UI_SKIN_MANAGER_ROLLBACK", "1");
        assert!(!ui_skin_manager_enabled());
        assert!(ui_skin_asset("style/tokens.css").contains("--eac-shell"));
        std::env::remove_var("DSH_UI_SKIN_MANAGER_ROLLBACK");
    }

    #[test]
    fn manager_snapshot_rejects_unknown_or_unsafe_assets() {
        let _env_lock = SKIN_MANAGER_ENV_LOCK.lock().expect("skin manager env lock");
        std::env::set_var("DSH_UI_SKIN_MANAGER", "1");
        let snapshot = ui_skin_manager_snapshot().expect("pinned snapshot");
        assert!(snapshot.assets.get("../escape.css").is_none());
        assert!(snapshot.assets.get("unknown.css").is_none());
        std::env::remove_var("DSH_UI_SKIN_MANAGER");
    }

    #[test]
    fn retired_and_unknown_shell_pages_are_not_found() {
        let retired_page = format!("/{}-{}", "recovery", "center");
        assert_eq!(shell_http_status("/loading"), 200);
        assert_eq!(shell_http_status("/died?code=1"), 200);
        assert_eq!(shell_http_status("/inject/bridge.js"), 200);
        assert_eq!(shell_http_status("/skin/control/layout.css"), 200);
        assert_eq!(shell_http_status("/skin/style/tokens.css"), 200);
        assert_eq!(shell_http_status("/skin/style/states.css"), 200);
        assert_eq!(shell_http_status("/skin/tokens.css"), 404);
        assert_eq!(shell_http_status("/skin/../skin.json"), 404);
        assert_eq!(shell_http_status(&retired_page), 404);
        assert_eq!(shell_http_status("/about"), 404);
        assert_eq!(shell_http_status("/unknown"), 404);
    }

    #[test]
    fn shell_pages_expose_named_skin_contracts_and_state_changes() {
        let loading = super::loading_page();
        assert!(loading.contains("data-region=\"session\""));
        assert!(loading.contains("data-control-name=\"system.default.loading-spinner\""));
        assert!(loading.contains("data-state=\"loading animating\""));

        let died = super::died_page("/tmp/dsh-web.log", "1");
        assert!(died.contains("data-control-name=\"system.default.restart-button\""));
        assert!(died.contains("data-state=\"idle\""));
        assert!(died.contains("setAttribute('data-state','running')"));
        assert!(died.contains("setAttribute('data-state','error')"));

        // 回归锁（启动页 `\` 乱码）：script 注入之前的 HTML 段不得含任何反斜杠
        // —— 模板行连接写成 `\\` 时，字面 `\` + 换行 + 缩进会原样进入响应体，
        // 标签之间的 `\` 成为可见文本节点（散落的 "\" 乱码）。
        let loading_html = loading.split("<script>").next().unwrap_or("");
        assert!(
            !loading_html.contains('\\'),
            "stray backslash in loading page HTML"
        );
        let died_html = died.split("<script>").next().unwrap_or("");
        assert!(
            !died_html.contains('\\'),
            "stray backslash in died page HTML"
        );
        // died 页脚本大括号配平：retry 函数体必须以 `});}` 收口后紧跟 </script>。
        assert!(died.contains("});}</script>"));
    }

    #[test]
    fn died_page_retries_through_boot_start_only() {
        let page = super::died_page("/tmp/dsh-web.log", "1");
        assert!(page.contains("_call('boot.start'"));
        assert!(!page.contains("rescue.safe-mode"));
        assert!(!page.contains(&format!("{}-{}", "recovery", "center")));
    }

    #[test]
    fn died_page_exposes_environment_diagnosis_and_guarded_purge() {
        // P1 自愈（形态 1）：sidecar 已退场，页面必须能独立给出环境诊断，
        // 并把「清理重建」做成**受保护**的显式动作。
        let page = super::died_page("/tmp/dsh-web.log", "1");
        // 诊断面板与命名锚点（与现有 shell-page 契约同一命名风格）。
        assert!(page.contains("data-control-name=\"system.default.environment-panel\""));
        assert!(page.contains("data-control-name=\"system.default.environment-summary\""));
        assert!(page.contains("data-control-name=\"system.default.environment-problems\""));
        assert!(page.contains("data-control-name=\"system.default.environment-purge-button\""));
        // 走 L1 命令（不依赖 sidecar 存活）。
        assert!(page.contains("invoke('diagnose_environment')"));
        assert!(page.contains("invoke('repair_environment'"));
        // 删除必须二次确认，且默认隐藏，只有 removable=true 才放出。
        assert!(page.contains("window.confirm("));
        assert!(page.contains("d.removable?'idle':'hidden'"));
        // 不得引入任何自动删除路径。
        assert!(
            !page.contains(
                "invoke('repair_environment',{purge:true}).then(function(){location.reload();});\n"
            ),
            "清理必须由用户点击触发，不得在加载时自动执行"
        );
        assert!(page.contains("onclick=\"purgeEnvironment()\""));
        // 无法自动清理时必须给出人工出路（注册表损坏场景实测会卡住）。
        assert!(page.contains("data-control-name=\"system.default.environment-hint\""));
        assert!(
            page.contains("环境无法自动清理"),
            "必须给出可执行的人工恢复提示"
        );
    }

    #[test]
    fn shell_pages_do_not_leak_line_continuation_backslashes() {
        // 回归（2026-09-29 实测「一坨黑」）：页面模板每行结尾必须用**单**反斜杠
        // 做 Rust 续行。写成双反斜杠 `\\` 时，Rust 把它当「字面反斜杠」，
        // 于是每个 HTML 行尾都吐出一个可见 `\` + 真实换行，页面被游离反斜杠铺满。
        //
        // 这个缺陷在 HEAD 上就已存在（28 处，/loading 页可见 17 处），
        // 自愈面板插入后扩到 84 处。
        //
        // 注意：只检查 **HTML 模板部分**（`<script>` 之前）。BRIDGE_JS 是
        // include_str! 进来的 JS 产物，其中的行尾 `\` 是合法的 JS 字符串续行，
        // 不能一并判死（首版断言过宽，被这个测试自己抓出来了）。
        for (label, page) in [
            ("loading_page", super::loading_page()),
            ("died_page", super::died_page("/tmp/dsh-web.log", "1")),
        ] {
            let html_only = match page.find("<script") {
                Some(idx) => &page[..idx],
                None => &page[..],
            };
            let leaked: Vec<&str> = html_only
                .split('\n')
                .filter(|line| line.ends_with('\\'))
                .collect();
            assert!(
                leaked.is_empty(),
                "{label} 的 HTML 模板泄露了 {} 个行尾反斜杠（续行应写单 \\，不得写 \\\\）：{:?}",
                leaked.len(),
                leaked.first().map(|l| &l[l.len().saturating_sub(60)..]),
            );
        }
    }

    #[test]
    fn died_page_uses_shell_invoke_bridge_not_global_tauri() {
        // 回归（2026-09-30 实测：诊断面板永远停在「正在检查隔离环境…」）：
        // 页面原先读 `window.__TAURI__`，但本壳**刻意不开** `withGlobalTauri`
        // （避免把 L1 命令面暴露给内核 Web UI 等所有页面），于是 `invoke` 恒为
        // undefined，诊断从未生效过。
        //
        // 修法：壳在 initialization_script 里注入受限的 `window.dshShell.invoke`
        //（薄包装 Tauri 无条件注入的 `__TAURI_INTERNALS__.invoke`），页面改用它。
        let page = super::died_page("/tmp/dsh-web.log", "1");
        assert!(
            page.contains("window.dshShell&&window.dshShell.invoke"),
            "页面必须经壳注入的 dshShell.invoke 调 L1 命令",
        );
        assert!(
            !page.contains("window.__TAURI__"),
            "页面不得依赖 __TAURI__（本壳未启用 withGlobalTauri，运行时恒为 undefined）",
        );

        // 注入侧必须真的定义了这个命名空间，且底层走 __TAURI_INTERNALS__。
        let init = super::shell_invoke_bridge_js();
        assert!(
            init.contains("window.dshShell"),
            "注入脚本必须定义 window.dshShell"
        );
        assert!(
            init.contains("__TAURI_INTERNALS__"),
            "底层必须用 Tauri 无条件注入的 __TAURI_INTERNALS__.invoke",
        );
        assert!(
            init.contains("Promise.reject"),
            "底层缺失时必须显式 reject，不得静默 resolve 成假成功",
        );

        // 组合进 initialization_script：壳启动时确实会注入它。
        let full = super::bridge_init_script();
        assert!(
            full.contains("window.dshShell"),
            "bridge_init_script 必须包含壳 invoke 绑定"
        );
    }

    #[test]
    fn environment_cli_actions_are_allowlisted() {
        // L1 只允许这三个动作；拼错的动作名必须在脚本侧被拒绝（fail loud），
        // 而不是静默变成一个「什么都没做」的成功。
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("repo root")
                .join("dsh-desktop")
                .join("scripts")
                .join("environment-diagnose.mjs"),
        )
        .expect("read environment-diagnose.mjs");
        for action in ["status", "plan", "remove", "repair"] {
            assert!(source.contains(action), "脚本必须支持 action={action}");
        }
        assert!(source.contains("未知 action"));
    }

    #[test]
    fn every_invoked_command_is_declared_for_acl() {
        // 回归（2026-09-30 实测：所有 command 都报 "not allowed by ACL"）：
        // Tauri v2 的自定义 command **默认被拒**，必须在 build.rs 的
        // AppManifest::commands() 里声明，才会生成 allow-* 权限；
        // 再由 capabilities/*.json 授权给窗口。任一处漏掉，命令在运行期
        // 就是「静默不可调用」—— 页面只看到 unavailable，毫无线索。
        //
        // 这里锁死三处的一致性：invoke_handler ⊆ build.rs 声明 ⊆ capability 授权。
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let main_rs = std::fs::read_to_string(manifest_dir.join("src").join("main.rs"))
            .expect("read main.rs");
        let build_rs =
            std::fs::read_to_string(manifest_dir.join("build.rs")).expect("read build.rs");
        let capability =
            std::fs::read_to_string(manifest_dir.join("capabilities").join("default.json"))
                .expect("read capabilities/default.json");

        // 从 generate_handler![...] 提取已注册的命令名。
        // 用 rfind：本测试自己的注释/字面量里也含这个字符串，find 会先命中测试自身。
        const MARKER: &str = "generate_handler![";
        let handler_start = main_rs.rfind(MARKER).expect("找到 invoke_handler");
        let after_bracket = handler_start + MARKER.len();
        let handler_end = main_rs[after_bracket..]
            .find(']')
            .map(|i| after_bracket + i)
            .expect("找到 handler 结束");
        let registered: Vec<&str> = main_rs[after_bracket..handler_end]
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
            .collect();
        assert!(
            registered.len() >= 4,
            "应至少注册 shell_ping / sidecar_call / diagnose_environment / repair_environment，实际 {registered:?}",
        );

        for cmd in &registered {
            assert!(
                build_rs.contains(&format!("\"{cmd}\"")),
                "build.rs 的 AppManifest 必须声明命令 {cmd}"
            );
            let slug = cmd.replace('_', "-");
            assert!(
                capability.contains(&format!("allow-{slug}")),
                "capabilities/default.json 必须授权 allow-{slug}（否则 {cmd} 运行期被 ACL 拒绝）",
            );
        }

        // 反向：声明了却没人调用的权限是死配置，容易被误认为「已授权」。
        let declared_in_build = build_rs
            .split("commands(&[")
            .nth(1)
            .and_then(|s| s.split("])").next())
            .expect("build.rs 应有 commands(&[...]) 清单");
        for raw in declared_in_build.split(',').map(str::trim) {
            let name = raw.trim_matches(|c: char| c == '"' || c.is_whitespace());
            if name.is_empty() {
                continue;
            }
            assert!(
                registered.contains(&name),
                "build.rs 声明了 {name}，但 invoke_handler 未注册它（该权限是死配置）",
            );
        }
    }

    #[test]
    fn capability_remote_scope_stays_narrow() {
        // 回归（2026-09-30 review 发现）：capability 初版用通配端口
        // `http://127.0.0.1:*/*`，**把 L1 命令面一并授权给了内核 Web UI**
        // —— 因为内核 UI 也是同一个 main 窗口导航过去的，只是跑在**动态端口**
        // 上（实测 /died 在 19873，内核 UI 在 58809 之类）。通配端口等于没有
        // origin 隔离，`remote` 那行就失去意义。
        //
        // 但也不能写死 19873：壳桥端口被占时会向上回退 25 个候选
        //（WS_PORT..WS_PORT+24），写死会在回退时让自愈功能失效。
        //
        // 因此 scope 必须是**端口段**正则：覆盖 [WS_PORT, WS_PORT+24]，排除
        // 内核的动态端口。这里锁死这个边界，防止以后被改回通配。
        let capability = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("capabilities")
                .join("default.json"),
        )
        .expect("read capabilities/default.json");

        assert!(
            !capability.contains("127.0.0.1:*"),
            "不得用通配端口：那会把 L1 命令面授权给内核 Web UI（动态端口）",
        );
        assert!(
            capability.contains("1987[3-9]") && capability.contains("1989[0-8]"),
            "scope 必须是覆盖壳桥端口段（{WS_PORT}..{}）的正则",
            WS_PORT + 24,
        );
        // 壳桥回退范围与 scope 必须同步：WS_PORT 改了这里也要改。
        assert_eq!(
            super::WS_PORT,
            19873,
            "WS_PORT 变动时必须同步 capability 的端口段"
        );
        assert!(
            capability.contains("\"local\": false"),
            "页面是外部 HTTP origin，local 必须为 false",
        );
    }

    #[test]
    fn retired_recovery_page_returns_http_404() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async {
            let retired_page = format!("/{}-{}", "recovery", "center");
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .expect("bind test listener");
            let address = listener.local_addr().expect("listener address");
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.expect("accept request");
                super::http_serve(stream, &retired_page)
                    .await
                    .expect("serve response");
            });

            let mut client = tokio::net::TcpStream::connect(address)
                .await
                .expect("connect test client");
            let request = format!(
                "GET /{}-{} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                "recovery", "center"
            );
            client
                .write_all(request.as_bytes())
                .await
                .expect("write request");
            let mut response = String::new();
            client
                .read_to_string(&mut response)
                .await
                .expect("read response");
            server.await.expect("server task");
            assert!(response.starts_with("HTTP/1.1 404 Not Found\r\n"));
        });
    }
}

fn is_resource_root(path: &Path) -> bool {
    path.join("sidecar").join("server.js").is_file() && path.join("dsh-desktop").is_dir()
}

#[cfg(windows)]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    path
}

fn verified_resource_root(path: &Path) -> Option<PathBuf> {
    let normalized = strip_verbatim_prefix(path.canonicalize().ok()?);
    (normalized.is_absolute() && is_resource_root(&normalized)).then_some(normalized)
}

fn initialize_packaged_resource_root(app: &tauri::App) {
    use tauri::Manager;
    if let Ok(root) = app.path().resource_dir() {
        if let Some(root) = verified_resource_root(&root) {
            let _ = PACKAGED_RESOURCE_ROOT.set(root);
        } else {
            eprintln!(
                "[shell] ignoring invalid resource directory: {}",
                root.display()
            );
        }
    }
}

/// 打包态与开发态（CARGO_MANIFEST_DIR 布局）的资源根。
/// 实测（R6 Stage 1）：Tauri v2 resources map 目标相对安装根，NSIS 装出
/// exe 同级 sidecar/ + dsh-desktop/ 兄弟目录；exe 同级直认优先，
/// 兼容保留 resources/ 子目录布局探测，最后回退开发布局。
fn resource_root() -> std::path::PathBuf {
    // Linux deb/AppImage 把资源放在 usr/lib/<product>/，不与 usr/bin 下的
    // 可执行文件同级。setup 阶段由 Tauri path resolver 注入真实目录。
    if let Some(root) = PACKAGED_RESOURCE_ROOT.get() {
        return root.clone();
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent().map(|p| p.to_path_buf()) {
            if dir.join("sidecar").join("server.js").exists() {
                return dir;
            }
            let res = dir.join("resources");
            if res.join("sidecar").join("server.js").exists() {
                return res;
            }
            // macOS bundle 布局：Contents/MacOS/<bin> → Contents/Resources/。
            #[cfg(target_os = "macos")]
            if let Some(contents) = dir.parent() {
                let mac_res = contents.join("Resources");
                if mac_res.join("sidecar").join("server.js").exists() {
                    return mac_res;
                }
            }
        }
    }
    // 开发态不把 CARGO_MANIFEST_DIR 编进 release 二进制，避免成品泄露构建机
    // 绝对路径。从 cwd 或 target/{debug,release} 下的可执行文件向上探测仓库根。
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.extend(cwd.ancestors().map(|path| path.to_path_buf()));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.extend(parent.ancestors().map(|path| path.to_path_buf()));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.join("dsh-desktop").is_dir() && path.join("tauri-shell").is_dir())
        .unwrap_or_else(|| std::path::PathBuf::from("."))
}

fn sidecar_script() -> std::path::PathBuf {
    let root = resource_root();
    let packaged = root.join("sidecar").join("server.js");
    let script = if packaged.exists() {
        packaged
    } else {
        // 开发态（仓库根布局）：sidecar 编译产物位于 tauri-shell/sidecar/。
        root.join("tauri-shell").join("sidecar").join("server.js")
    };
    strip_verbatim_prefix(script.canonicalize().unwrap_or(script))
}

fn is_sidecar_respawn_request(method: &str) -> bool {
    method == "boot.start"
}

fn dsh_desktop_dir() -> String {
    resource_root()
        .join("dsh-desktop")
        .to_string_lossy()
        .replace('\u{5C}', "/")
}

// 通道名是 ASCII 标识符，且必须满足 dpx 的 /^[A-Za-z][A-Za-z0-9-]{0,63}$/。
// 非法值退回默认通道 —— 不要「清洗」成一个看似合法却错误的通道（ADR 0004）。
fn sanitize_eac_channel(value: &str) -> String {
    let channel = value.trim().to_ascii_lowercase().replace('_', "-");
    let valid = channel.len() <= 60
        && channel
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_lowercase)
        && channel
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if valid && !channel.ends_with('-') {
        channel
    } else {
        DEFAULT_EAC_CHANNEL.to_string()
    }
}

// 发布通道：显式环境变量优先（开发/测试），其次安装包内的 environment-policy.json，
// 最后退回默认通道。
fn eac_channel() -> String {
    if let Ok(channel) = std::env::var("DSH_EAC_CHANNEL") {
        if !channel.trim().is_empty() {
            return sanitize_eac_channel(&channel);
        }
    }
    let policy = resource_root()
        .join("dsh-desktop")
        .join("environment-policy.json");
    if let Ok(text) = std::fs::read_to_string(policy) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(channel) = value.get("channel").and_then(|v| v.as_str()) {
                if !channel.trim().is_empty() {
                    return sanitize_eac_channel(channel);
                }
            }
        }
    }
    DEFAULT_EAC_CHANNEL.to_string()
}

// 产品数据根（ADR 0004）：Windows = %LOCALAPPDATA%\Deepseek Harness EAC，
// 非 Windows 在产品数据根下同样布局。L1 只负责给这一个根 + 通道；
// dpx storageRoot / 环境名 / 环境根 / 目录骨架全部由 L2 sidecar 调 dsh-dpx 推导，
// 壳里不复制 dpx 的路径策略，避免两侧漂移。
//
// 外部注入的 `DSH_EAC_DATA_ROOT` 是**权威值**：便携启动器、端到端验证与
// 故障注入都靠它把环境指到指定位置。若这里无视它、再用 `LOCALAPPDATA`
// 重算一遍，就会把环境建到与调用方预期不同的位置（L2 侧却把该变量当权威，
// 两侧语义正好相反），实测表现为「隔离根建在别处」。因此显式给定时一律采用。
fn eac_data_root() -> std::path::PathBuf {
    eac_data_root_with(
        std::env::var("DSH_EAC_DATA_ROOT").ok().as_deref(),
        std::env::var("USERPROFILE").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
        std::env::var("LOCALAPPDATA").ok().as_deref(),
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
        std::env::temp_dir(),
    )
}

/// `eac_data_root` 的**纯函数**核心：不读全局环境，参数即输入。
///
/// 拆出来是为了可测：`std::env::set_var` 是进程全局的，直接改它会让并行运行的
/// 其它测试读到被污染的 `DSH_EAC_DATA_ROOT`（实测出现过一次性失败）。纯函数
/// 版本既覆盖同一逻辑，又不引入跨测试干扰。
#[allow(clippy::too_many_arguments)]
fn eac_data_root_with(
    declared: Option<&str>,
    userprofile: Option<&str>,
    home_var: Option<&str>,
    localappdata: Option<&str>,
    xdg_data_home: Option<&str>,
    fallback_temp: std::path::PathBuf,
) -> std::path::PathBuf {
    // 显式注入即权威（空白值不算「给定」，退回推导）。
    if let Some(value) = declared {
        if !value.trim().is_empty() {
            return std::path::PathBuf::from(value.trim());
        }
    }
    let home = userprofile
        .or(home_var)
        .map(std::path::PathBuf::from)
        .unwrap_or(fallback_temp);
    let base = if cfg!(windows) {
        localappdata
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local"))
    } else {
        xdg_data_home
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"))
    };
    base.join(EAC_PRODUCT_NAME)
}

static SHELL_NOTIFY: OnceLock<broadcast::Sender<Value>> = OnceLock::new();
static WEB_URL: OnceLock<RwLock<String>> = OnceLock::new();
static LAST_MAXIMIZED: AtomicBool = AtomicBool::new(false);
// 优雅退出/重启意图：退出链路（shutdown 应答→sidecar 自退→EOF）会被 reader
// 当成「sidecar 死亡」广播 boot.server-died，退出/重启瞬间主窗闪现 /died 页。
// 各退出/重启入口置位，reader EOF 命中时只回绝在途 RPC、不广播死亡导航。
static SIDECAR_STOPPING: AtomicBool = AtomicBool::new(false);

fn shell_notify() -> broadcast::Sender<Value> {
    SHELL_NOTIFY
        .get_or_init(|| broadcast::channel::<Value>(64).0)
        .clone()
}

fn current_web_url() -> Option<String> {
    WEB_URL
        .get_or_init(|| RwLock::new(String::new()))
        .read()
        .ok()
        .map(|g| g.clone())
        .filter(|s| !s.is_empty())
}

fn set_current_web_url(url: &str) {
    if let Ok(mut g) = WEB_URL.get_or_init(|| RwLock::new(String::new())).write() {
        *g = url.to_string();
    }
}

// ---------------------------------------------------------------------------
// 主窗尺寸/位置记忆（issue：副屏宽度不够显示不全）。
// 保存 app_config_dir/window-state.json（{x,y} 为物理像素，{w,h} 为逻辑尺寸，
// 与 Tauri builder inner_size/position 的语义严格对应）。
// 恢复时做显示器 work-area 校验：中心点不在任何显示器上的旧状态丢弃，
// 尺寸收敛到所在显示器可用范围，位置 clamp 保证至少 40% 宽度可拖回。
// ---------------------------------------------------------------------------

const DEFAULT_INNER_W: f64 = 1400.0;
const DEFAULT_INNER_H: f64 = 900.0;
/// 主窗允许的最小逻辑尺寸默认值（480×360：适配副屏窄屏，与浮窗下限一致）。
/// 可用环境变量 DSH_WINDOW_MIN_W / DSH_WINDOW_MIN_H 覆盖（任意 >0 的有限值）。
const MIN_INNER_W_DEFAULT: f64 = 480.0;
const MIN_INNER_H_DEFAULT: f64 = 360.0;
/// 无保存状态时首启尺寸相对 work area 的边距（逻辑像素）。
const FIRST_RUN_MARGIN: f64 = 16.0;
/// 恢复位置时保证可见的最小宽度（逻辑像素），防止窗口大半落在屏外。
const MIN_VISIBLE_W: f64 = 80.0;

/// 读取正浮点环境变量；缺失或非法（非数值 / ≤0 / 非有限）时回退 fallback。
/// 供窗口边界覆盖（DSH_WINDOW_MIN_W/H、DSH_WINDOW_W/H）使用。
fn env_positive_f64(name: &str, fallback: f64) -> f64 {
    match std::env::var(name) {
        Ok(v) => v
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f > 0.0)
            .unwrap_or(fallback),
        Err(_) => fallback,
    }
}

/// 主窗允许的最小逻辑尺寸（默认 480×360，可用环境变量覆盖）。
fn min_inner_w() -> f64 {
    env_positive_f64("DSH_WINDOW_MIN_W", MIN_INNER_W_DEFAULT)
}

fn min_inner_h() -> f64 {
    env_positive_f64("DSH_WINDOW_MIN_H", MIN_INNER_H_DEFAULT)
}

/// 无记忆时首启默认逻辑尺寸（默认 1400×900，可用环境变量覆盖）。
fn default_inner_w() -> f64 {
    env_positive_f64("DSH_WINDOW_W", DEFAULT_INNER_W)
}

fn default_inner_h() -> f64 {
    env_positive_f64("DSH_WINDOW_H", DEFAULT_INNER_H)
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
struct WindowState {
    x: i32,
    y: i32,
    w: f64,
    h: f64,
    maximized: bool,
}

fn window_state_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("window-state.json"))
}

fn load_window_state(app: &tauri::AppHandle) -> Option<WindowState> {
    let path = window_state_path(app)?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_window_state(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(path) = window_state_path(app) else {
        return;
    };
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(size) = win.outer_size() else { return };
    let Ok(pos) = win.outer_position() else {
        return;
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let logical = size.to_logical::<f64>(scale);
    let state = WindowState {
        x: pos.x,
        y: pos.y,
        w: logical.width,
        h: logical.height,
        maximized: win.is_maximized().unwrap_or(false),
    };
    // 落盘防御（与启动侧 <600×400 丢弃互为镜像）：还原位被 DPI/显示器
    // 变化污染成极小尺寸的会话，坏值只允许存在当次，绝不写盘毒化下次启动。
    if state.w < 600.0 || state.h < 400.0 {
        eprintln!(
            "[shell] window-state too small on save ({}x{}), skip persist",
            state.w, state.h
        );
        return;
    }
    let json = match serde_json::to_string(&state) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("[shell] window-state serialize failed: {}", e);
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[shell] window-state mkdir failed: {}", e);
        }
    }
    if let Err(e) = std::fs::write(&path, json) {
        eprintln!("[shell] window-state save failed: {}", e);
    }
}

/// 拖动缩放期间避免写盘风暴：同一窗口 800ms 内最多落盘一次；
/// 最终状态由 CloseRequested / ExitRequested 兜底保存。
static LAST_STATE_SAVE: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

fn throttle_save_window_state(app: &tauri::AppHandle) {
    let now = std::time::Instant::now();
    let Ok(mut last) = LAST_STATE_SAVE.lock() else {
        return;
    };
    if last
        .map(|t| now.duration_since(t).as_millis() < 800)
        .unwrap_or(false)
    {
        return;
    }
    *last = Some(now);
    save_window_state(app);
}

// ---------------------------------------------------------------------------
// 壳语言态（SYNC-002 · __DSH_LOCALE__ 回写链，官方 preload-app.ts:102-105）
//
// 官方语义（main.ts:703-721）：localeBootstrap 返回 {languages, preference}，
// preference 存 Host 设置文档（ns=locale）；localeChanged 后更新应用菜单/平台页。
// EAC 权威源选型（任务卡要求调研后定点）：壳 L1 自持 locale-state.json ——
//   * L1 现无任何语言持久化（CHINESE_UI OnceLock 启动探测 OS、只读，全程不变）；
//   * sidecar settings.json 兼容层无语言键，且 L1 与 L2 并发写同一 JSON 有覆盖
//     竞态 —— 本域内唯一写者单独成文件，天然无冲突；
//   * 内核 Host 设置文档（ns=locale）是官方存储，但属禁改内核面，且壳 bootstrap
//     时 web 服务可能未起，语言读取不得依赖它。
// 文件放在壳设置目录（与 sidecar settings.json 同目录），路径解析与
// dsh-desktop/lib/desktop/platform.ts 的 userDataDir() 逐分支对齐：
// APPDATA / XDG_CONFIG_HOME 环境变量重定向即可隔离验证。preference 缺失 =
// null（官方语义：自动选择，回退 OS 语言检测）。
// ---------------------------------------------------------------------------

/// 壳设置目录（= sidecar platform.ts userDataDir() 的 Rust 镜像）。
fn shell_settings_dir() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        let base = std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                // platform.ts 回退：homeDir\AppData\Roaming（homeDir = USERPROFILE）。
                let home = std::env::var_os("USERPROFILE")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                home.join("AppData").join("Roaming")
            });
        base.join("Deepseek Harness EAC")
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        home.join("Library")
            .join("Application Support")
            .join("deepseek-harness-eac")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                let home = std::env::var_os("HOME")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::path::PathBuf::from("."));
                home.join(".config")
            });
        base.join("deepseek-harness-eac")
    }
}

fn locale_state_path() -> std::path::PathBuf {
    shell_settings_dir().join("locale-state.json")
}

/// 读持久化 preference（文件缺失/损坏/形态非法 → None = 自动选择）。
fn load_locale_preference() -> Option<String> {
    let raw = std::fs::read_to_string(locale_state_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("preference")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string())
}

fn save_locale_preference(preference: &str) {
    let path = locale_state_path();
    let json = serde_json::json!({ "preference": preference }).to_string();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!("[shell] locale-state mkdir failed: {}", e);
            return;
        }
    }
    if let Err(e) = std::fs::write(&path, json) {
        eprintln!("[shell] locale-state save failed: {}", e);
    }
}

/// 壳 UI 语言：持久化 preference 命中 zh 系 → 中文；其余 tag → 英文
///（官方 resolveDesktopStartupLocale：preference 归一到 zh/en，fallback en）；
/// 无持久化 → OS 语言检测（既有 use_chinese_ui）。
fn shell_prefers_chinese() -> bool {
    match load_locale_preference() {
        Some(p) => locale_tag_is_chinese(&p),
        None => use_chinese_ui(),
    }
}

/// 官方 LocaleSettings id 形态（client-locale LOCALE_ID_PATTERN）：
/// /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/。send 型通道的输入闸门：
/// 非法 tag 静默丢弃（官方 main.ts:713 对非 string 亦直接 return）。
fn locale_tag_is_well_formed(tag: &str) -> bool {
    let mut segments = tag.split('-');
    let Some(primary) = segments.next() else {
        return false;
    };
    let primary_len = primary.len();
    if !(2..=8).contains(&primary_len) || !primary.bytes().all(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    segments.all(|sub| {
        let n = sub.len();
        (1..=8).contains(&n) && sub.bytes().all(|b| b.is_ascii_alphanumeric())
    })
}

/// 系统语言标签（locale.bootstrap 的 L1 languages 来源 = 官方
/// app.getPreferredSystemLanguages 的 EAC 等价物；页面侧 navigator.languages
/// 由桥合并优先，L1 单标签兜底）。
#[cfg(windows)]
fn system_language_tag() -> String {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    let mut locale = [0u16; 85];
    let len = unsafe { GetUserDefaultLocaleName(locale.as_mut_ptr(), locale.len() as i32) };
    if len <= 1 {
        return "en".to_string();
    }
    String::from_utf16_lossy(&locale[..len as usize - 1])
}

#[cfg(not(windows))]
fn system_language_tag() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"]
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .map(|value| {
            value
                .split(':')
                .next()
                .unwrap_or(&value)
                .split('.')
                .next()
                .unwrap_or("")
                .to_string()
        })
        .filter(|tag| !tag.is_empty())
        .unwrap_or_else(|| "en".to_string())
}

/// 托盘菜单构建（初始 + locale.changed 重建共用；文案随壳语言态）。
fn build_tray_menu(
    app: &tauri::AppHandle,
    zh: bool,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let text = |zh_text: &'static str, en_text: &'static str| if zh { zh_text } else { en_text };
    let show = tauri::menu::MenuItem::with_id(
        app,
        "show",
        text("显示 / 隐藏窗口", "Show / Hide Window"),
        true,
        None::<&str>,
    )?;
    let restart = tauri::menu::MenuItem::with_id(
        app,
        "restart",
        text("重启 Web 服务", "Restart Web Service"),
        true,
        None::<&str>,
    )?;
    let feedback = tauri::menu::MenuItem::with_id(
        app,
        "feedback",
        text("反馈建议", "Feedback"),
        true,
        None::<&str>,
    )?;
    let quit =
        tauri::menu::MenuItem::with_id(app, "quit", text("退出", "Quit"), true, None::<&str>)?;
    let sep1 = tauri::menu::PredefinedMenuItem::separator(app)?;
    tauri::menu::Menu::with_items(app, &[&show, &sep1, &restart, &feedback, &quit])
}

/// locale.changed → 重建托盘菜单（语言回写落点）。菜单操作要求主线程，经
/// run_on_main_thread 派发；托盘未就绪（启动竞态）或重建失败只记日志 ——
/// send 型通道无回复可承载失败。
fn rebuild_tray_menu(app: &tauri::AppHandle) {
    let zh = shell_prefers_chinese();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || match build_tray_menu(&handle, zh) {
        Ok(menu) => match handle.tray_by_id(TRAY_ID) {
            Some(tray) => {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    eprintln!("[shell] tray menu rebuild failed: {}", e);
                } else {
                    println!(
                        "[shell] tray menu rebuilt (locale: {})",
                        if zh { "zh" } else { "en" }
                    );
                }
            }
            None => eprintln!("[shell] tray not ready for locale rebuild"),
        },
        Err(e) => eprintln!("[shell] tray menu build failed: {}", e),
    });
}

/// 托盘固定 id（locale.changed 重建时按 id 取回 TrayIcon 句柄）。
const TRAY_ID: &str = "dsh-main-tray";

// ---------------------------------------------------------------------------
// __DSH_HOST_PATHS__ 路径暂存（SYNC-003 · 官方 webUtils.getPathForFile 等价能力）
//
// 调研结论（bridge.ts 同款长注释，证据在任务自证材料）：WebView2 页面层的
// File 无真实路径（Chromium 没有 Electron 的 File.path patch），宿主层拿到
// 「粘贴的真实文件」的唯一无损通道是系统剪贴板 CF_HDROP —— 资源管理器复制的
// 文件以 CF_HDROP 落板，WebView2 页面 paste 事件的 clipboardData.files 正由它
// 生成（File 的 name/size 与此处枚举一致）。而「拖放」的真实路径只能在
// WebView2 之前接管 OLE 拖放（SetAllowExternalDrop(false) + 自注册 IDropTarget）
// 才能拿到，接管 = 页面原生 HTML5 拖放整体失效（页面收不到 dragover/drop，
// wry 对非文件拖拽无事件不可合成），本壳特意 disable_drag_drop_handler 保住
// 页面拖放 —— 故拖放路径本版不接管，桥侧 pathFor 对拖放文件返回 ''（走上传，
// 与现状一致），任务卡「已知局限」条款。
//
// 机制：常驻剪贴板监听线程（消息专用窗 HWND_MESSAGE +
// AddClipboardFormatListener）在 WM_CLIPBOARDUPDATE 时读 CF_HDROP
//（DragQueryFileW，wry 同款两段式取长路径）并取元数据（name/size/is_dir），
// 快照存 HOST_PATH_FILES 并经 shell_notify 广播 win.host-paths 通知帧；桥
//（bridge.ts）暂存后由 __DSH_HOST_PATHS__.pathFor 按 name+size 匹配返回绝对
// 路径。剪贴板不再含文件时推送空表清场（字节流截图上板 → 旧路径失效 →
// pathFor 返 ''，官方语义）。绝无伪造路径：表项只来自 DragQueryFileW 真实枚举。
//
// 局限：仅 Windows（CF_HDROP 为 Windows 剪贴板格式；macOS/Linux 文件粘贴格式
// 不同，未实现时无帧推送 → 桥侧无暂存 → pathFor 返 ''，行为与现状一致）。
// 新 WS 连接建立时补推当前快照（页面重载不丢已暂存剪贴板内容）。
// ---------------------------------------------------------------------------

/// 一条真实路径条目（win.host-paths 帧元素；字段与 bridge.ts 的匹配算法对齐）。
#[cfg(windows)]
#[derive(Clone, Debug, serde::Serialize)]
struct HostPathEntry {
    path: String,
    name: String,
    size: u64,
    is_dir: bool,
}

/// 最近一次剪贴板文件快照（win.host-paths 帧的权威源；剪贴板变化即整体替换）。
#[cfg(windows)]
static HOST_PATH_FILES: RwLock<Vec<HostPathEntry>> = RwLock::new(Vec::new());

/// 新 WS 连接补推当前快照（页面重载/重连不丢已暂存内容；空快照不推 ——
/// 页面 pathFor 对未知文件本就落 ''）。
#[cfg(windows)]
fn host_paths_snapshot_frame() -> Option<String> {
    let files = HOST_PATH_FILES.read().ok()?;
    if files.is_empty() {
        return None;
    }
    serde_json::to_string(&serde_json::json!({
        "method": "win.host-paths",
        "params": { "files": &*files }
    }))
    .ok()
}

#[cfg(not(windows))]
fn host_paths_snapshot_frame() -> Option<String> {
    None
}

/// 隔离验证钩子（SYNC-003 任务卡「L1 事件注入」条款）：环境变量
/// DSH_HOST_PATHS_STAGE 预置真实文件/目录路径（分号分隔），启动时经与剪贴板
/// 监听同一条 publish_host_path_entries 链路（快照 + WS 广播 + 新连接补推）
/// 暂存。用途：无法操作系统剪贴板的自动化验证环境（远程会话/策略锁剪贴板）
/// 下，仍可对 L1→WS→桥→pathFor 全链路做真实路径验证。硬约束不变：路径必须
/// 真实存在（fs::metadata 逐条校验，不存在的跳过并告警）—— 绝不产生伪造路径。
/// 默认（未设置环境变量）完全惰性，生产路径零影响。
#[cfg(windows)]
fn stage_host_paths_from_env() {
    let Some(raw) = std::env::var_os("DSH_HOST_PATHS_STAGE") else {
        return;
    };
    let mut entries: Vec<HostPathEntry> = Vec::new();
    for part in raw.to_string_lossy().split(';') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        let Ok(meta) = std::fs::metadata(p) else {
            eprintln!("[shell] host-paths stage: skip nonexistent path: {}", p);
            continue;
        };
        let name = std::path::Path::new(p)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string());
        entries.push(HostPathEntry {
            path: p.to_string(),
            name,
            size: meta.len(),
            is_dir: meta.is_dir(),
        });
    }
    if entries.is_empty() {
        return;
    }
    eprintln!(
        "[shell] host-paths stage: {} real path(s) from DSH_HOST_PATHS_STAGE",
        entries.len()
    );
    publish_host_path_entries(entries);
}

#[cfg(not(windows))]
fn stage_host_paths_from_env() {}

/// 快照落库 + WS 广播。每次剪贴板内容变化都推送（含空表清场）。
#[cfg(windows)]
fn publish_host_path_entries(entries: Vec<HostPathEntry>) {
    let empty = entries.is_empty();
    if let Ok(mut slot) = HOST_PATH_FILES.write() {
        let had = !slot.is_empty();
        *slot = entries.clone();
        if empty && had {
            eprintln!("[shell] host-paths: clipboard holds no files, staged paths cleared");
        }
    }
    if !empty {
        eprintln!(
            "[shell] host-paths: staged {} clipboard file(s)",
            entries.len()
        );
    }
    let _ = shell_notify().send(serde_json::json!({
        "method": "win.host-paths",
        "params": { "files": entries }
    }));
}

// windows-sys 未启用 Win32_System_DataExchange feature —— 剪贴板监听只需 5 个
// user32 函数，按 windows-sys 同款签名就地声明 FFI，避免为它们改动构建清单
//（Cargo.toml）。CF_HDROP / WM_CLIPBOARDUPDATE 为 winuser.h 文档常量。
#[cfg(windows)]
mod clipboard_ffi {
    /// RegisterClipboardFormat 预定义剪贴板格式：文件列表（winuser.h：CF_HDROP=15）。
    pub const CF_HDROP: u32 = 15;
    /// 剪贴板内容变化通知消息（winuser.h：WM_CLIPBOARDUPDATE=0x031D）。
    pub const WM_CLIPBOARDUPDATE: u32 = 0x031D;

    #[link(name = "user32")]
    extern "system" {
        pub fn OpenClipboard(
            hwndnewowner: windows_sys::Win32::Foundation::HWND,
        ) -> windows_sys::core::BOOL;
        pub fn CloseClipboard() -> windows_sys::core::BOOL;
        pub fn GetClipboardData(uformat: u32) -> windows_sys::Win32::Foundation::HANDLE;
        pub fn AddClipboardFormatListener(
            hwnd: windows_sys::Win32::Foundation::HWND,
        ) -> windows_sys::core::BOOL;
        pub fn RemoveClipboardFormatListener(
            hwnd: windows_sys::Win32::Foundation::HWND,
        ) -> windows_sys::core::BOOL;
    }
}

/// 读当前剪贴板 CF_HDROP → 路径 + 元数据。无文件/读取失败返回 None（调用方
/// 区分「确认无文件」(Some(空)) 与「瞬态读不到」(None，保留旧快照)）。
#[cfg(windows)]
unsafe fn read_clipboard_host_paths() -> Option<Vec<HostPathEntry>> {
    use clipboard_ffi::{CloseClipboard, GetClipboardData, OpenClipboard, CF_HDROP};
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    // 剪贴板可能被其它进程短暂持有：有限重试打开（打开失败不动旧快照，
    // 避免瞬态争用清掉页面已暂存的真实路径）。
    let mut opened = false;
    for _ in 0..3 {
        if OpenClipboard(std::ptr::null_mut()) != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(30));
    }
    if !opened {
        return None;
    }
    let mut entries: Vec<HostPathEntry> = Vec::new();
    let handle = GetClipboardData(CF_HDROP);
    if !handle.is_null() {
        let hdrop: HDROP = handle;
        // ifile = 0xFFFFFFFF → 返回条目数；随后逐条「先取长度再取内容」
        //（长路径可超 MAX_PATH，wry drag_drop.rs 同款两段式）。
        let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
        for i in 0..count {
            let len = DragQueryFileW(hdrop, i, std::ptr::null_mut(), 0) as usize;
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; len + 1];
            let written = DragQueryFileW(hdrop, i, buf.as_mut_ptr(), (len + 1) as u32) as usize;
            if written == 0 {
                continue;
            }
            let path = String::from_utf16_lossy(&buf[..written]);
            let meta = std::fs::metadata(&path);
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            entries.push(HostPathEntry {
                path,
                name,
                // 文件损坏/已删时 size=0、is_dir=false：仍如实暂存路径（粘贴
                // 时 Chromium 的 File 同样读不到内容，上传/引用语义由内核定）。
                size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                is_dir: meta.map(|m| m.is_dir()).unwrap_or(false),
            });
        }
    }
    let _ = CloseClipboard();
    Some(entries)
}

/// 常驻剪贴板监听线程：消息专用窗（不进任务栏、无焦点）+
/// AddClipboardFormatListener，独立线程自泵消息，不与 tauri 主事件循环耦合。
/// 仅 Windows（见顶部注释局限条款）。
#[cfg(windows)]
fn spawn_clipboard_path_listener() {
    let spawned = std::thread::Builder::new()
        .name("dsh-clipboard-paths".to_string())
        .spawn(|| unsafe { clipboard_listener_main() });
    if spawned.is_err() {
        eprintln!("[shell] clipboard path listener spawn failed");
    }
}

#[cfg(windows)]
unsafe fn clipboard_listener_main() {
    use clipboard_ffi::{
        AddClipboardFormatListener, RemoveClipboardFormatListener, WM_CLIPBOARDUPDATE,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
        TranslateMessage, MSG, WM_DESTROY, WNDCLASSW,
    };

    unsafe extern "system" fn clip_host_wndproc(
        hwnd: windows_sys::Win32::Foundation::HWND,
        msg: u32,
        wparam: windows_sys::Win32::Foundation::WPARAM,
        lparam: windows_sys::Win32::Foundation::LPARAM,
    ) -> windows_sys::Win32::Foundation::LRESULT {
        if msg == WM_CLIPBOARDUPDATE {
            if let Some(entries) = read_clipboard_host_paths() {
                publish_host_path_entries(entries);
            }
            return 0;
        }
        if msg == WM_DESTROY {
            RemoveClipboardFormatListener(hwnd);
            return 0;
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    let class_name: Vec<u16> = "dsh_eac_clip_host\0".encode_utf16().collect();
    let mut wc: WNDCLASSW = std::mem::zeroed();
    wc.lpfnWndProc = Some(clip_host_wndproc);
    wc.hInstance = GetModuleHandleW(std::ptr::null());
    wc.lpszClassName = class_name.as_ptr();
    if RegisterClassW(&wc) == 0 {
        eprintln!("[shell] clipboard listener RegisterClassW failed");
        return;
    }
    // HWND_MESSAGE = (HWND)-3：消息专用窗。注册失败只降级（无路径暂存，
    // 桥侧 pathFor 返 ''，与未实现平台行为一致），绝不阻塞壳启动。
    let hwnd_message = -3isize as windows_sys::Win32::Foundation::HWND;
    let hwnd = CreateWindowExW(
        0,
        class_name.as_ptr(),
        std::ptr::null(),
        0,
        0,
        0,
        0,
        0,
        hwnd_message,
        std::ptr::null_mut(),
        wc.hInstance,
        std::ptr::null(),
    );
    if hwnd.is_null() {
        eprintln!("[shell] clipboard listener window create failed");
        return;
    }
    if AddClipboardFormatListener(hwnd) == 0 {
        eprintln!("[shell] AddClipboardFormatListener failed");
        return;
    }
    println!("[shell] clipboard path listener ready");
    let mut msg: MSG = std::mem::zeroed();
    loop {
        // -1 = 错误（窗口销毁后即返回 -1 收摊），0 = WM_QUIT。
        let r = GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0);
        if r <= 0 {
            break;
        }
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
}

// ---------------------------------------------------------------------------
// 视口失同步自愈（issue：全屏窗口只有左侧 ~208px 条带被绘制、其余黑屏，
// 页面按 166px 窄视口布局 —— 用户看到"侧边栏图标只剩一个"的冻结画面）。
//
// 根因：WebView2 的视口边界由壳层在 WM_SIZE 时同步；窗口尺寸/显示器 DPI
// 变化事件被吞（副屏拔插、系统缩放切换、启动期主线程阻塞）后视口停留在
// 旧物理尺寸，页面 layout 按旧窄尺寸排，窗口其余区域永不重绘。
//
// 检测：桥心跳（5s）上报页面 innerWidth/innerHeight/devicePixelRatio
// （win.viewport-beat），与窗口 inner_size 比对，超差即判定失同步。
// 自愈：① 重申 webview bounds（不动窗口本身，最大化态安全，WebView2
// 重新布局+合成，撕裂的黑屏条带随即恢复）；② 连续两拍仍未纠正且非最大化
// 时，升级为 1px 窗口尺寸往返强制 WM_SIZE → 壳层按窗口实际尺寸重绑 webview。
// ---------------------------------------------------------------------------

/// 上次自愈时刻（节流 ≥2s）与连续失同步拍数。
static LAST_VP_HEAL: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
static VP_DESYNC_STREAK: AtomicU64 = AtomicU64::new(0);

/// 心跳报文的视口与窗口实际尺寸比对，失同步时分级自愈。
fn heal_viewport_desync(app: &tauri::AppHandle, page_w: f64, page_h: f64, dpr: f64) {
    use tauri::Manager;
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    // 最小化/隐藏时页面视口本来就不会跟随，不做误报。
    if win.is_minimized().unwrap_or(true) || !win.is_visible().unwrap_or(false) {
        VP_DESYNC_STREAK.store(0, Ordering::SeqCst);
        return;
    }
    let Ok(phys) = win.inner_size() else { return };
    let exp_w = (page_w * dpr).round();
    let exp_h = (page_h * dpr).round();
    let dw = (f64::from(phys.width) - exp_w).abs();
    let dh = (f64::from(phys.height) - exp_h).abs();
    if dw <= 8.0 && dh <= 8.0 {
        VP_DESYNC_STREAK.store(0, Ordering::SeqCst);
        return;
    }
    let now = std::time::Instant::now();
    let throttled = match LAST_VP_HEAL.lock() {
        Ok(mut last) => {
            let hit = last
                .map(|t| now.duration_since(t).as_millis() < 2000)
                .unwrap_or(false);
            if !hit {
                *last = Some(now);
            }
            hit
        }
        Err(_) => true,
    };
    if throttled {
        return;
    }
    eprintln!(
        "[shell] viewport desync: page {}x{}@{} vs window {}x{}, re-asserting webview bounds",
        page_w, page_h, dpr, phys.width, phys.height
    );
    // ① 直接重申 webview bounds = 窗口客户区物理尺寸。
    let rect = tauri::Rect {
        position: tauri::PhysicalPosition::new(0i32, 0i32).into(),
        size: tauri::PhysicalSize::new(phys.width, phys.height).into(),
    };
    if let Err(e) = win.as_ref().set_bounds(rect) {
        eprintln!("[shell] webview set_bounds failed: {}", e);
    }
    // ② 升级路径：连续两拍失同步且非最大化 → 1px 往返强制 WM_SIZE
    //（最大化窗口 set_size 会破坏最大化态，只走 ①）。
    let streak = VP_DESYNC_STREAK.fetch_add(1, Ordering::SeqCst);
    if streak >= 1 && !win.is_maximized().unwrap_or(false) {
        let w = phys.width;
        let h = phys.height;
        let _ = win.set_size(tauri::PhysicalSize::new(w, h.saturating_sub(1)));
        let win2 = win.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let _ = win2.set_size(tauri::PhysicalSize::new(w, h));
        });
        eprintln!(
            "[shell] viewport desync persists, nudged window size {}x{}",
            w, h
        );
    }
}

/// DPI/显示器变化后重申 webview bounds（ScaleFactorChanged 事件调用）。
/// tao 处理 WM_DPICHANGED 会重设窗口尺寸，但 WebView2 视口跟随偶发丢失
/// —— 即视口失同步的主诱因，这里延迟一拍显式重绑兜底。
fn reassert_webview_bounds(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let Ok(phys) = win.inner_size() else { return };
    let rect = tauri::Rect {
        position: tauri::PhysicalPosition::new(0i32, 0i32).into(),
        size: tauri::PhysicalSize::new(phys.width, phys.height).into(),
    };
    if let Err(e) = win.as_ref().set_bounds(rect) {
        eprintln!("[shell] webview set_bounds (dpi) failed: {}", e);
    } else {
        eprintln!(
            "[shell] webview bounds re-asserted after dpi change ({}x{})",
            phys.width, phys.height
        );
    }
}

/// 计算主窗初始（inner_size 逻辑尺寸, position 逻辑坐标, 是否恢复最大化）。
/// 有合法历史状态 → 恢复并在目标显示器 work area 内 clamp；
/// 无历史 → 按主显示器 work area 收敛默认尺寸并居中。
fn resolved_initial_bounds(app: &tauri::AppHandle) -> (f64, f64, Option<(f64, f64)>, bool) {
    let primary = app.primary_monitor().ok().flatten();

    let min_w = min_inner_w();
    let min_h = min_inner_h();
    let mut out_w = default_inner_w();
    let mut out_h = default_inner_h();
    let mut out_pos: Option<(f64, f64)> = None;
    let mut out_max = false;

    if let Some(p) = primary.as_ref() {
        let scale = p.scale_factor();
        let ct = p.work_area();
        let work_w = ct.size.width as f64 / scale;
        let work_h = ct.size.height as f64 / scale;
        // 窄屏收敛：配置的下限若超过 work area（OS 级最小尺寸大于屏幕可用
        // 范围），窗口将永远无法完整显示 —— 以 work area 为实际下限（保底 1px）。
        let eff_min_w = min_w.min(work_w - FIRST_RUN_MARGIN).max(1.0);
        let eff_min_h = min_h.min(work_h - FIRST_RUN_MARGIN).max(1.0);
        if std::env::var_os("DSH_WINDOW_W").is_none() && std::env::var_os("DSH_WINDOW_H").is_none()
        {
            // 自适应首启默认（issue：重装/首启窗口过小）：work area 双边距后
            // 取 80%，收敛到 [1200×800, 1920×1080] 逻辑区间 —— 1080p 及以上
            // 屏幕首启即约八成宽高，窄副屏由下方 work-area 收敛兜底。
            let fit_w = (work_w - FIRST_RUN_MARGIN * 2.0) * 0.8;
            let fit_h = (work_h - FIRST_RUN_MARGIN * 2.0) * 0.8;
            out_w = fit_w.clamp(1200.0, 1920.0);
            out_h = fit_h.clamp(800.0, 1080.0);
        }
        out_w = out_w.min(work_w - FIRST_RUN_MARGIN).max(eff_min_w);
        out_h = out_h.min(work_h - FIRST_RUN_MARGIN).max(eff_min_h);
        let cx = ct.position.x as f64 + (ct.size.width as f64 - out_w * scale) / 2.0;
        let cy = ct.position.y as f64 + (ct.size.height as f64 - out_h * scale) / 2.0;
        out_pos = Some((cx / scale, cy / scale));
    }

    if let Some(st) = load_window_state(app) {
        // 坏状态防御（issue：重装后窗口很小）：历史尺寸过小（<600×400 逻辑，
        // 低于有意义的可用下限）多为旧版本异常会话/坏写盘残留 —— 直接丢弃
        // 走上面的首启默认，避免每次启动都恢复成小窗。正常拖小的窗口首次
        // 调整后重新记忆即可恢复。
        if st.w < 600.0 || st.h < 400.0 {
            eprintln!(
                "[shell] window-state too small ({}x{}), ignored (use default size)",
                st.w, st.h
            );
        } else {
            // 目标显示器：窗口中心点所在显示器（副屏拼接/拔插后旧坐标仍指向其它
            // 屏也算合法；完全失效时 monitor_from_point 返回 None → 回退上面的默认）。
            let scale = primary.as_ref().map(|p| p.scale_factor()).unwrap_or(1.0);
            let cx = st.x as f64 + st.w * scale / 2.0;
            let cy = st.y as f64 + st.h * scale / 2.0;
            let target = app
                .monitor_from_point(cx, cy)
                .ok()
                .flatten()
                .or_else(|| primary.clone());
            if let Some(m) = target {
                let mscale = m.scale_factor();
                let wa = m.work_area();
                let work_w = wa.size.width as f64 / mscale;
                let work_h = wa.size.height as f64 / mscale;
                // 与首启一致：恢复下限不越过目标显示器 work area（极窄副屏上
                // 已保存的窄尺寸原样恢复，不会被 OS 下限弹回而显示不全）。
                let eff_min_w = min_w.min(work_w - FIRST_RUN_MARGIN).max(1.0);
                let eff_min_h = min_h.min(work_h - FIRST_RUN_MARGIN).max(1.0);
                let w = st.w.clamp(eff_min_w, work_w.max(eff_min_w));
                let h = st.h.clamp(eff_min_h, work_h.max(eff_min_h));
                // min_vis / 40px 兜底由逻辑尺寸推导，而 wa.* 是物理像素：高 DPI 屏
                // 不做 scale 换算会把「至少可见 40%/40px」的保障按 1/scale 缩水
                //（150% 屏实际只保证 ~27% 可见）。
                let min_vis = MIN_VISIBLE_W.max(w * 0.4) * mscale;
                let x = (st.x as f64)
                    .max(wa.position.x as f64)
                    .min(wa.position.x as f64 + wa.size.width as f64 - min_vis);
                let y = (st.y as f64)
                    .max(wa.position.y as f64)
                    .min(wa.position.y as f64 + wa.size.height as f64 - 40.0 * mscale);
                out_w = w;
                out_h = h;
                out_pos = Some((x / mscale, y / mscale));
                out_max = st.maximized;
            }
        }
    }

    (out_w, out_h, out_pos, out_max)
}

/// builder.min_inner_size 用的下限：极小 work area 屏上全局 480×360 会把
/// 窗口顶得显示不全，与 resolved_initial_bounds 的 eff_min 同一算法折算
/// 主屏 work area（OS 下限跟随实际屏幕，而不是固定常量）。
fn effective_min_inner(app: &tauri::AppHandle) -> (f64, f64) {
    let (mut mw, mut mh) = (min_inner_w(), min_inner_h());
    if let Ok(Some(m)) = app.primary_monitor() {
        let mscale = m.scale_factor();
        let wa = m.work_area();
        let work_w = wa.size.width as f64 / mscale;
        let work_h = wa.size.height as f64 / mscale;
        mw = mw.min(work_w - FIRST_RUN_MARGIN).max(1.0);
        mh = mh.min(work_h - FIRST_RUN_MARGIN).max(1.0);
    }
    (mw, mh)
}

/// 解析 Node 运行时：优先内置 vendor/node（与 Electron 壳共用一份），回退 PATH。
fn resolve_node() -> String {
    if let Ok(p) = std::env::var("DSH_NODE_EXE") {
        if !p.is_empty() {
            return p;
        }
    }
    let executable = if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    };
    let vendored = format!("{}/vendor/node/{}", dsh_desktop_dir(), executable);
    if std::path::Path::new(&vendored).exists() {
        return vendored;
    }
    executable.to_string()
}

/// L1 ↔ L2 sidecar 异步客户端：行分隔 JSON-RPC over stdio。
struct Sidecar {
    // 退出兜底需经 Arc 共享句柄轮询/击杀进程：tokio Child::kill/try_wait 要求
    // &mut，裸字段无法从 &self 访问。
    child: AMutex<Child>,
    writer: Arc<AMutex<ChildStdin>>,
    next_id: Arc<AtomicU64>,
    pending: Arc<AMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>,
    notify_tx: broadcast::Sender<Value>,
}

impl Sidecar {
    async fn spawn() -> Result<Self, String> {
        let node = resolve_node();
        let script = sidecar_script();
        eprintln!(
            "[sidecar] spawning node={} script={}",
            node,
            script.display()
        );
        let mut cmd = Command::new(&node);
        cmd.arg(&script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // 开发期诊断直通终端；release 无控制台，显式丢弃（inherit 在
            // windows 子系统下无有效句柄）。
            .stderr(if cfg!(debug_assertions) {
                Stdio::inherit()
            } else {
                Stdio::null()
            });
        // node.exe 是控制台子系统程序：GUI 父进程派生时若不加
        // CREATE_NO_WINDOW 会自建控制台窗口（0x08000000）。
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000);
        if let Ok(exe) = std::env::current_exe() {
            // 壳层 exe 与资源根（client-update 的 installDir 判定 / 打包态定位）。
            cmd.env("DSH_SHELL_EXE", &exe);
        }
        // 壳进程 PID：便携自更新助手的等待目标（等待壳退出后做目录树交换）。
        cmd.env("DSH_SHELL_PID", std::process::id().to_string());
        cmd.env("DSH_RESOURCE_ROOT", resource_root());
        // 安装环境隔离（ADR 0004）：正式壳启动始终注入隔离根 —— 只给产品数据根
        // 与通道，dpx 的 storageRoot/环境名/环境根由 L2 调 dsh-dpx 推导。
        let channel = eac_channel();
        cmd.env("DSH_EAC_DATA_ROOT", eac_data_root());
        cmd.env("DSH_EAC_CHANNEL", channel);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn node({}) failed: {}", node, e))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (notify_tx, _rx) = broadcast::channel::<Value>(64);
        let sc = Sidecar {
            // 退出兜底需要经 Arc 共享句柄轮询/击杀进程，child 必须可从 &self
            // 访问（tokio Child::kill/try_wait 均要求 &mut，裸字段做不到）。
            child: AMutex::new(child),
            writer: Arc::new(AMutex::new(stdin)),
            next_id: Arc::new(AtomicU64::new(0)),
            pending: Arc::new(AMutex::new(HashMap::new())),
            notify_tx,
        };
        sc.spawn_reader(ABufReader::new(stdout));
        Ok(sc)
    }

    fn spawn_reader(&self, mut reader: ABufReader<ChildStdout>) {
        let pending = self.pending.clone();
        let notify_tx = self.notify_tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // stdout closed
                    Ok(_) => {}
                    Err(_) => break,
                }
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                let v: Value = match serde_json::from_str(text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                    if let Some(tx) = pending.lock().await.remove(&id) {
                        let payload = if let Some(err) = v.get("error") {
                            Err(format!("rpc error: {}", err))
                        } else {
                            Ok(v.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = tx.send(payload);
                    }
                } else if v.get("method").is_some() {
                    // 通知帧：广播给所有 WS 连接。
                    let _ = notify_tx.send(v);
                }
            }
            // reader 退出 = sidecar 进程死亡（EOF/读错误）。不清尾的后果：
            // 在途 RPC 各挂满 180s 超时、UI 静默卡死无任何恢复入口。
            // 1) 立即回绝全部在途调用；2) 广播 boot.server-died，复用现有
            // 死亡导航链路把主窗引到 /died（sidecar 崩溃时没人会替它发这个帧）。
            // 优雅退出/重启（SIDECAR_STOPPING）时跳过广播：那是预期内死亡，
            // 广播只会让退出瞬间的主窗闪现 /died 页。
            for (_, tx) in pending.lock().await.drain() {
                let _ = tx.send(Err("sidecar exited".into()));
            }
            if !SIDECAR_STOPPING.load(Ordering::SeqCst) {
                let _ = notify_tx.send(serde_json::json!({
                    "method": "boot.server-died",
                    "params": { "code": "sidecar-exited", "logPath": "" }
                }));
            }
        });
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let req = serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        // 序列化/写/flush 失败或超时的路径必须清掉 pending 表项，否则
        // sidecar 死亡后每次调用泄漏一个 entry（HashMap 永久增长）。
        let write_res: Result<(), String> = async {
            let mut w = self.writer.lock().await;
            let mut line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
            line.push('\n');
            w.write_all(line.as_bytes())
                .await
                .map_err(|e| format!("write rpc: {}", e))?;
            w.flush().await.map_err(|e| format!("flush rpc: {}", e))?;
            Ok(())
        }
        .await;
        if let Err(e) = write_res {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(std::time::Duration::from_secs(180), rx).await {
            Ok(Ok(res)) => res,
            Ok(Err(_)) => {
                self.pending.lock().await.remove(&id);
                Err("sidecar dropped reply channel".into())
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err("sidecar call timeout (180s)".into())
            }
        }
    }

    async fn kill(&self) {
        let mut c = self.child.lock().await;
        let _ = c.kill().await;
        let _ = c.wait().await;
    }
}

/// 每连接共享态：sidecar 句柄。
#[derive(Clone)]
struct BridgeState {
    sidecar: Arc<AMutex<Option<Arc<Sidecar>>>>,
}

/// 同端口上的极简 HTTP + WebSocket 服务：
///   GET /loading            → 加载页（主窗首屏；内联桥脚本）
///   GET /died               → 服务中断页（boot.server-died 后导航）
///   GET /bootstrap          → 探针页（P2 冒烟遗留）
///   GET /inject/bridge.js   → 桥脚本
///   其余（Upgrade: websocket）→ JSON-RPC 中继（壳层拦截 + sidecar 转发）
/// 绑定桥端口：固定端口被占时向上探测，再失败退回 OS 分配。
/// 成功即把实际端口写入 WS_PORT_EFFECTIVE（所有 URL 构造经 ws_port() 读取）。
async fn bind_ws_listener() -> Option<TcpListener> {
    let mut candidates: Vec<u16> = (WS_PORT..WS_PORT.saturating_add(25)).collect();
    candidates.push(0); // OS 分配兜底
    for port in candidates {
        match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => {
                let real = l.local_addr().map(|a| a.port()).unwrap_or(port);
                if real != WS_PORT {
                    // 打印被占的原定端口（WS_PORT），不是刚绑定成功的候选端口。
                    eprintln!(
                        "[ws] port {} occupied, bridge fallback to {}",
                        WS_PORT, real
                    );
                }
                WS_PORT_EFFECTIVE.store(real, Ordering::SeqCst);
                return Some(l);
            }
            Err(e) => {
                if port == 0 {
                    eprintln!("[ws] bind fallback failed: {}", e);
                    return None;
                }
            }
        }
    }
    None
}

async fn serve_ws(state: BridgeState, app: tauri::AppHandle, listener: TcpListener) {
    println!(
        "[ws] bridge listening on http://127.0.0.1:{}/bootstrap",
        ws_port()
    );
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            // 持续性 accept 错误（监听句柄异常）若紧循环会打满 CPU：退避后再试。
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            continue;
        };
        let state = BridgeState {
            sidecar: state.sidecar.clone(),
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = handle_conn(stream, state, app).await;
        });
    }
}

/// 退出策略（= main.js getExitAction/askExitAction）：
/// minimize → 隐藏到托盘；quit → 优雅退出；ask → 弹出独立退出选择窗口。
async fn apply_exit_policy(app: &tauri::AppHandle, allow_ask: bool) {
    use tauri::Manager;
    let action = sidecar_exit_action(app)
        .await
        .unwrap_or_else(|| "ask".to_string());
    match action.as_str() {
        "minimize" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        "quit" => app.exit(0),
        _ => {
            if allow_ask {
                open_exit_dialog(app);
            } else {
                // 非用户主动路径（防误触兜底）：隐藏。
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
        }
    }
}

/// 注入退出确认 overlay 到主窗（无新窗口，不替换现有内容）。
fn open_exit_dialog(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("main") {
        win.eval(include_str!("exit-overlay.js")).ok();
    }
}

/// 从 sidecar 的 boot.state 读 exitAction（settings 同源）。
/// v6 Task 3.1（ADR 0006 v5）：chrome.init 已随 EAC 自定义面删除，
/// 退出策略改由 boot.state 承载（壳最小控制面的唯一信息接口）。
async fn sidecar_exit_action(_app: &tauri::AppHandle) -> Option<String> {
    let state = BRIDGE.get_or_init(|| BridgeState {
        sidecar: Arc::new(AMutex::new(None)),
    });
    let sc = state.sidecar.lock().await.clone()?;
    // 关窗路径同步等这个返回值（prevent_close 已拦），sidecar 活着但挂死时
    // 走 call 默认 180s 超时 = 用户点 X 后界面最长僵死 3 分钟。exitAction
    // 只是读配置，2s 足够；失败按无配置走默认策略。
    let r = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        sc.call("boot.state", serde_json::json!({})),
    )
    .await
    .ok()?
    .ok()?;
    r.get("exitAction")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

// ---------------------------------------------------------------------------
// 原生目录选择（SYNC-004 · __DSH_DIRECTORY_PICKER__.pick 的 L1 能力源）
//
// 官方语义（apps/desktop/src/directory-picker.ts:12,24）：主进程
// dialog.showOpenDialog(properties=['openDirectory','createDirectory'])，经
// preload（preload-app.ts:75-77）以 ipcRenderer.invoke(DESKTOP_IPC.directoryPick)
// 暴露为 window.__DSH_DIRECTORY_PICKER__.pick(): Promise<string | null> ——
// 用户选定 → 目录绝对路径字符串；取消 → null。消费者
// dsh-client-ui-directory-picker-native/lib/client.js:63 优先取本桥，缺失才
// 回退 Web 浏览式选目录（ctx.uiWorkspace.pickDirectory()）。
//
// 实现选型（任务卡方案优先级）：tauri-plugin-dialog（官方 dialog 插件，内部
// 即 rfd 0.16 的 IFileDialog 封装）—— 不引第二套原生对话框栈。与官方选项的
// 映射：openDirectory → FileDialogBuilder::pick_folder（IFileDialog 的
// FOS_PICKFOLDERS 文件夹模式）；createDirectory → 该模式自带「新建文件夹」
// 按钮（IFileDialog 文件夹模式默认提供，无需独立开关）。差异：官方传了
// 父窗口（应用内模态），本壳弹顶层对话框（非模态）—— 本壳主窗是无装饰
// 自绘标题栏窗，模态阻塞主窗会连自绘关闭钮一起失效，权衡后不设父窗。
//
// 线程模型（任务卡硬约束：绝不阻塞主线程）：禁用 blocking_pick_folder ——
// 它内部 run_on_main_thread + 通道等待，在异步/主线程上下文会 panic。
// 这里用异步 pick_folder(回调) + oneshot channel：插件在主线程事件循环上
// 只做「调度」（desktop.rs:172-182），IFileDialog 在独立线程模态运行并以
// 回调回传 FilePath，主线程与 WS 任务全程不被卡；WS 连接任务在
// handle_conn 里 await oneshot（tokio 异步等待，非忙等），等待期间出站
// 通知（win.maximized / win.host-paths 等）照常送达页面。
//
// 隔离验证钩子（任务卡「L1 注入钩子模拟两态」条款，仿 SYNC-003 的
// DSH_HOST_PATHS_STAGE 先例）：自动化环境（Edge headless + CDP）无法点击
// 原生对话框，故提供环境变量驱动的两态模拟 —— 只在显式设置时生效，
// 默认（未设置）恒走真实原生对话框，生产路径零影响：
//   DSH_DIRECTORY_PICK_STAGE=<目录> → 不弹框，校验该目录真实存在后模拟
//                                     「用户选定它」（绝无伪造：路径必须
//                                     是真实存在的目录）；
//   DSH_DIRECTORY_PICK_CANCEL=1     → 不弹框，模拟「用户取消」（null）。
// 两者同设时 STAGE 优先。L1 日志显式标注 (stage)，与真实轨迹可区分。
// ---------------------------------------------------------------------------

/// directory.pick 的 L1 实现：Some(绝对路径) = 用户选定；None = 取消/失败。
/// 由 handle_shell_method 的 "directory.pick" 分支 await。
async fn pick_directory(app: &tauri::AppHandle) -> Option<String> {
    // —— 隔离验证钩子（见上方注释；未设置环境变量时完全惰性）——
    if let Ok(stage) = std::env::var("DSH_DIRECTORY_PICK_STAGE") {
        let dir = stage.trim().to_string();
        // 绝不伪造：必须是真实存在的目录，否则按取消语义返回 None 并告警。
        let is_real_dir = std::fs::metadata(&dir).map(|m| m.is_dir()).unwrap_or(false);
        if !is_real_dir {
            eprintln!(
                "[shell] directory.pick (stage): staged path is not an existing directory: {}",
                dir
            );
            return None;
        }
        eprintln!("[shell] directory.pick (stage): simulated pick -> {}", dir);
        return Some(dir);
    }
    if std::env::var("DSH_DIRECTORY_PICK_CANCEL").as_deref() == Ok("1") {
        eprintln!("[shell] directory.pick (stage): simulated cancel -> null");
        return None;
    }

    // —— 真实原生对话框（tauri-plugin-dialog · 异步回调 + oneshot 回传）——
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = oneshot::channel::<Option<String>>();
    eprintln!("[shell] directory.pick: native folder dialog open (awaiting user)");
    app.dialog().file().pick_folder(move |picked| {
        // 回调在插件的工作线程上执行（desktop.rs pick_folder），不占主线程。
        let resolved = picked
            .as_ref()
            .and_then(|p| p.as_path())
            .map(|p| p.to_string_lossy().into_owned());
        match &resolved {
            Some(path) => println!("[shell] directory.pick: picked {}", path),
            None => println!("[shell] directory.pick: cancelled by user"),
        }
        // 对话框关闭即回传；接收端（WS 任务）若已消失则发送失败被忽略。
        let _ = tx.send(resolved);
    });
    rx.await.ok().flatten()
}

// ---------------------------------------------------------------------------
// 侧栏浏览器 guest 租约（SYNC-006 · dshDesktop.browser 的 L1 能力源）
//
// 官方契约（dsh-client-ui-sidebar-browser/lib/types/types.d.ts:16-23，逐字段）：
//   acquire(workspace) → Promise<DesktopBrowserReservation{lease, partition}>
//   release(lease)     → Promise<void>（guest 已销毁后才返回；幂等）
//   onOpenRequested(lease, listener) → () => void（disposer）
// 官方主进程（browser-guests.ts）持有 guest、执行固定隔离策略、租约制；guest
// 的可见载体由渲染层 <webview> 标签（Electron 专有）呈现。WebView2 无 webview
// 标签，本壳的等价物（任务卡两方案的落地形态，调研证据见任务自证材料）：
//   L1（本文件）= 主窗内「子 webview」作为 guest：
//     - Window::add_child(WebviewBuilder, pos, size) —— tauri 2.11.5 的多
//       webview 能力，被 "unstable" feature 门控；tauri-runtime-wry 2.11.4 的
//       unstable = []（空 feature），启用它不新增依赖、不动 Cargo.lock 的
//       tauri 2.11.5 / wry 0.55.1 / tao 0.35.3 锁定版本。
//     - guest 带 per-workspace data_directory（WebView2 用户数据目录）= 官方
//       partition 的存储隔离语义：同 workspace → 同 partition（跨 acquire 持久，
//       登录态/cookie 存活）；不同 workspace → 不同目录（互不可见）。
//     - 固定隔离策略（on_navigation）：只放行 about:blank（初始页）与非应用
//       自身源的 http(s)；其余一律取消（file:/data:/应用源等）。应用源与
//       官方消费者文案 error.application-origin（「不能在嵌入浏览器中打开
//       DSH 应用自身」）同一纪律。
//   L1.5（bridge.ts，页面层）= <webview> 宿主元素适配：消费者
//     （client.js ElectronWebViewImpl，:1332-1344）创建的 <webview> 是
//     HTMLUnknownElement（customElements.define 拒绝无连字符标签名，无法做成
//     自定义元素），桥在其上挂 Electron 同名 API（loadURL/goBack/canGoBack/
//     getURL/...），并把 bounds/命令上报 L1、把 L1 事件翻译成 Electron 同名
//     DOM 事件 —— 见 bridge.ts SYNC-006 节。
//
// 通道（handle_shell_method 拦截域，全部不经 sidecar）：
//   call  browser.acquire         {workspace, generation} → {lease, partition}
//   call  browser.release         {lease} → {ok:true}（幂等；销毁后广播
//                                  browser.guest-destroyed）
//   call  browser.guest-load-url  {lease, url} → {ok:true}（http(s) 白名单）
//   call  browser.guests.state    {} → {guests:[…], webviewCount}（L1 内省面，
//                                  不上桥面，语义同 sidecar 的 shortcuts.state；
//                                  验证通道的「webview 消失」观测点）
//   send  browser.guest-cmd       {lease, cmd: goBack|goForward|reload|clearHistory}
//   send  browser.guest-bounds    {lease, x, y, w, h}（逻辑像素，页面视口系 =
//                                 窗口客户区系；w/h<1 即隐藏 guest 不销毁 ——
//                                 keepMounted 语义：切页隐藏保状态）
//   send  browser.guest-attach    {lease}（宿主元素挂载 → 回推 bootstrap
//                                  dom-ready；Electron 首个 dom-ready 的等价物）
//   send  browser.page-hello      {generation}（页面世代：主文档重载/导航重建
//                                  后，旧文档的租约已无人持有 —— 官方由
//                                  webContents destroyed 收敛，本壳以世代比对
//                                  等价回收，防孤儿 guest 泄漏）
//   通知帧（shell_notify 广播，仅主窗页面消费；guest 无桥注入）：
//   browser.guest-event    {lease, event, url, title, loading, canGoBack,
//                           canGoForward, …事件载荷}（shim 缓存源 + DOM 事件翻译）
//   browser.open-requested {lease, url}（guest window.open/target=_blank 的
//                           http(s) 请求；实际开窗恒 Deny —— 官方语义：URL 推给
//                           消费者自行决定打开方式）
//   browser.guest-destroyed {lease}
//
// 已知局限（如实记录，见任务自证材料）：
//   1. canGoBack/canGoForward 来自 L1 导航深度计数（WebView2/wry 未暴露
//      history 栈查询），清史语义由 clearHistory 命令近似；
//   2. SPA pushState 导航不产生 NavigationStarting/ContentLoading → URL 不
//      上报（Electron did-navigate-in-page 无对应事件源）；
//   3. wry 的 NavigationCompleted 不区分成功/失败 → did-fail-load 无真实
//      错误码来源，加载失败呈现为空白页而非错误卡片；
//   4. 同一 workspace 并发第二个 guest 用 <partition>-<n> 目录（WebView2 每
//      环境独占用户数据目录；基名目录留给稳态单 guest 保持久性）。
// ---------------------------------------------------------------------------

/// 租约/标签序号（lease 唯一性的第二因子，纳秒时间戳防跨进程撞号）。
static GUEST_SEQ: AtomicU64 = AtomicU64::new(0);

/// 页面世代（browser.page-hello 上报；世代不符的 guest 在 hello 时回收）。
static PAGE_GENERATION: OnceLock<RwLock<String>> = OnceLock::new();

/// guest 登记：lease → 条目。回调（on_navigation 等运行在 WebView2 线程）与
/// WS 任务共享；条目里的 Webview 句柄线程安全（dispatcher 模型）。
struct GuestEntry {
    #[allow(dead_code)]
    label: String,
    partition: String,
    workspace: String,
    generation: String,
    /// 同 partition 并发 guest 的目录后缀（0 = 基名 <partition>）。
    dir_suffix: u32,
    /// 宿主元素是否声明了可见 bounds（guest 是否 show 中）。
    visible: bool,
    /// 导航深度计数（canGoBack/canGoForward 的近似来源）。
    back_depth: u32,
    max_depth: u32,
    /// guest-cmd goBack/goForward 预置方向，下一次放行的 NavigationStarting 消费。
    pending_dir: i8,
    /// 最近一次放行导航的 URL / 文档标题 / 加载态（状态帧的缓存源）。
    last_url: String,
    last_title: String,
    loading: bool,
    webview: tauri::Webview,
}

static BROWSER_GUESTS: OnceLock<std::sync::Mutex<HashMap<String, GuestEntry>>> = OnceLock::new();

fn browser_guests() -> &'static std::sync::Mutex<HashMap<String, GuestEntry>> {
    BROWSER_GUESTS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// FNV-1a 64：workspace → 稳定 partition 目录名（跨进程/跨版本稳定，不引入
/// 哈希依赖）。
fn fnv1a64(data: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_3ce4_8422_2325;
    for byte in data.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn browser_partition_for_workspace(workspace: &str) -> String {
    format!("browser-guest-{:016x}", fnv1a64(workspace))
}

/// guest 用户数据目录：<app_data_dir>/browser-guests/<名称>。
fn browser_guest_data_dir(app: &tauri::AppHandle, dir_name: &str) -> Option<PathBuf> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|base| base.join("browser-guests").join(dir_name))
}

/// 应用自身源判定（隔离策略第二条款：guest 绝不承载内核 Web UI）。
fn is_app_origin_url(url: &str) -> bool {
    match (current_web_url(), tauri::Url::parse(url)) {
        (Some(app_url), Ok(parsed)) => tauri::Url::parse(&app_url)
            .map(|a| a.origin().ascii_serialization() == parsed.origin().ascii_serialization())
            .unwrap_or(false),
        _ => false,
    }
}

/// guest 隔离策略（唯一裁决点）：about:blank（初始页）+ 非应用源的 http(s)。
fn guest_navigation_allowed(url: &str) -> bool {
    if url == "about:blank" {
        return true;
    }
    matches!(
        tauri::Url::parse(url).map(|u| u.scheme().to_string()),
        Ok(ref s) if s == "http" || s == "https"
    ) && !is_app_origin_url(url)
}

/// 广播一帧到页面（所有 WS 连接；guest 无桥注入，实际只有主窗页面消费）。
fn push_guest_frame(frame: Value) {
    let _ = shell_notify().send(frame);
}

/// 销毁 guest（幂等）：不存在返回 false；存在 → 移除登记 + 关闭 webview +
/// 广播 browser.guest-destroyed。close 走 dispatcher（线程安全），可在任意
/// 任务线程调用。
fn destroy_guest(lease: &str) -> bool {
    let entry = browser_guests()
        .lock()
        .ok()
        .and_then(|mut guests| guests.remove(lease));
    let Some(entry) = entry else {
        return false;
    };
    let _ = entry.webview.close();
    push_guest_frame(serde_json::json!({
        "method": "browser.guest-destroyed",
        "params": { "lease": lease }
    }));
    eprintln!(
        "[shell] browser guest destroyed: lease={} label={}",
        lease, entry.label
    );
    true
}

/// browser.acquire 的 L1 实现：建租约 + 真实创建子 webview guest + 登记。
/// 返回 Err(msg) = JSON-RPC error 回复文案。
fn browser_acquire(app: &tauri::AppHandle, params: &Value) -> Result<Value, String> {
    use tauri::Manager;
    // 官方签名 acquire(workspace: string)：workspace = 已解析的存储账户
    // （消费者 browserWorkspace 产出 "cwd:<path>" / "session:<id>"）。
    let workspace = match params.get("workspace").and_then(|v| v.as_str()) {
        Some(w) if !w.trim().is_empty() => w.to_string(),
        _ => return Err("browser.acquire: workspace must be a non-empty string".into()),
    };
    let generation = params
        .get("generation")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // guest 是主窗的子 webview：主窗必须存在。
    let Some(window) = app.get_window("main") else {
        return Err("browser.acquire: main window unavailable".into());
    };

    let partition = browser_partition_for_workspace(&workspace);
    let seq = GUEST_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let lease = format!(
        "dsh-browser-lease-{}-{}",
        seq,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0)
    );
    let label = format!("browser-guest-{}", seq);

    // 目录后缀分配：同 partition 的存活 guest 各占一个后缀（WebView2 每
    // 环境独占用户数据目录）；最低空闲后缀优先 —— 稳态单 guest 恒用基名
    // 目录，跨 acquire 持久（登录态/cookie 存活）。
    let dir_suffix = {
        let guests = browser_guests()
            .lock()
            .map_err(|_| "browser.acquire: guest table poisoned".to_string())?;
        let mut n = 0u32;
        while guests
            .values()
            .any(|g| g.partition == partition && g.dir_suffix == n)
        {
            n += 1;
        }
        n
    };
    let dir_name = if dir_suffix == 0 {
        partition.clone()
    } else {
        format!("{}-{}", partition, dir_suffix)
    };
    let Some(data_dir) = browser_guest_data_dir(app, &dir_name) else {
        return Err("browser.acquire: app data dir unavailable".into());
    };

    // 子 webview guest：初始 about:blank；hidden 等宿主元素给 bounds。
    let lease_nav = lease.clone();
    let lease_win = lease.clone();
    let lease_load = lease.clone();
    let lease_title = lease.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        label.clone(),
        tauri::WebviewUrl::External(tauri::Url::parse("about:blank").expect("static url")),
    )
    .data_directory(data_dir)
    // 固定隔离策略（放行 = true）。about:blank 不计数/不发事件（非用户导航）。
    .on_navigation(move |url| {
        let allowed = guest_navigation_allowed(url.as_str());
        if allowed && url.as_str() != "about:blank" {
            let url_string = url.as_str().to_string();
            if let Ok(mut guests) = browser_guests().lock() {
                if let Some(entry) = guests.get_mut(&lease_nav) {
                    match entry.pending_dir {
                        -1 => {
                            entry.back_depth = entry.back_depth.saturating_sub(1);
                            entry.pending_dir = 0;
                        }
                        1 => {
                            entry.back_depth += 1;
                            if entry.max_depth < entry.back_depth {
                                entry.max_depth = entry.back_depth;
                            }
                            entry.pending_dir = 0;
                        }
                        _ => {
                            entry.back_depth += 1;
                            // 新导航截断前进栈（浏览器同款语义）。
                            entry.max_depth = entry.back_depth;
                        }
                    }
                    entry.last_url = url_string.clone();
                    entry.loading = true;
                    push_guest_frame(serde_json::json!({
                        "method": "browser.guest-event",
                        "params": {
                            "lease": lease_nav,
                            "event": "did-start-navigation",
                            "url": entry.last_url,
                            "title": entry.last_title,
                            "loading": true,
                            "canGoBack": entry.back_depth > 1,
                            "canGoForward": entry.back_depth < entry.max_depth,
                            "isMainFrame": true,
                        }
                    }));
                }
            }
        }
        allowed
    })
    // 官方 onOpenRequested 的事件源（types.d.ts:10-14）：guest 请求开 http(s)
    // 页 → 推给消费者；guest 自身永不弹原生窗（Deny），打开方式由消费者决定。
    .on_new_window(move |url, _features| {
        if guest_navigation_allowed(url.as_str()) && url.as_str() != "about:blank" {
            push_guest_frame(serde_json::json!({
                "method": "browser.open-requested",
                "params": { "lease": lease_win, "url": url.as_str() }
            }));
        }
        tauri::webview::NewWindowResponse::Deny
    })
    // wry/WebView2 映射：ContentLoading → Started（≈ 提交 + DOM 就绪），
    // NavigationCompleted → Finished。
    .on_page_load(move |_webview, payload| {
        let url = payload.url().as_str().to_string();
        match payload.event() {
            tauri::webview::PageLoadEvent::Started => {
                if url == "about:blank" {
                    return;
                }
                // 提交点：did-navigate（Electron 同名事件，消费者 observe(true) 的
                // 触发器）+ dom-ready（每文档一次）。
                for event in ["did-navigate", "dom-ready"] {
                    push_guest_frame(serde_json::json!({
                        "method": "browser.guest-event",
                        "params": { "lease": lease_load, "event": event, "url": url }
                    }));
                }
            }
            tauri::webview::PageLoadEvent::Finished => {
                if url == "about:blank" {
                    return;
                }
                push_guest_frame(serde_json::json!({
                    "method": "browser.guest-event",
                    "params": { "lease": lease_load, "event": "did-stop-loading", "loading": false }
                }));
            }
        }
    })
    .on_document_title_changed(move |_webview, title| {
        if let Ok(mut guests) = browser_guests().lock() {
            if let Some(entry) = guests.get_mut(&lease_title) {
                entry.last_title = title.clone();
            }
        }
        push_guest_frame(serde_json::json!({
            "method": "browser.guest-event",
            "params": { "lease": lease_title, "event": "page-title-updated", "title": title }
        }));
    });

    // 创建在主窗内（1×1 起步，等宿主元素 bounds；创建完成前占用主线程是
    // tauri add_child 的既定语义 —— 与同步 IPC 命令同代价）。
    let webview = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| format!("browser.acquire: guest webview build failed: {}", e))?;
    let _ = webview.hide();

    let entry = GuestEntry {
        label: label.clone(),
        partition: partition.clone(),
        workspace: workspace.clone(),
        generation,
        dir_suffix,
        visible: false,
        back_depth: 0,
        max_depth: 0,
        pending_dir: 0,
        last_url: String::from("about:blank"),
        last_title: String::new(),
        loading: false,
        webview,
    };
    if let Ok(mut guests) = browser_guests().lock() {
        guests.insert(lease.clone(), entry);
    }
    eprintln!(
        "[shell] browser.acquire: lease={} label={} partition={} workspace={}",
        lease, label, partition, workspace
    );
    Ok(serde_json::json!({ "lease": lease, "partition": partition }))
}

/// browser.guests.state：L1 内省面（不上桥面；验证通道观测点）。
fn browser_guests_state(app: &tauri::AppHandle) -> Value {
    use tauri::Manager;
    let guests = browser_guests()
        .lock()
        .map(|guests| {
            guests
                .iter()
                .map(|(lease, g)| {
                    serde_json::json!({
                        "lease": lease,
                        "label": g.label,
                        "partition": g.partition,
                        "workspace": g.workspace,
                        "generation": g.generation,
                        "visible": g.visible,
                        "url": g.last_url,
                        "title": g.last_title,
                        "loading": g.loading,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    // 主窗内 webview 总数（主 webview + 存活 guest）——「webview 消失」的
    // 直接观测点（release 后回落）。
    let webview_count = app
        .get_window("main")
        .map(|w| w.webviews().len())
        .unwrap_or(0);
    serde_json::json!({ "guests": guests, "webviewCount": webview_count })
}

/// 壳层方法拦截：返回 Some(reply) = 已处理并给出 JSON-RPC 完整回复；
/// None = 已消费（send 型，无回复）；Err(()) = 非壳层方法 → 转发 sidecar。
async fn handle_shell_method(
    app: &tauri::AppHandle,
    method: &str,
    params: &Value,
    id: &Value,
) -> Result<Option<String>, ()> {
    use tauri::Manager;
    let reply =
        |result: Value| serde_json::json!({"jsonrpc":"2.0","id":id,"result":result}).to_string();
    // JSON-RPC error 回复（形态与 sidecar 路径一致：ws-jsonrpc-client 以
    // Error(message) reject，页面 Promise 走 catch）。
    let reply_error = |message: String| {
        serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":message}})
            .to_string()
    };
    match method {
        "win.minimize" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.minimize();
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.toggle-maximize" => {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_maximized().unwrap_or(false) {
                    let _ = w.unmaximize();
                    // 还原位损坏防御（issue：副屏/DPI 变化污染 Windows 保存的
                    // 还原位，还原后窗口只剩极窄一条）：还原后低于 OS 下限
                    // （480×360）→ 立即按当前显示器 work area 重设合理尺寸。
                    if let Ok(p) = w.inner_size() {
                        let scale = w.scale_factor().unwrap_or(1.0);
                        let lw = f64::from(p.width) / scale;
                        let lh = f64::from(p.height) / scale;
                        if lw < min_inner_w() || lh < min_inner_h() {
                            let (nw, nh, pos, _) = resolved_initial_bounds(app);
                            let _ = w.set_size(tauri::LogicalSize::new(nw, nh));
                            if let Some((x, y)) = pos {
                                let _ = w.set_position(tauri::LogicalPosition::new(x, y));
                            }
                            eprintln!(
                                "[shell] corrupt restore bounds ({}x{} logical), reset to {}x{}",
                                lw, lh, nw, nh
                            );
                        }
                    }
                } else {
                    let _ = w.maximize();
                }
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.close" => {
            // SYNC-001：keyboard.closeWindow(revision) 复用本通道。EAC 无快捷键
            // 配置修订存储，不做官方 keyboard.ts:97-102 的「revision 仍当前才
            // 关窗」校验 —— 收到的 revision 仅在此记录，便于排查与未来对账。
            if let Some(rev) = params.get("revision") {
                if !rev.is_null() {
                    eprintln!("[shell] win.close (shortcuts revision: {})", rev);
                }
            }
            // 退出策略（= Electron exitAction）：minimize→隐藏；quit→退出；
            // ask→弹出独立退出选择窗口。
            apply_exit_policy(app, true).await;
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.close-dialog" => {
            // 移除 overlay，恢复主窗
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("window.__dshExitOverlay&&window.__dshExitOverlay.dismiss()");
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.close-force" => {
            app.exit(0);
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.hide-and-close-dialog" => {
            // 最小化到托盘：隐藏主窗 + 移除 overlay，不恢复
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
                let _ = w.eval("window.__dshExitOverlay&&window.__dshExitOverlay.dismiss()");
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.is-maximized" => {
            let m = app
                .get_webview_window("main")
                .map(|w| w.is_maximized().unwrap_or(false))
                .unwrap_or(false);
            Ok(Some(reply(serde_json::json!({"maximized":m}))))
        }
        "win.start-dragging" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.start_dragging();
            }
            Ok(None) // send 型
        }
        "win.viewport-beat" => {
            // 桥心跳（5s）随帧上报页面视口；仅消费主窗报文（浮窗比对无意义）。
            // 见 heal_viewport_desync 顶部注释：视口失同步检测 + 自愈。
            let src = params.get("src").and_then(|v| v.as_str()).unwrap_or("main");
            if src == "main" {
                let w = params.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = params.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let dpr = params.get("dpr").and_then(|v| v.as_f64()).unwrap_or(0.0);
                if w > 0.0 && h > 0.0 && dpr > 0.0 {
                    heal_viewport_desync(app, w, h, dpr);
                }
            }
            Ok(None) // send 型
        }
        "win.reload" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("location.reload()");
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.devtools" => {
            if let Some(w) = app.get_webview_window("main") {
                if w.is_devtools_open() {
                    let _ = w.close_devtools();
                } else {
                    let _ = w.open_devtools();
                }
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.fullscreen" => {
            if let Some(w) = app.get_webview_window("main") {
                let fs = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!fs);
            }
            Ok(Some(reply(serde_json::json!({"ok":true}))))
        }
        "win.open-browser" => {
            let result = match current_web_url() {
                Some(url) => open_external(&url).await,
                None => Err("web URL unavailable".into()),
            };
            if let Err(error) = &result {
                eprintln!("[shell] open browser failed: {}", error);
            }
            Ok(Some(reply(native_action_result(result))))
        }
        // v6 Task 3.3：外链打开（dsh-client-file-changes 消费）。
        // L2 只做语义转发，实际执行仍走 L1 的 ShellExecuteW。
        "shell.open-external" => {
            let url = params.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let result = open_external(url).await;
            Ok(Some(reply(match result {
                Ok(()) => serde_json::json!({"ok":true}),
                Err(error) => serde_json::json!({"ok":false,"error":error}),
            })))
        }
        // v6 Task 3.3：文件打开（dsh-client-file-changes 消费）。
        // 安全契约：必须先经 sidecar 的 files.authorize-open 做路径归一化 +
        // 白名单/危险扩展名校验，拿到授权路径后才交给 ShellExecuteW。
        // 不得跳过授权直接 open_native_target —— ShellExecuteW 无二次校验。
        "files.open" => {
            let state = BRIDGE.get_or_init(|| BridgeState {
                sidecar: Arc::new(AMutex::new(None)),
            });
            let sidecar = state.sidecar.lock().await.clone();
            let Some(sidecar) = sidecar else {
                return Ok(Some(reply(
                    serde_json::json!({"ok":false,"error":"sidecar not running"}),
                )));
            };
            let authorized = match sidecar.call("files.authorize-open", params.clone()).await {
                Ok(value) => value,
                Err(error) => {
                    return Ok(Some(reply(serde_json::json!({"ok":false,"error":error}))))
                }
            };
            if authorized.get("ok").and_then(|v| v.as_bool()) != Some(true) {
                return Ok(Some(reply(authorized)));
            }
            let Some(target) = authorized.get("path").and_then(|v| v.as_str()) else {
                return Ok(Some(reply(
                    serde_json::json!({"ok":false,"error":"authorized path missing"}),
                )));
            };
            Ok(Some(reply(match open_native_target(target).await {
                Ok(()) => serde_json::json!({"ok":true}),
                Err(error) => serde_json::json!({"ok":false,"error":error}),
            })))
        }
        "log.page-error" => {
            let msg = params.get("message").and_then(|v| v.as_str()).unwrap_or("");
            eprintln!("[page-error] {}", msg);
            Ok(None)
        }
        // SYNC-002：官方 __DSH_LOCALE__ 面（preload-app.ts:102-105）。localeBootstrap
        //（官方 main.ts:703）返回 {languages, preference}；languages 给 L1 系统标签
        //（页面侧 navigator.languages 由桥合并优先），preference 透传持久化值
        //（string | null，null = 自动选择）。
        "locale.bootstrap" => {
            let preference = load_locale_preference();
            let languages = vec![system_language_tag()];
            Ok(Some(reply(serde_json::json!({
                "languages": languages,
                "preference": preference,
            }))))
        }
        // localeChanged（官方 main.ts:711）：send 型 fire-and-forget。校验官方
        // id 形态后持久化 preference + 重建托盘菜单文案（官方的应用菜单/平台页
        // 刷新在 EAC 无对应面）。无效输入静默忽略（官方对非 string 亦直接 return）。
        "locale.changed" => {
            if let Some(next) = params.get("locale").and_then(|v| v.as_str()) {
                if locale_tag_is_well_formed(next) {
                    save_locale_preference(next);
                    eprintln!("[shell] locale.changed: {}", next);
                    rebuild_tray_menu(app);
                }
            }
            Ok(None) // send 型
        }
        // SYNC-004：官方 __DSH_DIRECTORY_PICKER__ 面（preload-app.ts:75-77）。
        // 官方 invoke(DESKTOP_IPC.directoryPick) → Promise<string | null>：
        // 用户选定 → 目录绝对路径字符串；取消 → null。回包 result 直接承载
        // 该标量（string | null），桥侧原样透传给消费者（见 bridge.ts）。
        // await pick_directory 是 tokio 异步等待（oneshot），不阻塞任何线程；
        // 等待期间本连接的后续入站帧排队，出站通知照常送达（见 pick_directory 注释）。
        "directory.pick" => {
            let picked = pick_directory(app).await;
            Ok(Some(reply(match picked {
                Some(path) => serde_json::json!(path),
                None => serde_json::Value::Null,
            })))
        }
        // SYNC-006：官方 dshDesktop.browser 面（types.d.ts:16-23）的 L1 通道。
        // 通道语义与隔离策略见文件顶部「侧栏浏览器 guest 租约」节注释。
        "browser.acquire" => match browser_acquire(app, params) {
            Ok(reservation) => Ok(Some(reply(reservation))),
            Err(message) => Ok(Some(reply_error(message))),
        },
        // 官方语义：release(lease) 在 guest 销毁后返回；幂等（重复 release /
        // 未知 lease → ok:true + destroyed:false，不报错 —— 消费者 dropGuest
        // 与 destroyed 事件可能竞争双发）。
        "browser.release" => {
            let Some(lease) = params.get("lease").and_then(|v| v.as_str()) else {
                return Ok(Some(reply_error(
                    "browser.release: lease must be a string".into(),
                )));
            };
            let destroyed = destroy_guest(lease);
            Ok(Some(reply(
                serde_json::json!({ "ok": true, "destroyed": destroyed }),
            )))
        }
        // guest 导航（call 型）：隔离策略与 on_navigation 同一条纪律的另一入口
        //（地址栏 loadURL）。navigate 走 Webview::navigate（提交后事件链由
        // on_navigation / on_page_load 续上）。
        "browser.guest-load-url" => {
            let Some(lease) = params.get("lease").and_then(|v| v.as_str()) else {
                return Ok(Some(reply_error(
                    "browser.guest-load-url: lease must be a string".into(),
                )));
            };
            let Some(url) = params.get("url").and_then(|v| v.as_str()) else {
                return Ok(Some(reply_error(
                    "browser.guest-load-url: url must be a string".into(),
                )));
            };
            if !guest_navigation_allowed(url) || url == "about:blank" {
                return Ok(Some(reply_error(
                    "browser.guest-load-url: only http(s) URLs outside the app origin are allowed"
                        .into(),
                )));
            }
            let parsed = match tauri::Url::parse(url) {
                Ok(parsed) => parsed,
                Err(_) => {
                    return Ok(Some(reply_error(
                        "browser.guest-load-url: url failed to parse".into(),
                    )))
                }
            };
            let guests = browser_guests().lock().ok();
            let Some(guests) = guests else {
                return Ok(Some(reply_error(
                    "browser.guest-load-url: guest table poisoned".into(),
                )));
            };
            let Some(entry) = guests.get(lease) else {
                return Ok(Some(reply_error(
                    "browser.guest-load-url: unknown lease".into(),
                )));
            };
            match entry.webview.navigate(parsed) {
                Ok(()) => Ok(Some(reply(serde_json::json!({ "ok": true })))),
                Err(e) => Ok(Some(reply_error(format!("browser.guest-load-url: {}", e)))),
            }
        }
        // guest 导航命令（send 型）。goBack/goForward 先对账深度计数（与 UI
        // 按钮态同源），越界请求直接忽略；历史回退/前进经 guest 内
        // history.back()/forward()（wry 未暴露原生 GoBack/GoForward）。
        "browser.guest-cmd" => {
            let Some(lease) = params.get("lease").and_then(|v| v.as_str()) else {
                return Ok(None);
            };
            let cmd = params.get("cmd").and_then(|v| v.as_str()).unwrap_or("");
            let guests = browser_guests().lock().ok();
            let Some(mut guests) = guests else {
                return Ok(None);
            };
            let Some(entry) = guests.get_mut(lease) else {
                return Ok(None);
            };
            match cmd {
                "goBack" if entry.back_depth > 1 => {
                    entry.pending_dir = -1;
                    let _ = entry.webview.eval("history.back()");
                }
                "goForward" if entry.back_depth < entry.max_depth => {
                    entry.pending_dir = 1;
                    let _ = entry.webview.eval("history.forward()");
                }
                "reload" => {
                    entry.loading = true;
                    let _ = entry.webview.eval("location.reload()");
                }
                // 官方 observeReady 首文档后的 clearHistory：WebView2/wry 无
                // history 栈清理 API —— 以深度计数归一近似（首个真实文档即为
                // 历史起点，与官方「清掉 about:blank 起点」的语义一致）。
                "clearHistory" => {
                    entry.back_depth = 1;
                    entry.max_depth = 1;
                    entry.pending_dir = 0;
                }
                _ => { /* 未知/越界命令：忽略（不伪造成功） */ }
            }
            Ok(None)
        }
        // 宿主元素 bounds（send 型）：逻辑像素（页面视口系 = 窗口客户区系）。
        // w/h<1 → 隐藏不销毁（keepMounted：切页保状态）；>0 → set_bounds + show。
        "browser.guest-bounds" => {
            let Some(lease) = params.get("lease").and_then(|v| v.as_str()) else {
                return Ok(None);
            };
            let num = |key: &str| params.get(key).and_then(|v| v.as_f64()).unwrap_or(0.0);
            let (x, y, w, h) = (num("x"), num("y"), num("w"), num("h"));
            let guests = browser_guests().lock().ok();
            let Some(mut guests) = guests else {
                return Ok(None);
            };
            let Some(entry) = guests.get_mut(lease) else {
                return Ok(None);
            };
            if !w.is_finite() || !h.is_finite() || w < 1.0 || h < 1.0 {
                if entry.visible {
                    entry.visible = false;
                    let _ = entry.webview.hide();
                }
            } else {
                let rect = tauri::Rect {
                    position: tauri::LogicalPosition::new(x, y).into(),
                    size: tauri::LogicalSize::new(w, h).into(),
                };
                let _ = entry.webview.set_bounds(rect);
                if !entry.visible {
                    entry.visible = true;
                    let _ = entry.webview.show();
                }
            }
            Ok(None)
        }
        // 宿主元素挂载（send 型）：回推 bootstrap dom-ready —— Electron 的首个
        // dom-ready（about:blank 文档）等价物。事件时序：消费者 attach 监听器
        // 后才 present（挂载），此帧必然晚于监听器就绪；真实文档的 dom-ready
        // 由 on_page_load 的 ContentLoading 续上。
        "browser.guest-attach" => {
            let Some(lease) = params.get("lease").and_then(|v| v.as_str()) else {
                return Ok(None);
            };
            if let Ok(guests) = browser_guests().lock() {
                if let Some(entry) = guests.get(lease) {
                    push_guest_frame(serde_json::json!({
                        "method": "browser.guest-event",
                        "params": {
                            "lease": lease,
                            "event": "dom-ready",
                            "url": entry.last_url,
                            "title": entry.last_title,
                            "loading": entry.loading,
                            "canGoBack": entry.back_depth > 1,
                            "canGoForward": entry.back_depth < entry.max_depth,
                        }
                    }));
                }
            }
            Ok(None)
        }
        // 页面世代（send 型）：新文档报到即回收旧世代 guest（官方由 webContents
        // destroyed 收敛；本壳以世代比对等价，防页面重载孤儿泄漏）。
        "browser.page-hello" => {
            let Some(generation) = params.get("generation").and_then(|v| v.as_str()) else {
                return Ok(None);
            };
            if generation.is_empty() {
                return Ok(None);
            }
            let changed = match PAGE_GENERATION
                .get_or_init(|| RwLock::new(String::new()))
                .write()
            {
                Ok(mut slot) => {
                    let changed = slot.as_str() != generation;
                    *slot = generation.to_string();
                    changed
                }
                Err(_) => false,
            };
            if changed {
                let stale: Vec<String> = match browser_guests().lock() {
                    Ok(guests) => guests
                        .iter()
                        .filter(|(_, g)| g.generation != generation)
                        .map(|(lease, _)| lease.clone())
                        .collect(),
                    Err(_) => Vec::new(),
                };
                for lease in stale {
                    eprintln!(
                        "[shell] browser page generation changed: reclaiming {}",
                        lease
                    );
                    destroy_guest(&lease);
                }
            }
            Ok(None)
        }
        // L1 内省面（不上桥面；验证通道观测点，语义同 sidecar 的 shortcuts.state）。
        "browser.guests.state" => Ok(Some(reply(browser_guests_state(app)))),
        _ => Err(()),
    }
}

/// 仅放行 http(s)（对齐 Electron 侧 will-navigate/openExternal 的外链纪律）。
fn is_safe_external_url(url: &str) -> bool {
    !url.contains('"')
        && tauri::Url::parse(url)
            .map(|parsed| matches!(parsed.scheme(), "http" | "https"))
            .unwrap_or(false)
}

/// AppleScript 字符串转义：反斜杠与双引号（osascript 通知文案用）。
#[cfg(target_os = "macos")]
fn escape_apple_script_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

async fn open_external(url: &str) -> Result<(), String> {
    if !is_safe_external_url(url) {
        return Err("unsafe external URL".into());
    }
    open_native_target(url).await
}

fn native_action_result(result: Result<(), String>) -> Value {
    match result {
        Ok(()) => serde_json::json!({"ok":true}),
        Err(error) => serde_json::json!({"ok":false,"error":error}),
    }
}

async fn run_bounded_command(mut command: Command, label: &str) -> Result<(), String> {
    command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|error| format!("{} spawn failed: {}", label, error))?;
    match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!("{} exited with {}", label, status)),
        Ok(Err(error)) => Err(format!("{} wait failed: {}", label, error)),
        Err(_) => {
            let _ = child.kill().await;
            Err(format!("{} timed out after 10s", label))
        }
    }
}

async fn open_native_target(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::ptr::null;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        if target.contains('\0') {
            return Err("native target contains NUL".into());
        }
        let operation: Vec<u16> = std::ffi::OsStr::new("open")
            .encode_wide()
            .chain(Some(0))
            .collect();
        let target_wide: Vec<u16> = std::ffi::OsStr::new(target)
            .encode_wide()
            .chain(Some(0))
            .collect();
        // ShellExecuteW uses the registered Windows association directly. This keeps
        // Unicode paths and URL query strings out of cmd.exe parsing entirely.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                target_wide.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        return if result > 32 {
            Ok(())
        } else {
            Err(format!("ShellExecuteW failed with code {}", result))
        };
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("xdg-open");
        command.arg(target);
        return run_bounded_command(command, "xdg-open").await;
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(target);
        return run_bounded_command(command, "open").await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = target;
        Err("native open is unsupported on this platform".into())
    }
}

async fn show_system_notification(title: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let script = r#"
$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$safeTitle = [Security.SecurityElement]::Escape($env:DSH_NOTIFY_TITLE)
$safeBody = [Security.SecurityElement]::Escape($env:DSH_NOTIFY_BODY)
$xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$safeTitle</text><text>$safeBody</text></binding></visual></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Deepseek Harness EAC').Show($toast)
"#;
        let mut command = Command::new("powershell");
        command
            .args(["-NoProfile", "-Command", script])
            .env("DSH_NOTIFY_TITLE", title)
            .env("DSH_NOTIFY_BODY", body);
        command.as_std_mut().creation_flags(0x0800_0000);
        return run_bounded_command(command, "PowerShell toast").await;
    }
    #[cfg(target_os = "linux")]
    {
        let mut command = Command::new("notify-send");
        command.args(["--app-name", "Deepseek Harness EAC", title, body]);
        return run_bounded_command(command, "notify-send").await;
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            escape_apple_script_string(body),
            escape_apple_script_string(title)
        );
        let mut command = Command::new("osascript");
        command.args(["-e", &script]);
        return run_bounded_command(command, "osascript notification").await;
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        let _ = (title, body);
        Err("system notification is unsupported on this platform".into())
    }
}

/// Windows 任务栏 Big 图标：tauri 的 set_icon 只走 tao set_window_icon
/// （IconType::Small —— 标题栏/Alt+Tab），而任务栏读取的是 ICON_BIG；
/// tao 注册的窗口 class 不带图标（hIcon NULL）且 tauri 未暴露
/// set_taskbar_icon，任务栏因此显示空白默认图。
/// 处理：从 exe 内嵌资源加载图标（tauri-build 以资源 ID 32512 嵌入的
/// bundle .ico，lib.rs set_icon_with_id），SendMessage(WM_SETICON) 同时
/// 补 Big（任务栏）与 Small（标题栏）。失败仅告警，不阻塞窗口创建。
#[cfg(windows)]
fn apply_taskbar_icon_big(win: &tauri::WebviewWindow) {
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON,
        LR_DEFAULTSIZE, SM_CXSMICON, SM_CYSMICON, WM_SETICON,
    };
    let Ok(hwnd) = win.hwnd() else { return };
    // tauri hwnd() 返回 windows crate 的 HWND(pub *mut c_void)，与 windows-sys 指针同形。
    let hwnd = hwnd.0;
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        if hinstance.is_null() {
            return;
        }
        // MAKEINTRESOURCEW(32512)：资源 ID 按约定即指针值的低 16 位。
        let icon_name: *const u16 = 32512usize as *const u16;
        let hicon_big = LoadImageW(hinstance, icon_name, IMAGE_ICON, 0, 0, LR_DEFAULTSIZE);
        let hicon_small = LoadImageW(
            hinstance,
            icon_name,
            IMAGE_ICON,
            GetSystemMetrics(SM_CXSMICON),
            GetSystemMetrics(SM_CYSMICON),
            0,
        );
        if !hicon_big.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, hicon_big as isize);
        }
        if !hicon_small.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL as usize, hicon_small as isize);
        }
        if hicon_big.is_null() && hicon_small.is_null() {
            eprintln!("[shell] taskbar icon: LoadImage(resource 32512) returned null");
        }
    }
}

/// Windows 任务栏/标题栏图标：tao 注册的窗口 class 不带图标（WNDCLASSEXW
/// 的 hIcon/hIconSm 为 NULL），动态创建的窗口不显式注入图标时，任务栏按钮
/// 会显示空白默认图。default_window_icon 与托盘同源（tauri-build 嵌入的
/// bundle icon）；set_icon 失败只影响观感，不阻塞窗口创建。
fn apply_window_icon(win: &tauri::WebviewWindow, app: &tauri::AppHandle) {
    if let Some(icon) = app.default_window_icon() {
        if let Err(e) = win.set_icon(icon.clone()) {
            eprintln!("[shell] window icon set failed: {}", e);
        }
    }
    #[cfg(windows)]
    apply_taskbar_icon_big(win);
}

/// 回环 WS 准入校验（传入已小写的请求头）。
/// 浏览器跨站 WebSocket 必带发起页 Origin；非浏览器客户端（注入桥在
/// WebView 内运行，同样带 Origin）之外的场景通常不带。规则：
///   - 头部未完整终止（无 \r\n\r\n，窥探缓冲被截断）→ 拒绝；
///   - Origin 缺省 → 放行；有 Origin 则其 host 必须是本机回环名
///     （127.0.0.1 / localhost / [::1] / tauri.localhost，WebView2 的
///     tauri 源与内核 web 源均落在这些名下）；
///   - Host 头同理校验（防 DNS rebinding 把外部域名解析到回环后命中本桥）。
fn ws_handshake_allowed(head_lower: &str) -> bool {
    if !head_lower.contains("\r\n\r\n") {
        return false;
    }
    let allowed_host = |host: &str| -> bool {
        let h = host.trim();
        let h = if let Some(rest) = h.strip_prefix('[') {
            rest.split(']').next().unwrap_or("")
        } else {
            h.split(':').next().unwrap_or("")
        };
        matches!(h, "127.0.0.1" | "localhost" | "::1" | "tauri.localhost")
    };
    for line in head_lower.split("\r\n") {
        if let Some(v) = line.strip_prefix("origin:") {
            let v = v.trim();
            if v.is_empty() {
                continue; // 空 Origin 视同缺省
            }
            // "scheme://host[:port]/path" → host 段；"null"（沙箱 iframe）无 :// 直落 allowed_host 判否。
            let host = v.split("://").nth(1).unwrap_or(v);
            let host = host.split('/').next().unwrap_or("");
            if !allowed_host(host) {
                return false;
            }
        } else if let Some(v) = line.strip_prefix("host:") {
            if !allowed_host(v) {
                return false;
            }
        }
    }
    true
}

#[cfg(test)]
mod ws_handshake_tests {
    use super::ws_handshake_allowed;

    #[test]
    fn allows_loopback_origins_and_missing_origin() {
        let hdr = "get /ws http/1.1\r\nhost: 127.0.0.1:19873\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-key: x=\r\n\r\n";
        assert!(ws_handshake_allowed(hdr));
        assert!(ws_handshake_allowed("get /ws http/1.1\r\nhost: 127.0.0.1:19873\r\norigin: http://127.0.0.1:5173\r\nupgrade: websocket\r\n\r\n"));
        assert!(ws_handshake_allowed("get /ws http/1.1\r\nhost: localhost:19873\r\norigin: http://tauri.localhost\r\nupgrade: websocket\r\n\r\n"));
        assert!(ws_handshake_allowed(
            "get /ws http/1.1\r\norigin: tauri://localhost\r\nupgrade: websocket\r\n\r\n"
        ));
        assert!(ws_handshake_allowed("get /ws http/1.1\r\nhost: [::1]:19873\r\norigin: http://[::1]:19873\r\nupgrade: websocket\r\n\r\n"));
    }

    #[test]
    fn rejects_cross_site_origins_rebinding_and_truncated_headers() {
        assert!(!ws_handshake_allowed("get /ws http/1.1\r\nhost: 127.0.0.1:19873\r\norigin: https://evil.example\r\nupgrade: websocket\r\n\r\n"));
        // DNS rebinding：外部域名解析到回环后 Host 头仍带外部名。
        assert!(!ws_handshake_allowed(
            "get /ws http/1.1\r\nhost: evil.example:19873\r\nupgrade: websocket\r\n\r\n"
        ));
        // 沙箱 iframe 的 null 源。
        assert!(!ws_handshake_allowed("get /ws http/1.1\r\nhost: 127.0.0.1:19873\r\norigin: null\r\nupgrade: websocket\r\n\r\n"));
        // 头部截断（窥探缓冲不满且未见终止符）一律拒绝。
        assert!(!ws_handshake_allowed(
            "get /ws http/1.1\r\norigin: http://127.0.0.1:1"
        ));
    }
}

async fn handle_conn(
    stream: TcpStream,
    state: BridgeState,
    app: tauri::AppHandle,
) -> std::io::Result<()> {
    // 先窥探请求头：决定 WS 升级还是极简 HTTP。（peek 取 &self，不消耗流）
    // peek 是「当前到达多少看多少」：握手头可能分段到达（cookie 头大时
    // 必然 —— 浏览器 cookie 按域名不按端口隔离，127.0.0.1 上内核设置的
    // dsh-auth JWT 会被带回桥端口，握手头轻松超 4KB）。单段 peek + 4KB 缓冲
    // 会把「头未收全」误判为「头部截断」永久拒绝（装机版实测 152 连拒、
    // 页内桥全灭）。循环 peek 至见 \r\n\r\n；16KB 上限 + 3s 超时兜底。
    let (req_path, wants_upgrade, head) = {
        let mut buf = [0u8; 16384];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        let head = loop {
            let n = stream.peek(&mut buf).await?;
            let h = String::from_utf8_lossy(&buf[..n]).to_string();
            if h.contains("\r\n\r\n") {
                break h;
            }
            if n >= buf.len() || std::time::Instant::now() >= deadline {
                // 头超 16KB 或 3s 未收全：拒绝（保持旧截断语义的 fail-closed）。
                eprintln!(
                    "[ws] handshake header incomplete/oversized ({}B peeked), rejecting",
                    n
                );
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        let first = head.lines().next().unwrap_or("");
        let path = first.split_whitespace().nth(1).unwrap_or("/").to_string();
        (
            path,
            head.to_lowercase().contains("upgrade: websocket"),
            head,
        )
    };

    if !wants_upgrade {
        return http_serve(stream, &req_path).await;
    }

    // 回环桥准入：拒绝浏览器跨站 WebSocket —— 本机任意网页可跨站连入并调用
    // 全部壳层/侧车 RPC（files.revert 改文件、boot.stop 停服务等）。
    if !ws_handshake_allowed(&head.to_lowercase()) {
        eprintln!("[ws] rejected cross-origin / rebinding handshake");
        return Ok(());
    }

    let ws = tokio_tungstenite::accept_async(stream)
        .await
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let (mut sink, mut source) = ws.split();

    // 单一写任务：回复与通知统一经 out_tx 出站（SplitSink 不可克隆）。
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let writer_task = tauri::async_runtime::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            let _ = sink.send(m).await;
        }
    });

    // sidecar 通知 + 壳层通知 → 出站。
    let fwd_shell = {
        let mut rx = shell_notify().subscribe();
        let tx = out_tx.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(v) => {
                        let _ = tx.send(Message::Text(v.to_string()));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        })
    };
    let fwd_sidecar = if let Some(sc) = state.sidecar.lock().await.clone() {
        let mut rx = sc.notify_tx.subscribe();
        let tx = out_tx.clone();
        Some(tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(v) => {
                        let _ = tx.send(Message::Text(v.to_string()));
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }))
    } else {
        None
    };

    // SYNC-003：新连接补推当前剪贴板路径快照（页面重载/重连不丢已暂存内容；
    // 空快照不推，页面 pathFor 对未知文件本就落 ''）。
    if let Some(frame) = host_paths_snapshot_frame() {
        let _ = out_tx.send(Message::Text(frame));
    }

    while let Some(msg) = source.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => break,
        };
        if let Message::Text(txt) = msg {
            let Ok(req) = serde_json::from_str::<Value>(&txt) else {
                continue;
            };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let method = req
                .get("method")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_string();
            let params = req.get("params").cloned().unwrap_or(Value::Null);
            // 1) 壳层域：本地拦截（窗口/菜单壳动作/日志 send 帧）。
            match handle_shell_method(&app, &method, &params, &id).await {
                Ok(Some(reply)) => {
                    let _ = out_tx.send(Message::Text(reply));
                    continue;
                }
                Ok(None) => continue,
                Err(()) => {}
            }
            // 2) 其余 → sidecar。
            let sc = state.sidecar.lock().await.clone();
            // sidecar 已死（reader EOF 后槽位仍持旧 Arc）：/died 页的 boot.start
            // 必须经 sidecar 执行。检出死亡即重生
            // + 换槽 + 重接壳层广播订阅。竞态安全：仅当槽位仍指向这个死实例
            // 时才换（并发连接只会有一个真正重生）。
            let sc = match sc {
                Some(s) => {
                    let exited = matches!(s.child.lock().await.try_wait(), Ok(Some(_)));
                    if !exited {
                        Some(s)
                    } else if !is_sidecar_respawn_request(&method) {
                        // 页面心跳或初始化轮询不能驱动崩溃重生；否则 sidecar
                        // 若启动即退，会形成无上限的进程风暴。仅死亡页上的
                        // boot.start 拥有重生权限。
                        Some(s)
                    } else {
                        let mut slot = state.sidecar.lock().await;
                        match slot.clone() {
                            Some(cur) if !Arc::ptr_eq(&cur, &s) => Some(cur),
                            _ => match Sidecar::spawn().await {
                                Ok(fresh) => {
                                    wire_sidecar_notifications(&app, &fresh);
                                    let fresh = Arc::new(fresh);
                                    *slot = Some(fresh.clone());
                                    eprintln!("[sidecar] respawned after unexpected exit");
                                    Some(fresh)
                                }
                                Err(e) => {
                                    eprintln!("[sidecar] respawn failed: {}", e);
                                    Some(s) // 沿用死实例：调用立即失败回报错（语义同旧）
                                }
                            },
                        }
                    }
                }
                None => None,
            };
            let reply = match sc {
                Some(sc) => match sc.call(&method, params).await {
                    Ok(result) => serde_json::json!({"jsonrpc":"2.0","id":id,"result":result}),
                    Err(e) => {
                        serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":e}})
                    }
                },
                None => {
                    serde_json::json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"sidecar not running"}})
                }
            };
            let _ = out_tx.send(Message::Text(reply.to_string()));
        }
    }
    // 连接结束必须收割 3 个任务：两个转发任务的 broadcast 接收端永不枯竭
    //（广播端与壳/sidecar 同生命周期），写任务的 out_rx 又因转发任务持有
    // out_tx 克隆而不结束 —— 不 abort 则页面每次刷新/导航泄漏 3 个任务。
    // abort 即 drop 转发任务的 out_tx 克隆，写任务随 out_tx 全体 drop 自尽
    //（这里一并 abort 属双保险）。
    fwd_shell.abort();
    if let Some(h) = fwd_sidecar {
        h.abort();
    }
    writer_task.abort();
    Ok(())
}

/// Skin assets are loaded control first, then the bound style package.
const UI_SKIN_LINKS: &str = concat!(
    "<link rel=stylesheet href=\"/skin/control/layout.css\">",
    "<link rel=stylesheet href=\"/skin/style/tokens.css\">",
    "<link rel=stylesheet href=\"/skin/style/states.css\">",
);

fn loading_page() -> String {
    format!(
        // 行连接必须是单反斜杠（Rust 字符串续行，吞掉换行与缩进）。
        // 写成 `\\` 会把「字面反斜杠 + 换行 + 缩进」原样洗进 HTML —— 启动页
        // 上散落的 `\` 乱码即源于此（标签之间的 `\` 成为可见文本节点）。
        "<!doctype html><html class=\"eac-shell\"><head><meta charset=utf-8><title>Deepseek Harness EAC</title>{UI_SKIN_LINKS}</head>\
         <body data-region=\"session\" data-control-name=\"session-root\" data-state=\"loading\">\
         <main data-control-name=\"system.default.shell-page\" data-state=\"loading\">\
         <section data-control-name=\"system.default.shell-content\">\
         <div data-control-name=\"system.default.shell-title\">Deepseek Harness EAC</div>\
         <div data-control-name=\"system.default.shell-status\">{}</div>\
         <div data-control-name=\"system.default.loading-spinner\" data-state=\"loading animating\" aria-label=\"Loading\"></div>\
         </section></main>\
         <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';{}</script></body></html>",
        ui_text("正在启动服务…", "Starting services..."), ws_port(), BRIDGE_JS
    )
}

fn died_page(log_path: &str, code: &str) -> String {
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    format!(
        // 同 loading_page：单反斜杠续行；`\\` 会把字面 `\` 洗进 HTML/JS，
        // HTML 里成为可见乱码，`<script>` 里更是直接 JS SyntaxError（重试按钮失效）。
        "<!doctype html><html class=\"eac-shell\" lang={0}><head><meta charset=utf-8><title>{1}</title>{UI_SKIN_LINKS}</head>\
         <body data-region=\"session\" data-control-name=\"session-root\" data-state=\"error\">\
         <main data-control-name=\"system.default.shell-page\" data-state=\"error\">\
         <section data-control-name=\"system.default.shell-content\">\
         <div data-control-name=\"system.default.shell-title\">{2}</div>\
         <div data-control-name=\"system.default.shell-status\">{3} {4}</div>\
         <div data-control-name=\"system.default.shell-log-path\">{5}</div>\
         <div data-control-name=\"system.default.shell-actions\">\
         <button data-control-name=\"system.default.restart-button\" data-state=\"idle\" onclick=\"retry()\">{6}</button>\
         </div>\
         <div data-control-name=\"system.default.environment-panel\" data-state=\"loading\" id=\"env-panel\">\
         <div data-control-name=\"system.default.environment-title\">{11}</div>\
         <div data-control-name=\"system.default.environment-summary\" id=\"env-summary\">{12}</div>\
         <div data-control-name=\"system.default.environment-problems\" id=\"env-problems\"></div>\
         <button data-control-name=\"system.default.environment-purge-button\" data-state=\"hidden\" id=\"env-purge\" onclick=\"purgeEnvironment()\">{13}</button>\
         <div data-control-name=\"system.default.environment-hint\" data-state=\"hidden\" id=\"env-hint\"></div>\
         </div>\
         </section></main>\
         <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{7}/ws';{8}\
         function setEnvState(state){{var p=document.getElementById('env-panel');if(p){{p.setAttribute('data-state',state);}}}}\
         function renderProblems(list){{\
           var host=document.getElementById('env-problems');if(!host){{return;}}\
           host.textContent='';\
           (list||[]).forEach(function(item){{var d=document.createElement('div');d.setAttribute('data-control-name','system.default.environment-problem');d.textContent=item.text||item.code||'';host.appendChild(d);}});\
         }}\
         function refreshEnvironment(){{\
           var invoke=window.dshShell&&window.dshShell.invoke;\
           if(!invoke){{setEnvState('unavailable');return;}}\
           invoke('diagnose_environment').then(function(res){{\
             var d=(res&&res.diagnosis)||{{}};\
             var summary=document.getElementById('env-summary');\
             var problems=d.problems||[];\
             if(summary){{summary.textContent=(d.expectedRoot||'')+' · '+({14:?})+' '+(d.registered?({15:?}):({16:?}));}}\
             renderProblems(problems);\
             setEnvState(problems.length?'damaged':'healthy');\
             var purge=document.getElementById('env-purge');\
             if(purge){{purge.setAttribute('data-state',d.removable?'idle':'hidden');purge.disabled=!d.removable;}}\
             var hint=document.getElementById('env-hint');\
             if(hint){{\
               hint.textContent=d.removable?'':({20:?});\
               hint.setAttribute('data-state',d.removable?'hidden':'idle');\
             }}\
           }}).catch(function(e){{setEnvState('unavailable');var s=document.getElementById('env-summary');if(s){{s.textContent=String(e);}}}});\
         }}\
         function purgeEnvironment(){{\
           var b=document.getElementById('env-purge');if(!b){{return;}}\
           if(!window.confirm({17:?})){{return;}}\
           b.textContent={18:?};b.disabled=true;b.setAttribute('data-state','running');\
           var invoke=window.dshShell&&window.dshShell.invoke;\
           if(!invoke){{b.textContent={19:?};return;}}\
           invoke('repair_environment',{{purge:true}}).then(function(){{location.reload();}})\
             .catch(function(e){{b.textContent={19:?};b.disabled=false;b.setAttribute('data-state','error');var s=document.getElementById('env-summary');if(s){{s.textContent=String(e);}}}});\
         }}\
         refreshEnvironment();\
         function retry(){{\
           var b=document.querySelector('[data-control-name=\"system.default.restart-button\"]');b.textContent={9:?};b.disabled=true;b.setAttribute('data-state','running');\
           window.dshDesktop._call('boot.start',{{}}).then(function(){{location.reload();}})\
             .catch(function(e){{b.textContent={10:?};b.disabled=false;b.setAttribute('data-state','error');}});\
         }}</script></body></html>",
        ui_text("zh-CN", "en"),
        ui_text("服务已停止", "Service stopped"),
        ui_text("DSH 服务已停止", "The DSH service has stopped"),
        ui_text("退出码", "Exit code"),
        esc(code),
        esc(log_path),
        ui_text("重新启动", "Restart"),
        ws_port(),
        BRIDGE_JS,
        ui_text("正在重启…", "Restarting..."),
        ui_text("重启失败，请重试", "Restart failed. Try again."),
        // P1 自愈文案：环境 fail-closed 时给用户可操作的诊断与清理入口，
        // 而不是让他对着一个白屏猜原因。
        ui_text("安装环境", "Install environment"),
        ui_text("正在检查隔离环境…", "Checking the isolated environment..."),
        ui_text("清理并重建环境", "Clean and rebuild environment"),
        ui_text("已注册", "registered"),
        ui_text("已登记", "registered"),
        ui_text("未登记", "not registered"),
        ui_text("将删除该隔离环境下的全部数据（会话/配置/插件），且不可恢复。继续？", "This deletes all data in this isolated environment (sessions, config, plugins) and cannot be undone. Continue?"),
        ui_text("正在清理…", "Cleaning..."),
        ui_text("清理失败，请查看日志", "Cleanup failed; check the log"),
        // 无法自动清理时的出路（注册表损坏 / 目录被外部占用）：dpx 拒绝在
        // 不可信的注册表上做删除（正确的 fail-closed），所以这里给手工路径，
        // 而不是留一个点不动的按钮让人干瞪眼。
        ui_text(
            "环境无法自动清理（注册表不可读或目录被占用）。可手动把上面那条路径整个删掉或改名，然后重启本应用。",
            "This environment cannot be cleaned automatically (unreadable registry or the directory is in use). Manually delete or rename the path shown above, then restart the app.",
        ),
    )
}

/// 查询参数百分号编码（encodeURIComponent 语义：RFC 3986 unreserved 之外
/// 全部转 %XX）。5.3.2 及以前只编码反斜杠/冒号/斜杠/空格 —— `&`/`#` 会
/// 截断或污染参数（log 路径含 `&` 时 /died 页丢失后续内容）。页面侧
/// URLSearchParams 对 %XX 与旧 +（空格）均正确解码，行为兼容。
fn encode_query(v: &str) -> String {
    let mut out = String::with_capacity(v.len() + 8);
    for b in v.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[derive(Clone, Debug, serde::Deserialize)]
struct UiSkinManagerSnapshot {
    package: String,
    version: String,
    digest: String,
    generation: u64,
    assets: HashMap<String, String>,
    #[serde(rename = "slotAssets", default)]
    slot_assets: HashMap<String, Vec<String>>,
    fault: Option<String>,
}

fn ui_skin_manager_enabled() -> bool {
    !matches!(
        std::env::var("DSH_UI_SKIN_MANAGER_ROLLBACK").as_deref(),
        Ok("1") | Ok("true")
    )
}

fn ui_skin_manager_root() -> PathBuf {
    let root = resource_root();
    let packaged = root
        .join("ui-skin-manager")
        .join("resolved")
        .join("system.default");
    if packaged.is_dir() {
        packaged
    } else {
        root.join("tauri-shell")
            .join("artifacts")
            .join("resolved")
            .join("system.default")
    }
}

fn ui_skin_manager_snapshot() -> Option<UiSkinManagerSnapshot> {
    if !ui_skin_manager_enabled() {
        return None;
    }
    let path = ui_skin_manager_root().join("snapshot.json");
    let source = std::fs::read_to_string(path).ok()?;
    let lock: Value = serde_json::from_str(SKIN_MANAGER_LOCK).ok()?;
    let locked_default_digest = lock
        .pointer("/default/sha256")
        .and_then(Value::as_str)
        .map(str::to_owned)?;
    let snapshot: UiSkinManagerSnapshot = serde_json::from_str(&source).ok()?;
    (snapshot.package == "system.default"
        && snapshot.version == "2.0.0"
        && snapshot.digest == format!("sha256:{locked_default_digest}")
        && snapshot.fault.is_none()
        && snapshot
            .assets
            .keys()
            .all(|asset| ui_skin_asset_path_is_safe(asset)))
    .then_some(snapshot)
}

fn ui_skin_asset_path_is_safe(file: &str) -> bool {
    !file.is_empty()
        && !file.starts_with('/')
        && !file.contains('\\')
        && !file
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
}

fn ui_skin_manager_asset(file: &str) -> Option<String> {
    let snapshot = ui_skin_manager_snapshot()?;
    let relative = snapshot.assets.get(file)?;
    if !ui_skin_asset_path_is_safe(file) || !ui_skin_asset_path_is_safe(relative) {
        return None;
    }
    std::fs::read_to_string(ui_skin_manager_root().join(relative)).ok()
}

fn ui_skin_manager_bootstrap_json() -> String {
    let Some(snapshot) = ui_skin_manager_snapshot() else {
        return "{}".to_string();
    };
    let slots = snapshot
        .slot_assets
        .iter()
        .map(|(slot, assets)| {
            let css = assets
                .iter()
                .filter_map(|asset| ui_skin_manager_asset(asset))
                .collect::<Vec<_>>()
                .join("\n");
            (slot, css)
        })
        .collect::<HashMap<_, _>>();
    serde_json::to_string(&serde_json::json!({
        "enabled": true,
        "package": snapshot.package,
        "version": snapshot.version,
        "digest": snapshot.digest,
        "generation": snapshot.generation,
        "slots": slots,
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

fn ui_skin_asset_is_registered(file: &str) -> bool {
    ui_skin_manager_asset(file).is_some() || embedded_skin_asset(file).is_some()
}

fn ui_skin_asset(file: &str) -> String {
    if let Some(asset) = ui_skin_manager_asset(file) {
        return asset;
    }
    embedded_skin_asset(file).unwrap_or_default().to_string()
}

fn ui_skin_css_bundle() -> String {
    ["control/layout.css", "style/tokens.css", "style/states.css"]
        .iter()
        .map(|asset| ui_skin_asset(asset))
        .filter(|asset| !asset.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn embedded_skin_asset(file: &str) -> Option<&'static str> {
    match file {
        "control/layout.css" => Some(
            ":root{--eac-shell-surface:#202124;--eac-shell-text:#f1f3f4;}\nbody{margin:0;background:var(--eac-shell-surface);color:var(--eac-shell-text);font:14px sans-serif;}\n",
        ),
        "style/tokens.css" => Some(
            ":root{--eac-shell-surface:#202124;--eac-shell-text:#f1f3f4;--eac-shell-muted:#9aa0a6;}\n",
        ),
        "style/states.css" => Some(
            "[data-state~=loading]{opacity:.8}[data-state~=error]{color:#f28b82}[data-state~=disabled]{opacity:.55}\n",
        ),
        _ => None,
    }
}

fn shell_http_status(path: &str) -> u16 {
    let route = path.split('?').next().unwrap_or("");
    if ui_skin_manager_snapshot().is_some() {
        if let Some(asset) = route.strip_prefix("/skin/") {
            return if ui_skin_manager_asset(asset).is_some() {
                200
            } else {
                404
            };
        }
    }
    // SYNC-006 验证钩子（仿 DSH_HOST_PATHS_STAGE / DSH_DIRECTORY_PICK_STAGE
    // 先例）：仅当 DSH_BROWSER_PROBE=1 时放行 /browser-probe —— 一个不含桥的
    // 极小页面，window.open 触发 guest 的 NewWindowRequested，供自动化验证
    // onOpenRequested 事件链。默认（未设置）404，生产路径零影响。
    if route == "/browser-probe" {
        return if std::env::var("DSH_BROWSER_PROBE").as_deref() == Ok("1") {
            200
        } else {
            404
        };
    }
    if route == "/" || route == "/inject/bridge.js" || route == "/loading" || route == "/died" {
        200
    } else if route
        .strip_prefix("/skin/")
        .is_some_and(ui_skin_asset_is_registered)
    {
        200
    } else {
        404
    }
}

async fn http_serve(mut stream: TcpStream, path: &str) -> std::io::Result<()> {
    eprintln!("[http] serve {}", path);
    // 真正消费请求头（读到空行）：未读数据残留会让连接以 RST 而非 FIN 收尾，
    // WebView2 视为响应中断并反复重试。
    {
        use tokio::io::AsyncReadExt;
        let mut consumed = Vec::with_capacity(1024);
        let mut chunk = [0u8; 1024];
        loop {
            let n = stream.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            if consumed.len() + n > 64 * 1024 {
                break; // 头部异常超长，防御性放行
            }
            consumed.extend_from_slice(&chunk[..n]);
            if consumed.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
    }
    let status = shell_http_status(path);
    let (body, ctype) = if status == 404 {
        (
            "<!doctype html><meta charset=utf-8><title>Not Found</title><h1>404 Not Found</h1>"
                .to_string(),
            "text/html; charset=utf-8",
        )
    } else if path.starts_with("/inject/bridge.js") {
        (BRIDGE_JS.to_string(), "application/javascript")
    } else if let Some(file) = path.split('?').next().unwrap_or("").strip_prefix("/skin/") {
        (ui_skin_asset(file), "text/css; charset=utf-8")
    } else if path.starts_with("/browser-probe") {
        // SYNC-006 验证钩子页（shell_http_status 已按 DSH_BROWSER_PROBE=1 门控）。
        // 不含桥注入 —— 纯触发器：guest 加载本页后 window.open 一个 http(s)
        // 地址，L1 的 on_new_window 捕获并广播 browser.open-requested（开窗本身
        // 恒 Deny，不会真弹出页面）。
        (
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>browser-probe</title></head>\
             <body><h1>browser-probe</h1><script>\
             setTimeout(function(){window.open('/loading?probe=onOpenRequested','_blank');},150);\
             </script></body></html>"
                .to_string(),
            "text/html; charset=utf-8",
        )
    } else if path.starts_with("/loading") {
        (loading_page(), "text/html; charset=utf-8")
    } else if path.starts_with("/died") {
        // /died?code=..&log=..（查询参数由 boot.server-died 处理方拼好）
        let mut code = "unknown".to_string();
        let mut log = "".to_string();
        if let Some(q) = path.split_once('?') {
            for kv in q.1.split('&') {
                if let Some((k, v)) = kv.split_once('=') {
                    let v = v
                        .replace("%3A", ":")
                        .replace("%5C", "\\")
                        .replace("%2F", "/")
                        .replace('+', " ");
                    if k == "code" {
                        code = v;
                    } else if k == "log" {
                        log = v;
                    }
                }
            }
        }
        (died_page(&log, &code), "text/html; charset=utf-8")
    } else {
        let page = format!(
            // 同 loading_page：单反斜杠续行（`\\` 会把字面 `\` 洗进 HTML）。
            "<!doctype html><html class=\"eac-shell\"><head><meta charset=utf-8><title>DSH EAC Shell</title>{UI_SKIN_LINKS}</head>\
             <body data-region=\"session\" data-control-name=\"session-root\" data-state=\"idle\">\
             <main data-control-name=\"system.default.shell-page\"><section data-control-name=\"system.default.shell-content\">\
             <h3 data-control-name=\"system.default.shell-title\">DSH EAC — Tauri ShellHost</h3>\
             <pre data-control-name=\"system.default.shell-status\" id=out>connecting…</pre></section></main>\
             <script>window.__DSH_BRIDGE_WS__='ws://127.0.0.1:{}/ws';{}</script></body></html>",
            ws_port(), BRIDGE_JS
        );
        (page, "text/html; charset=utf-8")
    };
    let status_text = if status == 200 {
        "200 OK"
    } else {
        "404 Not Found"
    };
    let resp = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status_text,
        ctype,
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await?;
    Ok(())
}

fn run_bridge_test() -> i32 {
    println!("[bridge] node = {}", resolve_node());
    println!("[bridge] sidecar = {}", sidecar_script().display());
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let code = rt.block_on(async move {
        let sc = match Sidecar::spawn().await {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[bridge] FAIL spawn: {}", e);
                return 1;
            }
        };
        let checks: Vec<(&str, Value, Box<dyn Fn(&Value) -> bool>)> = vec![
            (
                "ping",
                serde_json::json!({}),
                Box::new(|r: &Value| r.get("pong") == Some(&serde_json::json!(true))),
            ),
            (
                "shell.info",
                serde_json::json!({}),
                Box::new(|r: &Value| r.get("sidecar") == Some(&serde_json::json!("server.ts"))),
            ),
            (
                "profile.name",
                serde_json::json!({}),
                Box::new(|r: &Value| r.get("name") == Some(&serde_json::json!("web-desktop"))),
            ),
        ];
        let mut ok = 0;
        for (name, params, check) in &checks {
            match sc.call(name, params.clone()).await {
                Ok(r) => {
                    println!("[bridge] {:<20} -> {}", name, r);
                    if check(&r) {
                        ok += 1;
                    } else {
                        eprintln!("[bridge] {} CHECK-FAIL", name);
                    }
                }
                Err(e) => eprintln!("[bridge] {} FAIL: {}", name, e),
            }
        }
        let _ = sc.call("shutdown", serde_json::json!({})).await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        sc.kill().await;
        println!("[bridge] {}/{} checks passed", ok, checks.len());
        if ok == checks.len() {
            0
        } else {
            1
        }
    });
    code
}

#[tauri::command]
fn shell_ping() -> serde_json::Value {
    serde_json::json!({ "pong": true, "shell": "tauri", "pid": std::process::id() })
}

/// 环境诊断/清理通道（P1 自愈，形态 1）。
///
/// 为什么放在 L1：环境 fail-closed 时 sidecar 已经退场（exit(2)），bridge 与
/// 它的 environment.* RPC 一起消失，而 `/died` 页正需要「环境坏了没有、坏在哪、
/// 能不能清理」—— 这条通道必须**不依赖 sidecar 存活**。
///
/// 分层红线（ADR 0002）：L1 **不实现**任何环境治理逻辑。这里只做三件事：
/// 用随包 node 跑 `dsh-desktop/scripts/environment-diagnose.mjs`、把它的
/// 单行 JSON 原样解析返回、把失败原因如实带出。注册表/清单/锁/删除全部仍由
/// dsh-dpx 经 L2 适配层完成。
fn run_environment_action(action: &str, purge: bool) -> Result<Value, String> {
    let script = resource_root()
        .join("dsh-desktop")
        .join("scripts")
        .join("environment-diagnose.mjs");
    if !script.is_file() {
        return Err(format!(
            "环境诊断脚本缺失：{}（安装包不完整，请重新安装）",
            script.display()
        ));
    }
    let node = resolve_node();
    let mut args = vec![
        script.to_string_lossy().to_string(),
        format!("--action={action}"),
    ];
    if purge {
        args.push("--purge".to_string());
    }

    let output = std::process::Command::new(&node)
        .args(&args)
        // 脚本自身需要真实用户环境（产品数据根/注册表位置都由它推导）。
        .stdin(std::process::Stdio::null())
        // 关键：必须注入资源根。打包态 dpx payload 位于 <resources>/dpx/src/index.js，
        // 适配层只能经 DSH_RESOURCE_ROOT 定位它；不传就会退化成开发态相对路径查找
        //（安装树上不存在）→ 诊断/清理在真实安装包里全部失效（实测踩中）。
        .env("DSH_RESOURCE_ROOT", resource_root())
        // 阻塞式取输出：诊断/清理都是短命的一次性进程。
        .output()
        .map_err(|e| format!("无法启动环境诊断（node={node}）：{e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // 脚本约定：成功与失败都以单行 JSON 输出，便于这里原样透传给页面。
    match serde_json::from_str::<Value>(&stdout) {
        Ok(value) => Ok(value),
        Err(_) => Err(format!(
            "环境诊断返回了非 JSON 数据（exit={:?}）：stdout={} stderr={}",
            output.status.code(),
            truncate_for_ui(&stdout, 400),
            truncate_for_ui(&stderr, 400),
        )),
    }
}

/// 截断长文本用于 UI 展示（避免把整段堆栈塞进 /died 页）。
fn truncate_for_ui(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}…")
}

#[tauri::command]
fn diagnose_environment() -> Result<Value, String> {
    run_environment_action("status", false)
}

/// 显式清理/重建当前通道环境。
///
/// 安全：`purge=true` 只在已登记环境上由 dpx 放行（未登记目录一律拒绝）；
/// 本命令**不会**被任何自动流程调用，只能由用户在 /died 页显式点击触发。
/// 不迁移旧数据、不触碰宿主 `~/.dsh`。
#[tauri::command]
fn repair_environment(purge: bool) -> Result<Value, String> {
    if !purge {
        // 非 purge 的 repair = 幂等重新确保（不删任何东西）。
        return run_environment_action("repair", false);
    }
    // 先 dry-run 取计划（不落盘），再执行 —— 让调用方拿到"删了什么"的事实。
    let plan = run_environment_action("plan", true)?;
    let removed = run_environment_action("remove", true)?;
    Ok(serde_json::json!({ "ok": true, "plan": plan, "removed": removed }))
}

#[tauri::command]
async fn sidecar_call(method: String, params: Value) -> Result<Value, String> {
    let state = BRIDGE.get_or_init(|| BridgeState {
        sidecar: Arc::new(AMutex::new(None)),
    });
    let sc = state.sidecar.lock().await.clone();
    match sc {
        Some(sc) => sc.call(&method, params).await,
        None => Err("sidecar not running".into()),
    }
}

static BRIDGE_ONCE: std::sync::Once = std::sync::Once::new();
static BRIDGE: std::sync::OnceLock<BridgeState> = std::sync::OnceLock::new();

/// sidecar 通知 → 壳层响应（主线程执行窗口操作）。
/// setup 首生与死后重生共用：
/// 重生实例有新的 notify_tx，不重接则 boot.web-ready 等事件永久丢失。
fn wire_sidecar_notifications(app: &tauri::AppHandle, sc: &Sidecar) {
    let mut notify = sc.notify_tx.subscribe();
    let app_notify = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match notify.recv().await {
                Ok(v) => handle_sidecar_notify(&app_notify, &v),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
    });
}

fn handle_sidecar_notify(app: &tauri::AppHandle, v: &Value) {
    let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "boot.web-ready" => {
            if let Some(url) = params.get("webUrl").and_then(|u| u.as_str()) {
                set_current_web_url(url);
                println!("[shell] web-ready → navigate: {}", url);
                let url = url.to_string();
                let app2 = app.clone();
                let _ = app.run_on_main_thread(move || {
                    use tauri::Manager;
                    if let Some(win) = app2.get_webview_window("main") {
                        if let Ok(parsed) = tauri::Url::parse(&url) {
                            let _ = win.navigate(parsed);
                        }
                    }
                });
            }
        }
        "boot.server-died" => {
            let code = params
                .get("code")
                .map(|c| c.to_string())
                .unwrap_or_else(|| "unknown".into());
            let log = params
                .get("logPath")
                .and_then(|l| l.as_str())
                .unwrap_or("")
                .to_string();
            println!("[shell] server-died code={} log={}", code, log);
            let href = format!(
                "http://127.0.0.1:{}/died?code={}&log={}",
                ws_port(),
                encode_query(&code),
                encode_query(&log)
            );
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                use tauri::Manager;
                if let Some(win) = app2.get_webview_window("main") {
                    let _ = win.show();
                    if let Ok(parsed) = tauri::Url::parse(&href) {
                        let _ = win.navigate(parsed);
                    }
                }
            });
        }
        // v6 Task 3.3：sidecar 内部请求打开外链（如更新流程）。
        // 与 handle_shell_method 的同名 arm 区分：这里是 notify 帧（无 id）。
        "shell.open-external" => {
            let url = params
                .get("url")
                .and_then(|value| value.as_str())
                .unwrap_or("");
            let url = url.to_string();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = open_external(&url).await {
                    eprintln!("[shell] sidecar open external failed: {}", error);
                }
            });
        }
        "shell.system-notification" => {
            let title = params
                .get("title")
                .and_then(|value| value.as_str())
                .unwrap_or("Deepseek Harness EAC")
                .to_string();
            let body = params
                .get("body")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = show_system_notification(&title, &body).await {
                    eprintln!("[shell] system notification failed: {}", error);
                }
            });
        }
        _ => {}
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--bridge-test") {
        std::process::exit(run_bridge_test());
    }

    let state = BRIDGE.get_or_init(|| BridgeState {
        sidecar: Arc::new(AMutex::new(None)),
    });

    tauri::Builder::default()
        // SYNC-004：dialog 插件（原生目录选择能力源，见 pick_directory 注释）。
        // 仅用 Rust 侧 API（app.dialog()）；WebView 侧 plugin:dialog|* 命令无
        // capability 授权，页面不可绕过桥直达 —— 行为面与注册前一致。
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动：聚焦已有主窗（= Electron second-instance 行为）。
            use tauri::Manager;
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            // 主窗导航完成：清理可能残留的退出 overlay
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.eval("window.__dshExitOverlay&&window.__dshExitOverlay.dismiss()");
            }
        }))
        .invoke_handler(tauri::generate_handler![
            shell_ping,
            sidecar_call,
            diagnose_environment,
            repair_environment
        ])
        .setup(move |app| {
            use tauri::Manager;

            initialize_packaged_resource_root(app);

            // SYNC-003：剪贴板路径监听（__DSH_HOST_PATHS__ 暂存源）。失败只
            // 降级（无帧推送 → 桥侧 pathFor 返 ''），不阻塞壳启动。
            #[cfg(windows)]
            spawn_clipboard_path_listener();
            // SYNC-003 验证钩子（L1 事件注入，见函数注释）：仅当
            // DSH_HOST_PATHS_STAGE 设置时生效。
            stage_host_paths_from_env();

            BRIDGE_ONCE.call_once(|| {
                let st = BridgeState {
                    sidecar: state.sidecar.clone(),
                };
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // 先绑桥端口（可能回退到非默认端口）：下面所有窗口 URL
                    // （loading / died）都指向桥端口，必须先定稿。
                    let Some(listener) = bind_ws_listener().await else {
                        eprintln!("[ws] bridge listener bind failed; aborting shell startup");
                        return;
                    };
                    match Sidecar::spawn().await {
                        Ok(sc) => {
                            println!("[shell] sidecar ready");
                            // sidecar 通知 → 壳层：首生与死后重生共用接线。
                            wire_sidecar_notifications(&app_handle, &sc);
                            *st.sidecar.lock().await = Some(Arc::new(sc));


                            // 主窗：先加载壳层 /loading 页（即起即见）。
                            let app_win = app_handle.clone();
                            let app_win_inner = app_win.clone();
                            let _ = app_win.run_on_main_thread(move || {
                                let app_win = app_win_inner;
                                let loading = format!("http://127.0.0.1:{}/loading", ws_port());
                                if let Ok(url) = tauri::Url::parse(&loading) {
                                    let (sim_w, sim_h, sim_pos, sim_max) =
                                        resolved_initial_bounds(&app_win);
                                    let (eff_min_w, eff_min_h) = effective_min_inner(&app_win);
                                    let mut builder = tauri::webview::WebviewWindowBuilder::new(
                                        &app_win,
                                        "main",
                                        tauri::WebviewUrl::External(url),
                                    )
                                    .title("Deepseek Harness EAC")
                                    .inner_size(sim_w, sim_h)
                                    .min_inner_size(eff_min_w, eff_min_h)
                                    .decorations(false)
                                    // 关闭窗口级 drag&drop handler，放行页面 HTML5 拖拽
                                    //（否则图片/文件拖不进输入框，页面 dragover/drop 收不到）。
                                    .disable_drag_drop_handler()
                                    // dsh-stt 语音识别：WebView2 在无用户手势下 getUserMedia
                                    // 可能被拒，放开 autoplay 策略。WebView2 的麦克风权限本身
                                    // 走 Windows 系统隐私设置，无需额外 permission 授权。
                                    // additional_browser_args 是整体替换语义（wry）：必须
                                    // 带上 Tauri 默认的 disable-features，否则主窗丢掉
                                    // msWebOOUI/msPdfOOUI/msSmartScreenProtection 禁用项，
                                    // 与浮窗（显式拼接该前缀）行为分裂。
                                    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required")
                                    .initialization_script(&bridge_init_script());
                                    if let Some((px, py)) = sim_pos {
                                        builder = builder.position(px, py);
                                    }
                                    match builder.build() {
                                        Ok(win) => {
                                            apply_window_icon(&win, &app_win);
                                            if sim_max {
                                                let _ = win.maximize();
                                            }
                                        }
                                        Err(e) => eprintln!("[shell] main window build failed: {}", e),
                                    }
                                }
                            });

                            // boot.start：拉起 dsh web → webUrl（通知处理器负责导航；
                            // 这里显式再导航一次，兜底通知竞态）。
                            let st2 = BridgeState { sidecar: st.sidecar.clone() };
                            let app_nav = app_handle.clone();
                            tauri::async_runtime::spawn(async move {
                                let sc = st2.sidecar.lock().await.clone();
                                let Some(sc) = sc else { return };
                                match sc.call("boot.start", serde_json::json!({})).await {
                                    Ok(r) => {
                                        let url = r.get("webUrl").and_then(|u| u.as_str()).unwrap_or("").to_string();
                                        println!("[shell] boot.start ok: {}", url);
                                        if !url.is_empty() {
                                            set_current_web_url(&url);
                                            let app3 = app_nav.clone();
                                            let _ = app_nav.run_on_main_thread(move || {
                                                use tauri::Manager;
                                                if let Some(win) = app3.get_webview_window("main") {
                                                    if let Ok(parsed) = tauri::Url::parse(&url) {
                                                        let _ = win.navigate(parsed);
                                                    }
                                                }
                                            });
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("[shell] boot.start failed: {}", e);
                                        let msg = e.replace('"', "'").replace('\n', " ");
                                        let href = format!(
                                            "http://127.0.0.1:{}/died?code=boot&log={}",
                                            ws_port(), encode_query(&msg)
                                        );
                                        let app3 = app_nav.clone();
                                        let _ = app_nav.run_on_main_thread(move || {
                                            use tauri::Manager;
                                            if let Some(win) = app3.get_webview_window("main") {
                                                let _ = win.show();
                                                if let Ok(parsed) = tauri::Url::parse(&href) {
                                                    let _ = win.navigate(parsed);
                                                }
                                            }
                                        });
                                    }
                                }
                            });

                            serve_ws(st, app_handle, listener).await;
                        }
                        Err(e) => {
                            // issue #210：resources 装配失败 / node sidecar 缺失时，
                            // 旧实现只 eprintln!，用户窗口永久停在 /loading 白屏、
                            // 无任何诊断入口。这里与 boot.start 失败同样处理：
                            // 建主窗并导航到 /died 页（参数带失败原因），提示重装。
                            eprintln!("[shell] sidecar spawn failed: {}", e);
                            let msg = e.to_string().replace('"', "'").replace('\n', " ");
                            let app_died = app_handle.clone();
                            let app_died_inner = app_died.clone();
                            let _ = app_died.run_on_main_thread(move || {
                                use tauri::Manager;
                                let app_died = app_died_inner;
                                let died = format!(
                                    "http://127.0.0.1:{}/died?code=sidecar-spawn&log={}",
                                    ws_port(), encode_query(&msg)
                                );
                                if let Ok(url) = tauri::Url::parse(&died) {
                                    if app_died.get_webview_window("main").is_none() {
                                        let (sim_w, sim_h, sim_pos, sim_max) =
                                            resolved_initial_bounds(&app_died);
                                        let (eff_min_w, eff_min_h) = effective_min_inner(&app_died);
                                        let mut builder = tauri::webview::WebviewWindowBuilder::new(
                                            &app_died,
                                            "main",
                                            tauri::WebviewUrl::External(url),
                                        )
                                        .title("Deepseek Harness EAC")
                                        .inner_size(sim_w, sim_h)
                                        .min_inner_size(eff_min_w, eff_min_h)
                                        .decorations(false);
                                        if let Some((px, py)) = sim_pos {
                                            builder = builder.position(px, py);
                                        }
                                        match builder.build() {
                                            Ok(win) => {
                                                apply_window_icon(&win, &app_died);
                                                if sim_max {
                                                    let _ = win.maximize();
                                                }
                                            }
                                            Err(e) => eprintln!("[shell] died window build failed: {}", e),
                                        }
                                    } else if let Some(win) = app_died.get_webview_window("main") {
                                        let _ = win.show();
                                        let _ = win.navigate(url);
                                    }
                                }
                            });
                            // issue #210 修复完整性：/died 页挂在桥端口上，
                            // spawn 失败分支同样必须起 serve_ws，否则
                            // 诊断页指向无人监听的端口，WebView2 只会显示「无法访问」。
                            serve_ws(st, app_handle, listener).await;
                        }
                    }
                });
            });

            // 托盘（L1）：显示/隐藏、重启服务、反馈、退出。
            // 文案语言 = 持久化 preference ?? OS 检测（SYNC-002：设置页改语言
            // 经 __DSH_LOCALE__.onChange → locale.changed → rebuild_tray_menu
            // 按 id 取回本托盘重建菜单）。菜单事件挂在托盘上，重建菜单不丢。
            let menu = build_tray_menu(app.handle(), shell_prefers_chinese())?;
            let mut tray = tauri::tray::TrayIconBuilder::with_id(TRAY_ID)
                .tooltip("Deepseek Harness EAC")
                .menu(&menu);
            let app_handle = app.handle().clone();
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(move |app, event| match event.id.as_ref() {
                "show" => {
                    if let Some(win) = app.get_webview_window("main") {
                        if win.is_visible().unwrap_or(true) {
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                }
                "restart" => {
                    let st = BridgeState {
                        sidecar: BRIDGE.get_or_init(|| BridgeState {
                            sidecar: Arc::new(AMutex::new(None)),
                        })
                        .sidecar
                        .clone(),
                    };
                    tauri::async_runtime::spawn(async move {
                        let sc = st.sidecar.lock().await.clone();
                        if let Some(sc) = sc {
                            match sc.call("boot.restart", serde_json::json!({})).await {
                                Ok(r) => println!("[tray] restart: {}", r),
                                Err(e) => eprintln!("[tray] restart failed: {}", e),
                            }
                        }
                    });
                }
                "feedback" => {
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = open_external("https://github.com/Ebony-Vinyl/Deepseek-Harness-EAC/issues").await {
                            eprintln!("[tray] open feedback failed: {}", error);
                        }
                    });
                }
                "quit" => app_handle.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                // 单击切换窗口可见性（= Electron tray.on('click')）。
                if let tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                    let app = tray.app_handle().clone();
                    if let Some(win) = app.get_webview_window("main") {
                        if win.is_visible().unwrap_or(true) && win.is_focused().unwrap_or(false) {
                            let _ = win.hide();
                        } else {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                }
            })
            .build(app)?;
            println!(
                "[shell] tray ready (locale: {})",
                if shell_prefers_chinese() { "zh" } else { "en" }
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            use tauri::Manager;
            match event {
                // 主窗关闭 → exitAction 策略（minimize/quit/ask 选择页）；浮窗真关闭。
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        // 退出前先落盘当前尺寸/位置（ExitRequested 还会兜底一次）。
                        save_window_state(window.app_handle());
                        api.prevent_close();
                        let app = window.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            apply_exit_policy(&app, true).await;
                        });
                    }
                }
                // 最大化状态变化 → win.maximized 通知（桥 onMaximizeChange 消费）。
                tauri::WindowEvent::Resized(_) => {
                    if window.label() == "main" {
                        let m = window.is_maximized().unwrap_or(false);
                        if LAST_MAXIMIZED.swap(m, Ordering::SeqCst) != m {
                            let _ = shell_notify().send(serde_json::json!({
                                "method": "win.maximized",
                                "params": { "maximized": m }
                            }));
                        }
                        throttle_save_window_state(window.app_handle());
                    }
                }
                // 拖移后保存位置（节流写盘，最终态由关闭/退出兜底）。
                tauri::WindowEvent::Moved(_) => {
                    if window.label() == "main" {
                        throttle_save_window_state(window.app_handle());
                    }
                }
                // DPI/显示器切换：WebView2 视口跟随偶发丢失（视口失同步主诱因），
                // 延迟一拍显式重申 webview bounds。
                tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    if window.label() == "main" {
                        let app = window.app_handle().clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                            reassert_webview_bounds(&app);
                        });
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // 进程退出前最终落盘一次窗口状态（兜底 CloseRequested 之前的分支）。
                save_window_state(app);
                // 优雅退出（同步有界，事件循环内完成，杜绝「调度后进程先退」的孤儿）：
                // shutdown RPC → sidecar 有界回收 dsh web 进程树 → 兜底 kill。
                let state = BRIDGE.get_or_init(|| BridgeState {
                    sidecar: Arc::new(AMutex::new(None)),
                });
                let st = BridgeState { sidecar: state.sidecar.clone() };
                let _ = tauri::async_runtime::block_on(async move {
                    let sc = st.sidecar.lock().await.clone();
                    if let Some(sc) = sc {
                        // 优雅退出意图置位：其后的 sidecar 自退 EOF 不再触发
                        // boot.server-died 广播（退出瞬间闪现 /died 页）。
                        SIDECAR_STOPPING.store(true, Ordering::SeqCst);
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_secs(10),
                            sc.call("shutdown", serde_json::json!({})),
                        )
                        .await;
                        // shutdown 后 sidecar 自行 gracefulExit → stopServer
                        // （grace 1.2s + hard 4s 有界，detached 的 dsh web 树杀
                        // 在其中）→ process.exit(0)。等它自退再兜底 kill：
                        // 5.3.2 及以前固定睡 500ms 就杀，stopServer 被拦腰
                        // 砍断，dsh web 变孤儿占着端口。有界轮询 ~9s 覆盖
                        // stopServer 上界 + 边距。
                        //
                        // 先清空槽位再轮询：旧实现走 Arc::into_inner(sc)，但槽位
                        // 永远持有同一个 Arc（强计数 ≥2），into_inner 恒 None ——
                        // 9s 轮询 + 兜底 kill 整段从未生效，sidecar 挂死时整棵
                        // node/dsh web 进程树孤儿化。child 已改为 AMutex<Child>，
                        // 直接经共享句柄轮询即可。
                        *st.sidecar.lock().await = None;
                        let started = std::time::Instant::now();
                        let mut exited = false;
                        while started.elapsed() < std::time::Duration::from_secs(9) {
                            if let Ok(Some(_)) = sc.child.lock().await.try_wait() {
                                exited = true;
                                break;
                            }
                            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        }
                        if !exited {
                            println!("[shell] sidecar did not exit in time; killing");
                            sc.kill().await;
                        }
                    }
                });
                println!("[shell] sidecar reaped; exiting");
            }
        });
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::escape_apple_script_string;

    #[test]
    fn escapes_backslashes_and_quotes() {
        assert_eq!(escape_apple_script_string("a\\b\"c"), "a\\\\b\\\"c");
    }

    #[test]
    fn leaves_plain_text_unchanged() {
        assert_eq!(escape_apple_script_string("hello 世界"), "hello 世界");
    }
}

#[cfg(test)]
mod eac_channel_tests {
    use super::{
        eac_data_root, eac_data_root_with, sanitize_eac_channel, DEFAULT_EAC_CHANNEL,
        EAC_PRODUCT_NAME,
    };

    #[test]
    fn keeps_valid_channels() {
        assert_eq!(sanitize_eac_channel("beta"), "beta");
        assert_eq!(sanitize_eac_channel("  Beta  "), "beta");
        assert_eq!(sanitize_eac_channel("rc-1"), "rc-1");
    }

    #[test]
    fn falls_back_for_invalid_channels_instead_of_mangling() {
        // 空值、非 ASCII 与非法首字符都必须退回默认通道，
        // 而不是「清洗」成一个看似合法却指向错误环境的名字。
        for invalid in [
            "",
            "   ",
            "中文通道",
            "1beta",
            "-beta",
            "beta!",
            "a".repeat(64).as_str(),
        ] {
            assert_eq!(
                sanitize_eac_channel(invalid),
                DEFAULT_EAC_CHANNEL,
                "input={invalid:?}"
            );
        }
    }

    #[test]
    fn product_data_root_ends_with_product_name() {
        let root = eac_data_root();
        assert!(root.ends_with(EAC_PRODUCT_NAME), "root={}", root.display());
        // L1 只给产品数据根：dpx storageRoot / dsh-environments 由 L2 推导，
        // 这里不得出现，否则两侧路径策略会各说各话。
        assert!(!root.to_string_lossy().contains("dsh-environments"));
        assert!(!root.to_string_lossy().contains("dpx"));
    }

    #[test]
    fn honors_injected_data_root_instead_of_recomputing() {
        // 回归（2026-09-28 实测）：首版实现无视外部注入的 DSH_EAC_DATA_ROOT，
        // 一律用 LOCALAPPDATA 重算 —— 而 L2 适配层把该变量当**权威值**，
        // 两侧语义相反，导致「隔离根建在别处」（便携启动器/端到端验证踩中）。
        //
        // 用纯函数核心验证：不碰进程全局环境，因此不会与并行运行的其它测试
        // 互相污染（早期版本用 set_var 出现过一次瞬时失败）。
        let injected = if cfg!(windows) {
            r"D:\EAC 数据\产品 Root"
        } else {
            "/tmp/eac 数据/产品 Root"
        };
        let temp = std::env::temp_dir();

        // 1) 显式注入 → 原样采用（含空格与中文）。
        assert_eq!(
            eac_data_root_with(
                Some(injected),
                None,
                None,
                Some(r"C:\ignored"),
                None,
                temp.clone()
            ),
            std::path::PathBuf::from(injected),
            "显式注入的产品数据根必须原样采用，不得被 LOCALAPPDATA 覆盖"
        );
        // 首尾空白要裁剪（便于 shell/启动器传值时容错）。
        assert_eq!(
            eac_data_root_with(
                Some("  D:\\Trimmed  "),
                None,
                None,
                None,
                None,
                temp.clone()
            ),
            std::path::PathBuf::from("D:\\Trimmed"),
        );
        // 2) 空白值不算「给定」→ 退回推导。
        assert!(
            eac_data_root_with(
                Some("   "),
                Some("C:\\Users\\u"),
                None,
                Some("C:\\la"),
                None,
                temp.clone(),
            )
            .ends_with(EAC_PRODUCT_NAME),
            "空白注入值应退回推导"
        );
        // 3) 未注入 → 按平台默认推导（Windows: LOCALAPPDATA；非 Windows: XDG_DATA_HOME）。
        let derived = eac_data_root_with(
            None,
            Some("/home/u"),
            None,
            Some("C:\\la"),
            Some("/xdg/data"),
            temp.clone(),
        );
        assert!(derived.ends_with(EAC_PRODUCT_NAME));
        if cfg!(windows) {
            assert!(
                derived.starts_with("C:\\la"),
                "Windows 推导应基于 LOCALAPPDATA：{derived:?}"
            );
        } else {
            assert!(
                derived.starts_with("/xdg/data"),
                "非 Windows 推导应基于 XDG_DATA_HOME：{derived:?}"
            );
        }
    }
}
