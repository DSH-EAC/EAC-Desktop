# 诊断报告：设置写入回声循环（主题闪屏 / 字号回弹 / 皮肤重置）

> 状态：已定案。修复见 `scripts/patch-deps.ts` 四个补丁，验收标准见「验收」一节。

## 症状

1. 切换深色/浅色主题后，`api/settings/mutate` 请求以约 1Hz 自动连发数秒到
   十几秒（用户无操作），`body[data-ds-dark-theme]` 逐拍翻转（闪屏）
2. 字号调整后回弹：调大后数秒内界面回到更小值；概率触发，点击越密集越易发作
3. 连带：发作后重启，`cordis.patch.yml` 中 `dsh-ui-skin-loader` 的 activeSkin 行
   丢失，皮肤重置为 default（控制台输出 `startup recovery: no skin persisted`）
4. 停手后自愈；官方 web（小 profile）不明显；两台机器、两个版本（0.1.7-rc.2 与
   0.2.0-rc.2 环境）复现

## 根因

```
点击 → ThemeRuntime 乐观发布（先改内存和 DOM，host.set 异步执行且不检查结果）
     → ConfigFormController FIFO 串行队列（无合并）
     → 服务端 configEditor.edit：文件锁 + 写前/写后两次全量 reconcile +
       HMR 串行队列 + preflight 无缓存（每笔约 500 次同步读盘，冷缓存 1-2s）
     → 每笔响应 acceptView → 广播 → adopt() 无在途防护，把显示改回
       该笔的已提交值（历史值）→ 下一笔响应再改到另一历史值
     → 显示按写入历史逐笔回退（闪屏）；同值守卫比较被回退污染的本地值，
       诱发补充点击（写入数约为意图数的 1.5 到 2 倍，即回弹）
触发条件：单笔延迟随 profile 规模与缓存状态在 30ms 到 2s 之间波动（重启后
缓存全冷 + 实时杀软扫描时最长）。症状只在「延迟长 × 连续操作」的交集出现。
```

官方 web 不明显的原因：默认 profile 只有 1 个 bundle（`DEFAULT_PROFILE_BUNDLES`），
写入快到 adopt 回声落在已更新值上。竞态与规模无关，规模只决定可见窗口。

## 关键证据

- fetch 钩子：单次操作后 `settings/mutate` 以约 1Hz 连发十余秒，载荷为
  `ns=ui-theme` 的单字段 set，expectedRevision 逐拍 +1 且全部被接受，与 FIFO
  串行加响应折叠 revision 的链路一致
- 文件秒级监控：patch 文件的 fontSize 在交互期逐值变化、停手后收敛，变化值
  均等于当时显示值 ±1（步进器语义）
- 源码穷举：ui-theme 写入口共 3 处，全部由点击触发且带同值守卫；
  document-updated 消费者全部只读；无定时器周期写者；无第二客户端；
  无传输层重试
- 0.2.0-rc.2 与 0.1.7-rc.2 逐字节比对：三处缺陷文件全部未变

## 已排除

传输层重试（只有流式通道有）；预览 iframe / 浮窗 / 手机桥（v6 已退役并有测试
锁定）；plugin-shield、locale-compat、guard（手动触发或只读）；皮肤 CSS（全部
审计通过）；「fiber.uid 假 revision」（volatile 写不重建 fiber）；「配置变更重执行
客户端模块」（rev 只由 bundle 文件元数据决定）。控制台可见的皮肤重复注册来自
HMR 对插件文件的合法 reload，不是双实例。

## 修复（五补丁，四个走 patch-deps 锚点，一个为 EAC 自有代码）

| # | 补丁 | 目标 | 作用 |
|---|---|---|---|
| 1 | settings-write-retry v2 | dsh-client-ui-settings | conflict 恢复后按新 revision 重试一次（复活从未生效的同名补丁，修正锚点、错误码、代际守卫） |
| 2 | theme-write-converge 防护 | dsh-client-ui-theme | adopt() 按字段跳过在途覆盖；写失败回滚到最后 settled 值；10s deadline 防饥饿 |
| 3 | theme-write-converge 收敛 | dsh-client-ui-theme | 每字段至多一笔在途 wire 写，飞行中点击只更新目标值（N 次点击 = 1 笔写） |
| 4 | reconcile 性能 | dsh-config-editor / dsh-app-boot | manifestOf 记忆化（stat 键）；写前 reconcile 内容未变时短路（同时消灭重复的 config-reload 事件） |
| 5 | 拷贝完整性 | lib/plugin-copy.ts（EAC 自有） | 完整性判定加 size 比对，捕获截断类损坏 |

配套：postinstall 移除 `|| exit 0`；新增 `test/patch-anchor-regression.test.ts`
回归测试（含安装树绊网，补丁失效时测试变红而非静默跳过）。

## 验收（计数器断言。补丁 2 与 4 叠加后闪烁不再出现，目测无法区分已修复与未触发）

1. fontSize 步进器 150ms 窗口内连点 5 次：wire 写笔数 = 1，最终持久值 = 最终显示值
2. 自动采集行 store (value, revision) 轨迹 100 轮：在途写期间显示回退次数 = 0
3. 注入 revision bump：mutate 返回 true，重试恰 1 次
4. 双窗口：窗 B 改主题，窗 A 在途写 fontSize：A 排水后 1s 内主题更新，fontSize 无回退
5. 单笔写 p95 ≤ 300ms；每次写 config-reload emit ≤ 1 次
6. 源未变时开机 copyFileSync = 0；源变更时必须重拷

## 边界声明

写入收敛只做在 ThemeRuntime 私有层，覆盖主题和字号两个字段，即实测风暴的
来源。其他设置表单的 FIFO 排队行为不变（单笔延迟已由 reconcile 性能补丁压
低）。若未来其他表单出现同类风暴，收敛模式可以平移。

## postinstall 退出码三态语义

| 情形 | 退出码 | 报警方式 |
|---|---|---|
| 全部锚点命中 | 0 | 无 |
| 锚点未命中（内核升级后的预期路径，安全跳过） | 0 | 日志记录；安装树绊网测试在测试期变红 |
| 意外崩溃（IO 错误等真实故障，非锚点问题） | 1 | postinstall 硬失败，npm install 可见 |

每个补丁独立 try/catch：单个崩溃不影响其余补丁执行；任一崩溃则进程以非零
码退出。`|| exit 0` 已移除，build 失败不再被吞。

## 上游化计划

四个锚点补丁是过渡载体。收敛与 adopt 防护是上游缺陷的普适修复，流程：

1. 携带证据链向 deepseek-ai/deepseek-harness 提 issue 和最小修复 PR
   （ThemeRuntime 收敛与防护、settings conflict 重试语义、reconcile preflight
   缓存，三者可独立评审）
2. 上游发版纳入后，EAC 升级内核，对应锚点补丁由回归测试判定退役
3. 锚点失配时安全跳过，绊网测试变红：补丁失效始终可被测试发现

上一版同名补丁因三处锚点失配从未生效，数月无人发现。绊网测试防止同类
失效静默存在。
