// doctor: a local health and format-drift report. It reads the plugin data
// folder and the current project's newest Claude Code transcript and prints only names, counts,
// type names and a hash: never a value from a record, never a path below the
// data folder or the projects root, never a session id. No network module and
// no child process is imported; nothing here calls fetch.
//
// Exports:
//   transcriptShape(records) -> { recordTypes, WebSearch, WebFetch, hash }
//       recordTypes: sorted record `type` names (same rule, '-' allowed). WebSearch / WebFetch: null when
//       the transcript has no such call, else { input, resultTypes, result }
//       (WebSearch adds resultEntry and resultItem). Each of input, result,
//       resultEntry and resultItem is null (nothing seen) or
//       { keyName: [sorted JSON type names] }, merged over every call.
//       input is the tool_use input; result is the record-level toolUseResult
//       of the record holding the matching tool_result; resultEntry is the
//       first object in result.results; resultItem the first object in its
//       content. hash: sha256 over the canonical JSON of the rest.
//   queueShape(files) -> { kinds: { kind: { keyName: [types] } }, hash }
//   KNOWN_SHAPES, KNOWN_QUEUE_SHAPES: what the committed fixtures pin (a test
//       recomputes them and fails on drift).
//   knownShapesFrom(shapes), knownQueueShapesFrom(shape): how they are computed.
//   compareShape(shape, known?) -> { changed, added, missing, typeChanged }
//       or { changed: false, noWebCalls: true }.
//   compareQueueShape(shape, known?) -> { changed, added, missing, typeChanged }
//   doctorReport({ env, root, now, pluginVersion, dataSource, project })
//       -> { text, report }
//       project: the current project's folder name under the projects root
//       (paths.currentProject), or null. The transcript check reads that
//       project's newest transcript, or the newest in any project when the
//       project is unknown or has none; report.transcript.scope says which.
//       dataSource: what paths.resolveDataDir returned for this run (computed
//       from env when absent). report.dataFolder: { name, writable, source,
//       argumentIgnored, otherQueues }, where otherQueues names (by folder name
//       only) any other Sourced data folder that also holds a queue:
//       the fallback folder when a plugin data folder is in use, or a folder
//       under <config>/plugins/data whose name starts with sourced when
//       the fallback is in use. DATA_DIR_TEXT holds the lines that say why.
//       report.permissions: { loose: [labels], repaired } for the data
//       folder, its queue and pending folders, the queue's session folders
//       and their files: what other users could read, made 0700 or 0600.
//       report.uploaded: { state: 'absent' } | { state: 'readable', count }
//       | { state: 'unreadable', advice } for uploaded.json (UPLOADED_ADVICE).
//       report.queue.sessions: queue session folders; sessionsWithoutTranscript:
//       how many of them have no transcript under the projects root. Seen in a
//       real session (O1, 2026-11-15): a print-mode run with
//       --no-session-persistence fires the hooks, but its transcript file never
//       exists, so its turns can be listed and never uploaded.
//
// Type names: string, number, boolean, null, array, object. Key names longer
// than 40 characters or not matching ^[A-Za-z0-9_]+$ become '<other>', since a
// key in user data could carry content.
import { readdirSync, readFileSync, statSync, lstatSync, chmodSync, openSync, readSync, closeSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseJsonl, findTranscripts } from './jsonl.mjs';
import {
  dataDir,
  projectsRoot,
  queueDir,
  sessionFile,
  uploadedFile,
  ensureDataDir,
  resolveDataDir,
  fallbackDataDir,
  configDir
} from './paths.mjs';
import { readUploaded } from './uploaded.mjs';

export const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_QUEUE_FILES_READ = 200;
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[A-Za-z0-9_]{1,40}$/;
// Record types are hyphenated ('cost-state', 'ai-title'), so '-' is allowed there.
const SAFE_RECORD_TYPE = /^[A-Za-z0-9_-]{1,40}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function safeName(key) {
  return typeof key === 'string' && SAFE_KEY.test(key) ? key : '<other>';
}

export function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'object' ? t : 'null';
}

// Sorted-key JSON, so the hash does not depend on insertion order.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const sha256 = (v) => createHash('sha256').update(canonical(v)).digest('hex');

// Adds obj's key names and value types into the section map (a Map of Sets).
function addKeys(section, obj) {
  for (const [k, v] of Object.entries(obj)) {
    const name = safeName(k);
    if (!section.has(name)) section.set(name, new Set());
    section.get(name).add(typeName(v));
  }
}

function sectionOut(section) {
  if (!section) return null;
  const out = {};
  for (const k of [...section.keys()].sort()) out[k] = [...section.get(k)].sort();
  return out;
}

function toolOut(t, tool) {
  if (!t) return null;
  const out = {
    input: sectionOut(t.input),
    resultTypes: [...t.resultTypes].sort(),
    result: sectionOut(t.result)
  };
  if (tool === 'WebSearch') {
    out.resultEntry = sectionOut(t.resultEntry);
    out.resultItem = sectionOut(t.resultItem);
  }
  return out;
}

const contentOf = (r) => (isObject(r) && isObject(r.message) && Array.isArray(r.message.content) ? r.message.content : []);

export function transcriptShape(records) {
  const list = Array.isArray(records) ? records : [];
  const recordTypes = new Set();
  const uses = new Map(); // tool_use id -> tool name
  const tools = {};
  const toolState = (name) =>
    (tools[name] ??= { input: null, resultTypes: new Set(), result: null, resultEntry: null, resultItem: null });

  for (const r of list) {
    if (!isObject(r)) continue;
    if (typeof r.type === 'string') recordTypes.add(SAFE_RECORD_TYPE.test(r.type) ? r.type : '<other>');
    for (const b of contentOf(r)) {
      if (!isObject(b) || b.type !== 'tool_use' || !WEB_TOOLS.includes(b.name)) continue;
      const t = toolState(b.name);
      if (typeof b.id === 'string') uses.set(b.id, b.name);
      if (isObject(b.input)) addKeys((t.input ??= new Map()), b.input);
    }
  }

  for (const r of list) {
    if (!isObject(r) || !('toolUseResult' in r)) continue;
    const tool = contentOf(r)
      .filter((b) => isObject(b) && b.type === 'tool_result' && uses.has(b.tool_use_id))
      .map((b) => uses.get(b.tool_use_id))[0];
    if (!tool) continue;
    const t = toolState(tool);
    const res = r.toolUseResult;
    t.resultTypes.add(typeName(res));
    if (!isObject(res)) continue;
    addKeys((t.result ??= new Map()), res);
    if (tool !== 'WebSearch' || !Array.isArray(res.results)) continue;
    const entry = res.results.find(isObject);
    if (!entry) continue;
    addKeys((t.resultEntry ??= new Map()), entry);
    const item = Array.isArray(entry.content) ? entry.content.find(isObject) : undefined;
    if (item) addKeys((t.resultItem ??= new Map()), item);
  }

  const shape = {
    recordTypes: [...recordTypes].sort(),
    WebSearch: toolOut(tools.WebSearch, 'WebSearch'),
    WebFetch: toolOut(tools.WebFetch, 'WebFetch')
  };
  return { ...shape, hash: sha256(shape) };
}

export function queueShape(files) {
  const kinds = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    if (!isObject(f) || typeof f.kind !== 'string') continue;
    const kind = safeName(f.kind);
    if (!kinds.has(kind)) kinds.set(kind, new Map());
    addKeys(kinds.get(kind), f);
  }
  const out = {};
  for (const k of [...kinds.keys()].sort()) out[k] = sectionOut(kinds.get(k));
  return { kinds: out, hash: sha256(out) };
}

// Union of the web-tool parts of several transcript shapes.
export function knownShapesFrom(shapes) {
  const acc = {};
  for (const s of shapes) {
    for (const tool of WEB_TOOLS) {
      const t = s?.[tool];
      if (!t) continue;
      const a = (acc[tool] ??= { input: null, resultTypes: new Set(), result: null, resultEntry: null, resultItem: null });
      for (const ty of t.resultTypes) a.resultTypes.add(ty);
      for (const sec of ['input', 'result', 'resultEntry', 'resultItem']) {
        if (!t[sec]) continue;
        a[sec] ??= new Map();
        for (const [k, types] of Object.entries(t[sec])) {
          if (!a[sec].has(k)) a[sec].set(k, new Set());
          for (const ty of types) a[sec].get(k).add(ty);
        }
      }
    }
  }
  return { WebSearch: toolOut(acc.WebSearch, 'WebSearch'), WebFetch: toolOut(acc.WebFetch, 'WebFetch') };
}

export function knownQueueShapesFrom(shape) {
  return shape.kinds;
}

// Generated from tests/fixtures/claude-code/transcript-*.jsonl (transcript-o1 is
// a real session, O1, 2026-11-15; the rest are hand-built) by
// knownShapesFrom; tests/claude-code-doctor.test.js fails when they drift.
export const KNOWN_SHAPES = {
  WebSearch: {
    input: { mode: ["string"], query: ["string"] },
    resultTypes: ["object", "string"],
    result: {
      durationSeconds: ["number"],
      query: ["string"],
      results: ["array"],
      searchCount: ["number"]
    },
    resultEntry: { content: ["array"], tool_use_id: ["string"] },
    resultItem: { title: ["string"], url: ["string"] }
  },
  WebFetch: {
    input: { prompt: ["string"], url: ["string"] },
    resultTypes: ["object"],
    result: {
      bytes: ["number"],
      code: ["number"],
      codeText: ["string"],
      durationMs: ["number"],
      result: ["string"],
      url: ["string"]
    }
  }
};

// Generated from the queue files recordHookEvent writes for
// tests/fixtures/claude-code/hooks-spec/*.json (hand-built) and hooks-real/*.json
// (seen in a real session, O1, 2026-11-15: mode is "standard" there).
export const KNOWN_QUEUE_SHAPES = {
  fetch: {
    at: ["string"],
    bytes: ["number"],
    duration_ms: ["number"],
    error: ["boolean"],
    final_url: ["string"],
    kind: ["string"],
    prompt_id: ["string"],
    session_id: ["string"],
    status: ["number"],
    tool_use_id: ["string"],
    url: ["string"],
    v: ["number"]
  },
  search: {
    allowed_domains: ["array", "null"],
    at: ["string"],
    blocked_domains: ["array", "null"],
    duration_s: ["null", "number"],
    error: ["boolean"],
    kind: ["string"],
    mode: ["null", "string"],
    prompt_id: ["string"],
    query: ["string"],
    results: ["array"],
    search_count: ["null", "number"],
    session_id: ["string"],
    tool_use_id: ["string"],
    v: ["number"]
  },
  stop: {
    answer: ["string"],
    at: ["string"],
    kind: ["string"],
    prompt_id: ["string"],
    session_id: ["string"],
    v: ["number"]
  }
};

// Keys whose absence is normal. Their presence with these types is no change.
export const OPTIONAL_KEYS = {
  WebSearch: {
    input: { mode: ['string'], allowed_domains: ['array'], blocked_domains: ['array'], max_results: ['number'] },
    result: { searchCount: ['number'] }
  }
};

function compareSection(label, got, known, optional, out, { ignoreNull = false } = {}) {
  const opt = optional ?? {};
  const knownSec = known ?? {};
  for (const [k, types] of Object.entries(got)) {
    const allowed = new Set([...(knownSec[k] ?? []), ...(opt[k] ?? [])]);
    if (!(k in knownSec) && !(k in opt)) {
      out.added.push(`${label}.${k}`);
      continue;
    }
    // A nullable queue field the fixtures only ever saw as null carries no type.
    const onlyNull = ignoreNull && (knownSec[k] ?? []).every((t) => t === 'null') && !(k in opt);
    for (const t of types) {
      if (ignoreNull && (t === 'null' || onlyNull)) continue;
      if (!allowed.has(t)) out.typeChanged.push(`${label}.${k}: ${t}`);
    }
  }
  for (const k of Object.keys(knownSec)) {
    if (!(k in got) && !(k in opt)) out.missing.push(`${label}.${k}`);
  }
}

const finish = (out) => ({ changed: out.added.length + out.missing.length + out.typeChanged.length > 0, ...out });

export function compareShape(shape, known = KNOWN_SHAPES) {
  if (!shape?.WebSearch && !shape?.WebFetch) return { changed: false, noWebCalls: true };
  const out = { added: [], missing: [], typeChanged: [] };
  for (const tool of WEB_TOOLS) {
    const t = shape[tool];
    if (!t) continue;
    const k = known[tool] ?? {};
    for (const ty of t.resultTypes) {
      if (!(k.resultTypes ?? []).includes(ty)) out.typeChanged.push(`${tool}.result: ${ty}`);
    }
    for (const sec of ['input', 'result', 'resultEntry', 'resultItem']) {
      if (!t[sec]) continue; // nothing of this part was seen, so nothing to compare
      compareSection(`${tool}.${sec}`, t[sec], k[sec], OPTIONAL_KEYS[tool]?.[sec], out);
    }
  }
  return finish(out);
}

export function compareQueueShape(shape, known = KNOWN_QUEUE_SHAPES) {
  const out = { added: [], missing: [], typeChanged: [] };
  for (const [kind, keys] of Object.entries(shape?.kinds ?? {})) {
    if (!known[kind]) {
      out.added.push(kind);
      continue;
    }
    compareSection(kind, keys, known[kind], null, out, { ignoreNull: true });
  }
  return finish(out);
}

// --- the report ---------------------------------------------------------

function checkWritable(env, dir) {
  try {
    ensureDataDir(env, dir);
    const probe = join(dir, `.doctor-${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(probe, '', { mode: 0o600, flag: 'wx' });
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Folders and files in the data folder that other users can read or write,
// tightened to 0700 and 0600. O2 (2026-11-15) saw a data folder another
// program re-created come back 0755. Only the data folder, its files, the
// queue and pending folders, the session folders in the queue and their
// files are looked at; a symbolic link is never followed or changed. The
// report names folders by their role and counts the rest, never a path.
// -> { loose: [labels], repaired: boolean }
function checkPermissions(data) {
  const loose = { data: false, queue: false, pending: false, sessions: 0, files: 0 };
  let repaired = true;
  const fix = (p, want) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return null;
    }
    if (st.isSymbolicLink() || (st.mode & 0o077) === 0) return false;
    try {
      chmodSync(p, want);
    } catch {
      repaired = false;
    }
    return true;
  };
  const files = (dir) => {
    for (const f of listDir(dir)) if (f.isFile() && fix(join(dir, f.name), 0o600)) loose.files += 1;
  };
  loose.data = fix(data, 0o700) === true;
  files(data);
  loose.queue = fix(join(data, 'queue'), 0o700) === true;
  files(join(data, 'queue'));
  for (const d of listDir(join(data, 'queue'))) {
    if (!d.isDirectory()) continue;
    if (fix(join(data, 'queue', d.name), 0o700)) loose.sessions += 1;
    files(join(data, 'queue', d.name));
  }
  loose.pending = fix(join(data, 'pending'), 0o700) === true;
  files(join(data, 'pending'));
  const labels = [];
  if (loose.data) labels.push('the data folder');
  if (loose.queue) labels.push('the queue folder');
  if (loose.pending) labels.push('the pending folder');
  if (loose.sessions) labels.push(`${loose.sessions} session folder${loose.sessions === 1 ? '' : 's'} in the queue`);
  if (loose.files) labels.push(`${loose.files} file${loose.files === 1 ? '' : 's'}`);
  return { loose: labels, repaired };
}

const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function permissionsLine(p) {
  if (!p.loose.length) return 'Permissions: the data folder and its files are private to your user.';
  const what = andList(p.loose);
  if (p.repaired) return `Permissions: ${what} could be read by other users on this computer. Doctor made them private to your user (folders 0700, files 0600).`;
  return `Permissions: ${what} can be read by other users on this computer, and doctor could not change that. Check who owns the data folder.`;
}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function mtimeOf(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

function queueInfo(env, now, projects) {
  const files = [];
  let sessions = 0;
  let sessionsWithoutTranscript = 0;
  for (const d of listDir(queueDir(env))) {
    if (!d.isDirectory() || !SESSION_DIR.test(d.name)) continue;
    sessions += 1;
    if (findTranscripts(d.name, projects).length === 0) sessionsWithoutTranscript += 1;
    const dir = join(queueDir(env), d.name);
    for (const f of listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.json')) continue;
      const file = join(dir, f.name);
      const mtime = mtimeOf(file);
      if (mtime !== null) files.push({ file, mtime });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const parsed = [];
  for (const { file } of files.slice(0, MAX_QUEUE_FILES_READ)) {
    try {
      parsed.push(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      // Half-written or damaged: not part of the shape.
    }
  }
  const shape = queueShape(parsed);
  return {
    files: files.length,
    sessions,
    sessionsWithoutTranscript,
    newestAgeMs: files.length ? Math.max(0, now - files[0].mtime) : null,
    shape,
    compare: parsed.length ? compareQueueShape(shape) : null
  };
}

// The record of saved turns (uploaded.json), read the way analyze and upload
// read it. Only a state and a count: never a conversation id.
export const UPLOADED_ADVICE =
  'Move it aside to start a new record. Turns already saved stay in your account; uploading one again is safe.';
function uploadedInfo(env) {
  if (!existsSync(uploadedFile(env))) return { state: 'absent' };
  const read = readUploaded(env);
  if (read.unreadable) return { state: 'unreadable', advice: UPLOADED_ADVICE };
  return { state: 'readable', count: read.turns.length };
}

function uploadedLine(u) {
  if (u.state === 'absent') return 'Saved turns record (uploaded.json): absent';
  if (u.state === 'unreadable') return `Saved turns record (uploaded.json): unreadable. ${u.advice}`;
  return `Saved turns record (uploaded.json): readable, ${u.count} saved turn${u.count === 1 ? '' : 's'}`;
}

// The newest UUID-named transcript under root, in the one project folder
// `project` when it is given.
function newestTranscript(root, project) {
  let best = null;
  for (const d of listDir(root)) {
    if (!d.isDirectory()) continue;
    if (project && d.name !== project) continue;
    for (const f of listDir(join(root, d.name))) {
      if (!f.isFile() || !SESSION_FILE.test(f.name)) continue;
      const file = join(root, d.name, f.name);
      const mtime = mtimeOf(file);
      if (mtime !== null && (!best || mtime > best.mtime)) best = { file, mtime };
    }
  }
  return best?.file ?? null;
}

// The last MAX_TRANSCRIPT_BYTES of the file. When the read starts mid-file the
// first (partial) line is dropped.
function readTail(file) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - MAX_TRANSCRIPT_BYTES);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return { text, bytesRead: read };
  } finally {
    closeSync(fd);
  }
}

// The current project's newest transcript when the project is known and has
// one, otherwise the newest in any project (O2, 2026-11-15, saw doctor read
// another project's). scope: 'project' or 'any'; why: null, 'unknown' (no
// project folder matches the working directory) or 'empty' (the project has
// no transcript). Never a path or a project name.
function transcriptInfo(root, project) {
  let scope = 'any';
  let why = project ? 'empty' : 'unknown';
  let file = project ? newestTranscript(root, project) : null;
  if (file) {
    scope = 'project';
    why = null;
  } else {
    file = newestTranscript(root);
  }
  if (!file) return { found: false, scope, why };
  try {
    const { text, bytesRead } = readTail(file);
    const { records, badLines } = parseJsonl(text);
    const shape = transcriptShape(records);
    return { found: true, scope, why, bytesRead, badLines, shape, compare: compareShape(shape) };
  } catch {
    return { found: true, scope, why, unreadable: true };
  }
}

function transcriptScopeText(t) {
  if (t.scope === 'project') return 'this project';
  if (t.why === 'empty') return 'any project, because this project has no transcript';
  return "any project, because Sourced can't tell which project this is";
}

// Why this data folder is the one in use.
export const DATA_DIR_TEXT = Object.freeze({
  argument: 'Data folder source: the plugin data folder Claude Code named, passed by the command file (--data-dir)',
  environment: 'Data folder source: the plugin data folder Claude Code named in CLAUDE_PLUGIN_DATA',
  environmentIgnored:
    'Data folder source: the plugin data folder Claude Code named in CLAUDE_PLUGIN_DATA (the command file passed an empty --data-dir, so Claude Code did not fill it in)',
  fallback: 'Data folder source: the fallback folder in the Claude config folder, because Claude Code named no plugin data folder',
  fallbackIgnored:
    'Data folder source: the fallback folder in the Claude config folder, because the command file passed an empty --data-dir (Claude Code did not fill it in)',
  otherQueue:
    'Warning: another data folder also holds a queue ({names}). The hooks write to the folder Claude Code names for them, and list and analyze read only the folder named above, so turns recorded in the other folder are missing here.'
});

export const DOCTOR_TEXT = Object.freeze({
  queueHash:
    'Shape hash of the kinds seen: {hash}. It changes when the newest queue files hold another record kind or another value type, so it is the same between two runs only when they saw the same kinds.'
});
const fill = (t, vars) => t.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

function sourceLine(src) {
  if (src.source === 'argument') return DATA_DIR_TEXT.argument;
  if (src.source === 'environment') return src.argumentIgnored ? DATA_DIR_TEXT.environmentIgnored : DATA_DIR_TEXT.environment;
  return src.argumentIgnored ? DATA_DIR_TEXT.fallbackIgnored : DATA_DIR_TEXT.fallback;
}

function holdsQueue(folder) {
  return listDir(join(folder, 'queue')).some((d) => d.isDirectory() && SESSION_DIR.test(d.name));
}

// Other Sourced data folders that hold a queue, by name only.
function otherQueues(env, data, source) {
  const candidates = [];
  if (source === 'fallback') {
    const base = join(configDir(env), 'plugins', 'data');
    for (const d of listDir(base)) {
      if (d.isDirectory() && d.name.startsWith('sourced')) candidates.push(join(base, d.name));
    }
  } else {
    candidates.push(fallbackDataDir(env));
  }
  return candidates.filter((c) => c !== data && holdsQueue(c)).map((c) => basename(c)).sort();
}

function defaultVersion() {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function age(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

function changeLines(cmp) {
  const lines = [];
  if (cmp.added.length) lines.push(`  Added: ${cmp.added.join(', ')}`);
  if (cmp.missing.length) lines.push(`  Missing: ${cmp.missing.join(', ')}`);
  if (cmp.typeChanged.length) lines.push(`  Type changed: ${cmp.typeChanged.join(', ')}`);
  return lines;
}

export function doctorReport({ env = process.env, root, now = Date.now(), pluginVersion, dataSource, project = null } = {}) {
  const src = dataSource?.ok ? dataSource : resolveDataDir(env, undefined);
  const data = dataDir(env);
  const projects = root ?? projectsRoot(env);
  const dataName = basename(data);
  const rootName = basename(projects);

  // Before the writable check, which makes the data folder 0700 itself.
  const permissions = checkPermissions(data);
  const report = {
    pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : defaultVersion(),
    nodeVersion: process.version,
    dataFolder: {
      name: dataName,
      writable: checkWritable(env, data),
      source: src.source,
      argumentIgnored: src.argumentIgnored,
      otherQueues: otherQueues(env, data, src.source)
    },
    permissions,
    queue: queueInfo(env, now, projects),
    sessionFile: existsSync(sessionFile(env)),
    uploaded: uploadedInfo(env),
    transcript: { rootName, ...transcriptInfo(projects, typeof project === 'string' && project ? project : null) }
  };

  const q = report.queue;
  const t = report.transcript;
  const lines = [
    'Sourced doctor',
    `Plugin version: ${report.pluginVersion}`,
    `Node version: ${report.nodeVersion}`,
    `Data folder (${dataName}): ${report.dataFolder.writable ? 'writable' : 'NOT writable'}`,
    sourceLine(src),
    permissionsLine(permissions),
    ...(report.dataFolder.otherQueues.length
      ? [DATA_DIR_TEXT.otherQueue.replace('{names}', report.dataFolder.otherQueues.join(', '))]
      : []),
    `Queue: ${q.files} file${q.files === 1 ? '' : 's'}${q.newestAgeMs === null ? '' : `, newest ${age(q.newestAgeMs)} old`}`,
    ...(q.sessionsWithoutTranscript
      ? [
          `Queue sessions with no transcript: ${q.sessionsWithoutTranscript} of ${q.sessions}. Claude Code kept no transcript for them (a run with --no-session-persistence keeps none) or it was deleted. Their turns are listed, but they can't be uploaded, because the prompt can't be shown.`
        ]
      : []),
    `Sign-in session file: ${report.sessionFile ? 'present' : 'absent'}`,
    uploadedLine(report.uploaded)
  ];

  const where = transcriptScopeText(t);
  if (!t.found) {
    lines.push(t.scope === 'project' || t.why === 'empty' ? 'No transcript found in this project or any other' : 'No transcript found in any project');
  } else if (t.unreadable) {
    lines.push(`The newest transcript in ${where} could not be read`);
  } else {
    const c = t.compare;
    if (c.noWebCalls) lines.push(`Transcript format unchanged (checked the newest transcript in ${where}; it has no web calls)`);
    else lines.push(`Transcript format ${c.changed ? 'changed' : 'unchanged'} (checked the newest transcript in ${where})`);
    if (!c.noWebCalls) lines.push(...changeLines(c));
    lines.push(`  Record types: ${t.shape.recordTypes.join(', ') || 'none'}`);
    if (t.badLines) lines.push(`  Unparsed lines: ${t.badLines}`);
    lines.push(`  Shape hash: ${t.shape.hash.slice(0, 16)}`);
  }

  if (!q.compare) {
    lines.push('Queue format: no queue files to check');
  } else {
    // O2 (2026-11-15) saw this hash change between two runs that both said
    // "unchanged": a fetch record had appeared. The hash covers the kinds and
    // value types seen, so the line names the kinds.
    const kinds = Object.keys(q.shape.kinds).join(', ') || 'none';
    lines.push(`Queue format ${q.compare.changed ? 'changed' : 'unchanged'} (record kinds seen: ${kinds})`);
    lines.push(...changeLines(q.compare));
    lines.push(`  ${fill(DOCTOR_TEXT.queueHash, { hash: q.shape.hash.slice(0, 16) })}`);
  }

  return { text: lines.join('\n') + '\n', report };
}
