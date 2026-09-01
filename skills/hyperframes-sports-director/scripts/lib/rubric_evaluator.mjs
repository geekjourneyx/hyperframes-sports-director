const OPERATOR_NAMES = new Set([
  'any-equals',
  'any-fabricated-or-zero-filled-missing-source',
  'any-missing-required-fields',
  'count-at-least',
  'equals',
  'every-equals',
  'every-exists-and-nonempty',
  'every-in-set',
  'every-references',
  'every-references-or-unavailable',
  'exists-and-nonempty',
  'file-exists-with-extension',
  'invalid-final-mp4-inspection',
  'matches-requested-delivery-constraints',
  'matches-requested-fields',
  'missing-required-fields',
  'missing-source-is-null-or-status-unavailable',
  'none-equals',
  'some-exists-and-nonempty',
  'some-in-set',
  'some-references',
]);

const APPLICABILITY_MODES = new Set([
  'always',
  'any-dimension-active',
  'dimension-active',
  'prompt-or-output-copy-requested',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmpty(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return isObject(value) ? Object.keys(value).length > 0 : value !== null && value !== undefined;
}

function pathValues(root, path) {
  if (typeof path !== 'string' || !path) return [];
  let values = [root];
  for (const part of path.split('.')) {
    const isWildcard = part.endsWith('[*]');
    const key = isWildcard ? part.slice(0, -3) : part;
    const next = [];
    for (const value of values) {
      if (!isObject(value) && !Array.isArray(value)) continue;
      const child = value[key];
      if (isWildcard) {
        if (Array.isArray(child)) next.push(...child);
      } else if (child !== undefined) {
        next.push(child);
      }
    }
    values = next;
  }
  return values;
}

function recordValues(root, path) {
  const parts = String(path).split('.');
  parts.pop();
  if (parts.length === 0) return [];
  return pathValues(root, parts.join('.'));
}

function expectedValues(root, expected) {
  if (expected === 'original-or-explicit-derivative') return ['original', 'explicit-derivative'];
  if (expected === 'source-or-licensed') return ['source', 'licensed'];
  return typeof expected === 'string' && expected.includes('.') ? pathValues(root, expected) : [expected];
}

function allPresent(values) {
  return values.length > 0 && values.every(isNonEmpty);
}

function requestedCopyFields(prompt) {
  const text = String(prompt || '').toLowerCase();
  const fields = [];
  if (text.includes('title') || text.includes('标题')) fields.push('title');
  if (text.includes('chapter') || text.includes('章节')) fields.push('chapter');
  if (text.includes('closing reflection') || text.includes('closing') || text.includes('收尾')) fields.push('closing_reflection');
  return fields;
}

function matchesDelivery(finalMp4, prompt) {
  if (!isObject(finalMp4)) return false;
  const text = String(prompt || '').toLowerCase();
  if (text.includes('4k') && !(Number(finalMp4.width) >= 3840 && Number(finalMp4.height) >= 2160)) return false;
  if (text.includes('16:9')) {
    const aspect = finalMp4.aspect_ratio === '16:9'
      || (Number.isFinite(Number(finalMp4.width)) && Number.isFinite(Number(finalMp4.height))
        && Math.abs(Number(finalMp4.width) / Number(finalMp4.height) - 16 / 9) < 0.001);
    if (!aspect) return false;
  }
  const sizeMatch = text.match(/(?:under|below|不超过|小于)\s*([0-9]+(?:\.[0-9]+)?)\s*gb/i)
    ?? text.match(/([0-9]+(?:\.[0-9]+)?)\s*gb/i);
  if (sizeMatch) {
    const limit = Number(sizeMatch[1]);
    const size = Number.isFinite(Number(finalMp4.file_size_gb))
      ? Number(finalMp4.file_size_gb)
      : Number(finalMp4.file_size_bytes) / 1_000_000_000;
    if (!Number.isFinite(size) || size > limit) return false;
  }
  return true;
}

function invalidFinalInspection(finalMp4, expected) {
  if (!isObject(finalMp4) || !isObject(expected)) return true;
  const requiredFields = Array.isArray(expected.required_fields) ? expected.required_fields : [];
  if (requiredFields.some((field) => !isNonEmpty(finalMp4[field]))) return true;
  if (finalMp4.inspection !== expected.inspection) return true;
  if (finalMp4.audio_stream_check !== expected.audio_stream_check) return true;
  const samples = finalMp4.decoded_sample_times;
  if (!Array.isArray(samples) || samples.length < expected.minimum_decoded_samples) return true;
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) return true;
  return new Set(samples).size !== samples.length;
}

function atomMatches(root, atom, prompt) {
  const values = pathValues(root, atom.path);
  const expected = expectedValues(root, atom.expected);
  const expectedSet = new Set(expected);
  const records = recordValues(root, atom.path);

  switch (atom.operator) {
    case 'exists-and-nonempty':
      return values.some(isNonEmpty);
    case 'every-in-set':
    case 'every-references':
      return values.length > 0 && values.every((value) => expectedSet.has(value));
    case 'some-in-set':
    case 'some-references':
      return values.some((value) => expectedSet.has(value));
    case 'none-equals':
      return values.every((value) => value !== atom.expected);
    case 'equals':
      return values.length === 1 && values[0] === atom.expected;
    case 'every-exists-and-nonempty':
      return allPresent(values);
    case 'every-equals':
      return values.length > 0 && values.every((value) => value === atom.expected);
    case 'some-exists-and-nonempty':
      return values.some(isNonEmpty);
    case 'every-references-or-unavailable':
      return values.length > 0 && values.every((value) => expectedSet.has(value) || value === 'unavailable');
    case 'missing-source-is-null-or-status-unavailable':
      return records.length > 0 && records.every((record) => {
        if (!isObject(record)) return false;
        if (isNonEmpty(record.source_asset_id)) return true;
        return record.value === null || record.status === 'unavailable';
      });
    case 'file-exists-with-extension':
      return values.length === 1 && typeof values[0] === 'string' && values[0].toLowerCase().endsWith(String(atom.expected).toLowerCase());
    case 'count-at-least': {
      const count = values.length === 1 && Array.isArray(values[0]) ? values[0].length : values.length;
      return count >= Number(atom.expected);
    }
    case 'matches-requested-fields': {
      const copy = values[0];
      if (!isObject(copy)) return false;
      const fields = requestedCopyFields(prompt);
      return fields.length > 0 ? fields.every((field) => isNonEmpty(copy[field])) : isNonEmpty(copy);
    }
    case 'matches-requested-delivery-constraints':
      return matchesDelivery(values[0], prompt);
    case 'any-fabricated-or-zero-filled-missing-source':
      return values.some((record) => isObject(record) && !isNonEmpty(record.source_asset_id)
        && record.value !== null && record.status !== 'unavailable');
    case 'any-equals':
      return values.some((value) => value === atom.expected);
    case 'any-missing-required-fields':
      return values.some((record) => !isObject(record) || atom.expected.some((field) => !isNonEmpty(record[field])));
    case 'missing-required-fields':
      return !isObject(values[0]) || atom.expected.some((field) => !isNonEmpty(values[0][field]));
    case 'invalid-final-mp4-inspection':
      return invalidFinalInspection(values[0], atom.expected);
    default:
      return false;
  }
}

function conditionMatches(root, condition, prompt) {
  if (!isObject(condition)) return false;
  if (Array.isArray(condition.all)) return condition.all.every((child) => conditionMatches(root, child, prompt));
  if (Array.isArray(condition.any)) return condition.any.some((child) => conditionMatches(root, child, prompt));
  if (condition.not !== undefined) return !conditionMatches(root, condition.not, prompt);
  return atomMatches(root, condition, prompt);
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function validateCondition(condition, diagnostics) {
  if (!isObject(condition)) {
    diagnostics.push('E_CONDITION_OBJECT');
    return;
  }
  for (const key of ['all', 'any']) {
    if (condition[key] !== undefined) {
      if (!Array.isArray(condition[key])) diagnostics.push(`E_CONDITION_${key.toUpperCase()}`);
      else condition[key].forEach((child) => validateCondition(child, diagnostics));
      return;
    }
  }
  if (condition.not !== undefined) {
    validateCondition(condition.not, diagnostics);
    return;
  }
  if (typeof condition.path !== 'string' || typeof condition.operator !== 'string') {
    diagnostics.push('E_CONDITION_ATOM');
    return;
  }
  if (!OPERATOR_NAMES.has(condition.operator)) diagnostics.push(`E_OPERATOR_UNSUPPORTED:${condition.operator}`);
}

function validateApplicability(applicability, dimensions, diagnostics) {
  if (!isObject(applicability) || typeof applicability.mode !== 'string') {
    diagnostics.push('E_APPLICABILITY');
    return;
  }
  if (!APPLICABILITY_MODES.has(applicability.mode)) diagnostics.push(`E_APPLICABILITY_MODE_UNSUPPORTED:${applicability.mode}`);
  const ids = new Set(dimensions.map((dimension) => dimension.id));
  const referenced = applicability.mode === 'dimension-active'
    ? [applicability.dimension]
    : applicability.mode === 'any-dimension-active' ? applicability.dimensions : [];
  if (!Array.isArray(referenced)) diagnostics.push('E_APPLICABILITY_DIMENSIONS');
  else referenced.forEach((id) => {
    if (!ids.has(id)) diagnostics.push(`E_APPLICABILITY_DIMENSION_UNKNOWN:${id}`);
  });
}

function validateRubric(rubric) {
  const diagnostics = [];
  if (!isObject(rubric)) return ['E_RUBRIC_OBJECT'];
  const scoring = rubric.scoring;
  if (!isObject(scoring)
    || !Number.isFinite(scoring.maximum_score)
    || !Number.isFinite(scoring.passing_score)
    || scoring.rounding !== 'round-half-up'
    || scoring.na_denominator_normalization !== true) diagnostics.push('E_RUBRIC_SCORING');
  const dimensions = isObject(rubric.applicability) && Array.isArray(rubric.applicability.dimensions)
    ? rubric.applicability.dimensions : [];
  if (!isObject(rubric.applicability) || !Array.isArray(rubric.applicability.dimensions)) diagnostics.push('E_RUBRIC_APPLICABILITY');
  else dimensions.forEach((dimension) => {
    if (!isObject(dimension) || typeof dimension.id !== 'string' || !Array.isArray(dimension.prompt_signals) || !Array.isArray(dimension.output_signals)) diagnostics.push('E_RUBRIC_DIMENSION');
  });
  if (!Array.isArray(rubric.criteria)) diagnostics.push('E_RUBRIC_CRITERIA');
  else rubric.criteria.forEach((criterion) => {
    if (!isObject(criterion) || typeof criterion.id !== 'string' || !Number.isFinite(criterion.points)
      || !Array.isArray(criterion.checks) || !Array.isArray(criterion.partial_credit)) {
      diagnostics.push('E_RUBRIC_CRITERION');
      return;
    }
    validateApplicability(criterion.applicability, dimensions, diagnostics);
    criterion.checks.forEach((check) => validateCondition(check, diagnostics));
    criterion.partial_credit.forEach((partial) => {
      if (!isObject(partial) || !Number.isFinite(partial.award_points)) diagnostics.push('E_PARTIAL_CREDIT');
      else validateCondition(partial.condition, diagnostics);
    });
  });
  if (!Array.isArray(rubric.hard_failures)) diagnostics.push('E_RUBRIC_HARD_FAILURES');
  else rubric.hard_failures.forEach((failure) => {
    if (!isObject(failure) || typeof failure.id !== 'string') diagnostics.push('E_RUBRIC_HARD_FAILURE');
    else validateCondition(failure.condition, diagnostics);
  });
  return uniqueSorted(diagnostics);
}

function activeDimensionIds(root, prompt, dimensions) {
  const text = String(prompt || '').toLowerCase();
  return new Set(dimensions.filter((dimension) => {
    const promptActive = dimension.prompt_signals.some((signal) => text.includes(String(signal).toLowerCase()));
    const outputActive = dimension.output_signals.some((path) => pathValues(root, path).some(isNonEmpty));
    return promptActive || outputActive;
  }).map((dimension) => dimension.id));
}

function isApplicable(criterion, activeDimensions, root, prompt) {
  switch (criterion.applicability.mode) {
    case 'always':
      return true;
    case 'dimension-active':
      return activeDimensions.has(criterion.applicability.dimension);
    case 'any-dimension-active':
      return criterion.applicability.dimensions.some((dimension) => activeDimensions.has(dimension));
    case 'prompt-or-output-copy-requested':
      return criterion.applicability.prompt_signals.some((signal) => String(prompt || '').toLowerCase().includes(String(signal).toLowerCase()))
        || criterion.applicability.output_signals.some((path) => pathValues(root, path).some(isNonEmpty));
    default:
      return false;
  }
}

function roundHalfUp(value) {
  return Math.floor(value + 0.5);
}

/**
 * Deterministically evaluates one output against a parsed rubric.
 * It never throws for malformed caller input; invalid contracts return stable diagnostics.
 */
export function evaluateRubric({ rubric, prompt = '', evaluatedOutput = {} } = {}) {
  const diagnostics = validateRubric(rubric);
  if (diagnostics.length > 0) {
    return {
      status: 'invalid',
      score: 0,
      applicable_points: 0,
      criteria: [],
      hard_failures: [],
      diagnostics,
    };
  }

  const output = isObject(evaluatedOutput) ? evaluatedOutput : {};
  const root = { prompt: String(prompt || ''), evaluated_output: output };
  const activeDimensions = activeDimensionIds(root, prompt, rubric.applicability.dimensions);
  let awardedPoints = 0;
  let applicablePoints = 0;
  const criteria = rubric.criteria.map((criterion) => {
    if (!isApplicable(criterion, activeDimensions, root, prompt)) {
      return { id: criterion.id, status: 'not-applicable', awarded_points: 0, available_points: criterion.points };
    }
    applicablePoints += criterion.points;
    if (criterion.checks.every((check) => conditionMatches(root, check, prompt))) {
      awardedPoints += criterion.points;
      return { id: criterion.id, status: 'full', awarded_points: criterion.points, available_points: criterion.points };
    }
    const partial = criterion.partial_credit.find((entry) => conditionMatches(root, entry.condition, prompt));
    if (partial) {
      awardedPoints += partial.award_points;
      return { id: criterion.id, status: 'partial', awarded_points: partial.award_points, available_points: criterion.points };
    }
    return { id: criterion.id, status: 'zero', awarded_points: 0, available_points: criterion.points };
  });
  const hardFailures = rubric.hard_failures
    .filter((failure) => conditionMatches(root, failure.condition, prompt))
    .map((failure) => failure.id);
  const score = applicablePoints === 0 ? 0 : roundHalfUp(100 * awardedPoints / applicablePoints);
  return {
    status: hardFailures.length > 0 || score < rubric.scoring.passing_score ? 'fail' : 'pass',
    score,
    applicable_points: applicablePoints,
    criteria,
    hard_failures: hardFailures,
    diagnostics: [],
  };
}

export const SUPPORTED_OPERATORS = Object.freeze([...OPERATOR_NAMES].sort());
export const SUPPORTED_APPLICABILITY_MODES = Object.freeze([...APPLICABILITY_MODES].sort());
