import { spawn } from 'node:child_process';

export class SubprocessError extends Error {
  constructor(command, args, code, stderr) {
    super(`${command} exited ${code}: ${stderr.trim()}`);
    this.name = 'SubprocessError';
    this.code = 'E_SUBPROCESS';
    this.command = command;
    this.args = [...args];
    this.exitCode = code;
  }
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      if (error.code === 'ENOENT') error.code = command === 'ffprobe' ? 'E_FFPROBE_MISSING' : 'E_FFMPEG_MISSING';
      reject(error);
    });
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new SubprocessError(command, args, code, stderr));
    });
  });
}

export async function ffprobeJson(path) {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path,
  ]);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    error.code = 'E_FFPROBE_JSON';
    throw error;
  }
}

export async function assertImageDecodes(path) {
  await runCommand('ffmpeg', ['-v', 'error', '-nostdin', '-i', path, '-frames:v', '1', '-f', 'null', '-']);
}

export async function runFfmpeg(args) {
  return runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
}
