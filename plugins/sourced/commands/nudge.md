---
description: Show, or turn on or off, the one-line suggestion after a turn that searched the web. Sends nothing.
argument-hint: "[on | off]"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS` is `on`, `off`, or nothing to show the current setting. Run this command once with the Bash tool, exactly as written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/sourced.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}" nudge $ARGUMENTS
```

Show the command's output to the user unchanged, in a code block, and do nothing else. Do not run any other command.
