import { MobileListLink, MobileListSection } from "../components/MobileAppHeader";
import { MobileFolderIcon } from "../components/MobileFolderIcon";
import { MobileSessionGate } from "../components/MobileSessionGate";
import { useMobileSnapshot } from "../hooks/useMobileSnapshot";
import { sortProjectsForMobile } from "../lib/mobileModels";
import { useMobileSessionState } from "../context/MobileSessionContext";

export function MobileProjects() {
  const { session } = useMobileSessionState();
  const { snapshotQuery, connectionError } = useMobileSnapshot(session);

  return (
    <MobileSessionGate
      connectionError={connectionError}
      session={session}
      snapshotQuery={snapshotQuery}
    >
      {(snapshot) => {
        const projects = sortProjectsForMobile(snapshot);
        if (projects.length === 0) {
          return <p className="px-1 py-8 text-sm text-muted-foreground">No projects found.</p>;
        }
        return (
          <MobileListSection>
            {projects.map((project) => (
              <MobileListLink
                key={project.id}
                icon={<MobileFolderIcon />}
                params={{ projectId: project.id }}
                to="/mobile/projects/$projectId"
              >
                {project.title}
              </MobileListLink>
            ))}
          </MobileListSection>
        );
      }}
    </MobileSessionGate>
  );
}
