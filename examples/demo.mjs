import { ExtensionHost } from "@4onstudios/iris-extensions/host";
import extension, { manifest } from "./devtools.ts";
import { memoryServices } from "./memory-services.mjs";

const demo = memoryServices();
demo.services.agents = {
  async *stream(_caller, agentId, request) {
    // An explicit mock: no model request or credentials needed to try the SDK.
    yield {
      type: "text",
      text: `[Mock ${agentId}] Received ${request.context?.length ?? 0} selected attachment(s).`,
    };
    yield { type: "done", stopReason: "end_turn" };
  },
};
const host = new ExtensionHost(demo.services);
host.install({
  manifest,
  trust: "trusted",
  load: async () => extension,
  grant: { permissions: [...manifest.permissions], agentIds: ["iris"] },
});
console.log("Before command:", host.listExtensions()[0].status);
console.log(
  "Word count:",
  await host.executeCommand("4onstudios.devtools.wordCount"),
);
console.log("After command:", host.listExtensions()[0].status);
await host.executeCommand("4onstudios.devtools.terminal");
const context = await host.resolveChatContext(
  "4onstudios.devtools.activeFile",
  "",
);
for await (const chunk of host.streamChat("4onstudios.devtools.explain", {
  conversationId: "demo",
  prompt: "Explain this file",
  context,
}))
  console.log(chunk);
await host.close();
console.log("Terminal closed on host shutdown:", demo.terminals[0].closed);
