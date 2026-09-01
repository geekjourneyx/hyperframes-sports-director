import { projectPath, sha256File } from './media.mjs';
import { ffprobeJson } from './ffmpeg.mjs';

function invalid(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function seconds(value) {
  return Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function escapeDrawtext(value) {
  return value.replace(/([\\':])/g, '\\$1');
}

function atempoFilters(rate) {
  const filters = [];
  let remaining = rate;
  while (remaining > 2) { filters.push('atempo=2'); remaining /= 2; }
  while (remaining < 0.5) { filters.push('atempo=0.5'); remaining /= 0.5; }
  filters.push(`atempo=${seconds(remaining)}`);
  return filters;
}

export async function compileRoughRenderPlan({ project, probe, timeline, width = 960, height = 540, outputPath }) {
  if (timeline?.phase !== 'rough' || timeline?.sourceProbeDigest !== probe?.integrity?.digest) invalid('E_ROUGH_TIMELINE_STALE', 'rough render requires the current proxy timeline');
  if (!Array.isArray(timeline.items) || timeline.items.length === 0) invalid('E_ROUGH_TIMELINE_EMPTY', 'rough render requires at least one timeline item');
  const mediaById = new Map(probe.media.map((entry) => [entry.mediaId, entry]));
  const args = [];
  const filters = [];
  const sources = [];
  const proxyDigests = [];
  let musicDigest = null;
  let inputIndex = 0;
  const concatLabels = [];
  for (let index = 0; index < timeline.items.length; index += 1) {
    const item = timeline.items[index];
    const media = mediaById.get(item.sourceMediaId);
    if (!media?.proxy || item.sourceReference?.kind !== 'proxy' || item.sourceReference.path !== media.proxy.path
      || item.sourceReference.digest !== media.sourceDigest || item.assetReferences?.length || item.motionReferences?.length) {
      invalid('E_ROUGH_PROXY_REQUIRED', 'rough render plan may resolve only current analysis proxies');
    }
    const portablePath = media.proxy.path;
    const absolutePath = projectPath(project, portablePath);
    const destinationDuration = item.destinationOutSeconds - item.destinationInSeconds;
    const sourceDuration = item.sourceOutSeconds - item.sourceInSeconds;
    if (media.mediaType === 'image') {
      args.push('-loop', '1', '-t', seconds(destinationDuration), '-i', absolutePath);
    } else {
      args.push('-ss', seconds(item.sourceInSeconds), '-t', seconds(sourceDuration), '-i', absolutePath);
    }
    sources.push(portablePath);
    proxyDigests.push({ path: portablePath, digest: await sha256File(absolutePath) });
    const videoFilters = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1', 'fps=24',
    ];
    if (media.mediaType === 'image' && item.transform?.stillMotion?.mode === 'panzoom') {
      const endScale = item.transform.stillMotion.endScale;
      videoFilters.push(`zoompan=z='min(zoom+0.0015,${endScale})':d=${Math.max(1, Math.round(destinationDuration * 24))}:s=${width}x${height}:fps=24`);
    }
    videoFilters.push(
      `drawtext=text='${escapeDrawtext('ANALYSIS PROXY')}':x=w-tw-16:y=h-th-16:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.65`,
      `trim=duration=${seconds(destinationDuration)}`, 'setpts=PTS-STARTPTS', 'format=yuv420p',
    );
    const hasAudio = media.streams?.some(({ type }) => type === 'audio') && media.mediaType !== 'image';
    const curve = item.playbackRateCurve ?? [
      { sourceTimeSeconds: item.sourceInSeconds, rate: item.playbackRate ?? 1 },
      { sourceTimeSeconds: item.sourceOutSeconds, rate: item.playbackRate ?? 1 },
    ];
    if (media.mediaType !== 'image' && curve.length > 1) {
      const segmentLabels = [];
      for (let segmentIndex = 0; segmentIndex < curve.length - 1; segmentIndex += 1) {
        const point = curve[segmentIndex];
        const next = curve[segmentIndex + 1];
        const relativeStart = point.sourceTimeSeconds - item.sourceInSeconds;
        const relativeEnd = next.sourceTimeSeconds - item.sourceInSeconds;
        filters.push(`[${inputIndex}:v]trim=start=${seconds(relativeStart)}:end=${seconds(relativeEnd)},setpts=(PTS-STARTPTS)/${seconds(point.rate)}[v${index}s${segmentIndex}]`);
        if (hasAudio) {
          filters.push(`[${inputIndex}:a]atrim=start=${seconds(relativeStart)}:end=${seconds(relativeEnd)},asetpts=PTS-STARTPTS,${atempoFilters(point.rate).join(',')}[a${index}s${segmentIndex}]`);
        } else {
          filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds((next.sourceTimeSeconds - point.sourceTimeSeconds) / point.rate)}[a${index}s${segmentIndex}]`);
        }
        segmentLabels.push(`[v${index}s${segmentIndex}][a${index}s${segmentIndex}]`);
      }
      filters.push(`${segmentLabels.join('')}concat=n=${curve.length - 1}:v=1:a=1[v${index}raw][a${index}raw]`);
      filters.push(`[v${index}raw]${videoFilters.join(',')}[v${index}]`);
      const audioFilters = [];
      if (item.audioPolicy?.denoise === true) audioFilters.push('afftdn');
      audioFilters.push(`volume=${seconds(10 ** ((item.audioPolicy?.sourceGainDb ?? 0) / 20))}`, `apad=whole_dur=${seconds(destinationDuration)}`, `atrim=duration=${seconds(destinationDuration)}`);
      filters.push(`[a${index}raw]${audioFilters.join(',')}[a${index}]`);
    } else {
      filters.push(`[${inputIndex}:v]${videoFilters.join(',')}[v${index}]`);
      filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds(destinationDuration)}[a${index}]`);
    }
    concatLabels.push(`[v${index}][a${index}]`);
    inputIndex += 1;
  }
  const music = timeline.music;
  const totalDuration = timeline.items.reduce((total, item) => total + item.destinationOutSeconds - item.destinationInSeconds, 0);
  const hasMusic = music?.mode === 'local';
  filters.push(`${concatLabels.join('')}concat=n=${timeline.items.length}:v=1:a=1[vrough][${hasMusic ? 'abase' : 'arough'}]`);
  if (hasMusic) {
    let musicPath;
    let musicProbe;
    try {
      musicPath = projectPath(project, music.path);
      musicDigest = { path: music.path, digest: await sha256File(musicPath) };
      musicProbe = await ffprobeJson(musicPath);
    } catch {
      invalid('E_MUSIC_LOCAL_MISSING', 'selected local music must exist and decode inside the project');
    }
    const trackDuration = Number(musicProbe.format?.duration);
    const trimIn = music.trimInSeconds ?? 0;
    const available = trackDuration - trimIn;
    const crossfade = music.loopCrossfadeSeconds ?? 0;
    if (!(available > 0) || !musicProbe.streams?.some(({ codec_type: type }) => type === 'audio')) invalid('E_MUSIC_LOCAL_INVALID', 'selected local music needs a positive decodable audio interval');
    if (totalDuration > available && music.loop !== true) invalid('E_MUSIC_TOO_SHORT', 'local music must cover the rough cut or declare a crossfaded loop');
    if (music.loop === true && !(crossfade > 0 && crossfade < available)) invalid('E_MUSIC_LOOP_SEAM', 'looped local music needs a crossfade shorter than the usable track interval');
    args.push('-i', musicPath);
    const musicIndex = inputIndex;
    let musicLabel;
    if (totalDuration > available) {
      const copies = Math.max(2, Math.ceil((totalDuration - crossfade) / (available - crossfade)));
      const splitLabels = Array.from({ length: copies }, (_, copy) => `[music${copy}]`).join('');
      filters.push(`[${musicIndex}:a]asplit=${copies}${splitLabels}`);
      for (let copy = 0; copy < copies; copy += 1) {
        filters.push(`[music${copy}]atrim=start=${seconds(trimIn)}:end=${seconds(trackDuration)},asetpts=PTS-STARTPTS[musicTrim${copy}]`);
      }
      let prior = 'musicTrim0';
      for (let copy = 1; copy < copies; copy += 1) {
        const next = `musicCross${copy}`;
        filters.push(`[${prior}][musicTrim${copy}]acrossfade=d=${seconds(crossfade)}:c1=tri:c2=tri[${next}]`);
        prior = next;
      }
      musicLabel = prior;
    } else {
      filters.push(`[${musicIndex}:a]atrim=start=${seconds(trimIn)}:duration=${seconds(totalDuration)},asetpts=PTS-STARTPTS[musicTrim]`);
      musicLabel = 'musicTrim';
    }
    const fadeIn = Math.min(music.fadeInSeconds ?? 0, totalDuration);
    const fadeOut = Math.min(music.fadeOutSeconds ?? 0, totalDuration);
    const gain = 10 ** ((music.gainDb ?? -18) / 20);
    const treatments = [`atrim=duration=${seconds(totalDuration)}`, `volume=${seconds(gain)}`];
    if (fadeIn > 0) treatments.push(`afade=t=in:st=0:d=${seconds(fadeIn)}`);
    if (fadeOut > 0) treatments.push(`afade=t=out:st=${seconds(totalDuration - fadeOut)}:d=${seconds(fadeOut)}`);
    filters.push(`[${musicLabel}]${treatments.join(',')}[musicReady]`);
    filters.push('[musicReady][abase]sidechaincompress=threshold=0.03:ratio=6[duckedMusic]');
    filters.push('[abase][duckedMusic]amix=inputs=2:duration=first:dropout_transition=0[arough]');
  }
  args.push('-filter_complex', filters.join(';'), '-map', '[vrough]', '-map', '[arough]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath ?? projectPath(project, 'renders/rough-cut.mp4'));
  return {
    command: 'ffmpeg', args, sources, proxyDigests,
    raster: { width, height }, watermark: 'ANALYSIS PROXY', preservesAudio: true, musicDigest,
  };
}
