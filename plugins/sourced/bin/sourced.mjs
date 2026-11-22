#!/usr/bin/env node
// The plugin's command-line entry (plan Task 13). All logic is in
// lib/cli.mjs; this file only hands runCli the real environment, network,
// output and clock, and sets the exit code.
import { runCli } from '../lib/cli.mjs';

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  print: (s) => process.stdout.write(`${s}\n`),
  now: Date.now
});
