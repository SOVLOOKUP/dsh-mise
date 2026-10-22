/** The write tiers the Host understands. */
export type WriteMode = 'readonly' | 'ask' | 'auto';
/** Resolved plugin config: what a `Mise` instance is built from. */
export interface MiseSettings {
    /** `mise` on PATH, or the absolute path to it. */
    readonly miseBin: string;
    /** Directory the panel and the tools default to; empty = the Host process cwd. */
    readonly cwd: string;
    /** Extra environment for every mise child process (MISE_DATA_DIR and friends). */
    readonly env: Readonly<Record<string, string>>;
    /** Read commands (`ls`, `ls-remote`, `registry`). */
    readonly timeoutMs: number;
    /** Install / use / prune, which download and unpack. */
    readonly longTimeoutMs: number;
    /** Writes are gated: `readonly` refuses, `ask` approves per tool call, `auto` proceeds. */
    readonly writeMode: WriteMode;
    /** How many remote versions one `mise_versions` answer carries (newest first). */
    readonly remoteLimit: number;
    /** How many registry rows one search returns. */
    readonly registryLimit: number;
    /** Put mise's shims dir first on the Host PATH, so tools work in every shell. */
    readonly activate: boolean;
}
/** A failure with a stable code the RPC envelope and the tools can carry. */
export declare class MiseError extends Error {
    readonly code: string;
    readonly details: Record<string, unknown> | undefined;
    constructor(code: string, message: string, details?: Record<string, unknown>);
}
/** The stable code and message an envelope reports for any thrown value. */
export declare function errorShape(error: unknown): {
    code: string;
    message: string;
};
/** The optional detail bag of any thrown value, for envelopes that carry one. */
export declare function errorDetails(error: unknown): Record<string, unknown>;
/** Trim a log to its tail: an install log is thousands of lines and the model needs the end. */
export declare function tail(text: unknown, maxLines?: number): string;
/** One `mise ls` row, narrowed to the fields the panel and the tools read. */
export interface VersionRow {
    readonly version: string;
    readonly requested: string | null;
    readonly installed: boolean;
    readonly active: boolean;
    readonly source: string | null;
    readonly installPath: string | null;
}
/** `mise ls --json`, keyed by tool name. */
export type VersionMap = Record<string, VersionRow[]>;
/** What one `mise` invocation produced; a non-zero exit is data, not a rejection. */
export interface RunResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
    /** `ENOENT` and friends: the spawn itself failed, so there is no exit code. */
    readonly spawnFailure: string | undefined;
    readonly timedOut: boolean;
}
/** One progress sink write: `stream` says which pipe the text came from. */
export type DataSink = (text: string, stream: 'out' | 'err') => void;
/** Options a `Mise` method accepts on top of its own arguments. */
export interface RunOptions {
    readonly cwd?: string | undefined;
    readonly long?: boolean;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal | undefined;
    readonly onData?: DataSink | undefined;
}
/** What one PATH scan found for one candidate command. */
export interface SystemTool {
    readonly name: string;
    /** The hit PATH resolves to first: mise's shim or install once activation is on. */
    readonly path: string;
    readonly version: string | null;
    readonly managedVersions: number;
    readonly managed: string[];
    readonly fromMise: boolean;
    /**
     * The image's own copy of the command: the first PATH hit that is not mise's.
     *
     * A second pass over PATH, because the first hit is a shim as soon as
     * activation is on — and the copy the image ships is exactly what the panel
     * needs when it says "this tool also exists outside mise". Null when PATH
     * holds no such copy.
     */
    readonly systemPath: string | null;
    readonly systemVersion: string | null;
}
/** The answer `systemTools` caches and both callers read. */
export interface SystemToolsAnswer {
    readonly tools: SystemTool[];
    readonly scanned: number;
}
/** One remote version row, with the two flags the picker draws. */
export interface RemoteVersion {
    readonly version: string;
    readonly createdAt: string | null;
    readonly url: string | null;
    readonly installed: boolean;
    readonly active: boolean;
}
/** One registry row. */
export interface RegistryRow {
    readonly short: string;
    readonly description: string;
    readonly bins: string[];
    readonly aliases: string[];
}
/** One candidate `tool@version` pair parsed out of mise's log output. */
export interface ToolVersionPair {
    readonly tool: string;
    readonly version: string;
}
/**
 * The mise client for one plugin instance.
 *
 * `config` is the resolved plugin config: the binary, the environment overlay,
 * the two timeouts. Readers copy the returned plain objects, so a caller never
 * holds a reference into the runner.
 */
export declare class Mise {
    readonly config: MiseSettings;
    private versionCache;
    /** Resolved once: a Host launched from a GUI does not inherit a shell PATH. */
    private binPath;
    private systemCache;
    constructor(config: MiseSettings);
    /** The binary as configured, before resolution (for display and messages). */
    get bin(): string;
    /**
     * Where `mise` actually is.
     *
     * A desktop-launched Harness inherits the launcher's PATH, which usually has
     * neither `~/.local/bin` nor `~/.cargo/bin` — the same reason a terminal
     * command can be missing from a tool call. So the configured binary wins, and
     * otherwise the usual install locations are probed in order instead of
     * reporting "not found" while `mise` sits in the home directory.
     */
    resolveBin(): Promise<string>;
    /** Child environment: the host's own, with the configured overlay on top. */
    env(): NodeJS.ProcessEnv;
    /** Where mise keeps its shims for this instance's environment. */
    shimsDir(): string;
    /** Target directory for one call: the caller's, else the configured default. */
    directory(cwd?: string): string;
    run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
    /** Run a read command and parse its JSON; a failure carries mise's own stderr. */
    json(args: readonly string[], options?: RunOptions): Promise<unknown>;
    /** `mise --version`, cached: the binary cannot change under a running Host. */
    version(): Promise<string | null>;
    /**
     * One snapshot of the directory: version, config chain, active versions, and
     * requested-but-missing versions. This is the panel's first read and the
     * `mise_status` tool's whole answer.
     */
    status(cwd?: string): Promise<StatusSnapshot>;
    /**
     * Every installed version of one tool, or of every tool.
     *
     * `mise ls --json <tool>` answers with a flat array while `mise ls --json`
     * answers with an object keyed by tool, so the filtered shape is re-keyed
     * here: every caller then reads one shape.
     */
    installed(tool?: string, cwd?: string): Promise<VersionMap>;
    /**
     * The version picker's data: what is installed, what the registries offer, and
     * which of the offered versions are already installed or active.
     *
     * `prefix` scopes the remote list the way `mise ls-remote jq@1.8` does, which
     * is how the panel narrows a long list without a second round trip.
     */
    versions(tool?: string, cwd?: string, prefix?: string): Promise<VersionsAnswer>;
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
    updates(cwd?: string): Promise<UpdatesAnswer>;
    /** Tool names the registries know, for the panel's search box. */
    registry(query?: string): Promise<RegistryAnswer>;
    /**
     * Tools that are on PATH but are not mise's.
     *
     * mise has no adopt step: a binary the image installed is never tracked, and
     * the old `tool = "system"` syntax is deprecated and does not wire it in
     * either. So the panel can only be honest about what is there, and say which
     * of those tools mise happens to have a managed copy of too.
     */
    systemTools(signal?: AbortSignal): Promise<SystemToolsAnswer>;
    /** Install explicit `tool@version` specs, or every tool the config requests. */
    install(specs: readonly string[] | string | undefined, cwd?: string, signal?: AbortSignal, onData?: DataSink): Promise<InstallAnswer>;
    /** Write a version into the project config (default) or the global config. */
    use(spec: string | undefined, scope: string | undefined, cwd?: string, fuzzy?: boolean, signal?: AbortSignal, onData?: DataSink): Promise<UseAnswer>;
    /**
     * Prune versions nothing uses.
     *
     * `--tools` keeps the cleanup to toolchain versions: mise's other prune
     * targets include its own tracked-config registry, which is not a toolchain
     * change and not what the panel offers. A real prune is always preceded by a
     * dry run in the same call, so the answer names what it removed.
     */
    prune(dryRun: boolean, cwd?: string, signal?: AbortSignal, onData?: DataSink): Promise<PrunePreview | PruneAnswer>;
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
    uninstall(specs: readonly string[] | string | undefined, cwd?: string, signal?: AbortSignal, onData?: DataSink): Promise<UninstallAnswer>;
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
    unuse(tool: string | undefined, path: string | undefined, cwd?: string, signal?: AbortSignal, onData?: DataSink): Promise<UnuseAnswer>;
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
    private forgetDangling;
}
/** `mise_status`: either "mise is not here" or one full snapshot of a directory. */
export type StatusSnapshot = {
    readonly available: false;
    readonly bin: string;
    readonly directory: string;
    readonly error: {
        code: string;
        message: string;
    };
} | {
    readonly available: true;
    readonly version: string | null;
    readonly bin: string;
    readonly directory: string;
    readonly configs: unknown[];
    readonly installed: VersionMap;
    readonly active: VersionMap;
    readonly missing: VersionMap;
};
/** `mise_versions`: the tool-less shape only lists what is installed. */
export type VersionsAnswer = {
    readonly tool: null;
    readonly directory: string;
    readonly installed: VersionMap;
} | {
    readonly tool: string;
    readonly directory: string;
    readonly latest: string | null;
    readonly installed: VersionRow[];
    readonly active: string[];
    readonly available: RemoteVersion[];
    readonly remoteTotal: number;
};
/**
 * Which `mise outdated` rows are a hint about a version.
 *
 * A row earns a hint only when mise named both versions and they differ: a tool
 * with nothing in effect (`current: null`) has no number to hang the mark on,
 * and calling the newest release an update would be noise. `outdated --json`
 * answers an object keyed by tool name; the array branch is the shape mise uses
 * for the same rows when it was handed explicit specs.
 */
export declare function narrowOutdated(payload: unknown): UpdateRow[];
/** One `mise unuse` the plan asks for, and the requests it covers. */
export interface UnuseStep {
    readonly tool: string;
    readonly spec: string;
    readonly path: string;
    readonly versions: string[];
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
export declare function planUnuse(specs: readonly string[], removed: readonly ToolVersionPair[], listing: unknown): UnuseStep[];
/** One tool mise says has a newer release than the version in effect. */
export interface UpdateRow {
    readonly tool: string;
    /** The version in effect — mise's own `current` column. */
    readonly current: string;
    /** The newest release overall (mise is asked to compare with `--bump`). */
    readonly latest: string;
    /** What a config asks for, when one asks for anything. */
    readonly requested: string | null;
}
/** `mise/updates`: what the panel's hint on a version number is drawn from. */
export interface UpdatesAnswer {
    readonly directory: string;
    readonly tools: UpdateRow[];
}
/** `mise_registry`-style search: the query, the corpus size, and the matched rows. */
export interface RegistryAnswer {
    readonly query: string;
    readonly total: number;
    readonly matches: RegistryRow[];
}
export interface InstallAnswer {
    readonly command: string;
    readonly exitCode: number;
    readonly ok: boolean;
    readonly output: string;
    readonly requested: string[];
    readonly installed: string[];
}
export interface UseAnswer {
    readonly command: string;
    readonly scope: 'project' | 'global';
    readonly exitCode: number;
    readonly ok: boolean;
    readonly output: string;
    readonly spec: string;
}
export interface PrunePreview {
    readonly dryRun: true;
    readonly candidates: ToolVersionPair[];
    readonly output: string;
    readonly exitCode: number;
}
export interface PruneAnswer {
    readonly dryRun: false;
    readonly candidates: ToolVersionPair[];
    readonly removed: ToolVersionPair[];
    readonly output: string;
    readonly exitCode: number;
}
export interface UninstallAnswer {
    readonly command: string;
    readonly exitCode: number;
    readonly ok: boolean;
    readonly removed: ToolVersionPair[];
    /** Config requests the uninstall dropped because they pointed at nothing. */
    readonly forgot: ForgotRequest[];
    readonly notInstalled: boolean;
    readonly output: string;
}
/** `mise_uninstall`'s other half: the request that went with the files. */
export interface UnuseAnswer {
    readonly command: string;
    readonly exitCode: number;
    readonly ok: boolean;
    readonly tool: string;
    readonly path: string;
    readonly output: string;
}
/** One config request removed after its version went away, and the file it was in. */
export interface ForgotRequest {
    readonly tool: string;
    readonly version: string;
    readonly path: string;
}
/**
 * The prunable rows in a prune dry run.
 *
 * mise prints one `mise <tool>@<version> [dryrun]  uninstall` line per victim, and
 * a reason line before it. Parsing the structured line (not the human sentence)
 * keeps a translated or reformatted reason from emptying the list.
 */
/** Progress lines of `mise uninstall`: `mise ✓ jq@1.6  7ms`. */
export declare function parseRemoved(output: unknown): ToolVersionPair[];
export declare function parsePrunable(output: unknown): ToolVersionPair[];
