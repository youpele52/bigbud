import { createHash } from "node:crypto";

import { digest, token } from "../cutover/evidence.ts";
import { allowFinding, type Allowlist } from "./allowlist.ts";
import { scanFile, type Finding, type SourceFile } from "./rules.ts";

export interface ReportedFinding extends Finding {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly reference?: string;
}

export interface ScannedFile {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
  readonly findings: readonly ReportedFinding[];
}

export interface StructuralReport {
  readonly kind: "ssh-owner-structural-report-v1";
  readonly status: "structural-conform" | "structural-violations";
  /** A pass is source-shape only. Indirect launches are outside this tool. */
  readonly structuralOnly: true;
  readonly s4Accepted: false;
  readonly scanned: readonly ScannedFile[];
  readonly summary: {
    readonly files: number;
    readonly findings: number;
    readonly allowed: number;
    readonly violations: number;
  };
}

const pathDigest = (path: string) => createHash("sha256").update(path, "utf8").digest("hex");

const findingKey = (finding: Finding) =>
  `${finding.rule}:${finding.path}:${finding.line}:${finding.symbol}`;

export function checkStructural(
  files: readonly SourceFile[],
  allowlist: Allowlist,
): StructuralReport {
  const seen = new Set<string>();
  const scanned: ScannedFile[] = [];
  let allowedCount = 0;
  let violations = 0;
  for (const file of files) {
    const findings: ReportedFinding[] = [];
    for (const finding of scanFile(file)) {
      const key = findingKey(finding);
      if (seen.has(key)) continue;
      seen.add(key);
      const allowed = allowFinding(allowlist, finding);
      if (allowed) allowedCount += 1;
      else violations += 1;
      findings.push({
        ...finding,
        allowed: allowed !== undefined,
        ...(allowed ? { reason: allowed.reason, reference: allowed.reference } : {}),
      });
    }
    scanned.push({
      id: token(pathDigest(file.path).slice(0, 24)),
      path: file.path,
      sha256: digest(createHash("sha256").update(file.content, "utf8").digest("hex")),
      findings,
    });
  }
  return {
    kind: "ssh-owner-structural-report-v1",
    status: violations === 0 ? "structural-conform" : "structural-violations",
    structuralOnly: true,
    s4Accepted: false,
    scanned,
    summary: {
      files: scanned.length,
      findings: allowedCount + violations,
      allowed: allowedCount,
      violations,
    },
  };
}
