import test from "node:test";
import assert from "node:assert/strict";
import { Emitter } from "@iris-ide/extensions";
import {
  createMonacoPorts,
  toMonacoRange,
} from "@iris-ide/extensions/adapters/monaco";
import { bindXterm } from "@iris-ide/extensions/adapters/xterm";
import { deferred, tick } from "./helpers.mjs";

function fakeMonaco(initial = "a😀b\r\nnext\n") {
  const changes = new Emitter();
  const closing = new Emitter();
  const created = new Emitter();
  const markers = new Map();
  let completion;
  let hover;
  let text = initial;
  let version = 1;
  let undoStops = 0;
  let allowed = true;
  const lines = () => text.split(/\r\n|\n/);
  const offset = ({ lineNumber, column }) => {
    const matches = [...text.matchAll(/\r\n|\n/g)];
    const newline = matches[lineNumber - 2];
    return (
      (lineNumber === 1 ? 0 : newline.index + newline[0].length) + column - 1
    );
  };
  const model = {
    uri: { toString: () => "file:///demo/main.ts" },
    getValue: () => text,
    getLanguageId: () => "typescript",
    getVersionId: () => version,
    getLineCount: () => lines().length,
    getLineMaxColumn: (line) => lines()[line - 1].length + 1,
    getOffsetAt: offset,
    isDisposed: () => false,
    onDidChangeContent: changes.event,
    onWillDispose: closing.event,
    getWordUntilPosition: () => ({ word: "ne", startColumn: 1, endColumn: 3 }),
    pushStackElement: () => {
      undoStops++;
    },
    pushEditOperations: (_selection, edits) => {
      const mapped = edits.map((e) => ({
        start: offset({
          lineNumber: e.range.startLineNumber,
          column: e.range.startColumn,
        }),
        end: offset({
          lineNumber: e.range.endLineNumber,
          column: e.range.endColumn,
        }),
        text: e.text,
      }));
      for (const edit of mapped.sort((a, b) => b.start - a.start))
        text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
      version++;
      changes.fire({});
    },
  };
  const monaco = {
    Uri: { parse: (value) => ({ toString: () => value }) },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    editor: {
      getModels: () => [model],
      getModel: (uri) =>
        uri.toString() === model.uri.toString() ? model : null,
      onDidCreateModel: created.event,
      setModelMarkers: (_model, owner, values) => markers.set(owner, values),
    },
    languages: {
      CompletionItemKind: {
        Text: 0,
        Function: 1,
        Variable: 4,
        Keyword: 17,
        Snippet: 27,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (_language, value) => {
        completion = value;
        return {
          dispose() {
            completion = undefined;
          },
        };
      },
      registerHoverProvider: (_language, value) => {
        hover = value;
        return {
          dispose() {
            hover = undefined;
          },
        };
      },
    },
  };
  const errors = [];
  const adapter = createMonacoPorts(monaco, {
    getActiveEditor: () => undefined,
    openDocument: async () => model,
    canEdit: () => allowed,
    onError: (e) => errors.push(e),
  });
  return {
    adapter,
    model,
    markers,
    errors,
    get completion() {
      return completion;
    },
    get hover() {
      return hover;
    },
    get undoStops() {
      return undoStops;
    },
    setAllowed(value) {
      allowed = value;
    },
  };
}
const signal = () => new AbortController().signal;
const position = (line, character) => ({ line, character });
const range = (a, b) => ({ start: position(0, a), end: position(0, b) });

test("Monaco edits use UTF-16, zero-based SDK positions and preserve undo", async (t) => {
  const f = fakeMonaco();
  t.after(() => f.adapter.dispose());
  assert.deepEqual(toMonacoRange(range(1, 3)), {
    startLineNumber: 1,
    startColumn: 2,
    endLineNumber: 1,
    endColumn: 4,
  });
  const success = await f.adapter.editor.applyEdits(
    "acme.test",
    {
      uri: f.model.uri.toString(),
      expectedVersion: 1,
      edits: [{ range: range(1, 3), newText: "X" }],
    },
    signal(),
  );
  assert.equal(success, true);
  assert.equal(f.model.getValue(), "aXb\r\nnext\n");
  assert.equal(f.undoStops, 2);
});

test("Monaco stale versions and readonly models reject without changes", async (t) => {
  const f = fakeMonaco();
  t.after(() => f.adapter.dispose());
  const original = f.model.getValue();
  const edit = {
    uri: f.model.uri.toString(),
    expectedVersion: 99,
    edits: [{ range: range(0, 1), newText: "X" }],
  };
  assert.equal(await f.adapter.editor.applyEdits("x", edit, signal()), false);
  f.setAllowed(false);
  edit.expectedVersion = 1;
  assert.equal(await f.adapter.editor.applyEdits("x", edit, signal()), false);
  assert.equal(f.model.getValue(), original);
});

test("Monaco overlapping and invalid ranges are rejected before any edit", async (t) => {
  const f = fakeMonaco();
  t.after(() => f.adapter.dispose());
  const original = f.model.getValue();
  const apply = (edits) =>
    f.adapter.editor.applyEdits(
      "x",
      { uri: f.model.uri.toString(), expectedVersion: 1, edits },
      signal(),
    );
  await assert.rejects(
    apply([
      { range: range(0, 3), newText: "a" },
      { range: range(2, 4), newText: "b" },
    ]),
    /Overlapping/,
  );
  await assert.rejects(
    apply([{ range: range(-1, 1), newText: "" }]),
    /outside/,
  );
  await assert.rejects(
    apply([{ range: range(3, 1), newText: "" }]),
    /reversed/,
  );
  await assert.rejects(
    apply([
      { range: range(1, 1), newText: "a" },
      { range: range(1, 1), newText: "b" },
    ]),
    /Overlapping/,
  );
  assert.equal(f.model.getValue(), original);
});

test("Monaco completion and hover adapters convert positions and keep markdown untrusted", async (t) => {
  const f = fakeMonaco();
  t.after(() => f.adapter.dispose());
  let received;
  f.adapter.languages.registerCompletionProvider("x", "typescript", {
    provideCompletions(doc, pos) {
      received = { doc, pos };
      return [{ label: "next", insertText: "next", kind: "keyword" }];
    },
  });
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: new Emitter().event,
  };
  const response = await f.completion.provideCompletionItems(
    f.model,
    { lineNumber: 2, column: 3 },
    {},
    token,
  );
  assert.deepEqual(received.pos, { line: 1, character: 2 });
  assert.equal(received.doc.version, 1);
  assert.deepEqual(response.suggestions[0].range, {
    startLineNumber: 2,
    endLineNumber: 2,
    startColumn: 1,
    endColumn: 3,
  });
  f.adapter.languages.registerHoverProvider("x", "typescript", {
    provideHover: () => ({ markdown: "[Run](command:evil)" }),
  });
  const hover = await f.hover.provideHover(
    f.model,
    { lineNumber: 1, column: 1 },
    token,
  );
  assert.equal(hover.contents[0].isTrusted, false);
  assert.equal(hover.contents[0].supportHtml, false);
});

test("Monaco diagnostic collections cannot clear each other's markers", (t) => {
  const f = fakeMonaco();
  t.after(() => f.adapter.dispose());
  const a = f.adapter.languages.createDiagnosticCollection("acme.a", "lint");
  const b = f.adapter.languages.createDiagnosticCollection("acme.b", "lint");
  const diagnostic = { range: range(0, 1), message: "bad", severity: "error" };
  a.set(f.model.uri.toString(), [diagnostic]);
  b.set(f.model.uri.toString(), [diagnostic]);
  a.dispose();
  assert.deepEqual([...f.markers.values()].map((v) => v.length).sort(), [0, 1]);
});

test("xterm routes output to the view and serializes PTY input", async () => {
  const userInput = new Emitter();
  const data = new Emitter();
  const resized = new Emitter();
  const writes = [];
  const output = [];
  const sizes = [];
  const gate = deferred();
  const view = {
    cols: 80,
    rows: 24,
    onData: userInput.event,
    onResize: resized.event,
    write: (value, done) => {
      output.push(value);
      done();
    },
  };
  const terminal = {
    onData: data.event,
    sendText: async (value, newline) => {
      writes.push([value, newline]);
      if (value === "a") await gate.promise;
    },
    resize: async (cols, rows) => {
      sizes.push([cols, rows]);
    },
  };
  const binding = bindXterm(view, terminal, (error) =>
    assert.fail(String(error)),
  );
  data.fire("shell output");
  userInput.fire("a");
  userInput.fire("b");
  await tick();
  assert.deepEqual(output, ["shell output"]);
  assert.deepEqual(writes, [["a", false]]);
  gate.resolve();
  await tick();
  assert.deepEqual(writes, [
    ["a", false],
    ["b", false],
  ]);
  resized.fire({ cols: 100, rows: 30 });
  assert.deepEqual(sizes, [
    [80, 24],
    [100, 30],
  ]);
  binding.dispose();
  userInput.fire("ignored");
  await tick();
  assert.equal(writes.length, 2);
});

test("xterm buffer overflow detaches the binding and reports an error", () => {
  const data = new Emitter();
  const errors = [];
  let writes = 0;
  const view = {
    cols: 80,
    rows: 24,
    onData: new Emitter().event,
    onResize: new Emitter().event,
    write: () => {
      writes++;
    },
  };
  const terminal = {
    onData: data.event,
    sendText: async () => {},
    resize: async () => {},
  };
  const binding = bindXterm(view, terminal, (error) => errors.push(error), 4);
  data.fire("1234");
  data.fire("5");
  data.fire("ignored");
  binding.dispose();
  assert.equal(writes, 1);
  assert.equal(errors.length, 1);
});
