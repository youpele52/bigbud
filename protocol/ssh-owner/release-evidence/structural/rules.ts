/**
 * Structural rules for the SSH-owner zero-bypass static check.
 *
 * These are conservative, source-shape rules. A finding is not proof of a
 * launch, and a clean file is not proof that no indirect launch exists.
 */

export const ruleNumbers = [1, 2, 3, 4, 5] as const;
export type Rule = (typeof ruleNumbers)[number];

export interface SourceFile {
  /** Repository-relative POSIX path, used for allowlist matching and reporting. */
  readonly path: string;
  readonly content: string;
}

export interface Finding {
  readonly rule: Rule;
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
}

const SSH_FAMILY = /^(?:ssh|ssh\.exe|ssh-keygen|ssh-add|ssh-agent|ssh-keyscan)$/i;
const SSH_WORD = /\b(?:ssh(?:\.exe)?|ssh-keygen|ssh-add|ssh-agent|ssh-keyscan)\b/i;
const SPAWNISH = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|runProcess|fork)\s*\(|\bfile\s*:/;
const SHELLISH = /(?:^|[\s"'`])(?:sh|bash|zsh|cmd|pwsh|powershell)(?:\.exe)?\b|\s-c(?:\s|["'`])/i;
const SENSITIVE_IDENTIFIER =
  /\b(?:SSH_ASKPASS|SSH_ASKPASS_REQUIRE|GIT_SSH_COMMAND|GIT_SSH|ControlMaster|ControlPath|ControlPersist)\b/;
const DELETED_MODULE =
  /^(?:sshCommand|sshSession(?:\.control)?|sshLocalCommand|sshProcess)(?:\.(?:ts|tsx|js|mjs|cjs))?$/;
const PRODUCT_FAMILIES = [
  /(^|\/)apps\/server\/src\/ssh\//,
  /(^|\/)apps\/server\/src\/remote-backend\/[^/]*\.ssh/,
  /(^|\/)apps\/server\/src\/peer-orchestration\//,
  /(^|\/)apps\/server\/src\/terminal-host\/[^/]*directSsh/,
  /(^|\/)apps\/server\/src\/provider\//,
  /(^|\/)apps\/server\/src\/remote-agent\//,
];
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mts|cts|rs)$/;
const TEST_FILE = /(?:\.test|\.spec|\.browser)\.[^.]+$|\/(?:fixtures?|__fixtures__)\//;

export function isSource(path: string, content: string): boolean {
  return SOURCE_EXTENSION.test(path) && !path.endsWith(".d.ts") && content.length > 0;
}

export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path);
}

/** Remove comments while preserving newlines and string/template contents. */
export function stripComments(text: string): string {
  let out = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let line = false;
  let block = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const next = text[index + 1];
    if (line) {
      if (char === "\n") {
        line = false;
        out += char;
      } else out += " ";
      continue;
    }
    if (block) {
      if (char === "*" && next === "/") {
        block = false;
        out += "  ";
        index += 1;
      } else out += char === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "/" && next === "/") {
      line = true;
      out += "  ";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      block = true;
      out += "  ";
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    out += char;
  }
  return out;
}

function lines(text: string) {
  return text.split("\n");
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function literals(line: string) {
  return [...line.matchAll(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g)].map(
    (match) => ({
      raw: match[0],
      value: match[0].slice(1, -1),
    }),
  );
}

function directSshLiteral(line: string) {
  if (!SPAWNISH.test(line)) return undefined;
  for (const literal of literals(line)) {
    const value = literal.value.trim();
    const first = value.split(/\s+/)[0] ?? "";
    if (SSH_FAMILY.test(first) || SSH_FAMILY.test(value)) return value;
  }
  return undefined;
}

function shellSshLiteral(line: string) {
  if (!SHELLISH.test(line) && !SPAWNISH.test(line)) return undefined;
  for (const literal of literals(line)) {
    if (!SSH_WORD.test(literal.value)) continue;
    // The family token has to be a command position, not an option value.
    if (
      /(?:^|[\s;&|()`'"])(?:ssh(?:\.exe)?|ssh-keygen|ssh-add|ssh-agent|ssh-keyscan)(?:\s|$)/i.test(
        literal.value,
      )
    ) {
      return literal.value;
    }
  }
  return undefined;
}

function scanRule1(linesOfFile: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of linesOfFile.entries()) {
    // Exact SSH-family literals are command candidates even when the launch
    // site is a later `command:`/spawn call, as with `const SSH_COMMAND = "ssh"`.
    for (const literal of literals(line)) {
      const value = literal.value.trim();
      if (!SSH_FAMILY.test(value)) continue;
      findings.push({ rule: 1, path: "", line: index + 1, symbol: value });
    }
    const direct = directSshLiteral(line);
    const shell = direct === undefined ? shellSshLiteral(line) : undefined;
    const symbol = direct ?? shell;
    if (symbol !== undefined) {
      findings.push({
        rule: 1,
        path: "",
        line: index + 1,
        symbol: SSH_WORD.exec(symbol)?.[0] ?? symbol.slice(0, 32),
      });
    }
  }
  return findings;
}

function scanRule2(linesOfFile: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of linesOfFile.entries()) {
    for (const match of line.matchAll(
      /\b(?:SSH_ASKPASS|SSH_ASKPASS_REQUIRE|GIT_SSH_COMMAND|GIT_SSH|ControlMaster|ControlPath|ControlPersist)\b/g,
    )) {
      findings.push({ rule: 2, path: "", line: index + 1, symbol: match[0] });
    }
    if (/-O["']?\s*(?:,\s*)?["']?exit\b/.test(line)) {
      findings.push({ rule: 2, path: "", line: index + 1, symbol: "-O exit" });
    }
  }
  return findings;
}

function scanRule3(linesOfFile: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of linesOfFile.entries()) {
    for (const match of line.matchAll(
      /\b(?:from\s*|require\s*\(\s*|import\s*\(\s*)["'`]([^"'`]+)["'`]/g,
    )) {
      const specifier = match[1] ?? "";
      const basename = specifier.split("/").at(-1) ?? "";
      if (DELETED_MODULE.test(basename)) {
        findings.push({
          rule: 3,
          path: "",
          line: index + 1,
          symbol: basename.replace(/\.[^.]+$/, ""),
        });
      }
    }
  }
  return findings;
}

function bodyAt(text: string, open: number): string {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, index + 1);
    }
  }
  return text.slice(open);
}

function scanRule4(path: string, text: string): Finding[] {
  if (!PRODUCT_FAMILIES.some((pattern) => pattern.test(path))) return [];
  const findings: Finding[] = [];
  const declarations: { name: string; params: string; body: string; index: number }[] = [];
  for (const match of text.matchAll(
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\{/g,
  )) {
    const open = text.indexOf("{", match.index);
    if (open >= 0) {
      declarations.push({
        name: match[1] ?? "",
        params: match[2] ?? "",
        body: bodyAt(text, open),
        index: match.index ?? 0,
      });
    }
  }
  for (const match of text.matchAll(
    /\b(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*(?::\s*[^=]+)?=>\s*/g,
  )) {
    const after = (match.index ?? 0) + match[0].length;
    const body =
      text[after] === "{" ? bodyAt(text, after) : (text.slice(after).split(/[;\n]/)[0] ?? "");
    declarations.push({
      name: match[1] ?? "",
      params: match[2] ?? "",
      body,
      index: match.index ?? 0,
    });
  }
  for (const declaration of declarations) {
    for (const param of ["executable", "command", "sshBinary", "env"]) {
      if (!new RegExp(`\\b${param}\\b`).test(declaration.params)) continue;
      const reachesSpawn = new RegExp(
        `\\b(?:spawn|spawnSync|execFile|execFileSync|exec|runProcess|fork)\\s*\\([^)]*\\b${param}\\b`,
        "s",
      ).test(declaration.body);
      if (reachesSpawn) {
        findings.push({
          rule: 4,
          path: "",
          line: lineOf(text, declaration.index),
          symbol: declaration.name || param,
        });
        break;
      }
    }
  }
  return findings;
}

function scanRule5(path: string, text: string): Finding[] {
  if (!path.endsWith(".rs") || path.includes("crates/bigbud-ssh-owner/")) return [];
  const findings: Finding[] = [];
  const linesOfFile = lines(text);
  for (const [index, line] of linesOfFile.entries()) {
    if (!line.includes("Command::new")) continue;
    const window = linesOfFile.slice(index, index + 3).join(" ");
    if (SSH_WORD.test(window)) {
      findings.push({ rule: 5, path: "", line: index + 1, symbol: "Command::new" });
    }
  }
  return findings;
}

export function scanFile(file: SourceFile): Finding[] {
  if (isTestPath(file.path) || !isSource(file.path, file.content)) return [];
  const text = stripComments(file.content);
  const linesOfFile = lines(text);
  const findings = [
    ...scanRule1(linesOfFile),
    ...scanRule2(linesOfFile),
    ...scanRule3(linesOfFile),
    ...scanRule4(file.path, text),
    ...scanRule5(file.path, text),
  ];
  for (const finding of findings) Object.assign(finding, { path: file.path });
  return findings;
}

/** Exported for tests: the shared identifier set used by rule 2. */
export function hasSensitiveIdentifier(line: string): boolean {
  return SENSITIVE_IDENTIFIER.test(line);
}
