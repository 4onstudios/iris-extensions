import type { Disposable, DisposableStore, Event, Json, MaybePromise } from "./core.js";
/** Resource identifiers are absolute URIs. ACP cwd is an OS path instead. */
export type Uri = string;
/** Zero-based line and UTF-16 character coordinates, like LSP and VS Code. */
export interface Position {
    readonly line: number;
    readonly character: number;
}
export interface Range {
    readonly start: Position;
    readonly end: Position;
}
export interface TextEdit {
    readonly range: Range;
    readonly newText: string;
}
/** Immutable snapshot: never expose a mutable Monaco model to an extension. */
export interface TextDocument {
    readonly uri: Uri;
    readonly languageId: string;
    readonly version: number;
    readonly text: string;
}
export interface DocumentEdit {
    readonly uri: Uri;
    readonly expectedVersion: number;
    readonly edits: readonly TextEdit[];
}
export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
}
export interface FileChange {
    readonly uri: Uri;
    readonly type: "created" | "changed" | "deleted";
}
export interface QuickPickItem {
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
}
export interface OutputChannel extends Disposable {
    appendLine(text: string): void;
    clear(): void;
    show(): void;
}
export interface CompletionItem {
    readonly label: string;
    readonly insertText: string;
    readonly detail?: string;
    readonly range?: Range;
    readonly kind?: "text" | "function" | "variable" | "keyword" | "snippet";
}
export interface CompletionProvider {
    readonly triggerCharacters?: readonly string[];
    provideCompletions(document: TextDocument, position: Position, signal: AbortSignal): MaybePromise<readonly CompletionItem[]>;
}
export interface Hover {
    readonly markdown: string;
    readonly range?: Range;
}
export interface HoverProvider {
    provideHover(document: TextDocument, position: Position, signal: AbortSignal): MaybePromise<Hover | undefined>;
}
export interface Diagnostic {
    readonly range: Range;
    readonly message: string;
    readonly severity: "error" | "warning" | "information" | "hint";
    readonly source?: string;
    readonly code?: string;
}
export interface DiagnosticCollection extends Disposable {
    set(uri: Uri, diagnostics: readonly Diagnostic[]): void;
    delete(uri: Uri): void;
    clear(): void;
}
export interface TerminalOptions {
    readonly name: string;
    readonly cwd?: Uri;
    /** Executable and arguments stay separate; the backend chooses permitted programs. */
    readonly executable?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
}
export interface Terminal extends Disposable {
    readonly id: string;
    readonly onData: Event<string>;
    readonly onExit: Event<{
        readonly code: number | null;
    }>;
    /** Input to the PTY; this can execute a command. It is never terminal output. */
    sendText(text: string, addNewLine?: boolean): Promise<void>;
    resize(columns: number, rows: number): Promise<void>;
    show(): void;
}
export interface ChatContext {
    readonly id: string;
    readonly label: string;
    readonly text: string;
    readonly uri?: Uri;
}
export interface ChatRequest {
    readonly conversationId: string;
    readonly prompt: string;
    /** Only attachments explicitly selected for this request. */
    readonly context?: readonly ChatContext[];
}
export type ChatChunk = {
    readonly type: "text";
    readonly text: string;
} | {
    readonly type: "progress";
    readonly message: string;
} | {
    readonly type: "acp-update";
    readonly update: Readonly<Record<string, unknown>>;
} | {
    readonly type: "done";
    readonly stopReason: string;
};
export type ChatHandler = (request: ChatRequest, signal: AbortSignal) => AsyncIterable<ChatChunk>;
export interface ChatContextProvider {
    provideContext(query: string, signal: AbortSignal): MaybePromise<readonly ChatContext[]>;
}
export declare const PERMISSIONS: readonly ["workspace.read", "workspace.write", "editor.read", "editor.write", "languages.register", "terminal.create", "chat.register", "chat.use", "commands.execute"];
export type Permission = (typeof PERMISSIONS)[number];
export type ActivationEvent = "onStartupFinished" | `onLanguage:${string}` | `onCommand:${string}` | `onChatParticipant:${string}` | `onChatContext:${string}`;
export interface CommandContribution {
    readonly id: string;
    readonly title: string;
    readonly category?: string;
}
export interface ChatContribution {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
}
export interface ExtensionManifest {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    /** Exact major API compatibility. This is not an npm semver range. */
    readonly apiVersion: 1;
    readonly activationEvents?: readonly ActivationEvent[];
    readonly permissions?: readonly Permission[];
    readonly contributes?: {
        readonly commands?: readonly CommandContribution[];
        readonly chatParticipants?: readonly ChatContribution[];
        readonly chatContextProviders?: readonly ChatContribution[];
    };
}
export interface ExtensionState {
    get(key: string): Promise<Json | undefined>;
    /** undefined deletes a key. Storage is automatically scoped to extension ID. */
    update(key: string, value: Json | undefined): Promise<void>;
}
export interface ExtensionContext {
    readonly extension: ExtensionManifest;
    readonly subscriptions: DisposableStore;
    readonly signal: AbortSignal;
    readonly workspaceState: ExtensionState;
    readonly globalState: ExtensionState;
    readonly log: {
        info(message: string): void;
        error(message: string, error?: unknown): void;
    };
}
export interface ExtensionApi {
    readonly version: "1.0.0";
    readonly commands: {
        registerCommand(id: string, handler: (...args: Json[]) => MaybePromise<Json | void>): Disposable;
        executeCommand(id: string, ...args: Json[]): Promise<Json | void>;
    };
    readonly workspace: {
        getFolders(): Promise<readonly WorkspaceFolder[]>;
        readFile(uri: Uri): Promise<Uint8Array>;
        writeFile(uri: Uri, content: Uint8Array): Promise<void>;
        findFiles(glob: string, signal?: AbortSignal): Promise<readonly Uri[]>;
        readonly onDidChangeFiles: Event<readonly FileChange[]>;
    };
    readonly editor: {
        getActiveDocument(): Promise<TextDocument | undefined>;
        openDocument(uri: Uri): Promise<TextDocument>;
        /** One document, atomic version check; overlapping edits are rejected. */
        applyEdits(edit: DocumentEdit): Promise<boolean>;
        readonly onDidChangeDocument: Event<TextDocument>;
    };
    readonly languages: {
        registerCompletionProvider(languageId: string, provider: CompletionProvider): Disposable;
        registerHoverProvider(languageId: string, provider: HoverProvider): Disposable;
        createDiagnosticCollection(name: string): DiagnosticCollection;
    };
    readonly window: {
        showMessage(message: string, kind?: "info" | "warning" | "error"): Promise<void>;
        showQuickPick(items: readonly QuickPickItem[], placeholder?: string): Promise<string | undefined>;
        createOutputChannel(name: string): OutputChannel;
    };
    readonly terminals: {
        createTerminal(options: TerminalOptions): Promise<Terminal>;
    };
    readonly chat: {
        registerParticipant(id: string, handler: ChatHandler): Disposable;
        registerContextProvider(id: string, provider: ChatContextProvider): Disposable;
        requestAgent(agentId: string, request: ChatRequest, signal?: AbortSignal): AsyncIterable<ChatChunk>;
    };
}
export interface ExtensionModule {
    activate(context: ExtensionContext, api: ExtensionApi): MaybePromise<void>;
    deactivate?(): MaybePromise<void>;
}
export declare function defineExtension(module: ExtensionModule): ExtensionModule;
//# sourceMappingURL=api.d.ts.map