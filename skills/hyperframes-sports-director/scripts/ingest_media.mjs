import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateDocument } from './lib/contracts.mjs';
import { buildMediaRecords, projectPath, resolveRoots, writeJsonAtomic } from './lib/media.mjs';

async function nextRevision(path) {
  try {
    const prior = JSON.parse(await readFile(path, 'utf8'));
    return Number.isInteger(prior.revision) ? prior.revision + 1 : 1;
  } catch {
    return 1;
  }
}

export async function ingestMedia(options) {
  const { project, input } = await resolveRoots(options.project, options.input);
  const records = await buildMediaRecords(input);
  const artifactPath = projectPath(project, 'analysis/MEDIA_INDEX.json');
  const document = {
    $schema: 'https://hyperframes.local/schemas/media-index.schema.json',
    schemaVersion: '1.0.0',
    revision: await nextRevision(artifactPath),
    entries: records.map(({ sourcePath, ...entry }) => entry),
    integrity: { digest: null, upstream: {} },
  };
  document.integrity.digest = computeArtifactDigest(document);
  const validation = validateDocument(await loadSchema('media-index'), document);
  if (!validation.valid) {
    const error = new Error(`MEDIA_INDEX validation failed: ${JSON.stringify(validation.errors)}`);
    error.code = 'E_MEDIA_INDEX_INVALID';
    throw error;
  }
  const registry = {
    registryVersion: 1,
    portable: false,
    inputRoot: input,
    entries: records.map(({ mediaId, sourceDigest, sourcePath }) => ({ mediaId, sourceDigest, sourcePath })),
  };
  await writeJsonAtomic(projectPath(project, 'cache/source-registry.json'), registry);
  await writeJsonAtomic(artifactPath, document);
  return {
    ok: true,
    indexed: records.length,
    unsupported: records.filter(({ mediaType }) => mediaType === 'unsupported').length,
    artifact: 'analysis/MEDIA_INDEX.json',
  };
}

const DEFINITIONS = { project: { required: true }, input: { required: true } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await ingestMedia(parseCliArguments(process.argv.slice(2), DEFINITIONS)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
