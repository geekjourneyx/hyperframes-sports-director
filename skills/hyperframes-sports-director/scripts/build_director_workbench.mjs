#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { buildDirectorWorkbench } from './lib/director-workbench.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { project } = parseCliArguments(process.argv.slice(2), { project: { required: true } });
    process.stdout.write(`${JSON.stringify(await buildDirectorWorkbench(project))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
