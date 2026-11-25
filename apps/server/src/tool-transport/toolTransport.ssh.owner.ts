import type { PickerProofOwner } from "../ssh/sshOwnerPickerProof.client.ts";
import type { PickerProofWorkspaceContentMatches } from "../ssh/sshOwnerPickerProof.codec.workspace.ts";

export interface TypedSshToolOwner {
  readProofWorkspaceFile: PickerProofOwner["readProofWorkspaceFile"];
  listProofWorkspaceDirectory: PickerProofOwner["listProofWorkspaceDirectory"];
  searchProofWorkspaceContents: PickerProofOwner["searchProofWorkspaceContents"];
  writeProofWorkspaceFile: PickerProofOwner["writeProofWorkspaceFile"];
  createProofWorkspaceDirectory: PickerProofOwner["createProofWorkspaceDirectory"];
  deleteProofWorkspaceEntry: PickerProofOwner["deleteProofWorkspaceEntry"];
}

export interface TypedSshToolCapability {
  readonly targetId: string;
  readonly workspaceRoot: string;
  readonly withOwner: <A>(
    targetId: string,
    use: (owner: TypedSshToolOwner) => Promise<A>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export type TypedSshToolCommand =
  | { readonly kind: "file.read"; readonly relativePath: string }
  | {
      readonly kind: "file.range";
      readonly relativePath: string;
      readonly offset: number;
      readonly maxBytes: number;
    }
  | { readonly kind: "file.write"; readonly relativePath: string; readonly contents: string }
  | {
      readonly kind: "file.patch";
      readonly relativePath: string;
      readonly contents: string;
      readonly expectedSha256?: string | undefined;
    }
  | { readonly kind: "search.contents"; readonly query: string; readonly limit: number }
  | { readonly kind: "directory.list"; readonly relativeDir: string }
  | { readonly kind: "directory.create"; readonly relativePath: string }
  | {
      readonly kind: "entry.delete";
      readonly relativePath: string;
      readonly expectedKind: "file" | "directory";
    };

export type TypedSshToolResult =
  | {
      readonly kind: "file";
      readonly data: Uint8Array;
      readonly sizeBytes: number;
      readonly truncated: boolean;
    }
  | { readonly kind: "written"; readonly relativePath: string }
  | { readonly kind: "deleted"; readonly relativePath: string }
  | { readonly kind: "search"; readonly value: PickerProofWorkspaceContentMatches }
  | {
      readonly kind: "directory";
      readonly entries: ReadonlyArray<{ readonly name: string; readonly directory: boolean }>;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "created";
      readonly relativePath: string;
      readonly alreadyExists: boolean;
    };

export interface RunTypedSshToolCommandInput {
  readonly capability: TypedSshToolCapability;
  readonly command: TypedSshToolCommand;
  readonly signal?: AbortSignal | undefined;
  readonly executionTargetId?: string | undefined;
}

/** A closed set of workspace verbs. No command text, argv, environment or shell crosses this API. */
export async function runTypedSshToolCommand(
  input: RunTypedSshToolCommandInput,
): Promise<TypedSshToolResult> {
  const { capability, command, signal } = input;
  if (input.executionTargetId !== undefined && input.executionTargetId !== capability.targetId)
    throw new Error("The typed SSH tool command does not match the bound target.");
  const run = <A>(use: (owner: TypedSshToolOwner) => Promise<A>) =>
    capability.withOwner(capability.targetId, use, signal);
  const root = capability.workspaceRoot;

  switch (command.kind) {
    case "file.read": {
      const file = await run((owner) =>
        owner.readProofWorkspaceFile(
          {
            executionTargetId: capability.targetId,
            workspaceRoot: root,
            relativePath: command.relativePath,
            kind: "preview",
          },
          signal,
        ),
      );
      return {
        kind: "file",
        data: file.data,
        sizeBytes: file.sizeBytes,
        truncated: file.truncated,
      };
    }
    case "file.range": {
      const file = await run((owner) =>
        owner.readProofWorkspaceFile(
          {
            executionTargetId: capability.targetId,
            workspaceRoot: root,
            relativePath: command.relativePath,
            kind: "range",
            offset: command.offset,
            maxBytes: command.maxBytes,
          },
          signal,
        ),
      );
      return {
        kind: "file",
        data: file.data,
        sizeBytes: file.sizeBytes,
        truncated: file.truncated,
      };
    }
    case "search.contents": {
      const value = await run((owner) =>
        owner.searchProofWorkspaceContents(
          {
            executionTargetId: capability.targetId,
            workspaceRoot: root,
            query: command.query,
            limit: command.limit,
          },
          signal,
        ),
      );
      return { kind: "search", value };
    }
    case "directory.list": {
      const directory = await run((owner) =>
        owner.listProofWorkspaceDirectory(
          {
            executionTargetId: capability.targetId,
            workspaceRoot: root,
            relativeDir: command.relativeDir,
          },
          signal,
        ),
      );
      return {
        kind: "directory",
        entries: directory.entries.map(({ name, directory: isDirectory }) => ({
          name,
          directory: isDirectory,
        })),
        truncated: directory.truncated,
      };
    }
    case "directory.create": {
      signal?.throwIfAborted();
      const created = await run((owner) =>
        owner.createProofWorkspaceDirectory({
          executionTargetId: capability.targetId,
          workspaceRoot: root,
          relativePath: command.relativePath,
        }),
      );
      return {
        kind: "created",
        relativePath: command.relativePath,
        alreadyExists: created === "alreadyExists",
      };
    }
    case "entry.delete": {
      signal?.throwIfAborted();
      await run((owner) =>
        owner.deleteProofWorkspaceEntry({
          executionTargetId: capability.targetId,
          workspaceRoot: root,
          relativePath: command.relativePath,
          expectedDirectory: command.expectedKind === "directory",
        }),
      );
      return { kind: "deleted", relativePath: command.relativePath };
    }
    case "file.write": {
      signal?.throwIfAborted();
      await run((owner) =>
        owner.writeProofWorkspaceFile({
          executionTargetId: capability.targetId,
          workspaceRoot: root,
          relativePath: command.relativePath,
          contents: new TextEncoder().encode(command.contents),
        }),
      );
      return { kind: "written", relativePath: command.relativePath };
    }
    case "file.patch": {
      signal?.throwIfAborted();
      if (command.expectedSha256 !== undefined)
        throw new Error("Hash-guarded patches require the typed editor save path.");
      await run((owner) =>
        owner.writeProofWorkspaceFile({
          executionTargetId: capability.targetId,
          workspaceRoot: root,
          relativePath: command.relativePath,
          contents: new TextEncoder().encode(command.contents),
        }),
      );
      return { kind: "written", relativePath: command.relativePath };
    }
  }
}
