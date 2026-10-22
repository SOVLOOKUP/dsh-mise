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
import type * as ReactNS from 'react';
/** The module table hands modules over by id; everything but React is untrusted. */
type ModuleRequire = (id: string) => unknown;
/** What the loader's `load` seam takes: this bundle's id, plus its factory. */
interface LoadedModule {
    readonly id: string;
    factory(require: ModuleRequire): PluginModule;
}
/** What the Host reads off the factory's return value. */
interface PluginModule {
    readonly name: string;
    readonly inject: readonly string[];
    apply(ctx: ClientContext): void;
}
/** The one loader member this bundle calls. */
interface ModuleLoader {
    load(module: LoadedModule): void;
}
declare global {
    interface Window {
        /** dsh's client module table: one global, one `load` per bundle. */
        readonly __ModuleLoader__: ModuleLoader;
    }
}
/** One RPC round-trip: `<channel>/<method>` carrying the `{ args }` envelope. */
interface RpcCaller {
    call(channel: string, method: string, payload: {
        readonly args: unknown;
    }): Promise<unknown>;
}
/** `ctx.get('connection')`: the authenticated channel this panel rides on. */
interface ConnectionService {
    readonly rpc?: RpcCaller | undefined;
}
/** The translator `locale.bind` hands out for one namespace. */
type Translate<Key extends string = string> = (key: Key) => string;
/** `ctx.locale`: register the dictionaries once, then bind the translator. */
interface LocaleService {
    register(namespace: string, dictionaries: {
        readonly zh: Readonly<Record<string, string>>;
        readonly en: Readonly<Record<string, string>>;
    }): void;
    bind(namespace: string): Translate;
}
/** One settings-section registration; `Props` is whatever `inject` returns. */
interface SettingsSectionConfig<Props> {
    readonly name: 'settings.section';
    readonly id: string;
    readonly order: number;
    readonly label: () => ReactNS.ReactNode;
    readonly inject: () => Props;
}
/** `ctx.slots`: the shell's settings-section table. */
interface SlotsService {
    inject(name: 'settings.section', register: () => void): void;
    register<Props>(config: SettingsSectionConfig<Props>, render: (props: Props) => ReactNS.ReactNode): void;
}
/** The `apply(ctx)` surface this page uses. */
interface ClientContext {
    effect(callback: () => void | (() => void), label: string): void;
    get(name: 'connection'): ConnectionService | undefined;
    readonly locale: LocaleService;
    readonly slots: SlotsService;
}
export {};
