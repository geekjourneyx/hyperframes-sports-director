import assert from 'node:assert/strict';
import test from 'node:test';

import { findProtectedSpeechCuts, validateAudioContinuity } from '../lib/audio.mjs';

function item(itemId, destinationInSeconds, destinationOutSeconds, bridge = 'none') {
  return {
    itemId, sourceMediaId: 'media-a', sourceInSeconds: destinationInSeconds, sourceOutSeconds: destinationOutSeconds,
    destinationInSeconds, destinationOutSeconds, audioPolicy: { bridge },
  };
}

test('cut at 4.7 inside protected 4.0-5.2 speech requires an L/J/ambience bridge', () => {
  const transcript = { status: 'available', segments: [{ transcriptId: 'transcript-a', mediaId: 'media-a', sourceInSeconds: 4, sourceOutSeconds: 5.2, text: 'protected speech', confidence: 1 }] };
  const timeline = { items: [item('item-a', 0, 4.7), item('item-b', 4.7, 8)] };
  assert.deepEqual(findProtectedSpeechCuts(timeline, transcript).map(({ cutSeconds }) => cutSeconds), [4.7]);
  assert.ok(validateAudioContinuity(timeline, transcript).errors.some(({ code }) => code === 'E_PROTECTED_SPEECH_CUT'));

  for (const bridge of ['l-cut', 'j-cut', 'ambience']) {
    const bridged = { items: [item('item-a', 0, 4.7, bridge), item('item-b', 4.7, 8)] };
    assert.equal(validateAudioContinuity(bridged, transcript).errors.length, 0, bridge);
  }
});
test('local music loop needs a crossfade and remote/provider automation is rejected', () => {
  const noCrossfade = validateAudioContinuity({ items: [], music: { mode: 'local', path: 'media/music/track.m4a', loop: true, loopCrossfadeSeconds: 0 } }, { status: 'unavailable', segments: [] });
  assert.ok(noCrossfade.errors.some(({ code }) => code === 'E_MUSIC_LOOP_SEAM'));

  for (const music of [
    { mode: 'local', path: 'https://suno.com/song.mp3', loop: false, loopCrossfadeSeconds: 0 },
    { mode: 'provider', provider: 'suno', automation: true },
  ]) {
    const result = validateAudioContinuity({ items: [], music }, { status: 'unavailable', segments: [] });
    assert.ok(result.errors.some(({ code }) => code === 'E_REMOTE_MUSIC_FORBIDDEN'));
  }
});
