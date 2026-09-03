import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { projectPath } from './lib/media.mjs';

const REQUIRED = ['colors', 'typography', 'spacing', 'safeZones', 'strokes', 'radii', 'depth', 'motion', 'easing', 'contrast', 'redundantEncodings'];
const TOKEN_FIELDS = ['colorToken', 'typographyRole', 'spacingToken', 'strokeToken', 'radiusToken', 'easingToken'];
const UNTOKENIZED_STYLE_FIELDS = new Set(['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'spacing', 'strokeWidth', 'borderRadius', 'radius', 'easing']);

function error(code, path, message, category = 'token-resolution') {
  return { code, classification: 'hard_error', category, path, message };
}

function tokenSet(designSystem) {
  return new Set(Object.values(designSystem?.tokens ?? {}).flatMap((group) => group && typeof group === 'object' ? Object.keys(group) : []));
}

function inspect(value, path, declared, errors, inColors = false) {
  if (Array.isArray(value)) return value.forEach((entry, index) => inspect(entry, `${path}/${index}`, declared, errors, inColors));
  if (!value || typeof value !== 'object') {
    if (!inColors && !path.startsWith('/assetManifest') && typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value)) errors.push(error('E_RAW_COLOR_LITERAL', path, 'scene-local color literals are forbidden'));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${key}`;
    if (TOKEN_FIELDS.includes(key) && typeof child === 'string' && !declared.has(child)
      && !(key === 'typographyRole' && child.startsWith('type.') && declared.has(child.slice('type.'.length)))) errors.push(error('E_TOKEN_UNRESOLVED', childPath, `unresolved semantic token ${child}`));
    if (UNTOKENIZED_STYLE_FIELDS.has(key) && !path.startsWith('/designSystem/tokens') && (typeof child === 'number' || typeof child === 'string')) errors.push(error('E_UNTOKENIZED_STYLE_VALUE', childPath, `${key} must reference a frozen semantic token`));
    if (key === 'colorTokens' && Array.isArray(child)) child.forEach((token, index) => {
      if (!declared.has(token)) errors.push(error('E_TOKEN_UNRESOLVED', `${childPath}/${index}`, `unresolved semantic token ${token}`));
    });
    inspect(child, childPath, declared, errors, inColors || path === '/designSystem/tokens' && key === 'colors');
  }
}

export function validateDesignSystem({ designSystem, lookProfile, sceneSchema, motionMap, assetManifest, dataOverlays, timeline } = {}) {
  const hardErrors = [];
  if (designSystem?.status !== 'frozen') hardErrors.push(error('E_DESIGN_NOT_FROZEN', '/designSystem/status', 'motion composition requires a frozen design system'));
  if (lookProfile?.status !== 'frozen') hardErrors.push(error('E_LOOK_NOT_FROZEN', '/lookProfile/status', 'motion composition requires a frozen Look profile'));
  for (const group of REQUIRED) if (!designSystem?.tokens?.[group] || Object.keys(designSystem.tokens[group]).length === 0) {
    hardErrors.push(error('E_TOKEN_GROUP_REQUIRED', `/designSystem/tokens/${group}`, `frozen composition requires ${group} tokens`));
  }
  const declared = tokenSet(designSystem);
  inspect(sceneSchema, '/sceneSchema', declared, hardErrors);
  inspect(motionMap, '/motionMap', declared, hardErrors);
  inspect(assetManifest, '/assetManifest', declared, hardErrors);
  inspect(dataOverlays, '/dataOverlays', declared, hardErrors);
  inspect(timeline, '/timeline', declared, hardErrors);
  return { valid: hardErrors.length === 0, hardErrors, errors: hardErrors };
}

export async function validateDesignSystemFile({ project }) {
  const [designSystem, lookProfile, sceneSchema, motionMap] = await Promise.all([
    'direction/DESIGN_SYSTEM.json', 'direction/LOOK_PROFILE.json', 'direction/SCENE_SCHEMA.json', 'direction/MOTION_MAP.json',
  ].map((path) => readFile(projectPath(project, path), 'utf8').then(JSON.parse)));
  return validateDesignSystem({ designSystem, lookProfile, sceneSchema, motionMap });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await validateDesignSystemFile(parseCliArguments(process.argv.slice(2), { project: { required: true } }));
    process.stdout.write(`${JSON.stringify({ ok: result.valid, ...result })}\n`); if (!result.valid) process.exitCode = 1;
  } catch (cause) { process.stdout.write(`${JSON.stringify(errorResult(cause))}\n`); process.exitCode = cause.code === 'E_USAGE' ? 2 : 1; }
}
