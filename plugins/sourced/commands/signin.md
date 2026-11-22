---
description: Sign in with Google so that a turn can be uploaded to your account.
allowed-tools: Bash(node:*)
---

Before you run the command, tell the user that a browser window opens for the Google sign-in and that the command waits up to three minutes for them to finish it.

Run this command once with the Bash tool, exactly as written, with a Bash timeout of 240000 milliseconds so that the tool does not stop it before the three minutes are up:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/sourced.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}" signin $ARGUMENTS
```

Show the command's output to the user unchanged, in a code block. Do not run any other command.
