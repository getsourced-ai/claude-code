// The plugin's command line (plan Task 13, and the `doctor` subcommand of
// Task 18): argument parsing and dispatch. plugin/bin/sourced.mjs
// only calls runCli with real values; tests call it directly with stubs.
// Built with Task 13 to owner gates G1 and G9, both answered 2026-11-15.
//
// Exports:
//   COMMAND_PREFIX  '/sourced:' (the name Sourced, owner decision 2026-11-19)
//   USAGE           the usage text
//   CLI_TEXT        the other user-facing strings here
//   parseArgs(argv) -> { ok: true, command, flags, positionals, dataDir }
//                    | { ok: false, error }
//       dataDir: the value of a leading `--data-dir <folder>`, or undefined.
//       That option is accepted only before the command, where every command
//       file puts it, so text the user types after the command cannot move
//       the data folder.
//   runCli(argv, { env, fetch, print, now, root, cwd, openBrowser,
//                  createServer, sleep }) -> Promise<exit code>  (0 ok, 1
//                  refused or failed, 2 bad arguments)
//       cwd: the working directory (process.cwd() by default), which names
//       the current project for list, analyze and doctor (paths.currentProject).
//       list and analyze cover only the current project unless --all is given.
//
// Only `upload` and `signin` are given `fetch`. list, analyze, doctor,
// cancel, whoami, signout and help never see it (U1). auth.mjs (which loads
// node:http and the browser opener) and upload.mjs are imported only when a
// command needs them, so the static imports below hold no network module.
// Every run first deletes pending uploads older than 15 minutes.
import { sweepPending, deletePending, deleteAllPending, isSending } from './pending.mjs';
import { isConfirmCode, isSessionId, isPromptId } from './ids.mjs';
import { resolveDataDir, BAD_DATA_DIR, currentProject } from './paths.mjs';
import { NUDGE_TEXT, nudgeEnabled, setNudge } from './nudge.mjs';
import { listCommand, analyzeCommand, cleanLine } from './analyze.mjs';
import { doctorReport } from './doctor.mjs';

export const COMMAND_PREFIX = '/sourced:';

export const USAGE = [
  'Usage: sourced <command>',
  '',
  'Commands:',
  '  list [--since <N>d|<N>h|all] [--all] List recent search turns in this project, newest first, numbered.',
  '                                       --all lists every project; --since all lists any time.',
  '  analyze [<number> | --last] [--since <N>d|<N>h|all] [--all]',
  '                                       Show one turn and its upload preview. Sends nothing.',
  '  analyze --session <id> [--turn <key>]',
  '  upload <code>                        Upload the one turn that analyze showed with this code.',
  '  cancel [<code>]                      Drop a waiting upload, or all of them. Sends nothing.',
  '  signin                               Sign in with Google.',
  '  signout                              Sign out and delete the sign-in file.',
  '  whoami                               Show the signed-in account.',
  '  nudge [on | off]                     Show, or turn on or off, the one line after a turn that searched.',
  '  doctor                               Check the plugin\'s files and the transcript format. Sends nothing.',
  '  help                                 Show this text.',
  '',
  'Option, before the command:',
  '  --data-dir <folder>                  The plugin data folder. The command files pass the one Claude Code names.',
  '',
  'Each upload sends one turn. No command uploads more than one.'
].join('\n');

export const CLI_TEXT = Object.freeze({
  unknownCommand: 'Unknown command.',
  noCommand: 'No command given.',
  unknownFlag: 'Unknown option for {command}.',
  repeatedFlag: 'An option was given twice.',
  missingValue: 'An option needs a value.',
  tooManyArgs: 'Too many arguments for {command}.',
  oneTurn: 'upload takes exactly one code. Each upload sends one turn, and no command uploads more than one.',
  uploadNeedsCode: 'upload needs the code that analyze printed.',
  badSince: '--since takes a number of days or hours, like 7d or 12h, or all.',
  scopeWithSession: '--all and --since go with a list number or --last, not with --session.',
  scopeNeedsPick: '--all and --since go with a list number or --last, like analyze 2 --all.',
  badNumber: 'analyze takes one turn number from the list, like 2.',
  badSession: "That session id isn't valid.",
  badTurn: "That turn key isn't valid.",
  turnNeedsSession: '--turn needs --session.',
  lastWithTurn: '--last picks the newest turn, so it does not go with --turn or a number.',
  numberWithSession: 'A list number does not go with --session.',
  badCode: "That isn't an upload code. A code is six capital letters and digits, as analyze printed it.",
  cancelledOne: 'Cancelled. Nothing was uploaded.',
  cancelledMany: 'Cancelled {n} waiting uploads. Nothing was uploaded.',
  cancelledNoneCode: 'No upload is waiting for that code.',
  cancelledNone: 'No uploads are waiting.',
  cancelSending: "This upload is already being sent, so it can't be cancelled. If nothing is uploading, run {prefix}analyze again for a new code.",
  signedInAs: 'Signed in as {email}.',
  signedIn: 'Signed in.',
  notSignedIn: 'Not signed in.',
  signedOut: 'Signed out.',
  badDataDir: BAD_DATA_DIR,
  unexpected: 'Sourced stopped on an unexpected error. Nothing was uploaded.'
});

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

// value: the flag takes the next argument. bool: it takes none.
const COMMANDS = {
  list: { flags: { '--since': 'value', '--all': 'bool' }, positionals: 0 },
  analyze: { flags: { '--session': 'value', '--turn': 'value', '--last': 'bool', '--since': 'value', '--all': 'bool' }, positionals: 1 },
  upload: { flags: {}, positionals: 1 },
  cancel: { flags: {}, positionals: 1 },
  signin: { flags: {}, positionals: 0 },
  signout: { flags: {}, positionals: 0 },
  whoami: { flags: {}, positionals: 0 },
  doctor: { flags: {}, positionals: 0 },
  nudge: { flags: {}, positionals: 1 },
  help: { flags: {}, positionals: 0 }
};

// A request for more than one turn: a list, a range, or "all".
const looksLikeMany = (s) => /[,\s]/.test(s) || /^\d+\s*-\s*\d+$/.test(s) || /^-?-?all$/i.test(s);

export function parseArgs(argv) {
  let args = Array.isArray(argv) ? argv.map(String) : [];
  let dataDir;
  while (args[0] === '--data-dir') {
    if (dataDir !== undefined) return { ok: false, error: CLI_TEXT.repeatedFlag };
    if (args.length < 2) return { ok: false, error: CLI_TEXT.missingValue };
    dataDir = args[1];
    args = args.slice(2);
  }
  const parsed = parseCommand(args);
  return parsed.ok ? { ...parsed, dataDir } : parsed;
}

function parseCommand(args) {
  if (!args.length) return { ok: false, error: CLI_TEXT.noCommand };
  const [command, ...rest] = args;
  const spec = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : null;
  if (!spec) return { ok: false, error: CLI_TEXT.unknownCommand };

  // upload: exactly one code and nothing else (U11).
  if (command === 'upload') {
    if (!rest.length) return { ok: false, error: CLI_TEXT.uploadNeedsCode };
    if (rest.length > 1 || rest[0].startsWith('-') || looksLikeMany(rest[0])) return { ok: false, error: CLI_TEXT.oneTurn };
    return { ok: true, command, flags: {}, positionals: rest };
  }

  const flags = {};
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-')) {
      const kind = Object.prototype.hasOwnProperty.call(spec.flags, a) ? spec.flags[a] : null;
      if (!kind) return { ok: false, error: fill(CLI_TEXT.unknownFlag, { command }) };
      if (a in flags) return { ok: false, error: CLI_TEXT.repeatedFlag };
      if (kind === 'bool') {
        flags[a] = true;
      } else {
        const v = rest[i + 1];
        if (v === undefined || v.startsWith('-')) return { ok: false, error: CLI_TEXT.missingValue };
        flags[a] = v;
        i += 1;
      }
      continue;
    }
    positionals.push(a);
  }
  if (positionals.length > spec.positionals) return { ok: false, error: fill(CLI_TEXT.tooManyArgs, { command }) };
  return { ok: true, command, flags, positionals };
}

const SINCE = /^([1-9]\d{0,3})([dh])$/;

// Turns parsed arguments into command options, or an error (exit 2).
// --since and --all, shared by list and analyze. scopeArgs repeats them, so
// the list's last line names the analyze command whose numbers agree.
function windowAndScope(flags, nowMs) {
  const out = { since: undefined, anyTime: false, allProjects: flags['--all'] === true, scopeArgs: '' };
  const raw = flags['--since'];
  if (raw !== undefined) {
    if (raw.toLowerCase() === 'all') {
      out.anyTime = true;
      out.scopeArgs += ' --since all';
    } else {
      const m = SINCE.exec(raw);
      if (!m) return { error: CLI_TEXT.badSince };
      const unit = m[2] === 'd' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
      out.since = nowMs - Number(m[1]) * unit;
      out.scopeArgs += ` --since ${raw}`;
    }
  }
  if (out.allProjects) out.scopeArgs += ' --all';
  return out;
}

function optionsFor(parsed, nowMs) {
  const { command, flags, positionals } = parsed;
  if (command === 'list') return windowAndScope(flags, nowMs);
  if (command === 'analyze') {
    const scoped = flags['--since'] !== undefined || flags['--all'] === true;
    if (scoped && flags['--session'] !== undefined) return { error: CLI_TEXT.scopeWithSession };
    // "analyze --all" alone could read as "analyze every turn", so it is refused.
    if (scoped && positionals[0] === undefined && !flags['--last']) return { error: CLI_TEXT.scopeNeedsPick };
    const ws = windowAndScope(flags, nowMs);
    if (ws.error) return ws;
    const sessionId = flags['--session'];
    const turnKey = flags['--turn'];
    const n = positionals[0];
    if (n !== undefined && looksLikeMany(n)) return { error: CLI_TEXT.oneTurn };
    if (n !== undefined && !/^[1-9]\d{0,5}$/.test(n)) return { error: CLI_TEXT.badNumber };
    if (flags['--last'] && (turnKey !== undefined || n !== undefined)) return { error: CLI_TEXT.lastWithTurn };
    if (turnKey !== undefined && sessionId === undefined) return { error: CLI_TEXT.turnNeedsSession };
    if (n !== undefined && sessionId !== undefined) return { error: CLI_TEXT.numberWithSession };
    if (sessionId !== undefined && !isSessionId(sessionId)) return { error: CLI_TEXT.badSession };
    if (turnKey !== undefined && !isPromptId(turnKey)) return { error: CLI_TEXT.badTurn };
    return {
      ...ws,
      sessionId: sessionId === undefined ? undefined : sessionId.toLowerCase(),
      turnKey,
      index: n === undefined ? undefined : Number(n)
    };
  }
  if (command === 'nudge') {
    const v = positionals[0]?.toLowerCase();
    if (v !== undefined && v !== 'on' && v !== 'off') return { error: NUDGE_TEXT.badValue };
    return { nudge: v };
  }
  if (command === 'upload' || command === 'cancel') {
    const raw = positionals[0];
    return { code: raw === undefined ? undefined : raw.toUpperCase() };
  }
  return {};
}

const defaultPrint = (s) => process.stdout.write(`${s}\n`);

export async function runCli(argv, {
  env = process.env,
  fetch = globalThis.fetch,
  print = defaultPrint,
  now = Date.now,
  root,
  cwd = process.cwd(),
  openBrowser,
  createServer,
  sleep
} = {}) {
  const nowFn = typeof now === 'function' ? now : () => now;
  const out = (s) => print(String(s));
  const prefix = COMMAND_PREFIX;
  try {
    const parsed = parseArgs(argv);
    if (!parsed.ok) {
      out(parsed.error);
      out('');
      out(USAGE);
      return 2;
    }
    const data = resolveDataDir(env, parsed.dataDir);
    if (!data.ok) {
      out(data.error);
      out('');
      out(USAGE);
      return 2;
    }
    env = data.env;
    sweepPending(env, { now: nowFn() });

    const opts = optionsFor(parsed, nowFn());
    if (opts.error) {
      out(opts.error);
      out('');
      out(USAGE);
      return 2;
    }

    // The project list and analyze cover by default, and doctor's transcript
    // check prefers.
    const scopeOf = (o) => {
      if (o.allProjects) return { all: true };
      const p = currentProject({ env, root, cwd });
      return p.ok ? { project: p.name } : {};
    };

    switch (parsed.command) {
      case 'help':
        out(USAGE);
        return 0;
      case 'list':
        return listCommand({ since: opts.since, anyTime: opts.anyTime, scope: scopeOf(opts), scopeArgs: opts.scopeArgs, env, root, now: nowFn, print: out, prefix });
      case 'analyze': {
        const { allProjects, ...rest } = opts;
        return analyzeCommand({ ...rest, scope: rest.sessionId ? {} : scopeOf(opts), env, root, now: nowFn, print: out, prefix });
      }
      case 'doctor': {
        const { text } = doctorReport({ env, root, now: nowFn(), dataSource: data, project: scopeOf({}).project ?? null });
        out(text.replace(/\n$/, ''));
        return 0;
      }
      case 'nudge': {
        if (opts.nudge === undefined) {
          out(nudgeEnabled(env) ? NUDGE_TEXT.stateOn : NUDGE_TEXT.stateOff);
          return 0;
        }
        out(setNudge(env, opts.nudge === 'on') ? NUDGE_TEXT.turnedOn : NUDGE_TEXT.turnedOff);
        return 0;
      }
      case 'cancel': {
        if (opts.code === undefined) {
          const n = deleteAllPending(env);
          out(n === 0 ? CLI_TEXT.cancelledNone : n === 1 ? CLI_TEXT.cancelledOne : fill(CLI_TEXT.cancelledMany, { n }));
          return 0;
        }
        if (!isConfirmCode(opts.code)) {
          out(CLI_TEXT.badCode);
          return 1;
        }
        if (isSending(env, opts.code)) {
          out(fill(CLI_TEXT.cancelSending, { prefix }));
          return 1;
        }
        if (deletePending(env, opts.code)) {
          out(CLI_TEXT.cancelledOne);
          return 0;
        }
        out(CLI_TEXT.cancelledNoneCode);
        return 1;
      }
      case 'upload': {
        const { uploadCommand } = await import('./upload.mjs');
        return await uploadCommand({ code: opts.code, env, root, fetch, print: out, now: nowFn, prefix, ...(sleep ? { sleep } : {}) });
      }
      case 'signin': {
        const { signIn } = await import('./auth.mjs');
        // signIn prints "Signed in." itself; this command prints the account.
        const quiet = (s) => {
          if (s !== CLI_TEXT.signedIn) out(s);
        };
        const result = await signIn({
          env,
          fetch,
          now: nowFn,
          print: quiet,
          ...(openBrowser ? { openBrowser } : {}),
          ...(createServer ? { createServer } : {})
        });
        if (!result?.ok) {
          out(result?.error || CLI_TEXT.unexpected);
          return 1;
        }
        out(result.email ? fill(CLI_TEXT.signedInAs, { email: cleanLine(result.email) }) : CLI_TEXT.signedIn);
        return 0;
      }
      case 'signout': {
        const { signOut } = await import('./auth.mjs');
        signOut({ env });
        out(CLI_TEXT.signedOut);
        return 0;
      }
      case 'whoami': {
        const { whoAmI } = await import('./auth.mjs');
        const email = whoAmI({ env });
        out(email ? fill(CLI_TEXT.signedInAs, { email: cleanLine(email) }) : CLI_TEXT.notSignedIn);
        return 0;
      }
      default:
        out(CLI_TEXT.unknownCommand);
        out(USAGE);
        return 2;
    }
  } catch {
    out(CLI_TEXT.unexpected);
    return 1;
  }
}
