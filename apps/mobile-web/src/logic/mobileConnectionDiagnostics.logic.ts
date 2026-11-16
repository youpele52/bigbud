import type { MobileConnectionState } from "./mobileConnection.logic";
import type { MobileRecoveryFreshness } from "./mobileRecovery.types";
import {
  classifyMobileBackendReach,
  isOffNetworkMobileReach,
  toRedactedMobileOrigin,
  type MobileBackendReach,
} from "@bigbud/shared/mobileBackendReach";

/**
 * Staged, redacted connection diagnostics for the phone. Each stage reports only
 * evidence the browser actually exposes: a failed `fetch` cannot tell DNS from
 * TLS from an unreachable network, so those causes are listed as candidates,
 * never asserted. Inputs are origins and states only; no tokens or secrets.
 */
export type MobileDiagnosticStage = "address" | "http" | "websocket" | "authorization" | "catch-up";

export type MobileDiagnosticStatus = "ok" | "failed" | "pending" | "not-run";

export interface MobileDiagnosticStageResult {
  readonly stage: MobileDiagnosticStage;
  readonly label: string;
  readonly status: MobileDiagnosticStatus;
  readonly detail: string;
}

export interface MobileConnectionDiagnostics {
  readonly origin: string | null;
  readonly reach: MobileBackendReach;
  readonly findings: readonly string[];
  readonly stages: readonly MobileDiagnosticStageResult[];
}

export type MobilePairingHttpResult =
  | "ok"
  | "unreachable"
  | "rejected"
  | "rate-limited"
  | "host-unavailable"
  | "server-error"
  | "timeout"
  | "unknown"
  | "not-run";

export interface MobileConnectionDiagnosticsInput {
  /** `window.location.protocol` and origin of the page running mobile web. */
  readonly pageOrigin: string;
  readonly backendBaseUrl: string;
  /** Result of the latest pairing HTTP request, when the screen made one. */
  readonly http?: MobilePairingHttpResult;
  readonly websocket?: "open" | "connecting" | "retrying" | "failed" | "not-run";
  readonly authorization?: "accepted" | "rejected" | "expired" | "unknown";
  readonly catchUp?: "current" | "refreshing" | "unavailable" | "not-run";
  readonly browserOffline?: boolean;
}

const REACH_LABELS: Record<MobileBackendReach, string> = {
  "tailnet-https": "Tailscale HTTPS address",
  "other-https": "HTTPS address",
  "lan-https": "Same-network (LAN) HTTPS address",
  "tailnet-http": "Tailscale address without HTTPS",
  "lan-http": "Same-network (LAN) address",
  loopback: "This-computer-only address",
  "other-http": "Address without HTTPS",
  invalid: "Invalid address",
};

export function describeMobileBackendReach(reach: MobileBackendReach): string {
  return REACH_LABELS[reach];
}

function addressFindings(pageOrigin: string, origin: string | null, reach: MobileBackendReach) {
  const findings: string[] = [];
  const pageSecure = pageOrigin.startsWith("https:");
  if (pageSecure && origin?.startsWith("http:")) {
    findings.push(
      "This page uses HTTPS but the saved host address does not, so the browser blocks the connection. Pair again from a link that starts with https://.",
    );
  }
  if (reach === "lan-http" || reach === "lan-https") {
    findings.push(
      "This address works only on the same network as the host. To connect from cellular or another Wi-Fi, enable Tailscale Serve on the host and pair again from its HTTPS link.",
    );
  } else if (reach === "loopback") {
    findings.push(
      "This address points at the phone itself, not the host. Pair again from a link created with Tailscale Serve enabled.",
    );
  } else if (reach === "tailnet-https") {
    findings.push(
      "This address only works while Tailscale is signed in and connected on this phone and your tailnet allows this phone to reach the host.",
    );
  }
  if (origin !== null && pageOrigin !== origin && reach === "tailnet-https") {
    findings.push(
      "This page loads from a different site than the host address. Some browsers restrict that for private networks; this is a possible cause, not a confirmed one.",
    );
  }
  return findings;
}

function httpStage(input: MobileConnectionDiagnosticsInput): MobileDiagnosticStageResult {
  const label = "Reach host over HTTP";
  switch (input.http ?? "not-run") {
    case "ok":
      return { stage: "http", label, status: "ok", detail: "The host answered." };
    case "rejected":
      return {
        stage: "http",
        label,
        status: "failed",
        detail: "The host refused the request (link used, expired, invalid or disabled).",
      };
    case "rate-limited":
      return {
        stage: "http",
        label,
        status: "failed",
        detail: "Too many pairing attempts. Wait a minute and try again.",
      };
    case "host-unavailable":
      return {
        stage: "http",
        label,
        status: "failed",
        detail:
          "The host's HTTPS address answered, but bigbud behind it did not. bigbud may be stopped or restarting, or Tailscale Serve may point to an old port.",
      };
    case "server-error":
      return {
        stage: "http",
        label,
        status: "failed",
        detail: "The host answered with an error.",
      };
    case "unknown":
      return {
        stage: "http",
        label,
        status: "failed",
        detail: "The request failed for a reason the browser did not identify.",
      };
    case "timeout":
      return {
        stage: "http",
        label,
        status: "failed",
        detail: "No answer within 10 seconds. The host may be asleep, offline or unreachable.",
      };
    case "unreachable":
      return {
        stage: "http",
        label,
        status: "failed",
        detail:
          "The browser could not connect. Possible causes: Tailscale off on this phone, host asleep or offline, DNS or certificate failure. The browser does not say which.",
      };
    case "not-run":
      return { stage: "http", label, status: "not-run", detail: "Not checked on this screen." };
  }
}

function websocketStage(input: MobileConnectionDiagnosticsInput): MobileDiagnosticStageResult {
  const label = "Open live connection";
  switch (input.websocket ?? "not-run") {
    case "open":
      return { stage: "websocket", label, status: "ok", detail: "Connected." };
    case "connecting":
    case "retrying":
      return { stage: "websocket", label, status: "pending", detail: "Trying to connect." };
    case "failed":
      return {
        stage: "websocket",
        label,
        status: "failed",
        detail: input.browserOffline
          ? "This phone reports no network connection."
          : "Could not keep a live connection to the host.",
      };
    case "not-run":
      return { stage: "websocket", label, status: "not-run", detail: "Not started." };
  }
}

function authorizationStage(input: MobileConnectionDiagnosticsInput): MobileDiagnosticStageResult {
  const label = "Pairing accepted";
  switch (input.authorization ?? "unknown") {
    case "accepted":
      return { stage: "authorization", label, status: "ok", detail: "Pairing is valid." };
    case "rejected":
      return {
        stage: "authorization",
        label,
        status: "failed",
        detail: "The host rejected this pairing. Pair this phone again.",
      };
    case "expired":
      return { stage: "authorization", label, status: "failed", detail: "This pairing expired." };
    case "unknown":
      return { stage: "authorization", label, status: "not-run", detail: "Not confirmed yet." };
  }
}

function catchUpStage(input: MobileConnectionDiagnosticsInput): MobileDiagnosticStageResult {
  const label = "Load chats";
  switch (input.catchUp ?? "not-run") {
    case "current":
      return { stage: "catch-up", label, status: "ok", detail: "Chats are up to date." };
    case "refreshing":
      return { stage: "catch-up", label, status: "pending", detail: "Loading chats." };
    case "unavailable":
      return { stage: "catch-up", label, status: "failed", detail: "Chats could not be loaded." };
    case "not-run":
      return { stage: "catch-up", label, status: "not-run", detail: "Not started." };
  }
}

export function buildMobileConnectionDiagnostics(
  input: MobileConnectionDiagnosticsInput,
): MobileConnectionDiagnostics {
  const origin = toRedactedMobileOrigin(input.backendBaseUrl);
  const reach = origin === null ? "invalid" : classifyMobileBackendReach(origin);
  const pageOrigin = toRedactedMobileOrigin(input.pageOrigin) ?? input.pageOrigin;
  const findings = addressFindings(pageOrigin, origin, reach);
  const addressOk = isOffNetworkMobileReach(reach);
  return {
    origin,
    reach,
    findings,
    stages: [
      {
        stage: "address",
        label: "Desktop address",
        status: reach === "invalid" || reach === "loopback" ? "failed" : "ok",
        detail: `${origin ?? "Missing"} · ${describeMobileBackendReach(reach)}${addressOk ? "" : " (not usable off this network)"}`,
      },
      httpStage(input),
      websocketStage(input),
      authorizationStage(input),
      catchUpStage(input),
    ],
  };
}

/** Maps the live connection lifecycle onto diagnostic stages without inventing causes. */
export function diagnosticsInputFromConnection(input: {
  readonly connection: MobileConnectionState;
  readonly freshness: MobileRecoveryFreshness;
}): Pick<
  MobileConnectionDiagnosticsInput,
  "websocket" | "authorization" | "catchUp" | "browserOffline"
> {
  const { connection, freshness } = input;
  const websocket: MobileConnectionDiagnosticsInput["websocket"] =
    connection.transport === "open"
      ? "open"
      : connection.transport === "connecting"
        ? "connecting"
        : connection.transport === "retrying"
          ? "retrying"
          : connection.transport === "unpaired"
            ? "not-run"
            : "failed";
  const authorization: MobileConnectionDiagnosticsInput["authorization"] = connection.expired
    ? "expired"
    : connection.authorization === "explicitly-rejected"
      ? "rejected"
      : connection.authorization === "locally-expired"
        ? "expired"
        : connection.transport === "open"
          ? "accepted"
          : "unknown";
  const catchUp: MobileConnectionDiagnosticsInput["catchUp"] =
    freshness === "current" || freshness === "legacy"
      ? "current"
      : freshness === "refreshing"
        ? "refreshing"
        : connection.transport === "open"
          ? "unavailable"
          : "not-run";
  return { websocket, authorization, catchUp, browserOffline: connection.browserOffline };
}

export const MOBILE_PAIRING_TIMEOUT_MESSAGE = "Timed out reaching the host backend.";

/** A pairing request that reached an HTTP server but got a non-OK status. */
export class MobilePairingHttpError extends Error {
  readonly status: number;
  constructor(status: number, rejectedMessage: string) {
    super(describePairingHttpStatus(status, rejectedMessage));
    this.name = "MobilePairingHttpError";
    this.status = status;
  }
}

function classifyPairingHttpStatus(status: number): MobilePairingHttpResult {
  if (status === 429) return "rate-limited";
  if (status === 502 || status === 503 || status === 504) return "host-unavailable";
  if (status >= 400 && status < 500) return "rejected";
  return "server-error";
}

function describePairingHttpStatus(status: number, rejectedMessage: string): string {
  switch (classifyPairingHttpStatus(status)) {
    case "rate-limited":
      return "Too many pairing attempts. Wait a minute and try again.";
    case "host-unavailable":
      return "The host's address answered, but bigbud there is not responding. Check that bigbud is running on that host.";
    case "rejected":
      return rejectedMessage;
    default:
      return "The host backend returned an error.";
  }
}

/** Classifies a pairing failure from the error the browser exposes. */
export function classifyMobilePairingHttpFailure(error: unknown): MobilePairingHttpResult {
  if (error instanceof MobilePairingHttpError) return classifyPairingHttpStatus(error.status);
  if (
    error instanceof Error &&
    (error.message === MOBILE_PAIRING_TIMEOUT_MESSAGE ||
      error.message === "Timed out reaching the desktop backend.")
  )
    return "timeout";
  // `fetch` reports every network-level failure (DNS, TLS, refused, blocked) as a TypeError.
  if (error instanceof TypeError) return "unreachable";
  return "unknown";
}
