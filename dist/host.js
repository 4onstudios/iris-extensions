import { abortError, checkAbort, combinedSignal, disposable, DisposableStore, Emitter, withAbort, } from "./core.js";
import { assertOwnedId, deepFreeze, parseManifest } from "./manifest.js";
export { AgentRegistry } from "./agents.js";
function required(port, name) {
    if (!port)
        throw new Error(`${name} is unavailable in this IDE host`);
    return port;
}
function uri(value) {
    try {
        if (new URL(value).protocol)
            return value;
    }
    catch {
        /* report below */
    }
    throw new Error("Expected an absolute resource URI");
}
function label(value) {
    if (!value.trim() || value.length > 512)
        throw new Error("Invalid resource name");
    return value;
}
export class ExtensionHost {
    services;
    activationTimeoutMs;
    #extensions = new Map();
    #commands = new Map();
    #builtins = new Map();
    #participants = new Map();
    #contexts = new Map();
    #closed = false;
    #changes;
    onDidChangeExtensions;
    constructor(services, activationTimeoutMs = 15_000) {
        this.services = services;
        this.activationTimeoutMs = activationTimeoutMs;
        this.#changes = new Emitter((error) => this.#log("host", "event listener failed", error));
        this.onDidChangeExtensions = this.#changes.event;
    }
    #log(id, message, error) {
        try {
            this.services.log(id, "error", message, error);
        }
        catch {
            /* logging cannot break cleanup */
        }
    }
    #open() {
        if (this.#closed)
            throw new Error("Extension host is closed");
    }
    #entry(id) {
        const entry = this.#extensions.get(id);
        if (!entry)
            throw new Error(`Unknown extension: ${id}`);
        return entry;
    }
    #changed() {
        this.#changes.fire(this.listExtensions());
    }
    listExtensions() {
        return [...this.#extensions.values()].map((e) => ({
            manifest: e.manifest,
            status: e.status,
            ...(e.error ? { error: e.error } : {}),
        }));
    }
    listCommands() {
        return [...this.#extensions.values()]
            .filter((e) => e.status !== "disabled" && e.status !== "failed")
            .flatMap((e) => e.manifest.contributes?.commands ?? []);
    }
    install(options) {
        this.#open();
        if (options.trust !== "trusted")
            throw new Error("Only trusted modules can run in this host");
        const manifest = parseManifest(options.manifest);
        if (this.#extensions.has(manifest.id))
            throw new Error(`Already installed: ${manifest.id}`);
        for (const permission of options.grant.permissions) {
            if (!manifest.permissions?.includes(permission))
                throw new Error(`Undeclared permission grant: ${permission}`);
        }
        for (const command of manifest.contributes?.commands ?? []) {
            if (this.#builtins.has(command.id))
                throw new Error(`Command already exists: ${command.id}`);
        }
        this.#extensions.set(manifest.id, {
            manifest,
            load: options.load,
            permissions: new Set(options.grant.permissions),
            commandIds: new Set(options.grant.commandIds),
            agentIds: new Set(options.grant.agentIds),
            status: "installed",
        });
        this.#changed();
    }
    registerHostCommand(id, handler) {
        this.#open();
        if (this.#builtins.has(id) ||
            [...this.#extensions.values()].some((e) => e.manifest.contributes?.commands?.some((c) => c.id === id))) {
            throw new Error(`Command already exists: ${id}`);
        }
        this.#builtins.set(id, handler);
        return disposable(() => this.#builtins.delete(id));
    }
    async start() {
        await this.activateEvent("onStartupFinished");
    }
    async activateEvent(event) {
        this.#open();
        const entries = [...this.#extensions.values()].filter((e) => {
            if (e.status === "disabled" || e.status === "failed")
                return false;
            if (e.manifest.activationEvents?.includes(event))
                return true;
            const c = e.manifest.contributes;
            return (c?.commands?.some((x) => event === `onCommand:${x.id}`) ||
                c?.chatParticipants?.some((x) => event === `onChatParticipant:${x.id}`) ||
                c?.chatContextProviders?.some((x) => event === `onChatContext:${x.id}`));
        });
        // A broken extension must not prevent others on the same event from activating.
        const results = await Promise.allSettled(entries.map((e) => this.activate(e.manifest.id)));
        results.forEach((result, index) => {
            if (result.status === "rejected")
                this.#log(entries[index].manifest.id, "Activation failed", result.reason);
        });
    }
    activate(id) {
        this.#open();
        const e = this.#entry(id);
        if (e.stopping || e.status === "disabled")
            return Promise.reject(new Error(`Extension is disabled: ${id}`));
        if (e.status === "active")
            return Promise.resolve();
        if (e.activation)
            return e.activation;
        if (e.status === "failed")
            return Promise.reject(new Error(`Enable ${id} to retry activation: ${e.error}`));
        const controller = new AbortController();
        const resources = new DisposableStore((error) => this.#log(id, "Disposal failed", error));
        e.controller = controller;
        e.resources = resources;
        e.status = "activating";
        const timer = setTimeout(() => controller.abort(new Error(`Activation timed out: ${id}`)), this.activationTimeoutMs);
        // Start on a microtask so e.activation is assigned before loading user code.
        e.activation = Promise.resolve()
            .then(async () => {
            const module = await withAbort(e.load(), controller.signal);
            if (typeof module.activate !== "function")
                throw new Error("Extension must export activate(context, api)");
            e.module = module;
            const api = this.#api(e, controller, resources);
            const state = (scope) => ({
                get: async (key) => {
                    this.#check(e, controller);
                    const value = await this.services.storage.get(id, scope, label(key), controller.signal);
                    this.#check(e, controller);
                    return structuredClone(value);
                },
                update: async (key, value) => {
                    this.#check(e, controller);
                    await this.services.storage.update(id, scope, label(key), structuredClone(value), controller.signal);
                    this.#check(e, controller);
                },
            });
            const context = Object.freeze({
                extension: e.manifest,
                subscriptions: resources,
                signal: controller.signal,
                workspaceState: Object.freeze(state("workspace")),
                globalState: Object.freeze(state("global")),
                log: Object.freeze({
                    info: (message) => this.services.log(id, "info", message),
                    error: (message, error) => this.#log(id, message, error),
                }),
            });
            await withAbort(Promise.resolve(module.activate(context, api)), controller.signal);
            this.#check(e, controller);
            e.status = "active";
        })
            .catch((error) => {
            controller.abort(error);
            resources.dispose();
            if (e.status !== "disabled") {
                e.status = "failed";
                e.error = error instanceof Error ? error.message : String(error);
            }
            throw error;
        })
            .finally(() => {
            clearTimeout(timer);
            delete e.activation;
            this.#changed();
        });
        this.#changed();
        return e.activation;
    }
    async disable(id) {
        const e = this.#entry(id);
        if (e.stopping)
            return e.stopping;
        e.status = "disabled";
        e.controller?.abort(abortError());
        e.resources?.dispose();
        const activation = e.activation;
        e.stopping = Promise.resolve()
            .then(async () => {
            await activation?.catch(() => { });
            if (e.module?.deactivate) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(new Error("Deactivation timed out")), this.activationTimeoutMs);
                try {
                    await withAbort(Promise.resolve(e.module.deactivate()), controller.signal);
                }
                catch (error) {
                    this.#log(id, "Deactivation failed", error);
                }
                finally {
                    clearTimeout(timer);
                }
            }
            delete e.module;
            delete e.controller;
            delete e.resources;
        })
            .finally(() => {
            delete e.stopping;
            this.#changed();
        });
        this.#changed();
        return e.stopping;
    }
    async enable(id) {
        this.#open();
        const e = this.#entry(id);
        if (e.status === "active" ||
            e.status === "activating" ||
            e.status === "installed")
            return;
        await this.disable(id);
        this.#open();
        e.status = "installed";
        delete e.error;
        this.#changed();
    }
    async uninstall(id) {
        await this.disable(id);
        this.#extensions.delete(id);
        this.#changed();
    }
    async close() {
        if (this.#closed)
            return;
        this.#closed = true;
        await Promise.all([...this.#extensions.keys()].map((id) => this.disable(id)));
        this.#builtins.clear();
        this.#changes.dispose();
    }
    async executeCommand(id, ...args) {
        return this.#executeCommand(id, args);
    }
    async #executeCommand(id, args, caller) {
        this.#open();
        if (!this.#commands.has(id) && !this.#builtins.has(id))
            await this.activateEvent(`onCommand:${id}`);
        const builtin = this.#builtins.get(id);
        if (builtin)
            return builtin(...structuredClone(args));
        let command = this.#commands.get(id);
        if (!command)
            throw new Error(`Command is unavailable: ${id}`);
        if (command.owner.status === "activating" && command.owner !== caller) {
            if (caller?.status === "activating")
                throw new Error("Cannot wait on another extension during activation");
            await this.activate(command.owner.manifest.id);
            command = this.#commands.get(id);
            if (!command)
                throw new Error(`Command is unavailable: ${id}`);
        }
        this.#check(command.owner, command.owner.controller);
        return command.value(...structuredClone(args));
    }
    async *streamChat(id, request, signal) {
        this.#open();
        await this.activateEvent(`onChatParticipant:${id}`);
        const item = this.#participants.get(id);
        if (!item)
            throw new Error(`Chat participant is unavailable: ${id}`);
        const ctl = item.owner.controller;
        this.#check(item.owner, ctl, "chat.register");
        const linked = combinedSignal(signal, ctl.signal);
        checkAbort(linked);
        for await (const chunk of item.value(deepFreeze(structuredClone(request)), linked)) {
            checkAbort(linked);
            yield chunk;
        }
    }
    async resolveChatContext(id, query, signal) {
        this.#open();
        await this.activateEvent(`onChatContext:${id}`);
        const item = this.#contexts.get(id);
        if (!item)
            throw new Error(`Chat context provider is unavailable: ${id}`);
        const ctl = item.owner.controller;
        this.#check(item.owner, ctl, "chat.register");
        const linked = combinedSignal(signal, ctl.signal);
        checkAbort(linked);
        const result = await withAbort(Promise.resolve(item.value.provideContext(query, linked)), linked);
        checkAbort(linked);
        return structuredClone(result);
    }
    #check(e, ctl, permission) {
        checkAbort(ctl.signal);
        if (this.#closed ||
            this.#extensions.get(e.manifest.id) !== e ||
            e.controller !== ctl ||
            (e.status !== "active" && e.status !== "activating"))
            throw new Error("Extension context is no longer active");
        if (permission && !e.permissions.has(permission))
            throw new Error(`Permission denied: ${permission}`);
    }
    #api(e, ctl, resources) {
        const id = e.manifest.id;
        const check = (permission) => this.#check(e, ctl, permission);
        const keep = (item) => {
            const tracked = disposable(() => {
                resources.delete(tracked);
                item.dispose();
            });
            resources.add(tracked);
            return tracked;
        };
        const own = (map, key, value) => {
            check();
            assertOwnedId(id, key);
            if (map.has(key))
                throw new Error(`Already registered: ${key}`);
            const entry = { owner: e, value };
            map.set(key, entry);
            return keep(disposable(() => {
                if (map.get(key) === entry)
                    map.delete(key);
            }));
        };
        const event = (permission, source) => (listener) => {
            check(permission);
            return keep(source()((value) => {
                if (ctl.signal.aborted)
                    return;
                try {
                    check(permission);
                    void Promise.resolve(listener(value)).catch((error) => this.#log(id, "Event listener failed", error));
                }
                catch (error) {
                    this.#log(id, "Event listener failed", error);
                }
            }));
        };
        const invoke = async (permission, fn) => {
            check(permission);
            const result = await withAbort(fn(), ctl.signal);
            check(permission);
            return result;
        };
        const guardResource = (raw, permission, make) => {
            let live = true;
            const d = keep(disposable(() => {
                live = false;
                raw.dispose();
            }));
            const guarded = make(() => {
                check(permission);
                if (!live)
                    throw new Error("Resource is disposed");
            }, () => d.dispose());
            return guarded;
        };
        const s = this.services;
        const api = {
            version: "1.0.0",
            commands: {
                registerCommand: (key, handler) => {
                    if (!e.manifest.contributes?.commands?.some((c) => c.id === key))
                        throw new Error(`Command is not declared: ${key}`);
                    return own(this.#commands, key, handler);
                },
                executeCommand: async (key, ...args) => {
                    check();
                    if (!e.manifest.contributes?.commands?.some((c) => c.id === key)) {
                        check("commands.execute");
                        if (!e.commandIds.has(key))
                            throw new Error(`Command not granted: ${key}`);
                    }
                    if (e.status === "activating" &&
                        !this.#commands.has(key) &&
                        !this.#builtins.has(key))
                        throw new Error("Cannot activate another command during activation; register handlers first");
                    return invoke(undefined, () => this.#executeCommand(key, args, e));
                },
            },
            workspace: {
                getFolders: () => invoke("workspace.read", () => s.workspace.getFolders(id, ctl.signal)),
                readFile: (path) => invoke("workspace.read", () => s.workspace.readFile(id, uri(path), ctl.signal)),
                writeFile: (path, bytes) => invoke("workspace.write", () => s.workspace.writeFile(id, uri(path), bytes.slice(), ctl.signal)),
                findFiles: (glob, signal) => invoke("workspace.read", () => s.workspace.findFiles(id, glob, combinedSignal(signal, ctl.signal))),
                onDidChangeFiles: event("workspace.read", () => s.workspace.onDidChangeFiles(id)),
            },
            editor: {
                getActiveDocument: () => invoke("editor.read", () => s.editor.getActiveDocument(id, ctl.signal)),
                openDocument: (path) => invoke("editor.read", () => s.editor.openDocument(id, uri(path), ctl.signal)),
                applyEdits: (edit) => invoke("editor.write", () => s.editor.applyEdits(id, structuredClone(edit), ctl.signal)),
                onDidChangeDocument: event("editor.read", () => s.editor.onDidChangeDocument(id)),
            },
            languages: {
                registerCompletionProvider: (language, provider) => {
                    check("languages.register");
                    check("editor.read");
                    return keep(required(s.languages, "Languages").registerCompletionProvider(id, label(language), {
                        ...(provider.triggerCharacters
                            ? { triggerCharacters: [...provider.triggerCharacters] }
                            : {}),
                        provideCompletions: async (doc, pos, signal) => {
                            check("languages.register");
                            const linked = combinedSignal(signal, ctl.signal);
                            checkAbort(linked);
                            const result = await withAbort(Promise.resolve(provider.provideCompletions(doc, pos, linked)), linked);
                            checkAbort(linked);
                            return result;
                        },
                    }));
                },
                registerHoverProvider: (language, provider) => {
                    check("languages.register");
                    check("editor.read");
                    return keep(required(s.languages, "Languages").registerHoverProvider(id, label(language), {
                        provideHover: async (doc, pos, signal) => {
                            check("languages.register");
                            const linked = combinedSignal(signal, ctl.signal);
                            checkAbort(linked);
                            const result = await withAbort(Promise.resolve(provider.provideHover(doc, pos, linked)), linked);
                            checkAbort(linked);
                            return result;
                        },
                    }));
                },
                createDiagnosticCollection: (name) => {
                    check("languages.register");
                    const raw = required(s.languages, "Languages").createDiagnosticCollection(id, label(name));
                    return guardResource(raw, "languages.register", (alive, dispose) => ({
                        set: (path, values) => {
                            alive();
                            raw.set(uri(path), structuredClone(values));
                        },
                        delete: (path) => {
                            alive();
                            raw.delete(uri(path));
                        },
                        clear: () => {
                            alive();
                            raw.clear();
                        },
                        dispose,
                    }));
                },
            },
            window: {
                showMessage: (message, kind = "info") => invoke(undefined, () => s.window.showMessage(id, message, kind, ctl.signal)),
                showQuickPick: (items, placeholder) => invoke(undefined, () => s.window.showQuickPick(id, structuredClone(items), placeholder, ctl.signal)),
                createOutputChannel: (name) => {
                    check();
                    const raw = s.window.createOutputChannel(id, label(name));
                    return guardResource(raw, undefined, (alive, dispose) => ({
                        appendLine: (text) => {
                            alive();
                            raw.appendLine(text);
                        },
                        clear: () => {
                            alive();
                            raw.clear();
                        },
                        show: () => {
                            alive();
                            raw.show();
                        },
                        dispose,
                    }));
                },
            },
            terminals: {
                createTerminal: async (options) => {
                    check("terminal.create");
                    if (options.cwd)
                        uri(options.cwd);
                    const creating = required(s.terminals, "Terminals")
                        .create(id, structuredClone(options), ctl.signal)
                        .then((raw) => {
                        // Creation can finish after disable even when a backend ignores abort.
                        try {
                            check("terminal.create");
                        }
                        catch (error) {
                            raw.dispose();
                            throw error;
                        }
                        return guardResource(raw, "terminal.create", (alive, dispose) => ({
                            id: raw.id,
                            onData: (listener) => {
                                alive();
                                return event("terminal.create", () => raw.onData)(listener);
                            },
                            onExit: (listener) => {
                                alive();
                                return event("terminal.create", () => raw.onExit)(listener);
                            },
                            sendText: async (text, addNewLine = true) => {
                                alive();
                                await raw.sendText(text, addNewLine);
                                alive();
                            },
                            resize: async (columns, rows) => {
                                alive();
                                if (!Number.isInteger(columns) ||
                                    !Number.isInteger(rows) ||
                                    columns < 1 ||
                                    rows < 1)
                                    throw new Error("Invalid terminal size");
                                await raw.resize(columns, rows);
                                alive();
                            },
                            show: () => {
                                alive();
                                raw.show();
                            },
                            dispose,
                        }));
                    });
                    return withAbort(creating, ctl.signal);
                },
            },
            chat: {
                registerParticipant: (key, handler) => {
                    check("chat.register");
                    if (!e.manifest.contributes?.chatParticipants?.some((c) => c.id === key))
                        throw new Error(`Participant not declared: ${key}`);
                    return own(this.#participants, key, handler);
                },
                registerContextProvider: (key, provider) => {
                    check("chat.register");
                    if (!e.manifest.contributes?.chatContextProviders?.some((c) => c.id === key))
                        throw new Error(`Context provider not declared: ${key}`);
                    return own(this.#contexts, key, provider);
                },
                requestAgent: async function* (agentId, request, signal) {
                    check("chat.use");
                    if (!e.agentIds.has(agentId))
                        throw new Error(`Agent not granted: ${agentId}`);
                    const linked = combinedSignal(signal, ctl.signal);
                    checkAbort(linked);
                    for await (const chunk of required(s.agents, "Agents").stream(id, agentId, deepFreeze(structuredClone(request)), linked)) {
                        checkAbort(linked);
                        check("chat.use");
                        yield chunk;
                    }
                },
            },
        };
        return deepFreeze(api);
    }
}
//# sourceMappingURL=host.js.map