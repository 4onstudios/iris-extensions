# Iris extension integration

The package is a TypeScript API and trusted same-realm host. It does not run VS Code, Zed, or Sublime plugins directly, and permission grants do not isolate arbitrary third-party JavaScript. Only modules that Iris bundles and reviews should be installed through `host.install` until a separate process or sandbox is implemented.

`src/extensions/irisRuntime.ts` constructs the host on the first Monaco editor mount. Both editor panes register their actual editor instances; the adapter uses the focused editor, Monaco snapshots and version-checked edits. File URLs are mapped to Iris tab paths. The Extensions sidebar displays bundled modules and invokes contributed commands. Add a bundled module's manifest, lazy import, and a host-owned grant next to the `sampleExtension` installation; the extension cannot grant itself capabilities. `src/extensions/sampleExtension.ts` is a small working example.

| API | Iris connection |
| --- | --- |
| `editor`, `languages` | Monaco instance and existing tab switching; writes to inactive or read-only models are rejected. |
| `workspace` | Tauri binary file API and desktop workspace root; local file URIs only. Direct writes to currently open models are rejected; use editor edits. Globs are bounded and local to the workspace. |
| `window`, `storage` | Existing editor alert, prompt-based quick pick, localStorage namespaces and console output channel. |
| `commands` | Bundled commands shown and executed in the Extensions sidebar. |
| `terminals` | Dedicated owned Tauri PTY, xterm view, input and resize. The Rust backend chooses the shell; executable, args, and env options are rejected. Returning to Iris's terminal hides the extension view without terminating its PTY. |
| `chat` | Registration and streaming contracts exist in the host; ChatBot rendering and ACP agent transport are not connected yet. |

To exercise the integration in a desktop build, open a text file and use **Extensions → Document Info → Show Document Info**. **Open Extension Terminal** starts a separately owned PTY inside the terminal area. Closing or disabling the extension disposes its PTY. The web version still supports editor and language registrations but has no native workspace byte I/O or PTY.

The host's file checks are for bundled trusted code and user intent, not a filesystem sandbox. Tauri's filesystem and shell permissions remain the outer boundary. In particular, an untrusted plugin could access the JavaScript realm outside the API. Before accepting arbitrary extensions, move execution behind a backend isolation boundary and make the workspace path checks symlink-aware there.
