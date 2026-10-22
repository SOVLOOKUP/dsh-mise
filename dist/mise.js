/**
 * The mise command layer.
 *
 * One place decides how a `mise` process is spawned, how its JSON is read, and
 * what a failure looks like — so the agent tools, the `/api` endpoints behind
 * the settings page, and any later caller all see the same numbers.
 *
 * Every read path parses mise's own `--json` output instead of scraping human
 * text; the two places that cannot (`install`, `prune`) keep the raw log and
 * additionally parse the one structured line mise prints for a prunable tool.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** A failure with a stable code the RPC envelope and the tools can carry. */
export class MiseError extends Error {
    code;
    details;
    constructor(code, message, details) {
        super(message);
        this.name = 'MiseError';
        this.code = code;
        this.details = details;
    }
}
/** The stable code and message an envelope reports for any thrown value. */
export function errorShape(error) {
    const code = typeof error?.code === 'string' ? error.code : 'mise/error';
    const message = error instanceof Error ? error.message : String(error);
    return { code, message };
}
/** The optional detail bag of any thrown value, for envelopes that carry one. */
export function errorDetails(error) {
    const details = error?.details;
    return details !== null && typeof details === 'object' ? details : {};
}
const MAX_BUFFER = 8 * 1024 * 1024;
/** Trim a log to its tail: an install log is thousands of lines and the model needs the end. */
export function tail(text, maxLines = 40) {
    const lines = String(text ?? '')
        .trimEnd()
        .split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}
/** One `mise` invocation, never rejecting on a non-zero exit. */
function spawnMise(bin, args, options) {
    const { cwd, env, timeoutMs, signal, onData } = options;
    return new Promise((resolve) => {
        const child = spawn(bin, args, { cwd, env, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let overflow = false;
        const finish = (code, spawnFailure) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (signal)
                signal.removeEventListener?.('abort', onAbort);
            resolve({ code, stdout, stderr, spawnFailure, timedOut });
        };
        const append = (stream, chunk) => {
            const text = String(chunk);
            if (stream === 'out')
                stdout += text;
            else
                stderr += text;
            // A long install prints megabytes of progress bars; cap what we keep
            // rather than growing without bound, and stop the child if it runs away.
            if (!overflow && stdout.length + stderr.length > MAX_BUFFER) {
                overflow = true;
                child.kill('SIGKILL');
            }
            if (onData !== undefined) {
                try {
                    onData(text, stream);
                }
                catch {
                    // A broken progress sink must never break the command itself.
                }
            }
        };
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => append('out', chunk));
        child.stderr?.on('data', (chunk) => append('err', chunk));
        const onAbort = () => {
            child.kill('SIGKILL');
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        const timer = timeoutMs > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, timeoutMs)
            : undefined;
        child.on('error', (error) => finish(1, typeof error.code === 'string' ? error.code : undefined));
        child.on('close', (code) => finish(overflow ? 1 : (code ?? 1)));
    });
}
/**
 * Tools the panel looks for on PATH.
 *
 * These are the ones a project usually inherits from the image; the list is
 * deliberately short and boring, not a PATH scan of everything installed.
 */
const SYSTEM_CANDIDATES = [
    'node',
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'deno',
    'corepack',
    'python3',
    'python',
    'go',
    'rustc',
    'cargo',
    'java',
    'ruby',
    'php',
    'uv',
    'poetry',
    'jq',
];
/** The first line one of those binaries prints for `--version`, if any. */
async function probeVersion(path, options) {
    const attempts = [['--version'], ['-version']];
    for (const args of attempts) {
        const result = await spawnMise(path, args, options);
        const lines = `${result.stdout}\n${result.stderr}`
            .split(/[\r\n]+/)
            .map((line) => line.trim())
            .filter(Boolean);
        // A tool normally answers with one short line, but a shim first prints
        // whatever mise itself has to say (banners, "installing…"). The version is
        // the line that carries one, not simply the first line.
        const versioned = lines.find((line) => /\d+\.\d+/.test(line) && line.length <= 60);
        if (versioned)
            return versioned.slice(0, 40);
        if (lines.length)
            return lines[0]?.slice(0, 40) ?? null;
    }
    return null;
}
/**
 * The mise client for one plugin instance.
 *
 * `config` is the resolved plugin config: the binary, the environment overlay,
 * the two timeouts. Readers copy the returned plain objects, so a caller never
 * holds a reference into the runner.
 */
export class Mise {
    config;
    versionCache;
    /** Resolved once: a Host launched from a GUI does not inherit a shell PATH. */
    binPath;
    systemCache;
    constructor(config) {
        this.config = config;
        this.versionCache = undefined;
        this.binPath = undefined;
        this.systemCache = undefined;
    }
    /** The binary as configured, before resolution (for display and messages). */
    get bin() {
        return this.config.miseBin || 'mise';
    }
    /**
     * Where `mise` actually is.
     *
     * A desktop-launched Harness inherits the launcher's PATH, which usually has
     * neither `~/.local/bin` nor `~/.cargo/bin` — the same reason a terminal
     * command can be missing from a tool call. So the configured binary wins, and
     * otherwise the usual install locations are probed in order instead of
     * reporting "not found" while `mise` sits in the home directory.
     */
    async resolveBin() {
        if (this.binPath)
            return this.binPath;
        const candidates = [
            this.config.miseBin,
            'mise',
            join(homedir(), '.local', 'bin', 'mise'),
            '/usr/local/bin/mise',
            '/opt/homebrew/bin/mise',
            join(homedir(), '.local', 'share', 'mise', 'bin', 'mise'),
        ].filter((candidate, index, all) => Boolean(candidate) && all.indexOf(candidate) === index);
        for (const candidate of candidates) {
            // A PATH hit is reported as the absolute path it resolved to: the panel
            // shows this string, and a bare "mise" tells nobody where it came from.
            const resolved = candidate === 'mise' ? await onPath('mise') : (await executable(candidate)) ? candidate : '';
            if (resolved) {
                this.binPath = resolved;
                return resolved;
            }
        }
        throw new MiseError('mise/not-found', `找不到 mise 可执行文件（试过 ${candidates.join('、')}）。请安装 mise（https://mise.run），或在插件配置里把 miseBin 指向它的绝对路径。`, { tried: candidates });
    }
    /** Child environment: the host's own, with the configured overlay on top. */
    env() {
        return {
            ...process.env,
            // mise's own answers to a prompt, and a stable non-TTY presentation: the
            // panel and the tool results are plain text, so no cursor control or color.
            MISE_YES: '1',
            NO_COLOR: '1',
            TERM: 'dumb',
            ...(this.config.env ?? {}),
        };
    }
    /** Where mise keeps its shims for this instance's environment. */
    shimsDir() {
        const fromConfig = String(this.config.env?.MISE_DATA_DIR ?? process.env.MISE_DATA_DIR ?? '').trim();
        const base = fromConfig ||
            join(String(process.env.XDG_DATA_HOME ?? '').trim() || join(homedir(), '.local', 'share'), 'mise');
        return join(base, 'shims');
    }
    /** Target directory for one call: the caller's, else the configured default. */
    directory(cwd) {
        const candidate = String(cwd ?? '').trim() || this.config.cwd || process.cwd();
        return candidate;
    }
    async run(args, options = {}) {
        const long = options.long === true;
        const bin = await this.resolveBin();
        const result = await spawnMise(bin, args, {
            cwd: this.directory(options.cwd),
            env: this.env(),
            timeoutMs: options.timeoutMs ?? (long ? this.config.longTimeoutMs : this.config.timeoutMs),
            signal: options.signal,
            onData: options.onData,
        });
        if (result.spawnFailure === 'ENOENT') {
            // The binary disappeared between the probe and this call: forget the
            // cached path so the next call resolves again instead of failing forever.
            this.binPath = undefined;
            throw new MiseError('mise/not-found', `无法执行 mise（${bin}）`, { bin });
        }
        return result;
    }
    /** Run a read command and parse its JSON; a failure carries mise's own stderr. */
    async json(args, options = {}) {
        const result = await this.run(args, options);
        const text = result.stdout.trim();
        if (result.code !== 0 && !text) {
            throw new MiseError('mise/command-failed', `mise ${args.join(' ')} 失败：${tail(result.stderr, 12) || `exit ${result.code}`}`, { args: [...args], exitCode: result.code });
        }
        try {
            return JSON.parse(text || 'null');
        }
        catch {
            throw new MiseError('mise/bad-json', `无法解析 mise ${args.join(' ')} 的 JSON 输出：${tail(text, 6)}`, {
                args: [...args],
            });
        }
    }
    /** `mise --version`, cached: the binary cannot change under a running Host. */
    async version() {
        if (this.versionCache !== undefined)
            return this.versionCache;
        const result = await this.run(['--version']);
        if (result.code !== 0) {
            throw new MiseError('mise/command-failed', `mise --version 失败：${tail(result.stderr, 4) || `exit ${result.code}`}`);
        }
        this.versionCache = result.stdout.trim() || null;
        return this.versionCache;
    }
    /**
     * One snapshot of the directory: version, config chain, active versions, and
     * requested-but-missing versions. This is the panel's first read and the
     * `mise_status` tool's whole answer.
     */
    async status(cwd) {
        const directory = this.directory(cwd);
        let version;
        try {
            version = await this.version();
        }
        catch (error) {
            return { available: false, bin: this.bin, directory, error: errorShape(error) };
        }
        const [installed, active, missing, configs] = await Promise.all([
            this.json(['ls', '--json'], { cwd: directory }).catch(() => ({})),
            this.json(['ls', '--current', '--json'], { cwd: directory }).catch(() => ({})),
            this.json(['ls', '--missing', '--json'], { cwd: directory }).catch(() => ({})),
            this.json(['config', 'ls', '--json'], { cwd: directory }).catch(() => []),
        ]);
        // `ls --json` also echoes the versions a config asks for but that are not on
        // disk (`installed: false`), so its rows are not "installed" until the flag
        // says so. Keeping them would draw an uninstalled version as an installed
        // one — an Uninstall button for nothing, no Install button, and a false
        // "in effect" mark — and would also cancel the tool out of `ls --missing`.
        const installedShape = pickRows(shapeVersions(installed), (entry) => entry.installed);
        const activeShape = pickRows(shapeVersions(active), (entry) => entry.active);
        // Trust `ls --json` over `ls --missing` when they disagree: a version mise
        // just listed as installed is not missing, and a momentary disagreement
        // would otherwise show up as a scary "not installed" badge.
        const known = new Map(Object.entries(installedShape).map(([tool, entries]) => [tool, new Set(entries.map((entry) => entry.version))]));
        const missingShape = shapeVersions(missing);
        for (const [tool, entries] of Object.entries(missingShape)) {
            const have = known.get(tool);
            if (have === undefined)
                continue;
            const still = entries.filter((entry) => !have.has(entry.version));
            if (still.length)
                missingShape[tool] = still;
            else
                delete missingShape[tool];
        }
        return {
            available: true,
            version,
            bin: this.binPath ?? this.bin,
            directory,
            configs: Array.isArray(configs) ? configs : [],
            installed: installedShape,
            active: activeShape,
            missing: missingShape,
        };
    }
    /**
     * Every installed version of one tool, or of every tool.
     *
     * `mise ls --json <tool>` answers with a flat array while `mise ls --json`
     * answers with an object keyed by tool, so the filtered shape is re-keyed
     * here: every caller then reads one shape.
     */
    async installed(tool, cwd) {
        const args = ['ls', '--json'];
        if (tool)
            args.push(tool);
        const payload = await this.json(args, { cwd });
        const shape = Array.isArray(payload) ? (tool ? { [tool]: payload.map(shapeEntry) } : {}) : shapeVersions(payload);
        // Same story as in `status`: a config-requested version that is not on disk
        // rides along in `ls --json`, and this method answers "installed".
        return pickRows(shape, (entry) => entry.installed);
    }
    /**
     * The version picker's data: what is installed, what the registries offer, and
     * which of the offered versions are already installed or active.
     *
     * `prefix` scopes the remote list the way `mise ls-remote jq@1.8` does, which
     * is how the panel narrows a long list without a second round trip.
     */
    async versions(tool, cwd, prefix) {
        const directory = this.directory(cwd);
        const name = String(tool ?? '').trim();
        if (!name) {
            return { tool: null, directory, installed: await this.installed(undefined, directory) };
        }
        const spec = prefix ? `${name}@${prefix}` : name;
        const [installedAll, active, remote, latest] = await Promise.all([
            this.installed(name, directory).catch(() => ({})),
            this.json(['ls', '--current', '--json'], { cwd: directory }).catch(() => ({})),
            this.json(['ls-remote', '--json', spec], { cwd: directory }).catch(() => []),
            this.run(['latest', name], { cwd: directory }).catch(() => undefined),
        ]);
        const installedVersions = new Set((installedAll[name] ?? []).map((entry) => entry.version));
        const activeVersions = new Set((shapeVersions(active)[name] ?? []).filter((entry) => entry.active).map((entry) => entry.version));
        const remoteRows = Array.isArray(remote) ? remote : [];
        const available = remoteRows
            .map((entry) => {
            const row = asRecord(entry);
            const version = text(row['version']);
            return {
                version,
                createdAt: text(row['created_at']) || null,
                url: text(row['release_url']) || null,
                installed: installedVersions.has(version),
                active: activeVersions.has(version),
            };
        })
            .reverse()
            .slice(0, this.config.remoteLimit);
        return {
            tool: name,
            directory,
            latest: latest && latest.code === 0 ? latest.stdout.trim() : null,
            installed: installedAll[name] ?? [],
            active: activeVersions.size ? [...activeVersions] : [],
            available,
            remoteTotal: remoteRows.length,
        };
    }
    /**
     * Tools whose version in effect is behind a newer release.
     *
     * The comparison is mise's own, not one written here: `outdated` already
     * knows how each tool versions itself and how to order those versions, which
     * a string or dotted-number compare would get wrong (`1.10` < `1.9`, and
     * `temurin-21.0.1+12` is not a tuple of numbers).
     *
     * `--bump` widens the question from "the newest release the config's request
     * allows" to "the newest release overall". Without it a pinned request
     * (`jq = "1.8.2"`) can never be outdated, so the panel would stay quiet about
     * every newer release — not what a hint on a version number is for.
     * `--inactive` brings in installed tools no config requests, so a tool the
     * table still lists is not silently skipped.
     *
     * A row with no `current` names a tool nothing is installed for. The table
     * already says `未安装` there and offers Install, and a hint needs a version
     * number to sit on, so those rows are dropped.
     *
     * `current` is also what says *which* version the verdict is about, and a tool
     * can hold several. `--inactive` makes mise answer about one of the installed
     * versions, not necessarily the one in effect: pnpm 12.13.0 left on disk beside
     * an active 12.14.0 comes back as `current: 12.13.0`, `latest: 12.14.0`. Read
     * as "this tool is behind" it drew `12.14.0 ↑12.14.0` — an upgrade offer for
     * the version already installed. The panel therefore attaches a hint to the
     * version named in `current` and nowhere else.
     */
    async updates(cwd) {
        const directory = this.directory(cwd);
        const payload = await this.json(['outdated', '--inactive', '--bump', '--json'], { cwd: directory });
        return { directory, tools: narrowOutdated(payload) };
    }
    /** Tool names the registries know, for the panel's search box. */
    async registry(query) {
        const entries = await this.json(['registry', '--json'], {});
        const needle = String(query ?? '').trim().toLowerCase();
        const rows = (Array.isArray(entries) ? entries : []).map((entry) => {
            const row = asRecord(entry);
            return {
                short: text(row['short']),
                description: text(row['description']),
                bins: Array.isArray(row['bins']) ? row['bins'].map(text).filter(Boolean) : [],
                aliases: Array.isArray(row['aliases']) ? row['aliases'].map(text).filter(Boolean) : [],
            };
        });
        const matched = needle
            ? rows.filter((row) => [row.short, row.description, ...row.bins, ...row.aliases].some((field) => field.toLowerCase().includes(needle)))
            : rows;
        return { query: needle, total: rows.length, matches: matched.slice(0, this.config.registryLimit) };
    }
    /**
     * Tools that are on PATH but are not mise's.
     *
     * mise has no adopt step: a binary the image installed is never tracked, and
     * the old `tool = "system"` syntax is deprecated and does not wire it in
     * either. So the panel can only be honest about what is there, and say which
     * of those tools mise happens to have a managed copy of too.
     */
    async systemTools(signal) {
        if (this.systemCache !== undefined && Date.now() - this.systemCache.at < 60_000) {
            return this.systemCache.value;
        }
        let managed = [];
        try {
            const listing = await this.json(['ls', '--installed', '--json']);
            managed = Object.entries(asRecord(listing)).map(([name, versions]) => {
                const rows = Array.isArray(versions) ? versions.map(asRecord) : [];
                return {
                    name,
                    installs: rows.map((entry) => text(entry['install_path'])).filter(Boolean),
                    versions: rows.map((entry) => text(entry['version'])).filter(Boolean),
                };
            });
        }
        catch {
            // "what mise has installed" is a bonus column; never fail the panel for it.
        }
        const shims = this.shimsDir();
        const tools = [];
        await Promise.all(SYSTEM_CANDIDATES.map(async (name) => {
            const hits = await onPathAll(name);
            const path = hits[0];
            if (!path)
                return;
            const record = managed.find((entry) => entry.name === name);
            const installs = record?.installs ?? [];
            // Two ways a PATH command can already be mise's: it lives inside an
            // install, or it is one of mise's shims. The second is the usual case
            // once activation is on, and probing a shim is pointless — it answers
            // with mise's banner, not the tool's version.
            //
            // The shim rule also reads the layout, not only the computed directory:
            // `shims` comes from MISE_DATA_DIR / XDG_DATA_HOME, and an activation
            // that resolved its data dir differently still puts `…/mise/shims` on
            // PATH. Missing that would report the shim as the image's copy and probe
            // it for a version, which answers with mise's own error text.
            const ownedByMise = (candidate) => candidate === join(shims, name) ||
                candidate.startsWith(`${shims}/`) ||
                candidate.includes('/mise/shims/') ||
                candidate.includes('/mise/installs/') ||
                installs.some((install) => candidate === install || candidate.startsWith(`${install}/`));
            const fromMise = ownedByMise(path);
            const version = fromMise
                ? null
                : await probeVersion(path, { env: this.env(), timeoutMs: 4000, signal });
            // The image's copy is a second hit, not a second command: with a shim in
            // front, the first hit IS mise and the copy the image ships is further
            // down PATH. Probing it is what lets the panel name the version the
            // tool still answers with when nobody has installed one.
            const systemPath = hits.find((candidate) => !ownedByMise(candidate)) ?? null;
            const systemVersion = systemPath === null
                ? null
                : systemPath === path
                    ? // The first hit was already the image's own: one probe answers both.
                        version
                    : await probeVersion(systemPath, { env: this.env(), timeoutMs: 4000, signal });
            tools.push({
                name,
                path,
                version,
                managedVersions: installs.length,
                managed: record?.versions ?? [],
                fromMise,
                systemPath,
                systemVersion,
            });
        }));
        const value = {
            tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
            scanned: SYSTEM_CANDIDATES.length,
        };
        this.systemCache = { at: Date.now(), value };
        return value;
    }
    /** Install explicit `tool@version` specs, or every tool the config requests. */
    async install(specs, cwd, signal, onData) {
        const list = (Array.isArray(specs) ? specs : [specs]).map((spec) => String(spec ?? '').trim()).filter(Boolean);
        const args = list.length ? ['install', ...list] : ['install'];
        const result = await this.run(args, { cwd, long: true, signal, onData });
        // What mise actually installed, read from its own success lines: echoing
        // the requested specs back would claim success for a version that 404'd.
        const installed = [...`${result.stdout}\n${result.stderr}`.matchAll(/mise\s+✓\s+(\S+?)@(\S+)/g)].map((match) => `${match[1]}@${match[2]}`);
        return {
            command: `mise ${args.join(' ')}`,
            exitCode: result.code,
            ok: result.code === 0,
            output: tail(result.stdout || result.stderr, 30),
            requested: list,
            installed,
        };
    }
    /** Write a version into the project config (default) or the global config. */
    async use(spec, scope, cwd, fuzzy, signal, onData) {
        const clean = String(spec ?? '').trim();
        if (!clean)
            throw new MiseError('mise/bad-request', 'use 需要 tool@version，例如 jq@1.8.2');
        if (scope !== 'project' && scope !== 'global') {
            throw new MiseError('mise/bad-request', `scope 只能是 project 或 global（收到 ${String(scope)}）`);
        }
        const args = ['use'];
        if (scope === 'global')
            args.push('--global');
        if (fuzzy)
            args.push('--fuzzy');
        args.push(clean);
        const result = await this.run(args, { cwd, long: true, signal, onData });
        return {
            command: `mise ${args.join(' ')}`,
            scope,
            exitCode: result.code,
            ok: result.code === 0,
            output: tail(result.stdout || result.stderr, 20),
            spec: clean,
        };
    }
    /**
     * Prune versions nothing uses.
     *
     * `--tools` keeps the cleanup to toolchain versions: mise's other prune
     * targets include its own tracked-config registry, which is not a toolchain
     * change and not what the panel offers. A real prune is always preceded by a
     * dry run in the same call, so the answer names what it removed.
     */
    async prune(dryRun, cwd, signal, onData) {
        const preview = await this.run(['prune', '--tools', '--dry-run'], { cwd, long: true, signal });
        const candidates = parsePrunable(`${preview.stdout}\n${preview.stderr}`);
        if (dryRun) {
            return {
                dryRun: true,
                candidates,
                output: tail(preview.stdout || preview.stderr, 20),
                exitCode: preview.code,
            };
        }
        if (!candidates.length) {
            return { dryRun: false, candidates: [], removed: [], output: '没有可清理的版本', exitCode: 0 };
        }
        const result = await this.run(['prune', '--tools'], { cwd, long: true, signal, onData });
        return {
            dryRun: false,
            candidates,
            removed: result.code === 0 ? candidates : [],
            exitCode: result.code,
            output: tail(result.stdout || result.stderr, 20),
        };
    }
    /**
     * Remove explicit `tool@version` installs, then the config requests they leave
     * dangling.
     *
     * `mise uninstall` prints its progress on stderr and exits 0 even for a
     * version that was not installed (it warns instead), so the answer reports
     * both the removal lines it actually saw and the exit code — the caller can
     * tell "removed" from "was not there" without guessing.
     *
     * Uninstalling is only half of what a user means by it: `mise uninstall`
     * deletes files and leaves `mise.toml` alone, so the request that named the
     * version survives and the panel keeps drawing a "missing" row for a tool the
     * user just removed. The `forgot` field is that other half — the requests
     * dropped from config so the row disappears.
     */
    async uninstall(specs, cwd, signal, onData) {
        const list = (Array.isArray(specs) ? specs : [specs]).map((spec) => String(spec ?? '').trim()).filter(Boolean);
        if (!list.length) {
            throw new MiseError('mise/bad-request', '要卸载什么？给 tool@version，例如 node@22.5.0');
        }
        const result = await this.run(['uninstall', ...list], { cwd, long: true, signal, onData });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        const removed = parseRemoved(output);
        const forgot = result.code === 0 ? await this.forgetDangling(list, removed, cwd, signal) : [];
        return {
            command: `mise uninstall ${list.join(' ')}`,
            exitCode: result.code,
            ok: result.code === 0,
            removed,
            forgot,
            notInstalled: /is not installed/.test(output),
            output: tail(output, 20),
        };
    }
    /**
     * Drop one tool's request from one config file, leaving the installs alone.
     *
     * This is the exit a "配置里要、机器上没有" row needs: `mise uninstall` only
     * deletes files, so a request can outlive every install of it and hold a row
     * in the table for good. `--path` is required on purpose — without it mise
     * rewrites "the first loaded config", which in a project tree is a guess, and
     * guessing which file to edit is how a global request gets deleted from the
     * wrong one. `--no-prune` keeps this an edit: what is on disk is a separate,
     * previewed decision.
     */
    async unuse(tool, path, cwd, signal, onData) {
        const name = String(tool ?? '').trim();
        const file = String(path ?? '').trim();
        if (!name)
            throw new MiseError('mise/bad-request', '要移除哪个工具的配置请求？给工具名，例如 node');
        if (!file)
            throw new MiseError('mise/bad-request', '要改哪个配置文件？这一项只接受明确给出的路径');
        const result = await this.run(['unuse', name, '--path', file, '--no-prune'], { cwd, long: true, signal, onData });
        const output = `${result.stdout}\n${result.stderr}`.trim();
        return {
            command: `mise unuse ${name} --path ${file}`,
            exitCode: result.code,
            ok: result.code === 0,
            tool: name,
            path: file,
            output: tail(output, 20),
        };
    }
    /**
     * Drop the config requests an uninstall just left pointing at nothing.
     *
     * The answer comes from `mise ls --json`, the one view that distinguishes a
     * stale request from a live one: `source.path` names the file, `source` plus
     * `installed` says whether anything is behind it, and `requested_version` is
     * what the file literally asks for.
     *
     * Two rules, in order:
     *  - another version of the tool is still installed → only the request that
     *    literally named the removed version goes (`mise unuse bun@1.4.3`),
     *    because a prefix request like `bun = "1"` still resolves and stays;
     *  - nothing of that tool is installed any more → every request for it in the
     *    declaring file goes, since a prefix now resolves to nothing either.
     *
     * `--path` pins the edit to the file that declared the request: without it
     * mise rewrites "the first loaded config", which in a project tree is not
     * necessarily the file the user meant. `--no-prune` keeps this an edit to
     * config — the installs are already gone, and prune is a separate, previewed
     * action.
     */
    async forgetDangling(specs, removed, cwd, signal) {
        let listing;
        try {
            listing = await this.json(['ls', '--json'], { cwd });
        }
        catch {
            // Tidying config is a follow-up, never the point of the call: the files
            // are already gone, so a listing that does not answer leaves the requests
            // alone instead of failing the uninstall.
            return [];
        }
        const forgot = [];
        for (const step of planUnuse(specs, removed, listing)) {
            const result = await this.run(['unuse', step.spec, '--path', step.path, '--no-prune'], { cwd, signal }).catch(() => undefined);
            if (result?.code !== 0)
                continue;
            for (const version of step.versions)
                forgot.push({ tool: step.tool, version, path: step.path });
        }
        return forgot;
    }
}
/**
 * Which `mise outdated` rows are a hint about a version.
 *
 * A row earns a hint only when mise named both versions and they differ: a tool
 * with nothing in effect (`current: null`) has no number to hang the mark on,
 * and calling the newest release an update would be noise. `outdated --json`
 * answers an object keyed by tool name; the array branch is the shape mise uses
 * for the same rows when it was handed explicit specs.
 */
export function narrowOutdated(payload) {
    const entries = Array.isArray(payload) ? payload : Object.values(asRecord(payload));
    const tools = [];
    for (const entry of entries) {
        const row = asRecord(entry);
        const tool = text(row['name']).trim();
        const current = text(row['current']).trim();
        const latest = text(row['latest']).trim();
        if (!tool || !current || !latest || current === latest)
            continue;
        tools.push({ tool, current, latest, requested: text(row['requested']).trim() || null });
    }
    tools.sort((left, right) => left.tool.localeCompare(right.tool));
    return tools;
}
/**
 * Which config requests a removal leaves dangling.
 *
 * `listing` is `mise ls --json`, the one view that separates a request from an
 * install: `source.path` names the file, `installed` says whether anything is
 * behind it, `requested_version` is what the file literally asks for.
 *
 * Two rules, in order:
 *  - another version of the tool is still installed → only the request that
 *    literally named the removed version goes (`mise unuse bun@1.4.3`), because
 *    a prefix request like `bun = "1"` still resolves and has to stay;
 *  - nothing of that tool is installed any more → every request for it in the
 *    declaring file goes, since a prefix now resolves to nothing either.
 */
export function planUnuse(specs, removed, listing) {
    const tools = new Set([...specs.map((spec) => spec.split('@')[0] ?? ''), ...removed.map((pair) => pair.tool)]
        .map((tool) => tool.trim())
        .filter(Boolean));
    if (!tools.size)
        return [];
    const byTool = asRecord(listing);
    // The versions that just left: what the caller named, plus what mise reported
    // removing. Both, because the answer text is the one place a removal can go
    // unmentioned while the spec still says exactly what was asked for.
    const goneVersions = new Set([
        ...removed.map((pair) => pair.version),
        ...specs.map((spec) => spec.split('@')[1] ?? '').filter(Boolean),
    ]);
    const steps = [];
    for (const tool of tools) {
        const rows = Array.isArray(byTool[tool]) ? byTool[tool].map(asRecord) : [];
        const live = rows.filter((row) => row['installed'] === true);
        const stale = live.length ? rows.filter((row) => goneVersions.has(text(row['requested_version']))) : rows;
        const byTarget = new Map();
        for (const row of stale) {
            const path = text(asRecord(row['source'])['path']);
            if (!path)
                continue;
            const version = text(row['requested_version']);
            const spec = live.length ? `${tool}@${version}` : tool;
            const key = `${spec}\u0000${path}`;
            const step = byTarget.get(key) ?? { tool, spec, path, versions: [] };
            step.versions.push(version);
            byTarget.set(key, step);
        }
        steps.push(...byTarget.values());
    }
    return steps;
}
/** A JSON object from mise, or an empty object for anything else. */
function asRecord(value) {
    return value !== null && typeof value === 'object' ? value : {};
}
/** One JSON scalar as text; `null` / `undefined` / objects become `''`. */
function text(value) {
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return '';
}
/** `mise ls --json` is `{ tool: [ { version, ... } ] }`; keep the fields the UI reads. */
function shapeVersions(payload) {
    const out = {};
    if (payload === null || typeof payload !== 'object')
        return out;
    for (const [tool, entries] of Object.entries(payload)) {
        if (!Array.isArray(entries))
            continue;
        out[tool] = entries.map(shapeEntry);
    }
    return out;
}
/** Keep the rows a predicate accepts, dropping tools that keep none. */
function pickRows(map, keep) {
    const out = {};
    for (const [tool, entries] of Object.entries(map)) {
        const kept = entries.filter(keep);
        if (kept.length)
            out[tool] = kept;
    }
    return out;
}
/** One `mise ls` row, narrowed to the fields the panel and the tools read. */
function shapeEntry(entry) {
    const row = asRecord(entry);
    const source = row['source'];
    const sourcePath = source !== null && typeof source === 'object' ? text(source['path']) || null : text(source) || null;
    return {
        version: text(row['version']),
        requested: text(row['requested_version']) || null,
        installed: row['installed'] !== false,
        active: row['active'] === true,
        source: sourcePath,
        installPath: text(row['install_path']) || null,
    };
}
/**
 * The prunable rows in a prune dry run.
 *
 * mise prints one `mise <tool>@<version> [dryrun]  uninstall` line per victim, and
 * a reason line before it. Parsing the structured line (not the human sentence)
 * keeps a translated or reformatted reason from emptying the list.
 */
/** Progress lines of `mise uninstall`: `mise ✓ jq@1.6  7ms`. */
export function parseRemoved(output) {
    const found = new Map();
    for (const raw of String(output ?? '').split('\n')) {
        const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
        const match = /^mise\s+✓\s+(\S+)@(\S+)/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
            found.set(`${match[1]}@${match[2]}`, { tool: match[1], version: match[2] });
        }
    }
    return [...found.values()];
}
export function parsePrunable(output) {
    const found = new Map();
    for (const raw of String(output ?? '').split('\n')) {
        const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trim();
        const match = /^mise\s+(\S+)@(\S+)\s+\[dryrun\]\s+uninstall/.exec(line);
        if (match?.[1] !== undefined && match[2] !== undefined) {
            found.set(`${match[1]}@${match[2]}`, { tool: match[1], version: match[2] });
        }
    }
    return [...found.values()];
}
/** Is this an executable file? */
async function executable(path) {
    try {
        await access(path, constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/** Is `mise` reachable through the current PATH? */
async function onPathAll(name) {
    const path = String(process.env.PATH ?? '');
    const hits = [];
    for (const dir of path.split(':')) {
        if (!dir)
            continue;
        const candidate = join(dir, name);
        if (hits.includes(candidate))
            continue;
        if (await executable(candidate))
            hits.push(candidate);
    }
    return hits;
}
async function onPath(name) {
    return (await onPathAll(name))[0] ?? '';
}
//# sourceMappingURL=mise.js.map