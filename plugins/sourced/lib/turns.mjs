// Joins the hook queue to the transcript, and lists recent search turns.
// Imports only node:fs, node:path and plugin/lib files: no network module and
// no child process. The only file it writes is <dataDir>/index.json.
//
// Exports:
//   turnKeyOf(turn)          prompt_id, else prompt_uuid (G2), else null
//   compareTurns(t, q)       -> { equal, counts } for a transcript turn t and
//                               a queue turn q (the mismatch rule below)
//   resolveTurn({ sessionId, turnKey, env, root })
//       -> { status: 'ok' | 'mismatch' | 'no-prompt' | 'not-found', turn,
//            source: 'transcript' | 'hooks' | null, join, meta, mismatch? }
//   listTurns({ since, limit, env, root, now, all, project })
//       -> { turns: [{ session_id, turn_key, time, prompt_preview, counts,
//            finished, unreadable? (true when it applies), source }], stats }
//   newestWebOnlyTurn({ env, root, project, after, since, anyTime, now })
//       -> { session_id, turn_key, time } | null: the newest turn in the queue
//          that fetched pages and ran no search, when it is newer than `after`
//          (ms) and inside the window; used by analyze --last
//   markDuplicateKeys(turns)  marks every turn whose key another turn of the
//                             same session also holds (duplicate_key: true)
//   previewOf(text, { injected })  80-character preview, or INJECTED_PREVIEW
//   INDEX_VERSION, INJECTED_PREVIEW
//
// resolveTurn, following plan Task 10:
//   1. The transcript is read with the reader. When it holds the turn (by
//      prompt_id or prompt record uuid), that turn is used: it has the prompt
//      and the subagent searches. With no queue turn to compare: 'ok'.
//   2. When the queue also holds the turn, the two are compared. A difference
//      gives 'mismatch' with counts only and turn null: the turn is
//      unreadable and is never offered for upload (S2, U8).
//   3. When the transcript is missing or does not hold the turn, a queue turn
//      gives 'no-prompt' (turn = the queue turn, for the local view; it cannot
//      upload, because U11 needs the exact prompt). Nothing gives 'not-found'.
//   A turn whose key is held by another turn of the session too is returned
//   with duplicate_key: true, so turnToDetail makes it unreadable.
//   `join` says how the queue turn was found: 'prompt_id' or 'tool_use_id'
//   (null when there is no queue turn or no transcript turn).
//
// The join key was confirmed in a real session (O1 step 4, 2026-11-15): the
// hook's prompt_id equals the transcript's promptId for the same turn. Calls
// made by a subagent (the web-fetch agent, or a background agent) carry the
// prompt_id of the human prompt that launched it, and their tool_use_id is
// only in the subagent's own file, so prompt_id is the join that finds them.
// The queue turn is first the group whose prompt_id equals the transcript
// turn's prompt_id. When no queue record has that prompt_id, the join falls
// back to tool_use_id: every queue search or fetch whose tool_use_id is one of
// the transcript turn's (main thread or subagent), plus every record that
// shares a (non-null) prompt_id with one of those, so a queue search the
// transcript lacks in the same hook turn is still compared.
//
// Mismatch rule (main-thread searches only; whether the queue holds subagent
// searches is unconfirmed, so a queue search whose tool_use_id is a joined
// subagent search's is left out of the comparison). Each queue search must
// match a transcript main-thread search by tool_use_id, with the same query
// string, the same status (a queue 'error' matches only a transcript search
// that is not 'ok'; a queue 'ok' only an 'ok' one) and the same result URLs in
// the same order within that search. The
// order of the searches themselves is not compared: searches issued in one
// parallel batch finish (and so reach the queue) in any order. A queue
// holding fewer searches than the transcript (a hook did not fire) is not a
// mismatch. The answer is compared too: when the queue holds a Stop answer
// (last_assistant_message, which equalled the transcript answer in every O1
// search turn), the transcript answer must end with it, trimmed; otherwise
// counts.answer_differs is 1 and the turns differ. The transcript answer may
// be longer, because the reader joins every answer text after the last tool
// call and the hook gives only the last message. counts: { transcript_searches,
// queue_searches, matched, different, queue_only, answer_differs }.
//
// listTurns reads the queue folders first, then the transcripts under root
// changed since `since` (default: 7 days before `now`; all: true scans
// every time). `project`, a folder name under root, keeps the list to that
// project: only its transcripts are read, and a queue session is listed only
// when its transcript is in that folder (a session with no transcript has no
// known project, so it is left out). With no `project` every project is
// listed. The CLI passes the current project by default (O2, 2026-11-15:
// the list showed the start of prompts from every project, and Claude
// repeats a command's output, so other projects' prompts entered the
// session); `--all` lists every project. A transcript is parsed only when the string "WebSearch" is in
// the main file or in one of the agent-*.jsonl files in its subagents/ folder
// (a turn whose only searches ran in a subagent); the subagent files are read
// one at a time and only until one holds the string. The index
// (<dataDir>/index.json) holds per transcript path { session_id, size,
// mtime_ms, subagents?: [[name, size, mtime_ms]], turns: [{ key, started_at,
// finished, unreadable?, counts, tool_use_ids, prompt_at: [offset, length] }] } for its
// search turns. An entry is fresh only when the main file and every subagent
// file (name, size and mtime) are unchanged; subagents is left out when the
// folder holds no agent file. It never holds prompt text: the 80-character preview is read at list time from the prompt record's
// byte range in the transcript, so an unchanged transcript is never read in
// full or parsed again. Session folders and transcript names that are not
// UUIDs are skipped. A session id held by more than one project folder is
// ambiguous: it is skipped (transcripts and queue turns alike) and counted in
// stats.ambiguous_sessions. A turn whose prompt holds editor context
// (prompt_injected) is listed with the fixed preview INJECTED_PREVIEW.
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir, projectsRoot, writeDataFile, queueDir } from './paths.mjs';
import { isSessionId, isPromptId } from './ids.mjs';
import { findTranscript, readSubagents, AGENT_FILE } from './jsonl.mjs';
import { readSession, readRecords, attachSubagents, turnIsSearch, turnIsFinished, promptFromRecord } from './reader.mjs';
import { readQueue, turnFromRecords, turnsFromQueue } from './queue-read.mjs';

// 2: turn entries carry unreadable: true when it applies.
// 3: reader version 3 (hand-backs, task notices and background subagents make
//    a turn unreadable), so entries written by version 2 are read again.
export const INDEX_VERSION = 3;
export const DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_LIMIT = 20;
export const PREVIEW_CHARS = 80;
export const INJECTED_PREVIEW = '(prompt holds editor context)';

const MAX_PROMPT_LINE = 4 * 1024 * 1024;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function turnKeyOf(turn) {
  const k = turn?.prompt_id ?? turn?.prompt_uuid ?? null;
  return isPromptId(k) ? k : null;
}

// A turn key held by more than one turn of one session (a repeated prompt
// id) can't tell list and analyze which turn is meant: every turn holding it
// gets duplicate_key: true, and turnToDetail makes it unreadable
// ('duplicate-key'). Both a turn's prompt id and its prompt record uuid
// count, because resolveTurn finds a turn by either. Mutates and returns
// `turns`.
export function markDuplicateKeys(turns) {
  const holders = new Map();
  for (const t of turns) {
    for (const k of new Set([t.prompt_id, t.prompt_uuid, turnKeyOf(t)].filter((x) => typeof x === 'string' && x))) {
      if (!holders.has(k)) holders.set(k, new Set());
      holders.get(k).add(t);
    }
  }
  for (const set of holders.values()) if (set.size > 1) for (const t of set) t.duplicate_key = true;
  return turns;
}

// What list can tell from the reader alone, without the capture checks in
// turn.mjs: a turn the reader marked as mixed or as holding repeated records,
// holding a repeated key, with editor context in its prompt, with damaged or
// skipped records, a web call with no result, or an unreadable search. analyze makes the full check.
function knownUnreadable(t) {
  return (
    t.duplicate_key === true ||
    t.continues_previous === true ||
    t.cut_off === true ||
    t.queued_message === true ||
    t.duplicate_records === true ||
    t.prompt_injected === true ||
    typeof t.prompt_origin === 'string' ||
    t.subagents.some((a) => a.background === true) ||
    t.skipped > 0 ||
    t.missing_results > 0 ||
    allSearches(t).some((s) => s.status === 'unreadable')
  );
}

const allSearches = (t) => [...t.searches, ...t.subagents.flatMap((a) => a.searches)];
const allFetches = (t) => [...t.fetches, ...t.subagents.flatMap((a) => a.fetches)];
const toolIdsOf = (t) => [...allSearches(t), ...allFetches(t)].map((x) => x.tool_use_id).filter(Boolean);

function countsOf(t) {
  const s = allSearches(t);
  return { searches: s.length, results: s.reduce((n, x) => n + x.results.length, 0), fetches: allFetches(t).length };
}

function sameUrls(a, b) {
  return a.length === b.length && a.every((r, i) => r.url === b[i].url);
}

export function compareTurns(t, q) {
  const subIds = new Set(t.subagents.flatMap((a) => a.searches.map((s) => s.tool_use_id)));
  const pos = new Map(t.searches.map((s, i) => [s.tool_use_id, i]));
  const counts = { transcript_searches: t.searches.length, queue_searches: 0, matched: 0, different: 0, queue_only: 0 };
  for (const qs of q.searches) {
    if (subIds.has(qs.tool_use_id) && !pos.has(qs.tool_use_id)) continue;
    counts.queue_searches += 1;
    const i = pos.get(qs.tool_use_id);
    if (i === undefined) {
      counts.queue_only += 1;
      continue;
    }
    const ts = t.searches[i];
    const sameStatus = qs.status === 'ok' ? ts.status === 'ok' : ts.status !== 'ok';
    if (ts.query !== qs.query || !sameStatus || !sameUrls(ts.results, qs.results)) {
      counts.different += 1;
      continue;
    }
    counts.matched += 1;
  }
  const qa = typeof q.answer_markdown === 'string' ? q.answer_markdown.trim() : '';
  const ta = typeof t.answer_markdown === 'string' ? t.answer_markdown.trim() : '';
  counts.answer_differs = qa !== '' && !ta.endsWith(qa) ? 1 : 0;
  const equal = counts.different === 0 && counts.queue_only === 0 && counts.answer_differs === 0;
  return { equal, counts };
}

function readTranscript(sessionId, root) {
  const path = findTranscript(sessionId, root);
  if (!path) return null;
  const read = readSession(path);
  if (read.unsupported) return { ...read, turns: [] };
  markDuplicateKeys(read.turns);
  return read;
}

// The queue records for transcript turn t: by prompt_id first, else by
// tool_use_id (see the header).
function queueRecordsFor(t, records) {
  if (t.prompt_id) {
    const same = records.filter((r) => r.prompt_id === t.prompt_id);
    if (same.length) return { join: 'prompt_id', records: same };
  }
  const ids = new Set(toolIdsOf(t));
  const hit = records.filter((r) => r.kind !== 'stop' && ids.has(r.tool_use_id));
  if (!hit.length) return { join: null, records: [] };
  const pids = new Set(hit.map((r) => r.prompt_id).filter((p) => p !== null));
  const out = records.filter((r) => hit.includes(r) || (r.prompt_id !== null && pids.has(r.prompt_id)));
  return { join: 'tool_use_id', records: out };
}

export function resolveTurn({ sessionId, turnKey, env = process.env, root } = {}) {
  const none = { status: 'not-found', turn: null, source: null, join: null, meta: null };
  if (!isSessionId(sessionId) || !isPromptId(turnKey)) return none;
  const projects = root ?? projectsRoot(env);
  const read = readTranscript(sessionId, projects);
  const t = read?.turns.find((x) => x.prompt_id === turnKey || x.prompt_uuid === turnKey) ?? null;
  const queue = readQueue(sessionId, { env });

  if (t) {
    const { join: how, records } = queueRecordsFor(t, queue.records);
    const q = records.length ? turnFromRecords(records) : null;
    if (!q) return { status: 'ok', turn: t, source: 'transcript', join: null, meta: read.meta };
    const { equal, counts } = compareTurns(t, q);
    if (!equal) return { status: 'mismatch', turn: null, source: 'transcript', join: how, meta: read.meta, mismatch: counts };
    return { status: 'ok', turn: t, source: 'transcript', join: how, meta: read.meta };
  }

  const q = turnFromRecords(queue.records.filter((r) => r.prompt_id === turnKey));
  if (q) {
    const meta = { session_id: sessionId, format: 'hooks', skipped: queue.skipped, transcript: read ? 'without-turn' : 'missing' };
    return { status: 'no-prompt', turn: q, source: 'hooks', join: null, meta };
  }
  return none;
}

// ---- listTurns -------------------------------------------------------------

function loadIndex(file) {
  try {
    const idx = JSON.parse(readFileSync(file, 'utf8'));
    if (isObject(idx) && idx.v === INDEX_VERSION && isObject(idx.files)) return idx;
  } catch (err) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  return { v: INDEX_VERSION, files: {} };
}

function listDir(dir, opts) {
  try {
    return readdirSync(dir, opts);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
}

// <root>/<project>/<uuid>.jsonl
function transcriptFiles(root) {
  const out = [];
  for (const proj of listDir(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    for (const name of listDir(join(root, proj.name))) {
      if (!name.endsWith('.jsonl')) continue;
      const sid = name.slice(0, -'.jsonl'.length);
      if (isSessionId(sid)) out.push({ path: join(root, proj.name, name), session_id: sid, project: proj.name });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// Parse one transcript buffer: records for the reader, and the byte range of
// each user record by uuid (for the preview).
function parseBuffer(buf) {
  const records = [];
  const ranges = new Map();
  const badAt = [];
  let lineNo = 0;
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    const line = buf.toString('utf8', start, end);
    if (line.trim()) {
      try {
        const r = JSON.parse(line);
        records.push(r);
        if (isObject(r) && r.type === 'user' && typeof r.uuid === 'string') ranges.set(r.uuid, [start, end - start]);
      } catch {
        // tail: the final line, with no newline after it (see reader.mjs).
        badAt.push({ line: lineNo, before: records.length, tail: end === buf.length });
      }
    }
    start = end + 1;
    lineNo += 1;
  }
  return { records, ranges, badLines: badAt.length, badAt };
}

// [[name, size, mtime_ms]] for the agent-*.jsonl files in the transcript's
// subagents/ folder, in name order (stat only: no file is opened).
function subagentStats(path) {
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  const out = [];
  for (const name of listDir(dir).sort()) {
    if (!AGENT_FILE.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) out.push([name, st.size, st.mtimeMs]);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return out;
}

const sameSubagents = (a, b) =>
  a.length === b.length && a.every((x, i) => Array.isArray(x) && x.length === 3 && x.every((v, j) => v === b[i][j]));

// The cheap string test, main file first, then each subagent file until one
// holds the string.
function hasSearchString(buf, path, subs) {
  if (buf.includes('"WebSearch"')) return true;
  const dir = join(path.replace(/\.jsonl$/, ''), 'subagents');
  for (const [name] of subs) {
    try {
      if (readFileSync(join(dir, name)).includes('"WebSearch"')) return true;
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  return false;
}

function indexTranscript(path, subs) {
  const buf = readFileSync(path);
  if (!hasSearchString(buf, path, subs)) return { turns: [], parsed: false };
  const { records, ranges, badLines, badAt } = parseBuffer(buf);
  const read = readRecords(records, { badAt });
  if (read.unsupported) return { turns: [], parsed: true };
  read.meta.bad_lines = badLines;
  attachSubagents(read, readSubagents(path));
  markDuplicateKeys(read.turns);
  const turns = [];
  for (const t of read.turns) {
    const key = turnKeyOf(t);
    if (!key || !turnIsSearch(t)) continue;
    turns.push({
      key,
      started_at: t.started_at,
      finished: turnIsFinished(t),
      ...(knownUnreadable(t) ? { unreadable: true } : {}),
      counts: countsOf(t),
      tool_use_ids: toolIdsOf(t),
      prompt_at: (t.prompt_uuid && ranges.get(t.prompt_uuid)) || null
    });
  }
  return { turns, parsed: true };
}

export function previewOf(text, { injected = false } = {}) {
  if (injected) return INJECTED_PREVIEW;
  if (typeof text !== 'string') return null;
  const flat = text.replace(/[\s\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return Array.from(flat).slice(0, PREVIEW_CHARS).join('');
}

// Reads only the prompt record's bytes.
function readPreview(path, at) {
  if (!Array.isArray(at) || at.length !== 2) return null;
  const [offset, length] = at;
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || length > MAX_PROMPT_LINE) return null;
  let fd;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, offset);
    // The same prompt text the reader keeps: injected blocks dropped, and a
    // fixed placeholder when editor context is mixed into the typed text.
    const p = promptFromRecord(JSON.parse(buf.toString('utf8', 0, n)));
    return p ? previewOf(p.text, { injected: p.injected }) : null;
  } catch (err) {
    if (err?.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const toMs = (v) => (v instanceof Date ? v.getTime() : typeof v === 'string' ? Date.parse(v) : v);

export function listTurns({ since, limit = DEFAULT_LIMIT, env = process.env, root, now = Date.now(), all = false, project } = {}) {
  const projects = root ?? projectsRoot(env);
  const from = all ? -Infinity : since === undefined || since === null ? toMs(now) - DEFAULT_SINCE_MS : toMs(since);
  if (Number.isNaN(from)) throw new TypeError('listTurns: since must be a time');
  const inRange = (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t >= from : all;
  };
  const stats = { queue_sessions: 0, queue_skipped: 0, transcripts: 0, parsed: 0, cached: 0, no_search_string: 0, out_of_range: 0, ambiguous_sessions: 0 };

  // A session id in more than one project folder cannot be told apart.
  const files = transcriptFiles(projects);
  const perSession = new Map();
  for (const f of files) perSession.set(f.session_id, (perSession.get(f.session_id) || 0) + 1);
  const ambiguous = new Set([...perSession].filter(([, n]) => n > 1).map(([sid]) => sid));
  stats.ambiguous_sessions = ambiguous.size;
  const scoped = typeof project === 'string' && project !== '';
  const inProject = (f) => !scoped || f.project === project;
  const projectSessions = new Set(files.filter(inProject).map((f) => f.session_id));

  // 1. Queue folders (cheap).
  const queued = [];
  for (const entry of listDir(queueDir(env), { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSessionId(entry.name) || ambiguous.has(entry.name)) continue;
    if (scoped && !projectSessions.has(entry.name)) continue;
    stats.queue_sessions += 1;
    const { turns, skipped } = turnsFromQueue(entry.name, { env });
    stats.queue_skipped += skipped;
    for (const t of turns) if (turnIsSearch(t)) queued.push({ session_id: entry.name, t });
  }

  // 2. Transcripts changed since `from`, through the index.
  const indexFile = join(dataDir(env), 'index.json');
  const index = loadIndex(indexFile);
  const nextFiles = {};
  let changed = false;
  const listed = [];
  const bySession = new Map();
  for (const f of files) {
    const { path, session_id } = f;
    if (!inProject(f)) {
      // Another project's entry stays in the index as it was.
      if (isObject(index.files[path])) nextFiles[path] = index.files[path];
      continue;
    }
    if (ambiguous.has(session_id)) continue;
    let st;
    try {
      st = statSync(path);
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    stats.transcripts += 1;
    let entry = index.files[path];
    const subs = subagentStats(path);
    const fresh =
      isObject(entry) &&
      entry.size === st.size &&
      entry.mtime_ms === st.mtimeMs &&
      Array.isArray(entry.turns) &&
      sameSubagents(Array.isArray(entry.subagents) ? entry.subagents : [], subs);
    if (fresh) {
      stats.cached += 1;
    } else if (st.mtimeMs < from && subs.every(([, , m]) => m < from)) {
      stats.out_of_range += 1;
      if (isObject(entry)) changed = true; // stale entry dropped
      continue;
    } else {
      const res = indexTranscript(path, subs);
      if (res.parsed) stats.parsed += 1;
      else stats.no_search_string += 1;
      entry = { session_id, size: st.size, mtime_ms: st.mtimeMs, ...(subs.length ? { subagents: subs } : {}), turns: res.turns };
      changed = true;
    }
    nextFiles[path] = entry;
    for (const t of entry.turns) {
      if (!bySession.has(session_id)) bySession.set(session_id, { keys: new Set(), ids: new Set() });
      const s = bySession.get(session_id);
      s.keys.add(t.key);
      for (const id of t.tool_use_ids || []) s.ids.add(id);
      if (!inRange(t.started_at)) continue;
      listed.push({
        session_id,
        turn_key: t.key,
        time: t.started_at,
        counts: t.counts,
        finished: t.finished,
        unreadable: t.unreadable === true,
        source: 'transcript',
        _path: path,
        _prompt_at: t.prompt_at
      });
    }
  }
  if (Object.keys(index.files).some((p) => !(p in nextFiles))) changed = true;
  if (changed) writeDataFile(env, indexFile, JSON.stringify({ v: INDEX_VERSION, files: nextFiles }) + '\n');

  // 3. Queue turns the transcripts do not hold (by prompt_id or tool_use_id).
  for (const { session_id, t } of queued) {
    const key = turnKeyOf(t);
    if (!key || !inRange(t.started_at)) continue;
    const s = bySession.get(session_id);
    if (s && (s.keys.has(key) || toolIdsOf(t).some((id) => s.ids.has(id)))) continue;
    listed.push({ session_id, turn_key: key, time: t.started_at, counts: countsOf(t), finished: turnIsFinished(t), unreadable: false, source: 'hooks' });
  }

  listed.sort(
    (a, b) =>
      (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0) ||
      (a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0) ||
      (a.turn_key < b.turn_key ? -1 : a.turn_key > b.turn_key ? 1 : 0)
  );
  const n = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const turns = listed.slice(0, n).map(({ _path, _prompt_at, ...row }) => ({
    session_id: row.session_id,
    turn_key: row.turn_key,
    time: row.time,
    prompt_preview: _path ? readPreview(_path, _prompt_at) : null,
    counts: row.counts,
    finished: row.finished,
    // Present only when it applies, so ordinary rows keep their shape.
    ...(row.unreadable ? { unreadable: true } : {}),
    source: row.source
  }));
  return { turns, stats };
}


// ---- newestWebOnlyTurn -------------------------------------------------------

// The newest turn whose queue records hold a fetch and no search (a
// WebFetch-only turn, which is not a search under S1), when it started after
// `after`. O2 (2026-11-15): analyze --last skipped such a turn and showed an
// older search turn, with nothing to say so. Its time is its first fetch's.
// The transcript decides in the end: a turn the transcript shows as a search
// (a search the hooks missed) is not returned.
export function newestWebOnlyTurn({ env = process.env, root, project, after, since, anyTime = false, now = Date.now() } = {}) {
  const projects = root ?? projectsRoot(env);
  const files = transcriptFiles(projects);
  const projectOf = new Map();
  const ambiguous = new Set();
  for (const f of files) {
    if (projectOf.has(f.session_id)) ambiguous.add(f.session_id);
    projectOf.set(f.session_id, f.project);
  }
  const from = anyTime ? -Infinity : since === undefined || since === null ? toMs(now) - DEFAULT_SINCE_MS : toMs(since);
  const scoped = typeof project === 'string' && project !== '';
  let best = null;
  for (const entry of listDir(queueDir(env), { withFileTypes: true })) {
    if (!entry.isDirectory() || !isSessionId(entry.name) || ambiguous.has(entry.name)) continue;
    if (scoped && projectOf.get(entry.name) !== project) continue;
    const groups = new Map();
    for (const r of readQueue(entry.name, { env }).records) {
      if (r.prompt_id === null || r.prompt_id === undefined) continue;
      if (!groups.has(r.prompt_id)) groups.set(r.prompt_id, { search: false, first: Infinity });
      const g = groups.get(r.prompt_id);
      if (r.kind === 'search') g.search = true;
      if (r.kind === 'fetch') {
        const t = Date.parse(r.at);
        if (Number.isFinite(t) && t < g.first) g.first = t;
      }
    }
    for (const [key, g] of groups) {
      if (g.search || !Number.isFinite(g.first) || g.first < from) continue;
      if (Number.isFinite(after) && g.first <= after) continue;
      if (!best || g.first > best.time) best = { session_id: entry.name, turn_key: key, time: g.first };
    }
  }
  if (!best) return null;
  const resolved = resolveTurn({ sessionId: best.session_id, turnKey: best.turn_key, env, root: projects });
  if (resolved.status === 'ok' && turnIsSearch(resolved.turn)) return null;
  return { ...best, time: new Date(best.time).toISOString() };
}
