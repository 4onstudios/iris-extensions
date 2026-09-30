import type * as M from "monaco-editor";
import type { DocumentEdit, Range, TextDocument } from "../api.js";
import type { EditorPort, LanguagesPort } from "../ports.js";
type Monaco = Pick<typeof M, "editor" | "languages" | "Uri" | "MarkerSeverity">;
export interface MonacoOptions {
    getActiveEditor(): M.editor.ICodeEditor | undefined;
    /** Use your existing tab/file service; return its already-opened Monaco model. */
    openDocument(uri: string, signal: AbortSignal): Promise<M.editor.ITextModel>;
    /** Enforce readonly files/workspaces here, including inactive models. */
    canEdit(model: M.editor.ITextModel): boolean;
    onError(error: unknown): void;
}
export declare function snapshot(model: M.editor.ITextModel): TextDocument;
export declare function toMonacoRange(range: Range): M.IRange;
export declare function validateDocumentEdits(model: M.editor.ITextModel, edit: DocumentEdit): void;
export declare function createMonacoPorts(monaco: Monaco, options: MonacoOptions): {
    editor: EditorPort;
    languages: LanguagesPort;
    dispose(): void;
};
export {};
//# sourceMappingURL=monaco.d.ts.map