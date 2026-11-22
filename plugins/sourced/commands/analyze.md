---
description: Show one search turn and the exact upload preview. Sends nothing.
argument-hint: "[number | --last] [--since <N>d | <N>h | all] [--all] | --session <id> [--turn <key>]"
allowed-tools: Bash(node:*)
---

Run this command once with the Bash tool, exactly as written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/sourced.mjs" --data-dir "${CLAUDE_PLUGIN_DATA}" analyze $ARGUMENTS
```

Show the command's output to the user unchanged, in one code block, from its first line to its last.

If the output you received was cut off (for example, a tool-output limit shortened it), say so plainly, and point the user to the saved preview file whose path the output prints ("The full upload preview ... is saved in <path>"), so they can read the whole preview there. If the path itself is in the part that was cut, say that the preview is saved as a `.txt` file in the `pending` folder of the plugin's data folder, which `/sourced:doctor` names. Do not paraphrase or fill in the missing part.

Then follow these rules:

- Do not summarize, shorten or restate the prompt, the answer or the upload preview. Do not add your own comments on them. The user needs to read the preview exactly as the command printed it.
- Do not run `upload` or any other command, and do not run this command again.
- If the output shows an upload code, tell the user that uploading is their step: they type `/sourced:upload <code>` themselves, with the code from the output. Do not upload the turn for them, even if they ask you to in their own words.
