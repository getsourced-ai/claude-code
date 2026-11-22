// Pending uploads (plan Task 13): what `analyze` leaves for `upload <code>`.
// Built to owner gates G1 (answered 2026-11-15, option A: typing the upload
// command with the code is the confirm) and G9 (what rides with a turn,
// answered 2026-11-15).
//
// Layout, under the plugin data folder:
//   pending/<code>.json     { v: 1, code, created_at, conversation_id,
//                             session_id, turn_key, payload_hash,
//                             payload_bytes }
//   pending/<code>.sending  the same file while one `upload` run sends it:
//                           claimPending renames .json to .sending, and only
//                           the run whose rename succeeded sends (U6)
//   pending/<code>.txt      the saved upload preview: the text `analyze`
//                           printed, the whole payload as JSON and the
//                           fingerprint
// All are written through writeDataFile (0600, in a 0700 folder). A code
// is checked with isConfirmCode before it is joined into a path, so no other
// file name is ever built from user input. Anything at these paths that is
// not a regular file (a symlink, a folder) is refused, never followed, and
// the record is opened with O_NOFOLLOW where the platform has it (U11).
//
// Imports only node:fs, node:path, node:crypto and plugin/lib files: no
// network module and no child process.
//
// Exports:
//   PENDING_VERSION, PENDING_TTL_MS (15 minutes)
//   pendingPaths(env, code)              -> { json, sending, txt } | null
//   newPendingCode(env)                  -> a code with no pending file yet
//   writePending(env, record, preview)   -> { json, sending, txt }
//   SENDING_STALE_MS (2 minutes)
//   claimPending(env, code, { now })     -> { ok: true }
//       | { ok: false, reason: 'bad-code' | 'missing' | 'busy' | 'not-file' }
//       The claim's time is the .sending file's mtime, set to `now` when
//       claimed. A .sending file with no .json beside it whose mtime is more
//       than SENDING_STALE_MS before `now` is a run that stopped: it is
//       renamed back to .json and claimed again. A time after `now` is not
//       stale.
//   releasePending(env, code)            -> true when .sending went back to .json
//   isSending(env, code)                 -> boolean
//   readPending(env, code, { now, claimed })   -> { ok: true, pending }
//       | { ok: false, reason: 'bad-code' | 'missing' | 'not-file' | 'corrupt'
//                              | 'expired' | 'tampered' }
//       (claimed: read the .sending file this run claimed)
//   deletePending(env, code, { claimed }) -> true when a file was removed
//       (.json and .txt; with claimed, the .sending file too)
//   deleteAllPending(env)                -> number of codes removed (a code
//                                           being sent is left alone)
//   sweepPending(env, { now })           -> number of codes removed (older
//                                           than PENDING_TTL_MS, or unreadable
//                                           and older than that by mtime;
//                                           stale .sending files included)
import { readdirSync, rmSync, lstatSync, existsSync, renameSync, openSync, readFileSync, fstatSync, closeSync, utimesSync, constants } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pendingDir, writeDataFile } from './paths.mjs';
import { isConfirmCode, newConfirmCode, isSessionId, isPromptId } from './ids.mjs';

export const PENDING_VERSION = 1;
export const PENDING_TTL_MS = 15 * 60 * 1000;
// A .sending claim older than this is a run that stopped (claimPending).
export const SENDING_STALE_MS = 2 * 60 * 1000;
// A created_at this far ahead of the clock is not trusted.
const CLOCK_SKEW_MS = 60 * 1000;
const FILE_NAME = /^([A-HJ-NP-Z2-9]{6})\.(json|txt|sending)$/;
const HEX64 = /^[0-9a-f]{64}$/;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const nowMs = (now) => (typeof now === 'function' ? now() : typeof now === 'number' ? now : Date.now());

export function pendingPaths(env, code) {
  if (!isConfirmCode(code)) return null;
  const dir = pendingDir(env);
  return { json: join(dir, `${code}.json`), sending: join(dir, `${code}.sending`), txt: join(dir, `${code}.txt`) };
}

// 'file', 'missing' or 'other' (a symlink, a folder, anything else). Never
// follows a link.
function kindOf(file) {
  try {
    return lstatSync(file).isFile() ? 'file' : 'other';
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'missing';
    throw err;
  }
}

const present = (file) => kindOf(file) !== 'missing';

export function newPendingCode(env) {
  for (let i = 0; i < 100; i++) {
    const code = newConfirmCode();
    const p = pendingPaths(env, code);
    if (!present(p.json) && !present(p.txt) && !present(p.sending)) return code;
  }
  throw new Error('newPendingCode: no free code');
}

export function writePending(env, record, preview) {
  const p = pendingPaths(env, record?.code);
  if (!p) throw new TypeError('writePending: bad code');
  const body = {
    v: PENDING_VERSION,
    code: record.code,
    created_at: record.created_at,
    conversation_id: record.conversation_id,
    session_id: record.session_id,
    turn_key: record.turn_key,
    payload_hash: record.payload_hash,
    payload_bytes: record.payload_bytes
  };
  // The preview first: a JSON file without its preview is never left behind
  // by a failed second write.
  writeDataFile(env, p.txt, `${preview}\n`);
  writeDataFile(env, p.json, `${JSON.stringify(body)}\n`);
  return p;
}

export function isSending(env, code) {
  const p = pendingPaths(env, code);
  return Boolean(p) && present(p.sending);
}

// Rename is atomic within one folder: of two runs, exactly one moves the file.
export function claimPending(env, code, { now } = {}) {
  const p = pendingPaths(env, code);
  if (!p) return { ok: false, reason: 'bad-code' };
  const t = nowMs(now);
  let kind = kindOf(p.json);
  if (kind === 'missing' && isStaleClaim(p.sending, t)) {
    releasePending(env, code);
    kind = kindOf(p.json);
  }
  if (kind === 'missing') return { ok: false, reason: present(p.sending) ? 'busy' : 'missing' };
  if (kind !== 'file') return { ok: false, reason: 'not-file' };
  const txt = kindOf(p.txt);
  if (txt === 'other') return { ok: false, reason: 'not-file' };
  if (present(p.sending)) return { ok: false, reason: 'busy' };
  try {
    // The claim's time, stamped before the rename so no run sees a fresh
    // claim with an old time.
    utimesSync(p.json, t / 1000, t / 1000);
    renameSync(p.json, p.sending);
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'busy' };
    throw err;
  }
  return { ok: true };
}

function isStaleClaim(file, t) {
  try {
    const st = lstatSync(file);
    return st.isFile() && t - st.mtimeMs > SENDING_STALE_MS;
  } catch {
    return false;
  }
}

export function releasePending(env, code) {
  const p = pendingPaths(env, code);
  if (!p || kindOf(p.sending) !== 'file' || present(p.json)) return false;
  try {
    renameSync(p.sending, p.json);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

function conversationIdOk(rec) {
  const id = rec.conversation_id;
  if (typeof id !== 'string' || id.length > 200) return false;
  if (!isSessionId(rec.session_id) || !isPromptId(rec.turn_key)) return false;
  return id === `${rec.session_id}.${rec.turn_key}`;
}

// The record's text, read without following a link and only from a regular file.
function readRegular(file) {
  if (kindOf(file) === 'missing') return { reason: 'missing' };
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    if (err?.code === 'ENOENT') return { reason: 'missing' };
    if (err?.code === 'ELOOP' || err?.code === 'EISDIR' || err?.code === 'EMLINK') return { reason: 'not-file' };
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) return { reason: 'not-file' };
    return { text: readFileSync(fd, 'utf8') };
  } catch (err) {
    if (err?.code === 'EISDIR') return { reason: 'not-file' };
    throw err;
  } finally {
    closeSync(fd);
  }
}

export function readPending(env, code, { now, claimed = false } = {}) {
  const p = pendingPaths(env, code);
  if (!p) return { ok: false, reason: 'bad-code' };
  const file = claimed ? p.sending : p.json;
  if (kindOf(file) === 'other' || kindOf(p.txt) === 'other') return { ok: false, reason: 'not-file' };
  const read = readRegular(file);
  if (read.reason) return { ok: false, reason: read.reason };
  let rec;
  try {
    rec = JSON.parse(read.text);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (!isObject(rec) || rec.v !== PENDING_VERSION || rec.code !== code) return { ok: false, reason: 'corrupt' };
  const created = Date.parse(rec.created_at);
  const t = nowMs(now);
  if (!Number.isFinite(created) || created > t + CLOCK_SKEW_MS) return { ok: false, reason: 'corrupt' };
  if (t - created > PENDING_TTL_MS) return { ok: false, reason: 'expired' };
  if (typeof rec.payload_bytes !== 'string' || typeof rec.payload_hash !== 'string' || !HEX64.test(rec.payload_hash)) {
    return { ok: false, reason: 'tampered' };
  }
  if (sha256(rec.payload_bytes) !== rec.payload_hash) return { ok: false, reason: 'tampered' };
  let payload;
  try {
    payload = JSON.parse(rec.payload_bytes);
  } catch {
    return { ok: false, reason: 'tampered' };
  }
  if (!isObject(payload) || payload.conversation_id !== rec.conversation_id || !conversationIdOk(rec) || !isSessionId(payload.install_id)) {
    return { ok: false, reason: 'tampered' };
  }
  return {
    ok: true,
    pending: {
      code: rec.code,
      created_at: rec.created_at,
      conversation_id: rec.conversation_id,
      session_id: rec.session_id,
      turn_key: rec.turn_key,
      install_id: payload.install_id,
      payload_hash: rec.payload_hash,
      payload_bytes: rec.payload_bytes,
      preview_path: p.txt
    }
  };
}

export function deletePending(env, code, { claimed = false } = {}) {
  const p = pendingPaths(env, code);
  if (!p) return false;
  const files = claimed ? [p.json, p.txt, p.sending] : [p.json, p.txt];
  const had = files.some(present);
  for (const f of files) rmSync(f, { force: true });
  return had;
}

function pendingCodes(env) {
  let names;
  try {
    names = readdirSync(pendingDir(env));
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return new Map();
    throw err;
  }
  const codes = new Map();
  for (const name of names) {
    const m = FILE_NAME.exec(name);
    if (!m) continue;
    if (!codes.has(m[1])) codes.set(m[1], new Set());
    codes.get(m[1]).add(m[2]);
  }
  return codes;
}

export function deleteAllPending(env) {
  let n = 0;
  for (const [code, kinds] of pendingCodes(env)) {
    if (kinds.has('sending')) continue;
    if (deletePending(env, code)) n += 1;
  }
  return n;
}

function mtimeOf(file) {
  try {
    return lstatSync(file).mtimeMs;
  } catch {
    return null;
  }
}

export function sweepPending(env, { now } = {}) {
  const t = nowMs(now);
  let n = 0;
  for (const [code, kinds] of pendingCodes(env)) {
    const p = pendingPaths(env, code);
    // Age from created_at when the record parses; otherwise (damaged JSON, a
    // link, or a preview with no record beside it) from the file time.
    const recordFile = kinds.has('sending') ? p.sending : kinds.has('json') ? p.json : null;
    let created = NaN;
    if (recordFile) {
      const read = readRegular(recordFile);
      try {
        created = read.text ? Date.parse(JSON.parse(read.text)?.created_at) : NaN;
      } catch {
        created = NaN;
      }
    }
    const born = Number.isFinite(created) ? created : mtimeOf(recordFile ?? p.txt) ?? t;
    const expired = t - born > PENDING_TTL_MS;
    if (expired && deletePending(env, code, { claimed: true })) n += 1;
  }
  return n;
}
