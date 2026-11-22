# Sourced for Claude Code

When a developer asks Claude Code which API, SDK or service to use, Claude Code searches the web, opens a few pages and cites some of them in its answer. This plugin shows you what happened in one turn: the queries Claude ran, the results that came back and their order, the pages it fetched, and the links its answer listed.

If you build a developer tool or an API, this is how you see whether Claude Code finds your docs, your pricing page or your comparison pages, and which pages it uses instead. If you work in SEO or marketing for a company that sells to engineers, it gives you the same view of the prompts your buyers type.

The plugin is free and needs no account. Recording, `list`, `analyze` and the local view all run on your computer. The hooks and the `list`, `analyze`, `doctor`, `cancel` and `nudge` commands make no network call, and no search, page, prompt or answer leaves your computer until you pick one turn, read the exact upload preview, and confirm that turn yourself. `signin` contacts the sign-in service. The plugin also bundles a separate, read-only connector that Claude Code itself opens to the Sourced server; see "Reading saved turns in Claude Code" below.

The plugin is made by Elegant Atomics and released under the MIT license (see `LICENSE`). Its text may change before the first release.

## What it records, and where

The plugin adds two hooks to Claude Code. One runs after each WebSearch or WebFetch call, and one runs when a turn finishes. Each hook writes one small file and makes no network call.

- For a search, the file holds the query, the search mode and domain filters if Claude set them, and the title and address of each result in the order they came back.
- For a page fetch, the file holds the address that was asked for, the address that answered, the status code, the size and the time it took.
- When a turn that searched finishes, the hook writes one more file to mark the end of that turn. That file holds the full text of Claude's answer for the turn. Like the other files, it stays on your computer and leaves it only if you upload that turn.

The hooks also run for searches and page fetches that a subagent makes, including the `web-fetch` subagent Claude Code uses to fetch pages, and each such file is filed under the prompt you typed. This was confirmed in a real Claude Code session on 2026-11-15. Each hook took 12 to 39 ms there.

The files go in the `queue` folder inside the plugin's data folder, with one subfolder per Claude Code session. Claude Code gives each plugin its own data folder, which survives plugin updates, and it tells the hooks where that folder is. For this plugin it is `~/.claude/plugins/data/sourced-sourced` (seen in a real install on 2026-11-15). Claude Code does not pass that folder to the commands in the same way, so each command file passes it to the plugin as `--data-dir "${CLAUDE_PLUGIN_DATA}"`, which Claude Code fills in when it loads the command. If Claude Code names no data folder, or leaves that value empty, the plugin uses `~/.claude/sourced-data`. The data folder and the folders in it are readable only by your user, and so are the files. Run `/sourced:doctor` to see the data folder's name, why the plugin chose it, the number of files in your queue and the state of the plugin's record of saved turns. If another program made the data folder or a folder in it readable by other users, `doctor` says so and makes it private again. If a second data folder also holds a queue, `doctor` warns you, because the commands then read a different folder from the one the hooks write to.

The hooks never write your working directory, your prompt, the transcript path, the instructions Claude gave for a page fetch, the text of a fetched page, or the summary text that comes with search results. Queue files older than 30 days are deleted, at most once a day, by the hook itself.

To show a turn's prompt and answer, the plugin also reads Claude Code's own session transcripts on your computer. It only reads them and never changes them. This is also how turns from before you installed the plugin can appear in the list. A session run with `claude -p --no-session-persistence` has no transcript: its searches are recorded and listed, with no prompt, and they can't be uploaded. `/sourced:doctor` counts such sessions.

## Looking at a turn

`/sourced:list` lists recent turns in the current project that searched the web, newest first and numbered. It shows turns from the last 7 days; `--since 30d` or `--since 12h` changes that, and `--since all` shows turns from any time. It also finds a turn whose only search ran in a subagent. A turn you already uploaded is marked "saved", and the plugin knows it by its session id and turn id.

The current project is the folder Claude Code keeps for the folder you started it in. If the plugin can't tell which project that is, `list` says so and shows nothing. `/sourced:list --all` lists turns from every project on this computer, and its first line says so. Claude repeats what `list` prints into your session, so `--all` puts the start of prompts from your other projects into this session, which matters if those projects hold other people's or other clients' work. A list number opens the same turn only with the same options: after `list --all`, type `/sourced:analyze <number> --all`. The list's last line shows the command to use.

`/sourced:analyze <number>` shows the upload preview for one turn, built from the upload itself, in this order: a line with the time and the model; the exact prompt, in full; the exact answer, in full; "Searches", with each query and the number of results it returned; "Pages", with every page address the upload holds, once each, with its tags ("Cited (inferred)", "Opened", "Result #n", or "Result #n of search m" when the turn searched more than once) and its title (when a search result's title is really the start of the page, such as "# Web search", the page's host shows instead; the saved copy's JSON keeps it as it uploads); a note that the links in the answer are inferred; and "Also sent", with the other values the upload holds. When several results are the same page, "Pages" says how many results it merged. Then come the path of a saved copy of the preview, which also holds the whole upload as JSON, the upload's fingerprint, the confirm question, and a six-character upload code. The code works for 15 minutes. `analyze` sends nothing. A turn that can't be uploaded shows a short view instead, with its prompt cut to 300 characters. A turn that is already saved shows its searches and pages, with each page's title and address in full, then "This turn is already saved." and no code. `/sourced:analyze --last` opens the newest finished search turn in the current project, and when the last turn that used the web only opened pages, it says so and shows that turn instead, with nothing to upload.

When a turn that searched the web finishes, the plugin shows you one line under the answer. Claude Code labels it "Stop says:", so it reads, for example, "Stop says: Sourced: this turn ran 3 searches. /sourced:analyze shows what was searched, opened and cited." Claude does not reply to it. It shows the line at most once per turn, and never for a turn with no search, for a subagent, or in print mode (`claude -p`). Showing it sends nothing and reads nothing beyond the files the hook already keeps and the plugin's own settings file. To stop it, type `/sourced:nudge off`; `/sourced:nudge on` turns it back on, and `/sourced:nudge` alone shows the setting. It is on by default.

A turn counts as a search only when at least one web search returned at least one result. A turn that only fetched pages, or whose searches returned nothing, shows "No web search" and cannot be uploaded.

## What one upload holds

One upload is one turn. No command uploads more than one turn, and the plugin has no setting that saves every turn.

The upload holds:

- the prompt and the answer;
- the searches, the results (title, address and rank), the pages fetched and the links the answer listed. The pages fetched are sent as their addresses only. Each link the answer listed is sent with a label that says Sourced inferred it, and the upload holds no list of links without that label;
- per-site counts and ranks worked out from those pages;
- a title for the saved turn, which is the start of your prompt: at most 80 characters on one line, cut at a word where it can be. It is never Claude Code's own title for the session;
- a turn id made from the Claude Code session id and the turn's prompt id (so the same turn is stored only once);
- a random id for this install of the plugin;
- the name of the model that answered;
- the time the turn started and the time it finished;
- fixed labels that say where the upload came from: `surface` (`claude_code`), `client` (`logged-in`) and `capturedVia` (`transcript`).

"Also sent" in the preview lists the title, the turn id, the install id, the model, the two times and the labels with their values. The saved copy of the preview holds the whole upload as JSON.

It never includes your code files, your working directory, your git branch, the rest of the session's transcript, or your Claude account details. It also never includes the search mode or domain filters, the instructions Claude gave for a page fetch, or the text of a fetched page. Coding prompts can contain code, file names or client names, so check the preview before you confirm.

## The confirm step

`analyze` ends with the confirm question, "Upload this turn? This sends the prompt and answer shown above, with the searches and pages, to your account. Nothing else from this session is sent.", and an instruction to type `/sourced:upload <code>` with the code it printed. The upload happens only when you type that command: typing it is your answer, so `upload` does not ask again and prints "Uploading the turn you previewed (code <code>)." Before it sends anything, `upload` checks this session's transcript for the command you typed. Claude Code writes a typed command there differently from one Claude runs itself, so if Claude started the upload, or the transcript doesn't show you typing it with that code, nothing is sent and the code keeps working for you to type. Which session is current is read from a value Claude Code sets; when it is not set, the plugin looks for the typed code in the transcripts written since the code was made. Before it sends anything, `upload` reads the turn from the transcript again and rebuilds the upload, and it sends nothing unless the result is exactly the preview you saw. The analyze command file tells Claude not to run the upload itself, and the upload command file is marked so that Claude cannot start it on its own. In a real session on 2026-11-20, `upload` and `signout` were not among the commands Claude could run on its own. Because the sign-in file is on the same computer that Claude Code runs on, these steps describe how the plugin is built rather than a security boundary.

If you change your mind, do nothing: the code expires after 15 minutes and nothing is sent. To drop a code at once, type `/sourced:cancel <code>`, or `/sourced:cancel` alone to drop every waiting code. Cancelling sends nothing. While the code works, the preview is also saved in a file in the plugin's data folder, with the whole upload as JSON and its fingerprint, so you can read it outside Claude Code. `analyze` prints the file's path.

## More with an account

The plugin is part of Sourced, which also has a Chrome extension for AI search and a web dashboard. Everything above works without an account. If you sign in, you can also upload the turns you choose to your account, see them in the dashboard beside your other saved chats, and have Claude read them back through the bundled connector. While you are signed out, `list` ends with one line that says so, and once you are signed in it shows nothing of the kind.

## Signing in and out

An upload needs an account. `/sourced:signin` opens a browser window for the Google sign-in and waits up to three minutes for you to finish it. The plugin then keeps the sign-in in a file named `session.json` in its data folder, readable only by your user. The plugin has no guest mode.

`/sourced:signout` deletes that file. Turns you already uploaded stay in your account until you delete them there. After you delete them in your account, `/sourced:list` still marks them "[saved]" and `/sourced:analyze` still says "This turn is already saved.", because that mark comes from the plugin's own record on your computer, and a delete in your account does not reach it (seen 2026-11-20, O3).

## Reading saved turns in Claude Code

The plugin includes a connector, named `sourced`, that lets Claude read the turns saved to your account. It is separate from the rest of the plugin:

- It is listed in the plugin's `.mcp.json`. Claude Code itself opens the link to the Sourced server when the plugin is enabled, which can be as soon as a session starts and without asking you; the plugin's own code does not. That contact holds no prompt, answer, search or page data, and the server returns data from your account only after you sign in to the connector. Whether Claude Code connects to it before you sign in to it is not yet confirmed.
- It is read-only: it cannot upload a turn. The plugin puts no session data into it. What it carries are the requests Claude makes to read your saved turns.
- It has its own sign-in, which you start by connecting it from `/mcp` (not yet confirmed in a real install). That sign-in is separate from `/sourced:signin`.

If you don't want the connector, disable the `sourced` server in Claude Code's `/mcp` settings (the exact steps are not yet confirmed), or uninstall the plugin.

## Confirmed in a real install

The owner's install test (O2) ran this build on 2026-11-15 in a real Claude Code 2.1.325 session on macOS. It confirmed:

- Claude Code fills in `${CLAUDE_PLUGIN_DATA}` in a command file, so the commands read the same data folder the hooks write to (confirmed 2026-11-15, O2).
- Claude Code shows the one-line suggestion that the hook sends in `systemMessage` when a turn that searched finishes, labeled "Stop says:", and Claude does not reply to it (confirmed 2026-11-15, O2). In print mode (`claude -p`) no line was printed, and the hooks still recorded the turn.
- Uninstalling the plugin and removing its marketplace deletes the plugin's data folder. A session that was already open keeps running the hooks until it is restarted (see "Install, update and uninstall").

The owner's sign-in and upload test (O3) ran on 2026-11-19 and 2026-11-20 against the production backend, on macOS in auto mode. It confirmed:

- `/sourced:signin` signs in with Google through the first loopback port, 53682, and the sign-in file is readable only by you (confirmed 2026-11-19, O3).
- `/sourced:analyze --last` shows the whole prompt and answer, and `/sourced:upload <code>` typed by you saves exactly one row to your account. The row is labeled Claude Code and holds no home folder path, working folder, git branch or page-fetch instructions (confirmed 2026-11-20, O3).
- Uploading the same turn again sends nothing, and a second turn of the same session is saved as its own row (confirmed 2026-11-20, O3).
- When Claude runs the upload command itself, nothing is sent, because you did not type the command. `upload` and `signout` were not among the commands Claude could run on its own (confirmed 2026-11-20, O3).
- `/sourced:signout` deletes the sign-in file, and `/sourced:analyze` then says to sign in first (confirmed 2026-11-20, O3).
- The connector lists the saved turns as Claude Code chats only, and counts their inferred links apart from captured citations (confirmed 2026-11-20, O3).

## Not yet confirmed

These parts of the plugin are built and tested by automated tests, but have not yet been checked in a real install:

- What Claude does when you ask it in plain words to upload a turn. In O2 it declined and did not try, and O3 did not ask.
- The message `/sourced:upload` prints when you type it while signed out, and whether the same code works after you sign in again. O3 saw only `/sourced:analyze`'s "Sign in first" line.
- How the web app shows Claude Code turns.
- How the bundled connector behaves when a session starts, whether Claude Code connects to it before you sign in to it, whether it shows in `/mcp` on a computer that has no other server at the same address, and the exact steps to disable it. O2 could not see it, because the test computer already had its own server at that address.
- What Claude Code's permission prompts look like for the plugin in the default permission mode. Both real runs used auto mode, where no prompt appeared.
- Whether the hooks stop in a new session after you uninstall the plugin.
- How a prompt that holds editor context from an IDE is handled in a real session. The owner's checks skipped it, because the owner does not use Claude Code in an IDE.
- Windows.

## Requirements

- Node 20 or newer, on the path that Claude Code uses to run commands.
- The plugin has been tested on macOS only.

## Install, update and uninstall

In Claude Code, add the marketplace and install the plugin:

```
/plugin marketplace add getsourced-ai/claude-code
/plugin install sourced@sourced
```

The plugin's public repository is [getsourced-ai/claude-code](https://github.com/getsourced-ai/claude-code). To install from a copy on your computer instead, give `/plugin marketplace add` the path of the folder that holds `.claude-plugin/marketplace.json`.

After installing, start a new Claude Code session so the hooks load, and run `/sourced:doctor`. It prints the plugin version, the Node version and the data folder, and it makes no network call. Then ask Claude something that makes it search the web, and run `/sourced:list`: the turn should be listed.

To update, refresh the marketplace and then update the plugin from the `/plugin` menu:

```
/plugin marketplace update sourced
```

To uninstall:

```
/plugin uninstall sourced@sourced
```

Uninstalling deletes the plugin's data folder, with the queue, the waiting uploads and the sign-in file. In the real install of 2026-11-15 the folder was gone right after the plugin was uninstalled and its marketplace removed; which of the two steps deleted it was not separated. A Claude Code session that was already open when you uninstalled keeps recording, keeps showing the one-line suggestion and creates the data folder again until it is restarted, so after uninstalling, restart every Claude Code session you have open. If a data folder is still there afterwards, delete it by hand, for example with `rm -rf ~/.claude/plugins/data/sourced-sourced`, or `rm -rf ~/.claude/sourced-data` if that is the one `/sourced:doctor` named.

## Limits

- The links in an answer are inferred. Claude Code does not record which result supported which sentence, so the plugin takes the links the answer wrote out and matches them to the results.
- Claude Code's web search returns only a title and an address for each result. The plugin has no snippets and no publication dates.
- When it lists or shows a turn, the plugin also reads the transcripts of that turn's subagents, so a search a subagent ran is shown with the turn.
- A prompt the plugin cannot read exactly cannot be uploaded. This covers a turn whose prompt has no typed text, such as an image alone, and a prompt with editor context or shell-mode output mixed into the typed text. Editor context and shell-mode blocks are never sent as the prompt.
- A message you type or queue while Claude is still working on a turn makes both that turn and the new one impossible to upload, because the answer that follows may answer either prompt. `list` marks such turns "can't be read". The same holds for two turns of one session that share a turn id.
- A turn that started a subagent in the background can't be uploaded, because Claude answered before the subagent searched. The turn Claude runs when that subagent reports back can't be uploaded either, because you didn't type its prompt. A subagent that works while the turn waits, such as the one that fetches pages, is fine.
- Claude Code's transcript format is internal and can change. `/sourced:doctor` reports when the format it finds differs from the one the plugin was built for.
