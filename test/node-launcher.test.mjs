import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startIris } from "../examples/acp-node.mjs";
import { collect } from "./helpers.mjs";

const cliPath = fileURLToPath(
  new URL("./fixtures/acp-agent.mjs", import.meta.url),
);
test("Node launcher connects SDK stdio streams and cleans up its child", async (t) => {
  const errors = [];
  const agent = await startIris({
    command: process.execPath,
    cliPath,
    cwd: process.cwd(),
    onError: (error) => errors.push(error),
  });
  t.after(() => agent.dispose());
  const chunks = await collect(
    agent.stream(
      "acme.test",
      { conversationId: "stdio", prompt: "hello" },
      new AbortController().signal,
    ),
  );
  assert.deepEqual(chunks, [
    { type: "text", text: "Hello over stdio" },
    { type: "done", stopReason: "end_turn" },
  ]);
  agent.dispose();
  agent.dispose();
  await assert.rejects(
    collect(
      agent.stream(
        "acme.test",
        { conversationId: "stdio", prompt: "late" },
        new AbortController().signal,
      ),
    ),
    { name: "AbortError" },
  );
  assert.equal(errors.length, 0);
});

test("Node launcher reports a missing executable and rejects startup", async () => {
  const errors = [];
  await assert.rejects(
    startIris({
      command: "/definitely-missing/iris-node",
      cliPath,
      cwd: process.cwd(),
      onError: (error) => errors.push(error),
    }),
    { code: "ENOENT" },
  );
  assert.equal(errors.length, 1);
});
