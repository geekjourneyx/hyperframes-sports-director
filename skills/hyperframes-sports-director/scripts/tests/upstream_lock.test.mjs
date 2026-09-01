import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('pins both AGPL upstreams to their approved immutable commits', async () => {
  const lock = JSON.parse(await readFile('UPSTREAM.lock.json', 'utf8'));

  assert.deepEqual(lock.upstreams, [
    {
      name: 'hyperframes-motion-director',
      repository: 'https://github.com/geekjourneyx/hyperframes-motion-director',
      commit: '0b66750322ccb50ae56ace5a8d361da2c1f65400',
      license: 'AGPL-3.0',
    },
    {
      name: 'guizang-sports-skill',
      repository: 'https://github.com/op7418/guizang-sports-skill',
      commit: 'f165bf2993c4eafd5dd91581317c8993230f84e1',
      license: 'AGPL-3.0',
    },
  ]);

  for (const upstream of lock.upstreams) {
    assert.match(upstream.commit, /^[0-9a-f]{40}$/);
    assert.equal(upstream.license, 'AGPL-3.0');
  }
});
