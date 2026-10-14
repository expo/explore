import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { startReportViewer } from './lib/report-viewer.mjs';

// --free-port is for scripts and tests: without it the Viewer keeps Vite's usual port (5173 and up),
// so a developer's bookmarked tab still finds it.
const { values } = parseArgs({ options: { run: { type: 'string' }, zip: { type: 'string' }, 'no-watch': { type: 'boolean' }, 'free-port': { type: 'boolean' } } });
if (!values.run && !values.zip) throw new Error('Use --run RUN_DIRECTORY or --zip REPORT.zip');
const run = values.run ? resolve(values.run) : undefined;
const metadata = run ? JSON.parse(await readFile(resolve(run, 'run.json'), 'utf8')) : undefined;
if (run && !metadata.report && !values.zip) throw new Error('This run produced no report. Read its run.json and logs.');
const zip = resolve(values.zip ?? resolve(run, metadata.report.path));
let bytes;
try { bytes = await readFile(zip); } catch { throw new Error(`Report missing: ${zip}. Restore the original ZIP or supply --zip; viewing never reruns CI.`); }
if (metadata?.report && createHash('sha256').update(bytes).digest('hex') !== metadata.report.sha256) throw new Error('Report digest differs from the recorded run.');
const { server, url } = await startReportViewer({ bytes, watch: !values['no-watch'], port: values['free-port'] ? 'free' : 0 });
console.log(`Viewer: ${url}`);
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async () => { await server.close(); });
