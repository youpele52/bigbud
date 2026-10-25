import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createServer } from "node:http";
import {
  verifyArtifacts,
  loadVerifiedHeadless,
  verifiedArtifactSource,
} from "./checkpoint.extension.artifacts.mjs";
import { continuationFixtures, checkpointFixtures } from "./checkpoint.fixtures.mjs";
import { referenceState } from "./checkpoint.extension.reference.mjs";
import { corruptionChecks } from "./checkpoint.extension.corruption.mjs";
import {
  custodyRefusalChecks,
  themeRefusalChecks,
} from "./checkpoint.extension.security-cases.mjs";

const directory = resolve(process.argv[2]);
const verified = await verifyArtifacts(directory); // Derive BOTH outputs before executing either.
const { Terminal } = loadVerifiedHeadless(verified);
const options = { cols: 20, rows: 6, scrollback: 100, allowProposedApi: true };
const write = (terminal, data) => new Promise((done) => terminal.write(data, done));
const checkpoint = (terminal) => terminal.exportExperimentalCheckpoint();
const parsedState = referenceState;
const results = [];
const browserCases = [];
const extensionFixtures = [
  { name: "utf16-carry", prefix: "a\ud83d", suffix: "\ude00X" },
  {
    name: "extended-underline-protected-charset",
    prefix: '\x1b[4:3;58:2::12:34:56m\x1b[1"q\x1b(0lqk\x1b7',
    suffix: "\x1b(Bxyz\x1b8q",
  },
  {
    name: "mouse-paste-origin-insert",
    prefix: "\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[?6h\x1b[4h",
    suffix: "abc\x1b[?6lX",
  },
  { name: "cursor-shape-wrap-pending", prefix: "\x1b[5 q" + "W".repeat(20), suffix: "\x1b[6nZ" },
  { name: "long-osc-carry", prefix: "\x1b]2;" + "👩‍💻".repeat(100), suffix: "\x1b\\\x1b[6n" },
  {
    name: "extended-grapheme-alt",
    prefix: "\x1b[4:5;58:5:197mA\u0308👩‍💻\x1b[?1049hALT\x1b7",
    suffix: "\x1b8\x1b[?1049l\x1b[6n",
  },
  {
    name: "partial-osc8-new-link",
    prefix: "\x1b]8;id=fixture;https://example.invalid",
    suffix: "\x1b\\LINK\x1b]8;;\x1b\\\x1b[6n",
  },
  {
    name: "mouse-dedup-event",
    prefix: "\x1b[?1003h\x1b[?1006h",
    mouseEvent: true,
    suffix: "mouse",
  },
];
for (const fixture of new Map(
  [...checkpointFixtures, ...continuationFixtures, ...extensionFixtures].map((fixture) => [
    fixture.name,
    fixture,
  ]),
).values()) {
  const reference = new Terminal(options);
  const target = new Terminal(options);
  try {
    // Continuation fixtures have structured operations; counterexamples have strings.
    const prefix = fixture.prefix;
    if (prefix === undefined) continue;
    await write(reference, prefix);
    if (fixture.mouseEvent)
      reference._core.coreMouseService.triggerMouseEvent({
        col: 1,
        row: 1,
        x: 10,
        y: 10,
        button: 0,
        action: 32,
        ctrl: false,
        alt: false,
        shift: false,
      });
    const capture = checkpoint(reference);
    const importEvents = [];
    for (const event of ["onData", "onBell", "onTitleChange", "onResize"])
      if (typeof target[event] === "function")
        target[event]((value) => importEvents.push([event, value]));
    target.importExperimentalCheckpoint(capture);
    assert.deepEqual(importEvents, [], "state import emitted external effects");
    assert.deepEqual(
      parsedState(target),
      parsedState(reference),
      `${fixture.name}: captured state`,
    );
    const replies = [];
    const referenceReplies = [];
    reference.onData((data) => referenceReplies.push(data));
    target.onData((data) => replies.push(data));
    target.importExperimentalCheckpoint(capture);
    assert.deepEqual(replies, [], "import emitted a historical reply");
    const mouseInputs = fixture.mouseEvent
      ? [1, 2].map((col) => ({
          col,
          row: 1,
          x: 10,
          y: 10,
          button: 0,
          action: 32,
          ctrl: false,
          alt: false,
          shift: false,
        }))
      : [];
    for (const event of mouseInputs) {
      const result = reference._core.coreMouseService.triggerMouseEvent({ ...event });
      assert.equal(
        target._core.coreMouseService.triggerMouseEvent({ ...event }),
        result,
        "restored mouse deduplication",
      );
    }
    await write(reference, fixture.suffix);
    await write(target, fixture.suffix);
    assert.deepEqual(replies, referenceReplies, `${fixture.name}: continuation replies`);
    assert.deepEqual(parsedState(target), parsedState(reference), `${fixture.name}: continuation`);
    browserCases.push({
      name: fixture.name,
      capture,
      suffix: fixture.suffix,
      expected: parsedState(reference),
      replies: referenceReplies,
      mouseInputs,
    });
    results.push({
      name: fixture.name,
      status: "passed",
      checkpointBytes: capture.byteLength,
    });
  } finally {
    reference.dispose();
    target.dispose();
  }
}

// Deterministic arbitrary byte cuts, including partial UTF-8/CSI/OSC/DCS.
let seed = 0x51a7;
const stream = new TextEncoder().encode(
  "ab😀\x1b[1;2mCD\x1b]0;title\x07\x1bP$qm\x1b\\\x1b7saved\x1b8尾\r\n".repeat(8),
);
for (let index = 0; index < 64; index++) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const cut = seed % stream.length;
  const reference = new Terminal(options);
  const target = new Terminal(options);
  try {
    await write(reference, stream.slice(0, cut));
    const capture = checkpoint(reference);
    const replies = [],
      referenceReplies = [];
    reference.onData((data) => referenceReplies.push(data));
    target.onData((data) => replies.push(data));
    target.importExperimentalCheckpoint(capture);
    assert.deepEqual(replies, [], "seeded import emitted historical replies");
    assert.deepEqual(parsedState(target), parsedState(reference), `seeded captured state ${cut}`);
    if (index % 2 === 0) {
      reference.resize(17, 7);
      target.resize(17, 7);
    }
    await write(reference, stream.slice(cut));
    await write(target, stream.slice(cut));
    assert.deepEqual(replies, referenceReplies, `seeded continuation replies ${cut}`);
    assert.deepEqual(parsedState(target), parsedState(reference), `seeded cut ${cut}`);
    browserCases.push({
      name: `seeded-${index}`,
      capture,
      suffix: Array.from(stream.slice(cut)),
      resize: index % 2 === 0 ? [17, 7] : undefined,
      expected: parsedState(reference),
      replies: referenceReplies,
    });
    results.push({ name: `seeded-${index}`, status: "passed", cut });
  } finally {
    reference.dispose();
    target.dispose();
  }
}

const clean = new Terminal(options);
try {
  corruptionChecks(clean);
  clean.parser.registerOscHandler(999, () => true);
  assert.throws(() => checkpoint(clean), /registration/);
} finally {
  clean.dispose();
}

const paused = new Terminal(options);
try {
  let release;
  paused.parser.registerOscHandler(
    999,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const parsing = write(paused, "\x1b]999;synthetic\x07");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.throws(() => checkpoint(paused), /settled/);
  assert.equal(typeof release, "function");
  release(true);
  await parsing;
  assert.throws(() => checkpoint(paused), /registration/);
} finally {
  paused.dispose();
}

for (const [prefix, expected] of [
  ["\x1b]4;1;rgb:11/22/33\x07", /palette/],
  ["\x1b]4;1;?", /palette/],
  ["\x1b]8;;https://example.invalid\x07X", /hyperlink/],
]) {
  const unsupported = new Terminal(options);
  try {
    await write(unsupported, prefix);
    assert.throws(() => checkpoint(unsupported), expected);
  } finally {
    unsupported.dispose();
  }
}

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = requireWeb("playwright");
const server = createServer((_request, response) => {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.end("<!doctype html><body></body>");
});
await new Promise((done, failed) => {
  server.once("error", failed);
  server.listen(0, "127.0.0.1", done);
});
let browser, browserSecurity;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({
    content: verifiedArtifactSource(verified, "browser"),
  });
  await page.addScriptTag({
    content: `globalThis.__bigbudReferenceState = ${referenceState.toString()}`,
  });
  await page.addScriptTag({
    content: `globalThis.__bigbudCustodyCases = ${custodyRefusalChecks.toString()};
    globalThis.__bigbudThemeCases = ${themeRefusalChecks.toString()};`,
  });
  browserSecurity = await page.evaluate(() => ({
    custody: __bigbudCustodyCases(Terminal, __bigbudReferenceState),
    theme: __bigbudThemeCases(Terminal, __bigbudReferenceState),
  }));
  for (const fixture of browserCases) {
    const wire = {
      ...fixture,
      capture: { ...fixture.capture, pages: fixture.capture.pages.map((page) => Array.from(page)) },
    };
    const result = await page.evaluate(async ({ capture, suffix, resize, mouseInputs = [] }) => {
      const t = new globalThis.Terminal({ allowProposedApi: true });
      const replies = [];
      t.onData((data) => replies.push(data));
      const effects = [];
      for (const event of ["onData", "onBell", "onTitleChange", "onResize"])
        if (typeof t[event] === "function") t[event]((value) => effects.push([event, value]));
      capture.pages = capture.pages.map((page) => new Uint8Array(page));
      t.importExperimentalCheckpoint(capture);
      const historicalReplies = replies.slice();
      const importEffects = effects.slice();
      for (const event of mouseInputs) t._core.coreMouseService.triggerMouseEvent(event);
      const container = document.createElement("div");
      document.body.append(container);
      t.open(container);
      if (resize) t.resize(...resize);
      await new Promise((done) =>
        t.write(typeof suffix === "string" ? suffix : new Uint8Array(suffix), done),
      );
      const state = globalThis.__bigbudReferenceState(t);
      t.dispose();
      container.remove();
      return { state, historicalReplies, replies, importEffects };
    }, wire);
    assert.deepEqual(result.state, fixture.expected, `${fixture.name}: headless to browser`);
    assert.deepEqual(result.historicalReplies, [], `${fixture.name}: historical browser replies`);
    assert.deepEqual(result.importEffects, [], `${fixture.name}: browser import external effects`);
    if (fixture.replies)
      assert.deepEqual(
        result.replies,
        fixture.replies,
        `${fixture.name}: browser continuation replies`,
      );
  }
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
  for (const fixture of browserCases)
    Terminal.prototype.releaseExperimentalCheckpoint(fixture.capture);
}
console.log(
  JSON.stringify(
    {
      exactCapability: false,
      results,
      headlessToBrowser: browserCases.length,
      browserSecurity,
      memory: process.memoryUsage(),
      blockers: [
        "hyperlink marker custody",
        "paired headless/browser palette/query authority",
        "independent complete schema and memory-accounting review",
        "independent field coverage review",
      ],
    },
    null,
    2,
  ),
);
