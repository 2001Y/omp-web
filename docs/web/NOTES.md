# NOTES.md — omp-web 开发记录与设计要点

## 状态

- **M0 已交付（2026-08-24）**：vendoring + `packages/web` 胶水宿主 + `--mode web` 接线，
  浏览器验收通过（原版 UI 外壳完整启动）。详见 `PROVENANCE.md` 与各 CHANGELOG。
- **M1 已交付（2026-08-24）**：核心聊天循环浏览器验收通过——
  多项目工作区侧栏（sessions 桶派生，见下）、打开历史会话（消息/思考块/工具卡/
  统计条完整渲染）、新建会话、实时 prompt→流式输出（tok/s 统计）、重连后历史回补。
  118 个存量会话全部通过客户端折叠校验。审批 UI 与跨工作区建会话留待 M2
  （多会话工厂 + `setToolUIContext` 桥接）。
- **M2 已交付（2026-08-24）**：审批 / 斜杠命令 / 模型选择浏览器验收全部通过——
  审批面板（等待审批徽标 + 允许一次/拒绝 → 工具执行 → 回合收尾）、
  命令菜单（`/` 键入与按钮触发、fuzzy 过滤、pick 执行 `/usage` 本地跑通）、
  模型选择器（模型 + 推理等级切换均生效）。

### M2 实现要点（踩坑记录）

- **审批门读的是 ExtensionRunner 的初始化期 UI 上下文**：`setToolUIContext` 只点亮
  ToolContextStore（ask 工具等），而每个工具都被 `ExtensionToolWrapper` 包裹、
  审批门查 `runner.hasUI()`——必须在 `runWebMode` 里追加
  `initializeExtensions(session, { mode: "rpc", uiContext })`（rpc 模式同款接线），
  否则审批 fail-closed（"no interactive UI available"）。
- **ask 帧信封 rpcId 必须复用 ask 的 rpcId**：客户端 `PendingWait.respond` 回填
  **信封** rpcId，服务端 `/api/respond` 按它反查注册表；`DownlinkHub.publish`
  对 `approval/requested`/`question/requested`（直播与重放）都要传 ask id。
- **宿主命令不得与客户端 contribution 同名**：ui-model-selection 注册客户端
  `/model` 弹窗，宿主命令表里的 `model` 会让 `candidates()` 抛
  "collides with a host command" → 菜单组被移除 → **零组自动关闭**（表象：菜单闪退）。
  `OmpWebDriver.listCommands` 以 `CLIENT_OWNED_COMMANDS` 过滤。
- **打开即附着**：`session.history` 对冷会话 attach（busy 时回退只读文件视图）；
  attach 经 `#attachInFlight` 串行化，让页面加载竞态里的
  `commands/list`/`session.models` 等待同一次切换后自愈。
- **命令执行链**（与 rpc 模式一致）：`tryRunRpcSkillCommand`（skill:xxx）
  → `executeAcpBuiltinSlashCommand`（文本内建，本地执行；`{prompt}` 残差再发）
  → `session.prompt(line)` 兜底（扩展命令/模板）。注意 OMP 的
  `session.prompt("/xxx")` **不解析斜杠命令**（TUI 在 REPL 层拦截）。
- **CommandExecution 线上形状**：`{commandId, result}`（commandId 是
  run/done 生命周期事件的配对 id）；只回 `{result}` 会被客户端 zod 拒绝
  （"rejected result"）。
- **IAB（Playwright press）的 caret 缺陷**：`press("/")` 插入字符但
  `selectionStart` 停在 0，`onChange → track(draft, caret=0)` 的触发检测从
  caret-1 起扫描直接返回 null——菜单不弹是**测试工具假象**，真实键入不受影响。
  自动化验证输入触发一律用 `type()`。
- **M3 批次 1 已交付（2026-08-25）**：命令生命周期 / 队列 / 历史分页浏览器验收通过——
  命令卡片（`/usage` 的 run/done 配对在聊天流渲染完整输出，重载会话后原位回放）、
  队列（运行中 Enter 排队 → chips + 编辑/删除/插话按钮 + "Cmd/Ctrl+Enter 插话"提示、
  followUp 自动消费开新回合）、分页（消息边界窗口，单元测试覆盖）。

### M3 批次 1 实现要点（踩坑记录）

- **运行中的 prompt 必须带 streamingBehavior**：OMP `prompt()` 在 isStreaming 时
  无该选项直接抛 `AgentBusyError`（M1 遗留：fire-and-forget 的 catch 把它吃了，
  表象是消息凭空消失）。`mode:'queue'` → `followUp`、`mode:'steer'` → `steer`。
- **OMP 队列消息没有 id**：`#queueUserMessage` 构造的 user 消息无 `id` 字段，
  线上 `session/queue` 的 MessageId 用 `WeakMap<AgentMessage, string>` 派生
  （对象身份 = 驻留期稳定；edit 替换对象时继承原 id）。第一版按 `message.id`
  读全部 undefined → 快照恒空 → 队列永远不显示。
- **队列变化无事件**：入队/消费不产生 AgentSessionEvent；`#syncQueue` 以
  id:placement 签名做幂等快照对比，挂在 prompt 应答后与每个 agent 事件尾部。
- **命令事件持久化**：`sessionManager.appendCustomEntry("omp-web/command", …)`
  （不进 LLM 上下文）；attach 改用 `adoptEntries(getEntries())` 按原始条目顺序
  交错回放（`translateItems`），冷读同源。命令输出剥离 ANSI（TUI 色码不能进网页）。
- **分页切窗**：从尾部数 `maxMessages` 条消息事件，切点前移到最近的
  turn/start 或 command/run 边界（不产生半开回合）；`hasMore = 切点 > 0`。
- **M3 批次 2 已交付（2026-08-25）**：设置对话框文档面（`settings.describe` 只读事实 +
  `settings.openDocument` 物化并用系统编辑器打开 OMP settings.yml，客户端原生
  SettingsDocumentStore 按钮承载）、`subagent.list`（AgentRegistry live 直接子代理 →
  continuable 行，会话头子代理计数实数化）、`commands/change` 广播
  （`subscribeCommandMetadataChanged` → mux `commands/change` 信号 → 客户端命令目录失效重拉）。
  浏览器验收：设置对话框四 section + 打开配置文件按钮正常渲染。

### M3 批次 2 实现要点（踩坑记录）

- **dsh 客户端没有通用 schema 设置表单**：设置页是 slot 注册制
  （`settings.section`：general/models/plugins/agent-preset 各自的专用组件，
  加 locale/permission/conversation 的行注入）。`settings.describe` 的 namespaces
  只是这些 section 的数据源——OMP 的 400+ 设置项**没有现成组件可承载**。
  全量可视化的路径只有：(a) 逐 section 语义映射（approvalMode→permission 行、
  模型设置→models section 词汇），(b) openDocument 文档编辑（已交付）。
  schemastery `schema.toJSON()` 信封形状已调研（`{uid, refs}` 树，构造函数
  `new Schema(envelope)` 按 refs 递归反水化），批次 3 做 section 映射时手写
  信封构造器即可（~20 行），无需引入 vendored schemastery 依赖。
- `subagent.list` 的 `mode: 'continuable'` 需要 label（displayName）；
  parked 子代理（session === null）暂不列（M4 persisted bridge）。
- `agentPreset.list` 返回 internal error 是预期（M4），设置对话框以 alert 呈现
  且不破坏其余 section。
- **M4 审计批次已交付（2026-08-25）**：计划模式（`/plan` 命令驱动 enter/exit 核心
  ——会话状态、write 增广工具集、模式上下文；翻转镜像为 `plan/mode` 事件 + `plan`
  projection；重载经 `mode_change` 条目折叠恢复，plan chip 与 placeholder 跟随）、
  ask 问答闭环（`hasUI` 纳入 web 使 ask 工具进清单；UI 上下文对话框方法改箭头类字段
  修复 ask 工具解构调用丢 `this` 的崩溃；面板渲染-选择-提交-模型续答全链路验收）、
  浏览器客户端设置持久化（`settings.mutate`/`update` → `~/.omp/web-client-settings.json`，
  内测声明确认可关）、`agentPreset.list` 空 stub。

### M4 审计批次实现要点（踩坑记录）

- **plan 模式**：OMP 的 `/plan` 是 TUI-only（builtin 只有 handleTui），web 需在
  listCommands 手动补条目；完整状态机在 InteractiveMode，web 复刻其核心四步
  （setPlanModeState + 工具集加 write + sendPlanModeContext + appendModeChange）。
  plan review 审批流走 `xd://propose`（write 审批 → 已有的 approval 面板）。
- **projection 的 subscribed truncate**：mux 重连基线 `session/subscribed` 会
  truncate 掉 seq > lastSeq 的 projection——重载后 plan 状态必须由 history 的
  projections block 重新 seed（`mode_change` 条目折叠进 log 的 plan/mode 事件 +
  history result 的 plan 字段）。
- **attach 不恢复 agent 侧模式**：`switchSession` 只恢复持久化工具集，不恢复
  planModeState——history 的 plan 判据必须读折叠 log（最后一条 plan/mode），
  不能读 `getPlanModeState()`。旧会话若持久化过 plan 工具集，ask 等工具不在其中
  （工具集是历史事实）。
- **ask 工具两个前置**：`sessionOptions.hasUI`（createSession 快照决定工具清单，
  main.ts 一行接线）+ ToolContextStore 的 `ctx.ui`（M2 已接）。工具内部把
  `ctx.askDialog` 解构为裸函数调用——UI 上下文的对话框方法必须是箭头类字段，
  否则 `this.asker` 崩溃（表象：模型报"工具基础设施崩溃"）。
- **客户端设置存储**：`settings.mutate`（settingsScope.set 的底层）承载内测声明
  确认等 loopback 客户端状态；独立 JSON 文件（`~/.omp/web-client-settings.json`）
  而非借道 OMP settings（避免 schema 外 key 语义）。ns 以宽松空 object schema
  上报（客户端写前不校验、宿主端自由写）。
- **A1 缺口-例外上报（A3 程序）**：dsh 客户端侧栏**没有会话删除交互**
  （archiveSession RPC 存在但无 UI 触发）——「会话删除」需要例外批准或后续
  dsh 组件更新后再接。
- **M5 批次 1 已交付（2026-08-25）**：会话标题（`session.list` 每行带
  `projections:{asOfSeq:0, values:{title}}`——侧栏显示 OMP 会话标题/首条消息，
  空会话回退 cwd 名）与 `@` 文件引用（`fileReferences/list` → cwd readdir 前缀
  匹配，隐藏文件/.git/node_modules 排除，文件/文件夹分类图标，目录选中后加 `/`
  续补全；提交序列化为纯路径文本——ui-reference codec `serialize: ref => ref`，
  OMP 端天然可读）。浏览器验收：标题列表 ✓、@ 菜单 13 候选 ✓、插入
  `@README.md ` ✓。

### M5 剩余计划（用户 2026-08-25 指示，按批次）

- **M5 批次 2 已交付（2026-08-25）**：**OMP 设置十 tab 全量**——自定义客户端插件
  `dsh-web/packages/client/omp-settings/`（dsh.client 声明 + 共享 tsdown preset
  构建 + BOOT_ROSTER 追加）把十个 OMP tab 注册为设置页 section；服务端
  `ompSettings/describe`（SETTINGS_SCHEMA → tabs/groups/fields 目录）与
  `ompSettings/update`（settings.set 持久化）承载读写。表单组件数据驱动
  （Menu=enum/boolean/options、Input=string/number/array、secret=password）。
  浏览器验收：十 section 导航 ✓、交互 tab 全字段渲染 ✓、枚举切换持久化
  （steeringMode one-at-a-time→all→回滚）✓。**模型 tab 的 /model 核心功能**：
  Default Model 选择器（531 可用模型动态 options，当前值 modelRoles.default，
  写路由 `session.setModel(target,"default",{persist:true})`）——切换
  flash→v4-pro 持久化验证 ✓ 并已恢复。
- **M5 批次 2 补充（2026-08-25，用户指示调整）**：①插件改为**完全目录驱动**
  （客户端零硬编码——tab 列表/标签/顺序全部来自 `ompSettings/describe`，服务端
  按 SETTING_TABS 排序输出）；②section 标签保持 OMP 原文（英文）不自译；③
  设置对话框 section 导航滚动修复（插件注入 `[role="dialog"] nav` 的
  overflow-y:auto 全局样式——原组件按少量 section 设计，omp 新增 10 个后溢出）。
- **设置页 roster 裁剪（2026-08-25，用户指示）**：移除五个 dsh 原生、omp 无对应
  的设置插件（models/plugin-inventory/plugins/agent-preset/permission-presets），
  保留通用设置外壳（用户确认）——设置页现为「通用设置 + omp 十 tab」，
  dsh 的 DeepSeek 模型配置/插件管理/Agent 预设/权限行全部消失，新会话 hero 的
  内测声明 onboarding 也随 ui-settings-models 一并移除。浏览器验收 ✓。
- **M5 批次 3 已交付（2026-08-25）**：
  ①**`/model` 模型角色配置界面**——Model tab 顶部 "Model Roles" 组：
  `getKnownRoleIds`（10 内建 default/smol/slow/vision/plan/designer/commit/
  tiny/task/advisor + 自定义）逐角色模型选择器（531 选项 + "(unset)" 继承项），
  写路由 `session.setModel(target, role, {persist:true})`；unset →
  `settings.setModelRole(role, undefined)`。浏览器验收：分配 plan 角色 →
  持久化 ✓ → 恢复 unset ✓。
  ②**供应商凭据管理**——Providers tab 顶部 "Credentials" 组：按
  `authStorage.getAll()` 每个持凭据的 provider 一行（状态 + Logout 动作），
  Logout → `authStorage.remove(provider)`（与 TUI /logout 同路径）。浏览器
  验收渲染 ✓（未实际点击以免清凭据）。
  ③**斜杠命令覆盖盘点**（矩阵）：内建命令约 38 个有文本 handle（web 经
  `executeAcpBuiltinSlashCommand` 直接可用，含 compact/usage/export 等）；
  **TUI-only 约 67 个**需分类处置——
  - **web 已有等价**：settings（设置对话框）、model（模型菜单+Model tab）、
    plan（plan 桥）、providers/logout（Credentials 组）、help（命令菜单）
  - **需桥接**（状态机类）：vibe、goal、guided-goal、plan-review、queue
  - **会话类**：branch/fork/switch/reload（部分有 RPC：session.fork）
  - **终端类**（无 web 对应）：git、theme、hotkeys、notifications、prompts
  - 其余多为子命令入口（mcp/extensions/marketplace 的 add/list/remove 等文本
    handle 已覆盖核心，子命令提示待验证）
- **M5 批次 3 补充（2026-08-25，用户指示分拆）**：Model Roles 与 Connect 从
  Model/Providers tab 的设置组**拆为独立选项卡**并配**专用组件**（用户指出
  原实现太粗糙、不像 TUI）：catalog 顶层新增 `models`/`modelRoles`/
  `connections` 块（tab 内注入组移除）；`ModelRolesSection`（每角色一行：
  tag Pill + 名称 + 继承说明 + 模型 Menu，531 选项 + unset）与
  `ConnectSection`（每 provider 一行：凭据数 + Connected/Logout 菜单，
  登出后目录强刷）——均用 dsh primitives（Pill/Menu）与既有行样式。
  导航位次：Model Roles 紧跟 Model、Connect 紧跟 Providers。浏览器验收：
  两组件渲染 ✓、角色分配持久化（plan→flash→恢复 unset）✓。
- **M5c UI 重设计（2026-08-25，用户指出信息缺漏后）**：
  **Model Roles v2**——角色行（Pill 徽章 + 当前模型·thinking 摘要 + thinking
  独立菜单 default/minimal..max + Browse 展开）；展开的**模型浏览器**：
  搜索框（dsh Input search）+ provider 分组 + 模型行元数据列（TUI 同款
  `1M ctx · 384k out · $0.14/0.28` + reasoning/vision 徽章，来自
  contextWindow/maxTokens/cost 元数据）；写入支持
  `provider/id[:thinking]` 后缀（服务端解析并 setModel(thinkingLevel)）。
  **Connect v2**——全量 provider 视图：Connected 组（authStorage 持凭据，
  OAuth 真实名称如 Kimi Code/OpenRouter）+ Available 组（getOAuthProviders
  全列表约 20 个：ChatGPT Plus/Pro、Anthropic、Z.AI、GitHub Copilot、
  Cursor、Devin、Antigravity、Google Cloud、xAI、GitLab 等，Not connected
  状态 + 终端 /login 引导）。浏览器验收：搜索过滤 ✓、分配保留 thinking ✓、
  分组元数据 ✓、双组渲染 ✓。
- **M6 设置易用性（2026-08-25，用户指示）**：表单 v3——①**每字段恢复默认**
  （值≠schema default 时显示 ↺ 按钮，写回 default；default undefined →
  `settings.set(key, undefined)` = 落盘省略 + resolve 回退默认）；②**已修改
  标记**（字段级 modified Pill + 组标题 `· N modified` 计数）；③**字段搜索**
  （tab >8 字段时显示工具栏，label/description/key 三向过滤）；④**分组折叠**
  （dsh DisclosureRow，默认展开，图标显示字段数）；⑤**tab 级 Reset all**
  （`Reset N to defaults`，批量写回默认）。写入后 catalog 强制重拉以保持
  标记诚实。浏览器验收：搜索/标记/单字段恢复（20→10 往返）/Reset all
  计数 ✓。
- **M7 批次（2026-08-25）**：**`session.fork` RPC**——消息菜单的「在新对话中
  分支」按钮从 internal error 变为可用：文件级 fork（`modes/web/fork.ts`，
  读源 JSONL → translator 折叠定位 atSeq 锚定的 turn/end 边界 → 按边界时间
  截断条目 → 新 header（继承 cwd/title，parentSession=源路径）写子文件于源
  同目录；attached 源先 flush；不打扰当前会话）。浏览器验收：按钮点击 →
  侧栏新会话（28→29）→ 子会话自动选中打开 ✓；curl 直测边界/文件内容 ✓。
- **M7 批次 2（批次 5 首批，2026-08-25）**：**vibe/goal 状态机桥**（plan 同
  模式，executeCommand 注册 `vibe`/`goal` 命令——TUI-only 故手动补入
  listCommands）：
  - `/vibe` toggle：enter（activateVibeTools(read+todo) + setVibeModeState +
    sendVibeModeContext + mode_change "vibe"）/exit（runModeExitTeardown 内
    abort + deactivateVibeTools(还原集) + setVibeModeState(undefined) +
    mode_change "none"）；plan/goal 互斥提示。
  - `/goal set/show/pause/resume/drop`：GoalModeState 全生命周期
    （setGoalModeState + mode_change goal/goal_paused/none +
    sendGoalModeContext）。
  - curl 验收：goal set→show（active）→drop、vibe on→off 全通；命令菜单
    注册 ✓。
- **M8 历史标签页（2026-08-25，用户指示）**：会话视图第三 tab「历史 History」
  （轨迹后，order 20）——TUI /tree 对等：消息条目树（You/AI/Tool 角色行 +
  摘要 + 父链缩进 + branch 兄弟数 Pill + 当前路径高亮），每节点 Rewind
  （`ompHistory/navigate` → `session.navigateTree(entryId)`，成功后 canonical
  log 重新 adopt）。数据：`ompHistory/tree`（getEntries → 消息节点 + 活跃叶
  链 onCurrentPath 标记 + 分支点 siblings 计数）。
  **踩坑**：session-scoped slot 的注册必须在 apply 顶层同步——异步回调里
  注册的条目挂载时 scope key 传空（inject 拿到 ""，表象 "no persisted
  session"）。
  浏览器验收：树渲染（12 节点含 ask 崩溃历史）✓、Rewind 点击后树刷新 ✓。
- **M9 历史页双栏重构（2026-08-25，用户指示）**：左栏 = 文件树式选择器
 （缩进层级、可折叠分支节点 caret、You/AI/Tool 彩色角色标签、`×N` 分支
  徽章、当前路径绿点 + 高亮、选中态、role=tree/treeitem 语义）；右栏 =
  选中条目详情（角色/时间戳/路径状态/兄弟数 Pill + 完整摘要正文）+ 功能栏
  （**Rewind here**——当前路径节点禁用；**Fork here**——`ompHistory/forkAt`
  entry 锚定 fork：`session.fork` 的 anchor 扩展 `{atSeq?|entryId?}`，
  entryId 以其 timestamp 为切割边界，子文件落源旁）。浏览器验收：树选择/
  详情联动 ✓、Fork here 成功（子文件 2 行 = header+锚定条目）✓。
- **M10 历史页 TUI /tree 对等（2026-08-25，用户指示）**：
  ①**树样式**——去圆角，改为圆点 + 竖线/横线肘形连接线（CSS ::before/::after
  伪元素画 parent lane 竖线 + 横向 stub，顶层行无连接线；节点前 7px 圆点，
  选中/当前路径蓝色，选中加 outline 环）；行/详情/按钮全部 border-radius: 0。
  ②**任意节点可回退**——去掉当前路径禁用（TUI 语义：回退到路径上任何点）。
  ③**用户消息回退进输入栏**（TUI selector-controller 同行为）——
  `ompHistory/navigate` 返回 `{editorText?}`（navigateTree 对 user entry
  返回其文本）；HistoryView 通过 **session standard kit 的 `inputActions`**
  （session-scoped slot 组件自动合并的标准 props，来自 ui-conversation 的
  provide channel）调 `inputActions.setDraft(editorText)`。浏览器验收：
  选中 user 行 → Rewind → 消息文本出现在 composer ✓ + 提示"在输入栏编辑" ✓。
  **踩坑**：Playwright getByText/treeitem 全页匹配会命中侧栏会话树/对话流
  的同文本元素——测试必须限定 `getByRole("tree", {name: "Message tree"})`。
- **M11 树样式精修（2026-08-25，用户反馈）**：①**嵌套连线**——树改为递归
  嵌套渲染（TreeNode 组件），`.treeChildren` 左侧 guide 竖线（border-left）
  + 每子行 ::before 横向 stub（-12px 起 12px 宽），首子行带圆弧肘
  （border-top-left-radius: 8px）——连线真正连贯；②**无常态背景**——树行去
  掉 resting/current-path 背景，只保留 hover 与 selected；③**DSH 按钮**——
  Rewind/Fork 改用 dsh **Button primitive**（variant="outline" size="sm"，
  原生圆角），替换自造 actionBtn。浏览器验收：嵌套树 + 连线 + DSH 按钮 ✓。
- 剩余（批次 6）：子代理 history/prompt/interrupt、guided-goal、/permission、
  host.pickDirectory、会话删除（A3 待批）。
- 注：`test/eval-code-mode-declarations.test.ts` 的 TS2769 为**上游既有错误**
  （stash 验证），与 web fork 无关。

### M1 实现要点（踩坑记录）

- `user/message` 事件的 `data` 就是消息本体，**不包** `{message}` 层（其余 surface
  事件如 `assistant/message`/`tool/result` 的 data 是 `{turn, step, message}`）。
- OMP 合成 toolCall id（如 `ollama:1:read`）跨 step 重复，映射时需加
  `@t{turn}s{step}` 限定符（`translate.ts` 的 `wireCallId`）。
- OMP 把中止/空响应的 assistant 消息持久化为空 content；dsh 契约规定此类回合
  不携带 `assistant/message` 事件，翻译时跳过。
- **seq 空间统一**：dsh 客户端以 seq 去重（`<= windowTail` 判为重放丢弃），
  因此附着会话的 history 与直播事件必须共享一个连续 seq 空间——
  `SessionEventTranslator` 维护 canonical log，附着（switch/new/boot）时用
  `adopt(messages)` 以历史重建种子，直播事件续接。
- 调试技巧：客户端折叠（`ConversationNodeAssembler` + ui-conversation 定义）可
  在 Node/Bun 中离线复现（假 ctx 收集定义），用于定位线上形状错误。

## 设计要点（用户指示）

### 工作区侧栏的项目 ← `~/.omp/agent/sessions` 的存储布局（2026-08-24）

工作区侧栏的「项目」列表应从 OMP 会话存储目录派生，而不是只报当前 cwd 一个隐式工作区：

- OMP 会话按 **cwd 桶**存储：`~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl`
  （XDG 变体扁平化到 `$XDG_DATA_HOME/omp/sessions`；编码与迁移逻辑在
  `oh-my-pi/packages/coding-agent/src/session/session-paths.ts`，目录根来自
  `@oh-my-pi/pi-utils` 的 `getSessionsDir(agentDir)`）。
- **一个 encoded-cwd 桶 = 一个工作区（项目）**：桶名解码回 cwd 路径，桶内会话即
  `workspace.sessionIds`。侧栏由此得到「全部项目 + 各项目会话」的树，与 TUI 的
  `--cwd` 会话切换语义一致。
- 实现落点：`WebDriver.listWorkspaces()`（`packages/web/src/protocol/driver.ts`）；
  OMP 侧用 `SessionManager.listAll()`（跨全部项目目录）+ session-paths 解码实现，
  当前活跃 cwd 的工作区排最前。
- M0 的单隐式工作区（`omp-cwd`）是被该方案取代的过渡实现。

## M12 — 历史 TUI 对等 + 本地化（2026-08-25）

- `historyTree` 全条目投影：`modes/web/history-tree.ts` 新建，`SessionEntry` → `WebHistoryNode`
  （kind/text/label/bookkeeping/toolCallsOnly/errorOrAborted/currentLeaf/onCurrentPath），文本与过滤标志完全对齐
  TUI `tree-selector.ts` 的 `#getEntryDisplayText`/`#applyFilter`；`branchSummariesEnabled` 随树返回。
- `navigateToEntry` 增加 summarize/customInstructions；新增 `ompHistory/label`（appendLabelChange）。
- 客户端 HistoryView 重写：`omp.history` 词典（zh/en，DSH locale 插件方式注册 + `locale:` 席位注入 `t`），
  标签页 label 变 thunk；TUI 五种过滤模式 + 搜索 + 键盘（↑/↓/Home/End/PgUp/PgDn/Alt+↑↓/Enter）+
  「已在此位置」no-op + 标签编辑（TUI Shift+L）+ 摘要三选（TUI Summarize branch?）。
- omp-settings 插件补 tsconfig + node_modules 符号链接 + css-modules.d.ts（进入 tsc 类型检查，
  修复暴露的 exactOptionalPropertyTypes/Catalog 线形错误）。

## M13 — 回退重建 / 分叉可见性 / Git-graph 画布（2026-08-25）

- **回退后对话重建（零客户端改动）**：调研结论（Explore）——dsh 客户端对 seq ≤ tail 的回退事件一律按重放
  丢弃，唯一能在不改 vendored 代码的前提下重建会话窗口的路径是 **前向 gap 修复**（`acceptLiveEvent` 检测
  `seq > tail+1` → `repairGap` 重取尾页 → `installWindow`→`replaceWindow`）。实现：`translator.skipTo(seq)`
  时间接片——回退后把 seq 水位直接跳过客户端已知尾，再追加一条 display-only 的 `rewind` 命令卡
  （`appendCommandRun/Done`），gap 触发客户端整体换窗。副作用：回退在转录里留下一条 rewind 卡（信息性，合理）。
- **fork 后侧栏可见**：`driver.fork` 广播 `session-added` + 失效列表缓存；插件侧 HistoryView 分叉成功后调
  注入的 `refreshSessions()`（runtime `SessionRuntime.refresh()`，ISessions 契约未暴露，经 as-cast 调用——
  注入 face 属胶水层）。验证：分叉后无需刷新即出现在侧栏（含标题）。
- **canvas 改视口 + 滚动驱动**：canvas 从「整树一张」改为视口尺寸，`scroll` 事件 rAF 重绘，仅画可见行窗口；
  祖先行滚出视口时连线从顶边进入（Git-graph 语义），最后一个可见行把子车道延伸出底边；半像素对齐（stroke +0.5）。
- **颜色可靠性**：发现部分 `--dsw-alias-*` 在 canvas 上 getPropertyValue 可能得到未解析 var()（赋给
  strokeStyle 被静默忽略→黑线看不见）。解法：候选 token 经 strokeStyle 往返校验，全部无效才用回退色。
- **布局**：HistoryView 根节点挂 `data-conversation-composer-overlay`（trajectory 模式）——viewArea 变
  `flex:1 1 0; overflow:hidden`，树/详情各自内部滚动，不再撑开整个标签页。
- **踩坑**：一次 `kill+nohup` 重启因 EADDRINUSE 静默失败（旧进程未死、新进程退出、curl 200 来自旧服务），
  导致整轮验收跑在旧代码上。教训：重启后必须核对 **新 pid 与启动时间**，不能只看 curl 200。
- 验收截图：`gui-test-screenshots/m13_t*`（回退重建对话、恢复、分叉侧栏、滚动重绘）。
- 追加（用户反馈）：删除搜索栏下的快捷键提示行；树/详情滚动容器底部留白改为
  `calc(var(--dsh-composer-height, 152px) + 16px)`（ConversationRoot 发布的浮动输入框实时高度，
  trajectory 同款），最后一行不再被输入框遮挡。

## M14 — 历史操作导航 + 侧栏活性（2026-08-25）

- **回退/fork 后的落地行为（用户要求）**：回退成功后自动切回「对话」tab（`actions.setView('chat')`）；
  fork 成功后 `sessions.open(childId)` 落到子会话的对话（新会话无持久 view，回退到默认 chat）+
  双次列表刷新（立即 + 800ms 重试）。**实现零 vendored 改动**：`conversation.view` 的 chat entry
  在注册时挂了 chatStore（store seat），store 实例按 handle 身份共享——omp-history entry 注册时
  把同一 handle 附上（`slots.entries('conversation.view')` 取 `.store`），框架标准 kit 即注入
  同一实例的 bound `actions`（setView）。这是 dsh store seat 的设计内用法。
- **自动标题侧栏刷新**：`sessionManager.onSessionNameChanged` → 失效列表缓存 + 广播
  `session-projection {key:"title"}`（与 rename 同帧），标题生成后侧栏即时更新。
- 验证：中间位置回退 → 自动切回对话、转录为回退点前缀（Zig 问答在、lab/blocktree 消失）、
  输入框带回退消息；fork → 侧栏实时出现子会话、自动选中并落在其对话 tab。
- 截图：`gui-test-screenshots/m14_t1_mid_rewind.png`。

## M15 — 三项根因修复 + 全链路实测（2026-08-25）

用户实测反馈"回退无变化、fork 侧栏不更新、标题不刷新"。逐项根因分析（含可见探针验证）后修复：

- **回退无变化 = 插件 apply 顺序竞争**：插件 apply 由服务依赖就绪驱动而非脚本顺序——omp-settings 依赖
  slots/locale/sessions（早期就绪），ui-conversation 还在等 layout 等，导致 omp 先 apply，
  `slots.entries('conversation.view')` 找不到 chat entry 的 store 句柄 → `actions` 未注入 →
  `setView` 可选链静默空转。修复：模块级 inject 增加 `conversation` 服务（ui-conversation 提供），
  apply 确定排其后。探针证据：缺句柄时标签显示 `⚠ no-store`。
- **fork 侧栏 = open 与列表刷新的顺序竞争**：`sessions.open`→`select()` 对不在列表摘要的会话直接
  throw（manager.ts:188），此前靠 session-added 帧恰好先到才"碰巧"工作。修复：openSession face 改为
  确定性重试——先 `refresh()` 落列表再 open，最多 12 次 × 250ms。
- **标题不刷新 = 两处叠加**：(a) 真实根因是"首条用户消息派生标题"只在列表重拉时到达客户端；
  (b) 初版挂 agent_start 但此刻 `#session.messages` 尚为空（日志证实 messages=0），且会话头是
  空串标题 `''` 而非 undefined，双重挡住发射。修复：挂 agent_end（消息已齐）+ falsy 守卫；
  派生标题经 session-projection {key:"title"} 广播——客户端 buildListSnapshot 本就读该投影键。
- 验证方法教训（记录）：此前两轮假阳性——未核实服务重启真换了进程（EADDRINUSE 静默失败）；
  用"永远存在的标签行"当选中证据；引导性截图提问。本轮全部改为精确断言（[selected] 限定、
  服务端日志、文件系统事实核对）+ 非引导截图。
- 实测（全过）：回退中间条目→自动切回对话（[selected] 断言+截图 m15_t1）+ 前缀正确；
  fork→带标题新行出现+子会话选中+落在对话；新会话首条消息→回合结束侧栏免刷新出现派生标题
  （"进行中 worldview"→"解释一下什么是B+树"，无 reload）。

## M16 — fork 回归原生格式（2026-08-25，用户要求零偏离）

- **fork.ts 重写**：不再手写子会话文件。锚点截断的源以**原始行的字节前缀**暂存于系统临时目录
  （非会话桶），子会话完全由原生 `SessionManager.forkFrom` 生成（title 槽/版本头/parentSession=源
  会话 ID/providerPromptCacheKey/blob 解析），artifacts 用原生 `copySessionArtifacts` 从真实源复制，
  暂存文件 finally 删除。实测子文件与原生逐字段一致（title 槽含定宽 pad、version 3、
  parentSession=id、cacheKey），/tmp 零残留。
- **写入面审计**：web 模式对会话文件的全部写入均走原生 API（appendCustomEntry[原生扩展机制，
  上游 cleanse/todo/tool-start 同用]/appendLabelChange/appendModeChange/setSessionName/navigateTree/
  forkFrom）；rewind 标记仅为显示层事件不落盘；其余 Bun.write 仅设置文档导出与 web-client-settings.json，
  非会话文件。
- **事故记录（重要）**：清理测试产物时启发式误判——"header 带 parentSession 即删"把用户 08-19~08-23
  的 5 个自有 fork 一并删除（我的 fork 全部在 08-25）。btrfs 根快照不含 @/home 子卷，不可恢复；
  `history.db` 按 session_id 保留了其中 97 条 prompt，已导出
  `omp-web/recovered-prompts-deleted-forks.json`（两个 0-prompt 的 fork 为纯前缀分叉，无独有内容）。
  共享前缀仍在其父会话（01a012a8 等）中。教训：删除必须按"我能证明是我创建的"白名单，不能按特征黑名单。

## M17 — 按当前分支线性化（用户指出的根本性缺陷，2026-08-25）

用户诊断（完全正确）：OMP 会话是 git 式树状历史，**只有当前叶子所在的分支+祖先链才是实际对话
上下文**，其余皆为分叉历史；而 web 驱动此前把 `getEntries()`（全树所有分支）当线性序列折叠喂给
DSH。后果：分支多的会话（多次回退/分叉后的 Implement 会话）事件结构交错，客户端组装器渲染不出
任何消息；回退后的重建也因此错误（只见 rewind 标记卡）。

- **重构**：`historyItemsOf` 内部先取**活动分支**（`currentBranchOf`：末条目沿 parentId 上溯到根，
  反转即根→叶；冷文件的活动叶子=最后一行，附加会话用原生 `getBranch()`）；四处种子
  （构造/newSession/回退重播种/switchTo）全部改喂 `getBranch()`；fork 的 turn 边界扫描随
  `historyItemsOf` 一并修正。historyTree 保持全树（树视图本就需要）。
- 实测：Implement（667 条消息、多级分叉）对话页正常渲染（此前零消息）+ 加载更早分页；
  回退到"分析 lab 项目的算法"后对话页=该点之前的 Zig 问答前缀、之后的 lab/blocktree 内容消失、
  输入框带回退消息（截图 m17_t1/m17_t2）；回退后已恢复原叶子（盘上叶子链验证）。
- 直播事件流本就只追加当前分支（新条目挂在叶子上），种子与直播自此语义一致。

## M18 — 评审修复批（死锁 / 模式泄漏 / 契约对齐，2026-08-25）

全量架构评审后的逐项修复（AGENTS.md 新增 A6：本批禁用子 Agent，全程主 agent 直接
改码）。按严重度：

- **P0 审批挂起死锁**：`ExtensionToolWrapper` 的审批门 `await uiContext.select()` 不挂
  AbortSignal；`session.abort()` 等待回合收尾会永久挂起（浏览器刷新同理）。修复：
  driver 在 `cancel()` / `navigateToEntry()` / `#switchTo()` 先经 WebStreamEvent 发
  `cancel-asks`（driver 不持有 server 侧注册表，复用 subscribe 通道），serve.ts 的
  `PendingInteractions.failSession` 逐个 fail 并广播 `approval/resolved{rejected}` /
  `question/resolved{cancelled}`——挂起 promise 落定，客户端面板消失。
- **P1 切换模式泄漏**：`AgentSession.switchSession` 只恢复消息/模型，不恢复
  plan/vibe/goal 状态与工具集——web 里打开冷会话会把上一会话的模式带过去。修复：
  `setSessionSwitchReconciler` 钩子挂 `#reconcileModesFromSession()`（按
  `buildSessionContext().mode` 重入/清理 plan[plan_paused 保守保 guardrail]/vibe/goal，
  对齐 TUI `#reconcileModeFromSession` 的范围：state+工具集，不含 goalRuntime 恢复）；
  构造函数/boot/newSession 同样调用。
- **P1 CSS 幻影 token**：omp-settings 的 settings.module.css 引用了一批不存在的
  `--dsw-*` 变量（全部静默失效）。按 ui-theme 真实 token 表逐项映射
  （font-size→`--dsw-font-xs-13-font-size`、text→`--dsw-alias-label-*`、
  border→`--dsw-alias-border-l2/l3` 等）；`--dsw-radius-sm` 无对应 token，按 dsh
  惯例硬编码 6px。HistoryView 的 canvas token 引用经校验全部存在。
- **P2 契约缺口**：skill.list 从错误形状 `{items:[]}` 桩改为真实填充（契约
  `{skills:[{name,description,modelInvocable}]}`，name 用 `skill:` 前缀形式）；
  session.export 端点实现（GET/HEAD `/api/session.export`，自含 STORE zip writer
  `src/server/zip.ts`，descendants 沿 parentSession 链），hmr 插件出册（宿主不提供
  其 EventSource）；steering 消息折叠进聊天流（此前直播/历史两处 skip，与 History
  树可见矛盾）；pageHistory 长回合空页死锁（单回合超预算时前向找不到边界 →
  空页+hasMore 软死锁，最新回合巨大时首屏全空；改为回退到该回合起点扩窗）。
- **P3 设计气味**：`__providerLogout:`/`__modelRole:` 魔数 key 改专用 RPC
  （`ompSettings/logoutProvider` / `ompSettings/setModelRole`，vendored 客户端两处
  调用点同步）；prompt 迟到拒绝浮现为失败命令卡（此前只进服务端日志，用户消息
  无声消失）；切换/新建广播 `session-attached`（serve 映射为 `session/subscribed`
  重基线 + queue 快照，客户端 queue 镜像/projection 随新基线重置）；workspace.list
  透传桶 mtime；mutateClientSetting 真嵌套路径（拒 `__proto__` 段）+ tmp+rename
  原子写；listFileReferences 拒 `..`/绝对段逃逸 cwd；`WebModelEntry.reasoning` 正式
  声明；redactedThinking  opaque blob 不再渲染；builtin 命令 refreshCommands/
  reloadPlugins 接线（对齐 rpc-mode）；run-web-mode 端口占用回退 OS 分配 +
  SIGINT/SIGTERM 即时停机（原 60s 轮询）；win32 `start` 走 `cmd /c`；
  describeHost 诚实化（真实 attachedSessions、canOpenPath:false）；pendingUserRpcId
  死重移除（客户端不消费 source.rpcId）。
- **验证**：packages/web 52 测试 / coding-agent test/web-mode 11 测试全绿；两包
  tsgo + biome 通过；dsh-web 客户端树 tsc -b 通过。

## M19 — TUI 能力面全量补齐 + 浏览器冒烟（2026-08-26）

对 TUI 能力清单（A1）逐项审计（P0–P4 全量报告见会话记录）后的实现批。全部主
agent 直接改码（A6），dsh-web vendored 树零改动。

- **附件链路（P0）**：`session.prompt` 收图片 part（`{type:"image",mediaType,data}`，
  rpc 层 `parsePromptParts`）；历史/直播三块内容源（user/assistant/toolResult）的
  image block 映射为 `{type:"image", attachment}`；`session.attachment` verb 按内容
  寻址（`att_<sha256>`，新模块 `attachments.ts`；会话日志=授权边界）；`imageLimits`
  投影（每份 history tail 常量播种）。冒烟：粘贴 PNG → 图片随 prompt 进会话 →
  用户消息渲染大图 → kimi-k3:cloud 无视觉走 OMP 落盘降级链。
- **工作区五 verb（P0）**：`workspace.rename/delete/insertBefore/insertSessionBefore/
  archiveSession` + 覆盖存储 `workspace-state.ts`（`~/.omp/web-workspaces.json`：
  标题/排序/归档/计划路径）。**deleteWorkspace 语义反转**：审计时定为"真删会话
  文件"，冒烟发现 vendored 确认对话框明示"The folder and session logs will be
  kept"——真删会让 UI 对用户撒谎（数据丢失级）。改为 forget-only（只丢覆盖；有
  会话的 cwd 桶下次 list 重现为 basename 桶，与对话框"appear under Ungrouped"
  文案一致）。冒烟实测：删除后该行归入 Ungrouped ✓。
- **session.search（P0）**：全文检索走 `SessionInfo.allMessagesText`（4KB 前缀窗，
  与 TUI 会话搜索同一上游窗口语义=对等）；snippetAround 码点安全截取；上限 20。
- **goal 全链路（P0）**：`goals.*` 六 verb（CAS ref）；goal projection 从
  `goal_updated` **事件负载**投影（dropGoal 先于 commit 发事件）；agent_end →
  800ms 自动续轮 + complete/drop 退出拆工具集；`/goal` 桥重写（set/show/pause/
  resume/drop/budget + 裸目标简写 `#startGoal`）；`/guided-goal`（goal 工具入列 +
  合成开场 interview prompt）。冒烟：/goal 设置 → GoalBar 出现（暂停/编辑/清除
  按钮齐）→ 自动续轮 35 回合 → complete 后 bar 消失；**/goal pause 相位切换
  实测 ✓**。
- **命令 claim 路由（P0 级缺陷，冒烟抓获）**：dsh 客户端只在 host 命令声明
  `input` 时才把 `/name args` 认领为命令（matchEnter 决策表），否则静默降级为
  prompt 发给模型。修复：`WebCommandDescriptor.input`（hint），registry 的
  `argumentHint` 透传，桥命令 goal/loop/plan/vibe/btw/tan 声明 input。冒烟前
  `/goal smoke test objective` 被当 prompt 发给模型，修复后正确走命令。
- **session.history 基线漏种（P0 级缺陷，冒烟抓获）**：goal/imageLimits 种子只
  加进了 `subagent.history` 分支，`session.history` 漏了——重载后 GoalBar 不渲染。
  修复后重载基线渲染实测 ✓。
- **子代理三 verb + parked 列出**：subagent.history/prompt/interrupt；parked 子
  代理从 `<fileSafeTimestamp>_<sessionId>.jsonl` 文件名尾段取 id，父子链接校验
  （`parentSessionPath` basename 或 registry ref）。
- **事件保真（P2）**：retry/compaction/notice → 临时命令卡（冒烟中
  auto-compact 卡实测渲染 ✓）；jobs 帧（`session/jobs` 全集快照，agent-event
  边界 diff 推送，cancelled→killed；冒烟中"1 background job"chip 实测 ✓）。
  todo toolview 改名决定：**不改**——OMP todo args `{op,list:[{phase,items}]}`
  与 dsh todo_write `{todos:[{content,status}]}` 词汇不同，线改名没有收益且说谎，
  toolview JSON 形状守卫自然回退通用渲染。
- **P1 命令桥**：`/plan`、`/vibe`（携带 prompt 参数；vibe 退出现在
  `killAll` 工人会话，修复审计发现的工人泄漏）、`/plan-review`（读最新
  `local://*-plan.md` 只读卡）、`/loop`（loop-limit 运行时 + 自动重投）、
  `/btw`（runEphemeralTurn）、`/tan`（TanCommandController 全量移植）、
  `/clear`（resetSessionContext + reset_boundary 折叠）、`/drop`
  （newSession({drop:true})）。
- **目录选择器**：browse 变体入册（native 桌面对话框宿主无法服务，继续出册）；
  `host.listDirectory`（只列目录、隐藏标记、上限 500、crumbs）/ `host.createDirectory`
  （拒嵌套名）；`workspace.create` 收养既有目录。冒烟实测：Add workspace →
  目录浏览对话框 → Edit path 直达 → 创建入册 ✓。
- **设置目录**：omp-settings 不再隐藏 number-without-options / array-without-options
  字段（客户端 OmpTabSection 自由输入 + Number() 强转 + 逗号切分数组）；
  runtime-options 字符串仍跳过。冒烟实测：Context 页 28 项，Additional Workspace
  Dirs 自由输入 → blur 写入 → 落 `config.yml` ✓。
- **messageFeedback（M19 决定）**：出册移除（boot roster 注释存档）；冒烟确认
  助手消息 footer 只剩 Copy/Branch，无 thumbs ✓。
- **跨工作区建会话（冒烟抓获）**：`createSession({workspaceId≠cwd})` 原抛错
  （M1 单会话时代遗留），现为**不打扰活会话**地在目标桶铸空白会话文件
  （header-only JSONL）；点开时经 history() 的 cold-open attach 接管。
- **editor() 评估**：问题输入本就是 auto-grow textarea，多行内容可输入；维持
  input() 回退，不引例外组件。
- **P3 长尾处置**：git/extensions/hotkeys/collab/live/setup/exit/quit 等 TUI 长尾
  命令维持不桥接（用户批复）；vibe 指示器、P3 仪表盘不做（用户批复）。
- **验证**：packages/web 59 测试 / coding-agent test/web-mode 22 测试全绿；两包
  tsgo + biome 干净（唯一存量 error 为 eval-code arktype 方差，HEAD 即有，未动）；
  全链路浏览器冒烟（工作区五 verb / 目录选择器 / goal bar 双路径 / 图片往返 /
  归档 / 搜索 / 设置写入 / 事件卡 / jobs chip / feedback 缺席）通过。

## M20 — UI 一致性修复 + History DSH 化（2026-08-26）

对照审查发现项全量处置（TUI-only 设置标注按用户指示不做）。细节见 PROVENANCE.md
M20 节；此处只记设计决定与坑。

- **P0 标题清除的根因**：`ProjectionValueStore.seed()`（vendored projection-store.ts:149）
  会用历史基线覆盖 list 阶段播种的派生投影行——cold 会话的 title 是派生值，不在事件
  流内，seed 时按 seq 删除语义被清掉，客户端回退 cwd basename。修法不在投影存储
  （vendored 零改动），而是 driver `#titleOfCurrent()` 优先持久标题
  （`sessionManager.getSessionName()`），与 cold 路径语义对齐。**教训：凡 list 播种的
  派生投影，attach 后都必须有持久数据源兜底，不能依赖事件流重放。**
- **`session_exit` 排序决定（存档）**：OMP 会话列表按 mtime 排序，附着会话被 kill 时
  追加的 session_exit 簿记行会把它顶到最前。TUI 会话列表同语义（TUI parity），
  过滤簿记时间戳需要改上游 session-listing，超出 fork 边界——维持原样。
- **搜索 4KB 窗口**：session-listing 的前缀扫描只读 4KB 前缀 + 32KB 尾部，大文件/
  消息靠后的会话搜不到中段内容。driver 侧加深扫兜底（≤16MB 全文件子串 + ±600 字符
  JSON 清理窗口），不改上游。
- **DSH 设置行词汇**（EnterBehaviorRow）：行 padding 16px 0、标题 14/22 label-primary、
  描述 12/18 label-tertiary（**不要** opacity 0.8 自调）、选择器 36px 无边框胶囊
  `bg-module-platform` 填充。trajectory 树行词汇：`font-xxs-12`、tag 药丸
  （user=success 绿 / system=secondary）、选中 `inset 0 0 0 2px
  brand-primary-new-colorprimary-new-color`（**双主题均蓝**；裸 `brand-primary`
  在 light 主题是近黑——画布强调色务必用前者）。
- **CSS `var()` 回退纪律**：DSH 惯例裸 `var(--token)` 无回退——回退值会静默掩盖
  token 改名/缺失（M18 教训）。fork CSS 已全量清除（仅留 `--dsh-composer-height`
  布局变量回退）。Canvas 侧例外：canvas 无法解析 var()，JS 色值链
  `['--token-a','--token-b']` + 字面回退仍必要（经 strokeStyle 往返校验）。
- **遗留**：「(no messages) (1)」为修复前持久化的历史分叉标题（用户数据，不回写）；
  DSH 品牌位维持原版（A3 待指示）；审批面板/queue chips 未做 live prompt 复验
  （消耗用户凭据），以契约测试为准。

## 里程碑路线

- **M1（已交付）核心聊天循环**：`session.create/resume/history/prompt/cancel`；
  `AgentSessionEvent` → dsh `SessionEvent` 词汇映射（正文/思考流/工具卡流式）；
  中断；审批 `approval/requested` + `/api/respond`；工作区列表改为 sessions 桶派生。
- **M2（已交付）**：模型/thinking 级别选择；斜杠命令发现与 `/` 触发；审批往返；
  会话 rename。
- **M3**：设置、子代理、计划模式、ask 问答（`question/requested`）、技能、
  `command/run`/`command/done` 生命周期事件桥、队列（steering）、会话 fork/delete、
  历史分页。
- **M4**：对 TUI 能力清单（AGENTS.md A1）逐项对等审计收尾。
- **M19（已交付）**：审计发现项全量实现（P0/P1/P2）+ 浏览器全链路冒烟；
  处置记录见 M19 节（todo toolview 不改名、workspace.delete forget-only、
  P3 长尾按批复不做）。
