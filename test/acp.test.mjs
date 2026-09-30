import test from "node:test";
import assert from "node:assert/strict";
import { agent } from "@agentclientprotocol/sdk";
import { AcpChatAgent, connectAcp } from "@4onstudios/iris-extensions/adapters/acp";
import { deferred, tick, collect } from "./helpers.mjs";

const request = { conversationId: "thread", prompt: "Hello" };
const signal = () => new AbortController().signal;
const permission = (sessionId) => ({
  sessionId,
  toolCall: { toolCallId: "t", title: "Run test" },
  options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }],
});
function fixture(t, options = {}) {
  const calls = { sessions: [], prompts: [], cancels: [] };
  const began = deferred();
  const finish = deferred();
  let bridge;
  const wire = {
    newSession: async (params) => {
      calls.sessions.push(params);
      return { sessionId: `s${calls.sessions.length}` };
    },
    prompt: (params) => {
      calls.prompts.push(params);
      began.resolve(params);
      return finish.promise;
    },
    cancel: (params) => {
      calls.cancels.push(params);
    },
  };
  bridge = new AcpChatAgent(
    wire,
    { protocolVersion: 1 },
    { cwd: "/demo", onError() {}, ...options },
  );
  t.after(() => {
    finish.resolve({ stopReason: "cancelled" });
    bridge.dispose();
  });
  const update = (sessionId, text) =>
    bridge.acceptUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  return { calls, wire, began, finish, bridge, update };
}

test("ACP SDK integration initializes, streams tools/text, and completes", async (t) => {
  let init;
  let received;
  let count = 0;
  const server = agent()
    .onRequest("initialize", ({ params }) => {
      init = params;
      return { protocolVersion: 1, agentCapabilities: {} };
    })
    .onRequest("session/new", () => ({ sessionId: `s${++count}` }))
    .onRequest("session/prompt", async ({ params, client }) => {
      received = params;
      const decision = await client.request(
        "session/request_permission",
        permission(params.sessionId),
      );
      assert.equal(decision.outcome.outcome, "cancelled"); // default is never auto-approve
      await client.notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t",
          title: "Test",
          status: "completed",
        },
      });
      await client.notify("session/update", {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from ACP" },
        },
      });
      return { stopReason: "end_turn" };
    });
  const bridge = await connectAcp(server, {
    cwd: "/demo",
    onError: (error) => assert.fail(String(error)),
  });
  t.after(() => bridge.dispose());
  const result = await collect(
    bridge.stream(
      "acme.test",
      { ...request, context: [{ id: "a", label: "A", text: "selected code" }] },
      signal(),
    ),
  );
  // The official SDK expands omitted capabilities to explicit false defaults.
  assert.equal(init.clientCapabilities.fs.readTextFile, false);
  assert.equal(init.clientCapabilities.fs.writeTextFile, false);
  assert.equal(init.clientCapabilities.terminal, false);
  assert.equal(init.protocolVersion, 1);
  assert.equal(result[0].type, "acp-update");
  assert.equal(result[1].text, "Hello from ACP");
  assert.equal(result[2].stopReason, "end_turn");
  assert.match(received.prompt[0].text, /selected code/);
});

test("session routing is per caller/conversation and sessions are reused", async (t) => {
  const f = fixture(t);
  f.finish.resolve({ stopReason: "end_turn" });
  await collect(f.bridge.stream("one", request, signal()));
  await collect(f.bridge.stream("one", request, signal()));
  await collect(f.bridge.stream("two", request, signal()));
  assert.equal(f.calls.sessions.length, 2);
  assert.deepEqual(
    f.calls.prompts.map((p) => p.sessionId),
    ["s1", "s1", "s2"],
  );
});

test("concurrent prompts in a conversation are rejected", async (t) => {
  const f = fixture(t);
  const first = collect(f.bridge.stream("one", request, signal()));
  await f.began.promise;
  await assert.rejects(
    collect(f.bridge.stream("one", request, signal())),
    /already running/,
  );
  f.finish.resolve({ stopReason: "end_turn" });
  await first;
});

test("cancellation during session creation returns promptly and never prompts", async (t) => {
  const f = fixture(t);
  const created = deferred();
  const creating = deferred();
  f.wire.newSession = () => {
    creating.resolve();
    return created.promise;
  };
  const ctl = new AbortController();
  const pending = collect(f.bridge.stream("one", request, ctl.signal));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await creating.promise;
  ctl.abort();
  await rejected;
  created.resolve({ sessionId: "slow" });
  await tick();
  assert.equal(f.calls.prompts.length, 0);
  assert.equal(f.calls.cancels.length, 0);
});

test("cancellation denies a pending permission and sends one cancellation", async (t) => {
  const decision = deferred();
  const f = fixture(t, { decidePermission: () => decision.promise });
  const ctl = new AbortController();
  const pending = collect(f.bridge.stream("one", request, ctl.signal));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const started = await f.began.promise;
  const asking = f.bridge.requestPermission(permission(started.sessionId));
  ctl.abort();
  await rejected;
  assert.deepEqual(await asking, { outcome: { outcome: "cancelled" } });
  await tick();
  assert.equal(f.calls.cancels.length, 1);
  decision.resolve({ outcome: "selected", optionId: "yes" });
});

test("unknown session and invented permission option IDs are rejected", async (t) => {
  const f = fixture(t, {
    decidePermission: async () => ({
      outcome: "selected",
      optionId: "invented",
    }),
  });
  assert.deepEqual(await f.bridge.requestPermission(permission("unknown")), {
    outcome: { outcome: "cancelled" },
  });
  const pending = collect(f.bridge.stream("one", request, signal()));
  const started = await f.began.promise;
  assert.deepEqual(
    await f.bridge.requestPermission(permission(started.sessionId)),
    { outcome: { outcome: "cancelled" } },
  );
  f.finish.resolve({ stopReason: "end_turn" });
  await pending;
});

test("valid permission choice is preserved", async (t) => {
  const f = fixture(t, {
    decidePermission: async () => ({ outcome: "selected", optionId: "yes" }),
  });
  const pending = collect(f.bridge.stream("one", request, signal()));
  const started = await f.began.promise;
  assert.deepEqual(
    await f.bridge.requestPermission(permission(started.sessionId)),
    { outcome: { outcome: "selected", optionId: "yes" } },
  );
  f.finish.resolve({ stopReason: "end_turn" });
  await pending;
});

test("breaking a stream cancels remotely and keeps its lane locked until settlement", async (t) => {
  const f = fixture(t);
  const iterator = f.bridge
    .stream("one", request, signal())
    [Symbol.asyncIterator]();
  const next = iterator.next();
  const started = await f.began.promise;
  f.update("other-session", "wrong");
  f.update(started.sessionId, "right");
  assert.equal((await next).value.text, "right");
  await iterator.return();
  await tick();
  assert.equal(f.calls.cancels.length, 1);
  await assert.rejects(
    collect(f.bridge.stream("one", request, signal())),
    /already running/,
  );
  f.update(started.sessionId, "late");
  f.finish.resolve({ stopReason: "cancelled" });
  await tick();
  assert.deepEqual(await collect(f.bridge.stream("one", request, signal())), [
    { type: "done", stopReason: "cancelled" },
  ]);
});

test("stream overflow fails and cancels instead of buffering forever", async (t) => {
  const f = fixture(t, { maxBufferedChunks: 2 });
  const pending = collect(f.bridge.stream("one", request, signal()));
  const rejected = assert.rejects(pending, /too slow/);
  const started = await f.began.promise;
  for (let i = 0; i < 10; i++) f.update(started.sessionId, "chunk");
  await rejected;
  await tick();
  assert.equal(f.calls.cancels.length, 1);
});

test("unsupported protocol is rejected and the SDK connection is closed", async () => {
  const server = agent().onRequest("initialize", () => ({
    protocolVersion: 99,
  }));
  await assert.rejects(
    connectAcp(server, { cwd: "/demo", onError() {} }),
    /Unsupported ACP/,
  );
});
