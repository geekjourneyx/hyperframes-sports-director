import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CHROME } from '../lib/director-workbench.mjs';

const CSS = new URL('../../assets/director-workbench/workbench.css', import.meta.url);
const EXPECTED_CHROME = {
  background: '#050505', surface: '#0D0D0D', surfaceRaised: '#141414', textPrimary: '#F5F2EA',
  textSecondary: '#A8A29A', accent: '#C9A86A', danger: '#E36B5D', line: '#2A2A2A',
};

test('workbench visual contract keeps readable type, fixed chrome, and a centered 4K director canvas', async () => {
  const css = await readFile(CSS, 'utf8');
  assert.deepEqual(CHROME, EXPECTED_CHROME, 'the workbench has exactly the approved chrome tokens');
  assert.match(css, /body\s*\{[^}]*font-size:\s*14px;/s, 'body copy has a 14px minimum');
  assert.doesNotMatch(css, /font-size:\s*(?:[0-9]|1[01])px\b/, 'no visible label or caption falls below 12px');
  assert.match(css, /@media \(min-width: 2200px\)\s*\{[\s\S]*?\.workbench-shell\s*\{[^}]*max-width:\s*2560px;[^}]*margin-inline:\s*auto;[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 440px;/s);
  assert.match(css, /\.candidate-filmstrip\s*\{/, 'the filmstrip remains part of the director workbench');
  assert.match(css, /\.direction-stage\.is-active\s*\{/, 'the director stage remains the dominant canvas');
});

test('workbench interaction contract keeps every control reachable and gives the approval decision priority', async () => {
  const css = await readFile(CSS, 'utf8');
  assert.match(css, /a, button\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(css, /\.approve-button\s*\{[^}]*min-height:\s*48px;/s);
  assert.match(css, /a:focus-visible, button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--hf-accent\);/s);
  assert.match(css, /\.approval-zone\s*\{[^}]*padding:/s);
});
