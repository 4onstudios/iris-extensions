# Iris IDE extension SDK

A TypeScript extension API and working host runtime for a Tauri, React, Monaco, terminal, and ACP chat IDE. The package name is local and unpublished. Rename it to your preferred namespace before publishing.

**This release runs trusted extensions in the same JavaScript realm as the host. Its API permission checks are not a security sandbox.** Use it for bundled extensions and trusted development modules. See [the execution boundary](docs/integration.md#execution-boundary) before accepting arbitrary third-party code.

## Try it

Use Node 22.18+ for the examples and build tools:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run demo
```

The demo uses an explicitly mocked chat agent and an in-memory terminal. It does not launch a shell, call a model, or require credentials. The archive also contains built ESM and TypeScript declarations in `dist/`.

## Write an extension

```ts
import { defineExtension } from "@4onstudios/iris-extensions";
import type { ExtensionManifest } from "@4onstudios/iris-extensions";

export const manifest = {
  id: "acme.hello",
  name: "Hello",
  version: "1.0.0",
  apiVersion: 1,
  contributes: {
    commands: [{ id: "acme.hello.sayHello", title: "Say hello" }],
  },
} satisfies ExtensionManifest;

export default defineExtension({
  activate(context, api) {
    api.commands.registerCommand("acme.hello.sayHello", async () => {
      await api.window.showMessage("Hello from an extension!");
    });
    context.log.info("Ready");
  },
  deactivate() {
    // Release any resources you created outside the SDK.
  },
});
```

The declared command appears in `host.listCommands()` before loading the extension. Calling `host.executeCommand("acme.hello.sayHello")` loads and activates it once. API-created registrations, listeners, output channels, diagnostic collections, and terminals are cleaned up automatically. Use `context.subscriptions.add(...)` for resources you create yourself.

## Bundled with Iris

Iris consumes this package from the npm registry. The host adapter is `src/extensions/irisRuntime.ts`; it is mounted from both Monaco editor panes and displayed in the existing Extensions panel. The bundled `Document Info` extension demonstrates lazy command activation and a separately owned PTY terminal. See `docs/iris-integration.md` for the exact connected and pending services.

## Install into another IDE

```sh
npm install @4onstudios/iris-extensions
```

`dist/` is built by the `prepare` script and published in the registry tarball, so it is not tracked in Git. Run `npm run build` locally before running the examples directly.

```ts
import { ExtensionHost } from "@4onstudios/iris-extensions/host";
import extension, { manifest } from "./my-extension.js";

// services is your implementation of HostServices. See examples/integration.ts.
const host = new ExtensionHost(services);
host.install({
  manifest,
  trust: "trusted",
  load: async () => extension,
  grant: { permissions: [], agentIds: [], commandIds: [] },
});
await host.start();
```

Grants come from the IDE's extension policy, not from the extension itself. A declared permission does not grant access. The example above is sufficient for the greeting extension; [Dev Tools](examples/devtools.ts) needs the explicit grants shown in [the integration example](examples/integration.ts).

## API surface

| Namespace   | Implemented features                                                                      | Required grant                                                             |
| ----------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `commands`  | Register declared commands; execute own or explicitly allowed commands                    | External calls: `commands.execute` plus command ID allowlist               |
| `workspace` | List roots, read/write bytes, find files, file change events                              | `workspace.read` / `workspace.write`                                       |
| `editor`    | Immutable document snapshots, open documents, change events, atomic single-document edits | `editor.read` / `editor.write`                                             |
| `languages` | Completion providers, hover providers, diagnostic collections                             | `languages.register`; providers also require `editor.read`                 |
| `window`    | Notifications, quick picks, disposable output channels                                    | Basic UI is available to active extensions                                 |
| `terminals` | Create owned terminals, input, resize, reveal, output/exit events                         | `terminal.create`                                                          |
| `chat`      | Chat participants, explicit context providers, cancellable agent streams                  | `chat.register`; agent requests require `chat.use` plus agent ID allowlist |
| `context`   | Global/workspace state, logging, subscriptions, lifetime abort signal                     | State automatically belongs to the extension ID                            |

The complete public contract is [src/api.ts](src/api.ts). IDE implementation contracts are in [src/ports.ts](src/ports.ts).

## Supplied adapters

- **Monaco:** document snapshots, coordinate conversion, guarded edits, undo boundaries, completion/hover registration, and independent diagnostic collections. Pass your loaded Monaco instance; no second editor instance is created.
- **ACP:** initialized connection adapter, official SDK connector, caller/conversation session isolation, streaming updates, permission forwarding, and cancellation. It works at the ACP protocol boundary so the same interface can support Iris or Codex ACP agents.
- **xterm:** connects an existing xterm instance to an existing PTY-backed terminal; input is serialized, output buffering is bounded, and listeners are disposable.
- **Agent registry:** a host-owned catalogue for approved agents, with cancellation on removal.

The core has no runtime dependencies. Monaco and xterm imports are type-only. The optional ACP connector uses `@agentclientprotocol/sdk`; declare it as a direct IDE dependency when using this adapter, even if Iris already brings it in transitively.

Development and tests pin TypeScript 5.9.3, Monaco 0.56.0, xterm 5.3.0, and ACP SDK 1.4.0. The core uses modern `AbortSignal.any`/`timeout`; use a current Tauri WebView or supply equivalent polyfills on older operating systems.

## Chat example

```ts
api.chat.registerParticipant(
  "acme.assistant.explain",
  async function* (request, signal) {
    yield { type: "progress", message: "Asking Iris…" };
    yield* api.chat.requestAgent("iris", request, signal);
  },
);
```

Declare that participant in a manifest whose ID is `acme.assistant`, request `chat.register` and `chat.use`, and have the IDE grant those permissions and the `iris` agent ID. The IDE can consume it as follows:

```ts
const abort = new AbortController();
for await (const chunk of host.streamChat(
  "acme.assistant.explain",
  {
    conversationId: thread.id,
    prompt: userMessage,
    context: selectedAttachments,
  },
  abort.signal,
)) {
  renderChatChunk(chunk);
}
// A Stop button calls abort.abort(). Dispose the stream when its view goes away.
```

An attachment provider is invoked only when the IDE explicitly asks for it. The SDK does not automatically send the current file, terminal contents, or entire workspace to a model.

## Lifecycle and compatibility

- `apiVersion: 1` selects this SDK's exact major API. It is not an npm range.
- Extension IDs have the form `publisher.name`; contribution IDs begin with that ID plus a dot.
- Activation supports `onStartupFinished`, `onLanguage:<id>`, and command/chat/context events. Declared command and chat contributions infer their activation events.
- Concurrent activation shares one promise. Failed activation releases tracked resources. A failed extension needs `enable(id)` before retry.
- `disable(id)` aborts the context, disposes resources, and invokes bounded asynchronous deactivation. `enable(id)` makes it eligible for activation again. Install before `start()`, or explicitly activate extensions added later.
- A deadline stops waiting for slow asynchronous activation. Same-realm code cannot forcibly stop a CPU-bound loop or undo side effects outside this API.
- Command handlers must be registered before they are executed. External callers wait for successful activation. Do not start circular extension/command dependencies during activation.
- Document positions are zero-based UTF-16. Monaco's one-based positions are converted by its adapter. URI parameters use absolute URIs; ACP `cwd` uses an absolute operating-system path.
- Retained API objects and resource methods reject after deactivation. Ports must honor cancellation before committing writes, and still own any external process cleanup.

This is an original API inspired by VS Code's registrations/lifecycle, Zed's declarative extension model, and Sublime's commands/events. Existing VS Code extensions, Zed WASM modules, and Sublime Python plugins do not run unchanged.

## Host integration

Iris connects Monaco, desktop workspace I/O, state, notifications, commands, and a dedicated Tauri PTY/xterm view. Chat participants and explicit context providers can register in the extension host, but the existing ChatBot does not yet render them, and agent requests need an Iris ACP transport port. The optional ACP adapter is a protocol building block, not a second silently launched chat session. [docs/integration.md](docs/integration.md) describes the general host contract; [docs/iris-integration.md](docs/iris-integration.md) records this repository's wiring.

This version does not implement an extension marketplace/installer, arbitrary webviews, menus/keybinding resolution, a settings schema UI, LSP transport, DAP, theme loading, MCP tool export, or an isolated third-party extension host. Keep these as explicit later API versions rather than silently claiming compatibility.

## Validation

The behavioral tests cover manifest validation, activation races/failures, permission and identity checks, cleanup, state isolation, document version conflicts, Unicode coordinates, diagnostics, PTY binding, ACP stream isolation, overflow, permission cancellation, and the official SDK's in-process and subprocess stdio transports. They use fakes for Monaco/PTY backends and a test ACP agent; a real Tauri window and a paid Iris/Codex model session have not been exercised.

See [docs/references.md](docs/references.md) for upstream sources and the inspected Iris package details.
