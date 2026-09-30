export interface Disposable {
    dispose(): void;
}
export type Event<T> = (listener: (value: T) => void) => Disposable;
export type MaybePromise<T> = T | Promise<T>;
export type Json = null | boolean | number | string | Json[] | {
    [key: string]: Json;
};
export declare function disposable(fn: () => void): Disposable;
/** LIFO cleanup; one broken resource must not prevent the remaining cleanup. */
export declare class DisposableStore implements Disposable {
    #private;
    private readonly onError;
    constructor(onError?: (error: unknown) => void);
    add<T extends Disposable>(item: T): T;
    delete(item: Disposable): void;
    dispose(): void;
}
export declare class Emitter<T> implements Disposable {
    #private;
    private readonly onError;
    constructor(onError?: (error: unknown) => void);
    readonly event: Event<T>;
    fire(value: T): void;
    dispose(): void;
}
export declare function abortError(): Error;
export declare function checkAbort(signal: AbortSignal): void;
/** The underlying work must also honor the signal; this only bounds the wait. */
export declare function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T>;
export declare function combinedSignal(...signals: (AbortSignal | undefined)[]): AbortSignal;
/** Single consumer, bounded buffering; used by push-based ACP transports. */
export declare class AsyncQueue<T> implements AsyncIterable<T> {
    #private;
    private readonly capacity;
    constructor(capacity?: number);
    push(value: T): void;
    end(): void;
    fail(error: unknown): void;
    [Symbol.asyncIterator](): AsyncIterator<T>;
}
//# sourceMappingURL=core.d.ts.map