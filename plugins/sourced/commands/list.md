---
description: List recent search turns in this project, newest first, numbered. Sends nothing.
argument-hint: "[--since <N>d | <N>h | all] [--all]"
allowed-tools: Bash(node:*)
---

Run this command once with the Bash tool, exactly as written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/sourced.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}" list $ARGUMENTS
```

Show the command's output to the user unchanged, in a code block. Do not run any other command.

The list covers the current project only. `--all` lists every project on this computer, with the start of their prompts, so do not add `--all` unless the user typed it.
