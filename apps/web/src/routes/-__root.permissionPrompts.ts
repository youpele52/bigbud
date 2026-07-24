interface FileAccessPromptGateInput {
  readonly bootstrapComplete: boolean;
  readonly hasLoadedServerConfig: boolean;
  readonly hasSeenFileAccessPrompt: boolean;
}

export function shouldShowFileAccessPrompt(input: FileAccessPromptGateInput): boolean {
  return input.bootstrapComplete && input.hasLoadedServerConfig && !input.hasSeenFileAccessPrompt;
}
