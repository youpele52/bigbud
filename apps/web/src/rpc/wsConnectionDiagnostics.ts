import { toBoundedRedactedText } from "@bigbud/shared/providerRuntime";

/** Removes authentication, query values, and arbitrary path data from socket diagnostics. */
export function socketDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return toBoundedRedactedText(`${url.protocol}//${url.host}/ws`, { maxChars: 200 });
  } catch {
    return "[invalid socket URL]";
  }
}
