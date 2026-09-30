import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { connectAcp } from "@iris-ide/extensions/adapters/acp";

/** Optional NODE BACKEND launcher. Never import this file into the Tauri renderer.
 * `command` is your packaged Node executable; `cliPath` is iris-agent/dist/cli.js.
 * Credentials belong in the backend environment. stdout is protocol bytes only.
 */
export async function startIris({
  command,
  cliPath,
  cwd,
  env,
  decidePermission,
  onError,
}) {
  const child = spawn(command, [cliPath, "--workspace", cwd, "--acp"], {
    cwd,
    env: { ...process.env, ...env },
    shell: false,
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.on("error", (error) => {
    try {
      onError(error);
    } catch {
      /* preserve process cleanup */
    }
  });
  let bridge;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    try {
      bridge?.dispose();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        }, 3000);
        timer.unref();
        child.once("exit", () => clearTimeout(timer));
      }
    }
  };
  child.once("exit", () => {
    bridge?.dispose();
  });
  try {
    await once(child, "spawn"); // rejects on process startup failure
    bridge = await connectAcp(
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
      {
        cwd,
        onError,
        ...(decidePermission ? { decidePermission } : {}),
      },
    );
    return {
      stream: (caller, request, signal) =>
        bridge.stream(caller, request, signal),
      forgetConversation: (caller, conversationId) =>
        bridge.forgetConversation(caller, conversationId),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
