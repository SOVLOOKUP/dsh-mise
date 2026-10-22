/**
 * Client-half smoke test without a browser: a stub module table that hands the
 * bundle a real React, a stub `window` / `document`, and a mock Harness context
 * that records the `settings.section` registration — then the page is actually
 * rendered, so a broken bundle fails here instead of in the operator's settings
 * page.
 *
 * It runs against the *built* half (`dist/client.js`), because that is the file
 * the Harness serves to the browser.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'

interface ModuleLoaderEntry {
  id: string
  factory(require: (specifier: string) => unknown): {
    name: string
    inject: string[]
    apply(ctx: unknown): void
  }
}

interface SectionRegistration {
  config: { name: string; id: string; order: number }
  render: (props: Record<string, unknown>) => React.ReactElement
}

type Json = Record<string, unknown>

const results: { name: string; ok: boolean; detail: unknown }[] = []
const check = (name: string, condition: unknown, detail?: unknown): void => {
  results.push({ name, ok: Boolean(condition), detail })
}

// ── the environment the bundle expects ───────────────────────────────────────
const registered: ModuleLoaderEntry[] = []
const styleNodes: { dataset: Json; textContent: string; remove(): void }[] = []

const globals = globalThis as unknown as {
  window: unknown
  document: unknown
  IS_REACT_ACT_ENVIRONMENT: boolean
}
globals.window = { __ModuleLoader__: { load: (entry: ModuleLoaderEntry) => registered.push(entry) } }
globals.document = {
  createElement: () => {
    const node = { dataset: {} as Json, textContent: '', remove: () => undefined }
    styleNodes.push(node)
    return node
  },
  head: { appendChild: () => undefined },
}
globals.IS_REACT_ACT_ENVIRONMENT = true

// The bundle registers itself on import; there is no export to bind to.
const bundle = process.env['CLIENT_BUNDLE'] ?? '../dist/client.js'
const bundlePath = new URL(bundle, import.meta.url).pathname
const bundleText = readFileSync(bundlePath, 'utf8')

// The Harness serves a plugin bundle as a classic <script src>, so `export` or
// `import` at the top level is a browser SyntaxError even though Node accepts it.
let classicScriptError: string | null = null
try {
  new Script(bundleText, { filename: bundlePath })
} catch (error) {
  classicScriptError = error instanceof Error ? error.message : String(error)
}
check('the bundle parses as a classic script', classicScriptError === null, classicScriptError)
check(
  'the bundle has no top-level import or export',
  !/^(?:import|export)\b/m.test(bundleText),
  /^(?:import|export)\b.*$/m.exec(bundleText)?.[0],
)
await import(pathToFileURL(bundlePath).href)

check('bundle registers itself exactly once', registered.length === 1, registered.map((entry) => entry.id))
const entry = registered[0]
if (entry === undefined) throw new Error('test: dist/client.js registered no module')
check('registers under the package id', entry.id === '@sovlookup/dsh-mise', entry.id)

const moduleExports = entry.factory((specifier: string) => {
  if (specifier === 'react') return React
  throw new Error(`test: the client bundle asked for an unexpected module: ${specifier}`)
})
check('module exports a plugin', moduleExports.name === 'dsh-mise', moduleExports.name)
check(
  'injects the three client services it uses',
  JSON.stringify(moduleExports.inject) === '["slots","locale","connection"]',
  moduleExports.inject,
)

// ── one fake Host behind the panel's own channel ─────────────────────────────
const calls: { channel: string; method: string; args: Json }[] = []

const answers: Record<string, Json> = {
  status: {
    available: true,
    version: 'mise 2026.1.0',
    bin: '/usr/bin/mise',
    directory: '/workspace',
    configs: [],
    installed: {
      jq: [
        { version: '1.7.1', requested: '1.7', installed: true, active: true, source: '/workspace/mise.toml', installPath: '/home/x/.local/share/mise/installs/jq/1.7.1' },
        // A second version on disk, nothing asking for it: the row summarises it
        // as a chip, and the version sub-table is where it gets managed.
        { version: '1.6.0', requested: null, installed: true, active: false, source: null, installPath: '/home/x/.local/share/mise/installs/jq/1.6.0' },
      ],
      // One version only: no chevron, and its Uninstall stays in the row.
      node: [{ version: '20.20.2', requested: '20', installed: true, active: true, source: '/workspace/mise.toml', installPath: '/home/x/.local/share/mise/installs/node/20.20.2' }],
    },
    active: {
      jq: [{ version: '1.7.1', requested: '1.7', installed: true, active: true, source: '/workspace/mise.toml', installPath: null }],
      node: [{ version: '20.20.2', requested: '20', installed: true, active: true, source: '/workspace/mise.toml', installPath: null }],
    },
    missing: {},
    writeMode: 'auto',
    activation: { enabled: true, configured: true, shimsDir: '/home/x/.local/share/mise/shims', commands: ['jq'], drift: [] },
  },
  system: {
    tools: [
      // jq the way activation leaves it: the shim answers first, so the hit PATH
      // resolves to is mise's and carries no version of its own — the copy the
      // image ships is the Host's second pass down PATH.
      {
        name: 'jq',
        path: '/home/x/.local/share/mise/shims/jq',
        version: null,
        managedVersions: 2,
        managed: ['1.7.1', '1.6.0'],
        fromMise: true,
        systemPath: '/usr/bin/jq',
        systemVersion: 'jq-1.7',
      },
      // No shim in front of this one: the first hit is already the image's copy.
      {
        name: 'node',
        path: '/usr/local/bin/node',
        version: 'v24.0.0',
        managedVersions: 1,
        managed: ['20.20.2'],
        fromMise: false,
        systemPath: '/usr/local/bin/node',
        systemVersion: 'v24.0.0',
      },
      // In the image but not in the project's mise config: the panel must not
      // grow a row for it.
      {
        name: 'corepack',
        path: '/usr/local/bin/corepack',
        version: '0.29.0',
        managedVersions: 0,
        managed: [],
        fromMise: false,
        systemPath: '/usr/local/bin/corepack',
        systemVersion: '0.29.0',
      },
    ],
    scanned: 18,
  },
  // A version no config references: the sub-table marks it 未使用, and — since
  // the batch Prune button left the panel — nothing else acts on it.
  prune: { dryRun: true, candidates: [{ tool: 'jq', version: '1.6.0' }], output: '', exitCode: 0 },
  activation: { enabled: true, configured: true, shimsDir: '/home/x/.local/share/mise/shims', commands: ['jq'], drift: [] },
  progress: { id: 0, label: '', startedAt: 0, elapsedMs: 0, done: true, exitCode: null, lines: [] },
  // The hint on a version number: jq 1.7.1 in effect, 1.8.2 released. The Host
  // has already dropped the rows that are no hint at all (nothing installed,
  // or already at the newest release), so one row is what the panel sees.
  updates: {
    directory: '/workspace',
    tools: [{ tool: 'jq', current: '1.7.1', latest: '1.8.2', requested: '1.7' }],
  },
  unuse: { command: 'mise unuse jq', exitCode: 0, ok: true, tool: 'jq', path: '/workspace/.config/mise/config.toml', output: '' },
  versions: { tool: 'jq', directory: '/workspace', latest: '1.8.1', installed: [], active: [], available: [], remoteTotal: 0 },
  registry: { query: 'jq', total: 0, matches: [] },
}

const connection = {
  rpc: {
    call: async (channel: string, method: string, payload: Json) => {
      calls.push({ channel, method, args: (payload['args'] as Json | undefined) ?? {} })
      const value = answers[method.replace(/^mise\//, '')]
      if (value === undefined) throw new Error(`test: the panel called an unknown endpoint ${method}`)
      return { ok: true, value }
    },
  },
}

let section: SectionRegistration | undefined
const effects: unknown[] = []
const ctx = {
  effect(fn: () => unknown) {
    const disposer = fn()
    effects.push(disposer)
    return disposer
  },
  get(name: string) {
    return name === 'connection' ? connection : undefined
  },
  locale: {
    register: () => () => undefined,
    bind: () => (key: string) => key,
  },
  slots: {
    inject: (name: string, setup: () => unknown) => {
      check('registers into settings.section', name === 'settings.section', name)
      return setup()
    },
    register: (config: SectionRegistration['config'], render: SectionRegistration['render']) => {
      section = { config, render }
      return () => undefined
    },
  },
}

moduleExports.apply(ctx)

check('the stylesheet is injected through the effect seam', styleNodes.length === 1, styleNodes.length)
check('the stylesheet is scoped to this plugin', styleNodes[0]?.dataset['plugin'] === '@sovlookup/dsh-mise', styleNodes[0]?.dataset)
check('the stylesheet carries the panel CSS', (styleNodes[0]?.textContent.length ?? 0) > 1000, styleNodes[0]?.textContent.length)
check('the section is registered', section !== undefined)
check('section id is mise', section?.config.id === 'mise', section?.config.id)
check('section order is 48', section?.config.order === 48, section?.config.order)

// ── render the page the way the settings shell does ──────────────────────────
if (section === undefined) throw new Error('test: no settings.section was registered')
const t = (key: string): string => key
const invoke = async (method: string, args: Json = {}): Promise<unknown> => {
  const answer = await connection.rpc.call('/mise', `mise/${method}`, { args })
  return answer.value
}

// Narrowed once: the guard below does not survive into the async closure.
const view = section

let renderer: TestRenderer.ReactTestRenderer | undefined
await act(async () => {
  renderer = TestRenderer.create(view.render({ t, invoke }))
  // The panel's first read happens in an effect; one more flush settles it.
  await Promise.resolve()
  await Promise.resolve()
})

const tree = JSON.stringify(renderer?.toJSON() ?? null)
check('the page renders', (renderer?.toJSON() ?? null) !== null, tree.slice(0, 120))
check('the page is not the error boundary', !tree.includes('面板渲染失败'), tree.slice(0, 200))
check('the installer talks to its own channel', calls.every((c) => c.channel === '/mise'), [...new Set(calls.map((c) => c.channel))])
check(
  'the first read is mise/status',
  calls.some((c) => c.method === 'mise/status'),
  calls.map((c) => c.method),
)
check(
  'the PATH scan is requested too',
  calls.some((c) => c.method === 'mise/system'),
  calls.map((c) => c.method),
)
check(
  'the panel draws what the Host answered',
  tree.includes('jq') && tree.includes('1.7.1'),
  tree.slice(0, 400),
)
check(
  'a PATH-only command is not a project tool row',
  !tree.includes('corepack'),
  tree.slice(0, 400),
)

// ── one line for the image's own toolchains, the list behind it ──────────────
// The scan's commands are not project tools, so they are not rows; they are
// still one click away under the table, folded by default.
type Node = { type: unknown; props: Record<string, unknown>; children: (Node | string)[] | null }
const findNodes = (node: unknown, match: (entry: Node) => boolean, out: Node[] = []): Node[] => {
  if (node === null || typeof node !== 'object') return out
  const entry = node as Node
  if (typeof entry.type === 'string' && entry.props && match(entry)) out.push(entry)
  for (const child of entry.children ?? []) findNodes(child, match, out)
  return out
}
const buttonsNow = (match: (entry: Node) => boolean): Node[] =>
  findNodes(renderer?.toJSON() ?? null, (entry) => entry.type === 'button' && match(entry))
const click = async (node: Node | undefined): Promise<void> => {
  const onClick = node?.props['onClick']
  if (typeof onClick !== 'function') throw new Error('test: that node has no click handler')
  await act(async () => {
    ;(onClick as () => void)()
    await Promise.resolve()
  })
}

check('the image toolchains are folded away', tree.includes('systemTools'), tree.slice(0, 400))
const foldHead = buttonsNow((entry) => String(entry.props['className'] ?? '').includes('dsmise-fold-head'))[0]
check('the fold is a real button with its count', foldHead !== undefined, buttonsNow(() => true).length)
check('the fold starts closed', foldHead?.props['aria-expanded'] === false, foldHead?.props['aria-expanded'])
await click(foldHead)
const unfoldedTree = JSON.stringify(renderer?.toJSON() ?? null)
check('unfolding lists what the image ships', unfoldedTree.includes('corepack'), unfoldedTree.slice(0, 500))
check('unfolding shows its path and version', unfoldedTree.includes('/usr/local/bin/corepack') && unfoldedTree.includes('0.29.0'), unfoldedTree.slice(0, 500))
const foldBody = findNodes(renderer?.toJSON() ?? null, (entry) => String(entry.props['className'] ?? '') === 'dsmise-fold-body')[0]
const foldBodyTree = JSON.stringify(foldBody ?? null)
check(
  'a system row is read-only, not a version table',
  !foldBodyTree.includes('uninstall') && !foldBodyTree.includes('dsmise-sub-row'),
  foldBodyTree.slice(0, 500),
)

// ── the name carries no chip at all ──────────────────────────────────────────
// Being mise's copy is the normal case, and the image's copy is a version, not a
// property of the tool: `受管` said nothing, and `系统` now hangs on the version
// row inside the sub-table instead of on the tool's own line.
check('no managed chip beside the tool name', !tree.includes('tagMise'), tree.slice(0, 500))
check('the tool row carries no 系统 tag', !tree.includes('tagSystem'), tree.slice(0, 500))

// ── the installed column is a count, spelled out ─────────────────────────────
// Which versions are on disk belongs in the sub-table; the row answers "how
// many" and nothing else — but the number carries its unit, because a bare `2`
// under a `已装` header is a quantity of something the header never named.
const counts = () =>
  findNodes(renderer?.toJSON() ?? null, (entry) => String(entry.props['className'] ?? '').includes('dsmise-count')).map(
    (entry) => entry.children?.[0],
  )
check('the row counts its versions instead of listing them', counts().length === 2, counts())
// jq holds two versions, node one; the row that holds nothing draws a dim 0
// and gets no count element at all. The locale is stubbed to echo keys, so the
// unit shows up as the plural key and the single-version row as the singular.
check('the count is the number on disk plus its unit', counts().join(',') === '2 installedTotal,1 installedTotalOne', counts())

// ── the table rows carry no buttons ──────────────────────────────────────────
// Every action the page offers acts on one version — install it, enable it,
// uninstall it — so the rows are read-only and the buttons live in the version
// sub-table behind the chevron. A row is not a place to press anything.
const rowActionButtons = findNodes(
  renderer?.toJSON() ?? null,
  (entry) => String(entry.props['className'] ?? '').includes('dsmise-tr'),
).flatMap((row) => findNodes(row, (entry) => String(entry.props['className'] ?? '').includes('dsmise-btn')))
check('no action buttons in the tool table', rowActionButtons.length === 0, rowActionButtons.map((entry) => entry.children))
check('the tool table has no actions column', !tree.includes('colActions'), tree.slice(0, 600))

// ── nothing prunes from the panel ────────────────────────────────────────────
// The preview still runs (it decides the 未使用 mark), but the button that
// rewrote the install directory is gone.
const dangerButtons = () => buttonsNow((entry) => String(entry.props['className'] ?? '').split(' ').includes('danger'))
check('no Prune button above the table', dangerButtons().length === 0, dangerButtons().map((entry) => entry.children))

// ── the version sub-table ────────────────────────────────────────────────────
// The row shows a count, so any row with something on disk opens its versions:
// state, path, remote versions, pin, uninstall all live in there.
const uninstallButtons = () => buttonsNow((entry) => String(entry.props['title'] ?? '') === 'uninstallHint')
check('the row itself carries no per-version button', uninstallButtons().length === 0, uninstallButtons().length)
const drills = buttonsNow((entry) => String(entry.props['title'] ?? '').startsWith('drillOpen'))
check(
  'every installed row offers a drill',
  drills.length === 2 && drills.some((entry) => String(entry.props['title'] ?? '').endsWith('jq')),
  drills.map((entry) => entry.props['title']),
)
const drill = drills[0]
await click(drill)
const drilledTree = JSON.stringify(renderer?.toJSON() ?? null)
check('the sub-table lists every installed version', drilledTree.includes('1.7.1') && drilledTree.includes('1.6.0'), drilledTree.slice(0, 600))
check('the sub-table names its columns', drilledTree.includes('colVersion') && drilledTree.includes('colState') && drilledTree.includes('colPath'), drilledTree.slice(0, 600))
check(
  'the sub-table is where a version is managed',
  drilledTree.includes('uninstall') && drilledTree.includes('setProject'),
  drilledTree.slice(0, 800),
)
// Browsing remote versions belongs to the search box above; the sub-table is
// about the versions already on disk, so it offers no such button.
check('the sub-table does not open the version list', !drilledTree.includes('remoteVersions'), drilledTree.slice(0, 800))
check('both versions can be uninstalled from it', uninstallButtons().length === 2, uninstallButtons().length)
check('the preview still marks the unused version', drilledTree.includes('pruneUnused') && drilledTree.includes('versionActive'), drilledTree.slice(0, 800))
// ── the image's copy is a version row, not a tag on the tool ─────────────────
// jq answers with two mise versions and one the image ships; all three are
// lines of the same sub-table, and only the image's line is inert.
check(
  'the image copy is listed as a version',
  drilledTree.includes('jq-1.7') && drilledTree.includes('/usr/bin/jq'),
  drilledTree.slice(0, 900),
)
check('that row wears the 系统 tag', drilledTree.includes('tagSystem'), drilledTree.slice(0, 900))
const systemRow = findNodes(
  renderer?.toJSON() ?? null,
  (entry) => String(entry.props['className'] ?? '') === 'dsmise-sub-row is-system',
)[0]
check('the system row is drawn once, in this sub-table', systemRow !== undefined, systemRow?.props)
check(
  'the system row offers nothing to press',
  findNodes(systemRow ?? null, (entry) => entry.type === 'button').length === 0,
  findNodes(systemRow ?? null, (entry) => Boolean(entry.props['className'])).map((entry) => entry.props['className']),
)
const collapse = buttonsNow((entry) => String(entry.props['title'] ?? '').startsWith('drillClose'))[0]
check('the drill can be closed again', collapse !== undefined, collapse?.props['title'])
await click(collapse)
// Closing is animated: the sub-table stays in the tree for the length of the
// fold (so the row below slides back up instead of teleporting), and is gone
// once that is over. `COLLAPSE_MS` is 220 — wait it out, then look.
const folded = () =>
  findNodes(
    renderer?.toJSON() ?? null,
    (entry) => String(entry.props['className'] ?? '').includes('dsmise-sub-wrap'),
  )[0]
check('closing starts the fold', folded() !== undefined && !String(folded()?.props['className']).includes('is-open'), folded()?.props['className'])
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300))
})
check(
  'closing drops the sub-table once it has folded',
  !JSON.stringify(renderer?.toJSON() ?? null).includes('colVersion') && folded() === undefined,
  JSON.stringify(renderer?.toJSON() ?? null).slice(0, 400),
)
check(
  'the update check is its own read',
  calls.some((c) => c.method === 'mise/updates'),
  calls.map((c) => c.method),
)
// The hint is the newest release, drawn after the version in effect — this is
// the whole feature: a version number that says a newer one exists.
check('a newer release rides on the version number', tree.includes('↑1.8.2'), tree.slice(0, 600))

// ── regression: a configured version that is no longer on disk ───────────────
// `mise ls --json` also echoes the versions a config asks for after an
// uninstall; the Host narrows that away (an uninstalled version arrives under
// `missing`, never under `installed`/`active`). Drawn wrongly it was an
// installed chip with an Uninstall button and a `·生效` mark, and the Install
// button that would have put the tool back was gone with it.
answers['status'] = {
  available: true,
  version: 'mise 2026.1.0',
  bin: '/usr/bin/mise',
  directory: '/workspace',
  configs: [],
  installed: {},
  active: {},
  missing: {
    jq: [
      {
        version: '1.8.2',
        requested: '1.8.2',
        installed: false,
        active: false,
        source: '/workspace/.config/mise/config.toml',
        installPath: null,
      },
    ],
  },
  writeMode: 'auto',
  activation: { enabled: true, configured: true, shimsDir: '/home/x/.local/share/mise/shims', commands: [], drift: [] },
}
const staleCalls = calls.length
await act(async () => {
  renderer = TestRenderer.create(view.render({ t, invoke }))
  await Promise.resolve()
  await Promise.resolve()
})
const goneTree = JSON.stringify(renderer?.toJSON() ?? null)
check('a configured version that is gone keeps its row', goneTree.includes('jq'), goneTree.slice(0, 300))
check('it reads as not installed', goneTree.includes('notInstalled'), goneTree.slice(0, 300))
// The row itself presses nothing: the version the config asks for is a line in
// the sub-table, so Install and Drop config are down there with it.
check('no Uninstall anywhere for a version that is not there', !goneTree.includes('uninstall'), goneTree.slice(0, 400))
check('no "in effect" mark on a version that is not there', !goneTree.includes('versionActive'), goneTree.slice(0, 400))
// The update hint rides on a version number, and this row has none: the Host's
// verdict must not turn into a marker floating beside "未安装".
check('no update hint without a version to hang it on', !goneTree.includes('↑1.8.2'), goneTree.slice(0, 400))
check('the reread went through the channel again', calls.length > staleCalls, calls.length - staleCalls)
// Nothing is on disk, but the image still ships jq: that copy is a version this
// tool answers with, so the row opens on it instead of pointing at an empty
// sub-table.
const goneDrills = buttonsNow((entry) => String(entry.props['title'] ?? '').startsWith('drillOpen'))
check(
  'a row with no managed version still opens on the image copy',
  goneDrills.some((entry) => String(entry.props['title'] ?? '').endsWith('jq')),
  goneDrills.map((entry) => entry.props['title']),
)
await click(goneDrills.find((entry) => String(entry.props['title'] ?? '').endsWith('jq')))
const goneDrilledTree = JSON.stringify(renderer?.toJSON() ?? null)
check(
  'and the sub-table says what the image ships',
  goneDrilledTree.includes('tagSystem') && goneDrilledTree.includes('jq-1.7'),
  goneDrilledTree.slice(0, 900),
)
check(
  'no Uninstall appears for it either',
  !goneDrilledTree.includes('uninstallHint'),
  goneDrilledTree.slice(0, 900),
)
check(
  'the version the config asks for is a line in the sub-table, with its Install',
  goneDrilledTree.includes('install 1.8.2') && goneDrilledTree.includes('notInstalled'),
  goneDrilledTree.slice(0, 1200),
)
// The row's other exit: forgetting the request that keeps asking for a tool
// nothing ever installed. Uninstall cannot reach this state — the request
// outlived its files — so `mise unuse`, aimed at the declaring file, is the move.
check('it offers dropping the config request', goneDrilledTree.includes('dropRequest'), goneDrilledTree.slice(0, 1200))
const dropBtn = buttonsNow((entry) => String(entry.props['title'] ?? '').includes('dropRequestHint'))[0]
check('the drop action explains itself on hover', dropBtn !== undefined)
const dropFrom = calls.length
await click(dropBtn)
check(
  'dropping the request edits the file that declared it',
  calls
    .slice(dropFrom)
    .some((c) => c.method === 'mise/unuse' && c.args['tool'] === 'jq' && c.args['path'] === '/workspace/.config/mise/config.toml'),
  calls.slice(dropFrom).map((c) => `${c.method}:${JSON.stringify(c.args)}`),
)

// ── regression: a verdict about a stale copy is not an upgrade offer ─────────
// `mise outdated --inactive --bump` answers about *some* installed version, and
// a tool can hold two: bun 1.4.0 left on disk beside an active 1.4.3 comes back
// as `current: 1.4.0`, `latest: 1.4.3`. Field report (2026-10-22): "bun 已经安装
// 最新版本了，1.4.0 就不需要提示升级了" — an old copy is old by definition, so
// the answer for it is the uninstall beside it, not a bump. Keyed by tool name
// this drew `1.4.3 ↑1.4.3`; keyed by version it drew `1.4.0 ↑1.4.3` on a line
// whose button says 卸载. Neither is an upgrade, so the verdict is dropped.
answers['status'] = {
  available: true,
  version: 'mise 2026.1.0',
  bin: '/usr/bin/mise',
  directory: '/workspace',
  configs: [],
  installed: {
    bun: [
      { version: '1.4.0', requested: null, installed: true, active: false, source: null, installPath: '/home/x/.local/share/mise/installs/bun/1.4.0' },
      { version: '1.4.3', requested: '1.4.3', installed: true, active: true, source: '/workspace/.config/mise/config.toml', installPath: '/home/x/.local/share/mise/installs/bun/1.4.3' },
    ],
  },
  active: {
    bun: [{ version: '1.4.3', requested: '1.4.3', installed: true, active: true, source: '/workspace/.config/mise/config.toml', installPath: null }],
  },
  missing: {},
  writeMode: 'auto',
  activation: { enabled: true, configured: true, shimsDir: '/home/x/.local/share/mise/shims', commands: [], drift: [] },
}
answers['system'] = { tools: [], scanned: 18 }
answers['prune'] = { dryRun: true, candidates: [], output: '', exitCode: 0 }
answers['updates'] = {
  directory: '/workspace',
  tools: [{ tool: 'bun', current: '1.4.0', latest: '1.4.3', requested: null }],
}
await act(async () => {
  renderer = TestRenderer.create(view.render({ t, invoke }))
  await Promise.resolve()
  await Promise.resolve()
})
const staleTree = JSON.stringify(renderer?.toJSON() ?? null)
check('the row shows the version in effect', staleTree.includes('1.4.3'), staleTree.slice(0, 400))
// The verdict is about 1.4.0, so it says nothing about 1.4.3 — the number drawn
// on the row — and must not be drawn beside it.
check(
  'no upgrade hint beside a version that is already the newest',
  !staleTree.includes('↑1.4.3'),
  staleTree.slice(0, 700),
)
const staleDrills = buttonsNow((entry) => String(entry.props['title'] ?? '').startsWith('drillOpen'))
await click(staleDrills.find((entry) => String(entry.props['title'] ?? '').endsWith('bun')))
const staleDrilled = JSON.stringify(renderer?.toJSON() ?? null)
check(
  'both copies are still listed',
  staleDrilled.includes('1.4.0') && staleDrilled.includes('1.4.3'),
  staleDrilled.slice(0, 1200),
)
// The stale copy's own line is where a per-version hint used to land. It must be
// bare now: nothing on the page offers an upgrade at all, because nothing here
// is behind — 1.4.3 is installed, 1.4.0 can only be deleted.
check('an old copy on disk offers no upgrade either', !staleDrilled.includes('↑'), staleDrilled.slice(0, 1200))

// ── regression: an empty project is an answer, not a spinner ─────────────────
// The PATH scan only annotates rows, so a directory whose mise config names no
// tool has an empty table — and used to sit on "读取中…" forever because the
// empty branch reused the loading label.
answers['status'] = {
  available: true,
  version: 'mise 2026.1.0',
  bin: '/usr/bin/mise',
  directory: '/workspace',
  configs: [],
  installed: {},
  active: {},
  missing: {},
  writeMode: 'auto',
  activation: { enabled: true, configured: true, shimsDir: '/home/x/.local/share/mise/shims', commands: [], drift: [] },
}
answers['updates'] = { directory: '/workspace', tools: [] }
await act(async () => {
  renderer = TestRenderer.create(view.render({ t, invoke }))
  await Promise.resolve()
  await Promise.resolve()
})
const emptyTree = JSON.stringify(renderer?.toJSON() ?? null)
check('an empty project says so', emptyTree.includes('noTools'), emptyTree.slice(0, 400))
check('an empty project never keeps spinning', !emptyTree.includes('loading'), emptyTree.slice(0, 400))
// A PATH-only scan result still makes no row: corepack is in the scan, not here.
check('the PATH scan still makes no row on its own', !emptyTree.includes('corepack'), emptyTree.slice(0, 400))

// ── the search box takes mise's own `tool@prefix` spelling ───────────────────
// `pnpm@12` is how `mise ls-remote pnpm@12` narrows a list, so the box accepts
// it as written: the placeholder names that spelling, the half after the `@`
// travels down as `prefix`, and the tool name stays `pnpm` — the installed list
// belongs to the tool, not to the prefix.
const searchBox = findNodes(
  renderer?.toJSON() ?? null,
  (entry) => entry.type === 'input' && String(entry.props['className'] ?? '').includes('dsmise-input'),
)[0]
// The locale is stubbed to echo keys, so the placeholder here is its key; the
// wording itself is checked in the bundle, in both languages.
check('the search box wears the placeholder', searchBox?.props['placeholder'] === 'toolPlaceholder', searchBox?.props['placeholder'])
check(
  'the placeholder names the version spelling in both languages',
  (bundleText.match(/pnpm@12/g) ?? []).length >= 2,
  (bundleText.match(/pnpm@12/g) ?? []).length,
)
await act(async () => {
  ;(searchBox?.props['onChange'] as ((event: unknown) => void) | undefined)?.({ target: { value: 'pnpm@12' } })
  await Promise.resolve()
})
const findButton = buttonsNow((entry) => entry.children?.length === 1 && entry.children[0] === 'find')[0]
check('the search box has its Find button', findButton !== undefined, buttonsNow(() => true).length)
const beforeFind = calls.length
await click(findButton)
const prefixed = calls.slice(beforeFind).filter((entry) => entry.method === 'mise/versions')
check(
  'a version-spelling entry is split into tool and prefix',
  prefixed.some((entry) => entry.args['tool'] === 'pnpm' && entry.args['prefix'] === '12'),
  prefixed.map((entry) => JSON.stringify(entry.args)),
)
const prefixedTree = JSON.stringify(renderer?.toJSON() ?? null)
// The narrowing is visible and reversible: a list silently cut down to 12.x
// with no way back to the whole tool is a dead end.
check(
  'the card says which prefix it is narrowed to',
  prefixedTree.includes('dsmise-prefix') && prefixedTree.includes('@12'),
  prefixedTree.slice(0, 800),
)
const clearPrefix = buttonsNow((entry) => String(entry.props['className'] ?? '').includes('dsmise-prefix'))[0]
const beforeClear = calls.length
await click(clearPrefix)
check(
  'dropping the prefix lists the whole tool again',
  calls
    .slice(beforeClear)
    .some((entry) => entry.method === 'mise/versions' && entry.args['tool'] === 'pnpm' && entry.args['prefix'] === ''),
  calls.slice(beforeClear).map((entry) => `${entry.method}:${JSON.stringify(entry.args)}`),
)

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '  -> ' + JSON.stringify(r.detail)}`)
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
