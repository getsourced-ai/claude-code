// The local queue the hooks write: one small JSON file per web call, plus one
// per finished search turn. Imports only node:fs, node:path and plugin/lib
// files (paths.mjs, ids.mjs and nudge.mjs, which add node:os and
// node:crypto), so the hook never loads a network module.
//
// Layout, under the plugin data folder:
//   queue/<session_id>/<tool_use_id>.json    kind 'search' or 'fetch'
//   queue/<session_id>/stop-<prompt_id>.json kind 'stop', only after a search
//   queue/.last-sweep                        time of the last 30-day sweep,
//                                            then its resume folder, if any
//
// The payload shape was seen in a real session (O1, 2026-11-15, Claude Code
// 2.1.325; tests/fixtures/claude-code/hooks-real): PostToolUse carries
// session_id, prompt_id, tool_use_id, tool_name, tool_input, tool_response,
// duration_ms, transcript_path, cwd, scratchpad_dir, effort, permission_mode
// and hook_event_name, plus agent_id and agent_type when a subagent made the
// call (the web-fetch agent that runs WebFetch for the main thread, or any
// other subagent). Such a call carries the prompt_id of the human prompt that
// launched it, even after that turn's Stop, and its tool_use_id is only in the
// subagent's own transcript; the queue joins it to the turn by prompt_id.
// Stop carries last_assistant_message, which equalled the transcript's answer
// in every O1 search turn. It is still read defensively. Never written: cwd,
// transcript_path, scratchpad_dir, agent ids, the WebFetch prompt and result
// text, the search summary.
import { readdirSync, readFileSync, statSync, rmSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { queueDir, dataDir, writePrivateFile, writeDataFile } from './paths.mjs';
import { isSessionId, isPromptId, isToolUseId } from './ids.mjs';
import { nudgeMessage, nudgeEnabled, isPrintMode } from './nudge.mjs';

export const RECORD_VERSION = 1;
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
export const SWEEP_BUDGET_MS = 50;
export const SWEEP_MARKER = '.last-sweep';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.slice() : null);

// 'PostToolUse', 'Stop' or null. hook_event_name decides when present (it was
// present on every O1 payload); otherwise tool_name means PostToolUse, and
// last_assistant_message means Stop unless the payload names a subagent.
// SubagentStop (seen in O1) carries last_assistant_message too, with agent_id,
// agent_type and agent_transcript_path; one with an empty agent_type fires
// about 3 seconds after most Stops with the same prompt_id. It is never a
// Stop here, and hooks.json does not register SubagentStop at all.
export function eventOf(payload) {
  if (!isObject(payload)) return null;
  const name = payload.hook_event_name;
  if (typeof name === 'string') return name === 'PostToolUse' || name === 'Stop' ? name : null;
  if (typeof payload.tool_name === 'string') return 'PostToolUse';
  if ('agent_transcript_path' in payload || 'agent_type' in payload || 'agent_id' in payload) return null;
  if ('last_assistant_message' in payload) return 'Stop';
  return null;
}

function common(payload, now) {
  return {
    v: RECORD_VERSION,
    session_id: payload.session_id,
    prompt_id: isPromptId(payload.prompt_id) ? payload.prompt_id : null,
    tool_use_id: payload.tool_use_id,
    at: new Date(now).toISOString()
  };
}

// results: one array of {title, url} per inner search, in returned order. The
// trailing summary string (and anything else that is not a result block) is
// dropped.
export function searchRecord(payload, now) {
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  const res = payload.tool_response;
  const ok = isObject(res) && Array.isArray(res.results);
  const results = [];
  if (ok) {
    for (const block of res.results) {
      if (!isObject(block) || !Array.isArray(block.content)) continue;
      const links = [];
      for (const item of block.content) {
        if (!isObject(item) || typeof item.url !== 'string') continue;
        links.push({ title: typeof item.title === 'string' ? item.title : '', url: item.url });
      }
      results.push(links);
    }
  }
  return {
    kind: 'search',
    ...common(payload, now),
    query: str(input.query) ?? (ok ? str(res.query) : null),
    mode: str(input.mode),
    allowed_domains: strList(input.allowed_domains),
    blocked_domains: strList(input.blocked_domains),
    results,
    search_count: ok ? num(res.searchCount) : null,
    duration_s: ok ? num(res.durationSeconds) : null,
    error: !ok
  };
}

export function fetchRecord(payload, now) {
  const input = isObject(payload.tool_input) ? payload.tool_input : {};
  const res = isObject(payload.tool_response) ? payload.tool_response : null;
  const status = res ? num(res.code) : null;
  return {
    kind: 'fetch',
    ...common(payload, now),
    url: str(input.url),
    final_url: res ? str(res.url) : null,
    status,
    bytes: res ? num(res.bytes) : null,
    duration_ms: res ? num(res.durationMs) : null,
    error: status === null || status >= 400
  };
}

// A sweep can remove an empty session folder between this write's mkdir and
// its temp-file write, which fails with ENOENT; one retry re-creates the
// folder. `write` is writePrivateFile, or a test's stand-in; `root` is the
// data folder, so every folder from it down ends 0700 (see paths.mjs).
function writeRecord(file, record, write = writePrivateFile, root) {
  // Key order: v and kind first, as documented.
  const { v, kind, ...rest } = record;
  const text = JSON.stringify({ v, kind, ...rest }) + '\n';
  try {
    write(file, text, { root });
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
    write(file, text, { root });
  }
}

// The search records the session folder holds for this prompt id, main
// thread and subagents alike: how many, and how many returned at least one
// result without an error (a search under S1).
function turnSearches(dir, promptId) {
  const out = { searches: 0, withResults: 0 };
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('stop-')) continue;
    try {
      const rec = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (!isObject(rec) || rec.kind !== 'search' || rec.prompt_id !== promptId) continue;
      out.searches += 1;
      if (rec.error !== true && Array.isArray(rec.results) && rec.results.some((r) => Array.isArray(r) && r.length > 0)) out.withResults += 1;
    } catch {
      // A file another hook is still renaming, or a damaged one: skip it.
    }
  }
  return out;
}

// A payload a subagent sent: it names an agent, even with an empty type.
const fromSubagent = (payload) => 'agent_id' in payload || 'agent_type' in payload || 'agent_transcript_path' in payload;

// The marker is "<last start ms>" or "<last start ms> <folder name>", where the
// folder is the one the last sweep ran out of budget on. Older versions wrote
// the number alone, which reads as "no resume point".
function readMarker(marker) {
  try {
    const [time, resume] = readFileSync(marker, 'utf8').trim().split(/\s+/);
    return { last: Number(time), resume: resume || null };
  } catch {
    return { last: NaN, resume: null };
  }
}

// Removes queue files older than 30 days, and session folders left empty. It
// runs at most once a day (the marker holds the last start time) and stops
// after SWEEP_BUDGET_MS of work; the next day's sweep starts at the folder
// where this one stopped, so every folder is reached in turn. The first folder
// of a sweep is always finished, so each sweep makes progress.
export function sweepQueue(env = {}, now = Date.now(), { budgetMs = SWEEP_BUDGET_MS } = {}) {
  const base = queueDir(env);
  if (!existsSync(base)) return false;
  const marker = join(base, SWEEP_MARKER);
  const { last, resume } = readMarker(marker);
  if (Number.isFinite(last) && last <= now && now - last < SWEEP_EVERY_MS) return false;
  writeDataFile(env, marker, resume ? `${now} ${resume}` : String(now));
  const started = performance.now();
  let first = true;
  const over = () => !first && performance.now() - started > budgetMs;
  const dirs = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  let at = resume ? dirs.findIndex((name) => name >= resume) : 0;
  if (at < 0) at = 0;
  const order = dirs.slice(at).concat(dirs.slice(0, at));
  let stoppedAt = null;
  for (const name of order) {
    if (over()) {
      stoppedAt = name;
      break;
    }
    const dir = join(base, name);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    let left = names.length;
    let cut = false;
    for (const file of names.map((n) => join(dir, n))) {
      if (over()) {
        cut = true;
        break;
      }
      try {
        if (now - statSync(file).mtimeMs > MAX_AGE_MS) {
          rmSync(file, { force: true });
          left--;
        }
      } catch {
        // Gone already, or unreadable: leave it.
      }
    }
    if (left === 0) {
      try {
        rmdirSync(dir);
      } catch {
        // A hook wrote into it meanwhile.
      }
    }
    first = false;
    if (cut) {
      stoppedAt = name;
      break;
    }
  }
  if (stoppedAt !== null || resume) {
    try {
      writeDataFile(env, marker, stoppedAt !== null ? `${now} ${stoppedAt}` : String(now));
    } catch {
      // The start time is already written; only the resume point is lost.
    }
  }
  return true;
}

// Handles one hook payload. Returns the file written, or null. Throws only on
// a write failure; the hook entry swallows that.
// `writeFile` replaces writePrivateFile for the record (tests only).
export function recordHookEvent(payload, opts = {}) {
  return handleHookEvent(payload, opts).written;
}

// As recordHookEvent, and also says whether the Stop hook shows the nudge:
// -> { written: file or null, nudge: the line to show, or null }.
// The nudge shows only for a Stop from the main thread, never in print mode
// or while Claude Code is already continuing for a Stop hook
// (stop_hook_active), only when the turn's own queue files hold a search with
// a result, only the first time this turn's stop file is written (so at most
// once per turn), and only while the setting is on. It reads nothing but the
// turn's queue files, which the Stop path already reads, and settings.json.
export function handleHookEvent(payload, { env = {}, now = Date.now(), writeFile = writePrivateFile } = {}) {
  const none = { written: null, nudge: null };
  const event = eventOf(payload);
  if (!event) return none;
  const dir = queueDir(env, payload.session_id);

  if (event === 'PostToolUse') {
    if (!dir || !isToolUseId(payload.tool_use_id)) return none;
    let record;
    if (payload.tool_name === 'WebSearch') record = searchRecord(payload, now);
    else if (payload.tool_name === 'WebFetch') record = fetchRecord(payload, now);
    else return none;
    const file = join(dir, `${payload.tool_use_id}.json`);
    writeRecord(file, record, writeFile, dataDir(env));
    return { written: file, nudge: null };
  }

  // Stop
  let written = null;
  let nudge = null;
  const counts = dir && isPromptId(payload.prompt_id) ? turnSearches(dir, payload.prompt_id) : { searches: 0, withResults: 0 };
  if (counts.searches > 0) {
    written = join(dir, `stop-${payload.prompt_id}.json`);
    const firstStop = !existsSync(written);
    writeRecord(written, {
      v: RECORD_VERSION,
      kind: 'stop',
      session_id: payload.session_id,
      prompt_id: payload.prompt_id,
      at: new Date(now).toISOString(),
      answer: str(payload.last_assistant_message)
    }, writeFile, dataDir(env));
    if (
      firstStop &&
      counts.withResults > 0 &&
      !fromSubagent(payload) &&
      payload.stop_hook_active !== true &&
      !isPrintMode(env) &&
      nudgeEnabled(env)
    ) {
      nudge = nudgeMessage({ searches: counts.searches });
    }
  }
  try {
    sweepQueue(env, now);
  } catch {
    // The sweep is housekeeping; it never fails the hook.
  }
  return { written, nudge };
}
