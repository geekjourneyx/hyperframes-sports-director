#!/usr/bin/env node
/* Copyright (C) 2026 HyperFrames Sports Director contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { constants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const unfinishedWords = [['TO', 'DO'], ['TB', 'D'], ['FIX', 'ME']].map((parts) => parts.join('')).join('|');
const placeholderPhrase = ['fill', 'this', 'in'].join(' ');
const MARKERS = new RegExp(`\\b(?:${unfinishedWords})\\b|${placeholderPhrase}`, 'i');

function parseFrontmatter(source) {
  const match = source.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return null;
  const values = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z][a-z0-9_-]*):\s*(.+)$/);
    if (!field) return null;
    values[field[1]] = field[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2');
  }
  return values;
}

function markdownLinks(source) {
  return [...source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].split('#')[0]).filter(Boolean);
}

async function filesUnder(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

export async function checkStructure(skillRoot) {
  const root = resolve(skillRoot);
  const errors = [];
  let skill = '';
  let metadata = '';
  try { skill = await readFile(join(root, 'SKILL.md'), 'utf8'); } catch { errors.push('missing SKILL.md'); }
  try { metadata = await readFile(join(root, 'agents/openai.yaml'), 'utf8'); } catch { errors.push('missing agents/openai.yaml'); }

  const frontmatter = parseFrontmatter(skill);
  if (!frontmatter) errors.push('SKILL.md must start with simple valid YAML frontmatter');
  const name = frontmatter?.name ?? '';
  const description = frontmatter?.description ?? '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length >= 64) errors.push('frontmatter name must be hyphenated lowercase and under 64 characters');
  if (!description.startsWith('Use when ') || description.length >= 500) errors.push('frontmatter description must start with "Use when" and be under 500 characters');

  const skillLines = skill ? skill.split('\n').length : 0;
  if (skillLines >= 500) errors.push('SKILL.md must be under 500 lines');

  const linkedMarkdown = new Set();
  for (const link of markdownLinks(skill)) {
    if (/^[a-z]+:/i.test(link) || link.startsWith('#')) continue;
    const target = resolve(root, link);
    if (!inside(root, target)) { errors.push(`link escapes Skill root: ${link}`); continue; }
    try { await access(target); } catch { errors.push(`broken link: ${link}`); continue; }
    if (link.endsWith('.md')) linkedMarkdown.add(relative(root, target));
  }

  const referenceRoot = join(root, 'references');
  for (const path of (await filesUnder(referenceRoot)).filter((item) => item.endsWith('.md'))) {
    const local = relative(root, path);
    if (!linkedMarkdown.has(local)) errors.push(`reference is not linked directly from SKILL.md: ${local}`);
    const nested = markdownLinks(await readFile(path, 'utf8')).filter((link) => !/^[a-z]+:/i.test(link) && link.endsWith('.md'));
    if (nested.length) errors.push(`reference exceeds one-hop routing: ${local}`);
  }

  for (const path of (await readdir(join(root, 'scripts'))).filter((name) => name.endsWith('.mjs')).map((name) => join(root, 'scripts', name))) {
    try { await access(path, constants.X_OK); } catch { errors.push(`script is not executable: ${relative(root, path)}`); }
  }

  const strings = [...metadata.matchAll(/^\s+[a-z_]+:\s*(.+)$/gm)].map((match) => match[1]);
  if (strings.some((value) => value !== 'true' && !/^"[^"\n]*"$/.test(value))) errors.push('agents/openai.yaml string values must be quoted');
  const displayName = metadata.match(/^\s+display_name:\s*"([^"]+)"$/m)?.[1] ?? '';
  const shortDescription = metadata.match(/^\s+short_description:\s*"([^"]+)"$/m)?.[1] ?? '';
  const defaultPrompt = metadata.match(/^\s+default_prompt:\s*"([^"]+)"$/m)?.[1] ?? '';
  const allowImplicitInvocation = metadata.match(/^\s+allow_implicit_invocation:\s*(true|false)$/m)?.[1] === 'true';
  if (!displayName) errors.push('agents/openai.yaml requires display_name');
  if (shortDescription.length < 25 || shortDescription.length > 64) errors.push('short_description must contain 25–64 characters');
  if (!defaultPrompt.includes('$hyperframes-sports-director') || !/[.!?]$/.test(defaultPrompt)) errors.push('default_prompt must be one sentence naming $hyperframes-sports-director');
  if (!allowImplicitInvocation) errors.push('implicit invocation must be enabled');

  for (const path of await filesUnder(root)) {
    if (MARKERS.test(await readFile(path, 'utf8'))) errors.push(`unfinished scaffold marker: ${relative(root, path)}`);
  }
  return { ok: errors.length === 0, errors, name, allowImplicitInvocation, skillLines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await checkStructure(root);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
