import type { Agent, AgentApp, InitializeResponse, RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, Stream } from "@agentclientprotocol/sdk";
import type { ChatChunk, ChatRequest } from "../api.js";
import type { Disposable } from "../core.js";
export type AcpWire = Pick<Agent, "newSession" | "prompt" | "cancel">;
export interface AcpOptions {
    /** Absolute OS path, fixed to this backend agent's workspace. Never a file:// URI. */
    readonly cwd: string;
    readonly onError: (error: unknown) => void;
    readonly decidePermission?: (request: RequestPermissionRequest, signal: AbortSignal) => Promise<RequestPermissionOutcome>;
    readonly maxSessions?: number;
    readonly maxBufferedChunks?: number;
}
/** A text-chat adapter over an already initialized ACP v1 connection. */
export declare class AcpChatAgent implements Disposable {
    #private;
    private readonly wire;
    private readonly options;
    private readonly closeTransport?;
    readonly onDidUpdate: import("../core.js").Event<SessionNotification>;
    constructor(wire: AcpWire, initialization: InitializeResponse, options: AcpOptions, closeTransport?: (() => void) | undefined);
    /** Route your ACP client's session/update callback here. Never parse stdout ad hoc. */
    acceptUpdate(notification: SessionNotification): void;
    /** Unknown sessions, cancelled turns, absent handlers, and invalid option IDs deny. */
    requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
    stream(caller: string, request: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
    /** Drops local history routing. ACP v1 does not guarantee a session-close capability. */
    forgetConversation(caller: string, conversationId: string): void;
    dispose(): void;
}
/** Optional SDK 1.4 connector. For an existing IDE ACP transport, use AcpChatAgent directly. */
export declare function connectAcp(stream: Stream | AgentApp, options: AcpOptions): Promise<AcpChatAgent>;
//# sourceMappingURL=acp.d.ts.map