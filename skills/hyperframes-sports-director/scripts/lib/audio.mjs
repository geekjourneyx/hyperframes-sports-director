const BRIDGES = new Set(['l-cut', 'j-cut', 'room-tone', 'ambience']);

function diagnostic(code, path, message, details = {}) {
  return { code, path, message, ...details };
}

function sourceTimeAtDestination(item, destinationSeconds) {
  const destinationDuration = item.destinationOutSeconds - item.destinationInSeconds;
  const sourceDuration = item.sourceOutSeconds - item.sourceInSeconds;
  if (!(destinationDuration > 0) || !(sourceDuration >= 0)) return null;
  return item.sourceInSeconds + ((destinationSeconds - item.destinationInSeconds) / destinationDuration) * sourceDuration;
}

function hasBridge(previous, next) {
  return BRIDGES.has(previous?.audioPolicy?.bridge) || BRIDGES.has(next?.audioPolicy?.bridge);
}

export function findProtectedSpeechCuts(timeline, transcript) {
  if (transcript?.status !== 'available') return [];
  const items = [...(timeline?.items ?? [])].sort((left, right) => left.destinationInSeconds - right.destinationInSeconds);
  const findings = [];
  for (let index = 0; index < items.length - 1; index += 1) {
    const previous = items[index];
    const next = items[index + 1];
    const cutSeconds = previous.destinationOutSeconds;
    if (cutSeconds !== next.destinationInSeconds || hasBridge(previous, next)) continue;
    const previousSourceCut = sourceTimeAtDestination(previous, cutSeconds);
    const nextSourceCut = sourceTimeAtDestination(next, cutSeconds);
    for (const span of transcript.segments ?? []) {
      const previousCutsSpan = span.mediaId === previous.sourceMediaId
        && previousSourceCut > span.sourceInSeconds && previousSourceCut < span.sourceOutSeconds;
      const nextCutsSpan = span.mediaId === next.sourceMediaId
        && nextSourceCut > span.sourceInSeconds && nextSourceCut < span.sourceOutSeconds;
      if (previousCutsSpan || nextCutsSpan) {
        findings.push({
          code: 'E_PROTECTED_SPEECH_CUT', cutSeconds, transcriptId: span.transcriptId,
          previousItemId: previous.itemId, nextItemId: next.itemId,
        });
      }
    }
  }
  return findings;
}

function validateMusic(music) {
  if (!music || music.mode === 'none') return [];
  const remote = music.mode !== 'local' || music.automation === true || music.provider !== undefined
    || typeof music.path !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(music.path)
    || music.path.startsWith('/') || music.path.includes('\\') || music.path.split('/').includes('..');
  if (remote) return [diagnostic('E_REMOTE_MUSIC_FORBIDDEN', '/music', 'v1 accepts only an explicit project-relative local music file')];
  if (music.loop === true && !(music.loopCrossfadeSeconds > 0)) {
    return [diagnostic('E_MUSIC_LOOP_SEAM', '/music/loopCrossfadeSeconds', 'a local music loop requires a positive crossfade')];
  }
  return [];
}

export function validateAudioContinuity(timeline, transcript) {
  const errors = findProtectedSpeechCuts(timeline, transcript).map((finding) => diagnostic(
    finding.code,
    `/items/${finding.previousItemId}`,
    'a cut inside protected speech requires an L-cut, J-cut, room-tone, or ambience bridge',
    finding,
  ));
  errors.push(...validateMusic(timeline?.music));
  return { valid: errors.length === 0, errors };
}
