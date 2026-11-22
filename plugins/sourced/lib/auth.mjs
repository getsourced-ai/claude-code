// Sign-in for the plugin: the extension's Google sign-in (Supabase PKCE code
// flow, src/background/background.js handleSignInGoogle and refreshSession)
// with a loopback redirect to http://127.0.0.1:<port>/callback instead of
// chrome.identity. Only the commands import this file; hooks never do.
//
// Every side effect is injected (fetch, browser, server, clock, output) so
// tests need no network, browser or port. Nothing this file prints holds a
// token, the PKCE verifier, the auth code or the account email.
import { createServer as httpCreateServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  LOOPBACK_HOST,
  LOOPBACK_PORTS,
  LOOPBACK_PATH
} from './config.mjs';
import { sessionFile, writeDataFile } from './paths.mjs';

export const READ_ONLY_MESSAGE = "This sign-in is read-only and can't upload.";
export const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
export const DEFAULT_FETCH_TIMEOUT_MS = 15 * 1000;
export const CANCELLED_MESSAGE = 'Sign-in was cancelled.';
// Code exchanges allowed per sign-in, so a flood of forged callbacks cannot
// make the CLI hammer the auth server.
export const MAX_EXCHANGE_ATTEMPTS = 5;
const REFRESH_MARGIN_SECONDS = 60;
// Supabase auth codes are UUIDs; anything outside this shape is not one.
const CODE_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

const PAGE_OK = '<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head>'
  + '<body><p>You are signed in to Sourced. You can close this tab and return to Claude Code.</p></body></html>';
const PAGE_BAD = '<!doctype html><html><head><meta charset="utf-8"><title>Not found</title></head>'
  + '<body><p>This address only accepts the Sourced sign-in redirect.</p></body></html>';
// Served when a code fails the exchange. It says nothing about why, so a
// forged request learns nothing, and the real redirect can still follow.
const PAGE_RETRY = '<!doctype html><html><head><meta charset="utf-8"><title>Sign-in not finished</title></head>'
  + '<body><p>This sign-in did not finish. Return to Claude Code; if it is still waiting, run sign-in again.</p></body></html>';
const PAGE_CANCELLED = '<!doctype html><html><head><meta charset="utf-8"><title>Sign-in cancelled</title></head>'
  + '<body><p>Sign-in was cancelled. You can close this tab and run sign-in again from Claude Code.</p></body></html>';

// ---------- JWT and PKCE helpers ----------

export function decodeJwtPayload(token) {
  try {
    if (typeof token !== 'string') return null;
    const segment = token.split('.')[1] || '';
    if (!segment) return null;
    const payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

// Same rule as collect's isClientToken (supabase/functions/collect/lib.ts):
// a top-level string client_id claim marks a connector (OAuth server) token,
// which is read-only by firm rule A6. No signature check: this only decides
// whether the plugin will store or use the token.
export function isClientToken(token) {
  const payload = decodeJwtPayload(token);
  return Boolean(payload) && typeof payload.client_id === 'string';
}

export function createPkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function redirectUrl(port) {
  return `http://${LOOPBACK_HOST}:${port}${LOOPBACK_PATH}`;
}

// As background.js builds it, with the loopback redirect.
export function buildAuthorizeUrl({ port, challenge }) {
  return `${SUPABASE_URL}/auth/v1/authorize?provider=google`
    + `&redirect_to=${encodeURIComponent(redirectUrl(port))}`
    + `&response_type=code`
    + `&code_challenge=${challenge}`
    + `&code_challenge_method=s256`;
}

// ---------- defaults for injected effects ----------

// The URL is always one argv entry, never part of a shell string. On Windows,
// cmd would split the URL at '&', so each '&' is escaped as '^&'.
export function browserCommand(platform, url) {
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '""', url.replace(/&/g, '^&')] };
  return { cmd: 'xdg-open', args: [url] };
}

export function defaultOpenBrowser(url) {
  const { cmd, args } = browserCommand(process.platform, url);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

// The handler is node:http's (req, res). signIn chooses the bind address.
export function defaultCreateServer(handler) {
  return httpCreateServer(handler);
}

// ---------- session file ----------

function readSession(env) {
  try {
    const s = JSON.parse(readFileSync(sessionFile(env), 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

function sessionFromTokenResponse(data, { nowSec, fallbackEmail = null }) {
  const access = data.access_token;
  let expiresAt = Number.isFinite(data.expires_at) ? data.expires_at : null;
  if (!expiresAt && Number.isFinite(data.expires_in)) expiresAt = nowSec + data.expires_in;
  const claims = decodeJwtPayload(access) || {};
  if (!expiresAt && Number.isFinite(claims.exp)) expiresAt = claims.exp;
  const email = (data.user && typeof data.user.email === 'string' && data.user.email)
    || (typeof claims.email === 'string' && claims.email)
    || fallbackEmail
    || null;
  return {
    access_token: access,
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expires_at: expiresAt,
    email
  };
}

function writeSession(env, session) {
  writeDataFile(env, sessionFile(env), JSON.stringify(session));
}

// ---------- listener ----------

function bind(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

// Stops new connections. The page already being sent still finishes (it
// carries Connection: close), and node:http (Node 19+) drops idle sockets.
function closeServer(server) {
  try { server.close(); } catch { /* already closed */ }
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'close'
  });
  res.end(body);
}

// ---------- token requests ----------

// POST to the token endpoint with a timeout. An abort counts as a network
// failure. Returns { response, data } or null when the server was not reached.
async function tokenRequest(fetch, grant, body, fetchTimeoutMs) {
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(fetchTimeoutMs)
    });
    const data = await response.json().catch(() => null);
    return { response, data };
  } catch {
    return null;
  }
}

// ---------- public API ----------

// Opens the Google sign-in and waits for the loopback redirect. Resolves
// { ok: true, email } or { ok: false, error }. It does not print the email;
// the caller decides what to show.
export async function signIn({
  env = process.env,
  fetch = globalThis.fetch,
  openBrowser = defaultOpenBrowser,
  createServer = defaultCreateServer,
  print = (s) => process.stdout.write(`${s}\n`),
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  ports = LOOPBACK_PORTS
} = {}) {
  const { verifier, challenge } = createPkcePair();

  // The extension's flow carries no state parameter. What binds the code to
  // this sign-in is the PKCE verifier: Supabase exchanges a code only with the
  // verifier whose challenge started the flow, and the verifier never leaves
  // this process except in the exchange request. A code injected by anyone
  // else fails the exchange, so a callback counts only once its exchange
  // succeeds: a failed one gets a neutral page and the listener keeps waiting
  // for the real redirect, up to MAX_EXCHANGE_ATTEMPTS exchanges. One
  // exchange runs at a time; a callback that arrives meanwhile is refused.
  //
  // A callback with `error` (the user cancelled at Google or Supabase) ends
  // the sign-in at once. Any local process or web page can forge that
  // request and end a sign-in early; that is accepted, since the user only
  // has to run sign-in again, and it gains the forger nothing.
  let port = null;
  let settled = false;
  let exchanging = false;
  let attempts = 0;
  let lastError = null;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const settle = (result) => {
    if (settled) return;
    settled = true;
    finish(result);
  };

  // Resolves { ok: true, session } | { ok: false, error, final }.
  const exchange = async (code) => {
    const r = await tokenRequest(fetch, 'pkce', { auth_code: code, code_verifier: verifier }, fetchTimeoutMs);
    if (!r) return { ok: false, error: 'Sign-in could not reach the server. Check your connection and try again.' };
    const { response, data } = r;
    if (!response.ok || !data || typeof data.access_token !== 'string' || !data.access_token) {
      return { ok: false, error: `Sign-in was refused by the server (HTTP ${response.status}). Try again.` };
    }
    // A genuine token, just the wrong kind: the sign-in is over (A6).
    if (isClientToken(data.access_token)) return { ok: false, error: READ_ONLY_MESSAGE, final: true };
    return { ok: true, session: sessionFromTokenResponse(data, { nowSec: Math.floor(now() / 1000) }) };
  };

  const handler = (req, res) => {
    let url;
    try { url = new URL(req.url || '/', 'http://127.0.0.1'); } catch { url = null; }
    // The Host check refuses DNS-rebinding pages and any other name for us.
    const host = req.headers && req.headers.host;
    if (settled || req.method !== 'GET' || !url || url.pathname !== LOOPBACK_PATH
      || port === null || host !== `${LOOPBACK_HOST}:${port}`) {
      send(res, 400, PAGE_BAD);
      return;
    }
    if (url.searchParams.has('error')) {
      // The query text (error, error_description) is never echoed.
      send(res, 200, PAGE_CANCELLED);
      settle({ ok: false, error: CANCELLED_MESSAGE });
      return;
    }
    const code = url.searchParams.get('code');
    if (!code || !CODE_PATTERN.test(code)) {
      send(res, 400, PAGE_BAD);
      return;
    }
    if (exchanging || attempts >= MAX_EXCHANGE_ATTEMPTS) {
      send(res, 400, PAGE_RETRY);
      return;
    }
    attempts += 1;
    exchanging = true;
    exchange(code).then((r) => {
      exchanging = false;
      if (settled) { send(res, 400, PAGE_RETRY); return; }
      if (r.ok) {
        writeSession(env, r.session);
        send(res, 200, PAGE_OK);
        settle({ ok: true, email: r.session.email });
        return;
      }
      lastError = r.error;
      send(res, 400, PAGE_RETRY);
      if (r.final || attempts >= MAX_EXCHANGE_ATTEMPTS) settle({ ok: false, error: r.error });
    }, () => {
      exchanging = false;
      lastError = 'Sign-in failed. Try again.';
      send(res, 400, PAGE_RETRY);
      if (attempts >= MAX_EXCHANGE_ATTEMPTS) settle({ ok: false, error: lastError });
    });
  };

  let server = null;
  for (const p of ports) {
    const candidate = createServer(handler);
    try {
      await bind(candidate, p);
      server = candidate;
      const addr = typeof candidate.address === 'function' ? candidate.address() : null;
      port = addr && typeof addr === 'object' && addr.port ? addr.port : p;
      break;
    } catch {
      closeServer(candidate);
    }
  }
  if (!server) {
    return { ok: false, error: `Sign-in needs one of ports ${ports.join(', ')} on 127.0.0.1, and all are in use.` };
  }

  const authorizeUrl = buildAuthorizeUrl({ port, challenge });
  print('Opening your browser to sign in with Google. If it does not open, visit this address:');
  print(authorizeUrl);
  try { openBrowser(authorizeUrl); } catch { /* the printed URL still works */ }

  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  let result = await Promise.race([finished, timedOut]);
  clearTimeout(timer);
  if (!result) {
    // Marks the flow over, so an exchange still running writes nothing.
    settle(null);
    const minutes = Math.max(1, Math.round(timeoutMs / 60000));
    result = lastError
      ? { ok: false, error: lastError }
      : { ok: false, error: `Sign-in timed out after ${minutes} minute${minutes === 1 ? '' : 's'}. Run sign-in again.` };
  }
  closeServer(server);
  if (result.ok) print('Signed in.');
  return result;
}

function usableToken(session, nowSec) {
  if (!session || typeof session.access_token !== 'string' || !session.access_token) return null;
  if (isClientToken(session.access_token)) return null;
  const expiresAt = Number.isFinite(session.expires_at) ? session.expires_at : decodeJwtPayload(session.access_token)?.exp;
  return Number.isFinite(expiresAt) && expiresAt - REFRESH_MARGIN_SECONDS > nowSec ? session.access_token : null;
}

// A usable access token, refreshed first when it expires within 60 seconds.
// Null when signed out, when the refresh fails, or for a connector token.
// A failed refresh deletes nothing, so a later call can try again.
export async function getAccessToken({
  env = process.env,
  fetch = globalThis.fetch,
  now = Date.now,
  fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS
} = {}) {
  const session = readSession(env);
  if (!session || typeof session.access_token !== 'string' || !session.access_token) return null;
  if (isClientToken(session.access_token)) return null;

  const nowSec = Math.floor(now() / 1000);
  const fresh = usableToken(session, nowSec);
  if (fresh) return fresh;
  if (typeof session.refresh_token !== 'string' || !session.refresh_token) return null;

  // Refresh tokens rotate, so two processes refreshing at once both send the
  // same one and only one wins. The loser re-reads the file once: if the
  // winner has written a different, unexpired token, that one is used.
  const fromOtherProcess = () => {
    const now2 = readSession(env);
    if (!now2 || now2.access_token === session.access_token) return null;
    return usableToken(now2, nowSec);
  };

  const r = await tokenRequest(fetch, 'refresh_token', { refresh_token: session.refresh_token }, fetchTimeoutMs);
  if (!r || !r.response.ok) return fromOtherProcess();
  const { data } = r;
  if (!data || typeof data.access_token !== 'string' || !data.access_token) return fromOtherProcess();
  if (isClientToken(data.access_token)) return null;

  const next = sessionFromTokenResponse(data, { nowSec, fallbackEmail: session.email || null });
  if (!next.refresh_token) next.refresh_token = session.refresh_token;
  writeSession(env, next);
  return next.access_token;
}

// Deletes the session file. True when there was one.
export function signOut({ env = process.env } = {}) {
  const file = sessionFile(env);
  const had = existsSync(file);
  rmSync(file, { force: true });
  return had;
}

// The signed-in account's email, or null. For local display only.
export function whoAmI({ env = process.env } = {}) {
  const s = readSession(env);
  return s && typeof s.email === 'string' && s.email ? s.email : null;
}
