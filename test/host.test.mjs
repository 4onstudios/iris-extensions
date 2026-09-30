import test from "node:test";
import assert from "node:assert/strict";
import {
  DisposableStore,
  disposable,
  Emitter,
  parseManifest,
} from "@4onstudios/iris-extensions";
import { ExtensionHost } from "@4onstudios/iris-extensions/host";
import { memoryServices } from "../examples/memory-services.mjs";
import { deferred, manifest, tick, collect } from "./helpers.mjs";

function fixture(t, options = {}) {
  const demo = memoryServices();
  const host = new ExtensionHost(demo.services, options.timeout ?? 1000);
  t.after(() => host.close());
  return { ...demo, host };
}
function install(
  host,
  activate,
  m = manifest(),
  grant = { permissions: m.permissions ?? [] },
) {
  host.install({
    manifest: m,
    trust: "trusted",
    grant,
    load: async () => ({ activate }),
  });
}

test("manifest rejects unknown fields, API versions, foreign and duplicate IDs", () => {
  assert.throws(
    () => parseManifest(manifest({ apiVersion: 2 })),
    /Unsupported/,
  );
  assert.throws(() => parseManifest(manifest({ permisions: [] })), /Unknown/);
  assert.throws(
    () => parseManifest(manifest({ permissions: ["everything"] })),
    /Unknown permission/,
  );
  assert.throws(
    () =>
      parseManifest(
        manifest({
          contributes: { commands: [{ id: "other.command", title: "X" }] },
        }),
      ),
    /must start/,
  );
  assert.throws(
    () =>
      parseManifest(
        manifest({
          contributes: {
            commands: [
              { id: "acme.test.x", title: "X" },
              { id: "acme.test.x", title: "X" },
            ],
          },
        }),
      ),
    /Duplicate/,
  );
  const input = manifest({ permissions: ["editor.read"] });
  const parsed = parseManifest(input);
  input.permissions.push("workspace.write");
  assert.deepEqual(parsed.permissions, ["editor.read"]);
  assert.throws(() => parsed.permissions.push("workspace.write"), TypeError);
});

test("disposal is LIFO and idempotent; event listener errors are isolated", () => {
  const order = [];
  const errors = [];
  const store = new DisposableStore((e) => errors.push(e));
  store.add(disposable(() => order.push(1)));
  store.add(
    disposable(() => {
      order.push(2);
      throw new Error("broken");
    }),
  );
  store.add(disposable(() => order.push(3)));
  store.dispose();
  store.dispose();
  store.add(disposable(() => order.push(4)));
  assert.deepEqual(order, [3, 2, 1, 4]);
  assert.equal(errors.length, 1);
  const emitter = new Emitter((e) => errors.push(e));
  emitter.event(() => {
    throw new Error("listener");
  });
  emitter.event((x) => order.push(x));
  emitter.fire(5);
  assert.equal(order.at(-1), 5);
  assert.equal(errors.length, 2);
});

test("contributed commands lazily activate once under concurrent requests", async (t) => {
  const { host } = fixture(t);
  const gate = deferred();
  const loading = deferred();
  let loads = 0;
  const m = manifest({
    contributes: { commands: [{ id: "acme.test.run", title: "Run" }] },
  });
  host.install({
    manifest: m,
    trust: "trusted",
    grant: { permissions: [] },
    load: async () => {
      loads++;
      loading.resolve();
      await gate.promise;
      return {
        activate(_ctx, api) {
          api.commands.registerCommand(
            "acme.test.run",
            (value) => Number(value) + 1,
          );
        },
      };
    },
  });
  assert.equal(host.listExtensions()[0].status, "installed");
  const first = host.executeCommand("acme.test.run", 2);
  const second = host.executeCommand("acme.test.run", 4);
  await loading.promise;
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [3, 5]);
  assert.equal(loads, 1);
});

test("activation failure rolls back registrations and invalidates captured API", async (t) => {
  const { host } = fixture(t);
  let captured;
  install(
    host,
    (_ctx, api) => {
      captured = api;
      api.commands.registerCommand("acme.test.run", () => 1);
      throw new Error("activation failed");
    },
    manifest({
      permissions: ["editor.read"],
      contributes: { commands: [{ id: "acme.test.run", title: "Run" }] },
    }),
  );
  await assert.rejects(host.activate("acme.test"), /activation failed/);
  assert.equal(host.listExtensions()[0].status, "failed");
  await assert.rejects(host.executeCommand("acme.test.run"), /unavailable/);
  await assert.rejects(captured.editor.getActiveDocument());
});

test("a command registered during activation is not externally executable until success", async (t) => {
  const { host } = fixture(t);
  const registered = deferred();
  const finish = deferred();
  let ran = false;
  install(
    host,
    async (_ctx, api) => {
      api.commands.registerCommand("acme.test.run", () => {
        ran = true;
      });
      registered.resolve();
      await finish.promise;
      throw new Error("late failure");
    },
    manifest({
      contributes: { commands: [{ id: "acme.test.run", title: "Run" }] },
    }),
  );
  const activation = host.activate("acme.test");
  const failed = assert.rejects(activation, /late failure/);
  await registered.promise;
  const command = host.executeCommand("acme.test.run");
  const blocked = assert.rejects(command, /late failure/);
  await tick();
  assert.equal(ran, false);
  finish.resolve();
  await Promise.all([failed, blocked]);
  assert.equal(ran, false);
});

test("async event rejection is reported without escaping to the process", async (t) => {
  const { host, logs, documentChanges } = fixture(t);
  install(
    host,
    (_ctx, api) => {
      api.editor.onDidChangeDocument(async () => {
        throw new Error("async listener");
      });
    },
    manifest({ permissions: ["editor.read"] }),
  );
  await host.activate("acme.test");
  documentChanges.fire({});
  await tick();
  assert.equal(
    logs.some((entry) => entry.error?.message === "async listener"),
    true,
  );
});

test("one failed startup extension does not block another", async (t) => {
  const { host } = fixture(t);
  let success = false;
  install(
    host,
    () => {
      throw new Error("bad");
    },
    manifest({ activationEvents: ["onStartupFinished"] }),
  );
  install(
    host,
    () => {
      success = true;
    },
    manifest({ id: "acme.good", activationEvents: ["onStartupFinished"] }),
  );
  await host.start();
  assert.equal(success, true);
});

test("declared permission without a host grant cannot reach backend", async (t) => {
  const { host, services } = fixture(t);
  let api;
  let calls = 0;
  services.workspace.readFile = async () => {
    calls++;
    return new Uint8Array();
  };
  install(
    host,
    (_ctx, value) => {
      api = value;
    },
    manifest({ permissions: ["workspace.read"] }),
    { permissions: [] },
  );
  await host.activate("acme.test");
  await assert.rejects(
    api.workspace.readFile("file:///demo/key"),
    /Permission denied/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      host.install({
        manifest: manifest({ id: "acme.other" }),
        trust: "trusted",
        load: async () => ({ activate() {} }),
        grant: { permissions: ["workspace.write"] },
      }),
    /Undeclared permission/,
  );
});

test("cross-extension and host commands require permission plus an exact grant", async (t) => {
  const { host } = fixture(t);
  let api;
  host.registerHostCommand("ide.save", () => "saved");
  host.registerHostCommand("ide.delete", () => "deleted");
  install(
    host,
    (_ctx, value) => {
      api = value;
    },
    manifest({ permissions: ["commands.execute"] }),
    { permissions: ["commands.execute"], commandIds: ["ide.save"] },
  );
  await host.activate("acme.test");
  assert.equal(await api.commands.executeCommand("ide.save"), "saved");
  await assert.rejects(
    api.commands.executeCommand("ide.delete"),
    /not granted/,
  );
});

test("unregistering a command is idempotent and releases ownership", async (t) => {
  const { host } = fixture(t);
  install(
    host,
    (_ctx, api) => {
      const d = api.commands.registerCommand("acme.test.run", () => "old");
      d.dispose();
      d.dispose();
      api.commands.registerCommand("acme.test.run", () => "new");
    },
    manifest({
      contributes: { commands: [{ id: "acme.test.run", title: "Run" }] },
    }),
  );
  assert.equal(await host.executeCommand("acme.test.run"), "new");
});

test("disable cleans terminal and event listeners; a stale context stays invalid after enable", async (t) => {
  const { host, documentChanges, terminals } = fixture(t);
  let api;
  let events = 0;
  install(
    host,
    async (_ctx, value) => {
      api = value;
      api.editor.onDidChangeDocument(() => events++);
      await api.terminals.createTerminal({ name: "Test" });
    },
    manifest({ permissions: ["editor.read", "terminal.create"] }),
  );
  await host.activate("acme.test");
  const stale = api;
  documentChanges.fire({});
  assert.equal(events, 1);
  await host.disable("acme.test");
  documentChanges.fire({});
  assert.equal(events, 1);
  assert.equal(terminals[0].closed, true);
  await assert.rejects(stale.editor.getActiveDocument());
  await host.enable("acme.test");
  await host.activate("acme.test");
  assert.notEqual(api, stale);
  await assert.rejects(stale.editor.getActiveDocument());
  assert.equal((await api.editor.getActiveDocument()).languageId, "typescript");
});

test("late terminal creation is disposed after cancellation without delaying disable", async (t) => {
  const { host, services } = fixture(t);
  const ready = deferred();
  let api;
  let disposed = 0;
  services.terminals.create = () => ready.promise;
  install(
    host,
    (_ctx, value) => {
      api = value;
    },
    manifest({ permissions: ["terminal.create"] }),
  );
  await host.activate("acme.test");
  const pending = api.terminals.createTerminal({ name: "Delayed" });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await host.disable("acme.test");
  await rejected;
  ready.resolve({
    dispose: () => {
      disposed++;
    },
  });
  await tick();
  assert.equal(disposed, 1);
});

test("storage is namespaced and returned state does not alias stored state", async (t) => {
  const { host } = fixture(t);
  const states = [];
  for (const id of ["acme.one", "acme.two"]) {
    install(
      host,
      (ctx) => {
        states.push(ctx.globalState);
      },
      manifest({ id }),
    );
    await host.activate(id);
  }
  await states[0].update("key", { value: 1 });
  assert.equal(await states[1].get("key"), undefined);
  const result = await states[0].get("key");
  result.value = 99;
  assert.deepEqual(await states[0].get("key"), { value: 1 });
  await states[0].update("key", undefined);
  assert.equal(await states[0].get("key"), undefined);
});

test("hanging activation times out and releases registered resources", async (t) => {
  const { host } = fixture(t, { timeout: 15 });
  let cleanup = 0;
  install(host, (ctx) => {
    ctx.subscriptions.add(disposable(() => cleanup++));
    return new Promise(() => {});
  });
  await assert.rejects(host.activate("acme.test"), /timed out/);
  assert.equal(cleanup, 1);
});

test("disable aborts a pending activation and late registrations fail", async (t) => {
  const { host } = fixture(t);
  const started = deferred();
  const resume = deferred();
  let denied = false;
  install(host, async (_ctx, api) => {
    started.resolve();
    await resume.promise;
    try {
      api.window.createOutputChannel("late");
    } catch {
      denied = true;
    }
  });
  const activation = host.activate("acme.test");
  const rejected = assert.rejects(activation, { name: "AbortError" });
  await started.promise;
  await host.disable("acme.test");
  await rejected;
  resume.resolve();
  await tick();
  assert.equal(denied, true);
  assert.equal(host.listExtensions()[0].status, "disabled");
});

test("chat lazily activates, forwards explicit attachments, and enforces agent grants", async (t) => {
  const { host, services } = fixture(t);
  let api;
  const requests = [];
  services.agents = {
    async *stream(caller, agentId, request) {
      requests.push({ caller, agentId, request });
      yield { type: "text", text: "hello" };
    },
  };
  install(
    host,
    (_ctx, value) => {
      api = value;
      api.chat.registerParticipant("acme.test.chat", (request, signal) =>
        api.chat.requestAgent("iris", request, signal),
      );
    },
    manifest({
      permissions: ["chat.register", "chat.use"],
      contributes: {
        chatParticipants: [{ id: "acme.test.chat", name: "Chat" }],
      },
    }),
    { permissions: ["chat.register", "chat.use"], agentIds: ["iris"] },
  );
  const request = {
    conversationId: "a",
    prompt: "explain",
    context: [{ id: "x", label: "Selected", text: "code" }],
  };
  assert.deepEqual(await collect(host.streamChat("acme.test.chat", request)), [
    { type: "text", text: "hello" },
  ]);
  assert.equal(requests[0].caller, "acme.test");
  assert.deepEqual(requests[0].request, request);
  await assert.rejects(
    collect(api.chat.requestAgent("unapproved", request)),
    /not granted/,
  );
});
