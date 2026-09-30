import type { Terminal as Xterm } from "xterm";
import type { Terminal } from "../api.js";
import type { Disposable } from "../core.js";
/** Wire an existing PTY-backed terminal to an existing xterm view. Does not spawn a shell. */
export declare function bindXterm(view: Xterm, terminal: Terminal, onError: (error: unknown) => void, maxBufferedCharacters?: number): Disposable;
//# sourceMappingURL=xterm.d.ts.map