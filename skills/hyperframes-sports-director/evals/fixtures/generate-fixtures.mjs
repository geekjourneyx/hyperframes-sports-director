import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function ffmpeg(args) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
}

export async function generateFixtures(root) {
  const nested = join(root, 'nested');
  await mkdir(nested, { recursive: true });

  const mainVideo = join(root, '20260901T120000Z-main.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=30000/1001:duration=5',
    '-f', 'lavfi', '-i', "aevalsrc=if(between(t\\,1\\,2)\\,0\\,sin(2*PI*1000*t)):s=48000:d=5",
    '-vf', "loop=loop=1:size=30:start=30,loop=loop=15:size=1:start=105,drawbox=x='mod(t*80\\,280)':y=60:w=40:h=40:color=white:t=fill,drawbox=enable='between(t\\,3\\,3.5)':x=0:y=0:w=iw:h=ih:color=black:t=fill,crop=300:160:x='10+if(between(t\\,4\\,5)\\,8*sin(80*t)\\,0)':y='10+if(between(t\\,4\\,5)\\,8*cos(80*t)\\,0)',scale=320:180,format=yuv420p",
    '-t', '5', '-r', '30000/1001', '-video_track_timescale', '30000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-shortest',
    '-metadata', 'creation_time=2026-09-01T12:00:00Z', mainVideo,
  ]);
  await ffmpeg([
    '-display_rotation', '90', '-i', mainVideo, '-map', '0', '-c', 'copy',
    '-metadata', 'creation_time=2026-09-01T12:01:00Z', join(root, '20260901T120100Z-rotated.mov'),
  ]);

  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1', '-frames:v', '1', join(root, '20260901T120200Z-photo.jpg')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x336699:size=120x160:rate=1', '-frames:v', '1', join(nested, '20260901T120300Z-portrait.png')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=144x96:rate=1', '-frames:v', '1', '-c:v', 'libwebp', join(root, '20260901T120400Z-photo.webp')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', join(root, '20260901T120500Z-tone.wav')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'aac', join(root, '20260901T120600Z-music.m4a')]);

  await writeFile(join(root, '20260901T120700Z-activity.fit'), Buffer.from([
    0x0e, 0x10, 0x00, 0x00, 0x2e, 0x46, 0x49, 0x54, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]));
  await writeFile(join(root, '20260901T120800Z-route.kml'), '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>\n');
  await writeFile(join(root, '20260901T120900Z-sidecar.json'), '{"rating":5,"note":"fixture sidecar"}\n');
  await writeFile(join(root, '20260901T121000Z-unsupported.txt'), 'unsupported fixture\n');
  await writeFile(join(root, '.hidden.mp4'), 'ignored hidden fixture\n');
  await mkdir(join(root, '__MACOSX'));
  await writeFile(join(root, '__MACOSX', 'resource.txt'), 'ignored system fixture\n');

  return { root, mainVideo };
}
