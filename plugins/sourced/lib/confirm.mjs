// Did the person type the upload command? (plan Task 13, owner gate G1 option
// A, answered 2026-11-15: the user types /sourced:upload <code>
// themselves.)
//
// Seen in a real session (O1 step 6, 2026-11-15, Claude Code 2.1.325;
// tests/fixtures/claude-code/confirm-*.jsonl are built from it): a command
// the person types is written as a user record with origin.kind 'human' and
// no isMeta, whose text is <command-message>plugin:cmd</command-message>
// <command-name>/plugin:cmd</command-name><command-args>ARGS</command-args>,
// followed by an isMeta record with the expanded command text. When Claude
// runs the same command on its own (the Skill tool), there is no such human
// record: there is an assistant tool_use for Skill ({ skill, args }), its
// tool_result, an isMeta "(Re-invocation of /plugin:cmd ...)" note and the
// same expanded text. The expanded text alone does not say who ran it.
//
// Rule: the upload is confirmed only when the session transcript holds a
// human-origin record (origin.kind 'human', not isMeta, not isSidechain)
// whose <command-name> is /sourced:upload and whose <command-args>
// is exactly the code (in any case: the CLI reads the code in capitals),
// written no earlier than the code was issued (less
// CLOCK_SKEW_MS), and that record is the last human input in the
// transcript since then (a later typed prompt or queued human message means
// the command now running is not the one the person typed). A Skill call for
// the upload command whose args hold this code, and no such typed record, is
// 'model'. (The re-invocation note does not hold the code, so it is not used.)
//
// Which transcript. Claude Code sets CLAUDE_CODE_SESSION_ID in the hook
// environment (O1 step 1). Whether the Bash tool's environment, where the
// upload command runs, also has it was not observed. When it is set to a
// UUID, only that session's transcript is read, and a session with no
// transcript file gives 'no-transcript'. When it is not set, the transcripts
// under the projects root written to since the code was issued are read
// (only those whose text holds the code), and any one of them holding the
// typed record confirms: the code is random, so finding it typed in a
// transcript is evidence the person typed it, not a guess at the session.
// No transcript written since then gives 'no-transcript'.
//
// Write timing. The human record was written before Claude's reply in every
// O1 turn, and the upload command file has Claude run the CLI only in that
// reply, so the record should be on disk when the check runs. That ordering
// is observed, not documented, so upload.mjs retries a 'none' or
// 'no-transcript' result a few times over about a second before it refuses.
//
// Read only: it never writes and imports no network module.
//
// Exports:
//   UPLOAD_COMMAND             'sourced:upload'
//   CLOCK_SKEW_MS
//   uploadCommandState(records, { code, since })  -> 'typed' | 'model' | 'none'
//   confirmTyped({ code, since, env, root })      -> { state, source }
//       state: 'typed' | 'model' | 'none' | 'no-transcript'
//       source: 'session' (CLAUDE_CODE_SESSION_ID named it) | 'recent'
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonl, findTranscript } from './jsonl.mjs';
import { isSessionId, isConfirmCode } from './ids.mjs';
import { projectsRoot } from './paths.mjs';

export const UPLOAD_COMMAND = 'sourced:upload';
export const CLOCK_SKEW_MS = 60 * 1000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const COMMAND_NAME = new RegExp(`<command-name>\\s*/?${UPLOAD_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</command-name>`);
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/;

function textOf(r) {
  const c = r.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

const isHumanRecord = (r) => r.type === 'user' && r.isMeta !== true && r.isSidechain !== true && isObject(r.origin) && r.origin.kind === 'human';
// A message the person sent mid-turn (O1 step 10).
const isHumanQueued = (r) => r.type === 'attachment' && isObject(r.attachment) && r.attachment.type === 'queued_command' && isObject(r.attachment.origin) && r.attachment.origin.kind === 'human';

function isTypedUpload(r, code) {
  if (!isHumanRecord(r)) return false;
  const t = textOf(r);
  if (!COMMAND_NAME.test(t)) return false;
  const args = COMMAND_ARGS.exec(t);
  return Boolean(args) && args[1].trim().toUpperCase() === code;
}

function isModelUpload(r, code) {
  if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) return false;
  return r.message.content.some(
    (b) => b?.type === 'tool_use' && b.name === 'Skill' && isObject(b.input) && typeof b.input.skill === 'string' && b.input.skill.replace(/^\//, '') === UPLOAD_COMMAND && String(b.input.args ?? '').toUpperCase().includes(code)
  );
}

export function uploadCommandState(records, { code, since }) {
  if (!Array.isArray(records) || !isConfirmCode(code)) return 'none';
  const from = Number.isFinite(since) ? since - CLOCK_SKEW_MS : -Infinity;
  let lastHuman = null;
  let model = false;
  for (const r of records) {
    if (!isObject(r)) continue;
    const t = Date.parse(r.timestamp);
    if (!Number.isFinite(t) || t < from) continue;
    if (isHumanRecord(r) || isHumanQueued(r)) lastHuman = r;
    if (isModelUpload(r, code)) model = true;
  }
  if (lastHuman && isTypedUpload(lastHuman, code)) return 'typed';
  return model ? 'model' : 'none';
}

function stateOfFile(file, code, since) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (!text.toUpperCase().includes(code)) return 'none';
  return uploadCommandState(parseJsonl(text).records, { code, since });
}

// Transcripts under root written to at or after `from` (stat only).
function recentTranscripts(root, from) {
  const out = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let names;
    try {
      names = readdirSync(join(root, p.name));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!SESSION_FILE.test(n)) continue;
      const file = join(root, p.name, n);
      try {
        if (statSync(file).mtimeMs >= from) out.push(file);
      } catch {
        // Gone since the listing.
      }
    }
  }
  return out.sort();
}

export function confirmTyped({ code, since, env = process.env, root } = {}) {
  const projects = root ?? projectsRoot(env);
  const sid = env?.CLAUDE_CODE_SESSION_ID;
  if (isSessionId(sid)) {
    const file = findTranscript(sid, projects);
    const state = file ? stateOfFile(file, code, since) : null;
    return { state: state ?? 'no-transcript', source: 'session' };
  }
  const from = Number.isFinite(since) ? since - CLOCK_SKEW_MS : -Infinity;
  const files = recentTranscripts(projects, from);
  if (!files.length) return { state: 'no-transcript', source: 'recent' };
  let model = false;
  for (const f of files) {
    const s = stateOfFile(f, code, since);
    if (s === 'typed') return { state: 'typed', source: 'recent' };
    if (s === 'model') model = true;
  }
  return { state: model ? 'model' : 'none', source: 'recent' };
}
