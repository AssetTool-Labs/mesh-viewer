export interface StepRef {
  readonly kind: 'ref';
  readonly id: number;
}

export interface StepEnum {
  readonly kind: 'enum';
  readonly value: string;
}

export interface StepCall {
  readonly kind: 'call';
  readonly name: string;
  readonly args: StepValue[];
}

export interface StepBinary {
  readonly kind: 'binary';
  readonly value: string;
}

export type StepValue = number | string | null | StepRef | StepEnum | StepCall | StepBinary | StepValue[];

export interface StepEntity {
  readonly id: number;
  readonly type: string;
  readonly args: StepValue[];
  readonly components?: ReadonlyMap<string, StepValue[]>;
}

export interface StepDocument {
  readonly entities: ReadonlyMap<number, StepEntity>;
  readonly byType: ReadonlyMap<string, readonly StepEntity[]>;
}

type TokenKind = 'ref' | 'number' | 'string' | 'binary' | 'enum' | 'identifier' | 'symbol';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly offset: number;
}

class TokenStream {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset];
  }

  take(): Token {
    const token = this.tokens[this.index++];
    if (!token) throw new Error('Unexpected end of STEP data.');
    return token;
  }

  consume(value: string): boolean {
    if (this.peek()?.value !== value) return false;
    this.index++;
    return true;
  }

  expect(value: string): Token {
    const token = this.take();
    if (token.value !== value) {
      throw new Error(`Expected "${value}" at byte ${token.offset}, found "${token.value}".`);
    }
    return token;
  }
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;

  while (offset < source.length) {
    const char = source[offset];
    if (/\s/.test(char)) {
      offset++;
      continue;
    }
    if (char === '/' && source[offset + 1] === '*') {
      const end = source.indexOf('*/', offset + 2);
      if (end < 0) throw new Error(`Unterminated STEP comment at byte ${offset}.`);
      offset = end + 2;
      continue;
    }
    if (char === "'") {
      const start = offset++;
      let value = '';
      let closed = false;
      while (offset < source.length) {
        if (source[offset] !== "'") {
          value += source[offset++];
          continue;
        }
        if (source[offset + 1] === "'") {
          value += "'";
          offset += 2;
          continue;
        }
        offset++;
        closed = true;
        break;
      }
      if (!closed) throw new Error(`Unterminated STEP string at byte ${start}.`);
      tokens.push({ kind: 'string', value, offset: start });
      continue;
    }
    if (char === '"') {
      const start = offset++;
      const end = source.indexOf('"', offset);
      if (end < 0) throw new Error(`Unterminated STEP binary literal at byte ${start}.`);
      const value = source.slice(offset, end);
      if (!/^[0-9A-Fa-f]*$/.test(value)) throw new Error(`Invalid STEP binary literal at byte ${start}.`);
      tokens.push({ kind: 'binary', value: value.toUpperCase(), offset: start });
      offset = end + 1;
      continue;
    }
    if (char === '#') {
      const start = offset++;
      const digits = /^\d+/.exec(source.slice(offset))?.[0];
      if (!digits) throw new Error(`Invalid STEP reference at byte ${start}.`);
      tokens.push({ kind: 'ref', value: digits, offset: start });
      offset += digits.length;
      continue;
    }
    if (char === '.') {
      const start = offset;
      const match = /^\.[A-Za-z0-9_]+\./.exec(source.slice(offset));
      if (match) {
        tokens.push({ kind: 'enum', value: match[0].slice(1, -1).toUpperCase(), offset: start });
        offset += match[0].length;
        continue;
      }
    }
    if (/[+\-.0-9]/.test(char)) {
      const start = offset;
      const match = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[Ee][+-]?\d+)?/.exec(source.slice(offset));
      if (match) {
        tokens.push({ kind: 'number', value: match[0], offset: start });
        offset += match[0].length;
        continue;
      }
    }
    if (/[A-Za-z_!]/.test(char)) {
      const start = offset;
      const value = /^[A-Za-z_!][A-Za-z0-9_!\-]*/.exec(source.slice(offset))?.[0] ?? '';
      tokens.push({ kind: 'identifier', value: value.toUpperCase(), offset: start });
      offset += value.length;
      continue;
    }
    if ('(),;=$*'.includes(char)) {
      tokens.push({ kind: 'symbol', value: char, offset });
      offset++;
      continue;
    }
    throw new Error(`Unexpected character "${char}" in STEP data at byte ${offset}.`);
  }

  return tokens;
}

function parseValue(stream: TokenStream): StepValue {
  const token = stream.take();
  switch (token.kind) {
    case 'ref':
      return { kind: 'ref', id: Number(token.value) };
    case 'number':
      return Number(token.value);
    case 'string':
      return token.value;
    case 'binary':
      return { kind: 'binary', value: token.value };
    case 'enum':
      return { kind: 'enum', value: token.value };
    case 'identifier': {
      if (!stream.consume('(')) return token.value;
      return { kind: 'call', name: token.value, args: parseListBody(stream) };
    }
    case 'symbol':
      if (token.value === '$' || token.value === '*') return null;
      if (token.value === '(') return parseListBody(stream);
      break;
  }
  throw new Error(`Unexpected token "${token.value}" at byte ${token.offset}.`);
}

function parseListBody(stream: TokenStream): StepValue[] {
  const values: StepValue[] = [];
  if (stream.consume(')')) return values;
  do {
    values.push(parseValue(stream));
  } while (stream.consume(','));
  stream.expect(')');
  return values;
}

function parseCall(stream: TokenStream): StepCall {
  const name = stream.take();
  if (name.kind !== 'identifier') {
    throw new Error(`Expected an entity name at byte ${name.offset}, found "${name.value}".`);
  }
  stream.expect('(');
  return { kind: 'call', name: name.value, args: parseListBody(stream) };
}

export function parsePart21(source: string): StepDocument {
  if (!/^\s*ISO-10303-21\s*;/i.test(source)) {
    throw new Error('Not an ISO-10303-21 STEP file.');
  }

  const stream = new TokenStream(tokenize(source));
  const entities = new Map<number, StepEntity>();
  const byType = new Map<string, StepEntity[]>();

  while (stream.peek()) {
    const first = stream.peek();
    if (first?.kind !== 'ref' || stream.peek(1)?.value !== '=') {
      stream.take();
      continue;
    }

    const id = Number(stream.take().value);
    stream.expect('=');
    let entity: StepEntity;
    if (stream.consume('(')) {
      const components = new Map<string, StepValue[]>();
      while (!stream.consume(')')) {
        const component = parseCall(stream);
        components.set(component.name, component.args);
      }
      const primary = [...components.entries()].find(([, args]) => args.length > 0) ?? [...components.entries()][0];
      entity = {
        id,
        type: primary?.[0] ?? 'COMPLEX_ENTITY',
        args: primary?.[1] ?? [],
        components,
      };
    } else {
      const call = parseCall(stream);
      entity = { id, type: call.name, args: call.args };
    }
    stream.expect(';');
    if (entities.has(id)) throw new Error(`Duplicate STEP entity #${id}.`);
    entities.set(id, entity);
    const list = byType.get(entity.type) ?? [];
    list.push(entity);
    byType.set(entity.type, list);
    for (const type of entity.components?.keys() ?? []) {
      if (type === entity.type) continue;
      const componentList = byType.get(type) ?? [];
      componentList.push(entity);
      byType.set(type, componentList);
    }
  }

  if (entities.size === 0) throw new Error('The STEP DATA section contains no entities.');
  return { entities, byType };
}

export function entityArgs(entity: StepEntity, type = entity.type): readonly StepValue[] | undefined {
  if (entity.type === type) return entity.args;
  return entity.components?.get(type);
}

export function isStepRef(value: StepValue | undefined): value is StepRef {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && value.kind === 'ref';
}

export function isStepEnum(value: StepValue | undefined, expected?: string): value is StepEnum {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === 'enum' &&
    (expected === undefined || value.value === expected)
  );
}

export function isStepCall(value: StepValue | undefined, name?: string): value is StepCall {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.kind === 'call' &&
    (name === undefined || value.name === name)
  );
}