# Changelog

All notable changes to the Sourced plugin for Claude Code are recorded here. The plugin has its own version, separate from the Sourced Chrome extension.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and the plugin uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

The first version. Its release date is set on the release day.

### Added
- Two hooks record each WebSearch and WebFetch call, and the end of each turn that searched, to a local queue in the plugin's data folder. They make no network call. Searches and page fetches made by a subagent are filed under the prompt you typed.
- `/sourced:list` lists recent turns in the current project that searched the web. `--since` changes the time window, and `--all` lists turns from every project with one line of warning.
- `/sourced:analyze` shows one turn with its exact upload preview: the prompt and the answer in full, the searches, every page with its tags, and the other values the upload holds. It ends with a six-character code that works for 15 minutes, and it sends nothing. `--last` opens the newest search turn. A result title that is really page text, such as "# Web search", shows as the page's host.
- `/sourced:upload <code>` uploads that one turn to your account. It sends nothing unless the session transcript shows you typed the command with that code, and unless the rebuilt upload matches the preview exactly. `/sourced:cancel` drops a waiting code.
- `/sourced:signin` signs in with Google through the browser, and `/sourced:signout` deletes the sign-in file.
- `/sourced:doctor` reports the data folder, the queue, the sign-in state and whether Claude Code's transcript format matches the one the plugin was built for. It repairs a data folder that other users can read.
- After a turn that searched, one quiet line under the answer suggests `analyze`. `/sourced:nudge off` turns it off.
- A bundled, read-only connector lets Claude read the turns saved to your account.
