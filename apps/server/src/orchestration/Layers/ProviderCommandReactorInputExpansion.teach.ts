import { Effect } from "effect";

import { buildTeachSkillRuntimeContext } from "../../teach/TeachLearningProjects.ts";
import { isTeachSkillName } from "../../teach/TeachLearningProjects.utils.ts";
import type { ProviderCommandReactorInputExpansionServices } from "./ProviderCommandReactorInputExpansion.ts";

export const appendTeachSkillRuntimeContext = Effect.fn("appendTeachSkillRuntimeContext")(
  function* (
    services: ProviderCommandReactorInputExpansionServices,
    input: {
      readonly skillName: string;
      readonly messageText: string;
      readonly threadWorkspaceRoot?: string;
    },
  ) {
    if (!isTeachSkillName(input.skillName)) {
      return null;
    }

    const defaultChatCwd = yield* services.resolveDefaultChatCwd();

    return yield* buildTeachSkillRuntimeContext({
      fileSystem: services.fileSystem,
      defaultChatCwd,
      messageText: input.messageText,
      ...(input.threadWorkspaceRoot ? { threadWorkspaceRoot: input.threadWorkspaceRoot } : {}),
    });
  },
);
