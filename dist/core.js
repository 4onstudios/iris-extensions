export function disposable(fn) {
    let alive = true;
    return {
        dispose() {
            if (alive) {
                alive = false;
                fn();
            }
        },
    };
}
/** LIFO cleanup; one broken resource must not prevent the remaining cleanup. */
export class DisposableStore {
    onError;
    #items = new Set();
    #disposed = false;
    constructor(onError = () => { }) {
        this.onError = onError;
    }
    add(item) {
        if (this.#disposed)
            item.dispose();
        else
            this.#items.add(item);
        return item;
    }
    delete(item) {
        this.#items.delete(item);
    }
    dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        const items = [...this.#items].reverse();
        this.#items.clear();
        for (const item of items) {
            try {
                item.dispose();
            }
            catch (error) {
                try {
                    this.onError(error);
                }
                catch {
                    /* continue cleanup */
                }
            }
        }
    }
}
export class Emitter {
    onError;
    #listeners = new Set();
    #disposed = false;
    constructor(onError = () => { }) {
        this.onError = onError;
    }
    event = (listener) => {
        if (this.#disposed)
            throw new Error("Emitter is disposed");
        this.#listeners.add(listener);
        return disposable(() => this.#listeners.delete(listener));
    };
    fire(value) {
        for (const listener of [...this.#listeners]) {
            const report = (error) => {
                try {
                    this.onError(error);
                }
                catch {
                    /* isolate reporting */
                }
            };
            try {
                void Promise.resolve(listener(value)).catch(report);
            }
            catch (error) {
                report(error);
            }
        }
    }
    dispose() {
        this.#disposed = true;
        this.#listeners.clear();
    }
}
export function abortError() {
    return new DOMException("Operation cancelled", "AbortError");
}
export function checkAbort(signal) {
    if (signal.aborted)
        throw signal.reason ?? abortError();
}
/** The underlying work must also honor the signal; this only bounds the wait. */
export function withAbort(work, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? abortError());
        signal.addEventListener("abort", abort, { once: true });
        work
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted)
            abort();
    });
}
export function combinedSignal(...signals) {
    return AbortSignal.any(signals.filter((s) => s !== undefined));
}
/** Single consumer, bounded buffering; used by push-based ACP transports. */
export class AsyncQueue {
    capacity;
    #values = [];
    #waiter;
    #ended = false;
    #error;
    #claimed = false;
    constructor(capacity = 256) {
        this.capacity = capacity;
    }
    push(value) {
        if (this.#ended)
            return;
        if (this.#waiter) {
            const waiter = this.#waiter;
            this.#waiter = undefined;
            waiter.resolve({ done: false, value });
        }
        else {
            if (this.#values.length >= this.capacity)
                throw new Error("Stream consumer is too slow");
            this.#values.push(value);
        }
    }
    end() {
        if (this.#ended)
            return;
        this.#ended = true;
        this.#waiter?.resolve({ done: true, value: undefined });
        this.#waiter = undefined;
    }
    fail(error) {
        if (this.#ended)
            return;
        this.#error = error;
        this.#values = [];
        this.#ended = true;
        this.#waiter?.reject(error);
        this.#waiter = undefined;
    }
    [Symbol.asyncIterator]() {
        if (this.#claimed)
            throw new Error("Stream already has a consumer");
        this.#claimed = true;
        return {
            next: () => {
                if (this.#error !== undefined)
                    return Promise.reject(this.#error);
                if (this.#values.length)
                    return Promise.resolve({ done: false, value: this.#values.shift() });
                if (this.#ended)
                    return Promise.resolve({ done: true, value: undefined });
                return new Promise((resolve, reject) => {
                    this.#waiter = { resolve, reject };
                });
            },
            return: async () => {
                this.#values = [];
                this.end();
                return { done: true, value: undefined };
            },
        };
    }
}
//# sourceMappingURL=core.js.map