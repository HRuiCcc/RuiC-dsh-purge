#!/usr/bin/env node
import fs from 'node:fs/promises';
import { run, readPrompt, savePrompt } from '../lib/service.js';
import { version } from '../lib/version.js';

const help = `RuiC-dsh-purge ${version}
Usage: ruic-dsh-purge <command> [options]

  status / selfcheck      Inspect patch evidence and unfinished operations
  plan                   Preview files, SHA256 hashes and patch matches
  apply [--dry-run]       Preflight, snapshot, then apply matched profile
  snapshots              List retained local snapshots
  revert <id> [--dry-run] Restore a snapshot if current files still match
  prompt                 Read RuiC's saved prompt
  prompt --file <path>    Import UTF-8 text (max 128 KiB)

  --base <path>          DSH package directory, .app or ASAR (or DSH_BASE)
  --home <path>          DSH data directory (or DSH_HOME)
  --shim-dir <path>      Explicitly include Windows dsh.cmd and dsh.ps1
  --json                 Machine-readable JSON; failures exit nonzero
  --help / --version

Default is read-only status. Restart DSH manually after apply/revert.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  if (args.includes('--version')) { console.log(version); return; }
  const options = {}, positionals = [];
  let json = false, file;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--dry-run') { options.dryRun = true; continue; }
    if (['--base', '--home', '--shim-dir', '--file'].includes(a)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${a}`);
      if (a === '--file') file = value;
      else options[a === '--shim-dir' ? 'shimDir' : a.slice(2)] = value;
    } else if (['--status', '--apply', '--revert'].includes(a)) positionals.push(a.slice(2));
    else if (a.startsWith('-')) throw new Error(`Unknown option ${a}`);
    else positionals.push(a);
  }
  const [command = 'status', argument] = positionals;
  if (positionals.length > (command === 'revert' ? 2 : 1)) throw new Error('Unexpected positional argument');
  if (file && command !== 'prompt') throw new Error('--file is only valid for prompt');
  if (options.dryRun && !['apply', 'revert'].includes(command)) throw new Error('--dry-run is only valid for apply/revert');
  let result;
  if (command === 'prompt') {
    const previous = await readPrompt(options);
    result = file ? await savePrompt(await fs.readFile(file, 'utf8'), previous.hash, options) : previous;
  } else result = await run(command, options, argument);
  if (!json) console.log(`RuiC-dsh-purge · ${command} · ${result.ok ? 'OK' : 'FAILED'}`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
main().catch(e => {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exitCode = 1;
});
