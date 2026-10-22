# dsh-mise

用 mise 管理本机多语言运行时的 DeepSeek Harness 插件：设置页看已装 / 可用版本，按目录（`.mise.toml` 驱动）安装、切换、卸载，并给 agent 暴露九个工具。

- **Host 半**（`src/index.ts` + `src/mise.ts`，编到 `dist/`）：所有 `mise` 调用、JSON 解析、写入闸门，以及插件自己的 `/mise` RPC 通道上的一组端点。
- **Client 半**（`src/client.ts`，编到 `dist/client.js`）：注册在 `settings.section` 上一个「mise」页（order 48），数据全部走已认证的 `/mise` RPC 通道，不自建 HTTP 路由。

源码是 TypeScript，Harness 载入的是编译产物：`package.json` 的 `main` / `exports` 指向 `dist/`，主机侧只 `import` 纯 ESM JavaScript，浏览器侧只拿到单文件 bundle，所以运行时不带 TS 加载器、也不依赖任何 `@deepseek-ai/*` 运行时包。

## 装了什么

| 能力 | 位置 |
|---|---|
| 一张表看全部：当前生效 / 已装几个版本 / PATH 命中的那份 | 设置 → mise 的「工具链」表；数据来自 `mise_status` + `mise_system` |
| 镜像自带的工具链折叠成一行 | 表下一行「系统自带 · N」，点开是名字 / 版本 / 路径（只读）；默认收起 |
| 装了版本就能下钻管理 | 该行工具名前的 `▸` 展开版本子表：每行一个版本，带状态、安装路径、启用 / 卸载；镜像自带的那份也在里面，标 `系统`、只读 |
| 已装版本 / 可用远程版本 / latest | 行内「已装」写 `2 个版本` 这样的个数，展开子表看是哪几个；远程版本走顶部搜索框，或 `mise_versions` |
| 版本号上有更新提示 | 表里「当前」列的版本号后面跟一个虚线小标 `↑1.8.2`（有新版本时才有），悬停给出当前版本与配置要求，点它直接打开该工具的版本列表；数据来自 `mise/updates` → `mise outdated --inactive --bump --json` |
| 配置要求但未安装的版本（会直接报错的那些） | 表里该行「当前」列标「未安装」，行尾给「安装 x.y.z」，表头给「按配置安装全部」 |
| 安装 `tool@version` | 面板「安装」按钮；`mise_install` |
| 切换版本（写项目 `mise.toml`） | 面板「启用」；`mise_use`（工具仍可 `scope=global`） |
| 卸载某个已装版本 | 面板版本行上的「卸载」（点两次确认）；`mise_uninstall` |
| 一个框搜索 | 输入工具名（node）直接列可安装版本；输入 `工具名@前缀`（pnpm@12）只列该前缀下的版本；输入用途（javascript runtime）自动退回 registry 搜索 |
| 安装结果可信 | `mise_install` 的 `installed` 是从 mise 自己的 `✓ tool@version` 行解析出来的真实安装结果，请求放在 `requested`；版本不存在时 `ok:false` 且 `installed: []`，不会把请求当结果回报 |
| 状态里带激活信息 | `mise_status` 的 `activation` 给出 shims 目录与当前可用的命令，agent 装完能判断 shell 里是否直接可用 |
| 安装/切换/清理时看实时进度 | 面板里的实时输出框（标题 + 已用秒数 + mise 自己的输出，每 0.7s 刷新） |
| 清理没被任何配置引用的版本（先预览再执行） | `mise_prune`（默认 dryRun）；面板里只标 `未使用`，逐个卸载 |
| registry 搜工具名 | 面板搜索框（只读） |

## agent 工具

九个工具，覆盖"看清现状 → 找版本 → 装 → 钉住 → 清理"整条链路：

| 工具 | 作用 |
|---|---|
| `mise_status` | mise 版本/路径、目标目录、目录链上的配置、在效版本、缺失版本，以及命令行激活状态（装完能不能在 shell 里直接用） |
| `mise_versions` | 给 `tool` 看已装/在效/latest/远程版本；给 `query` 搜 registry |
| `mise_system` | 只读扫描 PATH 上的开发工具：命中的路径与版本、mise 是否另有受管版本（`fromMise` / `managed`），以及跳过 mise 自己的 shim / 安装目录后镜像自带那份（`systemPath` / `systemVersion`） |
| `mise_install` | 装 `tool@version`；`background: true` 时立刻返回任务 id，用 `mise_progress` 轮询 |
| `mise_use` | 写进项目 `mise.toml` 或全局配置（未装会先装） |
| `mise_prune` | 清理没人用的版本，默认 `dryRun: true` 只预览 |
| `mise_uninstall` | 删掉指定版本 |
| `mise_activate` | 开关命令行激活（把 shims 放宿主 PATH 最前），返回新的激活快照 |
| `mise_progress` | 读一条写入命令的实时进度：在跑什么、多久、最近的输出行、是否结束；结束后附带完整结果 |

进度为什么是"任务 + 轮询"：工具调用是请求/响应，没法流式推。所以每次写入都记成一条任务，面板轮询正在跑的那条，agent 则用 `background: true` 起步、再用 `mise_progress` 按 id 取自己的那条（不带 id 就是最近一次运行，包括面板里点的）。大工具不再把一次调用卡满 15 分钟。

## 配置

行配置在 `cordis.patch.yml`（装好后也可由插件设置表单写）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `miseBin` | `''` | 留空则依次探测：PATH 上的 `mise` → `~/.local/bin/mise` → `/usr/local/bin/mise` → `/opt/homebrew/bin/mise` → `~/.local/share/mise/bin/mise`。GUI 拉起的 Harness 继承的 PATH 里通常没有 `~/.local/bin`，所以按序探测而不是直接报「找不到」 |
| `cwd` | `''` | 面板与工具的默认目录；留空 = Host 进程 cwd。面板不提供切换控件，改目录改这里（面板顶部会显示当前用的是哪个） |
| `env` | `{}` | 每个 mise 子进程的额外环境变量，如 `MISE_DATA_DIR` / `MISE_TRUSTED_CONFIG_PATHS` |
| `timeoutMs` | `20000` | 读命令（`ls` / `ls-remote` / `registry`）超时 |
| `longTimeoutMs` | `900000` | install / use / prune 超时 |
| `writeMode` | `auto` | `readonly`：面板与工具都拒绝写入；`ask`：每次写入工具调用走 DSH 审批通道（没有审批方时**拒绝**，安全方向）；`auto`：直接执行 |
| `remoteLimit` | `30` | 一次返回多少个远程版本 |
| `registryLimit` | `40` | registry 搜索返回条数 |
| `activate` | `true` | 加载时把 `<data dir>/shims` 放到宿主 PATH 最前，让工具命令在任何 shell 里都能用；`false` 则不动 PATH（面板开关只影响本次进程） |

`ask` 依赖 DSH 的审批通道；本 profile 的审批被设为「从不询问」，所以这里取 `auto`，要收紧改 `ask` 或 `readonly`。

## 写入边界

- 只动 mise 自己的 install 目录与配置文件；`prune` 固定带 `--tools`，不碰 mise 的 config 追踪表。
- 卸载只接受显式 `tool@version`，空参数直接报 `mise/bad-request`；仍被 `mise.toml` 引用的版本也能卸（那是你的选择，下一个 `mise install` 会装回来），只想清无引用的用 `prune`。
- **卸载 = 删文件 + 删掉配置里指向它的那条请求**（2026-10-22 起）。`mise uninstall` 只删文件，留着的请求会让那一行以「未安装」的样子继续挂在表里——这正是「卸载了怎么还在列表里」。所以卸载之后立刻补一步 `mise unuse`：`--path` 指向 `mise ls --json` 里 `source.path` 报出的那个文件（绝不猜「第一个加载的配置」），`--no-prune` 保证只改配置不删别的版本；还有别的版本装着时只删字面匹配该版本的那条，一条不剩时把该文件里这个工具的请求全部删掉。答案里的 `forgot` 就是被删掉的请求清单。
- 反过来，一条**从来没有安装**过的请求（`mise.toml` 里写了但没装过，或早先卸载留下的）在面板上是一个「未安装」行，行内「从配置移除」= 单独的 `mise unuse`，同样只认明确路径。

- 真 prune 前一定先跑一次 dry run，返回的 `removed` 就是那次预览里列出的版本，不是猜的。
- 面板的写按钮 = 用户点击，所以不经审批；agent 的写工具走 `writeMode`。
- 环境合成：子进程继承 Host 环境，再叠 `MISE_YES=1`、`NO_COLOR=1`、`TERM=dumb` 与 `env`，输出是纯文本，不携带光标控制。
- 不设 `MISE_AUTO_INSTALL=true`：install 只发生在显式调用时。

## 文件

```
src/index.ts       Host 半：apply / 九个工具 / /mise 端点 / writeMode 闸门
src/mise.ts        mise 命令层：探测 binary、spawn、JSON 解析、prune 解析
src/client.ts      Client 半：settings.section 页面（纯 React，无 Harness 包依赖）
dist/*.js|*.d.ts   构建产物（Harness 实际载入的就是这里；随仓库保留）
test/host.ts       假 ctx 冒烟测试：跑的是 dist/index.js
test/client.ts     假 window/document + 真 React 渲染：跑的是 dist/client.js
tsconfig.json      编译配置（strict、NodeNext、声明文件）
tsconfig.test.json 测试与源码一起做类型检查（noEmit）
cordis.patch.yml   一行 insert + 默认配置
locale/{en,zh}.json  Plugin Manager / 设置里显示的标题与描述
icon.svg           图标（自绘）
.agent-check/motion 动效的离线核验：从 dist 抽插件自己的 CSS 拼一张静态页，用 headless Chromium 查转场（见「动效」一节）
```

## 构建与自测

```sh
npm install          # 只装开发期依赖：typescript、@types/*、@deepseek-ai 类型包、react（测试渲染用）
npm run build        # tsc -p tsconfig.json → dist/，再跑 scripts/finish-client.mjs
npm run typecheck    # 源码 + 测试一起检查（不产出文件；测试 import 的是 dist/，所以要先 build）
npm test             # 自动先 build（pretest），再跑 test/host.ts 与 test/client.ts
npm run check        # build + typecheck + 两套测试，一条命令的交付闸门
npm run legacy:drop  # 宿主重启后删掉根目录遗留的 index.js / mise.js / client.js
```

### 构建了，但浏览器还是旧代码

宿主不读 `dist/`——它在**启动时**按当时的 `package.json` 的 `exports["./client"]` 解析出这份 bundle 的绝对路径，之后只 `stat` 那一个文件（`dsh-client-hmr` 每 500 ms 一次），内容变了才 republish 新 rev 给浏览器。于是：

- `exports` 若在宿主启动**之后**才改（本插件 2026-10-22 06:55 才从仓库根的 `client.js` 切到 `dist/client.js`），运行中的宿主仍盯着旧路径；此后再怎么 `npm run build`，它 stat 的文件没变，浏览器拿到的永远是旧字节，页面表现就像「改动没生效」。
- 临时办法：把刚构建的产物同步到宿主盯着的那份（`cp dist/client.js client.js`），半秒内 rev 就变、浏览器经 SSE 热替换。
- 彻底办法：重启 `dsh web`，或在 插件管理 里关掉再打开这个插件，让它按现在的 `exports` 重新解析；之后根目录的 `client.js` / `index.js` / `mise.js`（TS 之前的遗留产物）就是纯重复，跑一次 `npm run legacy:drop` 删掉，`dist/` 是唯一真源（脚本会先确认 `package.json` 已经指向 `dist/`，再删）。TS 迁移时留的 `.legacy-backup/` 备份已在 2026-10-22 删除：其中 `index.js` / `mise.js` 与根目录那两份逐字节相同，`client.js` / `host.mjs` 已被 `src/` 与 `test/host.ts` 取代。
- 构建脚本会顺手把 `dist/client.js` `cp` 到根目录那份 `client.js`（只要它还在），所以重启前每次 `npm run build` 都能让运行中的宿主拿到新字节；`legacy:drop` 之后这一步自动失效。
- 自查手段：带登录 cookie `curl /plugins/events`，看 `@sovlookup/dsh-mise` 那条的 `rev`，再与 `sha1(mtimeMs, ctimeMs, size)` 的 12 位前缀对照；`touch` 候选文件看 rev 变不变，就知道宿主盯的是哪一个。

开发期依赖只提供**类型**，运行时代码里没有一条 `import` 指向 `@deepseek-ai/*`：

- `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-client-connection`（+ 传递的 `dsh-llm`）给 `Context`、`ToolDefinition`、`ToolOutputDefinition`、`PreToolDecision`、`HostConnectionHandle` 这些接缝提供真实声明，版本钉在与运行中的 Harness 相同的 `0.2.1-rc.2`（cordis `4.0.5`）。
- Client 半反过来：它刻意不引 Harness 包，`window.__ModuleLoader__`、工厂的 `require`、`ctx.slots` / `ctx.locale` / `ctx.connection` 都在文件里就地声明，所以 Harness 升级不会因为某个被删掉的导出把这一页打挂。
- `react` / `react-test-renderer` 只为 `test/client.ts` 真的把页面渲染一遍。

构建产物要一起提交：Harness 不会替你编译，`dist/` 缺失就是插件加载失败。

重新安装 / 更新：

```sh
dsh plugin --profile web add github:SOVLOOKUP/dsh-mise     # 本地改动则用 dsh plugin --profile web add /workspace/research/dsh-mise
```

插件代码改动要 `npm run build` 后再重启 Harness 才载入新模块（`package.json` 的入口与浏览器 bundle 都是 `dist/` 里的文件）；只改 `cordis.patch.yml` 的配置由 HMR 即时重组。

## 激活：让工具命令真的能用

插件加载时把 `<data dir>/shims` 放到宿主进程 PATH 的最前面（等价于 `mise activate` 的核心效果，但不需要改 shell 配置）。之后 Host 派生的任何 shell 里 `bun`、以及以后用 mise 装的工具，都能直接调用，且是"按目录切版本"的：项目目录里用 `mise.toml` 指的那版，没有受管版本时自动落回系统那份。

- 生效范围：本 Host 进程及其子进程。外部终端不受影响。
- 谁赢：mise 有受管版本就用它；没有就用系统那份（shims 会回落），所以不会把命令弄没。
- 面板上不再有开关（顶部那块按需求去掉了）：要临时改这一进程的状态用工具 `mise_activate`，或把配置项 `activate` 改成 `false` 再重启；下次启动是否自动开启由 `activate` 决定（默认 `true`）。

## 持久化：mise 的状态不放 /tmp

这个镜像把 `XDG_CONFIG_HOME`、`XDG_DATA_HOME` 指到 `/tmp`，而 `/tmp` 重启即清空 —— mise 的全局配置（`<config>/mise/config.toml`）和安装目录本来都会落在那里。插件每次加载时执行一次修正：

- 持久副本放在 `$HOME` 下：`~/.config/mise`、`~/.local/share/mise`（本机即 `/workspace/...`）；
- 把 `/tmp` 那三个默认路径改成指向它们的符号链接（目录为空或不存在时才动，非空则只在面板里提示 `drift`，绝不删数据）；
- 因此裸 `mise`（不带任何 `MISE_*` 环境变量）和面板看到的是同一份状态。

配置项里的 `env.MISE_DATA_DIR` 与这条链接指向同一个目录，两者一致。

## 系统里已装的工具（只读）

面板会扫 PATH 上常见的 18 个工具名（node / npm / pnpm / yarn / bun / deno / corepack / python3 / python / go / rustc / cargo / java / ruby / php / uv / poetry / jq），拿到命中的路径与版本（版本只留数字：各工具的 `--version` 花样不同，`Python 3.13.5` / `jq-1.7` / `v24.22.0` / `go version go1.22.2 …` 一律取其中的版本号，不把程序名和 `v` 带进表格）。只读，不做任何改变；结果缓存 60 秒。命令扫两遍：第一遍是 PATH 上先命中的那个（开了激活就是 mise 的 shim，版本探不出来也不去探——它会答 mise 自己的横幅），第二遍跳过 mise 的 shim 与安装目录，拿到镜像真正自带的那份路径与版本。两遍都要，否则 shims 排在前面时「系统那份是哪一版」就永远查不到。

**扫描结果只用来补「这一行在 PATH 上是谁」，不额外造行**：只有当某个名字本来就在本目录的 mise 配置里（`active` / `installed` / `missing` 任一处有它）时，才在「当前」列落一个回落版本、并在版本子表里列出镜像自带的那份（标 `系统`，只读）。这个标记不再挂在工具行上（2026-10-22 按用户要求）：是 mise 那份还是镜像那份，是**某个版本**的事实，就写在那一行版本旁边。镜像里自带、但和本项目无关的命令（`corepack`、`python3` 这类）不会单独成行——它们既不是项目工具，`mise ls-remote` 也查不到（`corepack` 根本不在 registry 里，报 `corepack not found in mise tool registry`），列出来只会是一个点开永远 0 个版本、也没法装的行。既然行只来自 mise，一个什么都没配、也没装受管版本的目录就是一张空表，这时显示一句「本目录的 mise 配置里还没有任何工具」，而不是一直挂在「读取中…」上——出口是表上方那个搜索框。

**它们不消失，只是折起来**：表下面一行「系统自带 · N」（N = 扫描到、但既不在 mise 配置里也不是 mise 装的数量），点开是名字 / 版本 / 路径三列，默认收起。名字可点，点了打开该工具的版本列表（和顶部搜索框输工具名是同一个动作）——`corepack` 这类不在 registry 的命令会得到「没有可显示的版本」，这也是它不该占一行正表的原因。折叠状态只存在这一次页面里，不写 localStorage：它不是偏好，只是「看一眼」的动作。

这样存在的原因：mise 没有「接管已有二进制」的功能，预装的东西它既看不见也管不了（`mise which pnpm` 会直接说 `pnpm is not a mise bin`）。旧写法 `pnpm = "system"` 在 2026.10.17 已废弃（`WARN deprecated [system_tool_version]`，提示改用 `MISE_DISABLE_TOOLS`），而且它不会把系统那份接进来——`mise which` 只会报 `No executable found for configured tool`。所以面板只能诚实标出「当前是系统那份」，并说明「想管就得装一份受管版本」（agent 工具 `mise_system` 仍会返回完整的 18 个候选扫描结果，需要「机器上到底有什么」时问它）。

受管版本要真的顶掉系统那份，前提是 mise 的 shims 排在系统目录之前（`mise activate`，或把 `<data dir>/shims` 加到 PATH 前面）；实测 shims 在前时项目内命中的是受管版本，不在任何 mise 配置覆盖的目录里时则会落回系统那份，不会让命令凭空消失。

## 一个工具多个版本：版本子表

正表的「已装」列只写个数：**`2 个版本`**，不是一个光秃秃的数字，也不列是哪几个。哪几个、各自什么状态、装在哪、能对它做什么，全在子表里：

- 触发：该行工具名前的 `▸`（悬停提示「展开版本子表 · jq」），再点一次 `▾` 收起。**只要这一行知道任何一个版本就有这个箭头**（盘上 1 个也算；配置要了但没装的也算；镜像自带的那份也算）——行里已经不写版本了，子表是唯一能看到「是哪个版本」的地方，路径和卸载也在里面。
- **正表一行按钮都没有**（2026-10-22 按用户要求）：面板上的每个动作都是对着某个版本做的（装它、启用它、卸它），所以动作只在子表里出现，行本身只读。唯一的例外是表头上方那颗「按配置安装全部」——它一次处理所有缺失版本，不属于任何一行。
- 子表内容：一行一个版本，四列 `版本 | 状态 | 路径 | 操作`。已装的一行状态是 `生效` / `未使用`（未使用来自清理预览），路径是 mise 的安装目录（`installPath`，超长省略号、悬停看全文），操作只有两个：`启用`（`mise use tool@version` 写本目录 `mise.toml`，生效中的版本没有这一项）和「卸载 → 确认卸载」两步。
- 配置要了、盘上没有的版本也在这张表里（`未安装` chip，路径列是 `—`）：操作是 `安装 1.8.2`（`mise install`）和 `从配置移除`（`mise unuse`，删掉声明它的那一条请求；悬停「路径」列的 `—` 看是哪个配置文件要的）。这条以前在行内，正表去掉操作列后搬到这里——不搬就没有入口了，因为这种行没有任何已装版本。
- 四列宽度是定死的（`76px-0.7fr / 92px / 2fr / 176px`）：`.dsmise-sub-row` 每一行各是一个 grid，`auto` 列会按各自内容算宽度，整张表会参差不齐。
- 为什么只留个数（2026-10-22 按用户要求；单位 `个版本` 是后补的）：一列 chip 会把每一行撑到它最重那个工具的高度，而绝大多数行只有一个版本、`已装` 和 `当前` 是同一个版本号——重复的是最宽的那部分。个数让整列对齐、行高一致，代价是「具体是哪几个」要多一次点击。但光一个数字读不出它是什么：`2` 挂在 `已装` 表头下，眼睛会先把它当成某种数量的代号，所以数字后面带上单位（`2 个版本` / `1 个版本`，英文 `2 versions` / `1 version`，0 是淡色 `0 个版本`），列宽也跟着从 56px 放到 84px。
- 因此行内不再有版本 chip，也就不再有点 chip 打开版本列表这条路：要装新版本直接在顶部搜索框输工具名（那里是版本列表，每个远程版本都有「安装」）。子表里也不再放「远程版本」按钮——它回答的是「有哪些版本可装」，和这一列（盘上已有的版本）不是同一个问题。
- 镜像自带的那份也占一行：`版本 | 系统（虚线 chip）| 路径 |` 空操作列。它不能「启用」也不能「卸载」——mise 没有接管已有二进制的功能，所以这一行的操作列就是空的，不摆一个按不了或者按了会被拒的按钮。项目里没装受管版本时，这行就是「`jq` 到底跑的是哪一版」的答案；装了受管版本时，它在同一张表里排在下面，一眼能看出自己装的和镜像给的不是同一个版本。
- 展开状态跟着页面走，不落盘；刷新（重新读状态）不会把它折回去，因为它是同一棵树里的状态。

## 表头不再有「清理」

`清理 N` 按钮去掉了（2026-10-22 按用户要求）。剩下的分工：

- **读还在**：每次刷新仍跑一次 `mise prune --tools --dry-run`，因为 `未使用` 这个判断只有 mise 自己给得出来，子表的「状态」列靠它。它是个纯读（dry run），几毫秒。
- **写不在面板里**：批量真删改的是 mise 的安装目录，而这个按钮原来就跟「按配置安装全部」并排挂在表格正上方——扫描列表时最容易误点的地方。要批量清理用 agent 工具 `mise_prune`（默认 `dryRun: true`，先看再删），面板里按版本卸载就去子表点「卸载」，两步确认、只动那一个版本。
- 之所以留着 `未使用` 标记而不同时删掉这个读：没有它，「哪个版本是可以扔的」得自己比对配置和安装目录。

## 一个搜索框

安装区只有一个输入框，位置在工具表格上方，没有标题行也没有说明行（输入的三种含义写在占位符里：`工具名或用途，如 node / pnpm@12 / javascript runtime`）。输入工具名就直接是该工具的版本列表；输入 `工具名@前缀`（`pnpm@12`）就是 mise 自己的写法（等价 `mise ls-remote pnpm@12`，实测收窄到 12.0.0–12.14.0 共 30 个），`@` 后半截作为 `prefix` 传给 Host 的 `versions` 端点，工具名仍旧只取前一半——「已装」列答的是这个工具的版本，前缀只筛远程列表。只有版本形状的后缀才算前缀（必须数字开头），所以 `npm:@scope/pkg` 这类自带 `@` 的工具名、以及还没打完的 `node@` 都不会被拆开。收窄过的列表在卡片头上挂一枚可点的 `@12` 药丸（悬停「只看这个前缀的版本，点一下看全部」）：点它按整工具重列，否则窄列表就是个死胡同。名字对不上任何工具时（mise 对未知工具返回空列表而不是报错，所以判据是「空」而非「异常」）自动把它当用途去 registry 搜，结果是「registry 里的匹配」，点「查版本」进入版本列表。全都搜不到就只留一句提示，不留空列表。版本卡片里既没有第二个筛选框，也没有「刷新」：装完或启用后卡片自己重读一次，卡片头上只剩一个「收起」。

## 安装进度

通道是一次请求一次响应，推不了流：宿主把当前写命令的输出留在内存里（`startProgress` / `tracked`），面板在写操作进行时每 0.7 秒调 `progress` 取一次，取到的是去掉 ANSI 转义之后的最近若干行。

关键一点是 `\r` 不能被当成换行。mise 每秒好几次用 `\r` 重画同一行状态（进度条、`downloading 3.0/36.6 MB`），如果按字面 split 成多行，面板就会刷屏。所以每一行先算一个「键」——去掉数字、小数点、`█░▓▒` 这些会变的部分和多余空白，剩下的才是这行的身份；同键的新行就地替换旧行，位置不变。行长上限 24 条，跨 chunk 的半个行会先攒着等分隔符。结果是安装过程中那一块始终只有几行，数字在原地跳动。写命令结束即停止轮询，结果显示在常规提示区。install / use / uninstall / prune 都走这条路径，agent 调用对应工具时同样记录。

## 有新版本的小提示

版本号后面的虚线小标 `↑1.8.2` 只在 mise 说「有更新的版本」时出现，标的是最新那版的号，位置只有一个：「当前」列里**正在生效**的那个版本号右边（也就是说，只有能升级的那一版才配得上它）。悬停给出完整一句：最新版、当前生效的版本、配置要的版本（有配置的话），以及「点击查看可安装的版本」；点它直接打开这个工具的版本列表，那里每个远程版本都有「安装」。

几处判断：

- **比较交给 mise，不自己写**：`mise outdated --inactive --bump --json` 才知道每个工具怎么排版本（`1.10` > `1.9`，`temurin-21.0.1+12` 不是数字元组），手写字符串或点分段比较一定会在某些工具上错。
- **带 `--bump`**：不带时只和「配置允许的最新版」比，配置里钉死 `jq = "1.8.2"` 就永远不算过期，提示会一直不出现——那正好是用户最想知道的情形。带上之后比的是「全局最新发布」，配置范围写进悬停说明里，不偷偷替用户改配置。
- **带 `--inactive`**：没被任何配置请求、但已经装着的工具也要检查，否则表里有它、提示却没有。
- **只有生效那一版能升级，判决不成立就整条丢掉**：`--inactive` 让 mise 把「盘上留着、没在用」的旧版也拿来比。一个工具可以同时握着两版：`bun 1.4.0`（未使用）加生效中的 `1.4.3`，mise 回的是 `current: 1.4.0, latest: 1.4.3`——这是对**旧那版**的判决，而旧版不会「升级」（对它来说答案是卸载，子表里那颗按钮就是）。所以这条判决的 `current` 必须等于这个工具当前生效的版本（`ls --current --json` 报的那一版）才画，否则整条丢掉：既不画在「当前」列（那会变成劝人升级到一个已经装着的版本 `1.4.3 ↑1.4.3`），也不画在子表里旧版那一行（那是把同一句噪音挪个位置，2026-10-22 用户第二次报「bun 已经安装最新版本了，1.4.0 就不需要提示升级了」）。同理，什么都没生效的工具没有可升级的版本号，也不画。
- **`current` 为空的行丢掉**：那是「配置要、但什么都没装」的情况，表里已经标「未安装」并给了安装按钮，没有版本号可以挂提示；`current === latest` 的行也丢掉（mise 一般不会给，给了也不是提示）。
- **它是独立一次读，不挡表格**：这是唯一会出网的读（每个工具去问自己的发布源）。面板 `刷新` 时和 `status` / `system` / 清理预览并行发出，回来才把提示补上；失败（离线、发布源不通）就当没有提示，不弹错、不画一个假的「已是最新」。
- 小标是虚线描边：虚线读起来是「附注」，不会和 `未安装` / `未使用` 这类状态混淆。

## 导航行图标

`settings.section` 的注册契约只有 id / 顺序 / 文字，没有图标位；DSH 设置外壳按 section id 写死映射，不认识的 id 一律画通用齿轮。因此导航行里的图标由 label 自己画：`label` 返回一个 React 节点（外壳直接渲染它），节点里是平台图标集中的 `IconCodeOutlineMedium`（16px，与其它行齿轮同尺寸同网格），并在 layout effect 里把宿主那个齿轮 `display:none` 掉。这套做法与 `dsh-vaultwarden` 相同。平台图标取不到时退回手绘的双箭头 SVG，不会报错。想换字形只改 `platformIcon()` 里那一个导出名即可（可选：Code / WorkspaceTree / SlidersTwo / Gauge / Inspect / Skill）。

## 动效

面板是一层普通 DOM 加一份注入的 CSS，所以动效也只有 CSS：没有动画库，没有 JS 逐帧，只用 `transform` / `opacity` / 一处 `height`。

- **曲线和时长**：宿主主题里没有任何缓动或时长 token（它的 CSS 里一条 `cubic-bezier` 都没有），所以这页自己定一套，挂在 `.dsmise` 上：`--dsmise-ease-out: cubic-bezier(0.23,1,0.32,1)`（进 / 出）、`--dsmise-ease-in-out: cubic-bezier(0.77,0,0.175,1)`（屏内移动）、`--dsmise-fast: 120ms`、`--dsmise-base: 180ms`、`--dsmise-unfold: 200ms`、`--dsmise-collapse: 220ms`。最后一个同时是 JS 里的 `COLLAPSE_MS`：CSS 负责动画，它只负责「等它折完再从树里摘掉」。浏览器内置的 `ease-out` 在 200ms 这个量级太软，读不出「有意图」。
- **整页进场**：数据读完之前那儿只有一行 `读取中…`，读完是一整屏表格——同一帧把两屏内容怼上来是跳变。所以 `.dsmise > *` 的每一块各自 `opacity 0→1` + `translateY(4px)→0`，180ms，第二个大块（搜索框下面那张表）延迟 50ms。它是**挂载动画**：刷新是同一批节点重渲染，不会重播。
- **折叠（版本子表 / 系统自带）**：唯一用 `height` 的地方——手风琴没有 `transform` 的等价物。JS 先量 `scrollHeight`（元素被裁到 0 高时它仍然回答内容高度），把像素高度交给 wrapper 让转场从那儿走，到位后放回 `auto`，这样折子开着的时候新冒出来的版本行也撑得开；收起时先把当前高度钉住、下一帧再归零，折完 220ms 才卸载——所以下面那一行是被推回去的，不是瞬移。**没有用 `0fr → 1fr` 那套纯 CSS 技巧**：它要求栅格高度确定，而这一页的高度全由内容撑；另外 `padding` 会变成行的最小内容高度，折起来时会漏出 12px 一条边（在 headless 里量到过）。
- **箭头**：`▸` 画成一个 SVG，展开时 `rotate(90deg)`，160ms。字形换成 `▾` 是没法缓动的。
- **提示条 / 安装进度块**：它们就是 `.dsmise > *`，进场走同一条 4px 位移；进度块左边多一个 6px 呼吸点（`opacity` 1→.25，1.4s），因为日志还没打出字的时候，「在跑」和「卡死」长得一模一样。
- **按钮**：hover 和 `kind` 变色 120ms；按下 `scale(.97)` 100ms——这是「按到了」的反馈，不是装饰（命令要等一会儿才回话）。按压不做 hover 位移（触屏会误触发）。
- **`prefers-reduced-motion`**：不是全部关掉，而是留淡入、去掉位移——进场变成 120ms 纯 `opacity`，折叠、箭头、按压、呼吸点一律瞬时。
- 折着的时候内容 `visibility: hidden` + `pointer-events: none`：折到一半的按钮既点不到、也不会被 tab 到。

结构性的部分（类名、`is-open`、折完就卸载）在 `test/client.ts` 里；「这条曲线好不好看」渲染测试测不出来，见下面「验证状态」那条的实际验证方式。

## 自测

```sh
npm test         # 构建 + 两套冒烟测试
node --experimental-strip-types test/host.ts     # 只跑 Host 半（需先 npm run build）
node --experimental-strip-types test/client.ts   # 只跑 Client 半（需先 npm run build）
```

- `test/host.ts`：假 ctx（`inject` / `effect` / `on` / `tools.register` / `connection.rpc.handle`），验通道挂载、方法矩阵、readonly 拒绝、审批闸门、进度行合并、后台任务轮询、`updates` 的筛选。
- `test/client.ts`：假 `window.__ModuleLoader__` 与 `document`，模块工厂拿到真的 React，注册进 `settings.section` 之后用 `react-test-renderer` 真的渲染一遍——断言它只走 `/mise` 通道、首读是 `mise/status`、并且把宿主返回的数据画进表格（`jq` / `1.7.1`），以及有更新时版本号后面那个 `↑最新版`。

真实链路（面板 404/405 那类问题只能这样抓到）：把 profile 复制一份到临时 `DSH_HOME`、`node_modules` 指回原处，起第二个实例在别的端口，然后用它的 `?token=` 登录 URL 拿 cookie，对 `/mise/status` 发 `/api` 同样的信封，再在浏览器里点开 设置 → mise 看渲染。

## 自测不造替身二进制

`test/host.ts` 不用假的 mise 可执行脚本，也不 stub `spawn`：需要「已知答案」的地方，把决定抽成纯函数（`narrowOutdated`、`planUnuse`）直接喂一段 `mise` 的输出原文；需要真跑的地方就用真 mise（`cwd: /tmp`，只读端点 + 一个注定失败的 `install` 用来验证后台任务记录），既不装东西也不改任何 `mise.toml`。想测「
 帧不该变成 12 行」这种只有下载时才出现的行为，靠真机安装采样（见下面的验证状态），不在测试里伪装。

## 验证状态

- Host 层：用假 ctx 跑通全部端点（status / versions / registry / install / use / prune 预览与真跑 / readonly 拒绝 / 未知端点），并用真实 mise 2026.10.17 跑过 `jq` / `node` 的安装、切换、清理。
- 线上注册：九个工具在 Tool 目录里可见；`settings.section` 里出现 `dsh-mise / mise / order 48 / active`，说明浏览器已加载并执行了 client 模块。
- 激活：真机在干净 `bash -c` 里 `command -v bun` → `/workspace/.local/share/mise/shims/bun`、`bun --version` → 1.4.3，而 `node`/`npm`/`pnpm` 仍是 `/usr/local/bin`（没被劫持）；面板卡片实测 on → 关闭 → off → 开启 → on。删掉三条 /tmp 符号链接再加载插件，链接自动重建、裸 `mise ls` 又能看到 bun。
- 系统扫描：真机验过两种标记——同样的名字由 mise 装上并排在 PATH 前时显示「受管」（2026-10-22 按用户要求去掉了这个 chip：是 mise 那份属于正常情况，标出来只是噪音），落回镜像自带那份时给出它的版本（2026-10-22 起 `系统` 这个标记从工具行搬进版本子表，见「版本子表」一节）。顺带修掉一个自查出来的 bug：`mise ls --installed` 少了 `--json` 会输出表格，导致受管版本判断恒为 0。2026-10-22 起扫描只给本目录配置里已有的工具补标记，`corepack` 这类「镜像里有、项目里没有」的命令不再单独成行（它们不在 mise registry，点开永远是 0 个远程版本）。
- 安装进度：真机装 `bun@1.4.2`（36.6 MB）全程采样行数最大 6 行、终态 6 行，没有刷屏。真机装 `node@26.12.1` 时抓到实时行（`downloading 3.0/62.9 MB · 116 kB/s`），面板标题显示 `mise install node@26.12.1 · 已用 45s`；该次安装在临时数据目录里进行，已连目录一起删除，未影响本机安装。
- 面板：顶部只有一行「工具链管理」；「刷新」搬到下面安装行、紧挨「查找」右边，一个「刷新」= 拉状态 + 扫 PATH + 跑一次清理预览（表里的 `·未使用` 标记就来自它），不需要第二下。主体第一行是唯一的输入框（没有标题行、没有说明行）+「查找」+「刷新」，接着才是表 `工具 | 当前 | 已装`（没有操作列：动作都在版本子表里），没有分区标题和说明行，表下也没有文字——未使用版本只体现在子表的 `未使用` 标记上，只有错误才出一行红字；工具行上没有标记（哪份来自镜像写进子表那一行）、工具名下面那行 PATH 路径已去掉（悬停工具名看 title）、「当前」列只留版本号（哪个配置文件要它，悬停版本号看 title；有新版在它后面跟一个虚线小标）、「已装」列写 `N 个版本`（是 0 就画一个淡色的 `0 个版本`）、「启用」（只写当前目录 `mise.toml`；DSH 的活都在 /workspace 下，项目级就够，面板不提供全局写入）；表头只在有东西可处理时出现按钮，现在只剩「按配置安装全部」（有缺失时）。输入框在表格上方：输入工具名列版本，输入用途退回 registry 搜索。写入结果的通知条能点 ✕ 关掉，成功的那条 8 秒后自己消失，失败的要读一眼才关。截图见 `assets/panel.png`。
- 卸载后清配置（2026-10-22）：`planUnuse` 用 `mise ls --json` 的三种行做单元测试——同文件里还留着别的已装版本时只删字面匹配该版本的那条（`bun@1.4.3`，`bun = "1"` 这种前缀请求留下）、一条不剩时删该文件里这个工具的整条请求、没碰的工具不动、listing 读不出来时什么都不删；`test/client.ts` 断言「未安装」行上出现「从配置移除」按钮，且点击后打的是 `mise/unuse` 且带对声明文件路径。真机侧：`mise unuse pnpm --path ~/.config/mise/config.toml --no-prune` 删掉了指向已卸载 pnpm 的悬空请求（`mise removed: pnpm from ~/.config/mise/config.toml`），配置里只剩 `bun = "1.4.3"`。
- 未验证：深浅色两套主题下的配色差异（只看了浅色）。
- 有更新提示（2026-10-22）：筛选逻辑抽成纯函数 `narrowOutdated(outdated --json 的原文)`，`test/host.ts` 直接喂三种行（落后的、`current: null` 的、已是最新的），断言只留第一条并保住 `requested`；面板侧断言 `↑1.8.2` 画在当前版本号后面、且「未安装」那种没有版本号的行不画提示；真机 `mise outdated --inactive --bump --json` 在本目录给出 `bun 1.4.2 → 1.4.3`，`updates()` 9.9 ms（mise 自己缓存了远程版本），未在浏览器里目视检查深浅色两套配色。
- 去掉「受管」chip 与子表的「远程版本」按钮（2026-10-22）：`test/client.ts` 断言树里没有 `tagMise` 却有 `tagSystem`（系统那份仍要标），并断言下钻后的子表里既没有 `remoteVersions` 也有 `uninstall` + `setProject`（两个真作用于版本的动作还在）。
- 已装只留个数 + 去掉「清理」按钮（2026-10-22）：`test/client.ts` 断言「已装」列画的是 `2, 1` 两个数字而不是 chip、预置了一条「未使用」的清理预览却断言页面上一个 `danger` 按钮都没有（按钮真的没了，标记还在），并断言每个有版本的行都能下钻、行内一个按版本按钮都不留（`uninstallHint` 计数：未下钻 0 → 下钻后 2）。同一张静态预览页重截了一次，确认数字列对齐、行高一致。
- 系统自带折叠 / 版本子表（2026-10-22）：`test/client.ts` 用真渲染点开了两处折叠——表下「系统自带 · N」展开后列出 `corepack` 的版本与 `/usr/local/bin/corepack`（且确认里面没有卸载按钮、不是一张子表），`jq` 行的 `▸` 展开后列出 1.7.1 / 1.6.0 两行、四列齐全、两个版本都能卸载，再点 `▾` 收回去；同一次渲染里断言「只有多版本行才有箭头」（`drillOpen` 按钮数 = 1）和「行内一颗按版本按钮都没有」（`uninstallHint` 计数：未下钻 0 → 下钻后 2）。另外用 react-test-renderer 的树 + 插件自己的 CSS 拼了一张静态预览页，headless Chromium 截了两态（默认态、下钻 + 展开态）目视核对列宽、省略号与箭头方向，未在真实设置页里截图。
- 顺着上一条顺手修掉两处与文档不符的实现（都是「扫描不造行」这条约定的落点）：表格把 `mise_system` 扫到的 `corepack` 之类命令也造了行——`test/client.ts` 那条断言此前靠微任务时序侥幸通过，现在真的管住了；行只来自 mise 之后，空目录会永远停在「读取中…」，补了空态文案「本目录的 mise 配置里还没有任何工具」并加了断言。
- 正表不再有「操作」列（2026-10-22 按用户要求「外面的操作不要了，有里面子表的操作就行」）：表头与每行只剩 `工具 | 当前 | 已装` 三列，行内一颗按钮都没有；`启用` / `卸载` 照旧只在版本子表里。原本挂在「未安装」行上的 `安装 x.y.z` 与 `从配置移除` 也搬进了子表——这种行没有已装版本，不搬就没有入口，所以下钻条件从「盘上有版本」放宽成「盘上有版本 / 配置要了没装 / 镜像自带那份」三者任一。表头上方唯一保留的按钮是「按配置安装全部」（用户选择保留，它是批量的，不属于任何一行）。`test/client.ts` 断言三件事：正表行内 `dsmise-btn` 数为 0、首屏树里没有 `colActions`、只缺版本的 `jq` 行下钻后子表里同时有 `install 1.8.2` 与 `dropRequest`。顺手把子表列宽从 `auto` 改成定值（每行各是一个 grid，`auto` 会按各自内容算宽度，整张表参差不齐）：用 react-test-renderer 的树拼静态页在 headless Chromium 里量过——四列宽度在所有行上都是 137 / 92 / 392 / 176，`scrollWidth === clientWidth` 无溢出，正表行高 35–37px。
- 「已装」列写单位（2026-10-22 按用户要求「应该是 x 个版本，而不是只显示数字」）：数字后面补 `个版本`（英文 `version` / `versions` 按单复数走），0 也写成淡色的 `0 个版本`；`.dsmise-tr` 第三列从 `56px` 放到 `84px`，否则 `99 个版本` 会被挤掉。`test/client.ts` 的断言从「画的是 `2, 1`」改成「画的是 `2 installedTotal, 1 installedTotalOne`」——locale 在测试里是回显 key 的桩，这样同时钉住了「数字带单位」和「单版本走单数 key」两件事。
- 更新提示只挂在生效那一版（2026-10-22 分两轮定）：第一轮用户报「我安装的就是最新版，怎么还提示升级」，真机 `mise outdated --inactive --bump --json` 给出 `pnpm current: 12.13.0, latest: 12.14.0`——盘上留着 12.13.0、生效的是 12.14.0，判决说的是旧那版，按工具名挂就画成了 `12.14.0 ↑12.14.0`；当时改成「按 `current` 找版本」，判决跑到子表里 12.13.0 那一行。第二轮用户看着 bun 再报一次（`bun 1.4.0` 未使用 + `1.4.3` 生效 + `current: 1.4.0, latest: 1.4.3`），说明换个位置只是把噪音挪走：旧版不会升级，对它的回答是卸载。现在 `tableRows` 用 `status.active` 里生效那版的号去过滤判决，`current` 对不上就整条丢掉，子表里也不画（那里挂 `UpdateBadge` 的代码一起删了）；正例仍在——生效中的 `jq 1.7.1` 落后时提示照旧画在「当前」列（`↑1.8.2` 那条断言）。`test/client.ts` 的复现改成 bun 形状（`1.4.0` 未生效 + `1.4.3` 生效 + 那条判决）：断言首屏没有 `↑1.4.3`、下钻后两版都在树里但整棵树一个 `↑` 都没有。
- 动效（2026-10-22 按用户要求「加一点好看的动画」）：渲染测试测不了曲线，所以用插件自己的 CSS 拼了一张静态页，在 headless Chromium 里查**转场对象**而不是掐表——`getAnimations()` 里有 `height/200ms`、`opacity/160ms`、箭头上的 `transform` 转场，`finish()` 之后量到折叠块 0（收起）→ 60（展开）→ 0（折回），箭头算出的矩阵是 `rotate(90deg)`；`.dsmise > *` 量到 `dsmise-rise/180ms`，第二块延迟 `0.05s`。headless 的虚拟时间会把转场冻在起点（先前几次「怎么量都是 0」就是这个原因），所以判据只能是「有没有这条转场 + 终点对不对」，中间帧得在真浏览器里看。`test/client.ts` 那条「收起后子表消失」的断言也跟着改成两步：先摘 `is-open`（`closing starts the fold`），等 300ms 再断言节点真的没了（`closing drops the sub-table once it has folded`）。
- 搜索框认 `工具名@前缀`（2026-10-22 按用户要求「提示还需要提示 pnpm@12 这种带版本号的搜法」）：占位符改成 `工具名或用途，如 node / pnpm@12 / javascript runtime`（英文同），并真的支持这个写法而不是只写在提示里——`splitSpec` 只把「数字开头的后缀」当前缀拆出来（`npm:@scope/pkg` 与半截的 `node@` 原样保留），拆出的 `prefix` 走 Host 的 `versions` 端点（那里本来就拼成 `tool@prefix` 交给 `mise ls-remote`），工具名仍是前一半；registry 回落也只用工具名查。卡片头上多一枚可点药丸 `@12`，点掉即回到整工具列表，装完/启用后的自动重读会带着原来的前缀。`test/client.ts` 造了一个 `pnpm@12` 的输入：断言 `mise/versions` 收到 `{tool:'pnpm', prefix:'12'}`、占位符是两个语言各自都带 `pnpm@12`、卡片头出现 `dsmise-prefix` 与 `@12`，再点掉药丸断言下一次调用 `prefix` 是空串。真机侧 `mise ls-remote --json pnpm@12` 返回 30 个版本（12.0.0–12.14.0）。
