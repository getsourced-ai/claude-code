---
description: Sign out and delete the sign-in file on this computer.
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Run this command once with the Bash tool, exactly as written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/sourced.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}" signout $ARGUMENTS
```

Show the command's output to the user unchanged, in a code block, and do nothing else.
