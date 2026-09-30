import { ExtensionHost, AgentRegistry } from "@iris-ide/extensions/host";
import type { HostServices } from "@iris-ide/extensions/host";
import { createMonacoPorts } from "@iris-ide/extensions/adapters/monaco";
import type { MonacoOptions } from "@iris-ide/extensions/adapters/monaco";
import type { ChatAgent } from "@iris-ide/extensions/host";
import extension, { manifest } from "./devtools.js";

/** Compose this once at application startup, outside React component render. */
export async function installExtensions(
  monaco: typeof import("monaco-editor"),
  editorOptions: MonacoOptions,
  services: Omit<HostServices, "editor" | "languages" | "agents">,
  iris: ChatAgent, // a backend ACP bridge or a typed IPC proxy to it
) {
  const editor = createMonacoPorts(monaco, editorOptions);
  const agents = new AgentRegistry();
  agents.register("iris", iris);
  const host = new ExtensionHost({
    ...services,
    editor: editor.editor,
    languages: editor.languages,
    agents,
  });
  host.install({
    manifest,
    trust: "trusted",
    load: async () => extension,
    grant: { permissions: [...manifest.permissions], agentIds: ["iris"] },
  });
  const activateLanguage = (
    model: import("monaco-editor").editor.ITextModel,
  ) => {
    void host
      .activateEvent(`onLanguage:${model.getLanguageId()}`)
      .catch((error) =>
        services.log("host", "error", "Language activation failed", error),
      );
  };
  const created = monaco.editor.onDidCreateModel(activateLanguage);
  const changed = monaco.editor.onDidChangeModelLanguage((event) =>
    activateLanguage(event.model),
  );
  monaco.editor.getModels().forEach(activateLanguage);
  await host.start();
  return {
    host,
    async dispose() {
      created.dispose();
      changed.dispose();
      await host.close();
      try {
        agents.dispose();
      } finally {
        editor.dispose();
      }
    },
  };
}
