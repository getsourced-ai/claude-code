// The nudge (owner gate G1, answered 2026-11-15): one quiet line after a
// main-thread turn that searched the web, suggesting the analyze command.
// The Stop hook shows it through the documented hook output field
// `systemMessage` ("Warning message shown to the user"). O2 (2026-11-15,
// Claude Code 2.1.325) saw it shown under the answer, labeled "Stop says:",
// with no reply from Claude. The hook never uses `decision:
// "block"` or `additionalContext`, which would make Claude continue.
//
// The only thing this adds to what the hook already reads is the plugin's own
// settings file in its data folder. Imports only plugin/lib/paths.mjs and
// node:fs, so the hook still loads no network module.
//
// Exports:
//   NUDGE_TEXT                       every user-facing string
//   nudgeMessage({ searches })       the line itself
//   nudgeEnabled(env)                true unless settings.json has nudge: false
//   setNudge(env, on)                writes nudge into settings.json (0600)
//   isPrintMode(env)                 true when Claude Code runs without a
//                                    person at the screen (print mode or the
//                                    Agent SDK): CLAUDE_CODE_ENTRYPOINT starts
//                                    with "sdk". O1 saw that variable set in
//                                    both an interactive and a print-mode hook
//                                    but did not record its values. O2 saw
//                                    no line in print mode, without telling
//                                    whether this rule or Claude Code kept it.
import { readFileSync } from 'node:fs';
import { settingsFile, writeDataFile } from './paths.mjs';

export const NUDGE_TEXT = Object.freeze({
  line: 'Sourced: this turn ran {n} {searches}. /sourced:analyze shows what was searched, opened and cited.',
  stateOn: 'The one-line suggestion after a turn that searched the web is on. To turn it off: /sourced:nudge off',
  stateOff: 'The one-line suggestion after a turn that searched the web is off. To turn it on: /sourced:nudge on',
  turnedOn: 'Turned on. After a turn that searched the web, Sourced shows one line suggesting /sourced:analyze.',
  turnedOff: 'Turned off. Sourced no longer shows a line after a turn that searched the web. To turn it on again: /sourced:nudge on',
  badValue: 'nudge takes on or off, or nothing to show the setting.'
});

export function nudgeMessage({ searches }) {
  return NUDGE_TEXT.line.replace('{n}', String(searches)).replace('{searches}', searches === 1 ? 'search' : 'searches');
}

function readSettings(env) {
  try {
    const v = JSON.parse(readFileSync(settingsFile(env), 'utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function nudgeEnabled(env = {}) {
  return readSettings(env).nudge !== false;
}

export function setNudge(env = {}, on) {
  const next = { ...readSettings(env), nudge: on === true };
  writeDataFile(env, settingsFile(env), JSON.stringify(next) + '\n');
  return next.nudge;
}

export function isPrintMode(env = {}) {
  return typeof env.CLAUDE_CODE_ENTRYPOINT === 'string' && /^sdk/i.test(env.CLAUDE_CODE_ENTRYPOINT);
}
