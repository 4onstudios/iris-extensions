import { checkAbort, combinedSignal, disposable } from "./core.js";
/** Host-owned catalogue. Extensions can only invoke explicitly granted agent IDs. */
export class AgentRegistry {
    #agents = new Map();
    #disposed = false;
    register(id, agent) {
        if (this.#disposed)
            throw new Error("Agent registry is disposed");
        if (this.#agents.has(id))
            throw new Error(`Agent already exists: ${id}`);
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
    async *stream(caller, id, request, signal) {
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
    dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        const errors = [];
        for (const entry of [...this.#agents.values()]) {
            try {
                entry.dispose();
            }
            catch (error) {
                errors.push(error);
            }
        }
        if (errors.length)
            throw new AggregateError(errors, "Agent cleanup failed");
    }
}
//# sourceMappingURL=agents.js.map