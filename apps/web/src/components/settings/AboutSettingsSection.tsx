import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { openBrowserPanel } from "~/stores/browser/browserPanel.actions";
import { resolveAndPersistPreferredEditor } from "../../models/editor";
import { ensureNativeApi } from "../../rpc/nativeApi";
import { useServerAvailableEditors, useServerObservability } from "../../rpc/serverState";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { ABOUT_CHANGELOG_URL, ABOUT_LINKS } from "./AboutSettingsSection.links";
import { AboutManualInstallRow, AboutVersionRow } from "./AboutSettingsSection.version";

function useOpenAboutExternalUrl() {
  const navigate = useNavigate();

  return useCallback(
    (url: string) => {
      void navigate({ to: "/" }).then(() => {
        openBrowserPanel({ url });
      });
    },
    [navigate],
  );
}

export function AboutSettingsSection() {
  const openExternalUrl = useOpenAboutExternalUrl();
  const observability = useServerObservability();
  const availableEditors = useServerAvailableEditors();
  const [isOpeningLogsDirectory, setIsOpeningLogsDirectory] = useState(false);
  const [openDiagnosticsError, setOpenDiagnosticsError] = useState<string | null>(null);

  const logsDirectoryPath = observability?.logsDirectoryPath ?? null;

  const diagnosticsDescription = (() => {
    const exports: string[] = [];
    if (observability?.otlpTracesEnabled && observability.otlpTracesUrl) {
      exports.push(`traces to ${observability.otlpTracesUrl}`);
    }
    if (observability?.otlpMetricsEnabled && observability.otlpMetricsUrl) {
      exports.push(`metrics to ${observability.otlpMetricsUrl}`);
    }
    const mode = observability?.localTracingEnabled ? "Local trace file" : "Terminal logs only";
    return exports.length > 0 ? `${mode}. OTLP exporting ${exports.join(" and ")}.` : `${mode}.`;
  })();

  const openLogsDirectory = useCallback(() => {
    if (!logsDirectoryPath) return;
    setOpenDiagnosticsError(null);
    setIsOpeningLogsDirectory(true);

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenDiagnosticsError("No available editors found.");
      setIsOpeningLogsDirectory(false);
      return;
    }

    void ensureNativeApi()
      .shell.openInEditor(logsDirectoryPath, editor)
      .catch((error) => {
        setOpenDiagnosticsError(
          error instanceof Error ? error.message : "Unable to open logs folder.",
        );
      })
      .finally(() => {
        setIsOpeningLogsDirectory(false);
      });
  }, [logsDirectoryPath, availableEditors]);

  return (
    <SettingsSection title="Application">
      <AboutVersionRow />
      <SettingsRow
        title="Changelog"
        description="See what changed in recent updates."
        control={
          <Button size="xs" variant="outline" onClick={() => openExternalUrl(ABOUT_CHANGELOG_URL)}>
            View changelog
            <ExternalLinkIcon className="size-3.5" />
          </Button>
        }
      />
      <AboutManualInstallRow />
      <SettingsRow title="Links" description="Website, docs, source code, and community.">
        <ul className="mt-3 flex flex-col items-start">
          {ABOUT_LINKS.map(({ label, url }) => (
            <li key={url}>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2.5 gap-1.5 text-muted-foreground text-xs"
                onClick={() => openExternalUrl(url)}
              >
                <ExternalLinkIcon className="size-3" />
                {label}
              </Button>
            </li>
          ))}
        </ul>
      </SettingsRow>
      <SettingsRow
        title="Diagnostics"
        description={diagnosticsDescription}
        status={
          <>
            <span className="block break-all font-mono text-[11px] text-foreground">
              {logsDirectoryPath ?? "Resolving logs directory..."}
            </span>
            {openDiagnosticsError ? (
              <span className="mt-1 block text-destructive">{openDiagnosticsError}</span>
            ) : null}
          </>
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!logsDirectoryPath || isOpeningLogsDirectory}
            onClick={openLogsDirectory}
          >
            {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
