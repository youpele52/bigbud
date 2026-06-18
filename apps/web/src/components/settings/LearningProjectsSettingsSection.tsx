import type { TeachListProjectsResult } from "@bigbud/contracts";
import { BookOpenIcon, FolderOpenIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { readNativeApi } from "../../rpc/nativeApi";
import { useSettings } from "../../hooks/useSettings";

function formatProjectLabel(project: TeachListProjectsResult["projects"][number]): string {
  return project.title ?? project.slug;
}

export function LearningProjectsSettingsSection() {
  const settings = useSettings();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<TeachListProjectsResult | null>(null);

  const loadProjects = useCallback(async () => {
    const api = readNativeApi();
    if (!api) {
      setError("Learning projects are unavailable in this environment.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await api.teach.listProjects();
      setCatalog(result);
    } catch {
      setError("Could not load learning projects.");
      setCatalog(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects, settings.defaultChatCwd]);

  const openPath = useCallback(async (targetPath: string) => {
    const api = readNativeApi();
    if (!api) return;
    await api.shell.openPath(targetPath);
  }, []);

  const learningRootPath = catalog?.learningRootPath ?? `${settings.defaultChatCwd}/bigbud-learn`;

  return (
    <SettingsSection title="Learning projects" icon={<BookOpenIcon className="size-3" />}>
      <SettingsRow
        title="Learning folder"
        description="Multi-session /skills teach projects are stored here, inside your default chat folder."
        control={
          <Button
            variant="outline"
            className="w-full justify-start gap-2 sm:w-64"
            aria-label="Open learning projects folder"
            onClick={() => void openPath(learningRootPath)}
          >
            <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{learningRootPath}</span>
          </Button>
        }
      />

      <SettingsRow
        title="Saved projects"
        description='Start a new one from chat with /skills teach and a topic, e.g. "/skills teach budgeting".'
        control={
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            disabled={loading}
            onClick={() => void loadProjects()}
          >
            <RefreshCwIcon className="size-3" />
            Refresh
          </Button>
        }
      >
        {loading ? (
          <p className="mt-2 text-xs text-muted-foreground">Loading learning projects…</p>
        ) : error ? (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        ) : catalog && catalog.projects.length > 0 ? (
          <div className="mt-2 space-y-2">
            {catalog.projects.map((project) => (
              <div
                key={project.slug}
                className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{formatProjectLabel(project)}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {project.absolutePath}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-xs"
                  onClick={() => void openPath(project.absolutePath)}
                >
                  Open
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            No learning projects yet. Run /skills teach in a chat to create your first one.
          </p>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}
