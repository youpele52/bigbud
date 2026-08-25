import { CloudIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { LaptopMinimalIcon } from "lucide-react";

import type { Project } from "../../models/types";
import { resolveWorkspaceExecutionTargetId } from "../../lib/providerExecutionTargets";
import { isRemoteExecutionTargetId } from "../sidebar/Sidebar.projects.logic";

export function ProjectLocationIcon({
  className,
  project,
}: {
  className?: string;
  project: Project | null | undefined;
}) {
  const isRemote = project
    ? isRemoteExecutionTargetId(resolveWorkspaceExecutionTargetId(project))
    : false;

  return isRemote ? (
    <HugeiconsIcon
      aria-hidden="true"
      className={className}
      icon={CloudIcon}
      size={12}
      strokeWidth={1.5}
    />
  ) : (
    <LaptopMinimalIcon aria-hidden="true" className={className} />
  );
}
