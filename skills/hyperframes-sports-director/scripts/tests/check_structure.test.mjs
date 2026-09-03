import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, '../..');

test('installable Skill has discoverable metadata, one-hop references, and executable scripts', async () => {
  const required = ['SKILL.md', 'agents/openai.yaml'];
  const missing = [];
  for (const relative of required) {
    try { await access(join(skillRoot, relative)); } catch { missing.push(relative); }
  }
  assert.deepEqual(missing, [], `missing required Skill files: ${missing.join(', ')}`);

  const { checkStructure } = await import('../check_structure.mjs');
  const result = await checkStructure(skillRoot);
  assert.deepEqual(result.errors, []);
  assert.equal(result.name, 'hyperframes-sports-director');
  assert.equal(result.allowImplicitInvocation, true);
  assert.ok(result.skillLines < 500);
});
