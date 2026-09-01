export class CliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function parseCliArguments(argv, definitions) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new CliError('E_USAGE', `unexpected positional argument: ${argument}`);
    const name = argument.slice(2);
    const definition = definitions[name];
    if (!definition) throw new CliError('E_USAGE', `unknown option: --${name}`);
    if (definition.type === 'boolean') {
      result[definition.key ?? name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new CliError('E_USAGE', `missing value for --${name}`);
    index += 1;
    const key = definition.key ?? name;
    if (definition.type === 'number') {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new CliError('E_USAGE', `--${name} must be a number`);
      result[key] = number;
    } else if (definition.type === 'list') {
      result[key] = [...(result[key] ?? []), ...value.split(',').filter(Boolean)];
    } else {
      result[key] = value;
    }
  }
  for (const [name, definition] of Object.entries(definitions)) {
    const key = definition.key ?? name;
    if (definition.required && result[key] === undefined) throw new CliError('E_USAGE', `missing required option: --${name}`);
  }
  return result;
}

export function errorResult(error) {
  return {
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'E_INTERNAL',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
