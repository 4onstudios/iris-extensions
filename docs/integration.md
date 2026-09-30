# Connecting the SDK to your IDE

Create one `ExtensionHost` per workspace. Keep it outside React component renders, and close it during workspace/application teardown. For Vite/React hot reload, explicitly dispose the previous host and its adapters before creating another.

## Execution boundary

The delivered runtime loads **trusted JavaScript modules** supplied by your IDE's loader. It performs permission checks on its own API, but same-realm code can still access globals, imports, the DOM, or Tauri functions independently. Freezing an API object and requiring a `trust` flag do not isolate a module.

For untrusted extensions, put the extension runtime in a separate process or restricted runtime without direct Tauri/native authority. Expose serializable RPC operations through a host broker; derive extension identity from the transport endpoint, validate payloads, check per-extension grants again at that broker, and enforce filesystem/process/network limits in the backend. A Web Worker alone does not supply an OS security sandbox. The same-realm runtime does not implement that broker or containment.

Tauri capabilities belong to windows/webviews, so do not rely on them to distinguish several JavaScript extensions inside one renderer. The backend must enforce the caller's approved workspace roots and executable policy. Canonicalize paths on the backend; a frontend URI prefix check does not handle symlink escapes or file replacement races.

## Map your dependencies

| Your dependency/service                      | SDK integration                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@monaco-editor/react`, `monaco-editor`      | Obtain the loaded Monaco instance; call `createMonacoPorts` once. Return your active editor and open models through its options.                                                            |
| React, router, tree UI                       | Render `host.listCommands()` in the palette. Subscribe to `onDidChangeExtensions` and call `executeCommand` on selection. Build notifications/quick picks/output tabs through `WindowPort`. |
| `@assistant-ui/react`                        | Consume `host.streamChat` inside your existing assistant-ui runtime/adapter. Map text chunks to assistant message text, progress to status, and ACP updates to tool/plan UI.                |
| `@4onstudios/iris-agent`                     | Reuse your existing ACP connection, or launch its verified stdio CLI in your backend and connect through the supplied ACP adapter.                                                          |
| `@agentclientprotocol/codex-acp`             | Use a separate approved backend agent connection and register it under a distinct ID, such as `codex`. The SDK does not assume this package's CLI flags.                                    |
| xterm and addons                             | Keep your existing PTY service. `bindXterm` connects a `Terminal` handle to a view; keep fit and link addons owned by the IDE.                                                              |
| Tauri filesystem plugin / filesystem backend | Implement `WorkspacePort`, retaining native scope checks and your unsaved-file policy.                                                                                                      |
| Tauri SQL / existing SQLite layer            | Implement `StoragePort`; include extension ID and workspace identity in keys.                                                                                                               |
| pyright / TypeScript language server         | Keep your current LSP bridge. This SDK adds editor completion/hover/diagnostic providers; it is not an LSP client.                                                                          |
| Zod 4                                        | Optional for your backend/RPC schemas. The SDK manifest validator does not require another Zod version.                                                                                     |

The SDK does not replace assistant-ui, your file tree, terminal renderer, Git layer, or application database. It gives extensions stable access to selected IDE services.

## Editor and language providers

`examples/integration.ts` is type-checked against Monaco 0.56.0. Its `MonacoOptions` require:

1. `getActiveEditor()` — return the existing active editor instance.
2. `openDocument(uri, signal)` — use your tab/file manager to open or select a file, then return the model.
3. `canEdit(model)` — reflect readonly files and workspace state for active and inactive models.
4. `onError(error)` — route provider failures to IDE logs.

Language activation must also run for models already open at startup and after their language changes; the example wires both cases. Language registration does not launch a language server or register a new language grammar.

`editor.applyEdits` is atomic for **one already-open model**. It validates every range before changing anything, rejects overlaps, checks `expectedVersion`, and inserts undo boundaries. It returns `false` if the model is unavailable, readonly, or stale, and throws on malformed ranges. It does not implement atomic edits across several files. It updates the editor model without automatically saving to disk.

Each diagnostic collection has a distinct Monaco marker owner. Disposing one collection clears only that collection. Hover markdown uses `isTrusted: false` and disables HTML.

## Workspace and persistence ports

Every port receives a caller ID selected by the host. Preserve it through authenticated IPC; do not accept a caller ID chosen freely by an extension as native authorization.

`WorkspacePort` must perform real path authorization, file I/O, glob expansion, and scoped watch events. Keep writes consistent with dirty editor buffers. Check its abort signal before committing changes. The memory fixture is deliberately only a demonstration, and its `findFiles` is not a production glob implementation.

`StoragePort` keys should be composed as `(extensionId, scope, workspaceId?, key)`, with the current workspace ID held by that host's service instance. Use bound SQL parameters and JSON serialization; `undefined` deletes a key. Global state should remain independent of workspace selection. The SDK clones values at the boundary, but it does not manage SQL migrations or encrypt secrets. Keep credentials in your existing backend credential store, not extension state.

## Terminal port

Implement `TerminalsPort.create` around your existing terminal service. An owned `Terminal` must provide:

- `sendText(text, addNewLine)` writes PTY **input**; `false` preserves exact keyboard/paste bytes. Define and implement the platform newline behavior once in your backend.
- `onData` streams PTY **output**, and `onExit` reports process completion.
- `resize` changes PTY dimensions as well as the visual view.
- `show` selects the appropriate terminal tab.
- `dispose` terminates the owned process and releases subscriptions. It must be idempotent.

If creation is aborted, the backend should stop it. The host also disposes a terminal that arrives late from a backend which missed cancellation. Disabling an extension terminates its SDK-owned terminals by design; user-created terminals outside this API have a separate lifecycle.

Use `bindXterm(view, terminal, onError)` for an existing xterm instance. Its returned disposable detaches the view without killing the process; the owning extension/host manages process lifetime. On buffer overflow the binding detaches and calls `onError`. Your handler should pause or terminate the PTY and surface the reason. For sustained high throughput, use your backend's credit/acknowledgment flow control.

xterm is the emulator, and Tauri shell process spawning is not itself a complete interactive PTY implementation. This SDK expects the terminal backend you said the IDE already has; it does not invent a `pty_*` Tauri command API.

## ACP and Iris

The published Iris 0.2.9 package was inspected. Its executable is `iris-agent`; ACP mode uses `--acp`, and the workspace argument is `--workspace <absolute-path>`. The package depends on `@agentclientprotocol/sdk` and also exposes an `IrisClient` helper. Its helper owns **one active session per client**, so do not multiplex different conversations through one helper session.

The adapter below multiplexes sessions through a raw ACP connection and keeps a fixed workspace per agent. It does not reach into `IrisClient` private fields.

### Existing initialized connection

Construct `AcpChatAgent` with `newSession`, `prompt`, and `cancel` operations and the negotiated `InitializeResponse`:

```ts
const iris = new AcpChatAgent(connection, initialization, {
  cwd: workspaceAbsolutePath,
  onError: reportError,
  decidePermission: (request, signal) => permissionUI.choose(request, signal),
});
// In your existing ACP client callbacks:
// sessionUpdate(notification) -> iris.acceptUpdate(notification)
// requestPermission(request) -> iris.requestPermission(request)
```

Wire callbacks before issuing any prompts. Use your transport's disconnect signal to dispose the adapter. If using the newer SDK `ClientContext`, map `request("session/new", params)`, `request("session/prompt", params)`, and `notify("session/cancel", params)` as the three operations, as `connectAcp` does internally.

### New connection

`connectAcp(stream, options)` uses the official ACP SDK 1.4 client API, initializes protocol v1, and returns an owned `AcpChatAgent`. It advertises no filesystem or terminal client capabilities because it does not implement those ACP methods. If your existing ACP client implements these methods, keep its handler routing and capability negotiation, then use the initialized-connection form above.

For a Node backend, `examples/acp-node.mjs` supplies a process launcher using a configured Node executable and Iris CLI path. Keep this module out of the Tauri renderer bundle. Use your normal backend process supervisor in production, including process-tree termination and application shutdown cleanup.

An existing Tauri/Rust process transport can be adapted to the SDK's `Stream` instead. This transport must deliver parsed ACP messages with framing and backpressure. Do not treat arbitrary process output chunks as complete JSON messages; use the official `ndJsonStream` when you have byte streams. Keep stdout exclusively for protocol messages and stderr for logs.

Register the resulting agent with `AgentRegistry`, pass it as `HostServices.agents`, and grant selected extensions the `iris` ID. `chat.use` lets an extension ask that configured agent to act with its existing agent permissions; it is a consequential delegation capability, not merely permission to display chat text. Process credentials and launch arguments remain host-owned.

### Streaming and cancellation

`AcpChatAgent` keys conversations by both extension identity and conversation ID. Different extensions cannot accidentally share a session through matching conversation strings. It sends explicit selected attachments as text blocks, so it does not depend on optional embedded-resource or image capabilities.

One prompt may run per session. A second prompt is rejected while the first is active. Other sessions can run concurrently. The adapter routes updates by ACP session ID and bounds its output queue.

Aborting or breaking consumption sends one `session/cancel`. Pending permission UI resolves as `cancelled`. The local stream stops promptly, but the session remains busy until the actual remote prompt settles; this prevents late output from becoming part of a new turn. If an agent never acknowledges cancellation, reconnect/terminate that agent through your supervisor. The adapter cannot forcibly stop an external agent's tools.

Permission requests default to `cancelled` when no policy/UI callback exists. A selected option must be one of the agent's provided option IDs. The callback belongs to the host, not the extension. Extension API grants, ACP tool permission choices, and OS/native permissions are distinct policies.

Text chunks are normalized to `type: "text"`. Other protocol updates are retained as `type: "acp-update"`; `onDidUpdate` also exposes original notifications to the trusted host, including updates outside prompt turns and message IDs. Render streamed text through one route to avoid duplication. Treat agent text and tool results as untrusted display content.

`forgetConversation` drops local routing and starts fresh on the next prompt. It does not promise remote session deletion: baseline ACP v1 does not require that optional capability. Dispose the whole owned connection when closing a workspace. Session reload/listing, authentication UI, mode/model selection, multimodal prompts, and ACP filesystem/terminal methods remain in your existing full ACP integration.

## UI and extension loading

Use typed module loaders or a curated build registry. The manifest deliberately has no URL-to-import field. Your installer/loader owns artifact selection, signatures/integrity policy, cache invalidation, and ESM loading. For a default-exported module, use `load: async () => (await import("./extension.js")).default`.

Use `host.listExtensions()` for manifest metadata and status; chat contribution metadata is on each manifest. Use `host.listCommands()` for command palette entries. This release does not interpret keybindings, menu conditions, or arbitrary extension HTML.

Quick picks return an item ID or `undefined` on dismissal. Render notification/output/quick-pick strings as text. Update assistant-ui through your installed runtime's own adapter interface; the SDK deliberately does not invent a version-specific assistant-ui React hook.

When a user explicitly selects a context provider, call `host.resolveChatContext(id, query, signal)`, show the returned attachments, and pass selected items to the next chat request. No automatic workspace scan is performed by the SDK.
