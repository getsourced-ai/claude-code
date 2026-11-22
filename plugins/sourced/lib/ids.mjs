// Id checks. Every id that reaches a path or a payload passes one of these
// first; a value that fails is dropped, never joined into a path.
import { randomInt } from 'node:crypto';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const CONFIRM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

// 32 characters: A-Z without I and O, then 2-9 (no 0 or 1).
export const CONFIRM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const test = (re) => (value) => typeof value === 'string' && re.test(value);

export const isSessionId = test(SESSION_ID);
export const isPromptId = test(SAFE_ID);
export const isToolUseId = test(SAFE_ID);
export const isConfirmCode = test(CONFIRM_CODE);

// randomInt draws without modulo bias.
export function newConfirmCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CONFIRM_ALPHABET[randomInt(CONFIRM_ALPHABET.length)];
  return code;
}
