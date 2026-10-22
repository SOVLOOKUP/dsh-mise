/**
 * Host-half smoke test without a harness: a mock Context that emulates exactly
 * the seam this plugin touches (inject / effect / on / tools.register /
 * connection.rpc.handle), then every panel method and every tool.
 *
 * It runs against the *built* half (`dist/index.js`), because that is the file
 * the Harness loads — a passing source-level test would prove nothing about the
 * artifact.
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../dist/index.js'
import { narrowOutdated, planUnuse } from '../dist/mise.js'

/** One tool answer, as the tools return it: JSON text. */
type ToolValue = { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }

/** One RPC answer from the panel channel. */
type RpcValue = { ok: true; value: Record<string, unknown> } | { ok: false; error: { code: string; message: string } }

/** One `tools/pre-execute` decision, or the `next` sentinel the mock returns. */
type Decision = { kind: string; reason?: string } | 'next'

interface RegisteredTool {
  name: string
  execute(args: unknown, exec: { name: string; signal?: AbortSignal }): Promise<string>
}

interface Harness {
  readonly tools: Map<string, RegisteredTool>
  readonly channels: Map<string, (method: string, payload: unknown, signal: AbortSignal) => Promise<RpcValue>>
  readonly gate: { event: string; cb: (exec: unknown, next: () => Promise<Decision>) => Promise<Decision> }[]
  readonly disposers: unknown[]
}

/**
 * The smallest Context that satisfies `apply`.
 *
 * Every member it fakes is one this plugin actually calls; anything else would
 * be a service the plugin never touches.
 */
function makeCtx(config: unknown): Harness {
  const tools = new Map<string, RegisteredTool>()
  const gate: Harness['gate'] = []
  const channels: Harness['channels'] = new Map()
  const disposers: unknown[] = []
  const ctx = {
    effect(fn: () => unknown) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    on(event: string, cb: Harness['gate'][number]['cb']) {
      gate.push({ event, cb })
    },
    tools: {
      register(def: RegisteredTool) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    inject(deps: string[], fn: (child: unknown) => void) {
      if (deps.includes('connection')) {
        fn({
          connection: {
            rpc: {
              handle(channel: string, handler: Harness['channels'] extends Map<string, infer H> ? H : never) {
                if (channels.has(channel)) {
                  throw new Error(`connection: shared RPC channel ${channel} already has an interceptor`)
                }
                channels.set(channel, handler)
                return () => channels.delete(channel)
              },
              intercept() {
                throw new Error('connection: shared RPC channel "/api" already has an interceptor')
              },
            },
          },
          webServer: {},
        })
      } else {
        fn(ctx)
      }
    },
  }
  apply(ctx as unknown as Context, config)
  return { tools, channels, gate, disposers }
}

const results: { name: string; ok: boolean; detail: unknown }[] = []
const check = (name: string, condition: unknown, detail?: unknown): number =>
  results.push({ name, ok: Boolean(condition), detail })

// 1. apply() must not throw and must mount exactly one channel, not /api.
const live = makeCtx({ cwd: '/tmp', env: { MISE_DATA_DIR: process.env.MISE_TEST_DATA ?? '/tmp/misetest/data' } })
check('mounts /mise channel', live.channels.has('/mise'), [...live.channels.keys()])
check('never touches /api', !live.channels.has('/api'))
check('registers 9 tools', live.tools.size === 9, [...live.tools.keys()])
check(
  'the new tools are all there',
  ['mise_system', 'mise_activate', 'mise_progress'].every((name) => live.tools.has(name)),
  [...live.tools.keys()],
)

const call = live.channels.get('/mise')
if (call === undefined) throw new Error('test: /mise channel was not mounted')
const signal = (): AbortSignal => new AbortController().signal

const status = await call('status', { args: { cwd: '/tmp' } }, signal())
check('status ok', status.ok === true && status.value['available'] === true, status.ok ? undefined : status.error)
const statusValue = status.ok ? status.value : {}
check(
  'status carries activation',
  typeof (statusValue['activation'] as { shimsDir?: unknown } | undefined)?.shimsDir === 'string',
  statusValue['activation'],
)
check('status carries writeMode', typeof statusValue['writeMode'] === 'string', statusValue['writeMode'])
// Shape only: which versions exist depends on the machine, and the test must
// never assume or mutate the real install directory.
const installedShape = statusValue['installed']
check(
  'status lists installs as version arrays',
  installedShape !== null && typeof installedShape === 'object' && Object.values(installedShape).every(Array.isArray),
  JSON.stringify(Object.keys(installedShape ?? {})),
)

const versions = await call('versions', { args: { tool: 'jq', cwd: '/tmp' } }, signal())
check(
  'versions ok',
  versions.ok === true && Array.isArray((versions.value as { available?: unknown }).available),
  versions.ok ? Object.keys(versions.value) : versions.error,
)

const registry = await call('registry', { args: { query: 'jq' } }, signal())
check(
  'registry ok',
  registry.ok === true && ((registry.value as { matches?: unknown[] }).matches?.length ?? 0) > 0,
  registry.ok ? registry.value['total'] : registry.error,
)

const unknown = await call('nope', {}, signal())
check(
  'unknown method -> mise/unknown-endpoint',
  unknown.ok === false && unknown.error.code === 'mise/unknown-endpoint',
  unknown.ok ? undefined : unknown.error,
)

const pruneDry = await call('prune', { args: { cwd: '/tmp', dryRun: true } }, signal())
check(
  'prune dry-run ok',
  pruneDry.ok === true && Array.isArray((pruneDry.value as { candidates?: unknown }).candidates),
  pruneDry.ok ? undefined : pruneDry.error,
)

// 2. readonly must refuse every write through the channel too.
const ro = makeCtx({ writeMode: 'readonly' })
const roCall = ro.channels.get('/mise')
if (roCall === undefined) throw new Error('test: readonly /mise channel was not mounted')
const readonlyCalls: [string, Record<string, unknown>][] = [
  ['install', { specs: ['jq@1.6'] }],
  ['use', { spec: 'jq@1.8.2' }],
  ['prune', { dryRun: false }],
  ['uninstall', { specs: ['jq@1.6'] }],
  ['activate', {}],
]
for (const [method, payload] of readonlyCalls) {
  const r = await roCall(method, { args: payload }, signal())
  check(`readonly refuses ${method}`, r.ok === false && r.error.code === 'mise/write-disabled', r.ok ? undefined : r.error.code)
}

// 3. The approval gate only covers the mutating tools, and only in `ask`.
const ask = makeCtx({ writeMode: 'ask' })
const gated = ask.gate.find((g) => g.event === 'tools/pre-execute')?.cb
if (gated === undefined) throw new Error('test: approval gate was not registered')
const exec = (name: string, args: Record<string, unknown>): Promise<Decision> =>
  gated({ name, arguments: args }, async () => 'next')
/** The `kind` of an ask decision, or `undefined` for the pass-through string. */
const asked = async (name: string, args: Record<string, unknown>): Promise<string | undefined> => {
  const decision = await exec(name, args)
  return typeof decision === 'string' ? undefined : decision.kind
}
check('gate: install asks', (await asked('mise_install', { specs: ['jq@1.6'] })) === 'ask')
check('gate: read tool passes', (await exec('mise_status', {})) === 'next')
check('gate: prune dry-run passes', (await exec('mise_prune', { dryRun: true })) === 'next')
check('gate: prune real asks', (await asked('mise_prune', { dryRun: false })) === 'ask')
check('gate: uninstall asks', (await asked('mise_uninstall', { specs: ['jq@1.6'] })) === 'ask')
check('gate: activate asks', (await asked('mise_activate', { enabled: true })) === 'ask')
check('gate: progress is a read', (await exec('mise_progress', {})) === 'next')
check('gate: system is a read', (await exec('mise_system', {})) === 'next')

const auto = makeCtx({ writeMode: 'auto' })
const autoGate = auto.gate.find((g) => g.event === 'tools/pre-execute')?.cb
check(
  'gate: auto never asks',
  (await autoGate?.({ name: 'mise_install', arguments: { specs: ['x'] } }, async () => 'next')) === 'next',
)

// 4. The two reads that need a known answer are pure functions, so they are fed
//    fixtures instead of a stand-in binary: their input is `mise`'s JSON, and
//    that is what the test writes down. Nothing here spawns anything.
//
//    `mise outdated` answers three rows on purpose: one behind, one not
//    installed at all (`current: null`), one whose current version *is* the
//    newest. Only the first is a hint the panel can hang a number on.
const outdated = narrowOutdated({
  jq: { name: 'jq', requested: '1.7.1', current: '1.7.1', latest: '1.8.2' },
  node: { name: 'node', requested: '22', current: null, latest: '26.12.1' },
  bun: { name: 'bun', requested: '1.4.3', current: '1.4.3', latest: '1.4.3' },
})
check(
  'updates: keeps the tool that is behind, with both versions',
  outdated.length === 1 && outdated[0]?.tool === 'jq' && outdated[0]?.current === '1.7.1' && outdated[0]?.latest === '1.8.2',
  outdated,
)
check('updates: keeps what the config asks for', outdated[0]?.requested === '1.7.1', outdated[0])
check(
  'updates: drops a tool with nothing in effect and one already newest',
  !outdated.some((row) => row.tool === 'node' || row.tool === 'bun'),
  outdated.map((row) => row.tool),
)

//    What a removal leaves dangling, from `mise ls --json`. Two rows for the
//    same tool in one file: the one that keeps a version installed (a prefix
//    request that still resolves must survive) and the one that loses the last
//    installed version (every request for it goes).
const listing = {
  bun: [
    { requested_version: '1', installed: true, source: { type: 'mise.toml', path: '/proj/mise.toml' } },
    { requested_version: '1.4.3', installed: true, source: { type: 'mise.toml', path: '/proj/mise.toml' } },
  ],
  jq: [
    { requested_version: '1.8.2', installed: false, source: { type: 'mise.toml', path: '/home/x/.config/mise/config.toml' } },
  ],
  rust: [{ requested_version: 'stable', installed: true, source: { type: 'mise.toml', path: '/proj/mise.toml' } }],
}
const steps = planUnuse(['bun@1.4.3', 'jq@1.8.2'], [], listing)
check(
  'unuse plan: a sibling version keeps the prefix request alive',
  steps.some((step) => step.tool === 'bun' && step.spec === 'bun@1.4.3' && step.path === '/proj/mise.toml'),
  steps,
)
check(
  'unuse plan: nothing left installed drops the whole request from its own file',
  steps.some((step) => step.tool === 'jq' && step.spec === 'jq' && step.versions.length === 1 && step.path === '/home/x/.config/mise/config.toml'),
  steps,
)
check(
  'unuse plan: a tool that was not touched keeps its requests',
  !steps.some((step) => step.tool === 'rust') && steps.length === 2,
  steps.map((step) => step.spec),
)
check('unuse plan: an unreadable listing plans nothing', planUnuse(['jq@1.8.2'], [], {}).length === 0)


// 5. The three Agent-facing additions: system scan, activation switch, progress.
//    Tool results arrive as JSON text (that is what the model reads), so the
//    assertions parse them the same way.
const runTool = async (harness: Harness, name: string, args: Record<string, unknown>): Promise<ToolValue> => {
  const tool = harness.tools.get(name)
  if (tool === undefined) throw new Error(`test: tool ${name} is not registered`)
  return JSON.parse(await tool.execute(args, { name })) as ToolValue
}

const sysOut = await runTool(live, 'mise_system', {})
const sysTools = sysOut.ok ? ((sysOut.value['tools'] as Record<string, unknown>[] | undefined) ?? []) : []
check(
  'mise_system lists PATH tools with paths and versions',
  Array.isArray(sysTools) && sysTools.some((t) => t['name'] && t['path']),
  sysTools.slice(0, 2),
)
check(
  'mise_system marks what mise also manages',
  Array.isArray(sysTools) && sysTools.every((t) => typeof t['managedVersions'] === 'number' && Array.isArray(t['managed'])),
  sysTools[0],
)
// Two answers per command, because activation puts a shim in front of the copy
// the image ships: `path` is what PATH resolves to now, `systemPath` is the copy
// that is not mise's — the panel lists it as a read-only version.
check(
  'mise_system separates the image copy from the hit PATH resolves to',
  Array.isArray(sysTools) &&
    sysTools.every(
      (t) =>
        (t['systemPath'] === null || typeof t['systemPath'] === 'string') &&
        (t['systemVersion'] === null || typeof t['systemVersion'] === 'string'),
    ),
  sysTools[0],
)
check(
  'a shim in front still leaves the image copy named',
  Array.isArray(sysTools) && sysTools.every((t) => t['fromMise'] !== true || t['systemPath'] !== t['path'] || t['systemPath'] === null),
  sysTools.filter((t) => t['fromMise'] === true).slice(0, 2),
)

const offOut = await runTool(live, 'mise_activate', { enabled: false })
const offValue = offOut.ok ? offOut.value : undefined
check(
  'mise_activate(false) leaves PATH',
  offValue?.['enabled'] === false && !String(process.env.PATH).split(':').includes(String(offValue['shimsDir'])),
  offValue?.['enabled'],
)
const onOut = await runTool(live, 'mise_activate', { enabled: true })
const onValue = onOut.ok ? onOut.value : undefined
check(
  'mise_activate(true) puts shims first',
  onValue?.['enabled'] === true && String(process.env.PATH).split(':')[0] === String(onValue['shimsDir']),
  String(process.env.PATH).split(':')[0],
)

const idleOut = await runTool(live, 'mise_progress', {})
const idleValue = idleOut.ok ? idleOut.value : undefined
check('mise_progress answers with a job record', typeof idleValue?.['id'] === 'number' && typeof idleValue['done'] === 'boolean', idleValue?.['label'])
const missingOut = await runTool(live, 'mise_progress', { id: 9999 })
check(
  'mise_progress: unknown id is a clear error',
  missingOut.ok === false && missingOut.error.code === 'mise/no-such-job',
  missingOut.ok ? undefined : missingOut.error,
)

// A background job needs a command that takes long enough to be polled. No
// stand-in binary: a spec mise rejects — no such tool in the registry — fails in
// about 6 ms with its own message on stderr, which is enough to prove the job
// record exists before the command returns, finishes on its own, keeps that
// output, and that a later read finds it.
const bg = makeCtx({ writeMode: 'auto', cwd: '/tmp' })
const startOut = await runTool(bg, 'mise_install', { specs: ['dsh-mise-no-such-tool@0.0.0'], background: true })
const startValue = startOut.ok ? startOut.value : undefined
check(
  'mise_install(background) returns at once with an id',
  startValue?.['started'] === true && typeof startValue['id'] === 'number',
  startValue,
)
let snap: Record<string, unknown> | undefined
const jobId = startValue?.['id']
for (let tick = 0; tick < 80; tick += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50))
  const snapOut = await runTool(bg, 'mise_progress', { id: jobId as number })
  snap = snapOut.ok ? snapOut.value : undefined
  if (snap?.['done'] === true) break
}
const snapResult = snap?.['result'] as { exitCode?: number } | undefined
check(
  'background install finishes and reports itself',
  snap?.['done'] === true && snapResult?.exitCode !== 0,
  snap?.['error'] ?? snap?.['label'],
)
const snapLines = (snap?.['lines'] as unknown[] | undefined) ?? []
check('background job keeps its own output', snapLines.length > 0 && snap?.['id'] === jobId, snap?.['lines'])
const otherOut = await runTool(bg, 'mise_progress', {})
const otherValue = otherOut.ok ? otherOut.value : undefined
check('mise_progress without id falls back to the newest job', otherValue?.['id'] === jobId, otherValue?.['id'])

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '  -> ' + JSON.stringify(r.detail)}`)
console.log(failed.length === 0 ? '\nALL PASS' : `\n${failed.length} FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
