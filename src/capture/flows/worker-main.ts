/** The flows worker's entry: `node worker-main.js <request.json>`. */
import { runFlowsWorker } from "./worker.js";

const requestPath = process.argv[2];
if (!requestPath) { console.error("usage: flows worker <request.json>"); process.exit(2); }
try { await runFlowsWorker(requestPath); }
catch (error) { console.error((error as Error).stack ?? String(error)); process.exitCode = 1; }
