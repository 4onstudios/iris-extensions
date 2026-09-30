import type { ChatChunk, ChatRequest } from "./api.js";
import { checkAbort, combinedSignal, disposable } from "./core.js";
import type { Disposable } from "./core.js";
import type { AgentsPort } from "./ports.js";

export interface ChatAgent extends Disposable {
  stream(
    caller: string,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk>;
}
/** Host-owned catalogue. Extensions can only invoke explicitly granted agent IDs. */
export class AgentRegistry implements AgentsPort, Disposable {
  #agents = new Map<
    string,
    { agent: ChatAgent; signal: AbortSignal; dispose(): void }
  >();
  #disposed = false;
  register(id: string, agent: ChatAgent): Disposable {
    if (this.#disposed) throw new Error("Agent registry is disposed");
    if (this.#agents.has(id)) throw new Error(`Agent already exists: ${id}`);
    const controller = new AbortController();
    const release = disposable(() => {
      this.#agents.delete(id);
      controller.abort();
      agent.dispose();
    });
    this.#agents.set(id, {
      agent,
      signal: controller.signal,
      dispose: release.dispose,
    });
    return release;
  }
  async *stream(
    caller: string,
    id: string,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    const entry = this.#agents.get(id);
    if (!entry || this.#disposed)
      throw new Error(`Agent is unavailable: ${id}`);
    const linked = combinedSignal(signal, entry.signal);
    checkAbort(linked);
    for await (const chunk of entry.agent.stream(caller, request, linked)) {
      checkAbort(linked);
      yield chunk;
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    for (const entry of [...this.#agents.values()]) {
      try {
        entry.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Agent cleanup failed");
  }
}
