import type {
  ChatChunk,
  ChatRequest,
  CompletionProvider,
  DiagnosticCollection,
  DocumentEdit,
  FileChange,
  HoverProvider,
  OutputChannel,
  QuickPickItem,
  Terminal,
  TerminalOptions,
  TextDocument,
  Uri,
  WorkspaceFolder,
} from "./api.js";
import type { Disposable, Event, Json } from "./core.js";

/** Host-only ports. Implement these in the IDE, never in an untrusted extension. */
export interface WorkspacePort {
  getFolders(
    caller: string,
    signal: AbortSignal,
  ): Promise<readonly WorkspaceFolder[]>;
  readFile(caller: string, uri: Uri, signal: AbortSignal): Promise<Uint8Array>;
  writeFile(
    caller: string,
    uri: Uri,
    content: Uint8Array,
    signal: AbortSignal,
  ): Promise<void>;
  findFiles(
    caller: string,
    glob: string,
    signal: AbortSignal,
  ): Promise<readonly Uri[]>;
  onDidChangeFiles(caller: string): Event<readonly FileChange[]>;
}
export interface EditorPort {
  getActiveDocument(
    caller: string,
    signal: AbortSignal,
  ): Promise<TextDocument | undefined>;
  openDocument(
    caller: string,
    uri: Uri,
    signal: AbortSignal,
  ): Promise<TextDocument>;
  applyEdits(
    caller: string,
    edit: DocumentEdit,
    signal: AbortSignal,
  ): Promise<boolean>;
  onDidChangeDocument(caller: string): Event<TextDocument>;
}
export interface LanguagesPort {
  registerCompletionProvider(
    caller: string,
    language: string,
    provider: CompletionProvider,
  ): Disposable;
  registerHoverProvider(
    caller: string,
    language: string,
    provider: HoverProvider,
  ): Disposable;
  createDiagnosticCollection(
    caller: string,
    name: string,
  ): DiagnosticCollection;
}
export interface WindowPort {
  showMessage(
    caller: string,
    message: string,
    kind: "info" | "warning" | "error",
    signal: AbortSignal,
  ): Promise<void>;
  showQuickPick(
    caller: string,
    items: readonly QuickPickItem[],
    placeholder: string | undefined,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  createOutputChannel(caller: string, name: string): OutputChannel;
}
export interface StoragePort {
  get(
    caller: string,
    scope: "workspace" | "global",
    key: string,
    signal: AbortSignal,
  ): Promise<Json | undefined>;
  update(
    caller: string,
    scope: "workspace" | "global",
    key: string,
    value: Json | undefined,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface TerminalsPort {
  /** dispose must terminate the PTY/process and free listeners; creation honors abort. */
  create(
    caller: string,
    options: TerminalOptions,
    signal: AbortSignal,
  ): Promise<Terminal>;
}
export interface AgentsPort {
  stream(
    caller: string,
    agentId: string,
    request: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk>;
}
export interface HostServices {
  readonly workspace: WorkspacePort;
  readonly editor: EditorPort;
  readonly window: WindowPort;
  readonly storage: StoragePort;
  readonly languages?: LanguagesPort;
  readonly terminals?: TerminalsPort;
  readonly agents?: AgentsPort;
  readonly log: (
    caller: string,
    level: "info" | "error",
    message: string,
    error?: unknown,
  ) => void;
}
