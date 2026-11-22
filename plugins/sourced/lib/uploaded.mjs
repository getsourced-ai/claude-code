// Turns this install has already saved (plan Task 13, U6): uploaded.json in
// the plugin data folder, { v: 1, turns: [{ conversation_id, payload_hash,
// at, code? }] }, newest last and capped at the newest UPLOADED_CAP entries. Written
// through writeDataFile. Built with Task 13 to owner gates G1 and G9, both
// answered 2026-11-15.
//
// A turn counts as saved by its conversation_id alone: a finished turn's
// content does not change, and the payload hash also covers the install id,
// which a new install.json would change. A missing file reads as empty. A
// file that exists but cannot be read as this shape, or that holds any
// malformed entry, is 'unreadable': analyze
// and upload then refuse rather than risk a second upload, and
// recordUploaded will not overwrite it.
//
// code is the upload code that saved the turn (added after owner check O3,
// 2026-11-20), so upload can say a used code's turn is already saved rather
// than that no upload is waiting. Entries written before it have no code.
//
// Imports only node:fs and plugin/lib files: no network module.
//
// Exports:
//   UPLOADED_VERSION, UPLOADED_CAP
//   UploadedUnreadableError
//   readUploaded(env)                   -> { v, turns, unreadable }
//   savedState(env, conversationId)     -> 'saved' | 'not-saved' | 'unreadable'
//   isUploaded(env, conversationId)     -> boolean (unreadable counts as saved)
//   savedConversationIds(env)           -> Set of conversation ids (for list)
//   savedByCode(env, code)              -> boolean (a turn was saved with it)
//   recordUploaded(env, { conversation_id, payload_hash, at, code })  (throws
//                                          UploadedUnreadableError on an
//                                          unreadable file)
import { readFileSync } from 'node:fs';
import { uploadedFile, writeDataFile } from './paths.mjs';
import { isConfirmCode } from './ids.mjs';

export const UPLOADED_VERSION = 1;
export const UPLOADED_CAP = 20000;

export class UploadedUnreadableError extends Error {
  constructor() {
    super('uploaded.json cannot be read');
    this.name = 'UploadedUnreadableError';
  }
}

const isEntry = (e) =>
  e !== null &&
  typeof e === 'object' &&
  typeof e.conversation_id === 'string' &&
  typeof e.payload_hash === 'string' &&
  typeof e.at === 'string' &&
  (e.code === undefined || isConfirmCode(e.code));

export function readUploaded(env) {
  let text;
  try {
    text = readFileSync(uploadedFile(env), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { v: UPLOADED_VERSION, turns: [], unreadable: false };
    return { v: UPLOADED_VERSION, turns: [], unreadable: true };
  }
  try {
    const data = JSON.parse(text);
    if (data?.v !== UPLOADED_VERSION || !Array.isArray(data.turns)) return { v: UPLOADED_VERSION, turns: [], unreadable: true };
    // One malformed entry makes the whole file unreadable: dropping it
    // silently could offer a saved turn again (U6).
    if (!data.turns.every(isEntry)) return { v: UPLOADED_VERSION, turns: [], unreadable: true };
    return { v: UPLOADED_VERSION, turns: data.turns, unreadable: false };
  } catch {
    return { v: UPLOADED_VERSION, turns: [], unreadable: true };
  }
}

export function savedState(env, conversationId) {
  const read = readUploaded(env);
  if (read.unreadable) return 'unreadable';
  return read.turns.some((e) => e.conversation_id === conversationId) ? 'saved' : 'not-saved';
}

export function isUploaded(env, conversationId) {
  return savedState(env, conversationId) !== 'not-saved';
}

export function savedConversationIds(env) {
  return new Set(readUploaded(env).turns.map((e) => e.conversation_id));
}

export function savedByCode(env, code) {
  return isConfirmCode(code) && readUploaded(env).turns.some((e) => e.code === code);
}

export function recordUploaded(env, { conversation_id, payload_hash, at, code }) {
  const entry = code === undefined ? { conversation_id, payload_hash, at } : { conversation_id, payload_hash, at, code };
  if (!isEntry(entry)) throw new TypeError('recordUploaded: bad entry');
  const read = readUploaded(env);
  if (read.unreadable) throw new UploadedUnreadableError();
  const turns = read.turns.filter((e) => e.conversation_id !== conversation_id);
  turns.push(entry);
  const kept = turns.slice(-UPLOADED_CAP);
  writeDataFile(env, uploadedFile(env), `${JSON.stringify({ v: UPLOADED_VERSION, turns: kept })}\n`);
  return entry;
}
