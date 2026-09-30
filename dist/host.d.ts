import type { ActivationEvent, ChatContext, ChatRequest, CommandContribution, ExtensionManifest, ExtensionModule, Permission } from "./api.js";
import type { Disposable, Event, Json, MaybePromise } from "./core.js";
import type { HostServices } from "./ports.js";
export type * from "./ports.js";
export { AgentRegistry } from "./agents.js";
export type { ChatAgent } from "./agents.js";
type Status = "installed" | "activating" | "active" | "disabled" | "failed";
export interface ExtensionInfo {
    readonly manifest: ExtensionManifest;
    readonly status: Status;
    readonly error?: string;
}
export interface ExtensionGrant {
    readonly permissions: readonly Permission[];
    /** Exact allowlist, in addition to commands.execute / chat.use. No wildcard. */
    readonly commandIds?: readonly string[];
    readonly agentIds?: readonly string[];
}
export interface InstallOptions {
    readonly manifest: unknown;
    readonly load: () => Promise<ExtensionModule>;
    readonly grant: ExtensionGrant;
    /** This host executes JS in its own realm. It is NOT a sandbox. */
    readonly trust: "trusted";
}
type Command = (...args: Json[]) => MaybePromise<Json | void>;
export declare class ExtensionHost {
    #private;
    private readonly services;
    private readonly activationTimeoutMs;
    readonly onDidChangeExtensions: Event<readonly ExtensionInfo[]>;
    constructor(services: HostServices, activationTimeoutMs?: number);
    listExtensions(): readonly ExtensionInfo[];
    listCommands(): readonly CommandContribution[];
    install(options: InstallOptions): void;
    registerHostCommand(id: string, handler: Command): Disposable;
    start(): Promise<void>;
    activateEvent(event: ActivationEvent): Promise<void>;
    activate(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    uninstall(id: string): Promise<void>;
    close(): Promise<void>;
    executeCommand(id: string, ...args: Json[]): Promise<Json | void>;
    streamChat(id: string, request: ChatRequest, signal?: AbortSignal): AsyncGenerator<import("./api.js").ChatChunk, void, unknown>;
    resolveChatContext(id: string, query: string, signal?: AbortSignal): Promise<readonly ChatContext[]>;
}
//# sourceMappingURL=host.d.ts.map