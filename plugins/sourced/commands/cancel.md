---
description: Drop a waiting upload, or all of them. Sends nothing.
argument-hint: "[<code>]"
allowed-tools: Bash(node:*)
---

`$ARGUMENTS` is the upload code the user typed, or nothing to drop every waiting upload. Run this command once with the Bash tool, exactly as written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/sourced.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}" cancel $ARGUMENTS
```

Show the command's output to the user unchanged, in a code block, and do nothing else. Do not run any other command.
