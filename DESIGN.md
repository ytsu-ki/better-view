# Better View — Antigravity 工作流可视化插件 设计方案

> 目标：在 Antigravity 侧边栏用一眼能看懂的视图显示 agent 正在做什么、进行到哪一步、是否疑似卡住；
> 开启 Teamwork 时以树状多线视图显示各 agent 并行进度。
>
> 本文所有"已核实"结论均基于本机 Antigravity（`/Applications/Gemini.app`，`agy` hub，lsVersion 2.29.0）
> 2026-11-16 的实地检查；标 ⚠️ 的为推断，需在 M0 阶段验证。

---

## 0. M0 结果（2026-11-16）

| 项 | 结论 |
|---|---|
| sidecar 清单格式 | **已核实**（agy 内嵌文档 + proto）。插件内放 `sidecars/<文件夹>/sidecar.json`，sidecar id = `<插件名>/<文件夹>`。字段：`command`、`args`、`builtin`(schedule)、`restart_policy`、`description`、`display_name`、`env`、`disabled`、`has_web_ui`、`ui_config{display_name, views[{entrypoint, path, title, url, file_extensions, url_schemes}]}`、`agent_permissions{access_grants, workspace_uris, allows_user_interactions}`。CWD = sidecar 文件夹；stdout/stderr 落在其 `logs/`；持久数据写 `$ANTIGRAVITY_EXECUTABLE_DATA_DIR`。`agy plugin validate --strict` 通过（sidecars 1）。 |
| 注入环境变量（F4） | **已核实**：官方 Node sidecar 框架要求 `ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`、`ANTIGRAVITY_SIDECAR_WEB_PORT`，可选 `ANTIGRAVITY_SIDECAR_UI_TOKEN`、`ANTIGRAVITY_PROJECT_ID`、`ANTIGRAVITY_CONVERSATION_ID`、`ANTIGRAVITY_AGENTAPI_EXE`。只绑 127.0.0.1；非 GET 请求校验 `x-sidecar-token` 头或 `?token=`。 |
| LS API（F9） | **已核实**（用户手动探测）：`GetAllCascadeTrajectories` 返回 `trajectorySummaries{<convId>: {summary, stepCount, status(CASCADE_RUN_STATUS_*), lastModifiedTime, lastUserInputTime, latestExecutorTerminationReason, annotations.title, trajectoryMetadata.rootConversationId, trajectoryId}}`。`rootConversationId` 可把子会话挂到根上。 |
| Teamwork（F11） | 内部名 **native swarm**：由 `manage_subagents` 工具驱动（`add/kill/status/model/models/title/join`），worker 有花名册名、brief、可选 `workspace: inherit/share/branch`；协作经 **board**（`backend: auto/spanner/local`，本地为 filestore `board.jsonl`）。完整运行样本待采集（`scripts/sample_teamwork.py`）。 |
| 侧边栏 tab 出现 | **否定（当前宿主）**：插件安装为 enabled，App 重启后 Overview ▸ Extensions 仍为 "No extensions available"；放入 `~/.gemini/config/sidecars/` 也无效。`GetSidecars` 返回 `failed_precondition: sidecar manager not initialized` —— Gemini.app 内嵌的 Antigravity 宿主（hub 以 `--use_host_auth --host_bridge_url` 启动）未启用 sidecar 管理器。二进制默认 flag 中 `enable-sidecars`/`enable-ui-sidecars` 为 true，但 CLI/IDE/SDK 子客户端为 null。插件保留安装，宿主日后支持时零改动生效。 |
| 下一步 | UI 层需要宿主无关的承载方式（见 §2 备选）；数据层、卡死检测不受影响。sidecar 已改为只连接 pid 存活的 hub。 |
| 修正 | 内嵌文档称 "Antigravity 2.0 is a desktop Electron application"（随 Gemini.app 分发）。结论不变：不是 VS Code 分支，UI 走 sidecar。 |

## 0.1 M1 结果（2026-11-16）

运行：`npm start` → 浏览器打开 `http://127.0.0.1:47321/`（宿主支持 sidecar 时同一程序作为侧边栏运行）。

| 能力 | 数据来源 | 状态 |
|---|---|---|
| 单线视图：当前动作卡片 + 时间线 | `transcript.jsonl` 增量读取（1s 轮询）+ `GetAllCascadeTrajectories` 运行状态 | ✅ 真实 transcript 回放 + 追加延迟实测 ≈1s |
| 用量圆环（新增） | `RetrieveUserQuotaSummary` → `groups[].buckets[]{displayName, window, remainingFraction, resetTime}`；回退 `GetUserStatus` 内嵌 `quotaInfo` | ✅ 真实 hub（ls 2.29.0）已验证：3 个桶 `Weekly Limit Remaining` / `Five Hour Limit Remaining` / `Gemini 4 Argon Weekly Limit`，无 group 名。proto3 JSON 省略零值 → 缺 `remainingFraction` 的桶视为**已用尽**。标签去掉 Limit/Remaining 显示短名 |
| 上下文用量（新增） | 运行中会话订阅 `StreamAgentStateUpdates`，取 `contextWindowUsage{estimatedTokensUsed, maxContextTokens, estimatedAfterCompaction}`；无连接时用最近一次模型调用的 `input + cache_read + output` 估算（无上限） | ✅ 流式解析对假 LS 验证（实时增长）；**真实流待会话运行时确认**。每个模型学到的上限缓存到 `~/.cache/better-view/models.json`（`BETTER_VIEW_CACHE` 可改），空闲会话也能显示百分比；上限未知时只显示数字、不画条 |
| 后台任务 | GENERIC `RUNNING` 行 + SYSTEM_MESSAGE `Task id "…" finished/was canceled` + `manage_task kill` + 服务重启通知 | ✅ |

实现说明：零依赖 Node ESM（`sidecars/panel/lib/{transcript,hub,reducer,store}.mjs`），不再引入 TS/打包；`node --test` 19 项单测；`test/fake-ls.mjs` 为不需要真实凭据的本地假 LS。
可视化遵循 dataviz 规范：圆环为"单比值对上限"的环形 meter（同色系浅轨、蓝→琥珀→红按严重度、中心百分比用正文色、悬停给出重置时间），状态色均配图标与文字。
"服务重启"警告只在重启发生于最近一轮时显示（更早的重启只留在时间线里）。
另发现 `ExecutionStatus.modelRequest{attempt, maxAttempts, retryAt}` —— 模型请求重试中的直接信号，留给 M2 卡死检测。

## 0.2 M2 结果（2026-11-16）

卡死检测在 `sidecars/panel/lib/stall.mjs`，每 2 秒对每个会话给出一个结论和证据：

| 级别 | 含义 | 判据 | 通知 |
|---|---|---|---|
| WAITING | 等你操作 | `ask_question` 未答；或实时流 `executionState=STATE_WAITING_FOR_USER` / `waitingSteps` 非空 | ✅ |
| SLOW | 比平时慢 | 前台工具 > max(3×该工具 P99, 1 分钟)；模型 > 历史 P99；模型请求重试（`modelRequest.attempt>1`） | ✗（只显示） |
| STALLED | 疑似卡住 | 前台工具 > max(8×P99, 8 分钟)；模型 > max(2.5×P99, 5 分钟)；`ERROR_MESSAGE` 或报错后 1 分钟无新步骤 | ✅ |
| HALTED | 已停止但本轮没完成 | hub 报 IDLE，而 transcript 最后一行不是最终回复（宽限 15 秒；`USER_CANCELED` 除外） | ✅ |
| DEAD | 服务已退出 | 发现文件里的 hub pid 不再存活，而该会话上次是忙碌状态 | ✅ |

阈值由本机全部历史 transcript 自动校准（每分钟重算）。本机实测：模型调用 P50 10s / P99 129s；`run_command` P99 28s、最长 751s。
证据附加：未返回的工具、终止原因（`EXECUTOR_TERMINATION_REASON_*`）、hub pid 变更、hub 日志中的登录失效 / 连续网络错误（遥测上报错误视为噪音排除）。
后台任务日志 5 分钟不增长只做标注（服务类任务安静是正常的），不报警。
通知：macOS `osascript`（文本经 argv 传入，不拼进脚本）；同一轮评估里同级别的多个告警合并为一条；启动时已存在的状态不通知；本轮 ≥3 分钟的任务完成时也通知。`BETTER_VIEW_NOTIFY=0` 关闭。

**M1 时间戳修正**（M2 中发现）：`created_at` 是步骤**开始**时间——PLANNER_RESPONSE 是模型调用开始，GENERIC 是工具开始（结束时间在内容的 `Completed At`）；行在步骤完成后才追加。现在用 `Completed At` 和文件 mtime 作为“最后活动”，否则长命令结束后思考计时会虚高。
其他新事实：`CHECKPOINT` 行 = 上下文压缩后恢复；`ERROR_MESSAGE` 行 = 模型报错（可能为空，或含 `Retries remaining: N`）；`SYSTEM_MESSAGE` 之后 30 秒内必有模型调用（会唤醒 agent）；运行状态枚举含 `CASCADE_RUN_STATUS_BUSY`；`ask_question` 参数为 `questions:[{question, options, is_multi_select}]`；前台命令的 `steps/N/output.txt` 在命令结束时才创建（无法观察前台输出增长）；后台任务日志 `tasks/task-N.log` 边跑边写。

验证：
- `node --test` 36 项全过（新增 `test/stall.test.mjs`、`test/store.test.mjs`，全部为合成数据）。
- `node scripts/replay_stalls.mjs` 回放本机 7 个真实 transcript 的 3,900 个“本轮未完成”间隔：OK 3867 / SLOW 24 / STALLED 5 / WAITING 3。两个已知卡住样本（报错后停住、压缩后 5 分 40 秒无响应、你随后插话）都标红；另一个（命令未返回 107 秒后你插话、随后服务重启）在 1 分 46 秒标黄，实际运行时由 hub 进程监测标为 HALTED/DEAD。其余 3 次红色是确实 6–12 分钟无进展的间隔。
- `test/sim-stall.mjs`（launch 配置 `better-view-stall-sim`）在临时目录里伪造 hub 发现文件 + 假 LS，按时间写入 transcript，逐一触发 WAITING → HALTED → STALLED → SLOW → DEAD，界面与告警日志均已核对，`osascript` 测试通知退出码 0。
- **未在真实环境验证**：实时流里 `executionState` / `waitingSteps` / `modelRequest` 的字段路径（来自二进制推断，取不到时不影响其他判据）。

## 0.3 M3 结果（2026-11-17）：浮动侧窗（已移除，见 0.14）

宿主不启动 sidecar，所以侧边栏改由原生小程序承担：`mac/BetterView/main.swift`（单文件，命令行 `swiftc` 构建，无需 Xcode），`mac/build.sh` 产出 `mac/build/Better View.app`（ad-hoc 签名，菜单栏应用，无 Dock 图标）。

- **浮动侧窗**：非激活式 NSPanel + WKWebView 加载 `http://127.0.0.1:47321/?embed=1`（嵌入模式隐藏网页自己的标题）。点它不会把焦点从 Antigravity 抢走；跨所有桌面空间显示。
- **位置**（菜单栏 → 位置）：
  - 跟随 Antigravity 窗口（默认）：用 CoreGraphics 窗口列表取 `com.google.GeminiMacOS` 主窗口的位置（只读位置，不需要录屏或辅助功能权限），右侧有空间就贴在窗外，否则贴在窗内右缘；只在 Antigravity 处于前台时显示，像侧边栏一样；出问题时无论前台是谁都弹出。
  - 停靠屏幕右侧 / 左侧 / 自由浮动。宽度可拖动调整并记住。
- **菜单栏图标**按最严重状态变化：红色三角＝需要处理（STALLED/HALTED/DEAD），蓝色问号＝等你操作，黄色＝比平时慢，虚线圆＝运行中，侧栏图标＝空闲，灰色＝服务未运行；悬停或打开菜单看汇总（如“1 个需要处理 · 2 个运行中”）。
- **出问题时自动弹出**（可关）：有新会话进入 WAITING/告警时显示面板。
- **全局快捷键 ⌥⌘B** 开关面板（Carbon 热键，不需要辅助功能权限）。
- **服务掉线**：图标变灰；首次加载失败显示说明页，服务恢复后自动重新加载。
- **常驻**：`scripts/install-mac.sh` 构建并复制到 `~/Applications`，注册两个 launchd agent：`com.betterview.server`（登录即启动服务、崩溃自动重启，日志 `~/Library/Logs/better-view/server.log`；面板关着也照样检测和发通知）与 `com.betterview.app`（登录时打开侧窗）。`--uninstall` 移除；`--dry-run DIR` 只生成并校验 plist。

验证：
- `--self-test`：6 项纯函数检查（状态汇总、旧告警不计入、跟随位置计算——全宽窗口贴内缘 / 有空间贴外侧）。
- 实机运行对接 `test/sim-stall.mjs`：应用日志确认 启动 → 4 个运行中 → WAITING 时自动弹出并贴在 Antigravity 窗口内右缘（1074,82,360×760）→ HALTED 时图标转红；停服务 → 图标灰；服务未运行时启动显示说明页 → 服务恢复后自动重载；停靠右侧位置正确（1080,71,360×799）。
- `run.sh` 在空环境（模拟 launchd）下能找到 node 并启动；两个 plist 通过 `plutil -lint`。
- **未验证**：菜单栏图标与标题栏的实际观感、⌥⌘B 实际按键（本环境无法截屏或模拟全局按键）；launchd 实际安装（会写入常驻配置，需你确认后运行）。

## 0.4 M4 结果（2026-11-17）：任务清单 + Teamwork 团队视图 + 界面重做

按你的反馈（总任务清单、余量、简洁、多 agent 一屏）一起做完。

**Teamwork 真实结构**（采样 `samples/20261117-020000`，一次 18 个会话的 `/teamwork` 运行）：
你的会话 →（`invoke_subagent` Role "Teamwork Coordinator", TypeName `teamwork`）Coordinator → Task Interviewer / Project Orchestrator / Post-Victory Auditor；Orchestrator → 调研 ×3、实现 ×4 + 测试 ×1、审查 ×5。
- 父子关系：子会话第一行 SYSTEM_MESSAGE 的 `sender=<父会话 id>`；父会话 `invoke_subagent` 的结果 “Created the following subagent: {conversationId}” 及其 `Role`/`TypeName`。
- 名字：“You are \`worker_m1\`” 或元数据目录 `.agents/teamwork/<名字>/`。
- 清单：每个 agent 在 `.agents/teamwork/<名字>/progress.md` 维护 `- [x]` 清单；Orchestrator 的就是全队总清单。少数 agent 写时间线而非勾选项，取最后一条作为“最新进展”。
- 工具真名：`view_file`、`write_to_file`（`TargetFile`）、`replace_file_content`、`invoke_subagent`、`send_message`、`manage_subagents`。

**实现**：
- `lib/team.mjs`：按父子关系把会话归成“任务”（单会话也是一个任务），广度优先排成员，角色分四族（协调/调研/实现/审查），卡片名过长时用 agent 自己的短名。
- `lib/checklist.mjs`：解析勾选清单（`[x]` 完成、`[/]` 进行中、`[ ]` 未做，缩进为子项），按修改时间缓存。清单来源优先级：agent 写的 progress/task/todo/plan.md → 你的每条指令（完成一轮勾一项）。请求/验收标准类文件（ORIGINAL_REQUEST.md 等）不算清单。
- 父 agent 有未完成的子 agent 时视为“等待子 agent”，不判慢/卡住/停止（之前回放里 Coordinator 和你的会话被误标 5 次红，修后 0 次）。
- 通知：只有你的主会话完成才发“已完成”；子 agent 告警标题带任务名。
- UI 重做：任务选择器只列任务（不再在 subagent 之间跳）；一屏 = 标题 → 告警（标明哪个 agent）→ 任务清单 → 团队（协调链 + 按族分组的卡片，完成的组折叠成小标签，点卡片看该 agent 详情）→ 合并活动记录。用量改显示**余量**（≤30% 黄、≤10% 红）。族色取规范分类色 1–3 + 7（跳过与警告冲突的黄），浅/深色相邻配对校验通过，色块旁始终有文字。
- 菜单栏 app 按任务计数（18 个 agent 的团队算一个任务）。

验证：
- `node --test` 43 项全过（新增 `test/team.test.mjs`：拓扑、短名、清单解析、reducer 团队字段、真实工具简述）。
- 真实采样：18 个会话正确归为一个团队，层级与 Role 全部对上；Orchestrator 清单 8/8（采样当时）。注意：你之后把项目移到了 `~/Documents/gemini/antigravity/test/sidebar`，原 progress.md 路径已不存在，所以现在这个任务的清单回退为“按你的指令”——这是预期行为。
- `node scripts/replay_stalls.mjs`（加入子 agent 存活期后）：红色仍只有原来 5 个真实样本，Teamwork 18 个会话 0 误报。
- `test/sim-team.mjs`（launch 配置 `better-view-team-sim`）：总清单随 progress.md 实时勾选；调研组完成后折叠；M3 报错停住 → 主屏红色告警并标明 “M3 Sync Worker”；M2 慢 → 黄色；父 agent 显示“等待子 agent”；点卡片进详情（它的清单、当前、上下文、记录）再返回。深色/浅色、380px 宽、真实单会话（15 条指令清单）均检查过，控制台无报错。
- **未验证**：真实 Teamwork **运行中**的实时观感（采样时已结束）。

## 0.5 侧栏形态 + 跟随 Antigravity 当前会话（2026-11-17）

按反馈：“不要像一个窗口，改成 sidebar；不用追踪任务，点哪个会话就显示哪个”。

- **宿主侧边栏仍不可用**：Antigravity 未更新（hub lsVersion 仍为 2.29.0），sidecar 管理器依旧未初始化，无法嵌入它的界面。
- **当前会话的来源**：`annotations/<会话id>.pbtxt` 中的 `last_user_view_time`——在 Antigravity 里打开会话时更新（已核对：查看时间 = 文件修改时间）。服务端每秒检查这些文件的修改时间，`state.focus` = 最近被查看的会话；若 LS 摘要带 `annotations.lastUserViewTime` 也一并取用。`antigravity_state.pbtxt`、`presence/*.lock` 不含当前会话（lock 在会话创建时生成）。
- **界面**：去掉“自动跟随最新任务”。默认显示你在 Antigravity 打开的会话；打开的是子 agent 就直接进它在团队里的详情。选择器手动选的会保持，直到你在 Antigravity 里打开另一个会话。
- **原生侧栏**：无标题栏、无阴影，紧贴 Antigravity 窗口右缘、与窗口等高；内侧 1px 分隔线可拖动调宽（280–720）。
  - 授权“辅助功能”后（菜单 → 让 Antigravity 让出侧栏位置，由 macOS 弹窗、用户在系统设置里授权）：右侧没空间时把 Antigravity 窗口收窄、侧栏并排；隐藏侧栏、切换位置或退出时恢复原宽度。收窄后会小于 640pt 时不收窄。
  - 未授权：覆盖在窗口内侧右缘（标题栏以下）。
  - 注意：ad-hoc 签名每次重新构建都会变，重装后可能需要重新授权。

验证：`node --test` 44 项（新增 annotation 解析）；app `--self-test` 9 项（侧栏布局四种情形 + 计数）；`test/sim-team.mjs` 模拟在 Antigravity 中依次打开 主会话 → M2 worker → 主会话，面板依次显示 主会话 → M2 详情 → 主会话，控制台无报错。真实数据中 `focus` = 你最后打开的会话；**你在真实 Antigravity 中点不同会话，侧栏跟着切换（2026-11-17 已确认）**。**未验证**：侧栏实际外观、收窄 Antigravity 窗口的实际效果（需你授权并查看；本环境无法截屏）。

## 0.6 侧栏行为与界面收敛（2026-11-17）

按反馈：①侧栏只在 Antigravity 是前台时显示；②要能手动调侧栏占比；③少用颜色、会话区是中心、上下文放到额度下方。

- **显示规则**（`shouldShow`）：Antigravity（或侧栏自身）在前台、且其窗口在当前屏幕上才显示；切到别的程序、最小化或在别的桌面空间就隐藏。出问题时不再盖到别的程序上，只“预约”在回到 Antigravity 时显示，提醒交给系统通知和菜单栏图标。从菜单/⌥⌘B 主动打开的，保留到切换程序为止。
- **调宽度**：原因是侧栏为不激活面板——macOS 把第一次点击吞掉用于激活，光标形状也只在激活窗口里生效，所以分隔线拖不动、也看不出来。现在分隔线（8px）接收第一次点击、用常驻追踪区设置左右箭头光标、悬停加粗高亮。授权辅助功能后，拖动分隔线同时调整 Antigravity 窗口宽度（变窄变宽都跟随）；你自己挪动/缩放 Antigravity 窗口后，侧栏不再接管它的宽度。
- **界面**：单色；只有出问题时出现琥珀（慢/余量低）和红（卡住/用尽），均配图标与文字。卡片边框改为细线分区；角色色块取消；进度条/圆环/勾选为中性灰。顶部顺序：额度（小圆环 + 剩余%，重置时间在悬停提示）→ 上下文（当前显示的会话或所点 agent 的）→ 会话选择 → 标题 → 告警 → 清单 → 团队/当前 → 活动。
- app 日志写到 `~/Library/Logs/better-view/app.log`（launchd 用 `open` 启动会丢 stderr）。

验证：app `--self-test` 14 项（新增拖窄后 Antigravity 变宽、四条显示规则）；`node --test` 44 项；团队模拟在 360px 宽、深/浅色下检查新界面，无新增控制台错误。**未验证**：分隔线拖动的实际手感、授权后的并排效果（需你操作）。

## 0.7 插件侧边栏版本（2026-11-17，为独立版 Antigravity App 准备）

Google 另有独立的 Antigravity App（官网 antigravity.google/download，v2.32.0；`brew install --cask antigravity`），与 Gemini.app 内嵌版分开。是否启用 sidecar 未知——独立版自己托管 hub，可能不受 Gemini 宿主的限制，需装上后实测。

- `scripts/install-plugin.sh`：把 plugin.json、assets、`sidecars/panel/`（sidecar.json、run.sh、server.mjs、lib、ui）放进 `build/plugin/better-view`，先 `agy plugin validate --strict`（通过：sidecars 1），再同步到 `~/.gemini/config/plugins/better-view`（保留宿主的 logs/、data/）。`--check` 只校验。已安装 0.4.0，`agy plugin list`：enabled。
- 页面路径 `/sidebar`、`/aux` 自动用嵌入式样式。
- sidecar.json `env.BETTER_VIEW_NOTIFY=auto`：常驻服务（47321）还活着时插件不发通知，避免重复；常驻服务不在时由插件发。
- **安全修正**：此前“有 UI 令牌就放行任意 Host”却从未校验令牌，插件模式下等于关掉了 DNS 重绑定防护。现在非本机 Host 必须带正确令牌（`x-sidecar-token` 头、`?token=`，或首次带令牌加载后设置的 HttpOnly/SameSite=Strict cookie），时间恒定比较；无令牌（独立模式）只认本机。11 种情况实测：本机 200；外部 Host 无/错令牌 421；头/参数/cookie 正确令牌 200。
- 模拟宿主启动（空环境 + `ANTIGRAVITY_SIDECAR_WEB_PORT` + `ANTIGRAVITY_SIDECAR_UI_TOKEN`，从已安装目录运行 run.sh）：/sidebar、/aux、静态资源 200；320px 宽嵌入式渲染正常、无控制台错误。
- **未验证**：独立版是否显示插件侧边栏、它的数据目录是否也是 `~/.gemini/antigravity`、宿主加载页面的确切 URL 形式。

## 0.8 独立版实测：插件 UI 被实验开关挡住 → 改走 MCP App（2026-11-17）

**实测（Antigravity App 2.32.2，Electron）**：hub 以 `--enable_sidecars` 启动，数据目录同为 `~/.gemini/antigravity`；我们的 sidecar 被宿主启动（`sidecar_data/better-view/panel/logs`，宿主为它开了网关 `Sidecar better-view/panel gateway listening …`），后端一切正常——但界面没有入口。
- 原因：前端（由 LS 提供的 `main.js`）里插件 UI 由 `showUISidecars: Oi(b, "enable-ui-sidecars")` 控制，值来自服务端实验配置（`experimentEnabledProviders`），本地无覆盖途径；附近还有 `allow_all_sidecars` / `is_google_internal`。目前对普通账号是关的。绕过需改 App/LS，不做。
- 左侧栏 Plugins 区另受 `pluginSidebarSection` 控制。

**改走 MCP App（官方文档内嵌在 LS：“Developing MCP Apps”，SEP-1865）**：带 `_meta.ui.resourceUri` 的 MCP 工具 + `_meta["com.google.antigravity/ui"].entrypoints`：
- `aux_pane` → 侧边面板“+”菜单 / Overview ▸ Extensions，作为对话旁的 tab 打开——**不受上述实验开关限制**（前端：`y = available && (showUISidecars || mcpAppTools.length > 0)`）。
- `global` → 左侧栏整页入口（受 `pluginSidebarSection` 控制，是否显示待实测）。
- 实现：`mcp/server.mjs`（stdio JSON-RPC，无依赖，进程内复用 Store）：工具 `open`（两个入口）与仅 app 可调的 `state`；资源 `ui://better-view/panel.html`（`text/html;profile=mcp-app`，把 ui/ 的 HTML+CSS+`mcp-bridge.js`+app.js 内联成单文件，每次打开重新组装）。
- `ui/mcp-bridge.js`：postMessage JSON-RPC——`ui/initialize`（protocolVersion `2026-01-26`）→ `ui/notifications/initialized` → 每 1.5s `tools/call state`；`host-context-changed` 的规范变量（`--color-background-primary` 等）映射为面板色；沙箱内无网络、无存储，全部经宿主调用。
- 打包：Agent Plugins 规范下 MCP 服务写在 `mcp.json`（command 必须是裸命令名或插件内 `./` 路径：`./mcp/run.sh`），原生模式读 `mcp_config.json`（`${PLUGIN_ROOT}`）；两者都带。`agy plugin validate --strict` 通过：mcpServers 1 · sidecars 1。sidecar 设为 `disabled`（UI 被挡，避免数据跑两份）。版本 0.5.0。

验证：`node --test` 47 项（新增 `test/mcp.test.mjs`）；stdio 实测 initialize / tools/list / resources/read（44KB 单文件、无外部引用）/ state（322KB）/ 未知方法 / 关闭 stdin 退出；`test/mcp-host-sim.mjs` 模拟宿主（沙箱 iframe + 握手 + 转发 tools/call + 主题变量）：严格沙箱（origin null）下 DOM 正常、无错误；同源模式截图确认 360px 渲染与宿主深色主题。**待实测**：重启 Antigravity 后 MCP 服务是否启动、“+”菜单 / Extensions 是否出现 Better View、左侧栏 global 入口是否出现。

**实测进展（05:46 重启后）**：宿主**确实启动了** MCP 服务（`node server.mjs`，父进程为 LS，cwd 为插件 `mcp/`；工具定义缓存在 `~/.gemini/antigravity/mcp/better-view_view/{open,state}.json`）。Customizations ▸ MCP Servers 只列全局 `mcp_config.json` 里的服务（显示 1 个 colab-mcp），插件服务不在其中，不代表没加载；Plugins 区显示 Better View 已启用。LS 日志不记录插件 MCP 服务，其 stderr 也看不到 → 服务端另写 `~/Library/Logs/better-view/mcp.log`（只记生命周期与方法名，不记参数/结果；`BETTER_VIEW_MCP_LOG=0` 关闭）。顺带修复：stdin 关闭时先等 stdout 写完再退出（大响应曾被截断）。

**侧栏面板卡在“连接中…”（06:28 重启后实测）**：此时 MCP 服务只收到 initialize / tools/list，没有 resources/read，所以那个标签实际是插件 sidecar 的 AUX_PANE 视图（标题同为 Better View），并非 MCP App。原因：sidecar 网关只放行带 token 的请求（iframe 地址带 `?token=`；官方 SDK 用 `X-Sidecar-Token` 请求头），我们页面里相对路径的 `style.css` / `app.js` / `api/events` 都不带 token，被网关 401 拒掉，脚本没运行。修复：`lib/page.mjs` 把页面内联成单文件（sidecar 不带桥，MCP 带桥），只需一次请求；sidecar 模式改为每 2s 带请求头 `fetch api/state`（EventSource 设不了请求头）；10s 内仍无数据时，面板直接显示模式与错误原因。`test/sidecar-gateway-sim.mjs` 模拟网关（无 token 一律 401）：页面与轮询全部 200，数据正常。

## 0.9 实机可用后的调整（2026-11-17）

- **侧边栏实机可用**（sidecar 的 AUX_PANE 视图，经网关带 token 轮询）。侧边面板的 tab 按会话保存（`treeId = cascadeId:<id>`）：每个会话打开一次后会记住，新会话需要再从“+”打开一次；自动打开（`sidecarPillAutoOpen`）和左侧栏 global 入口都受服务端开关控制，插件无法改变。原生常驻侧栏（M3）不受影响，跟随所有会话。
- **你停止 ≠ 卡死**：新级别 `STOPPED`（显示“已停止”，不弹提醒、不发通知）。`USER_CANCELED` → 已由你停止；发出消息后立刻停止时，这轮没有任何模型输出、终止原因还是上一轮的 `NO_TOOL_CALL`（执行器根本没写记录）→ 同样判为 STOPPED。模型已开始工作后被异常终止仍是 HALTED。reducer 新增 `turnModelRows`。
- **余量颜色**：蓝（>30%）/ 黄（≤30%）/ 红（≤10%），去掉 ⚠ 图标。
- **主题变量冲突**：宿主推送的是 shadcn 变量，其中 `--muted` 是背景色，原先整组拷贝会把我们同名的灰色文字刷成背景色（几乎看不见）。改为只映射需要的几个（`--background/--foreground/--secondary-foreground/--muted-foreground/--border/--link`），我们的灰色改名 `--ink-3`。
- **上下文按来源分色**：Antigravity 每次模型调用都在 `conversations/<id>.db` 的 `gen_metadata` 里记录 `ContextWindowMetadata`（路径 1→9→10：1 已用、3 TokenBreakdown、4 上限；分组 System Prompt / Tools / Chat Messages / Unspecified，带子项）。`lib/ctxdb.mjs` 用 `node:sqlite` 只读读取最新一条、按 mtime 缓存（约 6ms）。条形图在“已用”部分内按来源分段（系统提示 紫 / 工具定义 青 / 对话消息 蓝，参考调色板第 7/3/1 槽，明暗两套已过校验；2px 间隔），占比 <5% 的并入“其他”；下方图例写名称和 token 数，悬停看前三个子项。告警色只用于右侧数字。
- **语言跟随 Antigravity**：Antigravity 是 Electron 应用，界面语言取系统首选语言；`lib/i18n.mjs` 读 `AppleLanguages[0]`（本机 en-US → 英文）。面板右上角“中/EN”切换，写入 `~/.cache/better-view/prefs.json`，所有 Better View 进程（sidecar、MCP、常驻服务）共享；按住 Option 点击恢复跟随。服务端文字（判定、证据、步骤摘要、通知）也走同一语言，切换后 Store 重建所有 run（`relang()`）。环境变量 `BETTER_VIEW_LANG` 优先（测试固定为 zh）。

## 0.10 先列任务表再执行（2026-11-17）

- Antigravity 2.32 的 agent 没有 TodoWrite 这类工具；但它的 planning mode 有原生约定：在 artifacts 目录（`brain/<会话 id>/`，默认 prompt 已告诉 agent 这个路径）写 `task.md`，`[ ]` 未开始 / `[/]` 进行中 / `[x]` 完成。默认模式下不会写。
- 插件新增常驻规则 `rules/AGENTS.md`（`agy plugin validate`：rules 1；`agy plugin list` 显示已注册）：凡是多步请求，先拆成 3–8 步写入 `task.md`，开始一步标 `[/]`、完成立即标 `[x]`，计划变化就改清单，新请求换新清单；问答、闲聊、单步请求不写。
- 面板：清单来源 = agent 写过的清单文件，否则 `brain/<id>/task.md`；不再用“你的每条指令”充当清单；上一个请求的已完成清单在新请求开始后隐藏。样式仿 Claude Code：虚线圆 = 未开始、旋转圆环 = 进行中、勾 = 完成；去掉进度白条和来源行。
- 精简：标题区只保留模型、团队人数、运行中的已用时间（去掉“最后活动 xx 前”“本轮耗时”）；活动记录不再列你发的消息。
- `test/demo-checklist.mjs`：假数据目录里的会话每 4 秒推进一步，用于看效果。

## 0.11 其他模型的额度（2026-11-17）

`RetrieveUserQuotaSummary` 只有共享池（Weekly / Five Hour / Gemini 4 Argon Weekly）。Claude、GPT 等模型的额度挂在 `GetUserStatus` 每个模型配置的 `quotaInfo` 上（Antigravity 的“某模型额度已用完”提示读的就是它）。现在两者都取：`modelQuotas()` 把剩余比例和重置时间完全相同的模型并成一个池，按厂商命名。实测：6 个 Claude 模型和 GPT-OSS 120B 剩余比例、重置时间完全一致 → 一个池 “Claude · GPT”（悬停可见共用的模型）；Gemini 模型由汇总里的池覆盖，不重复显示。

## 0.12 团队树 + 每个 agent 的模型；通知改由 Better View 应用发出（2026-11-17）

- **模型**：子 agent 的 transcript 里没有模型名；会话库 `gen_metadata` 最新一条的 3→28（备选 1→19）是这次调用实际用的模型 id（实测：主会话 `gemini-4-hydrogen-high`、“你好”会话 `claude-opus-5-5-medium`，与界面一致）。`ctxdb.convMeta()` 同时返回模型和上下文分解；`prettyModel()` 转成 “Claude Opus 5.5 · Medium”。
- **团队树**：按真实上下级（`team.parentId`）画缩进树 + 细连线：你的会话 → Teamwork Coordinator → Interviewer / Orchestrator / Post-Victory Auditor；某个节点下属 ≥4 且分属多类时按 调研 / 实现 / 审查 分组（可折叠，全部完成且团队仍在运行时自动折叠；组内模型相同时只在组标题显示一次）。每行：状态（运行中为旋转圆环）、名称、模型、一句话分工（角色名比名字多信息时用角色，否则用任务说明第一行）、清单进度与用时；点击进入详情（详情页显示上级（可点）和下属数）。
- **团队图**（第三版，按用户给的 Claude Code subagent 图）：颜色只表示层级（主会话 橙 → 第 1 层 紫 → 第 2 层 绿 → 第 3 层 蓝，更深层绿/蓝交替；按此顺序相邻色已过校验），与模型无关；顶部图例按层列出人数。方框居中、等宽字体，只放四样：1–3 词分工（由角色名提炼：`Survey Explorer Environment`→environment survey，`M1 Kinematics Worker`→kinematics）、模型、带 % 的进度条（有清单按清单，完成为 100%，运行中无清单为滑动条）、一词状态（运行中/完成/卡住/等你/已停止）。层级之间用带圆点和箭头的连线；一批 helper 用总线扇出，每行最多 3 个、每个方框上有箭头，多行时左侧一条竖线把各行总线连起来；某个 helper 自己的下属从它所在列接出；多类 worker 按类分组，组标题“orchestrate → 实现 5/5”。详细信息在悬停提示和点击后的详情页。
- **通知**：Antigravity 没有给插件的通知接口（sidecar 只有发消息/新建会话/读元数据；MCP Apps 无通知请求；它自己的系统通知只在内部为“需要你操作/完成”触发），`antigravity://` 链接也只支持 OAuth、插件页、AI Studio 导入，不能定位到会话。所以改为由 Better View 应用（菜单栏常驻那个）用 UserNotifications 发出：图标是插件 logo（build.sh 用 Quick Look 把 logo.svg 渲染成 icns），点击切到 Antigravity。服务把通知放进 `/api/state` 的 `notices`（最多 20 条，id 递增），应用每 2 秒轮询时带 `X-BetterView-App: notify|app`；10 秒内应用在线且已获授权 → 服务不再调用 osascript，否则仍用 osascript 兜底。菜单新增“发送测试通知”（`POST /api/test-notify`）/“通知未开启：打开系统设置…”。

## 0.13 动效（2026-11-17）

- **原则**：没变化就不动，变化的那一刻才动；`prefers-reduced-motion` 时全部关闭（数值直接到位、无入场、无转场）。
- **为什么在 JS 里记**：面板每次更新（1.5–2 秒）整页重建 DOM，CSS 动画会随元素重建而重播。所以 `app.js` 按“元素代表什么”记状态：`glide()` 数值补间（圆环、上下文条、方框进度条和它们的数字，新目标从当前值继续）；`fx()` 一次性动画（触发后每次重建都重新加上 class，并用负的 `--d` 接着播，不从头来）；`changed()/arrived()` 判断“这次更新里变了/新出现了”（切换屏幕时新屏上的东西不算“新出现”）。无限循环动画（转圈、光点）每次重建后把 `startTime` 对齐到文档时钟，所以不会每 2 秒跳回起点。
- **有哪些**：首次打开各段依次浮现、额度环依次画出并数字滚动、上下文条长出（增长明显时最多 10 秒一次流光）；任务清单新计划逐行写入、开始的那项高亮一下并有扫光文字、完成的那项勾选弹出、计数跳动，全部完成时从计数处撒一小把彩纸；团队图第一次看到时自上而下逐个搭起来，新加入的 agent 先长出箭头再落下，正在工作的 agent 方框边上有一点光绕行、箭头上有它层级颜色的光点往下流，刚完成的发一圈光、状态 ✓ 弹出，刚卡住的抖一下，整个团队完成时“回到主会话”落下并撒彩纸；图例悬停某层/某来源时其余变淡；新活动记录从顶部滑入；状态药丸运行/卡住时有涟漪；进入 agent 详情向左滑、返回向右滑（View Transitions；面板不出帧时 250 ms 内直接切换）；连接点在数据有新内容时闪一下。
- **预览**：预览窗格隐藏时浏览器不出帧（rAF 不跑、CSS 动画在下一帧才开始），截图只能看到不准确的时间点；`?frames=timer` 用定时器驱动补间，便于截图。`test/sim-team.mjs` 末尾加了收尾阶段（`SIM_FINISH_AT`，默认 150 秒）以便看到团队完成的那一刻；`.claude/launch.json` 的 `better-view-team-sim-fast` 在 42 秒收尾。

## 0.14 移除悬浮版（2026-11-17）

面板已在 Antigravity 里（插件 sidecar / MCP App）可用，Mac 上的悬浮版整体删除：`mac/`（Better View.app：浮动侧窗、菜单栏图标、⌥⌘B、带自身图标的通知）、`scripts/install-mac.sh` 和两个 launchd 常驻项（`com.betterview.server` / `com.betterview.app`，已在本机卸载）。服务里只为它存在的部分一并去掉：`/api/test-notify`、`/api/state` 里的 `notices` 与 `X-BetterView-App` 握手。卡死 / 完成通知仍由插件（Antigravity 运行时）通过 osascript 发出，图标为系统默认；单独运行 `npm start` 的服务仍可作为 primary（`BETTER_VIEW_NOTIFY=auto` 时插件让位，避免重复通知）。0.3 与 0.12 中关于悬浮窗、菜单栏、应用通知的内容保留为历史记录。（通知去重已改为租约，见 0.15。）

## 0.15 审查后的修正与体验改进（2026-11-18）

对照两份外部审查报告逐条核实后修的问题（报告本身未入库）：

- **连错 hub**：本机可同时有两个 hub 在跑（Antigravity 2.32 自己的，和 Gemini 的 `agy --hub` 2.29），`daemon/` 下各有一个发现文件。MCP 进程拿不到 `ANTIGRAVITY_LS_ADDRESS`，原先按文件名取第一个活着的，实测 Antigravity 里的 MCP 面板连到了 Gemini 的 hub（`lsof` 可见）。现在优先选 pid 等于本进程父进程的那个（插件的 MCP 和 sidecar 都是自己 hub 的子进程，`run.sh` 用 `exec`），其次取修改时间最新的。
- **额度**：2.32 的 `RetrieveUserQuotaSummary` 把 `groups` 包在 `response` 里，且每个模型家族一组（“Gemini Models”“Claude and GPT models”，窗口名相同）。原先只读顶层 `groups`，落到兜底搜索：组名丢失、两组同名窗口被当成重复去掉、用尽的桶（proto3 省略 `remainingFraction`）整个消失。现在任何层级的 `buckets` 列表都读，持有者的 `displayName` 即组名，去重键带 `bucketId`。`quotaFamilies()` 再按家族归并：每个家族一个圆环，显示最紧的那个窗口（剩余最少；并列取更短的窗口），悬停卡片照 Antigravity 用量面板的版式：标题，每个窗口一行（“每周额度 … 剩 92%”，按服务端顺序），下面一行小字“6d 17h后重置”；家族里模型自有的池（如 Gemini 4 Argon）另起小标题；仍是 100% 的窗口不写重置时间。`GetUserStatus` 的“Claude · GPT”按模型池并入同一家族，不再单独一环。
- **通知**：插件 sidecar 的 `disabled: true` 实际被 2.32 忽略（它照常运行并发通知），而 MCP 服务器原来不发通知（`BETTER_VIEW_NOTIFY=0`），所以只有 MCP 的宿主（如 Gemini）里没有通知，且通知依赖宿主忽略 `disabled`。现在所有 Better View 进程都挂 `attachNotifier()`，由租约文件 `~/.cache/better-view/notifier-<数据目录哈希>.json`（`{pid, at}`）决定谁发：上次发通知的进程只要还活着且 30 秒内发过就继续由它发，否则谁先看到新情况谁接手。测试用临时数据目录，租约文件不同，不会抢真实面板的。MCP 的日志文件只记告警级别，不记会话标题。
- **`state` 工具**：MCP Apps 规范里 `visibility: ['app']` 应对模型隐藏，宿主未必遵守；描述里写明仅供面板内部使用、不要从对话里调用（它返回本机全部会话，约 300 KB）。`set_language` 同理。
- **小问题**：并行调用里只要有 `ask_question` 就算“等你操作”（原先只看第一个）；清单文件只认 agent 自己的（`.agents/` 下的、或 `brain/<id>/` 里的工件），帮你改项目里的 `TODO.md`/`plan.md` 不再顶替清单，记下的文件没了或没有勾选项时回退到 `task.md`；`parseAnnotation` 允许 `title: "…"`（冒号后有空格）；`decodePbString` 按码点处理、`\x` 后不是十六进制不再抛错；读 transcript / hub 日志用 `StringDecoder`，一次读取停在多字节字符中间不再变成乱码；transcript 被截断重读时重建该会话的 run（原先计数翻倍）；SQLite 读取失败或清单文件读失败时不缓存这次的时间戳（原先可能一直停在旧值）；`conversations/` 也跟随 `BETTER_VIEW_AG_DIR`；连接 hub 被拒绝（ECONNREFUSED）时，原本忙碌的会话判为服务已退出；重试时间无法解析或已过去时不显示“0 秒后重试”；切回“跟随 Antigravity”时立即刷新提示状态；`engines.node` 改为 `>=22`（`node:sqlite`），`run.sh` 校验主版本 ≥22，nvm 里取最新版本而不是按名字排第一个的。

界面：

- **不打断阅读**：数据除了时间戳没变就不重绘（时钟本来就单独走）；面板里有选中的文字时暂不重绘，选区消失（或 30 秒后）再画最新的，可以选中复制命令和报错；任务下拉框只在选项变化时重建，且获得焦点时不动，失焦后补上。悬停提示所属的元素被重建时（agent 工作时每次更新都会），由指针下重建出的同一元素接管、内容随之刷新，不会闪退；指针下已没有（或提示由键盘聚焦打开）才隐藏，底部放不下时向上弹出，键盘聚焦也会显示。
- **告警直达**：团队页上的告警卡片可点击（或回车），直接进入那个 agent 的详情；正在选中文字时点击不算。
- **中文**：团队图里的角色词（survey/review/orchestrate…）中文界面下显示为调研/审查/编排…；额度窗口显示“5 小时”“每周”。
- **同模型不重复**：团队里多数 agent 用的模型在图例行末写一次，方框里只标出用了不同模型的（加粗）。
- **连续读文件折叠**：同一 agent 连续成功读取的文件合成一行“读取 · 6 个文件：a、b、c 等”，点击展开；出错、编辑、命令、派出子 agent 永远单独一行。活动记录与清单项的动画键改用步骤自身的 id / 同名项的序号，并行同名工具和同名子项不再每次更新都重播动画。
- **清单规则**（`rules/AGENTS.md`）：清单更新必须和下一步的实际工作放在同一批并行工具调用里，不许单独花一轮只改清单；清单只放在工件目录。
- **`/compact` 不是中断**（实机发现）：你发送 `/compact` 后，transcript 是 USER_INPUT `/compact` →（可能夹一条服务重启通知）→ CHECKPOINT，随后 hub 空闲、终止原因 `TERMINAL_CUSTOM_HOOK`，agent 等你下一条消息。原先只有“最终回复”才算一轮结束，于是 15 秒后判成 HALTED 并发了通知。现在本轮请求是 `/compact` 时，压缩检查点即结束本轮（“上下文已压缩，等待新指令”）；轮中自动压缩仍算继续（之后 25–45 秒会接着出下一次模型调用）。兜底：最后一行是压缩检查点且终止原因是 `TERMINAL_CUSTOM_HOOK` 时，不判为中断。

## 1. 关键事实（决定架构的前提）

| # | 事实 | 状态 | 意义 |
|---|------|------|------|
| F1 | Antigravity 桌面端是原生 macOS 应用（Gemini.app 内嵌 `agy`），**不是 VS Code 分支**，没有 VS Code 扩展 API | 已核实 | 不能写 VS Code TreeView 扩展 |
| F2 | 插件规范为 agent-plugins.org `plugin.json`，Antigravity 专属能力挂在 `extensions."com.google.antigravity"` 下 | 已核实（gdrive 插件） | 插件入口 |
| F3 | 插件可声明 **sidecar**：宿主托管的常驻进程，`has_web_ui: true` 时宿主注入 `ANTIGRAVITY_SIDECAR_WEB_PORT` / `ANTIGRAVITY_SIDECAR_UI_TOKEN`；`ui_config.views[].entrypoint` 可选 `SIDECAR_UI_ENTRYPOINT_SIDEBAR`（作为侧边栏 Plugins 下的一个 tab）/ `AUX_PANE` / `FULL_PANE`；另有 `restart_policy`、`env`、`path`、`title`、`display_name` | 已核实（agy 二进制 schema 字符串） | **侧边栏 UI 的正式通道** |
| F4 | sidecar 环境可能还会拿到 `ANTIGRAVITY_LS_ADDRESS`、`ANTIGRAVITY_CSRF_TOKEN`、`ANTIGRAVITY_CONVERSATION_ID` | ⚠️ 变量名存在于二进制，是否注入给 sidecar 待验证 | 可合法访问语言服务器 API |
| F5 | 每个会话的步骤流写在 `~/.gemini/antigravity/brain/<convId>/.system_generated/logs/transcript.jsonl`，**只追加 JSONL** | 已核实 | 主数据源，可 tail |
| F6 | transcript 行结构：`step_index, type(USER_INPUT/PLANNER_RESPONSE/GENERIC/SYSTEM_MESSAGE), status(DONE/RUNNING/ERROR/INVALID), source, created_at, content, tool_calls[{name,args}], thinking, input/output/cache_read_tokens` | 已核实 | 足够构建进度时间线 |
| F7 | 后台任务 ID 形如 `<convId>/task-N`，输出在 `.system_generated/tasks/task-N.log`，结束时写 `.system_generated/messages/<uuid>.json`（含 sender/recipient/messageTitle/timestamp） | 已核实 | 后台任务节点 + 活性信号 |
| F8 | 服务重启时会写 SYSTEM_MESSAGE："All your subagents and background tasks have been stopped due to server restart" | 已核实 | 强卡死信号 |
| F9 | 语言服务器有 `GetAgentTeamMetadata`、`StreamAgentStateUpdates`、`GetAllCascadeTrajectories`、`GetCascadeTrajectorySteps`、`ListBackgroundTasks`、`SubscribeToSidecars` 等 Connect RPC；hub 端口与 csrfToken 在 `~/.gemini/antigravity/daemon/hub_<port>.json` | 方法名已核实；**调用未验证** | 实时流 + Teamwork 拓扑的最佳来源 |
| F10 | 插件支持 hooks，事件含 `PreToolUse / PostToolUse / Stop / SessionStart / Notification` | 事件名已核实，⚠️ 配置格式待 `agy plugin validate` 验证 | 实时"开始执行工具"信号 |
| F11 | Teamwork 是真实功能（有"Teamwork 任务正在准备中…"提示），但本机历史里**没有一次完整 Teamwork 运行的数据** | 已核实 | 树的数据结构须在 M0 采样 |

> 观察：本机历史 transcript 中相邻步骤最大间隔有 1288s、41146s 等——有的是真卡，有的是用户离开。
> 因此"卡死判断"必须区分 **agent 在等什么**，不能只看沉默时长。

---

## 2. 总体架构

```
┌──────────────────────── Antigravity (Gemini.app) ────────────────────────┐
│  侧边栏 Plugins ▸ Better View tab  ◀── WebView 加载 http://127.0.0.1:$PORT/sidebar
│                                                                           │
│  agy hub / language server ──(Connect RPC, 可选)──┐                       │
│  hooks (Pre/PostToolUse, Stop, Notification) ─────┤                       │
└───────────────────────────────────────────────────┼───────────────────────┘
                                                    ▼
┌──────────────────── better-view sidecar（插件托管的常驻进程）──────────────┐
│  Sources（采集层，互为冗余）                                              │
│   ├─ TranscriptTailer   tail brain/*/logs/transcript.jsonl（按字节偏移）   │
│   ├─ TaskWatcher        tasks/task-N.log 的 mtime/size + messages/*.json  │
│   ├─ HookInbox          POST /hook ← hooks 脚本推送的实时事件              │
│   ├─ LsClient (可选)    StreamAgentStateUpdates / GetAgentTeamMetadata     │
│   └─ HubProbe           daemon/hub_*.json 的 pid 存活 + 端口可达          │
│                 │  原始事件                                               │
│                 ▼                                                         │
│  Normalizer → 统一事件模型 (AgentEvent)                                   │
│                 ▼                                                         │
│  StateStore (reducer)：Run → Agent 树 → Step / BgTask                     │
│                 ▼                                                         │
│  StallDetector（每 5s tick）：按状态计算沉默时长 → OK / SLOW / STALLED / DEAD │
│                 ▼                                                         │
│  HTTP Server：/sidebar 静态 UI · /api/snapshot · /api/events (SSE)        │
└───────────────────────────────────────────────────────────────────────────┘
```

设计原则：
1. **文件优先，API 增强。** 文件源已核实、稳定、离线可用，作为保底；LS API 与 hooks 只用于提速（实时）和补全拓扑（Teamwork）。任何一层挂掉，视图降级而不是空白。
2. **默认只读。** 插件只观察；"催一下 / 终止任务"等操作走显式按钮 + 二次确认。
3. **适配层隔离格式。** transcript/proto 是内部格式，会随版本变；所有解析集中在 `sources/*`，按 `lsVersion` 选择解析器，未知字段宽容处理。
4. **隐私。** transcript 里有命令输出和密钥；sidecar 只监听 127.0.0.1，校验 `ANTIGRAVITY_SIDECAR_UI_TOKEN`，不发出任何外部请求。

---

## 3. 统一数据模型

```ts
type AgentState =
  | 'THINKING'       // 最后一条是 USER_INPUT / 工具结果，等模型输出
  | 'TOOL_RUNNING'   // PLANNER_RESPONSE 发出 tool_calls，等对应 GENERIC 结果
  | 'BG_TASK'        // 有 RUNNING 的后台任务（task-N）在跑
  | 'WAITING_USER'   // ask_question / 权限请求 / Notification hook
  | 'IDLE' | 'DONE' | 'ERROR' | 'ORPHANED';   // ORPHANED: 服务重启后残留的 RUNNING

interface Run {            // 一次会话（conversation）
  id: string; title: string;        // title 来自 annotations/<id>.pbtxt
  rootAgentId: string; startedAt: number; lastActivityAt: number;
  teamwork: boolean;
}
interface AgentNode {      // 主 agent / subagent / Teamwork worker
  id: string; parentId?: string; role: 'main'|'subagent'|'worker'|'bg_task';
  label: string; state: AgentState; health: 'OK'|'SLOW'|'STALLED'|'DEAD';
  currentStep?: StepSummary;          // "run_command: npm test" 之类的一行摘要
  progress?: { done: number; total?: number };  // 有 task 列表/计划时才有 total
  lastSignalAt: number;               // 任何活性信号的最新时间
  tokens: { in: number; out: number };
}
interface StepSummary { index: number; kind: string; tool?: string; brief: string;
                        status: 'RUNNING'|'DONE'|'ERROR'; startedAt: number; endedAt?: number }
```

**活性信号（lastSignalAt 的来源）**：transcript 新行、task log 文件增长、hook 事件、LS 流事件、message 文件出现。
关键点：后台命令输出在增长 ≠ 卡死，即使 transcript 很久没动。

---

## 4. 卡死检测（核心价值）

### 4.1 判定矩阵

| 当前状态 | 看什么 | SLOW（黄） | STALLED（红） |
|---|---|---|---|
| THINKING | 距上次信号 | > P90 思考时长（默认 90s） | > max(P99, 5min) |
| TOOL_RUNNING（前台） | 距工具开始 & 输出是否增长 | 无输出增长 > 2min | 无输出增长 > 8min |
| BG_TASK | task log size/mtime | 不增长 > 5min | 不增长 > 15min 且无 finish message |
| WAITING_USER | — | 不算卡死，单独高亮"等你操作" | — |
| 任意 | hub pid 不存活 / 端口不可达 | — | **DEAD** |
| 任意 | 出现 "stopped due to server restart" 后仍有 RUNNING 行 | — | **ORPHANED** |
| 任意 | step status = ERROR 且之后无新步骤 > 1min | — | STALLED（报错停住） |

### 4.2 自动校准
首次启动时扫描本机全部历史 transcript，按"状态 → 下一信号"计算间隔分布（P50/P90/P99），作为各状态阈值的基线，写入 sidecar 本地缓存；用户可在 UI 设置里覆盖。这样阈值贴合用户自己的模型与任务类型，而不是拍脑袋。

### 4.3 呈现方式
不武断说"卡死了"，而是给 **证据 + 建议**：
> 🔴 疑似卡住 · 已 9 分 12 秒无任何输出
> 最后动作：`run_command` ssh … （前台，输出 6 分钟未增长）
> 建议：[打开会话] [发送"继续"] [终止该任务]

- [打开会话]：deep link / `agy --conversation <id>` ⚠️
- [发送"继续"]：`agy agentapi send-message <recipient_id> <content>`（已核实存在该命令），需二次确认
- [终止该任务]：⚠️ 待找到对应 RPC 或 CLI；M4 再做
- 状态跨入 STALLED/DEAD 时发系统通知（可关）

---

## 5. 视图设计

侧边栏很窄（约 300–400px），**不做节点连线图**，用"缩进树 + 每行迷你进度条"，信息密度高且不需要横向滚动。

### 5.1 单线模式（默认）

```
┌ Better View ───────────────────── ⚙ ┐
│ ● 配置 sing-box 节点        12m 03s │  ← 会话标题 + 总耗时
│ ▓▓▓▓▓▓▓▓▓▓▓░░░░  步骤 41 · 18k tok │
├─────────────────────────────────────┤
│ 🟢 正在执行  run_command            │
│    ssh vps … systemctl restart …    │
│    已运行 0:42 · 输出持续增长 ▁▃▅▇  │  ← 活性心电图
├─────────────────────────────────────┤
│ ✓ 读取配置文件            0:02      │
│ ✓ 编辑 config.json        0:01      │
│ ✓ 思考                    0:18      │
│ ⟳ 后台任务 task-103       3:10  ▁▂▃ │
│ … 展开更早的 37 步                   │
└─────────────────────────────────────┘
```

- 顶部"当前动作卡片"是重点：一眼看出在干嘛、干了多久、还有没有动静。
- 时间线按"阶段"折叠（连续的读文件合并为一行"读取 6 个文件"），避免变成又一个命令行。
- 多个会话同时在跑时，顶部出现会话切换条（按最近活动排序）。

### 5.2 Teamwork 树状多线模式

```
┌ Better View · Teamwork ─────────── ⚙ ┐
│ ▾ 🟢 Lead  规划/汇总        步骤 22   │
│   ├ 🟢 worker-1 前端组件     ▓▓▓▓░ 4/5│
│   ├ 🟡 worker-2 API 层       ▓▓░░░ 2/5│  ← SLOW：思考 2m40s
│   │    └ ⟳ bg task-17 npm test   1:12 │
│   ├ 🔴 worker-3 数据迁移     ▓░░░░ 1/4│  ← STALLED：9m 无输出
│   │    ⚠ 9m12s 无输出 · [详情][催一下] │
│   └ ✓  worker-4 文档         ▓▓▓▓▓ 完成│
├───────────────────────────────────────┤
│ 泳道视图 ▸  (可切换: 横向时间轴，每 agent 一条线) │
└───────────────────────────────────────┘
```

- 每个节点一行：健康灯 · 名称 · 当前任务一句话 · 进度。
- 父节点颜色 = 子树最差健康度，折叠时也能看到红点。
- 可切换"泳道视图"：每个 agent 一条横向时间线，适合复盘并行度和瓶颈（放到 AUX_PANE 宽屏显示）。
- 拓扑来源优先级：`GetAgentTeamMetadata`（⚠️）→ 子会话的 parent 关联（⚠️ 待采样）→ message 的 sender/recipient 关系（已核实，至少能挂出 bg task 层级）。

---

## 6. 项目骨架

```
better-view/
├─ plugin.json                    # 插件清单：sidecar + hooks 声明
├─ hooks/
│  ├─ hooks.json                  # ⚠️ 格式以 agy plugin validate 为准
│  └─ emit                        # 把 hook 事件 POST 到 sidecar 的 /hook（超时 200ms，失败静默）
├─ sidecar/
│  ├─ src/
│  │  ├─ main.ts                  # 读 env、启动 sources、HTTP server
│  │  ├─ config.ts                # 路径、阈值、版本探测(lsVersion)
│  │  ├─ sources/
│  │  │  ├─ transcriptTailer.ts   # fs.watch + 字节偏移续读，处理半行
│  │  │  ├─ taskWatcher.ts        # task-N.log 增长 + messages/*.json
│  │  │  ├─ hookInbox.ts
│  │  │  ├─ lsClient.ts           # Connect-JSON 客户端（可选层）
│  │  │  ├─ hubProbe.ts           # pid 存活/端口探测
│  │  │  └─ annotations.ts        # 会话标题
│  │  ├─ model/{types.ts, reducer.ts}
│  │  ├─ detect/{stall.ts, calibrate.ts}
│  │  └─ server/{http.ts, sse.ts, auth.ts}
│  └─ test/fixtures/              # 脱敏后的 transcript 样本（含卡死/重启/teamwork 场景）
├─ ui/
│  ├─ index.html
│  └─ src/{app.ts, store.ts, views/{RunHeader, CurrentAction, Timeline, TeamTree, Swimlane, Settings}.ts}
├─ scripts/build.sh               # 编译单文件二进制 + 打包 UI
└─ DESIGN.md
```

实际清单（M0 已通过 `agy plugin validate --strict`）：`plugin.json` 只放元数据，sidecar 由目录约定发现：

```jsonc
// sidecars/panel/sidecar.json
{
  "command": "/bin/sh", "args": ["run.sh"],          // run.sh 在常见位置查找 node
  "restart_policy": "on-failure",
  "display_name": "Better View",
  "description": "Shows what each agent is doing, how far it has got, and whether it looks stuck. Read-only.",
  "has_web_ui": true,
  "ui_config": { "display_name": "Better View", "views": [
    { "entrypoint": "SIDECAR_UI_ENTRYPOINT_SIDEBAR",  "path": "/sidebar", "title": "Progress" },
    { "entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE", "path": "/aux",     "title": "Progress" } ] }
}
```

> 选型修正：官方 sidecar 框架就是 Node，且 sidecar 可直接用 `command: node`，故 M1 起改为 **TypeScript → 单个 .mjs 产物（esbuild 打包）**，不再编译 Bun 二进制；Node 不在 PATH 时由 run.sh 兜底或在 `env` 里指定。

### 技术选型

| 部分 | 选择 | 理由 |
|---|---|---|
| sidecar | TypeScript + Bun，`bun build --compile` 出单文件二进制 | 用户机器不必装 Node；与 UI 共享类型定义 |
| UI | Preact + 原生 CSS，SSE 推送 | 体积小，侧边栏 WebView 加载快；不引入大型图形库 |
| 树/泳道 | 手写缩进树；泳道用 SVG | 窄屏下缩进树比 d3 节点图更可读 |
| LS 客户端 | Connect 协议 JSON 编码（`Content-Type: application/json` + csrf header） | 免生成 proto 代码；字段宽容 |

---

## 7. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **M0 探路（1–2 天）** | ① 最小 sidecar（返回 Hello 页面）装进侧边栏，用 `agy plugin validate --strict` 确定 sidecar/hooks 的准确字段 ② 在 sidecar 内打印收到的环境变量，确认 F4 ③ 从 sidecar 调一次 `GetAllCascadeTrajectories` / `GetAgentTeamMetadata` ④ **跑一次真实 Teamwork 任务**，采样其文件和 API 数据结构 | 侧边栏出现 tab；四个 ⚠️ 全部变为已核实或已否定 |
| **M1 单线视图** ✅ | TranscriptTailer + reducer + 当前动作卡片 + 时间线 + 用量圆环 + 上下文用量 | 跑一个 10 分钟任务，延迟 < 2s 同步（实测 ≈1s） |
| **M2 卡死检测** ✅ | TaskWatcher、HubProbe、StallDetector、历史校准、系统通知 | 用回放的历史卡死样本（含 server restart）能正确标红 |
| **M3 浮动侧窗** ✅（已移除，见 0.14） | Swift 浮动面板 + 菜单栏状态 + 跟随 Antigravity 窗口 + launchd 常驻 | 宿主不支持 sidecar 时仍能像侧边栏一样使用 |
| **M4 Teamwork 视图 + 任务清单** ✅ | 拓扑构建 + TeamTree + 泳道 AUX_PANE | 4 worker 的 Teamwork 运行中，树与实际状态一致 |
| **M5 操作与发布** | 催一下 / 打开会话 / 终止；hooks 实时化；打包、README、marketplace | 一键安装可用 |

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| 内部文件/RPC 格式随版本变化 | 适配层 + `lsVersion` 探测 + 宽容解析；fixtures 回归测试；解析失败时显示"数据源不兼容"而非崩溃 |
| sidecar 机制或字段未公开、可能调整 | M0 先验证；保留后备方案：独立菜单栏小应用（SwiftUI）读同样的文件源，UI 复用 |
| 大型 transcript（本机见过 3000+ 行、78MB db） | 只 tail 新增字节；冷启动只读最后 N 行 + 汇总统计 |
| 误报"卡死"让用户误杀任务 | 分 SLOW/STALLED 两级、展示证据、操作需确认、阈值基于用户自身历史 |
| 隐私（transcript 含密钥、命令输出） | 仅 127.0.0.1 + UI token；不落第三方；UI 中命令输出默认折叠 |
