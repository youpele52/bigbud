import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
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
  const [isRestarting, setIsRestarting] = useState(false);
  const [openDiagnosticsError, setOpenDiagnosticsError] = useState<string | null>(null);
  const canRestart = Boolean(window.desktopBridge?.restartApplication);

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

  const restartApplication = useCallback(() => {
    const restart = window.desktopBridge?.restartApplication;
    if (!restart || isRestarting) return;
    setIsRestarting(true);
    void restart().catch(() => {
      setIsRestarting(false);
    });
  }, [isRestarting]);

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
          <Button
            size="xs"
            variant="outline"
            className="gap-1"
            onClick={() => openExternalUrl(ABOUT_CHANGELOG_URL)}
          >
            View changelog
            <ArrowUpRightIcon className="size-3 shrink-0" aria-hidden="true" />
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
                className="gap-1.5 px-0 text-muted-foreground text-xs hover:bg-transparent"
                onClick={() => openExternalUrl(url)}
              >
                {label}
                <ArrowUpRightIcon className="size-3 shrink-0" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      </SettingsRow>
      {canRestart ? (
        <SettingsRow
          title="Restart"
          description="Restarts bigbud and its local engine. Use this if chat stays stuck after reconnect."
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={isRestarting}
              onClick={restartApplication}
            >
              {isRestarting ? "Restarting..." : "Restart bigbud"}
            </Button>
          }
        />
      ) : null}
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
            className="gap-1"
            disabled={!logsDirectoryPath || isOpeningLogsDirectory}
            onClick={openLogsDirectory}
          >
            {isOpeningLogsDirectory ? "Opening..." : "Open logs folder"}
            {isOpeningLogsDirectory ? null : (
              <ArrowUpRightIcon className="size-3 shrink-0" aria-hidden="true" />
            )}
          </Button>
        }
      />
    </SettingsSection>
  );
}
