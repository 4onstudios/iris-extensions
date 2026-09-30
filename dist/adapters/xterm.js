import { disposable, DisposableStore } from "../core.js";
/** Wire an existing PTY-backed terminal to an existing xterm view. Does not spawn a shell. */
export function bindXterm(view, terminal, onError, maxBufferedCharacters = 1_048_576) {
    const listeners = new DisposableStore(onError);
    let disposed = false;
    let pendingOutput = 0;
    let pendingInput = 0;
    let input = Promise.resolve();
    const result = disposable(() => {
        disposed = true;
        listeners.dispose();
    });
    const fail = (error) => {
        result.dispose();
        onError(error);
    };
    listeners.add(terminal.onData((data) => {
        if (disposed)
            return;
        pendingOutput += data.length;
        if (pendingOutput > maxBufferedCharacters) {
            fail(new Error("Terminal output exceeds the view buffer; pause or terminate the PTY"));
            return;
        }
        try {
            view.write(data, () => {
                pendingOutput -= data.length;
            });
        }
        catch (error) {
            fail(error);
        }
    }));
    listeners.add(view.onData((data) => {
        pendingInput += data.length;
        if (pendingInput > maxBufferedCharacters) {
            fail(new Error("Terminal input exceeds the PTY input buffer"));
            return;
        }
        // Preserve keystroke/paste order even if the backend performs async IPC writes.
        input = input
            .then(async () => {
            if (!disposed)
                await terminal.sendText(data, false);
        })
            .catch(fail)
            .finally(() => {
            pendingInput -= data.length;
        });
    }));
    listeners.add(view.onResize(({ cols, rows }) => {
        if (!disposed)
            void terminal.resize(cols, rows).catch(fail);
    }));
    void terminal.resize(view.cols, view.rows).catch(fail);
    return result;
}
//# sourceMappingURL=xterm.js.map