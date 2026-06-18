---
name: teach
description: Guide structured, multi-session learning with persisted missions, lessons, and reference docs in a dedicated bigbud learning folder. Use when the user wants to learn something over time, start a learning project, build a course, or says "teach me over time" or "I want to learn X properly" — not for one-off explanations of code or quick answers.
argument-hint: "What would you like to learn? (e.g. budgeting, photography, Spanish)"
---

The user wants structured learning across multiple sessions — not a one-off explanation.

## Before you write anything

### 1. Pick a learning project folder

Never treat the user's open thread folder, default chat folder, or git project as the teaching workspace.

**Required layout:** `<default-chat-folder>/bigbud-learn/<topic-slug>/`

Example: if the default chat folder is `~/Documents` and the topic is budgeting, every file goes under `~/Documents/bigbud-learn/personal-budgeting/` — **not** `~/Documents/MISSION.md`.

- `<default-chat-folder>` is set in **bigbud Settings → File Access → default chat folder**.
- bigbud injects the resolved paths when this skill runs — treat that runtime block as authoritative.
- Derive `<topic-slug>` from the topic (e.g. `personal-budgeting`, `beginner-photography`).
- **Create the `<topic-slug>` folder first**, then write files inside it.
- Each subject gets its own `<topic-slug>` folder so projects never overwrite each other.
- If the user names a different dedicated folder, use that instead.
- If a project folder already has `MISSION.md` or `lessons/`, treat it as a **resume**.

**Never write teaching files at these locations:**

- The default chat folder root (`MISSION.md` directly in Documents is wrong)
- `bigbud-learn/` without a `<topic-slug>` subfolder
- A directory containing `.git`, unless the user explicitly asks to learn inside that repo
- Home, Desktop, or other non-dedicated locations

If runtime context lists **misplaced teaching files** at the chat-folder root, move them into the correct project folder (or ask the user before moving) before creating new ones.

**If runtime context is missing** (rare): use `<defaultChatCwd>/bigbud-learn/<topic-slug>/` from settings. Ask once if unknown — never guess.

### 2. One-off vs multi-session

If the user only wants a quick answer ("what does this mean?", "explain this error"), answer directly and **do not** spin up a learning project or write files.

If they want learning over time, continue below.

## Teaching workspace

State for each learning project lives under the chosen folder:

- `MISSION.md` — Why the user is learning. Grounds all teaching. Format in [MISSION-FORMAT.md](./MISSION-FORMAT.md).
- `RESOURCES.md` — Curated high-trust sources. Format in [RESOURCES-FORMAT.md](./RESOURCES-FORMAT.md).
- `GLOSSARY.md` — Canonical terminology. Created lazily. Format in [GLOSSARY-FORMAT.md](./GLOSSARY-FORMAT.md).
- `./learning-records/*.md` — Progress and prior knowledge. Format in [LEARNING-RECORD-FORMAT.md](./LEARNING-RECORD-FORMAT.md).
- `./lessons/*.html` — Self-contained HTML lessons (one concept each, tied to the mission).
- `./reference/*.html` — Compressed cheat sheets for quick review and printing.
- `NOTES.md` — User preferences and working notes.

Create files and directories lazily — only when you have something to write.

## Philosophy

Learning needs three things:

- **Knowledge** — from high-quality, high-trust resources (never rely solely on parametric knowledge)
- **Skills** — acquired through interactive lessons with tight feedback loops
- **Wisdom** — real-world interaction via communities (forums, subreddits, local groups)

### Fluency vs storage strength

- **Fluency strength**: in-the-moment retrieval (can create illusion of mastery)
- **Storage strength**: long-term retention (the real goal)

Design for storage strength using desirable difficulty: retrieval practice, spacing, and interleaving.

## Lessons

The main unit of teaching. Each is one self-contained HTML file in `./lessons/`, named `0001-dash-case-name.html` (sequential numbering).

**Characteristics:**

- **Beautiful** — clean Tufte-style typography. The user will return to review.
- **Short** — completable quickly. Working memory is small.
- **One tangible win** — directly tied to the mission.
- **Citations** — link to high-trust resources. Never make unsupported claims.
- **Anchored** — link to other lessons and reference documents via HTML anchors.
- **Primary source recommendation** — point the user to the best resource you found.
- **Follow-up prompt** — remind the user they can ask questions in bigbud.

After creating a lesson, tell the user the file path and that they can open it in a browser.

## The mission

Every lesson ties to the mission (why the user wants to learn this).

If `MISSION.md` is not populated, interview the user first. Use plain language; avoid jargon unless the topic requires it. A bad mission is worse than no mission.

Missions may change as the user develops. Confirm with the user before updating.

## Zone of proximal development

Each lesson should challenge the user "just enough." Determine ZPD by:

- Reading learning records for what is already established
- Matching the next teachable thing to their mission
- Picking the most relevant thing in their zone

## Knowledge vs skills

**Knowledge** — gathered from trusted resources first. Keep `RESOURCES.md` updated. Lessons include citations. Difficulty is the enemy of acquisition — it eats working memory.

**Skills** — built through interactive feedback loops. Difficulty is the tool — effortful retrieval builds storage strength. Use quizzes, light in-browser tasks, or guided real-world steps. Feedback should be immediate and automatic where possible.

## Acquiring wisdom

When a question needs real-world experience, attempt to answer but ultimately delegate to a **community**. Find high-reputation communities. Respect opt-out preferences recorded in `RESOURCES.md` or `NOTES.md`.

## Reference documents

While creating lessons, also create reference docs in `./reference/`. Lessons are rarely revisited — reference docs are. Compress knowledge for quick lookup. Once `GLOSSARY.md` exists, use its terms consistently.

## NOTES.md

Record how the user prefers to learn, time constraints, accessibility needs, and things to keep in mind. Refer back when designing lessons.

## Multi-session continuity (bigbud)

Teaching projects span multiple bigbud chats. At the end of a substantive session:

1. Write or update learning records for anything newly established.
2. Briefly summarize progress and the suggested next lesson.
3. Suggest the user run `/skills handoff` before starting a fresh chat, so the next session can pick up without re-explaining. Mention the learning project path in that suggestion.

When resuming, read `MISSION.md`, recent learning records, and the latest lesson before teaching more.

## User-facing tone

Assume the user may not be technical. Prefer:

- Plain paths and file names over shell jargon
- Concrete next steps ("open this file in your browser") over abstract process talk
- Short summaries of what was created and where it lives
