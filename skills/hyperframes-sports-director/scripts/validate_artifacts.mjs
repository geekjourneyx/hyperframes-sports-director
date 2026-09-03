#!/usr/bin/env node
import { writeSync } from 'node:fs';

import { validateArtifact } from './lib/contracts.mjs';

const [schemaName, artifactPath, ...extra] = process.argv.slice(2);
let result;
if (!schemaName || !artifactPath || extra.length > 0) {
  result = {
    valid: false,
    errors: [{ code: 'E_USAGE', path: '/', message: 'usage: validate_artifacts.mjs <schema> <artifact-path>', schema: schemaName ?? 'unknown' }],
  };
} else {
  try {
    result = await validateArtifact(artifactPath, schemaName);
  } catch (error) {
    result = {
      valid: false,
      errors: [{ code: 'E_VALIDATION', path: '/', message: error.message, schema: schemaName }],
    };
  }
}

writeSync(1, `${JSON.stringify({ valid: result.valid, errors: result.errors })}\n`);
if (!result.valid) process.exitCode = 1;
