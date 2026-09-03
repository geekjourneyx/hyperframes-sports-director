#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { recordDirectorApproval } from './lib/director-workbench.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArguments(process.argv.slice(2), { project: { required: true }, request: { required: true } });
    const request = JSON.parse(await readFile(options.request, 'utf8'));
    const result = await recordDirectorApproval({ ...request, projectRoot: options.project });
    process.stdout.write(`${JSON.stringify({ ok: true, artifact: 'direction/DIRECTOR_APPROVAL.json', digest: result.approval.integrity.digest })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
