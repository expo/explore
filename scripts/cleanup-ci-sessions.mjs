#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Stop only exact sessions whose ownership the capture coordinator already verified. */
export async function cleanupCiSessions({ sessionFiles, easCommand, environment = process.env, runCommand = spawnSync }) {
  // head, base and baseline, each with a session per appearance pass (light, dark) beside its own.
  if (!Array.isArray(sessionFiles) || sessionFiles.length > 9) throw new Error('Provide at most nine explicit session handoff files.');
  const temporary = await realpath(environment.RUNNER_TEMP || tmpdir());
  const result = { stopped: [], failures: [] };
  let project;
  try {
    for (const path of sessionFiles) {
      let sessionId;
      try {
        if (!isAbsolute(path)) throw new Error('Session handoff paths must be absolute.');
        let info;
        try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        const canonical = await realpath(path);
        const local = relative(temporary, canonical);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 256
          || !local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)
          || typeof process.getuid === 'function' && info.uid !== process.getuid()) {
          throw new Error('Refusing an unsafe session handoff.');
        }
        const source = await readFile(path, 'utf8');
        sessionId = source.trim();
        if (!SESSION_ID.test(sessionId)) { sessionId = undefined; throw new Error('Refusing an invalid session ID.'); }
        if (!environment.EXPO_TOKEN?.trim()) throw new Error('Pass EXPO_TOKEN to the cleanup step.');
        if (!isAbsolute(easCommand)) throw new Error('Use the absolute pinned EAS CLI path.');
        if (!project) {
          project = await mkdtemp(join(temporary, 'explore-cleanup-'));
          await writeFile(join(project, 'package.json'), '{}\n', { mode: 0o600 });
          await writeFile(join(project, 'app.json'), '{"expo":{"name":"Explore cleanup","slug":"explore-cleanup"}}\n', { mode: 0o600 });
        }
        const env = { CI: 'true', EXPO_TOKEN: environment.EXPO_TOKEN };
        for (const name of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'USER', 'SYSTEMROOT']) {
          if (environment[name] !== undefined) env[name] = environment[name];
        }
        const stopped = runCommand(easCommand, ['simulator:stop', '--id', sessionId, '--json', '--non-interactive'], {
          cwd: project, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
        });
        if (stopped.error || stopped.status !== 0) throw new Error('The stop command failed or timed out; stop this exact session manually and verify its status.');
        let response;
        try { response = JSON.parse(stopped.stdout); } catch { throw new Error('The stop command did not return a valid confirmation.'); }
        if (response.id !== sessionId || response.status !== 'STOPPED') throw new Error('The stop response did not confirm this exact session is STOPPED.');
        if (await readFile(path, 'utf8') !== source) throw new Error('The session handoff changed during cleanup.');
        await rm(path);
        result.stopped.push(sessionId);
      } catch (error) {
        result.failures.push({ code: 'SESSION_CLEANUP_FAILED', ...(sessionId ? { sessionId } : {}),
          message: error instanceof Error ? error.message : 'Session cleanup failed.',
          nextAction: sessionId ? `Stop EAS Simulator session ${sessionId} and verify its status.` : 'Inspect the invalid handoff before stopping any session.' });
      }
    }
  } finally {
    if (project) await rm(project, { recursive: true, force: true });
  }
  return result;
}

async function main() {
  const options = { sessionFiles: [], easCommand: '' };
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!value || !['--session-file', '--eas'].includes(name)) throw new Error('Expected --eas PATH and explicit --session-file PATH arguments.');
    if (name === '--eas') options.easCommand = resolve(value);
    else options.sessionFiles.push(value);
  }
  const result = await cleanupCiSessions(options);
  for (const sessionId of result.stopped) process.stdout.write(`Confirmed retained EAS session ${sessionId} is STOPPED.\n`);
  if (!result.failures.length) return;
  for (const failure of result.failures) {
    process.stderr.write(`::error title=SESSION_CLEANUP_FAILED::${failure.message} ${failure.nextAction}\n`);
  }
  const diagnostics = join(process.env.RUNNER_TEMP || tmpdir(), 'explore-diagnostics');
  await mkdir(diagnostics, { recursive: true });
  await writeFile(join(diagnostics, 'cleanup.json'), `${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    process.stderr.write('::error title=SESSION_CLEANUP_FAILED::Could not safely complete retained-session cleanup. Inspect the handoff and stop only the recorded session.\n');
    process.exitCode = 1;
  });
}
