#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { compileDirectionProposals } from './lib/direction-proposals.mjs';

export async function compileDirectionProposalsFromFile({ project, candidates }) {
  const candidateDrafts = JSON.parse(await readFile(candidates, 'utf8'));
  return compileDirectionProposals({ projectRoot: project, candidates: candidateDrafts });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArguments(process.argv.slice(2), { project: { required: true }, candidates: { required: true } });
    const result = await compileDirectionProposalsFromFile(options);
    process.stdout.write(`${JSON.stringify({ ok: true, artifact: 'direction/DIRECTION_PROPOSALS.json', digest: result.integrity.digest, candidateCount: result.candidates.length })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
