export interface Disposable {
  dispose(): void;
}
export type Event<T> = (listener: (value: T) => void) => Disposable;
export type MaybePromise<T> = T | Promise<T>;
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export function disposable(fn: () => void): Disposable {
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
export class DisposableStore implements Disposable {
  #items = new Set<Disposable>();
  #disposed = false;
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}
  add<T extends Disposable>(item: T): T {
    if (this.#disposed) item.dispose();
    else this.#items.add(item);
    return item;
  }
  delete(item: Disposable): void {
    this.#items.delete(item);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const items = [...this.#items].reverse();
    this.#items.clear();
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        try {
          this.onError(error);
        } catch {
          /* continue cleanup */
        }
      }
    }
  }
}

export class Emitter<T> implements Disposable {
  #listeners = new Set<(value: T) => void>();
  #disposed = false;
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}
  readonly event: Event<T> = (listener) => {
    if (this.#disposed) throw new Error("Emitter is disposed");
    this.#listeners.add(listener);
    return disposable(() => this.#listeners.delete(listener));
  };
  fire(value: T): void {
    for (const listener of [...this.#listeners]) {
      const report = (error: unknown) => {
        try {
          this.onError(error);
        } catch {
          /* isolate reporting */
        }
      };
      try {
        void Promise.resolve(listener(value)).catch(report);
      } catch (error) {
        report(error);
      }
    }
  }
  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}

export function abortError(): Error {
  return new DOMException("Operation cancelled", "AbortError");
}
export function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? abortError();
}

/** The underlying work must also honor the signal; this only bounds the wait. */
export function withAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function combinedSignal(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal {
  return AbortSignal.any(
    signals.filter((s): s is AbortSignal => s !== undefined),
  );
}

/** Single consumer, bounded buffering; used by push-based ACP transports. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiter:
    | {
        resolve: (value: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  #ended = false;
  #error: unknown;
  #claimed = false;
  constructor(private readonly capacity = 256) {}
  push(value: T): void {
    if (this.#ended) return;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      waiter.resolve({ done: false, value });
    } else {
      if (this.#values.length >= this.capacity)
        throw new Error("Stream consumer is too slow");
      this.#values.push(value);
    }
  }
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#waiter?.resolve({ done: true, value: undefined });
    this.#waiter = undefined;
  }
  fail(error: unknown): void {
    if (this.#ended) return;
    this.#error = error;
    this.#values = [];
    this.#ended = true;
    this.#waiter?.reject(error);
    this.#waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.#claimed) throw new Error("Stream already has a consumer");
    this.#claimed = true;
    return {
      next: () => {
        if (this.#error !== undefined) return Promise.reject(this.#error);
        if (this.#values.length)
          return Promise.resolve({ done: false, value: this.#values.shift()! });
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
