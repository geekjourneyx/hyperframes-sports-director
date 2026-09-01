import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, readdir, rename } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MEDIA_EXTENSIONS = new Map([
  ['.mp4', 'video'], ['.mov', 'video'], ['.m4v', 'video'], ['.mkv', 'video'], ['.avi', 'video'], ['.webm', 'video'],
  ['.jpg', 'image'], ['.jpeg', 'image'], ['.png', 'image'], ['.webp', 'image'], ['.tif', 'image'], ['.tiff', 'image'], ['.heic', 'image'],
  ['.wav', 'audio'], ['.m4a', 'audio'], ['.mp3', 'audio'], ['.aac', 'audio'], ['.flac', 'audio'], ['.ogg', 'audio'],
  ['.fit', 'activity'], ['.kml', 'activity'], ['.gpx', 'activity'], ['.tcx', 'activity'],
  ['.json', 'sidecar'], ['.xmp', 'sidecar'], ['.srt', 'sidecar'], ['.vtt', 'sidecar'],
]);
const SYSTEM_NAMES = new Set(['__MACOSX', 'Thumbs.db', 'desktop.ini', '.DS_Store']);
const FINAL_FORBIDDEN = [
  { fragment: ['media', 'proxies'], code: 'E_PROXY_FINAL_SOURCE' },
  { fragment: ['review', 'probe'], code: 'E_ANALYSIS_DERIVATIVE_FINAL_SOURCE' },
  { fragment: ['analysis', 'evidence'], code: 'E_ANALYSIS_DERIVATIVE_FINAL_SOURCE' },
  { fragment: ['analysis', 'segments'], code: 'E_ANALYSIS_DERIVATIVE_FINAL_SOURCE' },
];

export class MediaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

function isWithin(path, root) {
  const child = relative(root, path);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

export async function resolveRoots(projectRoot, inputRoot) {
  if (!projectRoot || !inputRoot) throw new MediaError('E_OPTIONS', 'project and input are required');
  let input;
  try {
    input = await realpath(inputRoot);
  } catch (error) {
    throw new MediaError('E_INPUT_UNREADABLE', `input root is not readable: ${error.message}`);
  }
  const project = resolve(projectRoot);
  if (isWithin(project, input)) throw new MediaError('E_PROJECT_INSIDE_INPUT', 'project root must be outside the immutable input root');
  return { project, input };
}

export function classifyMedia(path) {
  return MEDIA_EXTENSIONS.get(extname(path).toLowerCase()) ?? 'unsupported';
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolvePromise);
    stream.once('error', reject);
  });
  return hash.digest('hex');
}

export async function enumerateInput(inputRoot) {
  const found = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (child.name.startsWith('.') || SYSTEM_NAMES.has(child.name)) continue;
      const path = join(directory, child.name);
      if (child.isDirectory()) await visit(path);
      else if (child.isFile()) {
        const metadata = await lstat(path);
        found.push({ path, relativePath: relative(inputRoot, path), byteSize: metadata.size });
      }
    }
  }
  await visit(inputRoot);
  return found;
}

function portableExtension(sourcePath, mediaType) {
  const extension = extname(sourcePath).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(extension)) return extension;
  return mediaType === 'unsupported' ? '.bin' : '.dat';
}

export async function buildMediaRecords(inputRoot) {
  const files = await enumerateInput(inputRoot);
  const hashed = await Promise.all(files.map(async (file) => ({
    ...file,
    mediaType: classifyMedia(file.path),
    sourceDigest: await sha256File(file.path),
  })));
  hashed.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const digestOrdinals = new Map();
  return hashed.map((file) => {
    const ordinal = (digestOrdinals.get(file.sourceDigest) ?? 0) + 1;
    digestOrdinals.set(file.sourceDigest, ordinal);
    const mediaId = `media-${file.sourceDigest.slice(0, 16)}-${String(ordinal).padStart(3, '0')}`;
    return {
      mediaId,
      mediaType: file.mediaType,
      sourceRootReadOnly: true,
      sourceDigest: file.sourceDigest,
      byteSize: file.byteSize,
      portablePath: `media/originals/${mediaId}${portableExtension(file.path, file.mediaType)}`,
      sourcePath: file.path,
    };
  });
}

export function projectPath(projectRoot, portablePath) {
  if (typeof portablePath !== 'string' || isAbsolute(portablePath)) throw new MediaError('E_PATH_ESCAPE', 'project path must be relative');
  const root = resolve(projectRoot);
  const path = resolve(root, portablePath);
  if (!isWithin(path, root)) throw new MediaError('E_PATH_ESCAPE', 'path escapes project root');
  return path;
}

export async function writeJsonAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function readSourceRegistry(projectRoot, inputRoot) {
  const { project, input } = await resolveRoots(projectRoot, inputRoot);
  let registry;
  try {
    registry = JSON.parse(await readFile(projectPath(project, 'cache/source-registry.json'), 'utf8'));
  } catch (error) {
    throw new MediaError('E_SOURCE_REGISTRY', `source registry is unavailable: ${error.message}`);
  }
  if (registry.portable !== false || registry.inputRoot !== input || !Array.isArray(registry.entries)) {
    throw new MediaError('E_SOURCE_REGISTRY', 'source registry does not bind the declared immutable input root');
  }
  for (const entry of registry.entries) {
    const resolvedSource = await realpath(entry.sourcePath);
    if (!isWithin(resolvedSource, input) || resolvedSource !== entry.sourcePath) {
      throw new MediaError('E_SOURCE_ESCAPE', `registered source for ${entry.mediaId} is outside the immutable input root`);
    }
    const digest = await sha256File(resolvedSource);
    if (digest !== entry.sourceDigest) throw new MediaError('E_SOURCE_CHANGED', `registered source changed for ${entry.mediaId}`);
  }
  return { project, input, registry };
}

export function assertFinalSource(path, projectRoot) {
  let resolvedPath;
  try { resolvedPath = realpathSync(path); } catch { resolvedPath = resolve(path); }
  const normalized = resolvedPath.split(sep);
  for (const { fragment, code } of FINAL_FORBIDDEN) {
    const found = normalized.some((part, index) => fragment.every((candidate, offset) => normalized[index + offset] === candidate));
    if (found) throw new MediaError(code, 'final render sources must resolve to immutable originals');
  }
  let resolvedProject = projectRoot && resolve(projectRoot);
  try { if (projectRoot) resolvedProject = realpathSync(projectRoot); } catch {}
  if (resolvedProject && isWithin(resolvedPath, resolvedProject)) {
    throw new MediaError('E_PROJECT_DERIVATIVE_FINAL_SOURCE', 'final render sources must not resolve inside the project workspace');
  }
  return path;
}
