# Validation record

Validated on 2026-09-30 with Node 24.19.0.

| Check | Result |
| --- | --- |
| Strict TypeScript build, declaration and source-map emission | Passed |
| SDK and TypeScript example type checking | Passed |
| Node behavioral tests | 35 passed, 0 failed |
| Example extension demonstration | Passed |
| Official ACP SDK in-process test transport | Passed |
| Official ACP SDK subprocess stdio test transport | Passed |
| Process startup failure handling | Passed |

Reproduce from the package directory:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run demo
```

Tests exercise activation, rollback, concurrent command execution, capability grants, scoped state, disposal, cancellation, versioned edits, UTF-16 positions, diagnostics, terminal input/output routing, bounded streams, ACP session routing and permission decisions.

The Monaco and terminal tests use controlled fakes. The subprocess test launches a small ACP test agent included in `test/fixtures`, not Iris Agent or Codex. The demo uses an explicit mock agent. No real Tauri window, filesystem/SQL implementation, PTY, agent credentials, or model-provider call was tested. Those are application integration checks to run after wiring `HostServices` to the actual IDE.
