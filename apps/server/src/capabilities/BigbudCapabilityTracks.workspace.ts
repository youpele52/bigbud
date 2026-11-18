import {
  BROWSER_TOOL_DESCRIPTION,
  GET_SYSTEM_RESOURCES_TOOL_DESCRIPTION,
} from "../orchestration-tools/threadOrchestrationBridge.shared.ts";
import { computerUseToolDescription } from "../orchestration-tools/orchestrationComputerUseTool.selected.ts";
import { AGENT_WORKSPACE_TOOL_SPECS } from "../orchestration-tools/AgentWorkspaceToolSpecs.ts";
import type { CapabilityTrack } from "./CapabilityCatalog.ts";
import { threadToolTrack } from "./BigbudCapabilityTracks.helpers.ts";

/** Visual replies, desktop resource monitoring and global/project workspace items. */
export const WORKSPACE_CAPABILITY_TRACKS: ReadonlyArray<CapabilityTrack> = [
  threadToolTrack({
    id: "chat.render.html",
    displayName: "Inline visual replies",
    description: "Publish durable HTML visual replies in the current thread using render_html.",
    summary:
      "render_html publishes themed inline visual replies; prefer HTML/CSS, sandboxed JS supported.",
    availability: [
      "Available through provider orchestration bridges. OpenCode V2 requires bootstrap ABI 4; retained earlier bootstraps keep their original tool surface.",
    ],
    triggers: [
      "A chart, diagram, table or interactive visual would explain the answer better.",
      "Results gathered from several web sources or searches.",
      "A comparison across options, providers or products.",
      "A small set of metrics that reads better as tiles or a chart.",
    ],
    risk: "reversible-write",
    workflow:
      "Call render_html with title and a self-contained HTML fragment (up to 24000 characters). Prefer HTML/CSS; inline JavaScript is supported. Publication is immediate, not a preview. Recipe: a heading, then source cards or a comparison table, with a one-line takeaway per item. bigbud supplies 14px typography; inherit fonts. Colours, pick one: (A, recommended) bigbud's theme variables, which follow light and dark mode: var(--background), var(--foreground), var(--card), var(--muted), var(--muted-foreground), var(--border), var(--primary), var(--accent), var(--secondary), var(--destructive), var(--radius) for corners and var(--chart-1) to var(--chart-5) for series colours; or (B) any palette and design you like, setting background, text colour and color-scheme together on your outer container so it reads on any app theme. Link sources with ordinary <a href> to http or https URLs; they open in the user's browser when the user clicks them, and #fragment links scroll within the visual. Keep under the 24000-character limit, use no external assets, and embed images as data URLs.",
    permissions:
      "Only the authenticated current thread and active turn. Sandbox has no host access, popups or forms. External navigation and ordinary external resources are blocked, but this is not zero-network isolation: browser APIs such as WebRTC remain available. Do not include credentials. Images must be embedded data URLs.",
    examples: [
      "Publish a comparison table or a self-contained interactive chart.",
      "Summarise five search results as source cards with a one-line takeaway each.",
      "Compare three providers in a table with a recommendation row.",
    ],
    antiPatterns: [
      "Do not use external scripts, remote assets, filesystem paths or host APIs.",
      "Never use render_html to ask the user a question or collect input. Use your native question tool; bigbud renders it with clickable options and a free-text field with attachments.",
      "Never mix your own text colours with bigbud's background, or invent variable names with fallback colours such as var(--text-primary, #1f2937); they break in dark mode.",
    ],
  }),
  threadToolTrack({
    id: "system.resources",
    displayName: "Desktop system resources",
    description: GET_SYSTEM_RESOURCES_TOOL_DESCRIPTION,
    summary: "Inspect desktop host/app CPU, RAM, disks, supported sensors, processes and trends.",
    triggers: [
      "A task needs current CPU, memory, network, or disk status of the desktop app's computer.",
    ],
    risk: "read-only",
    workflow:
      "Call get_system_resources with view summary, details, processes, trends or rules. Inspect source timestamps, status, incomplete attribution and truncation. Core excludes tools; inclusive includes attributed tool descendants. A stale process cursor must be explicitly restarted. Automatic context is bounded and refreshed only on user turns; background monitoring never invokes an AI turn.",
    permissions:
      "Read-only. Available while the desktop app and Rust monitor run. Desktop-owned alerts continue with the monitor page closed, not after the app quits. Temperatures depend on hardware support. No process control.",
    examples: ["Check current memory pressure on the desktop computer."],
    antiPatterns: ["Do not treat unavailable or stale metrics as current observations."],
  }),
  threadToolTrack({
    id: "system.resources.rules",
    displayName: "Resource monitoring rules",
    description: "Configure persisted desktop monitoring rules only at the user's request.",
    summary: "Persist user-requested resource alert rules.",
    triggers: ["The user asks to change resource alerts, budgets, snooze or monitoring."],
    risk: "reversible-write",
    workflow:
      "Read get_system_resources(view: rules), then configure_system_resource_rules with expectedRevision. On conflict reload, do not overwrite another change. Thresholds use percent, bytes for appMemory, Celsius for temperature. Select app core/inclusive explicitly. Reset restores conservative defaults.",
    permissions:
      "Explicit user request required. Persists locally on the desktop; does not control processes. Native notifications and monitoring after quit are not provided.",
    examples: [
      "Snooze resource alerts for ten minutes.",
      "Warn if bigbud core RSS stays over 4 GiB for a minute.",
    ],
    antiPatterns: [
      "Never invent a universal critical temperature.",
      "Never silently enable background monitoring or modify budgets.",
    ],
  }),
  ...AGENT_WORKSPACE_TOOL_SPECS.map((spec) =>
    threadToolTrack({
      id: `workspace.${spec.name.replaceAll("_", ".")}`,
      displayName: spec.name.replaceAll("_", " "),
      description: spec.description,
      triggers: ["The task requires working with global or project notes or kanban cards."],
      risk:
        spec.name.startsWith("list_") || spec.name.startsWith("get_")
          ? "read-only"
          : "reversible-write",
      workflow: `Call ${spec.name} with a global item or an item in the current project.`,
      permissions:
        "Restricted to global items and the current thread's project. Other projects and deletion are unavailable.",
      examples: [`Use ${spec.name} for global or current-project workspace items.`],
      antiPatterns: ["Do not attempt deletion or cross-project access."],
    }),
  ),
];

/** bigbud's in-app browser and native desktop automation. */
export const DESKTOP_CAPABILITY_TRACKS: ReadonlyArray<CapabilityTrack> = [
  threadToolTrack({
    id: "browser",
    displayName: "In-app browser",
    description: BROWSER_TOOL_DESCRIPTION,
    summary: "Control bigbud's visible or background browser for web navigation and interaction.",
    triggers: ["A task needs web navigation or interaction in bigbud's browser."],
    risk: "mutating",
    workflow: "Choose a visible or background browser target, interact, then release the tab.",
    permissions:
      "Page interactions can create external side effects; match them to the user's request.",
    examples: ["Inspect a signed-in page in the visible browser."],
    antiPatterns: ["Do not close a shared tab unless explicitly asked."],
    relatedCapabilityIds: ["computer.desktop"],
  }),
  threadToolTrack({
    id: "computer.desktop",
    displayName: "Desktop computer use",
    description: computerUseToolDescription(),
    summary: "Automate native desktop apps and operating-system interactions when enabled.",
    triggers: ["The user requests native desktop app or operating-system interaction."],
    risk: "mutating",
    workflow: "Use surface desktop and inspect permissions when automation fails.",
    permissions: "Mutating actions require full-access runtime mode.",
    examples: ["Open Calendar and inspect today's events."],
    antiPatterns: ["Do not use desktop automation for bigbud's built-in browser."],
    relatedCapabilityIds: ["browser"],
  }),
];
