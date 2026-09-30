import { defineExtension } from "@4onstudios/iris-extensions";
import type { ExtensionManifest } from "@4onstudios/iris-extensions";

export const manifest = {
  id: "4onstudios.devtools",
  name: "Iris Dev Tools",
  version: "0.1.0",
  apiVersion: 1,
  permissions: ["editor.read", "terminal.create", "chat.register", "chat.use"],
  contributes: {
    commands: [
      {
        id: "4onstudios.devtools.wordCount",
        title: "Count words in active file",
      },
      {
        id: "4onstudios.devtools.terminal",
        title: "Open development terminal",
      },
    ],
    chatParticipants: [
      {
        id: "4onstudios.devtools.explain",
        name: "Explain",
        description: "Explain code with Iris",
      },
    ],
    chatContextProviders: [
      { id: "4onstudios.devtools.activeFile", name: "Active file" },
    ],
  },
} as const satisfies ExtensionManifest;

export default defineExtension({
  activate(context, api) {
    const output = api.window.createOutputChannel("Iris Dev Tools");
    api.commands.registerCommand("4onstudios.devtools.wordCount", async () => {
      const document = await api.editor.getActiveDocument();
      const count =
        document?.text.trim().split(/\s+/).filter(Boolean).length ?? 0;
      await api.window.showMessage(`${count} words in the active file`);
      return count;
    });
    api.commands.registerCommand("4onstudios.devtools.terminal", async () => {
      const terminal = await api.terminals.createTerminal({
        name: "Development",
      });
      terminal.show(); // Creating a terminal does not silently run a command.
    });
    api.chat.registerContextProvider("4onstudios.devtools.activeFile", {
      async provideContext() {
        const document = await api.editor.getActiveDocument();
        return document
          ? [
              {
                id: document.uri,
                label: "Active file",
                uri: document.uri,
                text: document.text,
              },
            ]
          : [];
      },
    });
    api.chat.registerParticipant(
      "4onstudios.devtools.explain",
      async function* (request, signal) {
        yield {
          type: "progress",
          message: "Asking Iris to explain the selected context…",
        };
        yield* api.chat.requestAgent(
          "iris",
          {
            ...request,
            prompt: `Explain the following request clearly, using the attached context when relevant.\n\n${request.prompt}`,
          },
          signal,
        );
      },
    );
    // API-created registrations/resources are owned automatically. Use subscriptions
    // for resources your extension creates itself, such as timers or custom listeners.
    output.appendLine(`${context.extension.name} activated`);
  },
});
