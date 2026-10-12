/**
 * Interpreter for a practical JSON Schema subset (draft 2020-12 keywords listed below).
 * Interpreted rather than compiled to code, so untrusted schemas cannot execute anything.
 * Supported: type, enum, const, required, properties, additionalProperties, items,
 * minItems, maxItems, minLength, maxLength, pattern, minimum, maximum, format (email, uri, date-time, date).
 */
export interface SchemaError {
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

const FORMATS: Record<string, (s: string) => boolean> = {
  email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  uri: (s) => {
    try {
      new URL(s);
      return true;
    } catch {
      return false;
    }
  },
  'date-time': (s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s)),
  date: (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
};

export function validateJsonSchema(value: unknown, schema: Schema, path = '$', errors: SchemaError[] = [], depth = 0): SchemaError[] {
  if (depth > 32 || errors.length > 100) return errors;
  const push = (message: string) => errors.push({ path, message });

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const actual = typeOf(value);
    const ok = types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) {
      push(`expected ${types.join(' | ')}, got ${actual}`);
      return errors;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    push(`must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) push(`must equal ${JSON.stringify(schema.const)}`);

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) push(`must be at least ${schema.minLength} characters`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) push(`must be at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string' && schema.pattern.length <= 500 && !new RegExp(schema.pattern, 'u').test(value)) push(`must match ${schema.pattern}`);
    if (typeof schema.format === 'string' && FORMATS[schema.format] && !FORMATS[schema.format]!(value)) push(`must be a valid ${schema.format}`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) push(`must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) push(`must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) push(`must have at least ${schema.minItems} items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) push(`must have at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((v, i) => validateJsonSchema(v, schema.items as Schema, `${path}[${i}]`, errors, depth + 1));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const req of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!Object.prototype.hasOwnProperty.call(obj, req)) errors.push({ path: `${path}.${req}`, message: 'is required' });
    }
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const [k, v] of Object.entries(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validateJsonSchema(v, props[k]!, `${path}.${k}`, errors, depth + 1);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${k}`, message: 'is not allowed' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateJsonSchema(v, schema.additionalProperties as Schema, `${path}.${k}`, errors, depth + 1);
      }
    }
  }
  return errors;
}
