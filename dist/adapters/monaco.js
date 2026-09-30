import { checkAbort, disposable, DisposableStore, Emitter } from "../core.js";
export function snapshot(model) {
    return Object.freeze({
        uri: model.uri.toString(),
        languageId: model.getLanguageId(),
        version: model.getVersionId(),
        text: model.getValue(),
    });
}
export function toMonacoRange(range) {
    return {
        startLineNumber: range.start.line + 1,
        startColumn: range.start.character + 1,
        endLineNumber: range.end.line + 1,
        endColumn: range.end.character + 1,
    };
}
function fromPosition(position) {
    return { line: position.lineNumber - 1, character: position.column - 1 };
}
export function validateDocumentEdits(model, edit) {
    const offset = (position) => {
        if (!Number.isInteger(position.line) ||
            !Number.isInteger(position.character) ||
            position.line < 0 ||
            position.character < 0 ||
            position.line >= model.getLineCount() ||
            position.character >= model.getLineMaxColumn(position.line + 1)) {
            throw new RangeError("Edit position is outside the document");
        }
        return model.getOffsetAt({
            lineNumber: position.line + 1,
            column: position.character + 1,
        });
    };
    const ranges = edit.edits
        .map((item) => {
        const start = offset(item.range.start);
        const end = offset(item.range.end);
        if (start > end)
            throw new RangeError("Edit range is reversed");
        return { start, end };
    })
        .sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < ranges.length; i++) {
        const previous = ranges[i - 1];
        const current = ranges[i];
        if (previous.end > current.start || previous.start === current.start)
            throw new RangeError("Overlapping edits are not allowed");
    }
}
export function createMonacoPorts(monaco, options) {
    const resources = new DisposableStore(options.onError);
    const changes = resources.add(new Emitter(options.onError));
    const models = new Map();
    let collectionCounter = 0;
    const attach = (model) => {
        if (models.has(model))
            return;
        const listeners = new DisposableStore(options.onError);
        models.set(model, listeners);
        listeners.add(model.onDidChangeContent(() => changes.fire(snapshot(model))));
        listeners.add(model.onWillDispose(() => {
            listeners.dispose();
            models.delete(model);
        }));
    };
    monaco.editor.getModels().forEach(attach);
    resources.add(monaco.editor.onDidCreateModel(attach));
    resources.add(disposable(() => {
        for (const item of models.values())
            item.dispose();
        models.clear();
    }));
    const cancel = (token) => {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested)
            controller.abort();
        return { signal: controller.signal, dispose: () => subscription.dispose() };
    };
    const register = (value) => resources.add(disposable(() => value.dispose()));
    const editor = {
        getActiveDocument: async (_caller, signal) => {
            checkAbort(signal);
            const model = options.getActiveEditor()?.getModel();
            return model ? snapshot(model) : undefined;
        },
        openDocument: async (_caller, uri, signal) => {
            checkAbort(signal);
            const model = await options.openDocument(uri, signal);
            checkAbort(signal);
            return snapshot(model);
        },
        applyEdits: async (caller, edit, signal) => {
            checkAbort(signal);
            const model = monaco.editor.getModel(monaco.Uri.parse(edit.uri));
            if (!model ||
                model.isDisposed() ||
                model.getVersionId() !== edit.expectedVersion ||
                !options.canEdit(model))
                return false;
            validateDocumentEdits(model, edit);
            if (edit.edits.length === 0)
                return true;
            const operations = edit.edits.map((item) => ({
                range: toMonacoRange(item.range),
                text: item.newText,
                forceMoveMarkers: true,
            }));
            const active = options.getActiveEditor();
            // No await between version check and this write. Preserve the undo stack.
            if (active?.getModel() === model) {
                active.pushUndoStop();
                const result = active.executeEdits(caller, operations);
                active.pushUndoStop();
                return result;
            }
            model.pushStackElement();
            model.pushEditOperations(null, operations, () => null);
            model.pushStackElement();
            return true;
        },
        onDidChangeDocument: () => changes.event,
    };
    const languages = {
        registerCompletionProvider: (_caller, language, provider) => register(monaco.languages.registerCompletionItemProvider(language, {
            ...(provider.triggerCharacters
                ? { triggerCharacters: [...provider.triggerCharacters] }
                : {}),
            provideCompletionItems: async (model, position, _context, token) => {
                const cancellation = cancel(token);
                try {
                    checkAbort(cancellation.signal);
                    const items = await provider.provideCompletions(snapshot(model), fromPosition(position), cancellation.signal);
                    checkAbort(cancellation.signal);
                    const word = model.getWordUntilPosition(position);
                    const kinds = {
                        text: monaco.languages.CompletionItemKind.Text,
                        function: monaco.languages.CompletionItemKind.Function,
                        variable: monaco.languages.CompletionItemKind.Variable,
                        keyword: monaco.languages.CompletionItemKind.Keyword,
                        snippet: monaco.languages.CompletionItemKind.Snippet,
                    };
                    return {
                        suggestions: items.map((item) => ({
                            label: item.label,
                            insertText: item.insertText,
                            kind: kinds[item.kind ?? "text"],
                            ...(item.detail !== undefined ? { detail: item.detail } : {}),
                            ...(item.kind === "snippet"
                                ? {
                                    insertTextRules: monaco.languages.CompletionItemInsertTextRule
                                        .InsertAsSnippet,
                                }
                                : {}),
                            range: item.range
                                ? toMonacoRange(item.range)
                                : {
                                    startLineNumber: position.lineNumber,
                                    endLineNumber: position.lineNumber,
                                    startColumn: word.startColumn,
                                    endColumn: word.endColumn,
                                },
                        })),
                    };
                }
                catch (error) {
                    if (!cancellation.signal.aborted)
                        options.onError(error);
                    return { suggestions: [] };
                }
                finally {
                    cancellation.dispose();
                }
            },
        })),
        registerHoverProvider: (_caller, language, provider) => register(monaco.languages.registerHoverProvider(language, {
            provideHover: async (model, position, token) => {
                const cancellation = cancel(token);
                try {
                    checkAbort(cancellation.signal);
                    const hover = await provider.provideHover(snapshot(model), fromPosition(position), cancellation.signal);
                    checkAbort(cancellation.signal);
                    if (!hover)
                        return undefined;
                    return {
                        contents: [
                            {
                                value: hover.markdown,
                                isTrusted: false,
                                supportHtml: false,
                            },
                        ],
                        ...(hover.range ? { range: toMonacoRange(hover.range) } : {}),
                    };
                }
                catch (error) {
                    if (!cancellation.signal.aborted)
                        options.onError(error);
                    return undefined;
                }
                finally {
                    cancellation.dispose();
                }
            },
        })),
        createDiagnosticCollection: (caller, name) => {
            const owner = `${caller}/${name}/${++collectionCounter}`;
            const pending = new Map();
            const set = (model, values) => {
                const levels = {
                    error: monaco.MarkerSeverity.Error,
                    warning: monaco.MarkerSeverity.Warning,
                    information: monaco.MarkerSeverity.Info,
                    hint: monaco.MarkerSeverity.Hint,
                };
                monaco.editor.setModelMarkers(model, owner, values.map((value) => ({
                    ...toMonacoRange(value.range),
                    message: value.message,
                    severity: levels[value.severity],
                    ...(value.source !== undefined ? { source: value.source } : {}),
                    ...(value.code !== undefined ? { code: value.code } : {}),
                })));
            };
            const created = monaco.editor.onDidCreateModel((model) => {
                const values = pending.get(model.uri.toString());
                if (values)
                    set(model, values);
            });
            const clear = () => {
                for (const path of pending.keys()) {
                    const model = monaco.editor.getModel(monaco.Uri.parse(path));
                    if (model)
                        set(model, []);
                }
                pending.clear();
            };
            const cleanup = register(disposable(() => {
                created.dispose();
                clear();
            }));
            return {
                set: (path, values) => {
                    pending.set(path, values);
                    const model = monaco.editor.getModel(monaco.Uri.parse(path));
                    if (model)
                        set(model, values);
                },
                delete: (path) => {
                    pending.delete(path);
                    const model = monaco.editor.getModel(monaco.Uri.parse(path));
                    if (model)
                        set(model, []);
                },
                clear,
                dispose: () => cleanup.dispose(),
            };
        },
    };
    return { editor, languages, dispose: () => resources.dispose() };
}
//# sourceMappingURL=monaco.js.map