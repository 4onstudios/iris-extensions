import type { ChatChunk, ChatRequest } from "./api.js";
import type { Disposable } from "./core.js";
import type { AgentsPort } from "./ports.js";
export interface ChatAgent extends Disposable {
    stream(caller: string, request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
}
/** Host-owned catalogue. Extensions can only invoke explicitly granted agent IDs. */
export declare class AgentRegistry implements AgentsPort, Disposable {
    #private;
    register(id: string, agent: ChatAgent): Disposable;
    stream(caller: string, id: string, request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
    dispose(): void;
}
//# sourceMappingURL=agents.d.ts.map