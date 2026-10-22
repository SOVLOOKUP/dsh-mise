import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-mise";
export declare const inject: string[];
export declare function apply(ctx: Context, config?: unknown): void;
/** One tool answer: the value, or the failure the model has to read. */
export type AttemptResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: {
        code: string;
        message: string;
    };
};
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
