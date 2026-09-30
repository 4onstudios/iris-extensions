import { PERMISSIONS } from "./api.js";
function record(value, label) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function keys(value, allowed, label) {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            throw new Error(`Unknown ${label} field: ${key}`);
}
function string(value, label) {
    if (typeof value !== "string" || !value.trim() || value.length > 4096)
        throw new Error(`Invalid ${label}`);
    return value;
}
function list(value, label) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value) || value.length > 512)
        throw new Error(`Invalid ${label}`);
    return value;
}
export function assertOwnedId(owner, id) {
    if (!id.startsWith(`${owner}.`) ||
        !/^[a-zA-Z0-9_.-]+$/.test(id) ||
        id.length <= owner.length + 1) {
        throw new Error(`Contribution ID ${id} must start with ${owner}.`);
    }
}
function unique(items, key) {
    const seen = new Set();
    for (const item of items) {
        const id = key(item);
        if (seen.has(id))
            throw new Error(`Duplicate: ${id}`);
        seen.add(id);
    }
    return items;
}
export function deepFreeze(value) {
    if (value && typeof value === "object") {
        for (const child of Object.values(value))
            deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}
/** Validate untrusted JSON, reconstruct it, then freeze. TS types alone are not validation. */
export function parseManifest(input) {
    const m = record(input, "manifest");
    keys(m, [
        "id",
        "name",
        "version",
        "apiVersion",
        "activationEvents",
        "permissions",
        "contributes",
    ], "manifest");
    const id = string(m.id, "id");
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(id))
        throw new Error("Extension ID must be publisher.name");
    if (m.apiVersion !== 1)
        throw new Error("Unsupported extension API version");
    const version = string(m.version, "version");
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
        throw new Error("Invalid extension version");
    const permissions = unique(list(m.permissions, "permissions").map((value) => {
        if (!PERMISSIONS.includes(value))
            throw new Error(`Unknown permission: ${String(value)}`);
        return value;
    }), (x) => x);
    const events = unique(list(m.activationEvents, "activationEvents").map((value) => {
        const event = string(value, "activation event");
        if (event !== "onStartupFinished" &&
            !/^(onLanguage|onCommand|onChatParticipant|onChatContext):[a-zA-Z0-9_.+-]+$/.test(event)) {
            throw new Error(`Unsupported activation event: ${event}`);
        }
        if (!event.startsWith("onLanguage:") && event.includes(":"))
            assertOwnedId(id, event.slice(event.indexOf(":") + 1));
        return event;
    }), (x) => x);
    const c = m.contributes === undefined ? {} : record(m.contributes, "contributes");
    keys(c, ["commands", "chatParticipants", "chatContextProviders"], "contributes");
    const commands = unique(list(c.commands, "commands").map((value) => {
        const item = record(value, "command");
        keys(item, ["id", "title", "category"], "command");
        const cid = string(item.id, "command.id");
        assertOwnedId(id, cid);
        return {
            id: cid,
            title: string(item.title, "command.title"),
            ...(item.category === undefined
                ? {}
                : { category: string(item.category, "category") }),
        };
    }), (x) => x.id);
    const chats = (values, label) => unique(list(values, label).map((value) => {
        const item = record(value, label);
        keys(item, ["id", "name", "description"], label);
        const cid = string(item.id, `${label}.id`);
        assertOwnedId(id, cid);
        return {
            id: cid,
            name: string(item.name, `${label}.name`),
            ...(item.description === undefined
                ? {}
                : { description: string(item.description, "description") }),
        };
    }), (x) => x.id);
    const chatParticipants = chats(c.chatParticipants, "chatParticipants");
    const chatContextProviders = chats(c.chatContextProviders, "chatContextProviders");
    if ((chatParticipants.length || chatContextProviders.length) &&
        !permissions.includes("chat.register")) {
        throw new Error("Chat contributions require chat.register");
    }
    return deepFreeze({
        id,
        name: string(m.name, "name"),
        version,
        apiVersion: 1,
        activationEvents: events,
        permissions,
        contributes: { commands, chatParticipants, chatContextProviders },
    });
}
//# sourceMappingURL=manifest.js.map