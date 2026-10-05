# 生态来源与历史致谢 / Ecosystem credits

[中文首页](../README.md) · [English](../README.en.md)

以下保留旧 README 的作者归属、插件与皮肤许可记录，是历史生态档案，不是 v6 默认装配清单，也不保证这些包当前兼容或已发布。旧文中关于内置数量和功能的描述仅对应历史版本。当前装配请查 tauri-shell/stage-resources.mjs，逐包来源请查 dsh-desktop/assets/SOURCES.json 和 .sync 账本。

Historical attribution only; this list does not describe what ships with v6. Third-party licenses remain applicable.

### 插件致谢

| 插件名                                                    | 插件说明                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Archify（提供者：tt-a1i，EAC 推荐目录）                           | 由代码仓库或系统描述生成经校验的可交互架构图、工作流图、时序图与数据流图，可导出独立 HTML/SVG/PNG                        |
| computer-user（提供者：jing-hy）                             | 读屏 + 鼠标键盘自动化（Codex-style computer use；配 picturereader，纯文本模型可用）                 |
| @nanmicoder/dsh-agent-teams（提供者：nanmicoder）            | 多智能体团队协作：自然语言驱动的队长/成员/依赖任务与消息互通，Web GUI 树状监控                                   |
| dsh-auto-compact                                       | 自动压缩：接近上下文上限时自动发送 /compact                                                     |
| @deepseek-ai/dsh-balance（提供者：deepseek-ai）              | 账户余额、费用估算与价格设置                                                                 |
| dsh-better-sidebar（提供者：omdsh-dev）                      | VSCode 风格右侧栏，支持资源管理器/编辑器/终端/Git/浏览器                                            |
| dsh-change-review                                      | AI 变更审核：自动复查文件改动                                                               |
| @deepseek-ai/dsh-client-file-changes（提供者：deepseek-ai）  | 文件视图：会话文件更改追踪与一键还原                                                             |
| dsh-compact（提供者：zixin947）                              | 请求路径上下文压缩与溢出恢复                                                                 |
| dsh-composer-dynamic-island（提供者：says693）               | 将输入区按钮收纳为可配置、向上展开的紧凑灵动岛                                                        |
| @deepseek-ai/dsh-conversation-tweaks（提供者：deepseek-ai）  | 隐藏长篇输出 + 会话右侧导航滑轨                                                              |
| dsh-dafeiyu（提供者：QCYTSN）                                | 大肥鱼桌面伴侣                                                                        |
| dsh-deep-whale（提供者：Small-tailqwq）                      | 深海女仆工坊 maid-atelier 皮肤来源                                                       |
| dsh-dock-settings                                      | Skills 与 MCP 设置管理                                                              |
| dsh-eac-core-bridge（EAC 配套）                            | 核心桥：把隔离 SDK 插件的工具/上下文贡献安全桥接进 dsh Agent（受信组件，扩展故障不阻塞核心回合）                       |
| dsh-eac-locale-compat（EAC 配套）                          | 为未提供本地化词典的内置插件提供英文兼容层                                                          |
| @deepseek-ai/dsh-easy-setup（提供者：deepseek-ai）           | 快速配置：视觉模型、soul.md、迁移                                                           |
| dsh-feature-toggles（EAC 配套）                            | 设置页「增强功能」分区：集中提供默认关闭插件（余额小鲸鱼、AgentTeams 等）的一键启停                                |
| @deepseek-ai/dsh-file-changes（提供者：deepseek-ai）         | 会话文件更改投影                                                                       |
| dsh-file-drop-eac（提供者：jing-hy）                         | 拖放文件/文件夹到对话                                                                    |
| @deepseek-ai/dsh-float-window（提供者：deepseek-ai）         | 会话弹出独立窗口                                                                       |
| dsh-font-custom                                        | 字体与文字/代码颜色自定义                                                                  |
| dsh-image-paste                                        | 剪贴板图片粘贴发送                                                                      |
| dsh-meow-smooth（提供者：Phant0Meow）                        | 喵丝滑：输入框失焦折叠高度 + 窄屏选中会话自动收起侧边栏                                                  |
| dsh-message-rewind                                     | 消息改写并从此处重新生成                                                                   |
| @vlln/dsh-navbar（提供者：vlln）                             | 对话节点导航条：user 消息快速跳转                                                            |
| dsh-offpeak（提供者：christophersmith2737-commits）          | DeepSeek 峰谷价格拦截提醒                                                              |
| @deepseek-ai/dsh-openclaw-bridge（提供者：deepseek-ai）      | 微信 ClawBot / OpenClaw 桥接                                                       |
| dsh-pet（提供者：PC2005-cloud）                              | 页面悬浮桌宠                                                                         |
| dsh-pet-settings                                       | 桌宠设置分区                                                                         |
| dsh-phone（EAC 配套）                                      | 手机连接：LAN 扫码配对 + 完整 Web UI 反向代理                                                 |
| dsh-plugin-guard（提供者：lxzy-7）                           | 插件安装前快照、回滚与启动守护                                                                |
| dsh-plugin-healthcheck（提供者：chenw2759-wq）               | 插件静态体检与风险检查                                                                    |
| @deepseek-ai/dsh-plugin-manager（提供者：deepseek-ai）       | 插件管理：列出/启停内置插件                                                                 |
| dsh-plugin-shield                                      | 插件保护：快照/回滚/体检                                                                  |
| dsh-plugin-wizard                                      | 插件选择向导                                                                         |
| @deepseek-ai/dsh-prompt-custom（提供者：deepseek-ai）        | 自定义内核提示词                                                                       |
| dsh-raw-html（EAC 托管）                                   | VCP 视觉通感：通过官方 conversation slot 隔离渲染 HTML，提供字体、美学与设计规范能力                       |
| dsh-session-manager（提供者：hkkz9522）                      | 会话删除与归档管理                                                                      |
| dsh-settings-groups                                    | 设置页高级选项折叠                                                                      |
| dsh-settings-nav-custom                                | 设置页左侧边栏自定义                                                                     |
| dsh-settings-scroll-fix（提供者：says693）                   | 设置面板鼠标滚轮与溢出滚动修复                                                                |
| @dsh-external/dsh-side-session（提供者：dsh-external）       | 临时会话：不污染主会话的独立追问                                                               |
| dsh-soul-md（提供者：Scorp1o117）                            | soul.md 人设卡注入                                                                  |
| dsh-stt（提供者：BAIKAI23333）                               | 本地离线语音识别：sherpa-onnx SenseVoice 麦克风说话回填输入框，唤醒词 + 「发送」语音指令（默认禁用，三平台，引擎构建时按平台安装） |
| @deepseek-ai/dsh-terminal（提供者：deepseek-ai）             | 会话内交互式命令行                                                                      |
| @deepseek-ai/dsh-third-party-thinking（提供者：deepseek-ai） | 第三方模型思考强度控件                                                                    |
| dsh-tool-vision（提供者：Scorp1o117）                        | OpenAI 兼容视觉模型图片分析                                                              |
| dsh-undo-savepoint（提供者：lire1131）                       | 配置快照与撤销/回滚                                                                     |
| dsh-unified-market（提供者：jing-hy）                        | 统一插件市场：聚合三源                                                                    |
| dsh-viewport-lock（EAC 配套）                              | 视口约束：滚动钳制、稳定居中与输入区透明动态裁切（桌面壳/浏览器/手机端通用）                                        |
| dsh-web-mobile-fix（提供者：AcidGr）                         | 移动端布局修复                                                                        |
| dsh-web-plugin-manager（提供者：LX2000WASD）                 | 插件安装守卫与健康检查入口                                                                  |
| dsh-web-ui（提供者：zhu1090093659）                          | 9 款内置 Web UI 皮肤来源                                                              |
| dsh-webui-market（提供者：Sanqi-normal）                     | 社区插件目录与一键安装/卸载                                                                 |
| dsh-webui-prompt-optimizer（提取自 statem-li/dsh-webui）    | 流式提示词优化                                                                        |
| dsh-whale-widget（提供者：MeteorNOX）                        | 余额小鲸鱼挂件：今日已用、峰谷定价、随机台词与每轮消耗统计                                                  |
| picturereader（提供者：jing-hy）                             | 统一图片理解插件                                                                       |

感谢所有插件提供者对本项目与开源社区的奉献；由于插件数量众多，我们很抱歉，未能逐一统计到所有插件与其来源；如有插件的拥有者看到了自己所做的插件，欢迎您告知我们并添加到致谢名单中，也欢迎添加我们的交流群，以便一同交流、共同进步。

### 皮肤来源与许可

设置页内置 10 款 Web UI 皮肤，默认保持原生外观。启用任一皮肤时会自动禁用其他皮肤，也可一键恢复默认；皮肤的来源、作者和许可信息随安装包完整分发。

其中 9 款来自社区 [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)（BSD-3-Clause），maid-atelier 来自 [dsh-deep-whale 深海女仆工坊](https://github.com/Small-tailqwq/dsh-deep-whale)（CC BY-NC-SA 4.0，禁止商用）。

| 皮肤                   | 出处                                                                | 许可                        |
| -------------------- | ----------------------------------------------------------------- | ------------------------- |
| xp（Windows XP 风格）    | [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui)         | BSD-3-Clause              |
| qq98（QQ 经典 98 风格）    | 同上                                                                | BSD-3-Clause              |
| ths（同花顺风格）           | 同上                                                                | BSD-3-Clause              |
| blue-fantasy（蓝幻）     | 同上                                                                | BSD-3-Clause              |
| dragon-heir（龙裔）      | 同上                                                                | BSD-3-Clause              |
| minecraft（我的世界）      | 同上                                                                | BSD-3-Clause              |
| trading（交易风格）        | 同上                                                                | BSD-3-Clause              |
| whale-song（鲸歌）       | 同上                                                                | BSD-3-Clause              |
| miku（初音未来）           | 同上                                                                | BSD-3-Clause              |
| maid-atelier（深海女仆工坊） | [dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale) | **CC BY-NC-SA 4.0**（禁止商用） |
