---
description: Upload the one turn that analyze showed with this code.
argument-hint: "<code>"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

`$ARGUMENTS` is the upload code the user typed. Run this command once with the Bash tool, exactly as written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/sourced.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}" upload $ARGUMENTS
```

Show the command's output to the user unchanged, in a code block, and do nothing else. Do not run any other command. If the command refuses the code or fails, show its output and stop. Never retry with a different code.
