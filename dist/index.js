/**
 * dsh-mise — Host half.
 *
 * What it installs:
 *  1. Nine model tools (`mise_status`, `mise_versions`, `mise_install`,
 *     `mise_use`, `mise_prune`) registered on the plugin fiber, so every
 *     session can read and change the local toolchain.
 *  2. A settings page (设置 → mise) registered by the Client half, whose data
 *     arrives over the authenticated `/api` connection channel — the endpoints
 *     below. A plugin-owned HTTP route would bypass that authentication, so
 *     this bundle serves none.
 *
 * One implementation serves both callers: the tools and the endpoints call the
 * same `Mise` methods, so a version list read in the panel and one read by the
 * model can never disagree.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Mise, MiseError, errorDetails, errorShape } from './mise.js';
export const name = 'dsh-mise';
export const inject = ['tools'];
const DEFAULTS = {
    /** `mise` on PATH, or the absolute path to it. */
    miseBin: '',
    /** Directory the panel and the tools default to; empty = the Host process cwd. */
    cwd: '',
    /** Extra environment for every mise child process (MISE_DATA_DIR and friends). */
    env: {},
    /** Read commands (`ls`, `ls-remote`, `registry`). */
    timeoutMs: 20000,
    /** Install / use / prune, which download and unpack. */
    longTimeoutMs: 900000,
    /** Writes are gated: `readonly` refuses, `ask` approves per tool call, `auto` proceeds. */
    writeMode: 'ask',
    /** How many remote versions one `mise_versions` answer carries (newest first). */
    remoteLimit: 30,
    /** How many registry rows one search returns. */
    registryLimit: 40,
    /** Put mise's shims dir first on the Host PATH, so tools work in every shell. */
    activate: true,
};
/**
 * The panel's RPC channel: `<channel>/<method>`.
 *
 * `/api` is not available for this: a shared channel accepts exactly one
 * interceptor and the API gateway owns `/api`, so a second registration throws
 * and every panel call comes back 404. `rpc.handle` mounts the channel as its
 * own authenticated prefix route instead — same admission check as `/api`,
 * different path.
 */
const CHANNEL = '/mise';
/** Writes: the tools that change the machine, gated by `writeMode`. */
const WRITE_TOOLS = new Set([
    'mise_install',
    'mise_use',
    'mise_prune',
    'mise_uninstall',
    'mise_activate',
]);
export function apply(ctx, config = {}) {
    const settings = normalizeConfig(config);
    const mise = new Mise(settings);
    // ── what makes the tools usable outside this plugin ────────────────────────
    // 1. mise's durable state is kept off /tmp (the image points XDG there).
    // 2. the shims dir goes first on the Host PATH, so `bun` / `node` work in
    //    every shell the Host spawns, not only inside mise commands.
    const shimsDir = shimsDirSync(settings);
    const pathDrift = ensurePersistentState((message) => console.warn(`[dsh-mise] ${message}`));
    if (settings.activate && !onPathList(shimsDir))
        addToPath(shimsDir);
    const activation = () => ({
        enabled: onPathList(shimsDir),
        configured: settings.activate,
        shimsDir,
        commands: shimCommands(shimsDir),
        drift: pathDrift,
    });
    /**
     * The write gate, next to the mutation it guards so the model tools and the
     * panel's endpoints both pass through it. The `ask` tier cannot be answered
     * here — it is resolved per tool call through DSH's approval seam below.
     */
    const assertWritable = () => {
        if (settings.writeMode !== 'readonly')
            return;
        throw new MiseError('mise/write-disabled', '写入已停用（writeMode=readonly）。要安装、切换或清理版本，请到 设置 → mise 里点「允许写入」，或在插件配置里把 writeMode 改为 ask / auto。');
    };
    // ── running commands ───────────────────────────────────────────────────────
    // A write command prints its work on stderr and can run for minutes; this
    // request/response channel cannot stream. So every write is recorded as a
    // job: the panel polls the active one while it waits, and an Agent can start
    // a long install in the background and poll the same record by id.
    const jobs = new Map();
    let activeJobId = 0;
    let jobCounter = 0;
    const JOB_ENTRIES = 24;
    const JOBS_KEPT = 5;
    /**
     * Which logical line a printed line belongs to.
     *
     * mise redraws its status lines with `\r` several times per second, so the
     * raw stream is the same line over and over with different numbers. Numbers,
     * the bar glyphs and whitespace are what change; the rest names the line.
     * Two lines with the same key are the same line, so the newer one replaces
     * the older in place instead of scrolling the panel.
     */
    function lineKey(line) {
        return line
            .replace(/[0-9]+([.,][0-9]+)?/g, '')
            .replace(/[█░▓▒▏▎▍▌▋▊▉]+/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function pushEntry(entries, text) {
        const line = text.trim();
        if (!line)
            return;
        const key = lineKey(line);
        const slot = entries.find((entry) => entry.key === key);
        if (slot !== undefined) {
            slot.text = line;
            return;
        }
        entries.push({ key, text: line });
        if (entries.length > JOB_ENTRIES)
            entries.shift();
    }
    function beginJob(label) {
        jobCounter += 1;
        const job = {
            id: jobCounter,
            label,
            startedAt: Date.now(),
            done: false,
            exitCode: null,
            entries: [],
            result: undefined,
            error: undefined,
        };
        jobs.set(job.id, job);
        activeJobId = job.id;
        for (const id of [...jobs.keys()]) {
            if (jobs.size <= JOBS_KEPT)
                break;
            if (id === activeJobId)
                continue;
            jobs.delete(id);
        }
        return job;
    }
    /** The sink a runner writes into; `\r` redraws a line, `\n` ends it. */
    function jobSink(job) {
        // A chunk can end mid-line; hold the tail back until its separator arrives
        // so a split line is not recorded as two.
        let pending = '';
        return (chunk) => {
            pending += String(chunk).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
            for (;;) {
                const at = pending.search(/[\r\n]/);
                if (at < 0)
                    break;
                const line = pending.slice(0, at);
                pending = pending.slice(at + 1);
                if (pending[0] === '\n')
                    pending = pending.slice(1);
                pushEntry(job.entries, line);
            }
            // The unfinished tail is the line being drawn right now: show it too, so
            // a slow command is not silent between separators.
            if (pending)
                pushEntry(job.entries, pending);
        };
    }
    function jobSnapshot(job) {
        if (job === undefined) {
            return { id: 0, label: '', startedAt: 0, elapsedMs: 0, done: true, ok: undefined, exitCode: null, lines: [] };
        }
        const snapshot = {
            id: job.id,
            label: job.label,
            startedAt: job.startedAt,
            elapsedMs: Date.now() - job.startedAt,
            done: job.done,
            ok: job.error ? false : asOk(job.result),
            exitCode: job.done ? job.exitCode : null,
            lines: job.entries.map((entry) => entry.text),
        };
        // A finished job carries its whole answer, so a polling Agent does not need
        // a second call once the run is over.
        if (job.done && job.result !== undefined)
            snapshot.result = job.result;
        if (job.error)
            snapshot.error = errorShape(job.error).message;
        return snapshot;
    }
    function findJob(id) {
        if (id === undefined || id === null || id === '')
            return jobs.get(activeJobId);
        return jobs.get(Number(id));
    }
    async function runJob(job, operation) {
        try {
            const result = await operation(jobSink(job));
            job.done = true;
            job.exitCode = typeof asRecord(result)['exitCode'] === 'number' ? asRecord(result)['exitCode'] : null;
            job.result = result;
            return result;
        }
        catch (error) {
            job.done = true;
            job.error = error;
            throw error;
        }
    }
    /** Run one write command with its output recorded. */
    async function tracked(label, operation) {
        return runJob(beginJob(label), operation);
    }
    /** Start a write command without waiting for it; the caller polls the job. */
    function trackedInBackground(label, operation) {
        const job = beginJob(label);
        // The failure lives on the job; an unhandled rejection here would only
        // noise up the Host log for something the Agent is already told about.
        runJob(job, operation).catch(() => { });
        return job;
    }
    async function dispatch(method, payload, signal) {
        const envelope = asRecord(payload);
        const args = 'args' in envelope ? envelope['args'] : payload;
        const call = asRecord(args);
        try {
            switch (method) {
                case 'status':
                    // The panel needs the write tier too: with `readonly` every button
                    // would fail one click at a time instead of saying so up front.
                    return ok({
                        ...(await mise.status(optString(call['cwd']))),
                        writeMode: settings.writeMode,
                        activation: activation(),
                    });
                case 'versions':
                    return ok(await mise.versions(optString(call['tool']), optString(call['cwd']), optString(call['prefix'])));
                case 'registry':
                    return ok(await mise.registry(optString(call['query'])));
                case 'updates':
                    // Panel-only, and its own endpoint on purpose: this is the one read
                    // that leaves the machine, so the table must never wait for it. The
                    // answer is a hint, and a failure here is simply no hint.
                    return ok(await mise.updates(optString(call['cwd'])));
                case 'activation':
                    return ok(activation());
                case 'activate':
                    assertWritable();
                    addToPath(shimsDir);
                    return ok(activation());
                case 'deactivate':
                    assertWritable();
                    removeFromPath(shimsDir);
                    return ok(activation());
                case 'system':
                    return ok(await mise.systemTools(signal));
                case 'progress':
                    return ok(jobSnapshot(findJob(call['id'])));
                case 'install': {
                    assertWritable();
                    const specs = optStringList(call['specs']) ?? [];
                    return ok(await tracked(`mise install ${specs.join(' ')}`.trim(), (sink) => mise.install(specs, optString(call['cwd']), signal, sink)));
                }
                case 'use':
                    assertWritable();
                    return ok(await tracked(`mise use ${optString(call['spec']) ?? ''}`.trim(), (sink) => mise.use(optString(call['spec']), optString(call['scope']) ?? 'project', optString(call['cwd']), call['fuzzy'] === true, signal, sink)));
                case 'prune':
                    assertWritable();
                    return ok(await tracked('mise prune --tools', (sink) => mise.prune(call['dryRun'] !== false, optString(call['cwd']), signal, sink)));
                case 'unuse':
                    assertWritable();
                    return ok(await tracked(`mise unuse ${optString(call['tool']) ?? ''}`.trim(), (sink) => mise.unuse(optString(call['tool']), optString(call['path']), optString(call['cwd']), signal, sink)));
                case 'uninstall': {
                    assertWritable();
                    const specs = optStringList(call['specs']) ?? [];
                    return ok(await tracked(`mise uninstall ${specs.join(' ')}`.trim(), (sink) => mise.uninstall(specs, optString(call['cwd']), signal, sink)));
                }
                default:
                    return fail('mise/unknown-endpoint', `未知的 mise 端点：${method}`);
            }
        }
        catch (error) {
            return fail(errorShape(error).code, errorShape(error).message, errorDetails(error));
        }
    }
    // ── the panel's RPC channel ────────────────────────────────────────────────
    // `rpc.handle` registers the channel through the *reading* Context, and that
    // Context must be able to read `webServer` when the route is mounted. A plain
    // `ctx.inject([...])` child is not enough — the read throws "cannot get
    // property webServer without inject" — so carry webServer onto the child
    // explicitly, the same shape dsh-mnemon uses for the identical call.
    // `webServer` is a runtime-only service name this plugin does not depend on:
    // it is carried, not typed, so no Harness package becomes a build dependency.
    const panelDeps = ['connection', 'webServer'];
    ctx.inject(panelDeps, (webContext) => {
        try {
            const seam = webContext;
            const scoped = typeof seam.extend === 'function' ? seam.extend({ webServer: seam.get?.('webServer') }) : seam;
            const connection = scoped?.connection;
            if (connection === undefined || typeof connection.rpc?.handle !== 'function')
                return;
            connection.rpc.handle(CHANNEL, (endpoint, payload, signal) => dispatch(endpoint, payload, signal));
        }
        catch (error) {
            // Mounting the panel's channel must never take the tools down with it.
            console.error('[dsh-mise] 面板通道注册失败：', String(error));
        }
    });
    // ── model tools ────────────────────────────────────────────────────────────
    ctx.effect(() => ctx.tools.register({
        name: 'mise_status',
        description: '本机 mise 工具链概览：mise 版本与路径、目标目录、目录链上的配置文件（mise.toml 等）、当前生效的工具版本、配置要求但还没装的版本，以及命令行激活状态（激活后装好的工具在 shell 里能直接调用）。任何 mise 操作前先调它。',
        parameters: {
            type: 'object',
            properties: {
                cwd: { type: 'string', description: '目标目录；留空用插件配置的默认目录（通常是工程根）' },
            },
            additionalProperties: false,
        },
        output: textOutput(),
        async execute(args) {
            const call = asRecord(args);
            return asJson(await attempt(async () => {
                const snapshot = await mise.status(optString(call['cwd']));
                // Whether a shell sees the tools is part of "can I use this", not
                // a panel detail: an Agent that just installed node needs to know
                // if `node -v` will find it.
                return { ...snapshot, activation: activation() };
            }));
        },
    }), 'dsh-mise: mise_status');
    ctx.effect(() => ctx.tools.register({
        name: 'mise_versions',
        description: '查版本：给 tool 时返回它的已装版本、当前生效版本、latest 与可安装的远程版本（新的在前，带是否已装）；不给 tool 时返回本目录已装的所有工具；给 query 时按关键词搜 mise registry 里的工具名。',
        parameters: {
            type: 'object',
            properties: {
                tool: { type: 'string', description: '工具名，如 node / python / jq；可用 registry 搜索确认名称' },
                prefix: { type: 'string', description: '只看某个前缀的远程版本，如 tool=jq 时 prefix=1.8' },
                query: { type: 'string', description: '不给 tool 时用：按关键词搜 registry，返回工具名与说明' },
                cwd: { type: 'string', description: '目标目录；留空用插件配置的默认目录' },
            },
            additionalProperties: false,
        },
        output: textOutput(),
        async execute(args) {
            const call = asRecord(args);
            return asJson(await attempt(async () => {
                const tool = optString(call['tool']);
                const query = optString(call['query']);
                if (!tool && query)
                    return mise.registry(query);
                return mise.versions(tool, optString(call['cwd']), optString(call['prefix']));
            }));
        },
    }), 'dsh-mise: mise_versions');
    ctx.effect(() => ctx.tools.register({
        name: 'mise_install',
        description: '安装工具版本（写本机）。specs 传 tool@version（可多个，如 ["node@22.5.0"]）；留空表示按目标目录的配置文件安装全部所需工具。安装不改配置，要让版本生效再用 mise_use。',
        parameters: {
            type: 'object',
            properties: {
                specs: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'tool@version 列表；留空 = 按目录配置文件安装',
                },
                cwd: { type: 'string', description: '目标目录；留空用插件配置的默认目录' },
                background: {
                    type: 'boolean',
                    description: 'true = 只启动不等待，立刻返回任务 id，之后用 mise_progress 轮询；适合可能要几分钟的大工具',
                },
            },
            additionalProperties: false,
        },
        output: textOutput(),
        async execute(args, exec) {
            const call = asRecord(args);
            const specs = optStringList(call['specs']) ?? [];
            const cwd = optString(call['cwd']);
            const label = `mise install ${specs.join(' ')}`.trim();
            return asJson(await attempt(async () => {
                if (call['background'] !== true) {
                    return tracked(label, (sink) => mise.install(specs, cwd, exec.signal, sink));
                }
                // No signal: this tool call ends immediately, so a signal tied to
                // it would kill the install the moment it returned.
                const job = trackedInBackground(label, (sink) => mise.install(specs, cwd, undefined, sink));
                return { started: true, id: job.id, label, next: '用 mise_progress 带上这个 id 轮询' };
            }));
        },
    }), 'dsh-mise: mise_install');
    ctx.effect(() => ctx.tools.register({
        name: 'mise_uninstall',
        description: '卸载指定的已装版本（写本机，删的是 mise 安装目录里的那一份），并顺手删掉 mise.toml 里指向它的那一条请求——否则那一行会以「未安装」的样子继续留在列表里，答案里的 forgot 就是被删掉的请求。specs 传 tool@version，如 ["node@22.5.0"]；不确定有哪些已装版本就先 mise_status / mise_versions。只想清掉没人用的版本、不动任何配置时优先 mise_prune。',
        parameters: {
            type: 'object',
            properties: {
                specs: { type: 'array', items: { type: 'string' }, description: 'tool@version 列表，如 ["jq@1.6"]' },
                cwd: { type: 'string', description: '目标目录；留空用插件配置的默认目录' },
            },
            required: ['specs'],
            additionalProperties: false,
        },
        output: textOutput(),
        async execute(args, exec) {
            const call = asRecord(args);
            const specs = optStringList(call['specs']) ?? [];
            return asJson(await attempt(() => tracked(`mise uninstall ${specs.join(' ')}`.trim(), (sink) => mise.uninstall(specs, optString(call['cwd']), exec.signal, sink))));
        },
    }), 'dsh-mise: mise_uninstall');
    ctx.effect(() => ctx.tools.register({
        name: 'mise_system',
        description: '扫描 PATH 上的开发工具（node / npm / pnpm / python / java / go 等），给出每个命令的实际路径、版本，以及 mise 是否另有同一工具的受管版本。回答「这台机器装了什么」「某个命令现在是谁」时用它；它列出的是不归 mise 管的系统预装工具。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: textOutput(),
        async execute(_args, exec) {
            return asJson(await attempt(() => mise.systemTools(exec.signal)));
        },
    }), 'dsh-mise: mise_system');
    ctx.effect(() => ctx.tools.register({
        name: 'mise_activate',
        description: '开关命令行激活：开启后 mise 的 shims 目录排在宿主 PATH 最前面，装好的工具在 shell 里能直接调用；关闭则这些命令回到系统那一份。只影响当前 Host 进程及其子进程，下次启动是否自动开启由插件配置项 activate 决定。',
        parameters: {
            type: 'object',
            properties: {
                enabled: { type: 'boolean', description: 'true = 开启，false = 关闭' },
            },
            required: ['enabled'],
            additionalProperties: false,
        },
        output: textOutput(),
        async execute(args) {
            const call = asRecord(args);
            return asJson(await attempt(() => {
                assertWritable();
                if (call['enabled'] === true)
                    addToPath(shimsDir);
                else
                    removeFromPath(shimsDir);
                return activation();
            }));
        },
    }), 'dsh-mise: mise_activate');
    ctx.effect(() => ctx.tools.register({
        name: 'mise_progress',
        description: '查看一条写入命令（安装 / 切换 / 清理）的实时进度：在跑什么、跑了多久、最近的输出行、是否结束；结束后附带完整结果，不用再调一次。配合 mise_install 的 background=true 轮询使用；不带 id 时看最近运行的那条，包括面板里点的。',
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'number', description: '任务 id（mise_install background=true 返回的）；留空 = 最近一次运行' },
            },
            additionalProperties: false,
        },
        output: textOutput(),
        async execute(args) {
            const call = asRecord(args);
            const id = call['id'];
            return asJson(await attempt(async () => {
                const job = findJob(id);
                if (job === undefined) {
                    throw new MiseError('mise/no-such-job', `没有 id=${String(id)} 的任务；不带 id 可以看最近一次运行`);
                }
                return jobSnapshot(job);
            }));
        },
    }), 'dsh-mise: mise_progress');
    ctx.effect(() => ctx.tools.register({
        name: 'mise_use',
        description: '切换版本并写进配置：把 tool@version 写入目标目录的 mise.toml（scope=project，默认）或全局配置（scope=global），已装则只写配置，未装会先安装。fuzzy=true 时只写前缀（如 node@22）而不是完整版本号。',
        parameters: {
            type: 'object',
            properties: {
                spec: { type: 'string', description: 'tool@version，如 node@22.5.0' },
                scope: { type: 'string', enum: ['project', 'global'], description: 'project=写目标目录的 mise.toml（默认）；global=写全局配置' },
                fuzzy: { type: 'boolean', description: 'true 时按请求写前缀而不是钉死完整版本' },
                cwd: { type: 'string', description: '目标目录（scope=project 时决定写哪个 mise.toml）' },
            },
            required: ['spec'],
            additionalProperties: false,
        },
        output: textOutput(),
        async execute(args, exec) {
            const call = asRecord(args);
            const spec = optString(call['spec']);
            return asJson(await attempt(() => tracked(`mise use ${spec ?? ''}`.trim(), (sink) => mise.use(spec, optString(call['scope']) ?? 'project', optString(call['cwd']), call['fuzzy'] === true, exec.signal, sink))));
        },
    }), 'dsh-mise: mise_use');
    ctx.effect(() => ctx.tools.register({
        name: 'mise_prune',
        description: '清理没被任何配置使用的工具版本。默认 dryRun=true，只列出可清理项；确认后传 dryRun=false 才真删。只清理工具版本（mise prune --tools），不动 mise 的配置追踪表。',
        parameters: {
            type: 'object',
            properties: {
                dryRun: { type: 'boolean', description: 'true（默认）= 只预览；false = 真删除' },
                cwd: { type: 'string', description: '目标目录（决定哪些版本算「在用」）' },
            },
            additionalProperties: false,
        },
        output: textOutput(),
        async execute(args, exec) {
            const call = asRecord(args);
            return asJson(await attempt(() => mise.prune(call['dryRun'] !== false, optString(call['cwd']), exec.signal)));
        },
    }), 'dsh-mise: mise_prune');
    // ── writeMode=ask: approve each write through DSH's approval seam ──────────
    // Only for the mutating tools, and only in the `ask` tier. DSH resolves the
    // ask against the composed ApprovalService: `allowed-once` proceeds, and a
    // deployment with no approval channel denies (the safe direction). `prune` is
    // a write only when it is not a dry run.
    ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
        if (settings.writeMode !== 'ask' || !WRITE_TOOLS.has(exec.name))
            return next();
        if (exec.name === 'mise_prune' && asRecord(exec.arguments)['dryRun'] !== false)
            return next();
        return {
            kind: 'ask',
            reason: `修改本机 mise 工具链（${exec.name}）`,
            displayReason: {
                en: `Allow this change to the local mise toolchain? (${exec.name})`,
                zh: `允许这次改动本机 mise 工具链吗？（${exec.name}）`,
            },
        };
    }), 'dsh-mise: writeMode=ask approval gate');
}
/**
 * Run one operation and shape the answer the same way on both paths: a value
 * under `ok`, or the failure's stable code and message. A thrown error becomes
 * a readable result instead of a framework error, so the model can retry with
 * the reason in hand.
 */
async function attempt(operation) {
    try {
        return { ok: true, value: await operation() };
    }
    catch (error) {
        return { ok: false, error: errorShape(error) };
    }
}
/** Tool output: one JSON string, so the model reads the same fields the panel does. */
function textOutput() {
    return {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
    };
}
/** Serialize a result, or a failure with its stable code. */
function asJson(value) {
    return JSON.stringify(value, null, 2);
}
function ok(value) {
    return { ok: true, value };
}
function fail(code, message, details) {
    return { ok: false, error: { code, message, details: details ?? {} } };
}
/** A JSON object from the wire, or an empty object for anything else. */
function asRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
/** The `ok` flag a finished job's result carries, when it has one. */
function asOk(value) {
    const flag = asRecord(value)['ok'];
    return typeof flag === 'boolean' ? flag : undefined;
}
/** One optional string argument, as the model or the panel sent it. */
function optString(value) {
    return typeof value === 'string' ? value : undefined;
}
/** One optional string-list argument, dropping anything that is not a string. */
function optStringList(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : undefined;
}
/**
 * Config normalization: the row config is plain YAML, so every field is
 * validated here rather than by a schema the plugin cannot import.
 */
function normalizeConfig(config) {
    const raw = asRecord(config);
    const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
    const mode = String(raw['writeMode'] ?? DEFAULTS.writeMode);
    const rawEnv = raw['env'];
    return {
        miseBin: String(raw['miseBin'] ?? DEFAULTS.miseBin).trim(),
        cwd: String(raw['cwd'] ?? DEFAULTS.cwd).trim(),
        env: rawEnv !== null && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
            ? rawEnv
            : {},
        timeoutMs: positive(raw['timeoutMs'], DEFAULTS.timeoutMs),
        longTimeoutMs: positive(raw['longTimeoutMs'], DEFAULTS.longTimeoutMs),
        writeMode: ['readonly', 'ask', 'auto'].includes(mode) ? mode : DEFAULTS.writeMode,
        remoteLimit: positive(raw['remoteLimit'], DEFAULTS.remoteLimit),
        registryLimit: positive(raw['registryLimit'], DEFAULTS.registryLimit),
        activate: raw['activate'] === undefined ? DEFAULTS.activate : raw['activate'] !== false,
    };
}
/**
 * Where mise keeps its shims, best effort and synchronous (activation happens
 * while the plugin is being applied, before any command can run).
 */
function shimsDirSync(settings) {
    const fromConfig = String(settings.env?.MISE_DATA_DIR ?? process.env.MISE_DATA_DIR ?? '').trim();
    if (fromConfig)
        return join(fromConfig, 'shims');
    const xdgData = String(process.env.XDG_DATA_HOME ?? '').trim();
    const base = xdgData || join(process.env.HOME || homedir(), '.local', 'share');
    return join(base, 'mise', 'shims');
}
/** True when `dir` is already an entry of PATH. */
function onPathList(dir) {
    return String(process.env.PATH ?? '')
        .split(':')
        .filter(Boolean)
        .includes(dir);
}
function addToPath(dir) {
    const entries = String(process.env.PATH ?? '')
        .split(':')
        .filter(Boolean)
        .filter((entry) => entry !== dir);
    process.env.PATH = [dir, ...entries].join(':');
}
function removeFromPath(dir) {
    process.env.PATH = String(process.env.PATH ?? '')
        .split(':')
        .filter(Boolean)
        .filter((entry) => entry !== dir)
        .join(':');
}
/** The commands the shims dir currently offers, i.e. what activation makes usable. */
function shimCommands(dir) {
    try {
        return readdirSync(dir).sort();
    }
    catch {
        return [];
    }
}
/**
 * Keep mise's state off `/tmp`.
 *
 * This image points XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_STATE_HOME at /tmp,
 * which is wiped on restart, so a global config written there (and the installs
 * beside it) would silently disappear. The durable copy lives under $HOME; the
 * XDG paths are made symlinks to it, so a bare `mise` in any shell reads the
 * same state as the panel. Runs on every load, because /tmp does not survive
 * and the symlinks have to be recreated each time.
 */
function ensurePersistentState(log) {
    const home = String(process.env.HOME ?? '').trim();
    if (!home)
        return [];
    const drift = [];
    const pairs = [
        ['XDG_CONFIG_HOME', '.config'],
        ['XDG_DATA_HOME', '.local/share'],
        ['XDG_STATE_HOME', '.local/state'],
    ];
    for (const [envKey, relative] of pairs) {
        const base = String(process.env[envKey] ?? '').trim();
        if (!base)
            continue;
        const from = join(base, 'mise');
        const to = join(home, relative, 'mise');
        if (from === to)
            continue;
        try {
            const fromStat = lstatSync(from, { throwIfNoEntry: false });
            const isLink = fromStat?.isSymbolicLink() === true;
            if (isLink) {
                if (readlinkSync(from) !== to) {
                    rmSync(from, { force: true });
                    mkdirSync(to, { recursive: true });
                    symlinkSync(to, from);
                }
                continue;
            }
            if (!fromStat) {
                // Point the /tmp default at the durable copy, creating it when the
                // plugin is the first thing to touch mise on this machine.
                mkdirSync(to, { recursive: true });
                mkdirSync(base, { recursive: true });
                symlinkSync(to, from);
                continue;
            }
            // A real directory on /tmp: only replace it when it holds nothing, so an
            // unexpected file there is never destroyed.
            if (fromStat.isDirectory() && readdirSync(from).length === 0) {
                rmSync(from, { recursive: true, force: true });
                symlinkSync(to, from);
            }
            else if (fromStat.isDirectory()) {
                drift.push(from);
            }
        }
        catch (error) {
            log(`无法把 ${from} 指向 ${to}：${String(error)}`);
        }
    }
    return drift;
}
export default { name, inject, apply };
//# sourceMappingURL=index.js.map