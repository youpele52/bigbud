function extractOpencodeStructuredTitle(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("title" in value)) {
    return null;
  }
  const title = value.title;
  return typeof title === "string" ? title : null;
}

function extractTitleFromTextCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  try {
    const parsed = JSON.parse(candidate);
    return extractOpencodeStructuredTitle(parsed);
  } catch {
    // Fall through to loose parsing for quasi-JSON responses.
  }

  const quotedMatch = candidate.match(/['"]?title['"]?\s*:\s*['"]([^'"]+)['"]/i);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  const bareMatch = candidate.match(/['"]?title['"]?\s*:\s*([^,}\n]+)/i);
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
      ? extractOpencodeStructuredTitle(input.info.structured)
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

export { extractTitleFromTextCandidate };
