interface FileAccessPromptGateInput {
  readonly bootstrapComplete: boolean;
  readonly hasLoadedServerConfig: boolean;
  readonly hasSeenFileAccessPrompt: boolean;
}

interface ComputerUsePromptGateInput {
  readonly bootstrapComplete: boolean;
  readonly hasLoadedServerConfig: boolean;
  readonly hasSeenFileAccessPrompt: boolean;
  readonly hasSeenComputerUsePrompt: boolean;
  readonly isDesktop: boolean;
  readonly showFileAccessDialog: boolean;
}

interface ChainedComputerUsePromptGateInput {
  readonly hasLoadedServerConfig: boolean;
  readonly hasSeenComputerUsePrompt: boolean;
  readonly isDesktop: boolean;
}

export function shouldShowFileAccessPrompt(input: FileAccessPromptGateInput): boolean {
  return input.bootstrapComplete && input.hasLoadedServerConfig && !input.hasSeenFileAccessPrompt;
}

export function shouldShowComputerUsePrompt(input: ComputerUsePromptGateInput): boolean {
  return (
    input.bootstrapComplete &&
    input.hasLoadedServerConfig &&
    input.isDesktop &&
    input.hasSeenFileAccessPrompt &&
    !input.hasSeenComputerUsePrompt &&
    !input.showFileAccessDialog
  );
}

export function shouldChainComputerUsePrompt(input: ChainedComputerUsePromptGateInput): boolean {
  return input.hasLoadedServerConfig && input.isDesktop && !input.hasSeenComputerUsePrompt;
}
