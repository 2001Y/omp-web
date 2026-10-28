# PROVENANCE.md — omp-web 组件来源与适配记录

本文件按 omp-web `AGENTS.md` A2/A3 约束记录：所有视觉/交互组件的来源、
vendored 原版文件的每一处改动、以及胶水层对原版逻辑的行为移植。

## 1. Vendored 客户端栈：`dsh-web/`

- **来源**：`ref-repo/deepseek-harness`（只读参考，不改动）。
- **基线**：commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（2026-08-21）。
- **拷贝方式**：`rsync -a --exclude='.git/' --exclude='.jj/'`（其余整树，含
  `node_modules`/已构建产物，约 1.6 GiB；pnpm store 为全局硬链接，拷贝后
  树内为独立文件副本）。
- **构建状态**：`apps/web/dist`（Vite 外壳）与全部 41 个花名册插件的
  `lib/client.js` 在拷贝时已构建完成，未做任何补构建。`ui-primitives`、
  `ui-slots`、`web` 三个包走 `staticLinked` 通道（静态链入 Vite 外壳），
  按设计无 `client.js`。
- **源码改动**：**零**。截至本记录，vendored 树与基线逐字节一致
  （排除 `.git`/`.jj`）。任何未来适配（import 路径重定向、运行时兼容
  修复）必须逐条追加到下文「适配记录」一节。

## 2. 胶水层对原版逻辑的行为移植（A4 允许的非呈现层）

`oh-my-pi/packages/web/src/` 内以下实现是 dsh 原版**非呈现层**逻辑的行为
移植（原版文件因绑定 Cordis/Node 宿主无法直接 import；移植保持行为等价，
浏览器侧原版 bundle 仍是线上契约的唯一权威）：

| 胶水文件 | 原版来源（dsh-web/ 内路径） | 移植内容 |
| --- | --- | --- |
| `src/boot/graph.ts` | `packages/client/modules/src/index.ts`（`ClientModuleRegistry`、`orderByModuleGraph`、`graphRow`、`resolveMeta`、`serveBundle` 的表构建部分） | boot 图组装：roster 扫描、`dsh.client` 声明解析、`exports["./client"]` 解析、sha1-12 rev、模块图排序 |
| `src/boot/graph.ts`（`stripClientSuffix`、`optionalStringArray`） | `packages/client/modules/src/client/manifest.ts` | 规范化辅助 |
| `src/boot/inject.ts` | `packages/host/webserver/src/injections.ts`（`renderIndexInjections`/`renderRow`） + `packages/client/modules/src/index.ts`（`bootInjections` 的队列脚本与预加载行） | index.html 注入行渲染（含 `<` 转义）；`__ModuleLoader__` 队列脚本文本逐字复制（属线上 wire 协议） |
| `src/server/trust.ts` | `packages/client/connection/src/api-request-trust.ts`、`loopback-hostname.ts` | `/api` 信任围栏（Host 回环/白名单 + `sec-fetch-site` + Origin 同源校验） |
| `src/server/static.ts` | `packages/host/frontend-static/src/index.ts`（`serveStatic`） | dist 静态服务语义（根/index 路径渲染、403/404/405、MIME 表） |
| `src/server/serve.ts`（`/plugins/` 路由） | `packages/client/modules/src/index.ts`（`serveBundle`） | 插件 bundle 与 sourcemap 服务（含带 scope 的 id 解析） |
| `src/server/serve.ts`（WS 下行） | `packages/client/connection/src/websocket-downlink.ts` | 仅保留「下行只读、客户端消息即违规关闭(1008)」语义；M0 无帧推送 |
| `src/contract/wire.ts` | `packages/host/apiproxy/src/api/rpc.ts` | 四象限信封类型镜像（仅本宿主产生/消费的成员） |

浏览器花名册（`src/boot/graph.ts` 的 `BOOT_ROSTER`，41 项）来源：
`packages/bundle/web-app/cordis.patch.yml` 的浏览器行（含 `client-hmr`、
`session-log-download`）加上 base 层双面行（`typert`、`typert-gateway`）；
`ui-directory-picker-browse/native` 两包按原版「auto picker 按需覆盖挂载」
语义暂不入册（omp 宿主尚未提供目录能力）。

## 3. 例外组件记录（A3）

无。截至本记录，未出现需要自造的视觉/交互组件。

## 4. 适配记录（vendored 树源码改动）

无（零改动）。新增条目格式：日期、文件、改动、理由。

### M18 记录（2026-08-25）

- **BOOT_ROSTER 移除 `dsh-client-hmr`**（`oh-my-pi/packages/web/src/boot/graph.ts`）：
  该插件是 dev-only 热重载，消费宿主不提供的 `/plugins/events` EventSource；
  出册为 boot 组合层取舍，vendored 文件零改动。`dsh-session-log-export` 保留——
  宿主已实现其端点契约（下条）。
- **`session.export` 端点**（`src/server/serve.ts` + 新增 `src/server/zip.ts`）：
  GET/HEAD `/api/session.export?sessionId=&includeDescendants=` 返回会话日志 zip
  （STORE 方法、表驱 CRC32、本地头+中央目录+EOCD，自含实现避免引入归档依赖）。
  属 A4 非呈现层（协议实现），对齐 `session-log-export` 插件的客户端契约
  （HEAD 探活 → GET 下载）。descendants 沿同桶 `parentSession` 链。
- **`omp-settings` 包内改动**（fork 自有目录，非 vendored 原版文件）：
  - `settings.module.css`：幻影 token 重映射到 ui-theme 真实 token
    （`--dsw-font-size-sm/xs`→`--dsw-font-xs-13-font-size`；
    `--dsw-text-primary/secondary`→`--dsw-alias-label-primary/secondary`；
    `--dsw-border-subtle/strong`→`--dsw-alias-border-l2/l3`；
    `--dsw-bg-secondary`→`--dsw-alias-bg-layer-2`；
    `--dsw-status-warning`→`--dsw-alias-state-warn-primary`；
    `--dsw-alias-interactive-bg-selected`→`--dsw-alias-interactive-bg-active`）。
    `--dsw-radius-sm` 无对应 token，按 dsh 惯例（ui-primitives 硬编码 px 圆角）
    改为硬编码 6px。此前这些 var() 全部静默失效（浏览器对未定义自定义属性
    回退初始值）。
  - `ConnectSection.tsx` / `ModelRolesSection.tsx`：登出与角色指派从魔数 key
    （`__providerLogout:`/`__modelRole:` 走 `ompSettings/update`）改专用端点
    `ompSettings/logoutProvider` / `ompSettings/setModelRole`（结构化参数，
    服务端 driver 新增同名 verb）。
- **测试基建**：`packages/web/test/serve.test.ts` 新增 `collectFramesObservable`
  （opened 可等待信号）+ deferred 取代 Bun.sleep 时序假设；既有 collectFrames
  签名不变。

## 5. dsh-web 树的更新流程

1. 在 `ref-repo/deepseek-harness` 拉取目标版本（保持只读）。
2. 重新 rsync 至 `dsh-web/`（排除同上）。
3. 若原版重新构建：在 `ref-repo` 现场 `pnpm install && pnpm run build`
   后再拷贝，或在本树内构建；流程与结果记入上表。
4. 比对 `BOOT_ROSTER` 与新 `cordis.patch.yml` 浏览器行的差异并更新。
5. 跑 `oh-my-pi/packages/web` 的 `bun test` 与浏览器验收。

## A3 例外记录（2026-08-25，用户指示批准）

- **OMP 设置全量标签页（10 tab 表单）**：dsh-web 无通用 schema 设置表单组件
  （各 settings.section 均为专用组件；ui-primitives 仅 Button/Input/Menu/Modal/
  DisclosureRow 等基础件）。经用户明确指示（"OMP 的设置也要全部实现，一个标签页
  对应一个 web 版设置的标签页"）批准：设置 section 组件由 dsh primitives 组合
  构成，不发明新 token、不写新 CSS（复用 primitives 的 css modules 与
  settings.section slot 机制）。同类覆盖：模型设置 tab（TUI /model 对等）与
  供应商设置 tab（TUI /provider、/logout 对等）。

## 新增客户端插件（2026-08-25，M5）

- **`dsh-web/packages/client/omp-settings/`**：omp fork 自有的设置 section 插件
  （新增目录，vendored 树原文件零改动）。将 OMP 十个设置 tab 注册为
  `settings.section`（外观/模型/交互/上下文/记忆/文件/Shell/工具/任务/供应商），
  表单由 `ompSettings/describe` 目录驱动（dsh primitives：Menu/Input 组合，
  A3 例外见上文）。构建复用 dsh-web 共享 tsdown preset（clientBundle），
  产物 lib/client.js 经 `/plugins/@omp/client-settings/client.js` 服务。
  BOOT_ROSTER 末位追加该包。

### 设置导航滚动（2026-08-25，用户指出）

- 第一版用了原生 `max-height: 60vh + overflow`（自造高度、未走 dsh 滚动控件），
  用户指出后改为 dsh 自身惯例：`min-height: 0; overflow-y: auto`，高度由面板
  （`min(800px, 100vh - 48px)`）约束，滚动条经面板声明的 `--dsh-scrollbar-*`
  token 继承由 ui-theme 的 scrollbar.css 渲染（与 `.options` 内容列同机制）。

### 设置页 roster 裁剪（2026-08-25，用户指示）

- 从 BOOT_ROSTER 移除五个 dsh 原生、omp 后端永不提供的设置插件：
  `ui-settings-models`（dsh DeepSeek 模型配置 section + 内测声明 onboarding）、
  `ui-settings-plugin-inventory`、`ui-settings-plugins`（dsh 插件管理）、
  `ui-agent-preset`（Agent 预设）、`ui-permission-presets`（权限行 + composer
  权限选择器）。vendored 文件零改动，仅 boot 组合层取舍。
- 保留 `ui-settings-general`（用户确认）：设置页外壳 + 通用设置 section
  （语言/外观/繁忙 Enter 行）+ 打开配置文件按钮。
### 历史视图（M12/M13，2026-08-25）

- **`omp-settings` 插件新增 HistoryView（conversation.view 席位）**：canvas 绘制的
  Git-graph 树（视口尺寸 + 滚动 rAF 重绘）为**呈现层**，属既有 A3 例外（自研组合
  组件）的扩展；颜色全部消费 `--dsw-*` token（经 strokeStyle 往返校验，未解析的
  var() 计算值回退），无新造 token。词典走 DSH locale 插件机制（`omp.history`
  命名空间 zh/en + `locale:` 席位注入 `t`），标签页 label 为 thunk。
- **`refreshSessions` 注入 face**：HistoryView 分叉成功后调用 runtime
  `SessionRuntime.refresh()`（`ISessions` 契约未暴露该方法，经类型断言调用）。
  该调用是数据层编排（刷新会话列表），不产生视觉输出，属 A4 胶水；类型断言的
  理由与风险在此记录。
- **`omp-settings` 包补 tsconfig.json / css-modules.d.ts / node_modules 符号链接**
  （对齐 vendored 客户端包惯例，使插件进入 tsc 检查）；vendored 原文件仍零改动。
- 服务端 `translator.skipTo` 时间接片与 `rewind` 标记事件：纯数据层（显示日志），
  无呈现职责；未改动任何 vendored 客户端文件（对话重建利用客户端既有的
  gap-repair 机制）。

### fork 原生化（M16，2026-08-25）

- `modes/web/fork.ts`（omp 自有代码，非 vendored）重写为对原生 `SessionManager.forkFrom` 的
  委托：截断源=原文件字节前缀（OS 临时目录），artifacts=原生 `copySessionArtifacts`。
  会话文件格式自此与上游完全一致（此前手写头缺 title 槽/version 规范化/providerPromptCacheKey，
  parentSession 误为路径）。


### M19 处置（2026-08-26）

- **`ui-message-feedback` 出册**（用户批准）：boot roster 移除并注释存档；vendored
  包文件零改动。副作用：助手消息 footer 不再有点赞/点踩（审计认定与 OMP 的
  无反馈通道模型不符）。
- **`ui-directory-picker-browse` 入册**：纯浏览器目录浏览对话框（数据走
  `host.listDirectory`/`host.createDirectory` RPC + `workspace.create` 收养），无桌面
  能力依赖。native 变体继续出册（桌面 open dialog 宿主无法服务）。
- **新模块（omp 自有胶水，非 vendored）**：`modes/web/attachments.ts`（内容寻址
  附件 id + 尺寸探测 + 会话日志扫描）、`modes/web/workspace-state.ts`（工作区覆盖
  存储，独立 JSON 文档 `~/.omp/web-workspaces.json`，tmp+rename 原子写）。
- **`OmpTabSection` 字段渲染扩展（fork 自有包内改动）**：`omp-settings` 本就是 fork
  自有的 A3 例外包（见 M3 节记录）；本次把 number-without-options 与
  array-without-options 字段从"隐藏"改为自由 Input（number `Number()` 强转、array
  逗号切分），落点 `omp-settings/src/client/OmpTabSection.tsx:113-166`。这些字段
  此前在 GUI 完全不可达；视觉仍全部消费 `--dsw-*` token（复用既有 Input 组件）。
- **未做（批复存档）**：todo 工具不改名 toolview（词汇不同，改了反而说谎）；
  vibe 指示器 / P3 仪表盘 / TUI 长尾命令（git/extensions/hotkeys/collab/live/setup/
  exit/quit）不桥接；editor() 维持单行回退（vendored 问题输入为 auto-grow
  textarea，多行可达）。

### M20 UI 一致性修复与历史视图 DSH 化（2026-08-26）

**触发**：UI/UX 全面对照审查（读 DSH 原版源码逐组件比对 + 浏览器实测）后，用户指示
除「TUI-only 设置标注」外全部处理，并将 History 标签页样式与 Canvas 重设计为贴近
原版 DSH 风格。

**参照的 DSH 原版词汇（只读，零改动）**：
- `ui-conversation/src/client/settings/EnterBehaviorRow.{tsx,module.css}` —— 设置行
  （16px 行距 / 14px 标题 / 12px 三级描述 / 36px 无边框胶囊选择器 `bg-module-platform`）。
- `ui-trajectory/src/client/{TrajectoryCell,TrajectoryToolbar}.module.css` —— 树行
  （`font-xxs-12` 工具行、tag 配色 user=success/system=secondary、选中态
  `inset 0 0 0 2px var(--dsw-alias-brand-primary-new-colorprimary-new-color)`、
  无边框三级工具栏控件）。
- `ui-primitives/src/{Button,Pill}.tsx` —— 胶囊按钮与静态 Pill。

**fork 侧改动**：
- `oh-my-pi/packages/coding-agent/src/modes/web/driver.ts`（fork 自有文件）：
  - **P0：常驻会话标题被历史基线清除**。`ProjectionValueStore.seed()` 删除语义会清掉
    list 阶段播种的标题行（cold 会话 title 是派生值、不在事件流内）。修复
    `#titleOfCurrent()` 先取 `sessionManager.getSessionName()` 持久标题，未命名才回退
    首条用户消息派生，与 cold 路径 `#titleOfInfo` 语义一致。实测「Implement
    neighbor-packed」会话（998 条历史、6 次压缩、last compaction 后无用户消息）标题
    不再退化为 cwd basename。
  - `#titleOfInfo` 过滤 listing 占位符 `(no messages)`（视为未命名，回退 cwd basename）。
    存量已持久化的 "(no messages) (1)" 分叉标题属历史数据，不回写。
  - `session.search` 深扫兜底：前缀扫描无结果时，对 ≤16MB 文件全文件子串扫描，
    截取命中 ±600 字符窗口并清理 JSON 转义后作为摘要。
- `omp-settings/src/client/settings.module.css`（全量重写）：设置行对齐
  EnterBehaviorRow 词汇；**清除全部 CSS `var()` 回退值**（7 处 double + 40+ 处
  token 回退改裸 `var(--dsw-*)`，双主题 token 存在性已逐一验证；仅保留
  `var(--dsh-composer-height, 152px)`——运行时布局变量，非 token）；History 行高
  28→32、角色前缀改 trajectory tag 药丸、选中态改 brand inset ring、详情正文改
  `border-l2` + `bg-layer-3` + r8 卡片、移除全大写 DETAILS 标题；Canvas 调色板改
  `border-l3/l2` 连接线、`label-dimmed` 普通节点、当前路径用
  `brand-primary-new-colorprimary-new-color`（双主题均蓝，替代原 light 主题近黑的
  `brand-primary`；canvas 无法解析 var()，JS 侧保留 token 链 + 回退）。
- `ConnectSection.tsx`（重写）：凭据计数单复数（"1 credential stored"）；状态从
  State/Action 双 Menu 改静态 `Pill: Connected` + 直接 `Logout` 描边胶囊按钮；
  available 行新增 `Copy login command` ghost 按钮（写 `/login <provider>` 至剪贴板，
  按钮瞬时变 "Copied"）。
- `OmpTabSection.tsx`：Reset all 改 `Button outline sm + IconRefreshOutline14`。

**构建/验收**：`tsdown` 重打包 `lib/client.js` 79.74 kB；omp-settings `tsc -b` 通过；
浏览器双主题实测（标题修复 / 设置行 / Connect / History 新样式含主题切换 canvas 重绘）；
`bun test` packages/web 59 通过、coding-agent web-mode 26 通过（新增 4 条：
标题基线播种×2、(no messages) 过滤、深扫）；oh-my-pi 侧改动文件 biome 通过
（dsh-web fork 包无 biome 配置，2 空格风格与 oh-my-pi biome 默认 tabs 冲突，维持原状）。

**已知残留（非缺陷）**：「(no messages) (1)」为修复前分叉时已持久化的历史标题；
TUI-only 设置项标注按用户指示不做；DSH 品牌位（DSH Local Build / Into the Unknown）
维持原版，如需更名需 A3 确认与明确方向。

## 发布形态（2026-08-26，M21）

- **仓库**：fork 发布为独立公开仓库 [LaneSun/omp-web](https://github.com/LaneSun/omp-web)
  （`origin`；上游 can1357/oh-my-pi 改挂 `upstream`）。首个 release：tag `v0.1.0`。
- **dsh-web 不入仓**：vendored 树（1.6 GiB，含 node_modules 与构建产物）不进 git。
  运行时经两条路径获得：
  1. Release 资产 `dsh-web-runtime-<v>.tar.gz`（约 4.3 MiB）——由
     `scripts/package-dsh-runtime.ts` 从本地已构建树收集：apps/web/dist 全量 +
     36 个花名册包的 package.json + `lib/client.js`(+map) + LICENSE +
     THIRD_PARTY_NOTICES + `OMP-WEB-MANIFEST.json`（基线 commit/时间戳/清单）。
     解包即 dsh 根；已实测：解包树启动服务 → index 200 + boot 图注入 +
     插件 bundle 200 + 浏览器完整渲染。
  2. `scripts/setup-dsh-web.sh` 源码构建——clone deepseek-harness @ 固定基线
     （treeless depth-1）、pnpm install --frozen-lockfile、pnpm build、overlay
     `@omp/client-settings` 并手工符号链接其 9 个 workspace 依赖 + react/@types，
     再经根 node_modules 的 tsdown 打包插件 bundle（该包不在 pnpm lockfile 内，
     全仓 pnpm install 会报 ERR_PNPM_OUTDATED_LOCKFILE，故不走 pnpm）。
- **`@omp/client-settings` 源码归宿**：迁入仓库 `dsh-overlay/packages/client/
  omp-settings/`（此前唯一副本在未版本化的 vendored 树内）。dsh 树内那份仍是
  运行时副本；改动应先落 dsh-overlay 再同步进 dsh 树重建。
- **dsh 根解析顺序**（run-web-mode.ts）：`OMP_WEB_DSH_ROOT` → 仓内 `./dsh-web/`
  （release 解包布局，.gitignore 已挡）→ 仓旁 `../dsh-web`（工作区布局）。
- **已知警告**：上游历史自带 `.turbo/cache/*.tar.zst`（53.92 MB）触发 GitHub
  大文件警告；属上游历史包袱，改写历史换消除的代价不成比例，保留。

## ブランド差し替え（2026-10-28、ユーザー指示で実施）

M20 記録の「DSH 品牌位は原版維持、更名には A3 確認と明確な方向が必要」という
残件に対する実施記録。方向はユーザーが 2026-10-28 に確定：「ロゴなども
deepseek から omp に変更」「OMP HARNESS のように、DSH のロゴをパクった感じ」。

- **スロット経由（overlay のみ、ツリー無改変）**：`@omp/client-settings` が
  `sidebar.brand.mark` / `sidebar.brand.name` / `conversation.hero.brand.mark`
  を占有（ui-brand-official と同じ inject＋generator 形式で原子的に登録）。
  マークは幾何構成の π（Brand.tsx に構成数値を明記：24×18 ステージ、キャップ
  バー＋脚＋ノックアウトの目。魚の目のモチーフを継承）。名前は OMP の
  タイプセット＋HARNESS バッジ（公式ワードマークのバッジ文法を模倣、色は
  `--dsw-alias-label-*` トークンのみ）。
- **ホスト配信（packages/web の組成責務）**：ページタイトルを
  `OMP Harness` に差し替え、`/favicon.svg`・`/favicon-dark.svg` は π マークの
  専用アセット（`src/server/assets/`、魚アイコンと同じ #000/#fff の単色処理）、
  `/manifest.webmanifest` は name/short_name のみ差し替えて配信。いずれも
  vendored ツリーには触れない。
- **残留（意図的）**：ヒーローの見出し文言 `Into the Unknown` は
  ui-conversation のロケール文字列で差し込み口がなく、原版のまま。変えるなら
  setup 時のロケールパッチという別途 A3 判断が要る。
- **タイトルの二重経路**：配信 HTML の `<title>` 差し替え（ホスト組成）に加え、
  実行時の document.title はツリー自身のビルド変数 `DSH_CLIENT_TITLE` が
  正本（vite の clientDocumentTitle / clientBuildEnvironmentDefines）。
  setup スクリプトが `OMP Harness` を渡す（`OMP_WEB_TITLE` で上書き可）。

### ブランドの独立プラグイン化と色レイヤー（2026-10-28、同日追記）

ユーザー指示（「全部プラグインにしておくのがいい。デフォルトで omp に」
「色も同様」）を受け、ブランドを `@omp/client-settings` から独立した
`@omp/client-brand` へ分離した（本家の ui-brand-official と同じ役割分担）。
ホストのロスターは brand→settings の順で両 overlay を既定で追加する
（roster.ts の OVERLAY_PACKAGES）。外せば素の DSH ブランドに戻る、という
意味でこれが本フォークの「プロファイル」単位になる。

色はコンポーネント側に直書きせず、ui-theme の `ctx.theme.overrideTokens`
（トークン上書きレイヤー）で `--dsw-alias-brand-primary` 等に OMP の
TUI アクセント #febc38 を重ねる。プラグインを外せばレイヤーごと消える。
ライト側の brand-text だけ同系の濃い金 #a66e00（#febc38 は白地で読めない
ための調整）。タイトルは従来どおりビルド変数（プロファイル的設定）で、
ロゴだけが本質的にコンポーネント＝プラグインを要する、という切り分け。
favicon は本家と同じ単色（#000/#fff）扱いのまま（ブランド色は画面内のみ）。

### WEB バッジ・全面アクセント・Preview 除去（2026-10-28、同日追記）

ユーザーの再指示3点を実施。(1) バッジ文言を HARNESS から **WEB** へ
（OMP 自体がハーネスであり、バッジは製品でなく面を名乗るべき、という
ユーザーの指摘）。タイトルとマニフェスト名も OMP Web に統一。
(2) アクセントの全面置換：送信ボタンが brand-primary-new-color
（ライトではリテラルの青）→ deepseek スケール参照の複合だったため、
個別表面を追わず **静的スケール自体を金へ再配色**（50〜900＋700-delete、
blue-950 は deep-diving 混色の相方として温色化、文書選択色もエイリアス
で金に）。リンク・info ボタン・business 状態・バブル・サイドバーの
アクセントはスケール参照経由で一括して追従する。ライト側の濃い段
（500 相当）は白地での可読性のため #a66e00 に深化、ダーク側は鮮やかな
金で統一。実測：送信ボタンはライト rgb(166,110,0)／ダーク rgb(254,196,74)。
(3) ヒーローの Preview バッジ除去：差し込み口（スロット・設定・トークン）
が存在しない唯一の面のため、ブランドプラグインの CSS で生成クラス名の
サフィックス（`_previewBadge`、ビルド間で安定）に対する display:none を
採用。DSH がクラス名を変更したら規則は静かに無効化されバッジが戻るだけ
で、他は壊れない劣化方式。自動追従（週次 bump）でもこの方式は維持される。
