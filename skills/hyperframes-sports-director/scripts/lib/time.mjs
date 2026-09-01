function fpsRatio(fps) {
  if (typeof fps === 'string') {
    const match = /^(\d+)\/(\d+)$/.exec(fps);
    if (!match || Number(match[2]) === 0) throw new TypeError('fps must be a positive number or rational');
    return { numerator: Number(match[1]), denominator: Number(match[2]) };
  }
  if (!Number.isFinite(fps) || fps <= 0) throw new TypeError('fps must be positive');
  return { numerator: fps, denominator: 1 };
}

export function secondsToFrames(seconds, fps) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('seconds must be non-negative');
  const { numerator, denominator } = fpsRatio(fps);
  return Math.round(seconds * numerator / denominator);
}

export function framesToSeconds(frames, fps) {
  if (!Number.isInteger(frames) || frames < 0) throw new TypeError('frames must be a non-negative integer');
  const { numerator, denominator } = fpsRatio(fps);
  return frames * denominator / numerator;
}
