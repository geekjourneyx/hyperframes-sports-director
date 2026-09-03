#!/usr/bin/env node
/* Copyright (C) 2026 HyperFrames Sports Director contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import sharp from 'sharp';

const SKILL_NAME = 'hyperframes-sports-director';
const RELEASE_PROFILES = ['cycling', 'hiking', 'pool-swimming'];
const REQUIRED_SCRIPTS = ['test', 'test:contracts', 'test:media', 'test:skill', 'eval', 'check', 'release:dry'];
const ALLOWED_PACKAGE_KEYS = ['dependencies', 'engines', 'license', 'name', 'private', 'scripts', 'type', 'version'];
const FORBIDDEN_EXTENSIONS = /\.(?:3gp|aac|aiff?|ape|avi|braw|cr2|cr3|dng|f4v|fit|flac|flv|gpx|insv|kml|m2ts|m4a|m4v|mkv|mov|mp3|mp4|mts|mxf|ogg|ogv|opus|orf|raf|raw|rsv|wav|webm|wma|wmv)$/i;
const SECRET_FILENAME = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\.json)?|id_rsa|id_ed25519|[^/]+\.(?:jks|keystore|pem|key|p12))$/i;
const SECRET_CONTENT = /(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{32,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b)/;
const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.yaml', '.yml']);
const ZIP_UTF8 = 0x0800;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_DATE_1980_01_01 = 0x21;

function posix(path) {
  return path.split(sep).join('/');
}

function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.startsWith(sep));
}

async function readRequired(path, label, errors) {
  try {
    return await readFile(path);
  } catch {
    errors.push(`missing ${label}`);
    return null;
  }
}

function yamlString(source, key) {
  return source.match(new RegExp(`^\\s+${key}:\\s+"([^"]+)"$`, 'm'))?.[1] ?? '';
}

function extension(path) {
  const match = path.match(/(\.[^./]+)$/);
  return match?.[1].toLowerCase() ?? '';
}

async function walkFiles(root, { exclude = () => false } = {}) {
  const files = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const local = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (exclude(local, entry)) continue;
      const path = join(directory, entry.name);
      const facts = await lstat(path);
      if (facts.isSymbolicLink()) throw new Error(`symbolic link is not portable: ${local}`);
      if (facts.isDirectory()) await visit(path, local);
      else if (facts.isFile()) files.push({ local, path, mode: facts.mode });
    }
  }
  await visit(root);
  return files.sort((a, b) => a.local.localeCompare(b.local));
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, seed) => {
  let value = seed;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function buildZip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.bytes, { level: 9 });
    const checksum = crc32(entry.bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(ZIP_UTF8, 6);
    localHeader.writeUInt16LE(ZIP_METHOD_DEFLATE, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(ZIP_DATE_1980_01_01, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    localRecords.push(localHeader, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8, 8);
    central.writeUInt16LE(ZIP_METHOD_DEFLATE, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(ZIP_DATE_1980_01_01, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, name);
    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

export async function listArchiveEntries(path) {
  const bytes = await readFile(path);
  const minimum = Math.max(0, bytes.length - 65557);
  let endOffset = -1;
  for (let cursor = bytes.length - 22; cursor >= minimum; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50) { endOffset = cursor; break; }
  }
  if (endOffset < 0) throw new Error('invalid ZIP: end record not found');
  const count = bytes.readUInt16LE(endOffset + 10);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('invalid ZIP: central entry not found');
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    entries.push(bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function packageFiles(skillRoot) {
  const files = await walkFiles(skillRoot, {
    exclude(local, entry) {
      const parts = local.split('/');
      if (parts[0] === 'evals') return true;
      if (parts.includes('node_modules') || parts.includes('__pycache__')) return true;
      return !entry.isDirectory() && (entry.name === '.DS_Store' || entry.name.endsWith('.pyc'));
    },
  });
  const allowed = [
    /^SKILL\.md$/,
    /^agents\/openai\.yaml$/,
    /^assets\/director-workbench\/[^/]+\.(?:css|html|js)$/,
    /^assets\/hyperframes-project\/(?:index\.html|src\/(?:main|scene-runtime)\.js|src\/styles\.css)$/,
    /^assets\/icons\/icon-(?:large|small)\.png$/,
    /^profiles\/(?:delivery|devices|sports)\/[a-z0-9-]+\.json$/,
    /^references\/[a-z0-9-]+\.md$/,
    /^schemas\/[a-z0-9-]+\.schema\.json$/,
    /^scripts\/(?:lib\/|tests\/)?[a-z0-9_.-]+\.mjs$/,
    /^templates\/[A-Z0-9_-]+\.template\.(?:json|md)$/,
  ];
  for (const file of files) {
    if (!allowed.some((pattern) => pattern.test(file.local))) throw new Error(`unrecognized packaged file: ${file.local}`);
    if (/(?:^|\/)(?:cache|originals|proxies|renders|[^/]*workspace[^/]*)(?:\/|$)/i.test(file.local)) throw new Error(`forbidden packaged directory: ${file.local}`);
    if (FORBIDDEN_EXTENSIONS.test(file.local) || SECRET_FILENAME.test(file.local)) throw new Error(`forbidden packaged file: ${file.local}`);
    if (TEXT_EXTENSIONS.has(extension(file.local)) && SECRET_CONTENT.test(await readFile(file.path, 'utf8'))) throw new Error(`credential-like packaged content: ${file.local}`);
  }
  return files;
}

async function repositorySafetyErrors(repoRoot) {
  const errors = [];
  const files = await walkFiles(repoRoot, {
    exclude(local) {
      const head = local.split('/')[0];
      return ['.git', '.worktrees', 'dist', 'node_modules'].includes(head);
    },
  });
  for (const file of files) {
    if (FORBIDDEN_EXTENSIONS.test(file.local)) errors.push(`forbidden media or activity file: ${file.local}`);
    if (SECRET_FILENAME.test(file.local)) errors.push(`forbidden secret filename: ${file.local}`);
    if (TEXT_EXTENSIONS.has(extension(file.local))) {
      const source = await readFile(file.path, 'utf8');
      if (SECRET_CONTENT.test(source)) errors.push(`credential-like content: ${file.local}`);
    }
  }
  return errors;
}

export async function checkRelease(repoRootInput, { version = '1.0.0', tag = null } = {}) {
  const repoRoot = resolve(repoRootInput);
  const skillRoot = join(repoRoot, 'skills', SKILL_NAME);
  const errors = [];
  const packageBytes = await readRequired(join(repoRoot, 'package.json'), 'package.json', errors);
  const lockBytes = await readRequired(join(repoRoot, 'package-lock.json'), 'package-lock.json', errors);
  const changelogBytes = await readRequired(join(repoRoot, 'CHANGELOG.md'), 'CHANGELOG.md', errors);
  await readRequired(join(repoRoot, 'README.md'), 'README.md', errors);
  await readRequired(join(repoRoot, 'RELEASING.md'), 'RELEASING.md', errors);
  const ciBytes = await readRequired(join(repoRoot, '.github/workflows/ci.yml'), 'CI workflow', errors);
  const releaseBytes = await readRequired(join(repoRoot, '.github/workflows/release.yml'), 'release workflow', errors);
  const metadataBytes = await readRequired(join(skillRoot, 'agents/openai.yaml'), 'agents/openai.yaml', errors);
  const attributionBytes = await readRequired(join(repoRoot, 'ATTRIBUTIONS.md'), 'ATTRIBUTIONS.md', errors);
  const upstreamBytes = await readRequired(join(repoRoot, 'UPSTREAM.lock.json'), 'UPSTREAM.lock.json', errors);

  let manifest = {};
  let lock = {};
  let upstream = {};
  try { if (packageBytes) manifest = JSON.parse(packageBytes); } catch { errors.push('package.json must be valid JSON'); }
  try { if (lockBytes) lock = JSON.parse(lockBytes); } catch { errors.push('package-lock.json must be valid JSON'); }
  try { if (upstreamBytes) upstream = JSON.parse(upstreamBytes); } catch { errors.push('UPSTREAM.lock.json must be valid JSON'); }

  if (manifest.name !== SKILL_NAME) errors.push(`package name must be ${SKILL_NAME}`);
  if (manifest.version !== version) errors.push(`package version must be ${version}`);
  if (tag !== null && tag !== `v${version}`) errors.push(`release tag must equal v${version}`);
  if (manifest.private !== true) errors.push('package must remain private');
  if (manifest.license !== 'AGPL-3.0-only') errors.push('package license must be AGPL-3.0-only');
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(ALLOWED_PACKAGE_KEYS)) errors.push('package manifest contains unsupported top-level fields');
  for (const script of REQUIRED_SCRIPTS) if (typeof manifest.scripts?.[script] !== 'string') errors.push(`package script is missing: ${script}`);
  for (const [name, dependencyVersion] of Object.entries(manifest.dependencies ?? {})) {
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(dependencyVersion)) errors.push(`dependency must be exactly pinned: ${name}`);
    if (lock.packages?.['']?.dependencies?.[name] !== dependencyVersion) errors.push(`package-lock dependency mismatch: ${name}`);
  }
  if (lock.version !== version || lock.packages?.['']?.version !== version) errors.push(`package-lock version must be ${version}`);

  const changelog = changelogBytes?.toString('utf8') ?? '';
  if (!new RegExp(`^## \\[?${version.replaceAll('.', '\\.')}\\]?\\s+-`, 'm').test(changelog)) errors.push(`CHANGELOG heading must declare ${version}`);
  const ci = ciBytes?.toString('utf8') ?? '';
  if (!ci.includes('npm test') || !ci.includes('npm run eval') || !ci.includes('npm run check')) errors.push('CI workflow must run tests, evals, and release checks');
  const release = releaseBytes?.toString('utf8') ?? '';
  if (!/tags:\s*\n\s*-\s*["']v\*["']/.test(release)) errors.push('release workflow must use the v* tag pattern');
  if (!release.includes('needs: verify') || !release.includes('steps.version.outputs.version')) errors.push('release archive must wait for verification and derive its filename from package metadata');
  if (!release.includes('GITHUB_REF_NAME') || !release.includes('--tag')) errors.push('release workflow must reject a tag that differs from package metadata');

  const attribution = attributionBytes?.toString('utf8') ?? '';
  for (const record of upstream.upstreams ?? []) {
    if (!/^[a-f0-9]{40}$/.test(record.commit ?? '')) errors.push(`upstream commit is not immutable: ${record.name ?? 'unknown'}`);
    if (!attribution.includes(record.repository ?? '') || !attribution.includes(record.commit ?? '')) errors.push(`attribution does not match pinned upstream: ${record.name ?? 'unknown'}`);
  }
  if ((upstream.upstreams ?? []).length !== 2) errors.push('exactly two pinned upstreams are required');

  const metadata = metadataBytes?.toString('utf8') ?? '';
  const iconFields = { small: yamlString(metadata, 'icon_small'), large: yamlString(metadata, 'icon_large') };
  const expectedIcons = { small: { path: 'assets/icons/icon-small.png', width: 64, height: 64 }, large: { path: 'assets/icons/icon-large.png', width: 1024, height: 1024 } };
  const icons = {};
  for (const [size, expected] of Object.entries(expectedIcons)) {
    const declared = iconFields[size].replace(/^\.\//, '');
    if (declared !== expected.path) errors.push(`icon_${size} must reference ./${expected.path}`);
    const target = resolve(skillRoot, declared);
    if (!declared || !inside(skillRoot, target)) { errors.push(`icon_${size} escapes the Skill root`); continue; }
    const bytes = await readRequired(target, `icon_${size}`, errors);
    let dimensions = null;
    try {
      if (bytes) {
        const image = sharp(bytes, { failOn: 'error' });
        const metadata = await image.metadata();
        await image.clone().raw().toBuffer();
        if (metadata.format === 'png') dimensions = { width: metadata.width, height: metadata.height };
      }
    } catch {
      // The stable validation error below intentionally hides decoder internals.
    }
    if (!dimensions || dimensions.width !== expected.width || dimensions.height !== expected.height) errors.push(`icon_${size} must be a decodable ${expected.width}x${expected.height} PNG`);
    if (dimensions) icons[size] = { path: declared, ...dimensions };
  }

  const goldenScores = {};
  for (const profile of RELEASE_PROFILES) {
    const bytes = await readRequired(join(skillRoot, 'evals/expected', `${profile}.json`), `${profile} golden result`, errors);
    if (!bytes) continue;
    try {
      const expected = JSON.parse(bytes);
      goldenScores[profile] = expected.total;
      if (expected.total < 90 || expected.releaseEligible !== true || expected.hardGates?.length || expected.thresholdFailures?.length) errors.push(`${profile} golden result is not release eligible`);
    } catch {
      errors.push(`${profile} golden result must be valid JSON`);
    }
  }

  try {
    await packageFiles(skillRoot);
  } catch (error) {
    errors.push(error.message);
  }
  try { errors.push(...await repositorySafetyErrors(repoRoot)); } catch (error) { errors.push(error.message); }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)].sort(),
    version,
    archiveName: `${SKILL_NAME}-v${version}.skill`,
    goldenScores,
    icons,
  };
}

export async function createReleaseArchive(repoRootInput, { version = '1.0.0', tag = null, output = join(resolve(repoRootInput), 'dist') } = {}) {
  const repoRoot = resolve(repoRootInput);
  const result = await checkRelease(repoRoot, { version, tag });
  if (!result.ok) throw new Error(`release check failed:\n${result.errors.join('\n')}`);
  const skillRoot = join(repoRoot, 'skills', SKILL_NAME);
  const files = await packageFiles(skillRoot);
  const entries = await Promise.all(files.map(async (file) => ({
    name: `${SKILL_NAME}/${posix(file.local)}`,
    bytes: await readFile(file.path),
    mode: file.mode,
  })));
  const archiveBytes = buildZip(entries);
  await mkdir(output, { recursive: true });
  const path = join(output, result.archiveName);
  await writeFile(path, archiveBytes);
  const digest = createHash('sha256').update(archiveBytes).digest('hex');
  const checksumPath = `${path}.sha256`;
  await writeFile(checksumPath, `${digest}  ${basename(path)}\n`);
  return { path, checksumPath, digest, entries: entries.map((entry) => entry.name) };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = resolve(dirname(process.argv[1]), '../../..');
  const packageVersion = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')).version;
  const version = option('--version') ?? packageVersion;
  const tag = option('--tag') ?? null;
  try {
    if (process.argv.includes('--dry-run')) {
      const archive = await createReleaseArchive(repoRoot, { version, tag });
      process.stdout.write(`${JSON.stringify({ ok: true, version, archive: relative(repoRoot, archive.path), checksum: archive.digest, entries: archive.entries.length })}\n`);
    } else {
      const result = await checkRelease(repoRoot, { version, tag });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
