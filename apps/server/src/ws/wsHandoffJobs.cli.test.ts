import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";

import { ServerSettingsService } from "./serverSettings.ts";
import { generateCodexHandoff } from "./wsHandoffJobs.cli.ts";

const HandoffCliTestLayer = Layer.mergeAll(NodeServices.layer, ServerSettingsService.layerTest());

function makeFakeCodexBinary(fs: FileSystem.FileSystem, dir: string): Effect.Effect<string, never> {
  const codexPath = `${dir}/codex`;
  return Effect.gen(function* () {
    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'output_path=""',
        'seen_skip_git_repo_check="0"',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--skip-git-repo-check" ]; then',
        '    seen_skip_git_repo_check="1"',
        "    shift",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "    shift",
        "    continue",
        "  fi",
        "  shift",
        "done",
        'if [ "$seen_skip_git_repo_check" != "1" ]; then',
        '  printf "%s\\n" "missing --skip-git-repo-check" >&2',
        "  exit 8",
        "fi",
        "cat > \"$output_path\" <<'__BIGBUD_HANDOFF_OUTPUT__'",
        JSON.stringify({ markdown: "# Handoff\n\nBody" }),
        "__BIGBUD_HANDOFF_OUTPUT__",
        "exit 0",
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return codexPath;
  }).pipe(Effect.orDie);
}

it.layer(HandoffCliTestLayer)("generateCodexHandoff", (it) => {
  it.effect("passes skip git repo check for chat-only handoff cwd", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const serverSettings = yield* ServerSettingsService;
        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "bigbud-handoff-cli-test-",
        });
        const codexPath = yield* makeFakeCodexBinary(fileSystem, tempDir);
        yield* serverSettings.updateSettings({
          providers: { codex: { binaryPath: codexPath } },
        });

        const markdown = yield* generateCodexHandoff(
          {
            commandSpawner,
            fileSystem,
            projectionSnapshotQuery: {} as never,
            serverSettings,
          },
          {
            cwd: tempDir,
            prompt: "handoff",
            modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
          },
        );

        expect(markdown).toBe("# Handoff\n\nBody");
      }),
    ),
  );
});
