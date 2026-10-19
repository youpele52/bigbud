const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BACKOFF_MS = [5000, 15000, 30000];

function run(command, args, timeout = 120000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0 && !result.error,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}\nexit=${result.status} signal=${result.signal ?? "none"} error=${result.error?.code ?? "none"}`,
    stdout: result.stdout ?? "",
    timedOut: result.error?.code === "ETIMEDOUT",
  };
}

/** Redact credentials before emitting any tool output or recovery metadata. */
function sanitize(text, secrets) {
  let safe = String(text);
  for (const secret of secrets.filter(Boolean).toSorted((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join("[REDACTED]");
  }
  return safe
    .replace(/(password|token|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .slice(0, 12000);
}

/** Retry only known transport/ticket propagation failures, never invalid signatures. */
function isTransient(result) {
  return (
    result.timedOut ||
    /NSURLErrorDomain[^\n]*-100[159]|network connection was lost|timed? out|could not resolve|could not connect|connection reset|service unavailable|HTTP[^\n]*\b(429|50[234])\b|record not found|could not find.*ticket/i.test(
      result.output,
    )
  );
}

/** Submit once, then staple/validate the same signed app with bounded transport retries. */
async function runNotarization(options, runtime = {}) {
  const execute = runtime.run ?? run;
  const sleep = runtime.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = runtime.log ?? console.log;
  const { appPath, appleId, password, teamId } = options;
  if (!options.recoveryDir) throw new Error("[afterSign] Missing notarization recovery directory");
  fs.mkdirSync(options.recoveryDir, { recursive: true, mode: 0o700 });
  const recovery = fs.mkdtempSync(path.join(options.recoveryDir, "signed-app-"));
  const archive = path.join(recovery, "signed-app.zip");
  const secrets = [
    appleId,
    password,
    teamId,
    ...Object.entries(process.env)
      .filter(([key]) => /PASSWORD|TOKEN|SECRET|PRIVATE_KEY|CSC_LINK/i.test(key))
      .map(([, value]) => value),
  ];
  const safe = (value) => sanitize(value, secrets);
  const metadata = {
    runner: safe(process.env.RUNNER_OS ?? os.platform()),
    architecture: os.arch(),
    os: os.release(),
    image: safe(process.env.ImageVersion ?? "local"),
    submissionId: null,
    accepted: false,
  };
  const save = () =>
    fs.writeFileSync(path.join(recovery, "diagnostics.json"), JSON.stringify(metadata, null, 2), {
      mode: 0o600,
    });
  function checked(command, args, timeout) {
    const result = execute(command, args, timeout);
    if (!result.ok) throw new Error(safe(`${command} failed: ${result.output}`));
    return result;
  }
  async function ticket(operation) {
    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
      const result = execute("xcrun", ["stapler", operation, appPath]);
      if (result.ok) return;
      log(safe(`[afterSign] stapler ${operation} attempt ${attempt + 1}: ${result.output}`));
      if (attempt >= BACKOFF_MS.length || !isTransient(result)) {
        throw new Error(safe(`stapler ${operation} failed: ${result.output}`));
      }
      await sleep(BACKOFF_MS[attempt]);
    }
  }
  try {
    checked("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, archive], 600000);
    // Do not use @electron/notarize: its public API staples implicitly.
    const submission = execute(
      "xcrun",
      [
        "notarytool",
        "submit",
        archive,
        "--apple-id",
        appleId,
        "--password",
        password,
        "--team-id",
        teamId,
        "--wait",
        "--timeout",
        "30m",
        "--output-format",
        "json",
      ],
      2100000,
    );
    let response;
    try {
      response = JSON.parse(submission.stdout);
    } catch {
      throw new Error(safe(`notarytool returned no valid submission result: ${submission.output}`));
    }
    if (typeof response.id === "string" && /^[a-f0-9-]{36}$/i.test(response.id)) {
      metadata.submissionId = response.id;
    }
    metadata.accepted = submission.ok && response.status === "Accepted";
    save();
    log(
      `[afterSign] submission ${metadata.submissionId ?? "unknown"}: ${metadata.accepted ? "Accepted" : "not accepted"}`,
    );
    if (!metadata.accepted || !metadata.submissionId) {
      throw new Error(safe(`Notarization not accepted: ${submission.output}`));
    }
    await ticket("staple");
    await ticket("validate");
    checked("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    fs.rmSync(recovery, { recursive: true, force: true });
  } catch (error) {
    // Do not persist notarytool logs or environment dumps: they can contain credentials.
    metadata.failure = safe(error.message);
    for (const [name, command, args] of [
      ["osVersion", "sw_vers", []],
      ["xcode", "xcodebuild", ["-version"]],
      ["stapler", "xcrun", ["--find", "stapler"]],
      [
        "network",
        "curl",
        [
          "--disable",
          "--head",
          "--silent",
          "--show-error",
          "--max-time",
          "15",
          "--output",
          "/dev/null",
          "--write-out",
          "HTTP %{http_code}; remote %{remote_ip}; TLS %{ssl_verify_result}\n",
          "https://api.apple-cloudkit.com/",
        ],
      ],
    ]) {
      metadata[name] = safe(execute(command, args, 20000).output);
    }
    save();
    log(`[afterSign] Recovery data retained at ${recovery}`);
    throw new Error(
      `[afterSign] Notarization failed closed; no resubmission. ${metadata.failure}`,
      {
        cause: new Error(metadata.failure),
      },
    );
  }
}

module.exports = { runNotarization, sanitize, isTransient };
