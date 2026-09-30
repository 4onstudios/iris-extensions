import { client } from "@agentclientprotocol/sdk";
import type {
  Agent,
  AgentApp,
  InitializeResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  Stream,
} from "@agentclientprotocol/sdk";
import type { ChatChunk, ChatRequest } from "../api.js";
import {
  abortError,
  AsyncQueue,
  checkAbort,
  combinedSignal,
  Emitter,
  withAbort,
} from "../core.js";
import type { Disposable } from "../core.js";

export type AcpWire = Pick<Agent, "newSession" | "prompt" | "cancel">;
export interface AcpOptions {
  /** Absolute OS path, fixed to this backend agent's workspace. Never a file:// URI. */
  readonly cwd: string;
  readonly onError: (error: unknown) => void;
  readonly decidePermission?: (
    request: RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<RequestPermissionOutcome>;
  readonly maxSessions?: number;
  readonly maxBufferedChunks?: number;
}
interface Turn {
  readonly key: string;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly queue: AsyncQueue<ChatChunk>;
  sessionId?: string;
  promptStarted: boolean;
  settled: boolean;
  cancelSent: boolean;
}

/** A text-chat adapter over an already initialized ACP v1 connection. */
export class AcpChatAgent implements Disposable {
  #sessions = new Map<string, string>();
  #turns = new Map<string, Turn>();
  #life = new AbortController();
  #updates: Emitter<SessionNotification>;
  readonly onDidUpdate;

  constructor(
    private readonly wire: AcpWire,
    initialization: InitializeResponse,
    private readonly options: AcpOptions,
    private readonly closeTransport?: () => void,
  ) {
    if (initialization.protocolVersion !== 1)
      throw new Error(
        `Unsupported ACP version: ${initialization.protocolVersion}`,
      );
    if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(options.cwd))
      throw new Error("ACP cwd must be an absolute OS path");
    this.#updates = new Emitter((error) => this.#report(error));
    this.onDidUpdate = this.#updates.event;
  }
  #report(error: unknown): void {
    try {
      this.options.onError(error);
    } catch {
      /* isolate logging */
    }
  }
  #cancel(turn: Turn): void {
    if (
      !turn.promptStarted ||
      turn.settled ||
      turn.cancelSent ||
      !turn.sessionId
    )
      return;
    turn.cancelSent = true;
    void Promise.resolve()
      .then(() => this.wire.cancel({ sessionId: turn.sessionId! }))
      .catch((error) => this.#report(error));
  }
  /** Route your ACP client's session/update callback here. Never parse stdout ad hoc. */
  acceptUpdate(notification: SessionNotification): void {
    if (this.#life.signal.aborted) return;
    this.#updates.fire(notification); // includes idle-session updates for the IDE UI
    const turn = [...this.#turns.values()].find(
      (item) => item.sessionId === notification.sessionId,
    );
    if (!turn || turn.signal.aborted || turn.settled) return;
    const update = notification.update;
    try {
      // Preserve all protocol variants. The UI renders text chunks once, not twice.
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ) {
        if (update.content.text.length > 1_048_576)
          throw new Error("ACP text chunk exceeds limit");
        turn.queue.push({ type: "text", text: update.content.text });
      } else {
        if (JSON.stringify(update).length > 1_048_576)
          throw new Error("ACP update exceeds limit");
        turn.queue.push({
          type: "acp-update",
          update: structuredClone(update) as unknown as Readonly<
            Record<string, unknown>
          >,
        });
      }
    } catch (error) {
      turn.queue.fail(error);
      turn.controller.abort(error);
      this.#cancel(turn);
    }
  }
  /** Unknown sessions, cancelled turns, absent handlers, and invalid option IDs deny. */
  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const turn = [...this.#turns.values()].find(
      (item) => item.sessionId === request.sessionId,
    );
    const denied: RequestPermissionResponse = {
      outcome: { outcome: "cancelled" },
    };
    if (
      !turn ||
      turn.signal.aborted ||
      turn.settled ||
      !this.options.decidePermission
    )
      return denied;
    try {
      const outcome = await withAbort(
        this.options.decidePermission(structuredClone(request), turn.signal),
        turn.signal,
      );
      if (turn.signal.aborted || turn.settled) return denied;
      if (
        outcome.outcome === "selected" &&
        !request.options.some((option) => option.optionId === outcome.optionId)
      )
        return denied;
      return { outcome };
    } catch (error) {
      if (!turn.signal.aborted) this.#report(error);
      return denied;
    }
  }
  async *stream(
    caller: string,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    checkAbort(this.#life.signal);
    checkAbort(signal);
    if (!caller || !request.conversationId)
      throw new Error("Caller and conversation ID are required");
    if (
      request.prompt.length +
        (request.context ?? []).reduce(
          (sum, value) => sum + value.text.length,
          0,
        ) >
      1_048_576
    )
      throw new Error("Chat request exceeds limit");
    const key = JSON.stringify([caller, request.conversationId]);
    if (this.#turns.has(key))
      throw new Error("A prompt is already running in this conversation");
    const controller = new AbortController();
    const linked = combinedSignal(signal, controller.signal, this.#life.signal);
    const turn: Turn = {
      key,
      controller,
      signal: linked,
      queue: new AsyncQueue(this.options.maxBufferedChunks ?? 256),
      promptStarted: false,
      settled: false,
      cancelSent: false,
    };
    this.#turns.set(key, turn);
    const aborted = () => {
      turn.queue.fail(linked.reason ?? abortError());
      this.#cancel(turn);
    };
    linked.addEventListener("abort", aborted, { once: true });
    // Keep this lane locked until the actual remote prompt settles, even after local abort.
    // Otherwise late notifications from a cancelled prompt could leak into the next turn.
    void this.#pump(turn, request)
      .catch((error) => turn.queue.fail(error))
      .finally(() => {
        turn.settled = true;
        turn.queue.end();
        linked.removeEventListener("abort", aborted);
        this.#turns.delete(key);
      });
    try {
      for await (const chunk of turn.queue) yield chunk;
    } finally {
      if (!turn.settled) {
        controller.abort(abortError());
        this.#cancel(turn);
      }
    }
  }
  async #pump(turn: Turn, request: ChatRequest): Promise<void> {
    checkAbort(turn.signal);
    let sessionId = this.#sessions.get(turn.key);
    if (!sessionId) {
      // Count reservations as well as completed sessions to enforce the concurrent limit.
      const pending = [...this.#turns.keys()].filter(
        (key) => !this.#sessions.has(key),
      ).length;
      if (this.#sessions.size + pending > (this.options.maxSessions ?? 100))
        throw new Error(
          "ACP session limit reached; reconnect or forget a conversation",
        );
      const session = await this.wire.newSession({
        cwd: this.options.cwd,
        mcpServers: [],
      });
      sessionId = session.sessionId;
      if ([...this.#sessions.values()].includes(sessionId))
        throw new Error("Agent returned a duplicate session ID");
      if (!this.#life.signal.aborted) this.#sessions.set(turn.key, sessionId);
    }
    turn.sessionId = sessionId;
    checkAbort(turn.signal); // cancelling during session/new must never send a prompt
    const prompt = [
      ...(request.context ?? []).map((item) => ({
        type: "text" as const,
        text: `Attached context: ${item.label}${item.uri ? ` (${item.uri})` : ""}\n${item.text}`,
      })),
      { type: "text" as const, text: request.prompt },
    ];
    turn.promptStarted = true;
    const response = await this.wire.prompt({ sessionId, prompt });
    turn.settled = true;
    if (!turn.signal.aborted)
      turn.queue.push({ type: "done", stopReason: response.stopReason });
  }
  /** Drops local history routing. ACP v1 does not guarantee a session-close capability. */
  forgetConversation(caller: string, conversationId: string): void {
    const key = JSON.stringify([caller, conversationId]);
    if (this.#turns.has(key))
      throw new Error("Cannot forget a running conversation");
    this.#sessions.delete(key);
  }
  dispose(): void {
    if (this.#life.signal.aborted) return;
    this.#life.abort(abortError());
    this.#sessions.clear();
    this.#updates.dispose();
    this.closeTransport?.();
  }
}

/** Optional SDK 1.4 connector. For an existing IDE ACP transport, use AcpChatAgent directly. */
export async function connectAcp(
  stream: Stream | AgentApp,
  options: AcpOptions,
): Promise<AcpChatAgent> {
  let bridge: AcpChatAgent | undefined;
  const app = client()
    .onNotification("session/update", ({ params }) =>
      bridge?.acceptUpdate(params),
    )
    .onRequest(
      "session/request_permission",
      ({ params }) =>
        bridge?.requestPermission(params) ?? {
          outcome: { outcome: "cancelled" },
        },
    );
  // SDK overloads accept either of these concrete transport forms.
  const connection =
    "readable" in stream ? app.connect(stream) : app.connect(stream);
  try {
    const initialization = await withAbort(
      connection.agent.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "iris-ide", version: "0.1.0" },
        clientCapabilities: {},
      }),
      combinedSignal(connection.signal, AbortSignal.timeout(15_000)),
    );
    const wire: AcpWire = {
      newSession: (params) => connection.agent.request("session/new", params),
      prompt: (params) => connection.agent.request("session/prompt", params),
      cancel: (params) => connection.agent.notify("session/cancel", params),
    };
    bridge = new AcpChatAgent(wire, initialization, options, () =>
      connection.close(),
    );
    connection.signal.addEventListener("abort", () => bridge?.dispose(), {
      once: true,
    });
    return bridge;
  } catch (error) {
    connection.close();
    throw error;
  }
}
