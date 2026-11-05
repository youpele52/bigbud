export function projectDeleteConfirmationCopy(input: {
  projectName: string;
  threadCount: number;
  isRemoteWorkspace: boolean;
}) {
  const label = input.isRemoteWorkspace ? "remote workspace" : "project";
  const removal = `This only removes the ${input.isRemoteWorkspace ? "workspace" : "project"} from bigbud, not from your system.`;
  return {
    title: `Delete ${label} "${input.projectName}"?`,
    description:
      input.threadCount > 0
        ? `This ${label} has ${input.threadCount} ${input.threadCount === 1 ? "thread" : "threads"} that will also be deleted. ${removal}`
        : removal,
  };
}
