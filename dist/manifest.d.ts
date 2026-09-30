import type { ExtensionManifest } from "./api.js";
export declare function assertOwnedId(owner: string, id: string): void;
export declare function deepFreeze<T>(value: T): T;
/** Validate untrusted JSON, reconstruct it, then freeze. TS types alone are not validation. */
export declare function parseManifest(input: unknown): ExtensionManifest;
//# sourceMappingURL=manifest.d.ts.map