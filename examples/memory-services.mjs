import { disposable, Emitter } from "@4onstudios/iris-extensions";

/** In-memory demo/test fixture. Not a filesystem, PTY, or production persistence layer. */
export function memoryServices() {
  const files = new Map();
  const storage = new Map();
  const fileChanges = new Emitter();
  const documentChanges = new Emitter();
  const messages = [];
  const logs = [];
  const output = [];
  const terminals = [];
  let active = Object.freeze({
    uri: "file:///demo/main.ts",
    languageId: "typescript",
    version: 1,
    text: "const message = 'Hello Iris';",
  });
  const services = {
    workspace: {
      getFolders: async () => [{ uri: "file:///demo", name: "Demo" }],
      readFile: async (_caller, uri) => {
        if (!files.has(uri)) throw new Error("File not found");
        return files.get(uri).slice();
      },
      writeFile: async (_caller, uri, bytes) => {
        files.set(uri, bytes.slice());
        fileChanges.fire([{ uri, type: "changed" }]);
      },
      findFiles: async () => [...files.keys()],
      onDidChangeFiles: () => fileChanges.event,
    },
    editor: {
      getActiveDocument: async () => active,
      openDocument: async (_caller, uri) => {
        if (active?.uri !== uri) throw new Error("Demo only has one model");
        return active;
      },
      applyEdits: async () => {
        throw new Error("Use the Monaco adapter for document edits");
      },
      onDidChangeDocument: () => documentChanges.event,
    },
    window: {
      showMessage: async (_caller, message) => {
        messages.push(message);
      },
      showQuickPick: async () => undefined,
      createOutputChannel: (caller, name) => {
        let closed = false;
        return {
          appendLine: (text) => {
            if (closed) throw new Error("Closed");
            output.push({ caller, name, text });
          },
          clear() {},
          show() {},
          dispose() {
            closed = true;
          },
        };
      },
    },
    storage: {
      get: async (caller, scope, key) =>
        structuredClone(storage.get(JSON.stringify([caller, scope, key]))),
      update: async (caller, scope, key, value) => {
        const k = JSON.stringify([caller, scope, key]);
        if (value === undefined) storage.delete(k);
        else storage.set(k, structuredClone(value));
      },
    },
    terminals: {
      create: async (_caller, options) => {
        const data = new Emitter();
        const exit = new Emitter();
        const record = { options, closed: false, input: [], shown: false };
        const release = disposable(() => {
          record.closed = true;
          exit.fire({ code: 0 });
          data.dispose();
          exit.dispose();
        });
        terminals.push(record);
        return {
          id: `demo-${terminals.length}`,
          onData: data.event,
          onExit: exit.event,
          sendText: async (text, addNewLine = true) => {
            record.input.push(text + (addNewLine ? "\r" : ""));
          },
          resize: async () => {},
          show: () => {
            record.shown = true;
          },
          dispose: release.dispose,
        };
      },
    },
    log: (caller, level, message, error) =>
      logs.push({ caller, level, message, error }),
  };
  return {
    services,
    files,
    storage,
    fileChanges,
    documentChanges,
    messages,
    logs,
    output,
    terminals,
    setActive(document) {
      active = document;
      documentChanges.fire(document);
    },
  };
}
