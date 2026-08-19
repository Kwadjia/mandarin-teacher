/**
 * Start everything needed for a study session, with one command.
 *
 *   npm start
 *
 * There are two processes, and forgetting the second is easy: the app on :8787, and
 * the local speech scorer on :8790 that the Speak tab needs. Neither survives a reboot
 * — they are foreground processes, not services — and starting only the app leaves
 * speaking silently unavailable with nothing on screen explaining why until you open
 * the tab.
 *
 * The scorer is optional on purpose. If Python or the model is missing, this says so
 * and carries on: listening, the quiz and dictation all work without it, and refusing
 * to start the app over a missing GPU dependency would be the wrong trade.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENV = join(REPO, '.venv', 'Scripts', 'python.exe');
const children = [];

function run(name, command, args, colour) {
  const child = spawn(command, args, { cwd: REPO, shell: true });
  const tag = `\x1b[${colour}m${name.padEnd(6)}\x1b[0m`;
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) console.log(`${tag} ${line}`);
    });
  }
  children.push(child);
  return child;
}

if (existsSync(VENV) && existsSync(join(REPO, 'pipeline', 'speech_server.py'))) {
  run('speech', VENV, ['pipeline/speech_server.py'], '35');
} else {
  console.log(
    '\x1b[33mspeech\x1b[0m no Python environment at .venv — the Speak tab will be off.\n' +
      '       Everything else works. To enable it:  py -3.11 -m venv .venv && ' +
      '.venv\Scripts\pip install -r pipeline/requirements.txt',
  );
}

// The app is started second and unconditionally: it is the thing worth having up.
run('app', 'npm', ['run', 'study'], '36');

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
