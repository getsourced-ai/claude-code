---
description: Check the plugin's files and the transcript format. Sends nothing.
allowed-tools: Bash(node:*)
---

Run this command once with the Bash tool, exactly as written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/sourced.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}" doctor $ARGUMENTS
```

Show the command's output to the user unchanged, in a code block. Do not run any other command.
