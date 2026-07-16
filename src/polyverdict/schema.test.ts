/**
 * Tests for the PolyVerdict minimal JSON Schema subset: validation, type
 * coercion, and JSON-from-assistant extraction. Also exercises the enforce
 * trigger + single-shot enforcement helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  validateAndCoerce,
  stripMarkdownFences,
  parseJsonFromAssistant,
} from './schema';
import {
  detectSchemaTrigger,
  enforceOnce,
  buildRetryMessages,
  MAX_ENFORCE_ATTEMPTS,
} from './enforce';

describe('validateAndCoerce', () => {
  it('accepts a valid object against a properties/required schema', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name', 'age'],
    };
    const r = validateAndCoerce({ name: 'Ada', age: 36 }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ name: 'Ada', age: 36 });
  });

  it('reports a missing required property', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name', 'age'],
    };
    const r = validateAndCoerce({ name: 'Ada' }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('age'))).toBe(true);
    }
  });

  it('coerces a numeric string to a number', () => {
    const schema = { type: 'object', properties: { age: { type: 'number' } } };
    const r = validateAndCoerce({ age: '42' }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ age: 42 });
  });

  it('coerces a numeric string to an integer', () => {
    const r = validateAndCoerce('7', { type: 'integer' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(7);
  });

  it('rejects a non-integer numeric string for integer type', () => {
    const r = validateAndCoerce('7.5', { type: 'integer' });
    expect(r.ok).toBe(false);
  });

  it('coerces "true"/"false" strings to booleans', () => {
    const schema = {
      type: 'object',
      properties: { active: { type: 'boolean' }, deleted: { type: 'boolean' } },
    };
    const r = validateAndCoerce({ active: 'true', deleted: 'false' }, schema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ active: true, deleted: false });
  });

  it('coerces a number to a string when the schema says string', () => {
    const r = validateAndCoerce({ id: 42 }, {
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ id: '42' });
  });

  it('fails when an enum value is not allowed', () => {
    const schema = { type: 'string', enum: ['red', 'green', 'blue'] };
    const r = validateAndCoerce('purple', schema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/enum|one of/i);
  });

  it('accepts an allowed enum value', () => {
    const r = validateAndCoerce('green', {
      type: 'string',
      enum: ['red', 'green', 'blue'],
    });
    expect(r.ok).toBe(true);
  });

  it('validates and coerces nested objects and arrays', () => {
    const schema = {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: { id: { type: 'integer' }, name: { type: 'string' } },
          required: ['id'],
        },
        tags: { type: 'array', items: { type: 'string' } },
        scores: { type: 'array', items: { type: 'number' } },
      },
      required: ['user'],
    };
    const r = validateAndCoerce(
      {
        user: { id: '5', name: 'Grace' },
        tags: ['a', 'b'],
        scores: ['1', '2.5'],
      },
      schema,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        user: { id: 5, name: 'Grace' },
        tags: ['a', 'b'],
        scores: [1, 2.5],
      });
    }
  });

  it('reports errors from deep inside nested structures', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { qty: { type: 'integer' } },
            required: ['qty'],
          },
        },
      },
    };
    const r = validateAndCoerce({ items: [{ qty: 1 }, { name: 'x' }] }, schema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('[1]') && e.includes('qty'))).toBe(
        true,
      );
    }
  });

  it('ignores unknown keywords', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'number' } },
      additionalProperties: false,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      description: 'ignored',
    };
    const r = validateAndCoerce({ n: 1, extra: true }, schema);
    expect(r.ok).toBe(true);
  });
});

describe('stripMarkdownFences', () => {
  it('strips a ```json fenced block', () => {
    const text = '```json\n{"a":1}\n```';
    expect(stripMarkdownFences(text)).toBe('{"a":1}');
  });

  it('strips a bare ``` fenced block', () => {
    const text = '```\n{"a":1}\n```';
    expect(stripMarkdownFences(text)).toBe('{"a":1}');
  });

  it('extracts a fenced block embedded in prose', () => {
    const text = 'Here you go:\n```json\n{"ok":true}\n```\nHope that helps!';
    expect(stripMarkdownFences(text)).toBe('{"ok":true}');
  });

  it('returns trimmed text unchanged when no fence is present', () => {
    expect(stripMarkdownFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe('parseJsonFromAssistant', () => {
  it('parses fenced JSON', () => {
    const r = parseJsonFromAssistant('```json\n{"a":1}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1 });
  });

  it('extracts a JSON object from surrounding prose', () => {
    const r = parseJsonFromAssistant('Sure! {"a": 1, "b": [2, 3]} done.');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1, b: [2, 3] });
  });

  it('fails on non-JSON text', () => {
    const r = parseJsonFromAssistant('no json here at all');
    expect(r.ok).toBe(false);
  });
});

describe('detectSchemaTrigger', () => {
  it('detects an inline x-axion-schema header', () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    const headers = new Headers({ 'x-axion-schema': JSON.stringify(schema) });
    const t = detectSchemaTrigger(headers, {});
    expect(t).not.toBeNull();
    expect(t?.schema).toEqual(schema);
  });

  it('URL-decodes a percent-encoded header', () => {
    const schema = { type: 'string' };
    const encoded = encodeURIComponent(JSON.stringify(schema));
    const headers = new Headers({ 'x-axion-schema': encoded });
    const t = detectSchemaTrigger(headers, {});
    expect(t?.schema).toEqual(schema);
  });

  it('detects response_format.json_schema in the body', () => {
    const schema = { type: 'object' };
    const body = {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'Widget', schema },
      },
    };
    const t = detectSchemaTrigger(new Headers(), body);
    expect(t?.schema).toEqual(schema);
    expect(t?.name).toBe('Widget');
  });

  it('returns null when no trigger is present', () => {
    expect(detectSchemaTrigger(new Headers(), { messages: [] })).toBeNull();
  });
});

describe('enforceOnce', () => {
  it('accepts + coerces valid fenced JSON', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'number' } },
      required: ['n'],
    };
    const r = enforceOnce('```json\n{"n":"5"}\n```', schema);
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ n: 5 });
    expect(r.jsonText).toBe('{"n":5}');
  });

  it('reports parse failures', () => {
    const r = enforceOnce('definitely not json', { type: 'object' });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/parse failed/i);
  });

  it('reports schema violations', () => {
    const r = enforceOnce('{"n": "abc"}', {
      type: 'object',
      properties: { n: { type: 'number' } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('buildRetryMessages', () => {
  it('appends the failed output and a corrective user hint', () => {
    const messages = [{ role: 'user' as const, content: 'give me json' }];
    const next = buildRetryMessages(messages, {
      schema: { type: 'object' },
      errors: ['$.n: expected number, got string'],
      assistantText: '{"n":"x"}',
    });
    expect(next).toHaveLength(3);
    expect(next[1]).toEqual({ role: 'assistant', content: '{"n":"x"}' });
    expect(next[2]?.role).toBe('user');
    expect(next[2]?.content).toContain('$.n: expected number');
    // Original array is not mutated.
    expect(messages).toHaveLength(1);
  });
});

describe('MAX_ENFORCE_ATTEMPTS', () => {
  it('is capped at 3 per BUILD-SPEC', () => {
    expect(MAX_ENFORCE_ATTEMPTS).toBe(3);
  });
});
