// `upload <code>`: the confirm step (plan Task 13, U11). Built to owner gates
// G1 (answered 2026-11-15, option A: typing this command with the code
// `analyze` printed is the confirm) and G9 (answered 2026-11-15).
//
// Order of checks, and nothing is sent until all pass:
//   1. the code's shape (isConfirmCode)
//   2. the claim: pending/<code>.json is renamed to <code>.sending, so of two
//      runs on one code only one sends (U6); a run that loses prints
//      "already being sent" and sends nothing. A claim older than
//      SENDING_STALE_MS (2 minutes, a run that stopped) is taken back and
//      the upload proceeds: the server keeps one copy per turn, so a repeat
//      is safe. Anything that is not a regular file is refused and never
//      followed (U11).
//   3. the pending record: parses, its code matches, not older than 15
//      minutes, sha256(payload_bytes) === payload_hash (readPending)
//   3b. the person typed the command (confirm.mjs): the session transcript
//      holds a human-origin record of /sourced:upload with this code,
//      written after the code was issued, as the last human input. A result
//      of 'none' or 'no-transcript' is tried again, CONFIRM_TRIES times in
//      all and CONFIRM_WAIT_MS apart, in case Claude Code has not yet written
//      the record (unconfirmed: in O1 it was always written before Claude's
//      reply). Any refusal puts the claim back and sends nothing.
//   4. not already saved (U6: the conversation_id in uploaded.json; an
//      uploaded.json that can't be read refuses)
//   5. the turn, read again from the transcript and built with the same
//      install id, gives exactly payload_bytes; else the file is dropped (U11)
//   6. signed in (getAccessToken non-null); else "Sign in first", keep the file
//   7. print "Uploading the turn you previewed (code <code>)." and POST.
//      The locked confirm line is printed by analyze, above the code; typing
//      this command after reading it is the confirm, so it is not asked here.
// The POST body is the stored payload_bytes string as is, never re-serialized.
// Headers are exactly Authorization, apikey and Content-Type: no Origin
// (collect's resolveCorsOrigin refuses a non-browser origin). At most
// MAX_POSTS requests per run. 200 saves: the pending files are always
// deleted and "Saved" always printed, even when the local record of it
// can't be written. 401: the session file is read again, and a token another
// process wrote is tried; otherwise one forced refresh, then one retry. 409
// gets one retry after Retry-After (capped at 5 s). Any other failure puts
// the claim back, so the user can retry; the server upserts on the
// conversation id, so a retry after a lost reply is safe. Nothing here
// prints a token or any part of a response body: status codes only.
//
// Exports:
//   UPLOAD_TEXT, DASHBOARD_URL, UPLOAD_TIMEOUT_MS, MAX_CONFLICT_WAIT_MS, MAX_POSTS,
//   CONFIRM_TRIES, CONFIRM_WAIT_MS
//   refreshAccessToken({ env, fetch, now, fetchTimeoutMs }) -> token | null
//       A refresh whatever the stored expiry (auth.mjs refreshes only near
//       expiry, and a 401 says the server no longer takes the token).
//   uploadCommand({ code, env, root, fetch, print, now, sleep, prefix }) -> exit code
import { readFileSync } from 'node:fs';
import { COLLECT_URL, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.mjs';
import { getAccessToken, isClientToken, decodeJwtPayload, DEFAULT_FETCH_TIMEOUT_MS } from './auth.mjs';
import { sessionFile, writeDataFile } from './paths.mjs';
import { isConfirmCode } from './ids.mjs';
import { claimPending, releasePending, readPending, deletePending } from './pending.mjs';
import { savedState, savedByCode, recordUploaded } from './uploaded.mjs';
import { rebuildPayloadBytes } from './analyze.mjs';
import { confirmTyped } from './confirm.mjs';

export const DASHBOARD_URL = 'https://app.chatgptsearchinsights.com';
export const UPLOAD_TIMEOUT_MS = 20 * 1000;
export const MAX_CONFLICT_WAIT_MS = 5 * 1000;
export const MAX_POSTS = 2;
export const CONFIRM_TRIES = 4;
export const CONFIRM_WAIT_MS = 300;

export const UPLOAD_TEXT = Object.freeze({
  uploading: 'Uploading the turn you previewed (code {code}).',
  badCode: "That isn't an upload code. A code is six capital letters and digits, as analyze printed it.",
  noPending: 'No upload is waiting for that code. Codes last 15 minutes. To make a new one: {prefix}analyze',
  busy: 'This upload is already being sent. If nothing is uploading, run {prefix}analyze again for a new code.',
  tampered: "This upload's saved data changed after analyze, so it was not sent. To make a new one: {prefix}analyze",
  turnChanged: 'This turn changed since the preview, so it was not sent. Run {prefix}analyze again.',
  alreadySaved: 'This turn is already saved.',
  codeUsed: 'That turn is already saved to your account.',
  savedUnreadable: "The record of saved turns can't be read, so nothing was sent. Run {prefix}doctor.",
  signInFirst: 'Sign in first: {prefix}signin',
  saved: 'Saved to your account.',
  notRecorded: "This computer couldn't note that the turn is saved, so analyze may offer it again. Uploading it again is safe: your account keeps one copy of each turn.",
  signInAgain: "Your sign-in wasn't accepted, so nothing was saved. Sign in again: {prefix}signin. Then run {prefix}upload {code}",
  rateLimited: 'Too many uploads right now (HTTP 429), so nothing was saved. Wait a minute, then run {prefix}upload {code}',
  couldNotSave: "Couldn't save (HTTP {status}). To try again: {prefix}upload {code}",
  unreachable: "Couldn't save: the server could not be reached. To try again: {prefix}upload {code}",
  noReply: 'The upload was sent but the reply was not received, so the turn may already be saved. Trying again is safe: your account keeps one copy of each turn. To try again: {prefix}upload {code}',
  modelRun: 'Nothing was sent: this upload was started by Claude, not typed by you. To upload this turn, type {prefix}upload {code} yourself.',
  notTyped: "Nothing was sent: Sourced found no {prefix}upload {code} typed by you in this session's transcript. Uploading is your step: type the command yourself.",
  noTranscript: "Nothing was sent: Sourced couldn't find this session's transcript, so it can't confirm that you typed {prefix}upload {code}."
});

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
const nowFnOf = (now) => (typeof now === 'function' ? now : typeof now === 'number' ? () => now : Date.now);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readSessionFile(env) {
  try {
    const s = JSON.parse(readFileSync(sessionFile(env), 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

export async function refreshAccessToken({ env, fetch, now = Date.now, fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const session = readSessionFile(env);
  if (!session || typeof session.refresh_token !== 'string' || !session.refresh_token) return null;
  let data;
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
      signal: AbortSignal.timeout(fetchTimeoutMs)
    });
    if (!response.ok) return null;
    data = await response.json().catch(() => null);
  } catch {
    return null;
  }
  const access = data?.access_token;
  if (typeof access !== 'string' || !access || isClientToken(access)) return null;
  const nowSec = Math.floor(nowFnOf(now)() / 1000);
  let expiresAt = Number.isFinite(data.expires_at) ? data.expires_at : null;
  if (!expiresAt && Number.isFinite(data.expires_in)) expiresAt = nowSec + data.expires_in;
  if (!expiresAt) expiresAt = decodeJwtPayload(access)?.exp ?? null;
  const next = {
    access_token: access,
    refresh_token: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : session.refresh_token,
    expires_at: expiresAt,
    email: (typeof data.user?.email === 'string' && data.user.email) || session.email || null
  };
  writeDataFile(env, sessionFile(env), JSON.stringify(next));
  return access;
}

// The session file's access token when it differs from `used`, is not a
// connector token and has not expired: another process refreshed first.
function tokenFromOtherProcess(env, used, nowFn) {
  const s = readSessionFile(env);
  const access = s?.access_token;
  if (typeof access !== 'string' || !access || access === used || isClientToken(access)) return null;
  const exp = Number.isFinite(s.expires_at) ? s.expires_at : decodeJwtPayload(access)?.exp;
  return Number.isFinite(exp) && exp > Math.floor(nowFn() / 1000) ? access : null;
}

function retryAfterMs(response) {
  const raw = response?.headers?.get ? response.headers.get('Retry-After') : null;
  const s = Number.parseInt(raw ?? '', 10);
  const ms = Number.isFinite(s) && s >= 0 ? s * 1000 : 1000;
  return Math.min(ms, MAX_CONFLICT_WAIT_MS);
}

// Errors raised before any byte of the request left: the server was not reached.
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_INVALID_URL']);
function notSent(err) {
  for (let e = err, i = 0; e && i < 4; e = e.cause, i++) {
    if (typeof e.code === 'string' && NOT_SENT.has(e.code)) return true;
  }
  return false;
}

// { response } or { error: 'unreachable' | 'no-reply' }.
async function post(fetch, bytes, token) {
  try {
    const response = await fetch(COLLECT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    });
    return { response };
  } catch (err) {
    return { error: notSent(err) ? 'unreachable' : 'no-reply' };
  }
}

export async function uploadCommand({ code, env, root, fetch, print, now = Date.now, sleep = defaultSleep, prefix = '' }) {
  const nowFn = nowFnOf(now);
  const vars = { prefix, code };
  if (!isConfirmCode(code)) {
    print(UPLOAD_TEXT.badCode);
    return 1;
  }

  const claim = claimPending(env, code, { now: nowFn() });
  if (!claim.ok) {
    if (claim.reason === 'busy') {
      print(fill(UPLOAD_TEXT.busy, vars));
    } else if (claim.reason === 'not-file') {
      deletePending(env, code);
      print(fill(UPLOAD_TEXT.tampered, vars));
    } else {
      print(fill(savedByCode(env, code) ? UPLOAD_TEXT.codeUsed : UPLOAD_TEXT.noPending, vars));
    }
    return 1;
  }

  // From here this run holds <code>.sending. Until a request is sent, every
  // way out either deletes the files or puts the claim back.
  let held = true;
  const release = () => {
    if (held) releasePending(env, code);
    held = false;
  };
  const drop = () => {
    deletePending(env, code, { claimed: true });
    held = false;
  };
  try {
    const read = readPending(env, code, { now: nowFn(), claimed: true });
    if (!read.ok) {
      drop();
      if (read.reason === 'expired' || read.reason === 'missing') print(fill(savedByCode(env, code) ? UPLOAD_TEXT.codeUsed : UPLOAD_TEXT.noPending, vars));
      else print(fill(UPLOAD_TEXT.tampered, vars));
      return 1;
    }
    const pending = read.pending;

    // G1 option A: the person typed this command (confirm.mjs).
    const since = Date.parse(pending.created_at);
    let typed = confirmTyped({ code, since, env, root });
    for (let i = 1; i < CONFIRM_TRIES && (typed.state === 'none' || typed.state === 'no-transcript'); i++) {
      await sleep(CONFIRM_WAIT_MS);
      typed = confirmTyped({ code, since, env, root });
    }
    if (typed.state !== 'typed') {
      release();
      const text = typed.state === 'model' ? UPLOAD_TEXT.modelRun : typed.state === 'no-transcript' ? UPLOAD_TEXT.noTranscript : UPLOAD_TEXT.notTyped;
      print(fill(text, vars));
      return 1;
    }

    const saved = savedState(env, pending.conversation_id);
    if (saved === 'saved') {
      drop();
      print(UPLOAD_TEXT.alreadySaved);
      return 0;
    }
    if (saved === 'unreadable') {
      release();
      print(fill(UPLOAD_TEXT.savedUnreadable, vars));
      return 1;
    }

    const now2 = rebuildPayloadBytes({ sessionId: pending.session_id, turnKey: pending.turn_key, installId: pending.install_id, env, root });
    if (now2 !== pending.payload_bytes) {
      drop();
      print(fill(UPLOAD_TEXT.turnChanged, vars));
      return 1;
    }

    const token = await getAccessToken({ env, fetch, now: nowFn });
    if (!token) {
      release();
      print(fill(UPLOAD_TEXT.signInFirst, vars));
      return 1;
    }

    // The confirm was the user typing this command after reading the locked
    // line in analyze, so it is not asked again here.
    print(fill(UPLOAD_TEXT.uploading, { code: pending.code }));
    return await send({ pending, token, env, fetch, print, nowFn, sleep, vars, release, drop });
  } finally {
    // An unexpected error before sending leaves the upload where it was.
    release();
  }
}

async function send({ pending, token, env, fetch, print, nowFn, sleep, vars, release, drop }) {
  let posts = 0;
  let authRetried = false;
  let conflictRetried = false;
  for (;;) {
    posts += 1;
    const { response, error } = await post(fetch, pending.payload_bytes, token);
    if (error) {
      release();
      print(fill(error === 'unreachable' ? UPLOAD_TEXT.unreachable : UPLOAD_TEXT.noReply, vars));
      return 1;
    }
    const status = response.status;
    if (status === 200) {
      let recorded = true;
      try {
        recordUploaded(env, { conversation_id: pending.conversation_id, payload_hash: pending.payload_hash, at: new Date(nowFn()).toISOString(), code: pending.code });
      } catch {
        recorded = false;
      }
      try {
        drop();
      } catch {
        // The claimed file is spent either way: the sweep removes it later.
      }
      print(UPLOAD_TEXT.saved);
      print(DASHBOARD_URL);
      if (!recorded) print(UPLOAD_TEXT.notRecorded);
      return 0;
    }
    const canRetry = posts < MAX_POSTS;
    if (status === 401 && !authRetried && canRetry) {
      authRetried = true;
      const used = token;
      token = tokenFromOtherProcess(env, used, nowFn) ?? (await refreshAccessToken({ env, fetch, now: nowFn })) ?? tokenFromOtherProcess(env, used, nowFn);
      if (!token) {
        release();
        print(fill(UPLOAD_TEXT.signInAgain, vars));
        return 1;
      }
      continue;
    }
    if (status === 409 && !conflictRetried && canRetry) {
      conflictRetried = true;
      await sleep(retryAfterMs(response));
      continue;
    }
    // Every other answer: the claim goes back, so the user can try again.
    release();
    if (status === 401) {
      print(fill(UPLOAD_TEXT.signInAgain, vars));
      return 1;
    }
    if (status === 429) {
      print(fill(UPLOAD_TEXT.rateLimited, vars));
      return 1;
    }
    print(fill(UPLOAD_TEXT.couldNotSave, { ...vars, status: Number.isInteger(status) ? status : 'unknown' }));
    return 1;
  }
}
