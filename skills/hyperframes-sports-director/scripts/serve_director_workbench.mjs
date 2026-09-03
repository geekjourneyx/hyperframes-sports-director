#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { startWorkbenchServer } from './lib/director-workbench.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArguments(process.argv.slice(2), {
      project: { required: true }, port: { type: 'number' }, 'ttl-seconds': { key: 'ttlSeconds', type: 'number' },
    });
    const server = await startWorkbenchServer({
      projectRoot: options.project, port: options.port ?? 0,
      ttlMs: options.ttlSeconds === undefined ? undefined : options.ttlSeconds * 1000,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, url: server.url, expiresAt: server.expiresAt })}\n`);
    const stop = async () => { await server.close(); process.exit(0); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
