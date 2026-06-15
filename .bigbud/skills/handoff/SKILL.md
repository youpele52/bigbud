---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

Do not include a "suggested skills" section.

If any skills were actually used during the thread and that is relevant follow-up context, include a "Skills used in this thread" section that lists:

- the skill name
- where it was used
- what it was used for

Omit that section entirely when no relevant skills were used.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

Return the document in exactly this XML block and nothing else:

<handoff_document>
FULL_MARKDOWN_DOCUMENT_BODY
</handoff_document>

Do not include commentary before or after the XML block.
