/**
 * dsh-mise — Client half.
 *
 * One surface: 设置 → mise. It reads and changes the local toolchain entirely
 * through the plugin's own channel (`connection.rpc.call('/mise',
 * 'mise/<method>', { args })`), which carry the operator's authenticated
 * session; this bundle serves no HTTP route of its own and the Host owns every
 * `mise` invocation, so the browser never touches a binary.
 *
 * Styling uses only the documented `--dsw-alias-*` theme tokens, so light and
 * dark both follow the host. No Harness Client package is imported: React comes
 * from the module table and everything else is plain DOM, so a host upgrade
 * cannot break this page through a primitive it no longer ships.
 */
import type * as ReactNS from 'react'

// ── the module table ──────────────────────────────────────────────────────────
// React — like every other module this bundle might touch — arrives through the
// factory's `require`; nothing is imported at runtime, so the emitted file stays
// one self-contained script. These declarations are the only trace of the seam.

/** The module table hands modules over by id; everything but React is untrusted. */
type ModuleRequire = (id: string) => unknown

/** What the loader's `load` seam takes: this bundle's id, plus its factory. */
interface LoadedModule {
  readonly id: string
  factory(require: ModuleRequire): PluginModule
}

/** What the Host reads off the factory's return value. */
interface PluginModule {
  readonly name: string
  readonly inject: readonly string[]
  apply(ctx: ClientContext): void
}

/** The one loader member this bundle calls. */
interface ModuleLoader {
  load(module: LoadedModule): void
}

declare global {
  interface Window {
    /** dsh's client module table: one global, one `load` per bundle. */
    readonly __ModuleLoader__: ModuleLoader
  }
}

// ── the harness client seam ───────────────────────────────────────────────────
// Declared here, never imported: this plugin deliberately ships no Harness
// runtime dependency, so these interfaces list exactly the members the page
// calls, typed from how it calls them.

/** One RPC round-trip: `<channel>/<method>` carrying the `{ args }` envelope. */
interface RpcCaller {
  call(channel: string, method: string, payload: { readonly args: unknown }): Promise<unknown>
}

/** `ctx.get('connection')`: the authenticated channel this panel rides on. */
interface ConnectionService {
  readonly rpc?: RpcCaller | undefined
}

/** An `Error` that also carries the channel's stable code, as both halves send it. */
interface CodedError extends Error {
  code?: string
}

/** The translator `locale.bind` hands out for one namespace. */
type Translate<Key extends string = string> = (key: Key) => string

/** `ctx.locale`: register the dictionaries once, then bind the translator. */
interface LocaleService {
  register(
    namespace: string,
    dictionaries: { readonly zh: Readonly<Record<string, string>>; readonly en: Readonly<Record<string, string>> },
  ): void
  bind(namespace: string): Translate
}

/** One settings-section registration; `Props` is whatever `inject` returns. */
interface SettingsSectionConfig<Props> {
  readonly name: 'settings.section'
  readonly id: string
  readonly order: number
  readonly label: () => ReactNS.ReactNode
  readonly inject: () => Props
}

/** `ctx.slots`: the shell's settings-section table. */
interface SlotsService {
  inject(name: 'settings.section', register: () => void): void
  register<Props>(config: SettingsSectionConfig<Props>, render: (props: Props) => ReactNS.ReactNode): void
}

/** The `apply(ctx)` surface this page uses. */
interface ClientContext {
  effect(callback: () => void | (() => void), label: string): void
  get(name: 'connection'): ConnectionService | undefined
  readonly locale: LocaleService
  readonly slots: SlotsService
}

// ── what the channel answers ──────────────────────────────────────────────────
// The panel receives untrusted JSON, so every interface below is what one answer
// is narrowed to, field by field, before the page draws anything of it.

/** One `mise ls` row, as the Host narrows it. */
interface ToolVersionRow {
  readonly version: string
  readonly requested: string | null
  readonly installed: boolean
  readonly active: boolean
  readonly source: string | null
  readonly installPath: string | null
}

/** `mise ls --json`, keyed by tool name. */
type VersionMap = Record<string, ToolVersionRow[]>

/** A tool name plus one of its rows: what `flatten` builds for the prune bar. */
type FlattenedRow = ToolVersionRow & { readonly tool: string }

/** One remote version the picker draws. */
interface RemoteVersion {
  readonly version: string
  readonly createdAt: string | null
  readonly url: string | null
  readonly installed: boolean
  readonly active: boolean
}

/** One `tool@version` pair: a prune candidate, or something already removed. */
interface ToolVersionPair {
  readonly tool: string
  readonly version: string
}

/** The write tiers the Host offers; `readonly` refuses every mutation. */
type WriteMode = 'readonly' | 'ask' | 'auto'

/** Where mise's shims sit on the Host PATH: `mise/status` embeds it, `mise/activation` is it. */
interface ActivationSnapshot {
  readonly enabled: boolean
  readonly configured: boolean
  readonly shimsDir: string
  readonly commands: string[]
  readonly drift: string[]
}

/** `mise/status`: one directory snapshot, the write tier, and the activation. */
interface StatusAnswer {
  readonly available: boolean
  readonly directory: string
  readonly installed: VersionMap
  readonly active: VersionMap
  readonly missing: VersionMap
  readonly writeMode: WriteMode
  /** Set only when mise is not there: the reason the banner at the top shows. */
  readonly error?: { readonly code: string; readonly message: string } | undefined
  readonly activation: ActivationSnapshot
}

/** `mise/versions` for one tool: what is installed here, and what could be. */
interface VersionsAnswer {
  readonly tool: string
  readonly directory: string
  readonly latest: string | null
  readonly installed: ToolVersionRow[]
  readonly active: string[]
  readonly available: RemoteVersion[]
  readonly remoteTotal: number
}

/** One tool mise says has a newer release than the version in effect. */
interface UpdateRow {
  readonly tool: string
  readonly current: string
  readonly latest: string
  readonly requested: string | null
}

/** `mise/updates`: what the hint on a version number is drawn from. */
interface UpdatesAnswer {
  readonly directory: string
  readonly tools: UpdateRow[]
}

/** One registry row: a tool name, what it does, and how else it is spelled. */
interface RegistryRow {
  readonly short: string
  readonly description: string
  readonly bins: string[]
  readonly aliases: string[]
}

/** `mise/registry`: the query, the corpus size, and the matched rows. */
interface RegistryAnswer {
  readonly query: string
  readonly total: number
  readonly matches: RegistryRow[]
}

/** One PATH hit from `mise/system`. */
interface SystemTool {
  readonly name: string
  readonly path: string
  readonly version: string | null
  readonly managedVersions: number
  readonly managed: string[]
  readonly fromMise: boolean
  /**
   * The image's own copy, per the Host's second PATH pass. Absent on an older
   * Host, which is why every reader falls back to `path` when it is undefined.
   */
  readonly systemPath?: string | null | undefined
  readonly systemVersion?: string | null | undefined
}

/** `mise/system`: the PATH scan, plus the failure the panel draws when it throws. */
interface SystemAnswer {
  readonly tools: SystemTool[]
  /** How many candidate commands the scan looked at; the page does not draw it. */
  readonly scanned?: number | undefined
  readonly error?: string | undefined
}

/** `mise/progress`: one poll of the one running write. */
interface JobSnapshot {
  readonly id: number
  readonly label: string
  readonly elapsedMs: number
  readonly done: boolean
  readonly ok?: boolean | undefined
  readonly exitCode: number | null
  readonly lines: string[]
  /** A finished job carries its whole answer. */
  readonly result?: unknown
  readonly error?: string | undefined
}

/** What every write answers; the panel reads only these three off it. */
interface WriteAnswer {
  readonly ok?: boolean | undefined
  readonly exitCode?: number | undefined
  readonly output?: string | undefined
}

/** `mise/install`: which specs were asked for, and which ended up installed. */
interface InstallAnswer extends WriteAnswer {
  readonly requested: readonly string[]
  readonly installed: readonly string[]
}

/** `mise/use`: the spec, and which config it was pinned in. */
interface UseAnswer extends WriteAnswer {
  readonly spec: string
  readonly scope: 'project' | 'global'
}

/** `mise/uninstall`: what went away, and whether mise said it was never there. */
interface UninstallAnswer extends WriteAnswer {
  readonly removed: readonly ToolVersionPair[]
  /** Config requests the Host dropped because their version is gone. */
  readonly forgot?: readonly ForgotRequest[] | undefined
  readonly notInstalled: boolean
}

/** One config request removed with its version, and the file it was written in. */
interface ForgotRequest {
  readonly tool: string
  readonly version: string
  readonly path: string
}

/** `mise/unuse`: the request that went out of one config file. */
interface UnuseAnswer extends WriteAnswer {
  readonly tool: string
  readonly path: string
}

/** `mise/prune` with `dryRun: true`: what a cleanup would delete. */
interface PrunePreview extends WriteAnswer {
  readonly dryRun: true
  readonly candidates: ToolVersionPair[]
}

/** `mise/prune` with `dryRun: false`: what a cleanup did delete. */
interface PruneResult extends WriteAnswer {
  readonly dryRun: false
  readonly candidates: ToolVersionPair[]
  readonly removed: ToolVersionPair[]
}

/** Either prune answer. */
type PruneAnswer = PrunePreview | PruneResult

/** Every call this page makes: its arguments and the answer it narrows to. */
interface RpcCalls {
  readonly status: { readonly args: { readonly cwd?: string | undefined }; readonly value: StatusAnswer }
  readonly versions: {
    readonly args: { readonly tool: string; readonly prefix: string; readonly cwd: string }
    readonly value: VersionsAnswer
  }
  readonly registry: { readonly args: { readonly query: string }; readonly value: RegistryAnswer }
  readonly updates: { readonly args: { readonly cwd?: string | undefined }; readonly value: UpdatesAnswer }
  readonly activation: { readonly args: Record<string, never>; readonly value: ActivationSnapshot }
  readonly system: { readonly args: Record<string, never>; readonly value: SystemAnswer }
  readonly progress: { readonly args: Record<string, never>; readonly value: JobSnapshot }
  readonly install: {
    readonly args: { readonly specs: readonly string[]; readonly cwd: string }
    readonly value: InstallAnswer
  }
  readonly use: {
    readonly args: { readonly spec: string; readonly scope: 'project' | 'global'; readonly cwd: string }
    readonly value: UseAnswer
  }
  readonly prune: { readonly args: { readonly dryRun: boolean; readonly cwd: string }; readonly value: PruneAnswer }
  readonly uninstall: {
    readonly args: { readonly specs: readonly string[]; readonly cwd: string }
    readonly value: UninstallAnswer
  }
  readonly unuse: {
    readonly args: { readonly tool: string; readonly path: string; readonly cwd: string }
    readonly value: UnuseAnswer
  }
}

/** Every method the Host mounts on `/mise`. */
type RpcMethod = keyof RpcCalls

/** The arguments one method takes. */
type RpcArgsOf<M extends RpcMethod> = RpcCalls[M]['args']

/** The answer one method narrows to. */
type RpcValueOf<M extends RpcMethod> = RpcCalls[M]['value']

/**
 * The RPC caller every part of the page shares.
 *
 * `args` is optional because the argument-free calls (`system`, `progress`) are
 * made without one, and the Host defaults `{ args }` to `{}` for the same reason.
 */
type Invoke = <M extends RpcMethod>(method: M, args?: RpcArgsOf<M>) => Promise<RpcValueOf<M>>

window.__ModuleLoader__.load({
  id: '@sovlookup/dsh-mise',
  factory(require) {
    const React = reactModule(require('react'))
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-mise'
    const SECTION_ID = 'mise'
    const SECTION_ORDER = 48

    /**
     * How long a disclosure is given to fold before its content leaves the tree.
     *
     * The stylesheet's `--dsmise-unfold` is what animates (200ms); this is the
     * margin the unmount waits on top of it, so the two move together.
     */
    const COLLAPSE_MS = 220

    const DICT_ZH = {
      nav: '工具链管理',
      title: '工具链管理',
      loading: '读取中…',
      refresh: '刷新',
      colTool: '工具',
      colCurrent: '当前',
      colInstalled: '已装',
      colActions: '操作',
      tagSystem: '系统',
      systemVersionHint: '镜像自带的这份可执行文件，mise 不管它：只读，不能启用也不能卸载。',
      notInstalled: '未安装',
      pruneUnused: '未使用',
      installManaged: '安装',
      installAll: '按配置安装全部',
      pathDrift: '这些目录还在 /tmp 且里面有内容，没有自动迁移：',
      setProject: '启用',
      uninstall: '卸载',
      uninstallConfirm: '确认卸载',
      uninstallHint: '把这个版本从 mise 安装目录删掉，并顺手删掉配置里指向它的那一条（没有这条请求，它也不会再占一行）；想成批清掉没人引用的版本用下面的清理。',
      forgotConfig: '已从配置里移除该请求',
      dropRequest: '从配置移除',
      dropRequestHint: '把配置里要求这个工具的条目删掉（mise unuse），已经装好的文件不受影响；删掉这一行就不再出现。',
      toolPlaceholder: '工具名或用途，如 node / pnpm@12 / javascript runtime',
      prefixHint: '只看这个前缀的版本，点一下看全部',
      notFound: '没找到叫这个名字的工具，下面也没有 registry 匹配结果。换个说法试试，比如 javascript runtime。',
      registryMatches: 'registry 里的匹配',
      find: '查找',
      noticeClose: '关闭',
      query: '查版本',
      latest: 'latest',
      remoteTotal: '个远程版本',
      installedTotal: '个版本',
      installedTotalOne: '个版本',
      versionsEmpty: '没有可显示的版本。',
      versionInstalled: '已装',
      versionActive: '生效',
      noTools: '本目录的 mise 配置里还没有任何工具',
      systemTools: '系统自带',
      systemFoldHint: '镜像自带、mise 不管的命令：只读，展开看版本与路径',
      colVersion: '版本',
      colState: '状态',
      colPath: '路径',
      drillOpen: '展开版本子表',
      drillClose: '收起版本子表',
      updateHint: '有新版本',
      updateConfig: '配置要',
      updateOpen: '点击查看可安装的版本',
      install: '安装',
      installing: '安装中…',
      progressElapsed: '已用',
      progressWaiting: '等 mise 输出…',
      unavailable: '找不到 mise',
      unavailableHint: '装好 mise（https://mise.run）后刷新；或在插件配置里把 miseBin 指向它的绝对路径。',
      writeReadonly: '当前 writeMode=readonly，面板上的安装、切换、清理会被拒绝。',
      failed: '失败',
      ok: '成功',
      exitCode: '退出码',
      pickerClose: '收起',
    }

    const DICT_EN = {
      nav: 'Toolchains',
      title: 'Toolchain Manager',
      loading: 'Reading…',
      refresh: 'Refresh',
      colTool: 'Tool',
      colCurrent: 'Current',
      colInstalled: 'Installed',
      colActions: 'Actions',
      tagSystem: 'system',
      systemVersionHint: 'The copy the image ships. mise does not manage it: read-only, nothing to enable or uninstall.',
      notInstalled: 'missing',
      pruneUnused: 'unused',
      installManaged: 'Install',
      installAll: 'Install everything configured',
      pathDrift: 'Still on /tmp with content, not migrated:',
      setProject: 'Enable',
      uninstall: 'Uninstall',
      uninstallConfirm: 'Confirm',
      uninstallHint: 'Delete this version from the mise install directory and drop the config request that named it, so it stops holding a row. To clean up versions no config references, use Prune below.',
      forgotConfig: 'config request removed',
      dropRequest: 'Drop config',
      dropRequestHint: 'Remove the config entry that asks for this tool (mise unuse). Installed files are untouched; the row disappears with it.',
      toolPlaceholder: 'tool name or purpose, e.g. node / pnpm@12 / javascript runtime',
      prefixHint: 'Only versions under this prefix; click to see all',
      notFound: 'No tool by that name, and the registry returned no matches either. Try a purpose instead, e.g. javascript runtime.',
      registryMatches: 'Registry matches',
      find: 'Find',
      noticeClose: 'Dismiss',
      query: 'Versions',
      latest: 'latest',
      remoteTotal: 'remote versions',
      installedTotal: 'versions',
      installedTotalOne: 'version',
      versionsEmpty: 'No versions to show.',
      versionInstalled: 'installed',
      versionActive: 'active',
      noTools: 'No tool in the mise config for this directory yet',
      systemTools: 'Shipped by the image',
      systemFoldHint: 'Commands the image provides that mise does not manage: read-only, expand for version and path',
      colVersion: 'Version',
      colState: 'State',
      colPath: 'Path',
      drillOpen: 'Expand the version sub-table',
      drillClose: 'Collapse the version sub-table',
      updateHint: 'new release',
      updateConfig: 'config asks',
      updateOpen: 'Click to see the versions you can install',
      install: 'Install',
      installing: 'Installing…',
      progressElapsed: 'Elapsed',
      progressWaiting: 'Waiting for mise output…',
      unavailable: 'mise not found',
      unavailableHint: 'Install mise (https://mise.run) and refresh, or point miseBin in the plugin config at its absolute path.',
      writeReadonly: 'writeMode=readonly: install, switch and prune are refused from this page.',
      failed: 'Failed',
      ok: 'OK',
      exitCode: 'exit',
      pickerClose: 'Collapse',
    }

    const CSS = [
      // ── motion ────────────────────────────────────────────────────────────
      // The page's own motion scale, declared once and used by every rule
      // below. The host theme ships no easing or duration token of any kind
      // (there is no `--dsw-*` curve in its CSS), so this is the codebase's
      // first set rather than a second, parallel one. The curves are the strong
      // UI ones on purpose: the browser's built-in `ease-out` is too weak to
      // read as deliberate at 200ms.
      '.dsmise{--dsmise-ease-out:cubic-bezier(0.23,1,0.32,1);--dsmise-ease-in-out:cubic-bezier(0.77,0,0.175,1);--dsmise-fast:120ms;--dsmise-base:180ms;--dsmise-unfold:200ms;display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.dsmise h2{margin:0;font-size:15px;line-height:22px;font-weight:600}',
      '.dsmise-meta{display:flex;flex-wrap:wrap;gap:6px 12px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsmise-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.dsmise-sec{display:flex;flex-direction:column;gap:8px}',
      '.dsmise-sec-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
      '.dsmise-sec-head h3{margin:0;font-size:13px;line-height:20px;font-weight:600}',
      '.dsmise-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:0}',
      '.dsmise-card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.dsmise-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between}',
      '.dsmise-row-main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.dsmise-name{font-weight:600}',
      '.dsmise-dim{color:var(--dsw-alias-label-secondary)}',
      '.dsmise-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsmise-chip.is-active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsmise-chip.is-installed{border-color:var(--dsw-alias-state-success-primary)}',
      // A dashed border is the "not mise's, not actionable" shape: the same chip
      // geometry, so the row reads as one of the versions, without the solid
      // outline that promises a state mise can change.
      '.dsmise-chip.is-system{border-style:dashed;color:var(--dsw-alias-label-secondary)}',
      // Colour changes ease; the press is a 100ms 0.97 squish, which is
      // feedback rather than decoration (there is no other sign the press
      // landed until the command answers).
      '.dsmise-btn{appearance:none;font:inherit;font-size:12px;line-height:18px;padding:3px 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color var(--dsmise-fast) ease,border-color var(--dsmise-fast) ease,color var(--dsmise-fast) ease,transform 100ms var(--dsmise-ease-out)}',
      '.dsmise-btn:active:not(:disabled){transform:scale(.97)}',
      '.dsmise-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
      '.dsmise-btn:disabled{opacity:.55;cursor:default}',
      '.dsmise-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.dsmise-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsmise-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.dsmise-input{font:inherit;font-size:12px;line-height:18px;padding:4px 8px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-width:0}',
      '.dsmise-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.dsmise-input.grow{flex:1 1 220px}',
      '.dsmise-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto}',
      '.dsmise-ver{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0}',
      '.dsmise-alert{border-radius:var(--dsw-radius-md,8px);padding:8px 10px;font-size:12px;line-height:18px;border:1px solid var(--dsw-alias-border-l1)}',
      '.dsmise-alert.has-close{display:flex;align-items:flex-start;gap:10px}',
      '.dsmise-notice-body{flex:1 1 auto;min-width:0}',
      '.dsmise-alert-close{border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:2px 4px;opacity:.75}',
      '.dsmise-alert-close:hover{opacity:1}',
      '.dsmise-alert.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dsmise-alert.warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.dsmise-alert.ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.dsmise-log{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);max-height:160px;overflow:auto;margin:0}',
      // The newer-release hint: a dashed outline reads as an aside, not a state
      // the tool is in, so it cannot be mistaken for `未安装` / `未使用`.
      '.dsmise-update{appearance:none;font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px dashed var(--dsw-alias-state-warn-primary);background:transparent;color:var(--dsw-alias-state-warn-primary);cursor:pointer;white-space:nowrap}',
      '.dsmise-update:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsmise-update:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.dsmise-table{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
      // Three columns: tool, current, how many. No actions column — everything
      // this table can do is done to a version, so it lives in the sub-table.
      // The count column is fixed (not `auto`): every row is its own grid, so a
      // content-sized column would size itself per row and the numbers would not
      // line up. Wide enough for the unit that follows the number.
      '.dsmise-tr{display:grid;grid-template-columns:minmax(96px,1fr) minmax(120px,1.2fr) 84px;gap:10px;align-items:center;padding:7px 10px}',
      '.dsmise-tr+.dsmise-tr{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsmise-tr.is-head{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.dsmise-cell{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.dsmise-cell-actions{flex-direction:row;flex-wrap:wrap;gap:6px;justify-content:flex-end}',
      '.dsmise-span-actions{justify-content:flex-end;gap:8px}',
      // The count with its unit, right-aligned so the column reads as a column.
      '.dsmise-cell-count{flex-direction:row;align-items:center;justify-content:flex-end}',
      '.dsmise-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dsmise-chip.is-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      // The prefix the search box carried (`pnpm@12`): the same pill as a chip,
      // but pressable — it drops the narrowing and lists the whole tool.
      '.dsmise-prefix{appearance:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-brand-primary);background:transparent;color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dsmise-prefix:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dsmise-prefix:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      // A tool name that drills into its version sub-table: the chevron is the
      // only affordance, so it is drawn even though the name itself is the target.
      '.dsmise-tool{appearance:none;font:inherit;color:inherit;background:none;border:0;padding:0;display:inline-flex;align-items:center;gap:5px;text-align:left;cursor:pointer;min-width:0}',
      '.dsmise-tool:hover .dsmise-name{text-decoration:underline;text-underline-offset:2px}',
      '.dsmise-tool:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px;border-radius:var(--dsw-radius-md,8px)}',
      // The chevron is drawn, not typed: a glyph would have to swap ▸ for ▾,
      // and a swap cannot be eased. One arrow, turned a quarter turn when its
      // disclosure is open.
      '.dsmise-chev{flex:none;display:inline-flex;align-items:center;justify-content:center;width:9px;height:9px;color:var(--dsw-alias-label-secondary);transition:transform 160ms var(--dsmise-ease-out)}',
      '.dsmise-chev.is-open{transform:rotate(90deg)}',
      '.dsmise-chev svg{display:block}',
      // One disclosure, both directions. Height is the one property with no
      // transform stand-in for an accordion, so it is the exception: the
      // component measures the content (`scrollHeight`) and hands the wrapper a
      // pixel height, which the transition then runs from — and settles it to
      // `auto` once it has arrived, so a row that grows while the fold is open
      // (a version appears) still fits. Nothing in `is-open` may set a height:
      // a class that jumps to `auto` in the same commit as the pinned pixels
      // resolves to the end value at once and there is nothing left to
      // transition. Visibility waits out the fold on close, so the content is
      // not tabbable while it is still shrinking, and it is neither clickable
      // nor read out until it is open.
      '.dsmise-collapse{height:0;overflow:hidden;visibility:hidden;opacity:0;pointer-events:none;transition:height var(--dsmise-unfold) var(--dsmise-ease-out),opacity 120ms var(--dsmise-ease-out),visibility 0s linear var(--dsmise-unfold)}',
      '.dsmise-collapse.is-open{visibility:visible;opacity:1;pointer-events:auto;transition:height var(--dsmise-unfold) var(--dsmise-ease-out),opacity 160ms var(--dsmise-ease-out) 40ms,visibility 0s}',
      // The version sub-table sits between two rows, so the row separators are
      // re-declared around it: `.dsmise-tr+.dsmise-tr` no longer matches, and
      // the line above it belongs to the open state only.
      '.dsmise-sub{display:flex;flex-direction:column;gap:1px;padding:4px 10px 8px 26px;background:var(--dsw-alias-bg-layer-2)}',
      '.dsmise-sub-wrap.is-open>.dsmise-sub{border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dsmise-sub-wrap+.dsmise-tr{border-top:1px solid var(--dsw-alias-border-l1)}',
      // Fixed outer columns on purpose: every row is its own grid, so an `auto`
      // column would size itself per row and the table would come out ragged.
      '.dsmise-sub-row{display:grid;grid-template-columns:minmax(76px,0.7fr) 92px minmax(120px,2fr) 176px;gap:10px;align-items:center;padding:4px 0;font-size:12px;line-height:18px}',
      '.dsmise-sub-row.is-head{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      // The image's copy is a version, not a hopeful one: dimmed, with room kept
      // for the buttons it does not have so the columns stay lined up.
      '.dsmise-sub-row.is-system{color:var(--dsw-alias-label-secondary)}',
      '.dsmise-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      // The image's own toolchains: one collapsed line until asked for.
      '.dsmise-fold{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);overflow:hidden;background:var(--dsw-alias-bg-layer-1)}',
      '.dsmise-fold-head{appearance:none;font:inherit;font-size:12px;line-height:18px;display:flex;align-items:center;gap:6px;padding:7px 10px;border:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;text-align:left}',
      '.dsmise-fold-head:hover{color:var(--dsw-alias-label-primary)}',
      '.dsmise-fold-head:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}',
      '.dsmise-fold-body{display:flex;flex-direction:column;padding:4px 10px 8px 22px}',
      '.dsmise-sys-row{display:grid;grid-template-columns:minmax(88px,1fr) minmax(96px,1fr) minmax(160px,2.4fr);gap:10px;align-items:center;padding:3px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      // ── entrance ──────────────────────────────────────────────────────────
      // The page arrives in one shot (a read finishes, the whole panel appears
      // where a one-line `读取中…` was), so each block rises 4px as it fades in
      // rather than teleporting. It is a mount animation on purpose: a refresh
      // re-renders the same nodes and must not replay it, and the second big
      // block trails the first by 50ms so the page reads as arriving rather
      // than as appearing. Deferred to `transform`/`opacity`, so nothing in the
      // page is laid out again while it plays.
      '.dsmise>*{animation:dsmise-rise var(--dsmise-base) var(--dsmise-ease-out) both}',
      '.dsmise>.dsmise-sec+.dsmise-sec{animation-delay:50ms}',
      '@keyframes dsmise-rise{from{opacity:0;transform:translateY(4px)}}',
      '@keyframes dsmise-fade{from{opacity:0}}',
      // A command is running: the log under this dot is the progress, but a log
      // that has not printed yet is indistinguishable from a hung one.
      '.dsmise-live{flex:none;width:6px;height:6px;border-radius:999px;background:var(--dsw-alias-brand-primary);animation:dsmise-live 1.4s ease-in-out infinite}',
      '@keyframes dsmise-live{0%,100%{opacity:1}50%{opacity:.25}}',
      // Fewer and gentler, not none: the fade stays (it is what makes the page
      // legible), every 4px rise, fold, chevron turn and squish goes.
      '@media (prefers-reduced-motion:reduce){',
      '.dsmise>*{animation:dsmise-fade 120ms ease both}',
      '.dsmise-collapse,.dsmise-collapse.is-open{transition:none}',
      '.dsmise-chev{transition:none}',
      '.dsmise-btn{transition:background-color var(--dsmise-fast) ease,border-color var(--dsmise-fast) ease,color var(--dsmise-fast) ease}',
      '.dsmise-btn:active:not(:disabled){transform:none}',
      '.dsmise-live{animation:none}',
      '}',
      // The settings nav gives every unknown section the generic gear; the row
      // glyph is drawn by the label instead (same shape dsh-vaultwarden uses).
      '.dsmise-nav-label{display:inline-flex;align-items:center;gap:8px;min-width:0}',
      '.dsmise-nav-glyph{flex:none;width:16px;height:16px;color:inherit}',
      '.dsmise-nav-text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    ].join('')

    // ── narrowing untrusted payloads ──────────────────────────────────────────
    // Small helpers, one field at a time — never a cast of a whole answer.

    /** A JSON object, or an empty object for anything else. */
    function asRecord(value: unknown): Record<string, unknown> {
      return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
    }

    /** A JSON array, or an empty one. */
    function asArray(value: unknown): unknown[] {
      return Array.isArray(value) ? value : []
    }

    /** One JSON scalar as text; `null`, `undefined`, objects and arrays become `''`. */
    function text(value: unknown): string {
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return ''
    }

    /** A JSON scalar as text, or `undefined` when the field is absent (the `??` sites). */
    function optText(value: unknown): string | undefined {
      if (value === null || value === undefined) return undefined
      return typeof value === 'string' ? value : String(value)
    }

    /** A JSON number, or `0` when the field is missing or not finite. */
    function num(value: unknown): number {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    /** The write tier, defaulting to `ask` — the tier the Host itself defaults to. */
    function asWriteMode(value: unknown): WriteMode {
      return value === 'readonly' || value === 'auto' ? value : 'ask'
    }

    /** One `mise ls` row. */
    function asVersionRow(value: unknown): ToolVersionRow {
      const row = asRecord(value)
      return {
        version: text(row['version']),
        requested: optText(row['requested']) ?? null,
        installed: row['installed'] === true,
        active: row['active'] === true,
        source: optText(row['source']) ?? null,
        installPath: optText(row['installPath']) ?? null,
      }
    }

    /** `{ tool: [row…] }`, one entry per tool name. */
    function asVersionMap(value: unknown): VersionMap {
      const map: Record<string, ToolVersionRow[]> = {}
      for (const [tool, rows] of Object.entries(asRecord(value))) map[tool] = asArray(rows).map(asVersionRow)
      return map
    }

    /** One remote version row. */
    function asRemoteVersion(value: unknown): RemoteVersion {
      const row = asRecord(value)
      return {
        version: text(row['version']),
        createdAt: optText(row['createdAt']) ?? null,
        url: optText(row['url']) ?? null,
        installed: row['installed'] === true,
        active: row['active'] === true,
      }
    }

    /** One registry row. */
    function asRegistryRow(value: unknown): RegistryRow {
      const row = asRecord(value)
      return {
        short: text(row['short']),
        description: text(row['description']),
        bins: asArray(row['bins']).map(text),
        aliases: asArray(row['aliases']).map(text),
      }
    }

    /** One PATH hit. */
    function asSystemTool(value: unknown): SystemTool {
      const tool = asRecord(value)
      return {
        name: text(tool['name']),
        path: text(tool['path']),
        version: optText(tool['version']) ?? null,
        managedVersions: num(tool['managedVersions']),
        managed: asArray(tool['managed']).map(text),
        fromMise: tool['fromMise'] === true,
      }
    }

    /** One `tool@version` pair. */
    function asPair(value: unknown): ToolVersionPair {
      const pair = asRecord(value)
      return { tool: text(pair['tool']), version: text(pair['version']) }
    }

    /**
     * Split one search-box entry into a tool and an optional version prefix.
     *
     * `pnpm@12` is the same spelling `mise ls-remote pnpm@12` takes, so the box
     * accepts it and hands the half after the `@` down as `prefix`: the Host
     * already narrows the remote list with it, and the installed list still
     * answers for the tool as a whole (a prefix is not a tool name).
     *
     * Only a version-shaped tail counts. Tool identifiers can carry an `@` of
     * their own (`npm:@scope/pkg`), and `node@` with nothing behind it is just a
     * half-typed spec, not a request to filter.
     */
    function splitSpec(value: string): { readonly tool: string; readonly prefix: string } {
      const clean = String(value ?? '').trim()
      const at = clean.lastIndexOf('@')
      if (at > 0) {
        const tail = clean.slice(at + 1)
        if (/^\d/.test(tail)) return { tool: clean.slice(0, at), prefix: tail }
      }
      return { tool: clean, prefix: '' }
    }

    /** One "this tool is behind" row. A row with no version in effect is no hint. */
    function asUpdateRow(value: unknown): UpdateRow | null {
      const row = asRecord(value)
      const tool = text(row['tool']).trim()
      const current = text(row['current']).trim()
      const latest = text(row['latest']).trim()
      if (!tool || !current || !latest || current === latest) return null
      return { tool, current, latest, requested: optText(row['requested']) ?? null }
    }

    /** The activation snapshot, either embedded in a status or answered on its own. */
    function asActivation(value: unknown): ActivationSnapshot {
      const snapshot = asRecord(value)
      return {
        enabled: snapshot['enabled'] === true,
        configured: snapshot['configured'] === true,
        shimsDir: text(snapshot['shimsDir']),
        commands: asArray(snapshot['commands']).map(text),
        drift: asArray(snapshot['drift']).map(text),
      }
    }

    /** One poll of a running write. */
    function asJob(value: unknown): JobSnapshot {
      const job = asRecord(value)
      return {
        id: num(job['id']),
        label: text(job['label']),
        elapsedMs: num(job['elapsedMs']),
        done: job['done'] === true,
        ok: typeof job['ok'] === 'boolean' ? job['ok'] : undefined,
        exitCode: typeof job['exitCode'] === 'number' ? job['exitCode'] : null,
        lines: asArray(job['lines']).map(text),
        result: job['result'],
        error: optText(job['error']),
      }
    }

    /** The three fields every write answer shares; `ok` is absent on a dry-run preview. */
    function asWrite(answer: Record<string, unknown>): WriteAnswer {
      return {
        ok: typeof answer['ok'] === 'boolean' ? answer['ok'] : undefined,
        exitCode: typeof answer['exitCode'] === 'number' ? answer['exitCode'] : undefined,
        output: optText(answer['output']),
      }
    }

    /** `mise/status`. */
    function decodeStatus(value: unknown): StatusAnswer {
      const answer = asRecord(value)
      const failure = asRecord(answer['error'])
      return {
        available: answer['available'] === true,
        directory: text(answer['directory']),
        installed: asVersionMap(answer['installed']),
        active: asVersionMap(answer['active']),
        missing: asVersionMap(answer['missing']),
        writeMode: asWriteMode(answer['writeMode']),
        error: Object.keys(failure).length ? { code: text(failure['code']), message: text(failure['message']) } : undefined,
        activation: asActivation(answer['activation']),
      }
    }

    /** `mise/versions`. */
    function decodeVersions(value: unknown): VersionsAnswer {
      const answer = asRecord(value)
      return {
        tool: text(answer['tool']),
        directory: text(answer['directory']),
        latest: optText(answer['latest']) ?? null,
        installed: asArray(answer['installed']).map(asVersionRow),
        active: asArray(answer['active']).map(text),
        available: asArray(answer['available']).map(asRemoteVersion),
        remoteTotal: num(answer['remoteTotal']),
      }
    }

    /** `mise/registry`. */
    function decodeRegistry(value: unknown): RegistryAnswer {
      const answer = asRecord(value)
      return {
        query: text(answer['query']),
        total: num(answer['total']),
        matches: asArray(answer['matches']).map(asRegistryRow),
      }
    }

    /** `mise/updates`. */
    function decodeUpdates(value: unknown): UpdatesAnswer {
      const answer = asRecord(value)
      return {
        directory: text(answer['directory']),
        tools: asArray(answer['tools'])
          .map(asUpdateRow)
          .filter((row): row is UpdateRow => row !== null),
      }
    }

    /** `mise/system`. */
    function decodeSystem(value: unknown): SystemAnswer {
      const answer = asRecord(value)
      return {
        tools: asArray(answer['tools']).map(asSystemTool),
        scanned: num(answer['scanned']),
        error: optText(answer['error']),
      }
    }

    /** `mise/install`. */
    function decodeInstall(value: unknown): InstallAnswer {
      const answer = asRecord(value)
      return {
        ...asWrite(answer),
        requested: asArray(answer['requested']).map(text),
        installed: asArray(answer['installed']).map(text),
      }
    }

    /** `mise/use`. */
    function decodeUse(value: unknown): UseAnswer {
      const answer = asRecord(value)
      return {
        ...asWrite(answer),
        spec: text(answer['spec']),
        scope: answer['scope'] === 'global' ? 'global' : 'project',
      }
    }

    /** `mise/uninstall`. */
    function decodeUninstall(value: unknown): UninstallAnswer {
      const answer = asRecord(value)
      return {
        ...asWrite(answer),
        removed: asArray(answer['removed']).map(asPair),
        forgot: asArray(answer['forgot']).map((entry) => {
          const row = asRecord(entry)
          return { tool: text(row['tool']), version: text(row['version']), path: text(row['path']) }
        }),
        notInstalled: answer['notInstalled'] === true,
      }
    }

    /** `mise/unuse`. */
    function decodeUnuse(value: unknown): UnuseAnswer {
      const answer = asRecord(value)
      return {
        ...asWrite(answer),
        tool: text(answer['tool']),
        path: text(answer['path']),
      }
    }

    /** `mise/prune`, in either mode. */
    function decodePrune(value: unknown): PruneAnswer {
      const answer = asRecord(value)
      const candidates = asArray(answer['candidates']).map(asPair)
      const removed = asArray(answer['removed']).map(asPair)
      return answer['dryRun'] === false
        ? { ...asWrite(answer), dryRun: false, candidates, removed }
        : { ...asWrite(answer), dryRun: true, candidates }
    }

    /** One narrowing function per method: the table is what makes `invoke` typed. */
    const DECODERS = {
      status: decodeStatus,
      versions: decodeVersions,
      registry: decodeRegistry,
      updates: decodeUpdates,
      activation: asActivation,
      system: decodeSystem,
      progress: asJob,
      install: decodeInstall,
      use: decodeUse,
      prune: decodePrune,
      uninstall: decodeUninstall,
      unuse: decodeUnuse,
    } satisfies { readonly [M in RpcMethod]: (value: unknown) => RpcValueOf<M> }

    /** The empty version map `Object.entries` needs when a snapshot has no rows. */
    const NO_VERSIONS: VersionMap = {}

    /**
     * The React namespace the module table hands over.
     *
     * `require` is typed `unknown` because every other module it returns is
     * untrusted; this is the one the page cannot work without, so its members are
     * checked here and the namespace is asserted once, at the seam.
     */
    function reactModule(value: unknown): typeof import('react') {
      const module = asRecord(value)
      const members = [
        'createElement',
        'Component',
        'useCallback',
        'useEffect',
        'useLayoutEffect',
        'useMemo',
        'useRef',
        'useState',
      ] as const
      for (const member of members) {
        if (typeof module[member] !== 'function') throw new Error(`react.${member} 不可用`)
      }
      return value as typeof import('react')
    }

    /** Whether a value from the module table can be rendered as a component. */
    function isElementType(value: unknown): value is ReactNS.ComponentType<IconProps> {
      return typeof value === 'function' || typeof value === 'string'
    }

    /** The one icon member this page looks for, or `null` when the table has no such package. */
    function iconOf(value: unknown): ReactNS.ComponentType<IconProps> | null {
      const icon = asRecord(value)['IconCodeOutlineMedium']
      return isElementType(icon) ? icon : null
    }

    /** A caught value, reduced to the one field the page reads off it. */
    interface ThrownMessage {
      readonly message?: unknown
    }

    /** A caught value as `{ message }`, without trusting it to be an `Error`. */
    function asThrown(value: unknown): ThrownMessage {
      const record = asRecord(value)
      return 'message' in record ? { message: record['message'] } : {}
    }

    /** A caught value as one line of text: an `Error`'s message, else its string form. */
    function reason(error: unknown): string {
      const message = asThrown(error).message
      return message === null || message === undefined ? String(error) : String(message)
    }

    // ── the page's own shapes ─────────────────────────────────────────────────
    // Types only: what each control takes, and what the page holds between reads.

    /** The translator this page uses; every key it asks for exists in both dictionaries. */
    type PageTranslate = Translate<keyof typeof DICT_ZH>

    /** The two things the shell injects into this section. */
    interface PageProps {
      readonly t: PageTranslate
      readonly invoke: Invoke
    }

    /** The settings row's label: the text the glyph sits beside. */
    interface NavLabelProps {
      readonly text: string
    }

    /** What the nav glyph takes: the size the shell draws it at, and a class hook. */
    interface IconProps {
      readonly size?: number | undefined
      readonly className?: string | undefined
    }

    /** The boundary takes `t` only because the shell injects the same props. */
    interface PanelBoundaryProps {
      readonly t: PageTranslate
      readonly children?: ReactNS.ReactNode
    }

    interface PanelBoundaryState {
      readonly error: Error | null
    }

    /** One of the page's buttons; `kind` picks the `.primary` / `.danger` border. */
    interface BtnProps {
      readonly children?: ReactNS.ReactNode
      readonly onClick?: (() => void) | undefined
      readonly kind?: string | undefined
      readonly disabled?: boolean | undefined
      readonly title?: string | undefined
    }

    /** One inline state chip; `state` becomes `is-<state>`. */
    interface ChipProps {
      readonly children?: ReactNS.ReactNode
      readonly state?: string | undefined
    }

    /** One titled block; every member is optional on purpose (see `Section`). */
    interface SectionProps {
      readonly title?: ReactNS.ReactNode
      readonly hint?: ReactNS.ReactNode
      readonly action?: ReactNS.ReactNode
      readonly children?: ReactNS.ReactNode
    }

    /** One log block: a command's own output. */
    interface LogProps {
      readonly text?: string | undefined
    }

    /** The trailing hint on a version number: mise says a newer release exists. */
    interface UpdateBadgeProps {
      readonly update: UpdateRow
      readonly t: PageTranslate
      readonly onOpen: () => void
    }

    /** The chevron into a disclosure: one arrow, turned when the disclosure is open. */
    interface ChevProps {
      readonly open: boolean
    }

    /** One disclosure whose content is only in the tree while it is worth having. */
    interface CollapseProps {
      readonly open: boolean
      /** The wrapper's own class; the fold bookkeeping class is added for you. */
      readonly className: string
      readonly children?: ReactNS.ReactNode
    }

    /** The receipt or failure the panel shows under the buttons. */
    interface Notice {
      readonly kind: 'error' | 'ok'
      readonly text: string
      readonly log: string
    }

    /** The version card the search box opens, and what it currently knows. */
    interface PickerState {
      readonly tool: string
      /** The version prefix the entry carried (`pnpm@12` → `12`), if any. */
      readonly prefix?: string | undefined
      readonly loading?: boolean | undefined
      readonly data: VersionsAnswer | null
      readonly error: string | null
    }

    /** The prune verdict, plus whether it is a preview or what a cleanup just did. */
    interface PruneState {
      readonly candidates: ToolVersionPair[]
      readonly removed?: ToolVersionPair[] | undefined
      readonly ran?: boolean | undefined
      readonly error?: string | undefined
      readonly ok?: boolean | undefined
      readonly exitCode?: number | undefined
      readonly output?: string | undefined
      readonly dryRun?: boolean | undefined
    }

    /** One table row: everything the mise sources know about one tool name. */
    interface TableRow {
      readonly name: string
      readonly activeRow: ToolVersionRow | undefined
      readonly installed: ToolVersionRow[]
      readonly missing: ToolVersionRow[]
      /** The PATH hit for this same name, if the image also ships a copy. */
      readonly sys: SystemTool | undefined
      /**
       * The image's copy, resolved once: it is a version in the sub-table, not a
       * tag on the tool row.
       */
      readonly systemCopy: { readonly path: string; readonly version: string | null } | null
      /**
       * mise's "a newer release exists" verdicts for this tool. Each names the
       * version it is about (`current`), which is not always the version in
       * effect: a stale copy left on disk is reported too. So this is a list,
       * and a hint is looked up by version rather than by tool.
       */
      readonly updates: UpdateRow[]
    }

    // ── host channel ──────────────────────────────────────────────────────────

    /**
     * Build the RPC caller over the authenticated `/mise` channel.
     *
     * One `{ args }` envelope in, one narrowed answer out: the `ok`/`value`
     * envelope the Host wraps every answer in is unwrapped here, so the rest of
     * the page deals in payloads instead of channels.
     */
    const makeInvoke = (connection: ConnectionService | undefined): Invoke => {
      const call = async (method: RpcMethod, args: unknown): Promise<unknown> => {
        if (!connection || typeof connection.rpc?.call !== 'function') {
          const error: CodedError = new Error('连接通道不可用（请刷新页面）')
          error.code = 'no_connection'
          throw error
        }
        // The Host mounts this plugin's own channel (`/mise`), not `/api`:
        // a shared channel takes one interceptor and the API gateway owns that one.
        const result = asRecord(await connection.rpc.call('/mise', method, { args }))
        if (!result['ok']) {
          const failure = asRecord(result['error'])
          const error: CodedError = new Error(optText(failure['message']) ?? `mise.${method} 调用失败`)
          error.code = optText(failure['code']) ?? 'rpc_error'
          throw error
        }
        return result['value']
      }

      return async <M extends RpcMethod>(method: M, args?: RpcArgsOf<M>): Promise<RpcValueOf<M>> =>
        DECODERS[method](await call(method, args ?? {}))
    }

    /** Flatten `{ tool: [{ version }] }` into `[{ tool, version, ... }]`. */
    const flatten = (grouped: VersionMap | undefined): FlattenedRow[] => {
      const rows: FlattenedRow[] = []
      for (const [tool, entries] of Object.entries(grouped ?? NO_VERSIONS)) {
        for (const entry of entries ?? []) rows.push({ tool, ...entry })
      }
      return rows
    }

    /**
     * Render-error boundary.
     *
     * A settings section is a guest in the shell's tree: if this component
     * throws while rendering, an uncaught error would travel up into whatever
     * React root the shell mounted it under. Catching it here turns any such
     * bug into one local card, and the rest of Settings keeps working.
     */
    /**
     * The platform icon set, when this page has it. Acquired lazily and cached:
     * a page without the seed word (a bare host) simply gets the drawn fallback,
     * never an error.
     */
    let navIconCache: ReactNS.ComponentType<IconProps> | null | undefined
    function platformIcon(): ReactNS.ComponentType<IconProps> | null {
      if (navIconCache !== undefined) return navIconCache
      try {
        navIconCache = iconOf(require('@deepseek-ai/dsh-client-ui-primitives'))
      } catch {
        navIconCache = null
      }
      return navIconCache
    }

    /** The fallback glyph: two chevrons, drawn by hand at 16px on the same grid. */
    const FallbackGlyph: ReactNS.FC = () =>
      h(
        'svg',
        {
          className: 'dsmise-nav-glyph',
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M6.2 3.4 10 8l-3.8 4.6' }),
        h('path', { d: 'M10.4 3.4 14.2 8l-3.8 4.6' }),
      )

    /**
     * The nav row for this section: glyph plus text.
     *
     * `settings.section` registration carries no icon, and the shell draws the
     * generic gear for every id it does not know, so the glyph lives inside the
     * label — a React node is what the shell renders there — and the host's own
     * gear (a direct `svg` child of the row button) is hidden once it appears.
     */
    function NavLabel({ text }: NavLabelProps) {
      const ref = React.useRef<HTMLSpanElement | null>(null)
      React.useLayoutEffect(() => {
        const svg = ref.current?.closest('button')?.querySelector<SVGElement>(':scope > svg')
        if (svg) svg.style.display = 'none'
      }, [text])
      const Icon = platformIcon()
      return h(
        'span',
        { className: 'dsmise-nav-label', ref },
        Icon ? h(Icon, { size: 16, className: 'dsmise-nav-glyph' }) : h(FallbackGlyph, null),
        h('span', { className: 'dsmise-nav-text' }, text),
      )
    }

    class PanelBoundary extends React.Component<PanelBoundaryProps, PanelBoundaryState> {
      constructor(props: PanelBoundaryProps) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error: Error): PanelBoundaryState {
        return { error }
      }

      override render(): ReactNS.ReactNode {
        if (this.state.error) {
          return h(
            'div',
            { className: 'dsmise' },
            h('h2', null, 'mise'),
            h('div', { className: 'dsmise-alert error' }, `面板渲染失败：${this.state.error?.message ?? this.state.error}`),
            h(
              'div',
              null,
              h(
                Btn,
                { onClick: () => this.setState({ error: null }) },
                '重试',
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    // ── small controls ────────────────────────────────────────────────────────

    const Btn: ReactNS.FC<BtnProps> = ({ children, onClick, kind, disabled, title }) =>
      h(
        'button',
        {
          type: 'button',
          className: `dsmise-btn${kind ? ` ${kind}` : ''}`,
          onClick,
          disabled,
          title,
        },
        children,
      )

    const Chip: ReactNS.FC<ChipProps> = ({ children, state }) =>
      h('span', { className: `dsmise-chip${state ? ` is-${state}` : ''}` }, children)

    /**
     * The image's own copy of a scanned command, when PATH holds one.
     *
     * `systemPath` is the Host's second pass over PATH (the first hit that is not
     * mise's own), so the copy is found even when a shim answers first. An older
     * Host answers only with the hit PATH resolves to; there the copy exists
     * exactly when that hit is not mise's.
     */
    const systemCopyOf = (sys: SystemTool | undefined): { readonly path: string; readonly version: string | null } | null => {
      if (!sys) return null
      const path = sys.systemPath ?? (sys.fromMise ? null : sys.path)
      if (!path) return null
      return { path, version: sys.systemVersion ?? (sys.fromMise ? null : sys.version) }
    }

    /**
     * A block in the page. The heading is optional: the install box needs no
     * title, because the input's own placeholder says what it takes and the
     * table underneath says what it changes.
     */
    const Section: ReactNS.FC<SectionProps> = ({ title, hint, action, children }) =>
      h(
        'section',
        { className: 'dsmise-sec' },
        title || action
          ? h('div', { className: 'dsmise-sec-head' }, title ? h('h3', null, title) : null, action ?? null)
          : null,
        hint ? h('p', { className: 'dsmise-hint' }, hint) : null,
        children,
      )

    const Log: ReactNS.FC<LogProps> = ({ text }) => h('pre', { className: 'dsmise-log' }, text || '')

    /** The disclosure arrow: drawn as one path so it can turn instead of swap. */
    const Chev: ReactNS.FC<ChevProps> = ({ open }) =>
      h(
        'span',
        { className: `dsmise-chev${open ? ' is-open' : ''}`, 'aria-hidden': 'true' },
        h(
          'svg',
          {
            viewBox: '0 0 9 9',
            width: 9,
            height: 9,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
          h('path', { d: 'M3.2 1.6 6.4 4.5 3.2 7.4' }),
        ),
      )

    /**
     * Run `fn` once the browser has painted the state it is in now.
     *
     * Two frames, not one: the first paints the element in its closed shape,
     * and only a style that has been painted can be transitioned away from. A
     * timeout stands in where there is no `requestAnimationFrame` (the render
     * test), where nothing is painted and nothing needs to be.
     */
    function afterPaint(fn: () => void): () => void {
      const scope = globalThis as {
        requestAnimationFrame?: (callback: () => void) => number
        cancelAnimationFrame?: (handle: number) => void
      }
      if (typeof scope.requestAnimationFrame !== 'function') {
        const timer = setTimeout(fn, 32)
        return () => clearTimeout(timer)
      }
      let inner = 0
      const outer = scope.requestAnimationFrame(() => {
        inner = scope.requestAnimationFrame?.(fn) ?? 0
      })
      return () => {
        scope.cancelAnimationFrame?.(outer)
        if (inner) scope.cancelAnimationFrame?.(inner)
      }
    }

    /**
     * One disclosure that is in the DOM only while it is worth having.
     *
     * Opening is a transition, not a keyframe: a chevron can be pressed twice in
     * half a second, and a transition retargets from whatever height the fold is
     * at while a keyframe would restart from zero. Height is measured here
     * (`scrollHeight`, which still answers while the fold is clipped shut) and
     * handed to the wrapper as pixels; the stylesheet owns the curve. There is
     * no `0fr → 1fr` trick on purpose: that only interpolates while the grid's
     * height is definite, which is exactly what an auto-height settings page
     * does not give it.
     *
     * The content mounts shut, is opened one painted frame later (only a painted
     * height can be transitioned away from), and on close stays in the tree for
     * the length of the fold so the row below slides up instead of teleporting.
     * While it is not open it is hidden and inert to the pointer, so a collapse
     * cannot be clicked through.
     */
    const Collapse: ReactNS.FC<CollapseProps> = ({ open, className, children }) => {
      const [present, setPresent] = useState(open)
      const [expanded, setExpanded] = useState(open)
      const alive = useRef(true)
      const node = useRef<HTMLDivElement | null>(null)
      const stopFrame = useRef<(() => void) | null>(null)
      const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        const settle = (apply: () => void): void => {
          if (alive.current) apply()
        }
        stopFrame.current?.()
        stopFrame.current = null
        if (exitTimer.current !== null) {
          clearTimeout(exitTimer.current)
          exitTimer.current = null
        }
        if (open) {
          if (present) {
            setExpanded(true)
            return
          }
          setPresent(true)
          stopFrame.current = afterPaint(() => settle(() => setExpanded(true)))
          return
        }
        setExpanded(false)
        if (present) exitTimer.current = setTimeout(() => settle(() => setPresent(false)), COLLAPSE_MS)
        // `present` is read, not depended on: it changes *from* this effect, and
        // a second run would apply `is-open` in the same frame the content
        // mounts, which is the one frame that cannot animate.
      }, [open])

      // The height the fold travels through.
      //
      // Closing (`open` is already false, the node is still here): pin the
      // height it has right now, then let go to zero on the next painted frame,
      // which is what turns the unmount into a slide instead of a jump. Opening
      // is the mirror: `expanded` arrives one painted frame after the node
      // mounts, so the shut height has been painted and can be transitioned
      // away from; the pinned pixels are released to `auto` once the fold has
      // arrived, so a version row added while it is open still fits.
      useEffect(() => {
        const panel = node.current
        if (!panel || !present) return
        if (!open) {
          panel.style.height = `${panel.scrollHeight}px`
          return afterPaint(() => {
            panel.style.height = '0px'
          })
        }
        if (!expanded) return
        panel.style.height = `${panel.scrollHeight}px`
        const timer = setTimeout(() => {
          panel.style.height = 'auto'
        }, COLLAPSE_MS)
        return () => clearTimeout(timer)
      }, [open, expanded, present])

      useEffect(
        () => () => {
          stopFrame.current?.()
          if (exitTimer.current !== null) clearTimeout(exitTimer.current)
        },
        [],
      )

      if (!present) return null
      return h(
        'div',
        { className: `dsmise-collapse ${className}${expanded ? ' is-open' : ''}`, ref: node },
        children,
      )
    }

    /**
     * The hint a version number carries when mise reports a newer release.
     *
     * It is a button, not just a badge: the thing a reader wants next is the
     * version list, and that is one click away instead of a trip through the
     * search box. The whole story lives in the title — which release, what is in
     * effect now, and what the config asks for — because the row itself has no
     * space for a sentence.
     */
    const UpdateBadge: ReactNS.FC<UpdateBadgeProps> = ({ update, t, onOpen }) =>
      h(
        'button',
        {
          type: 'button',
          className: 'dsmise-update',
          title: [
            `${t('updateHint')} ${update.latest}`,
            `${t('colCurrent')} ${update.current}`,
            // Only when it says something the version beside it does not: a
            // request that already names this exact version is the same number.
            update.requested && update.requested !== update.current
              ? `${t('updateConfig')} ${update.requested}`
              : '',
            t('updateOpen'),
          ]
            .filter(Boolean)
            .join(' · '),
          'aria-label': `${t('updateHint')} ${update.latest}`,
          onClick: onOpen,
        },
        `↑${update.latest}`,
      )

    // ── the page ──────────────────────────────────────────────────────────────

    function MisePanel({ t, invoke }: PageProps) {
      const [status, setStatus] = useState<StatusAnswer | null>(null)
      const [statusError, setStatusError] = useState<string | null>(null)
      const [cwd, setCwd] = useState('')
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState<Notice | null>(null)
      const [tool, setTool] = useState('')
      const [picker, setPicker] = useState<PickerState | null>(null)
      const [matches, setMatches] = useState<RegistryRow[] | null>(null)
      const [prune, setPrune] = useState<PruneState | null>(null)
      const [confirmKey, setConfirmKey] = useState('')
      const [progress, setProgress] = useState<JobSnapshot | null>(null)
      const [system, setSystem] = useState<SystemAnswer | null>(null)
      const [updates, setUpdates] = useState<UpdatesAnswer | null>(null)
      /** Tools whose version sub-table is open, by tool name. */
      const [openTools, setOpenTools] = useState<string[]>([])
      /** Whether the image's own toolchains are unfolded. */
      const [showSystem, setShowSystem] = useState(false)
      const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
      const progressTimer = useRef<ReturnType<typeof setInterval> | null>(null)
      const progressLog = useRef<HTMLPreElement | null>(null)
      const mounted = useRef(true)

      useEffect(() => {
        mounted.current = true
        return () => {
          mounted.current = false
          if (progressTimer.current !== null) clearInterval(progressTimer.current)
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        }
      }, [])

      /** The PATH snapshot is separate from status: it never blocks the panel. */
      const loadSystem = useCallback(async () => {
        try {
          const data = await invoke('system')
          if (mounted.current) setSystem(data)
        } catch (error) {
          if (mounted.current) setSystem({ error: reason(error), tools: [] })
        }
      }, [invoke])

      /**
       * The update check, on its own.
       *
       * It is the one read that leaves the machine — mise asks each tool's own
       * release source — so the table never waits for it: it rides beside the
       * other reads and its hint appears when it lands. A failure (offline, a
       * registry that will not answer) is not a panel state: no hint is better
       * than a wrong one, so the row simply carries none.
       */
      const checkUpdates = useCallback(async () => {
        try {
          const data = await invoke('updates', cwd ? { cwd } : {})
          if (mounted.current) setUpdates(data)
        } catch {
          if (mounted.current) setUpdates(null)
        }
      }, [cwd, invoke])

      const refresh = useCallback(
        async () => {
          setBusy('status')
          setStatusError(null)
          // Fired, not awaited: a slow release source must not hold the table.
          void checkUpdates()
          try {
            const data = await invoke('status', cwd ? { cwd } : {})
            if (!mounted.current) return
            setStatus(data)
            if (data.directory) setCwd(data.directory)
          } catch (error) {
            if (mounted.current) setStatusError(reason(error))
          } finally {
            if (mounted.current) setBusy('')
          }
          await loadSystem()
          // The prune verdict is what marks a version `·未使用` in the table, so
          // it comes from the same gesture instead of a second button asking the
          // same question. It is also the slowest call, so it runs last.
          try {
            const preview = await invoke('prune', { dryRun: true, cwd })
            if (mounted.current) setPrune({ ...preview, ran: false })
          } catch (error) {
            if (mounted.current) setPrune({ error: reason(error), candidates: [] })
          }
        },
        // The table mixes mise state with the PATH scan, so one refresh has to
        // update both or a column goes stale.
        [checkUpdates, cwd, invoke, loadSystem],
      )

      useEffect(() => {
        const node = progressLog.current
        if (node) node.scrollTop = node.scrollHeight
      }, [progress?.lines?.length, progress?.done])

      useEffect(() => {
        refresh()
        loadSystem()
        // First read only: later reads go through the directory control.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const loadTool = useCallback(
        async (name: string, prefix = '') => {
          const clean = String(name ?? '').trim()
          if (!clean) return
          setPicker({ tool: clean, prefix, loading: true, data: null, error: null })
          try {
            const data = await invoke('versions', { tool: clean, prefix, cwd })
            if (mounted.current) setPicker({ tool: clean, prefix, data, error: null })
          } catch (error) {
            if (mounted.current) setPicker({ tool: clean, prefix, data: null, error: reason(error) })
          }
        },
        [cwd, invoke],
      )

      const runWrite = useCallback(
        async <T extends WriteAnswer>(label: string, operation: () => Promise<T>): Promise<T | null> => {
          setBusy(label)
          setNotice(null)
          try {
            const result = await operation()
            if (!mounted.current) return result
            setNotice({
              kind: result && result.ok === false ? 'error' : 'ok',
              text: result ? `${label}：${result.ok === false ? t('failed') : t('ok')}（${t('exitCode')} ${result.exitCode ?? 0}）` : label,
              log: result?.output ?? '',
            })
            // A success message is a receipt, not a task: it clears itself. A
            // failure stays until it is read and closed.
            if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
            noticeTimer.current =
              result && result.ok === false
                ? null
                : setTimeout(() => {
                    noticeTimer.current = null
                    if (mounted.current) setNotice(null)
                  }, 8000)
            return result
          } catch (error) {
            if (mounted.current) setNotice({ kind: 'error', text: `${label}：${reason(error)}`, log: '' })
            return null
          } finally {
            if (mounted.current) setBusy('')
          }
        },
        [t],
      )

      /**
       * Poll the running command's output while a write is in flight.
       *
       * The channel answers one request at a time, so progress cannot be
       * pushed; the panel asks instead, and stops as soon as the write settles.
       */
      const stopTracking = () => {
        if (progressTimer.current !== null) {
          clearInterval(progressTimer.current)
          progressTimer.current = null
        }
      }

      const trackProgress = useCallback(async <T>(operation: () => Promise<T>): Promise<T> => {
        stopTracking()
        setProgress(null)
        progressTimer.current = setInterval(() => {
          invoke('progress')
            .then((snapshot) => {
              if (mounted.current) setProgress(snapshot)
            })
            .catch(() => {})
        }, 700)
        try {
          return await operation()
        } finally {
          stopTracking()
          // One last read so a short run still leaves its output on screen.
          try {
            const snapshot = await invoke('progress')
            if (mounted.current) setProgress(snapshot)
          } catch {
            // The write result already told the story.
          }
        }
      }, [invoke])

      const writeWithProgress = <T extends WriteAnswer>(label: string, operation: () => Promise<T>) =>
        runWrite(label, () => trackProgress(operation))

      /** Uninstall one explicit version: the chip turns into a confirm, then it goes. */
      const removeOne = async (spec: string) => {
        setConfirmKey('')
        const result = await writeWithProgress(`${t('uninstall')} ${spec}`, () => invoke('uninstall', { specs: [spec], cwd }))
        if (result && result.ok !== false) {
          await refresh()
          // The row leaves the table because the config request went with the
          // files. Say so — otherwise the row's disappearance reads as a glitch.
          if (mounted.current && (result.forgot?.length ?? 0) > 0) {
            setNotice({
              kind: 'ok',
              text: `${t('uninstall')} ${spec}：${t('ok')}（${t('forgotConfig')}）`,
              log: result.output ?? '',
            })
          }
        }
      }

      /**
       * Forget the config request behind one "未安装" row.
       *
       * Uninstall removes the request with the files, but a request can also
       * outlive them on its own — a `mise.toml` line for a tool nothing ever
       * installed, or one an older uninstall left behind. Until that line goes,
       * the row stays, so the row's own action is to drop it (`mise unuse`) from
       * the very file that declared it. Installs are untouched.
       */
      const dropRequest = async (name: string, sources: readonly string[]) => {
        for (const path of sources) {
          const result = await writeWithProgress(`${t('dropRequest')} ${name}`, () =>
            invoke('unuse', { tool: name, path, cwd }),
          )
          if (result?.ok === false) return
        }
        await refresh()
      }

      const installOne = async (spec: string) => {
        await writeWithProgress(`${t('install')} ${spec}`, () => invoke('install', { specs: [spec], cwd }))
        await refresh()
        if (picker?.tool) await loadTool(picker.tool, picker.prefix ?? '')
      }

      const installConfigured = async () => {
        await writeWithProgress(t('installAll'), () => invoke('install', { specs: [], cwd }))
        await refresh()
      }

      /** Pin `tool@version` in the current directory's mise.toml. */
      const useOne = async (spec: string) => {
        await writeWithProgress(`${t('setProject')} ${spec}`, () => invoke('use', { spec, scope: 'project', cwd }))
        await refresh()
        if (picker?.tool) await loadTool(picker.tool, picker.prefix ?? '')
      }

      /**
       * One entry point for the single search box.
       *
       * A tool name lists that tool's versions, and `tool@prefix` (`pnpm@12`)
       * lists the versions under that prefix — the box takes mise's own spelling
       * instead of asking for a prefix somewhere else. An unknown name does not
       * throw: mise answers an empty list, which is why emptiness — not an error
       * — is what sends the query on to the registry as a purpose. The registry
       * is always asked about the bare tool name: `pnpm@12` is not what it
       * indexes.
       */
      const findTool = async (value: string) => {
        const { tool: clean, prefix } = splitSpec(value)
        if (!clean) return
        setBusy('find')
        setNotice(null)
        setMatches(null)
        setPicker({ tool: clean, prefix, loading: true, data: null, error: null })

        let data: VersionsAnswer | null = null
        let toolError: ThrownMessage | null = null
        try {
          data = await invoke('versions', { tool: clean, prefix, cwd })
        } catch (error) {
          toolError = asThrown(error)
        }
        const isTool =
          data !== null &&
          ((data.available ?? []).length > 0 || (data.installed ?? []).length > 0 || Boolean(data.latest))
        if (isTool) {
          if (mounted.current) {
            setPicker({ tool: clean, prefix, data, error: null })
            setBusy('')
          }
          return
        }

        try {
          const registry = await invoke('registry', { query: clean })
          if (!mounted.current) return
          const found = registry.matches ?? []
          setMatches(found)
          // Nothing matched anywhere: the notice says so; an empty version card
          // on top of it would only add noise and a second input box.
          setPicker(null)
          if (!found.length) {
            setNotice({
              kind: 'error',
              text: t('notFound'),
              log: String(toolError?.message ?? ''),
            })
          }
        } catch (registryError) {
          if (!mounted.current) return
          setPicker({ tool: clean, data, error: null })
          setNotice({
            kind: 'error',
            text: reason(registryError),
            log: String(toolError?.message ?? ''),
          })
        } finally {
          if (mounted.current) setBusy('')
        }
      }


      const available = status?.available === true
      const readonly = status?.writeMode === 'readonly'
      const missingRows = useMemo(() => flatten(status?.missing), [status])

      /**
       * PATH hits that are not project tools: what the image ships and mise
       * neither manages nor is asked for here.
       *
       * They are the bulk of the scan (node, python3, go, ruby…) and none of
       * them is a row — a row would be a version list mise cannot fill. Folded
       * under the table they are still one click away, which is the point: the
       * question "is this toolchain the image's or mine?" has an answer, it just
       * does not deserve a line in the main table.
       */
      const systemRows = useMemo(() => {
        const known = new Set([
          ...Object.keys(status?.active ?? {}),
          ...Object.keys(status?.installed ?? {}),
          ...Object.keys(status?.missing ?? {}),
        ])
        return (system?.tools ?? [])
          .filter((entry) => !known.has(entry.name) && !entry.fromMise)
          .sort((left, right) => left.name.localeCompare(right.name))
      }, [status, system])

      /**
       * mise's "a newer release exists" verdicts, by tool name.
       *
       * A list per tool, because one verdict is about one version: a tool can
       * hold several versions and mise reports on the stale one, not on the one
       * in effect. They are grouped by tool here and filtered per row against
       * the version actually in effect (see `tableRows`).
       */
      const updatesByTool = useMemo(() => {
        const map = new Map<string, UpdateRow[]>()
        for (const entry of updates?.tools ?? []) map.set(entry.tool, [...(map.get(entry.tool) ?? []), entry])
        return map
      }, [updates])

      // One row per tool name, drawn from whichever of the four sources knows
      // about it, so nothing a tool knows is spread over four lists.
      //
      // The PATH scan annotates a row; it does not make one. A command the image
      // ships but this directory's config never names (`corepack`, `python3`…)
      // is not a project tool: mise has no versions to offer for it, so its row
      // would be a version list that can never fill. Its answer still rides along
      // as the `受管` / `系统` mark and the fallback version.
      const tableRows = useMemo<TableRow[]>(() => {
        const names = new Set([
          ...Object.keys(status?.active ?? {}),
          ...Object.keys(status?.installed ?? {}),
          ...Object.keys(status?.missing ?? {}),
        ])
        return [...names]
          .map((name) => {
            const activeEntries = status?.active?.[name] ?? []
            const installedEntries = status?.installed?.[name] ?? []
            const activeVersion = activeEntries.find((entry) => entry.active)?.version
            const sys = (system?.tools ?? []).find((entry) => entry.name === name)
            return {
              name,
              activeRow: activeEntries.find((entry) => entry.active) ?? activeEntries[0],
              installed: installedEntries,
              missing: status?.missing?.[name] ?? [],
              sys,
              systemCopy: systemCopyOf(sys),
              // Only the version in effect can be upgraded. mise reports on a
              // stale copy just as readily as on the one in effect — bun 1.4.0
              // left on disk beside an active 1.4.3 comes back as
              // `current: 1.4.0`, `latest: 1.4.3` — but that copy is something
              // to delete, not to bump, so a verdict about it is dropped here
              // rather than drawn. It also means a tool with nothing in effect
              // has no number to hang a hint on.
              updates: activeVersion
                ? (updatesByTool.get(name) ?? []).filter((entry) => entry.current === activeVersion)
                : [],
              managed: activeEntries.length > 0 || installedEntries.length > 0 || (status?.missing?.[name] ?? []).length > 0,
            }
          })
          .sort((a, b) => Number(b.managed) - Number(a.managed) || a.name.localeCompare(b.name))
      }, [status, system, updatesByTool])

      /**
       * Versions the prune preview called unused, by tool. Nothing prunes from
       * this page any more, so the read stays a preview: the mark tells the
       * sub-table which version is junk, and Uninstall is how it goes.
       */
      const unusedByTool = useMemo(() => {
        const map = new Map()
        // `prune.removed` / `prune.ran` describe a cleanup that actually ran;
        // this page no longer triggers one, so only the preview is read here.
        for (const row of prune?.candidates ?? []) {
          if (!row?.tool) continue
          map.set(row.tool, [...(map.get(row.tool) ?? []), String(row.version ?? '')])
        }
        return map
      }, [prune])

      if (statusError) {
        return h(
          'div',
          { className: 'dsmise' },
          h('h2', null, t('title')),
          h('div', { className: 'dsmise-alert error' }, statusError),
          h('div', null, h(Btn, { onClick: () => refresh() }, t('refresh'))),
        )
      }

      if (!status) return h('div', { className: 'dsmise' }, h('p', { className: 'dsmise-hint' }, t('loading')))

      return h(
        'div',
        { className: 'dsmise' },
        h('div', { className: 'dsmise-head' }, h('h2', null, t('title'))),

        // Only what went wrong is worth a line up here; the healthy version and
        // binary are in `mise_status` and the tools.
        available
          ? null
          : h(
              'div',
              { className: 'dsmise-alert warn' },
              h('div', null, h('strong', null, t('unavailable'))),
              h('div', null, status.error?.message ?? ''),
              h('div', null, t('unavailableHint')),
            ),

        readonly ? h('div', { className: 'dsmise-alert warn' }, t('writeReadonly')) : null,

        // The /tmp repair is silent when it works; this is the one case it
        // cannot fix (a real directory with content sitting on /tmp).
        status?.activation?.drift?.length
          ? h('div', { className: 'dsmise-alert warn' }, `${t('pathDrift')} ${status.activation.drift.join('、')}`)
          : null,

        notice
          ? h(
              'div',
              { className: `dsmise-alert has-close ${notice.kind}` },
              h(
                'div',
                { className: 'dsmise-notice-body' },
                h('div', null, notice.text),
                notice.log ? h(Log, { text: notice.log }) : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsmise-alert-close',
                  title: t('noticeClose'),
                  'aria-label': t('noticeClose'),
                  onClick: () => {
                    if (noticeTimer.current !== null) {
                      clearTimeout(noticeTimer.current)
                      noticeTimer.current = null
                    }
                    setNotice(null)
                  },
                },
                '✕',
              ),
            )
          : null,

        // The running command's own output, while it runs: a fresh install
        // downloads, unpacks and links, and silence reads as "stuck".
        progress && !progress.done
          ? h(
              'div',
              { className: 'dsmise-card' },
              h(
                'div',
                { className: 'dsmise-row' },
                h(
                  'div',
                  { className: 'dsmise-row-main' },
                  // A live mark, because a log that has not printed yet looks
                  // exactly like a command that hung.
                  h('span', { className: 'dsmise-live', 'aria-hidden': 'true' }),
                  h('span', { className: 'dsmise-name dsmise-mono' }, progress.label || t('install')),
                ),
                h('span', { className: 'dsmise-dim' }, `${t('progressElapsed')} ${Math.round((progress.elapsedMs ?? 0) / 1000)}s`),
              ),
              h(
                'pre',
                { className: 'dsmise-log', ref: progressLog },
                (progress.lines ?? []).join('\n') || t('progressWaiting'),
              ),
            )
          : null,

        // The one input that adds a tool, above the table: a version list and
        // its install button hang off it, so it opens the page. No heading and
        // no explanatory line — the placeholder names the two things it takes.
        h(
          Section,
          {},
          h(
            'div',
            { className: 'dsmise-row' },
            h('input', {
              className: 'dsmise-input grow',
              value: tool,
              placeholder: t('toolPlaceholder'),
              spellCheck: false,
              'aria-label': t('toolPlaceholder'),
              onChange: (event) => setTool(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') findTool(tool)
              },
            }),
            h(Btn, { kind: 'primary', disabled: Boolean(busy) || !tool.trim(), onClick: () => findTool(tool) }, t('find')),
            // Refresh sits beside the search it backs: Find re-asks the box's
            // question, Refresh re-reads everything the table shows.
            h(Btn, { disabled: busy === 'status', onClick: () => refresh() }, t('refresh')),
          ),
          matches
            ? h(
                'div',
                { className: 'dsmise-list' },
                h('span', { className: 'dsmise-dim' }, t('registryMatches')),
                matches.length
                  ? matches.map((entry) =>
                      h(
                        'div',
                        { key: entry.short, className: 'dsmise-row' },
                        h(
                          'div',
                          { className: 'dsmise-row-main' },
                          h('span', { className: 'dsmise-name dsmise-mono' }, entry.short),
                          h('span', { className: 'dsmise-dim' }, entry.description.slice(0, 90)),
                        ),
                        h(
                          Btn,
                          {
                            onClick: () => {
                              setTool(entry.short)
                              setMatches(null)
                              loadTool(entry.short)
                            },
                          },
                          t('query'),
                        ),
                      ),
                    )
                  : h('span', { className: 'dsmise-dim' }, t('versionsEmpty')),
              )
            : null,
          picker
            ? h(
                'div',
                { className: 'dsmise-card' },
                h(
                  'div',
                  { className: 'dsmise-row' },
                  h(
                    'div',
                    { className: 'dsmise-row-main' },
                    h('span', { className: 'dsmise-name dsmise-mono' }, picker.tool),
                    // The entry carried a prefix, so the list under this name is
                    // only part of it. Saying so is not enough — a narrowed list
                    // with no way back is a dead end — so the chip doubles as the
                    // way out: one click, and the whole tool is listed again.
                    picker.prefix
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dsmise-prefix dsmise-mono',
                            title: t('prefixHint'),
                            onClick: () => loadTool(picker.tool),
                          },
                          `@${picker.prefix}`,
                        )
                      : null,
                    picker.data?.latest ? h(Chip, null, `${t('latest')} ${picker.data.latest}`) : null,
                    picker.data ? h('span', { className: 'dsmise-dim' }, `${picker.data.remoteTotal} ${t('remoteTotal')}`) : null,
                  ),
                  // No Refresh here: the card is one answer to one question, and
                  // asking again costs a click on the version chip that opened it.
                  h(Btn, { onClick: () => setPicker(null) }, t('pickerClose')),
                ),
                picker.loading ? h('span', { className: 'dsmise-dim' }, t('loading')) : null,
                picker.error ? h('div', { className: 'dsmise-alert error' }, picker.error) : null,
                picker.data?.available?.length
                  ? h(
                      'div',
                      { className: 'dsmise-list' },
                      picker.data.available.map((entry) =>
                        h(
                          'div',
                          { key: entry.version, className: 'dsmise-ver' },
                          h(
                            'div',
                            { className: 'dsmise-row-main' },
                            h('span', { className: 'dsmise-mono' }, entry.version),
                            entry.active ? h(Chip, { state: 'active' }, t('versionActive')) : null,
                            entry.installed ? h(Chip, { state: 'installed' }, t('versionInstalled')) : null,
                            entry.createdAt ? h('span', { className: 'dsmise-dim' }, String(entry.createdAt).slice(0, 10)) : null,
                          ),
                          h(
                            'div',
                            { className: 'dsmise-row-main' },
                            entry.active
                              ? null
                              : entry.installed
                                ? h(
                                    Btn,
                                    { disabled: Boolean(busy), onClick: () => useOne(`${picker.tool}@${entry.version}`) },
                                    t('setProject'),
                                  )
                                : h(
                                    Btn,
                                    {
                                      kind: 'primary',
                                      disabled: Boolean(busy),
                                      onClick: () => installOne(`${picker.tool}@${entry.version}`),
                                    },
                                    busy === `${t('install')} ${picker.tool}@${entry.version}` ? t('installing') : t('install'),
                                  ),
                          ),
                        ),
                      ),
                    )
                  : picker.loading
                    ? null
                    : h('span', { className: 'dsmise-dim' }, t('versionsEmpty')),
              )
            : null,
        ),

        // One table for everything known about each tool: what is in effect,
        // how many versions are on disk, and what PATH resolves — the four lists
        // this used to be said little on their own, because the question is
        // always "what about this tool".
        // No heading and no explanatory line: the table explains itself, and it
        // carries no buttons of its own — every action belongs to a version, and
        // versions are in the sub-table.
        h(
          'div',
          { className: 'dsmise-sec' },
          // The one button outside that rule: a missing version is a batch, and
          // "install everything the config asks for" is about all of them at
          // once. Batch cleanup used to sit beside it; the table's own version
          // management replaced it, and a button that rewrites the install
          // directory should not be the easiest thing to hit while scanning a
          // list.
          missingRows.length
            ? h(
                'div',
                { className: 'dsmise-row-main dsmise-span-actions' },
                h(Btn, { kind: 'primary', disabled: Boolean(busy), onClick: installConfigured }, t('installAll')),
              )
            : null,
          !tableRows.length
            ? // Nothing to draw is an answer, not a state to wait in: the PATH
              // scan alone never makes a row, so a directory whose mise config
              // names no tool has an empty table by definition. The box above is
              // the way out of it.
              h('span', { className: 'dsmise-dim' }, t('noTools'))
            : h(
                'div',
                { className: 'dsmise-table' },
                h(
                  'div',
                  { className: 'dsmise-tr is-head' },
                  h('span', null, t('colTool')),
                  h('span', null, t('colCurrent')),
                  h('span', { style: { textAlign: 'right' } }, t('colInstalled')),
                ),
                tableRows.map((row) => {
                  const { name, activeRow, installed, missing, sys, systemCopy, updates: rowUpdates } = row
                  // The image's copy answers "what does this command run as,
                  // when mise has nothing here" — the version, not a label. The
                  // `系统` tag itself lives on its row in the sub-table.
                  const systemVersion = systemCopy?.version ?? null
                  const unused = unusedByTool.get(name) ?? []
                  // The hint belongs to the version it is about, and only the
                  // version in effect is left in `rowUpdates` — so it rides here
                  // when `current` names the number drawn in this row, and never
                  // anywhere else.
                  const update = activeRow ? rowUpdates.find((entry) => entry.current === activeRow.version) : undefined
                  // Every row that knows of a version opens. The row shows a
                  // count, not the versions, so a row with something on disk has
                  // something to open — and a version the config asks for but
                  // that is not on disk is a version too (the sub-table is where
                  // its Install lives). The image's copy is one of them as well.
                  const drillable = installed.length > 0 || missing.length > 0 || systemCopy !== null
                  const open = drillable && openTools.includes(name)
                  const toggle = () =>
                    setOpenTools((current) =>
                      current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name],
                    )
                  return h(
                    React.Fragment,
                    { key: name },
                    h(
                      'div',
                      { className: 'dsmise-tr' },
                      // Tool: just the name and the chevron into the version
                      // sub-table. The path itself is not drawn (hover shows it,
                      // and the sub-table has a column for it), and neither is a
                      // mark: whether a copy comes from mise or the image is a
                      // property of a version, so it is said beside that version.
                      h(
                        'div',
                        { className: 'dsmise-cell' },
                        h(
                          'div',
                          { className: 'dsmise-row-main' },
                          drillable
                            ? h(
                                'button',
                                {
                                  type: 'button',
                                  className: 'dsmise-tool',
                                  'aria-expanded': open,
                                  title: `${open ? t('drillClose') : t('drillOpen')} · ${name}`,
                                  onClick: toggle,
                                },
                                h(Chev, { open }),
                                h('span', { className: 'dsmise-name dsmise-mono' }, name),
                              )
                            : h('span', { className: 'dsmise-name dsmise-mono', title: sys?.path ?? undefined }, name),
                        ),
                      ),
                      // Current: the active version, else a warning that config
                      // wants what is not here, else the system version PATH falls
                      // back to. Which file asks for it is not drawn — the version
                      // is the answer — but hovering the version names that file.
                      // A newer release rides behind the version it supersedes, so
                      // the hint sits on this number — and only when the verdict is
                      // about this number; a verdict about another version on disk
                      // waits in the sub-table, beside that version. Clicking it
                      // opens the version list, where Install is one more click.
                      h(
                        'div',
                        { className: 'dsmise-cell' },
                        h(
                          'div',
                          { className: 'dsmise-row-main' },
                          activeRow
                            ? h('span', { className: 'dsmise-mono', title: activeRow.source ?? undefined }, activeRow.version)
                            : missing.length
                              ? h(
                                  React.Fragment,
                                  null,
                                  h(Chip, { state: 'warn' }, t('notInstalled')),
                                  h('span', { className: 'dsmise-dim dsmise-mono' }, missing.map((entry) => entry.version).join(' · ')),
                                )
                              : systemVersion
                                ? h('span', { className: 'dsmise-dim dsmise-mono' }, systemVersion)
                                : h('span', { className: 'dsmise-dim' }, '—'),
                          update
                            ? h(UpdateBadge, {
                                update,
                                t,
                                onOpen: () => {
                                  setTool(name)
                                  loadTool(name)
                                },
                              })
                            : null,
                        ),
                      ),
                      // How many versions are on disk — nothing more. Which ones
                      // they are, and what to do with them (state, path, remote
                      // versions, pin, uninstall), is the sub-table's answer: a
                      // row of chips made every project row as tall and as busy as
                      // its heaviest tool. The number is spelled out with its
                      // unit: a bare `2` sitting under a `已装` header reads as a
                      // quantity of something else, and the unit is what makes
                      // the column mean "versions".
                      h(
                        'div',
                        { className: 'dsmise-cell dsmise-cell-count' },
                        installed.length
                          ? h(
                              'span',
                              { className: 'dsmise-count dsmise-mono' },
                              `${installed.length} ${t(
                                installed.length === 1 ? 'installedTotalOne' : 'installedTotal',
                              )}`,
                            )
                          : h('span', { className: 'dsmise-dim dsmise-mono' }, `0 ${t('installedTotal')}`),
                      ),
                      // No actions here. Everything this table can do is done to
                      // a version — install one, enable one, uninstall one — and
                      // versions live in the sub-table, so that is the one place
                      // a button appears.
                    ),
                    // The sub-table: one line per version this tool answers with,
                    // with the room the row does not have — state, install path,
                    // and what can be done to that exact version (install, pin,
                    // uninstall). The versions the config asks for but the disk
                    // does not have are lines here too, and so is the image's own
                    // copy: everything this table knows about a version is in
                    // this one list, and a line that cannot be acted on simply
                    // has no buttons.
                    // The disclosure wrapper (see `Collapse`): the sub-table is
                    // in the tree only while it is open or folding shut, so a
                    // closed row costs nothing and a closing one still slides.
                    h(
                      Collapse,
                      { open, className: 'dsmise-sub-wrap' },
                      h(
                        'div',
                        { className: 'dsmise-sub' },
                        h(
                            'div',
                            { className: 'dsmise-sub-row is-head' },
                            h('span', null, t('colVersion')),
                            h('span', null, t('colState')),
                            h('span', null, t('colPath')),
                            h('span', { style: { textAlign: 'right' } }, t('colActions')),
                          ),
                          installed.map((entry) => {
                            const spec = `${name}@${entry.version}`
                            const confirming = confirmKey === spec
                            const isUnused = unused.includes(String(entry.version))
                            const isActive =
                              entry.active === true ||
                              (status?.active?.[name] ?? []).some((other) => String(other.version) === String(entry.version))
                            return h(
                              'div',
                              { key: entry.version, className: 'dsmise-sub-row' },
                              // No upgrade hint on a version line: a copy that is
                              // not in effect is old by definition and the answer
                              // for it is the uninstall beside it, not a bump.
                              h(
                                'div',
                                { className: 'dsmise-row-main' },
                                h('span', { className: 'dsmise-mono' }, entry.version),
                              ),
                              h(
                                'div',
                                { className: 'dsmise-row-main' },
                                isActive ? h(Chip, { state: 'active' }, t('versionActive')) : null,
                                isUnused ? h(Chip, { state: 'warn' }, t('pruneUnused')) : null,
                              ),
                              h(
                                'span',
                                { className: 'dsmise-dim dsmise-mono dsmise-ellipsis', title: entry.installPath ?? '' },
                                entry.installPath ?? '—',
                              ),
                              h(
                                'div',
                                { className: 'dsmise-row-main dsmise-cell-actions' },
                                // Remote versions are not offered here any more:
                                // the search box above already answers "which
                                // versions exist", and this column is about the
                                // versions already on disk.
                                isActive ? null : h(Btn, { disabled: Boolean(busy), onClick: () => useOne(spec) }, t('setProject')),
                                h(
                                  Btn,
                                  {
                                    kind: confirming ? 'danger' : undefined,
                                    disabled: Boolean(busy),
                                    title: t('uninstallHint'),
                                    onClick: () => (confirming ? removeOne(spec) : setConfirmKey(spec)),
                                  },
                                  confirming ? t('uninstallConfirm') : t('uninstall'),
                                ),
                              ),
                            )
                          }),
                          // Versions a config asks for that are not on disk. They
                          // are versions of this tool all the same — that is why
                          // the row exists at all — so the sub-table is where they
                          // are answered: Install puts one back, and 从配置移除
                          // forgets a request whose files never existed (the
                          // request outlives them, so `mise unuse` is the move).
                          missing.map((entry) =>
                            h(
                              'div',
                              { key: `missing:${entry.version}`, className: 'dsmise-sub-row is-missing' },
                              h('span', { className: 'dsmise-mono' }, entry.version),
                              h(
                                'div',
                                { className: 'dsmise-row-main' },
                                h(Chip, { state: 'warn' }, t('notInstalled')),
                              ),
                              // No install path to name: nothing was unpacked.
                              // The config file that asks for it is what hover
                              // shows instead, which is the useful half of "where".
                              h(
                                'span',
                                { className: 'dsmise-dim dsmise-mono dsmise-ellipsis', title: entry.source ?? '' },
                                '—',
                              ),
                              h(
                                'div',
                                { className: 'dsmise-row-main dsmise-cell-actions' },
                                h(
                                  Btn,
                                  {
                                    kind: 'primary',
                                    disabled: Boolean(busy),
                                    onClick: () => installOne(`${name}@${entry.version}`),
                                  },
                                  `${t('install')} ${entry.version}`,
                                ),
                                entry.source
                                  ? h(
                                      Btn,
                                      {
                                        disabled: Boolean(busy),
                                        title: t('dropRequestHint'),
                                        onClick: () =>
                                          dropRequest(
                                            name,
                                            [
                                              ...new Set(
                                                missing
                                                  .map((other) => other.source)
                                                  .filter((source): source is string => Boolean(source)),
                                              ),
                                            ],
                                          ),
                                      },
                                      t('dropRequest'),
                                    )
                                  : null,
                              ),
                            ),
                          ),
                          // The image's copy, read-only by construction: mise has
                          // no handle on it, so there is no Enable and no
                          // Uninstall to offer. Its version still belongs here —
                          // it is what the command answers with whenever mise has
                          // nothing in effect.
                          systemCopy
                            ? h(
                                'div',
                                { key: 'system', className: 'dsmise-sub-row is-system' },
                                h('span', { className: 'dsmise-mono' }, systemCopy.version ?? '—'),
                                h(
                                  'span',
                                  { className: 'dsmise-row-main', title: t('systemVersionHint') },
                                  h(Chip, { state: 'system' }, t('tagSystem')),
                                ),
                                h(
                                  'span',
                                  { className: 'dsmise-dim dsmise-mono dsmise-ellipsis', title: systemCopy.path },
                                  systemCopy.path,
                                ),
                                // Nothing to press: the actions column stays empty
                                // rather than offering a button the Host would have
                                // to refuse.
                                h('div', { className: 'dsmise-row-main dsmise-cell-actions' }),
                              )
                            : null,
                        ),
                      ),
                    )
                }),
              ),
          // The image's own toolchains, folded: one line that says how many
          // there are, and the list behind it for when the question is "is this
          // mine or the image's?". Read-only, so nothing here needs a button
          // beyond opening it — except the name, which opens that tool's version
          // list the same way a chip does.
          systemRows.length
            ? h(
                'div',
                { className: 'dsmise-fold' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsmise-fold-head',
                    'aria-expanded': showSystem,
                    title: t('systemFoldHint'),
                    onClick: () => setShowSystem((value) => !value),
                  },
                  h(Chev, { open: showSystem }),
                  h('span', null, `${t('systemTools')} · ${systemRows.length}`),
                ),
                h(
                  Collapse,
                  { open: showSystem, className: 'dsmise-fold-wrap' },
                  h(
                    'div',
                    { className: 'dsmise-fold-body' },
                    systemRows.map((entry) =>
                        h(
                          'div',
                          { key: entry.name, className: 'dsmise-sys-row' },
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'dsmise-tool',
                              title: entry.path,
                              onClick: () => {
                                setTool(entry.name)
                                loadTool(entry.name)
                              },
                            },
                            h('span', { className: 'dsmise-name dsmise-mono' }, entry.name),
                          ),
                          h('span', { className: 'dsmise-mono' }, entry.version ?? '—'),
                          h('span', { className: 'dsmise-dim dsmise-mono dsmise-ellipsis', title: entry.path }, entry.path),
                        ),
                      ),
                    ),
                ),
              )
            : null,
          // Only a failure is worth words: everything else the preview knows is
          // already in the table (the `·未使用` marks and the 清理 button itself).
          prune?.error ? h('div', { className: 'dsmise-alert error' }, prune.error) : null,
        ),
      )
    }

    // ── plugin wiring ─────────────────────────────────────────────────────────

    function apply(ctx: ClientContext): void {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-mise: dictionaries')
      const t = ctx.locale.bind(NS)
      const connection = ctx.get('connection')
      const invoke = makeInvoke(connection)

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = '@sovlookup/dsh-mise'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-mise: styles')

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => {
              let text = 'mise'
              try {
                text = t('nav')
              } catch {
                // A page whose locale is not ready still gets a readable row.
              }
              return h(NavLabel, { text })
            },
            inject: () => ({ t, invoke }),
          },
          (props) => h(PanelBoundary, { t: props.t }, h(MisePanel, props)),
        ),
      )
    }

    return { name: 'dsh-mise', inject: ['slots', 'locale', 'connection'], apply }
  },
})
