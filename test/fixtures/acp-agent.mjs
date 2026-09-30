// Test fixture only. Does not call a model or execute tools.
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

let session = 0;
agent()
  .onRequest("initialize", () => ({
    protocolVersion: 1,
    agentCapabilities: {},
  }))
  .onRequest("session/new", () => ({ sessionId: `stdio-${++session}` }))
  .onRequest("session/prompt", async ({ params, client }) => {
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello over stdio" },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(
    ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)),
  );
