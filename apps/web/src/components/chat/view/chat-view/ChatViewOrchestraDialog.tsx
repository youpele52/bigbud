import { OrchestraDialog } from "../../orchestra/OrchestraDialog";
import { type ChatViewBaseState } from "./chat-view-base-state.hooks";
import { type ChatViewComposerDerivedState } from "./chat-view-composer-derived.hooks";

export function ChatViewOrchestraDialog(props: {
  base: ChatViewBaseState;
  composer: ChatViewComposerDerivedState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { base, composer, ...dialogProps } = props;
  if (!base.activeThread) {
    return null;
  }

  return (
    <OrchestraDialog
      {...dialogProps}
      activeProject={base.activeProject}
      activeThread={base.activeThread}
      defaultModelSelection={composer.selectedModelSelection}
      discoveredAgents={composer.discoveredAgents}
      discoveredSkills={composer.discoveredSkills}
      modelOptionsByProvider={composer.modelOptionsByProvider}
      providers={composer.providerStatuses}
      prompt={base.prompt}
      resolvedTheme={base.resolvedTheme}
      runtimeMode={base.runtimeMode}
    />
  );
}
