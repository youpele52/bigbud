#!/usr/bin/env node

import { resolve } from "node:path";

import {
  auditMacApp,
  findMacAppBundles,
  formatAuditReport,
  parseAuditArgs,
} from "./lib/macos-app-architecture.ts";

// Fails unless every Mach-O file in each packaged .app contains the build architecture, so a
// cross-built x64 app can never ship an arm64-only helper, addon or framework (or the reverse).
const { releaseRoot, arch } = parseAuditArgs(process.argv.slice(2));
const apps = findMacAppBundles(resolve(releaseRoot));
if (apps.length === 0) throw new Error(`No packaged .app bundle found under ${releaseRoot}`);

let failed = false;
for (const app of apps) {
  const result = auditMacApp(app, arch);
  const report = formatAuditReport(result, arch);
  if (result.offenders.length > 0) {
    failed = true;
    console.error(report);
  } else {
    console.log(report);
  }
}
if (failed) process.exit(1);
