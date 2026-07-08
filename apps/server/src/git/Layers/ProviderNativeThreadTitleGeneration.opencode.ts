function extractOpencodeStructuredString(value: unknown, key: "title" | "summary"): string | null {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return null;
  }
  const extracted = (value as Record<"title" | "summary", unknown>)[key];
  return typeof extracted === "string" ? extracted : null;
}

function extractValueFromTextCandidate(text: string, key: "title" | "summary"): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    const parsed = JSON.parse(candidate);
    return extractOpencodeStructuredString(parsed, key);
  } catch {
    // Fall through to loose parsing for quasi-JSON responses.
  }

  const quotedMatch = candidate.match(new RegExp(`['"]?${key}['"]?\\s*:\\s*['"]([^'"]+)['"]`, "i"));
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  const bareMatch = candidate.match(new RegExp(`['"]?${key}['"]?\\s*:\\s*([^,}\\n]+)`, "i"));
  if (bareMatch?.[1]) {
    return bareMatch[1].trim();
  }

  return null;
}

export function extractOpencodeResponseTitle(input: {
  readonly info: unknown;
  readonly parts: ReadonlyArray<unknown>;
}): string | null {
  const structuredTitle =
    typeof input.info === "object" && input.info !== null && "structured" in input.info
      ? extractOpencodeStructuredString(input.info.structured, "title")
      : null;

  if (structuredTitle) {
    return structuredTitle;
  }

  for (const part of input.parts) {
    if (typeof part !== "object" || part === null || !("type" in part) || !("text" in part)) {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
      return extractTitleFromTextCandidate(part.text) ?? part.text;
    }
  }

  return null;
}

export function extractOpencodeResponseSummary(input: {
  readonly info: unknown;
  readonly parts: ReadonlyArray<unknown>;
}): string | null {
  const structuredSummary =
    typeof input.info === "object" && input.info !== null && "structured" in input.info
      ? extractOpencodeStructuredString(input.info.structured, "summary")
      : null;

  if (structuredSummary) {
    return structuredSummary;
  }

  for (const part of input.parts) {
    if (typeof part !== "object" || part === null || !("type" in part) || !("text" in part)) {
      continue;
    }
    if (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0) {
      return extractSummaryFromTextCandidate(part.text) ?? part.text;
    }
  }

  return null;
}

const extractTitleFromTextCandidate = (text: string) =>
  extractValueFromTextCandidate(text, "title");
const extractSummaryFromTextCandidate = (text: string) =>
  extractValueFromTextCandidate(text, "summary");

export { extractTitleFromTextCandidate, extractSummaryFromTextCandidate };
