import { Schema } from "effect";
import { TrimmedNonEmptyString } from "../core/baseSchemas";

export const EditorLaunchStyle = Schema.Literals(["direct-path", "goto", "line-column"]);
export type EditorLaunchStyle = typeof EditorLaunchStyle.Type;

type EditorDefinition = {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly [string, ...string[]] | null;
  readonly baseArgs?: readonly string[];
  readonly launchStyle: EditorLaunchStyle;
  readonly installationEvidence?: {
    readonly darwinAppNames?: readonly [string, ...string[]];
    readonly linuxDesktopIds?: readonly [string, ...string[]];
    readonly win32AppPaths?: readonly [string, ...string[]];
  };
};

export const EDITORS = [
  {
    id: "cursor",
    label: "Cursor",
    commands: ["cursor"],
    launchStyle: "goto",
    installationEvidence: {
      darwinAppNames: ["Cursor.app"],
      linuxDesktopIds: ["cursor.desktop"],
      win32AppPaths: [
        "Cursor/Cursor.exe",
        "Programs/Cursor/Cursor.exe",
        "Local/Programs/Cursor/Cursor.exe",
      ],
    },
  },
  { id: "trae", label: "Trae", commands: ["trae"], launchStyle: "goto" },
  { id: "kiro", label: "Kiro", commands: ["kiro"], baseArgs: ["ide"], launchStyle: "goto" },
  {
    id: "vscode",
    label: "VS Code",
    commands: ["code"],
    launchStyle: "goto",
    installationEvidence: {
      darwinAppNames: ["Visual Studio Code.app"],
      linuxDesktopIds: ["code.desktop", "visual-studio-code.desktop"],
      win32AppPaths: [
        "Microsoft VS Code/Code.exe",
        "Programs/Microsoft VS Code/Code.exe",
        "Local/Programs/Microsoft VS Code/Code.exe",
      ],
    },
  },
  {
    id: "vscode-insiders",
    label: "VS Code Insiders",
    commands: ["code-insiders"],
    launchStyle: "goto",
    installationEvidence: {
      darwinAppNames: ["Visual Studio Code - Insiders.app"],
      linuxDesktopIds: ["code-insiders.desktop", "visual-studio-code-insiders.desktop"],
      win32AppPaths: [
        "Microsoft VS Code Insiders/Code - Insiders.exe",
        "Programs/Microsoft VS Code Insiders/Code - Insiders.exe",
        "Local/Programs/Microsoft VS Code Insiders/Code - Insiders.exe",
      ],
    },
  },
  { id: "vscodium", label: "VSCodium", commands: ["codium"], launchStyle: "goto" },
  {
    id: "windsurf",
    label: "Windsurf",
    commands: ["windsurf"],
    launchStyle: "goto",
    installationEvidence: {
      darwinAppNames: ["Windsurf.app"],
      linuxDesktopIds: ["windsurf.desktop"],
      win32AppPaths: [
        "Windsurf/Windsurf.exe",
        "Programs/Windsurf/Windsurf.exe",
        "Local/Programs/Windsurf/Windsurf.exe",
      ],
    },
  },
  {
    id: "zed",
    label: "Zed",
    commands: ["zed", "zeditor"],
    launchStyle: "direct-path",
    installationEvidence: {
      darwinAppNames: ["Zed.app"],
      linuxDesktopIds: ["zed.desktop", "dev.zed.Zed.desktop"],
      win32AppPaths: ["Zed/Zed.exe", "Programs/Zed/Zed.exe", "Local/Programs/Zed/Zed.exe"],
    },
  },
  { id: "antigravity", label: "Antigravity", commands: ["agy"], launchStyle: "goto" },
  { id: "idea", label: "IntelliJ IDEA", commands: ["idea"], launchStyle: "line-column" },
  { id: "file-manager", label: "File Manager", commands: null, launchStyle: "direct-path" },
] as const satisfies ReadonlyArray<EditorDefinition>;

export const EditorId = Schema.Literals(EDITORS.map((e) => e.id));
export type EditorId = typeof EditorId.Type;

export type CodeEditorId = Exclude<EditorId, "file-manager">;

export const CODE_EDITORS = EDITORS.filter(
  (editor) => editor.id !== "file-manager",
) as ReadonlyArray<Extract<(typeof EDITORS)[number], { readonly id: CodeEditorId }>>;

export const OpenInEditorInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  editor: EditorId,
});
export type OpenInEditorInput = typeof OpenInEditorInput.Type;

export const OpenPathInput = Schema.Struct({
  path: TrimmedNonEmptyString,
});
export type OpenPathInput = typeof OpenPathInput.Type;

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}
