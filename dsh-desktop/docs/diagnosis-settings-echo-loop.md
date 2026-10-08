# 诊断报告：设置写入回声循环（主题闪屏 / 字号回弹 / 皮肤重置）

> 状态：已定案（三轮 22 份调查报告交叉验证）。修复见 `scripts/patch-deps.ts` 四个
> 补丁 + 本文档「修复」一节。验收标准见「验收」一节。

## 症状

1. 切换深色/浅色主题后，`api/settings/mutate` 请求以约 1Hz **自动连发**数秒到
   十几秒（用户无操作），`body[data-ds-dark-theme]` 逐拍翻转（闪屏）
2. 字号调整后回弹：14 改 16，数秒内界面回到更小值；概率触发（越快点越易发作）
3. 连带：发作后重启，`cordis.patch.yml` 中 `dsh-ui-skin-loader` 的 activeSkin 行
   丢失，皮肤重置为 default（控制台 `startup recovery: no skin persisted`）
4. 停手后自愈；官方 web（小 profile）不明显；beta 与 beta1 双机复现

## 根因（最终模型：乐观回放放大 + 三重重算写入 + 重启冷窗）

```
点击 → ThemeRuntime 乐观发布（先改内存+翻 DOM，host.set 异步且无视结果）
     → ConfigFormController FIFO 串行队列（无合并）
     → 服务端 configEditor.edit：文件锁 + 写前/写后两次全量 reconcile +
       HMR 串行队列 + preflight 无缓存（每笔 ~500 次同步读盘，冷窗 1-2s）
     → 每笔响应 acceptView → 广播 → adopt() 无在途防护，把显示拉回
       「那一笔的已提交值」（= 历史值）→ 下一笔响应又拉到另一历史值……
     → 屏幕逐帧重演写入历史 = 闪屏；同值守卫比较被污染的本地值，
       诱发再点击（写入数 ≈ 意图数 × 1.5-2）= 回弹感
概率门：当晚 web 服务两次重启 → preBootSync 全量同步（壳进程无锁写 patch，
与内核带锁写构成跨进程写者对）+ 缓存全冷 → 单笔延迟热 30-120ms / 冷 1-2s，
只在「重启后窗口 × 连续操作」交集现形。
```

官方 web 不明显的原因：默认 profile 仅 1 个 bundle（`DEFAULT_PROFILE_BUNDLES`），
写入快到 adopt 回声落在已更新值上；竞态与规模无关，规模只决定可见窗口。

## 关键证据

- fetch 钩子载荷：`ns=ui-theme`、preference 在 light/system/dark 轮换、
  expectedRevision 每拍 +1 且全部被接受（单写者自有队列特征）；system 值 =
  dark 立方右侧 8px 的 system 立方被误点（过冲-校正轨迹）
- 文件秒级监控：交互 16 秒 fontSize 走过 9 个值，逐值均为「当时显示值 ±1」，
  停手收敛；16→13 为秒级采样漏拍（11 笔写 vs 9 个观测值）
- 全树穷举：ui-theme 写入口恰 3 处全部 click-gated 带同值守卫；document-updated
  消费者全只读；无定时器周期写者；无第二客户端；无传输层重试
- 0.2.0-rc.2 与 0.1.7-rc.2 逐字节比对：三处缺陷文件全部未变

## 已排除（防重复调查）

传输层重试（仅流式通道有）；预览 iframe / 浮窗 / 手机桥（v6 已退役并有测试锁）；
plugin-shield/locale-compat/guard（手动或只读）；皮肤 CSS（13 皮肤全审计干净）；
「fiber.uid 假 revision」（volatile 写不重建 fiber）；「配置变更重执行客户端模块」
（rev 只跟 bundle 文件元数据挂钩）。皮肤注册两遍 = 调试期编辑 live profile 文件
触发的 HMR 级联（合法 reload，非双实例）。

## 修复（五补丁，全部走 patch-deps 锚点 + 一处 EAC 自有代码）

| # | 补丁 | 目标 | 治什么 |
|---|---|---|---|
| 1 | settings-write-retry v2 | dsh-client-ui-settings | conflict 恢复后按新 revision 重试一次（原僵尸补丁复活，修正锚点+错误码+代际守卫） |
| 2 | theme-write-converge·防护 | dsh-client-ui-theme | adopt() 按字段跳过在途覆盖；失败回滚到最后 settled 值；10s deadline 防饥饿 |
| 3 | theme-write-converge·收敛 | 同上 | 每字段至多一笔在途 wire 写，飞行中点击只更新目标值（N 点击=1 写） |
| 4 | reconcile 性能三连 | dsh-config-editor / dsh-app-boot | manifestOf 记忆化（stat 键）；写前 reconcile 内容未变短路（并消灭重复 config-reload 事件）；兼容文件复用撤下（跨锁并发窗口） |
| 5 | 拷贝完整性 | lib/plugin-copy.ts（EAC 自有） | 完整性判定加 size 比对，捕获截断类损坏 |

配套：postinstall 去掉 `|| exit 0`；`test/patch-anchor-regression.test.ts`
回归测试（含安装树绊网，让僵尸补丁变红而非静默跳过）。

## 验收（计数器断言，目测不可靠——补丁 2×4 叠加后闪烁彻底消失）

1. fontSize 步进器 150ms 窗口连点 5 次 → wire 写笔数 = 1，最终持久值 = 最终显示值
2. 自动采集行 store (value, revision) 轨迹 100 轮 → 在途写期间显示回退次数 = 0
3. 注入 revision bump → mutate 返回 true、重试恰 1 次
4. 双窗口：窗 B 改主题，窗 A 在途写 fontSize → A 排水后 ≤1s 主题更新、fontSize 无回退
5. 单笔写 p95 ≤ 300ms；每次写 config-reload emit ≤ 1 次
6. 源未变开机 copyFileSync = 0；源变更必须真的重拷

## 遗留（非本修复范围，已记录）

- 皮肤 id 选中态会被任意设置写入的 adopt 冲掉（上游既存行为）
- activeSkin 回写 default 的「失活原因」判定（级联期间的皮肤重置根治）
- dsh-ui-skin-loader 持续拒写故障环（需 host 拒写前置，未观测到实例）
