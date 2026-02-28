---
name: btca-cli
description: btca is a cli for getting information from other git repositories by querying them with natural language. Spawns an external subagent to explore external codebases (i.e. a github repo) and answer questions about them. Great when integrating complex libraries, frameworks, or tools.
---

btca is a cli for asking questions about various folders, primarily git repositories. It's built to give you the exact information you need without bloating your context window. btca uses agents under the hood to answer your question, so prompt it the way you would prompt a tool similar to yourself.

For example, assuming you have a resource named `codex`, you can ask questions like:

```bash
btca ask -r codex -q "What is the return format for Codex App Server responses? Are there any edge cases worth knowing?"
```

Your prompt may include specific names for resources to use, if they do then you should try those first. If you need to check available resources, you can use the `btca resources` command.

New resources can be created if the ones you need do not yet exist.

```bash
btca add -n svelte-dev https://github.com/sveltejs/svelte.dev
```
