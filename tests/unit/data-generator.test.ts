import { describe, it, expect } from 'vitest';
import {
  generateData,
  generateBatch,
  generateBoundaryValues,
  resolvePlaceholders,
  type DataTemplate,
  type BoundaryMode,
} from '../../src/utils/data-generator.js';

describe('Data Generator', () => {
  describe('generateData - string', () => {
    it('generates string with fixed length', () => {
      const result = generateData({ type: 'string', length: 10 }, { seed: 42 });
      expect(typeof result).toBe('string');
      expect((result as string).length).toBe(10);
    });

    it('generates string with charset alnum', () => {
      const result = generateData({ type: 'string', length: 20, charset: 'alnum' }, { seed: 1 });
      expect(typeof result).toBe('string');
      expect((result as string).length).toBe(20);
      expect(/^[a-zA-Z0-9]+$/.test(result as string)).toBe(true);
    });

    it('generates string with charset digit', () => {
      const result = generateData({ type: 'string', length: 8, charset: 'digit' }, { seed: 5 });
      expect(/^[0-9]+$/.test(result as string)).toBe(true);
    });
  });

  describe('generateData - number', () => {
    it('generates number in range', () => {
      const result = generateData({ type: 'number', min: 0, max: 100 }, { seed: 42 });
      expect(typeof result).toBe('number');
      expect(result as number).toBeGreaterThanOrEqual(0);
      expect(result as number).toBeLessThanOrEqual(100);
    });

    it('generates number with precision', () => {
      const result = generateData({ type: 'number', min: 0, max: 10, precision: 2 }, { seed: 7 });
      const decimals = (result as number).toString().split('.')[1];
      expect(decimals === undefined || decimals.length <= 2).toBe(true);
    });

    it('generates integer with step', () => {
      const result = generateData({ type: 'number', min: 0, max: 100, step: 10 }, { seed: 3 });
      expect(result as number % 10).toBe(0);
    });
  });

  describe('generateData - boolean', () => {
    it('generates a boolean', () => {
      const result = generateData({ type: 'boolean' }, { seed: 1 });
      expect(typeof result).toBe('boolean');
    });
  });

  describe('generateData - array', () => {
    it('generates array with count', () => {
      const result = generateData(
        { type: 'array', items: { type: 'number', min: 0, max: 100 }, count: 5 },
        { seed: 42 },
      );
      expect(Array.isArray(result)).toBe(true);
      expect((result as unknown[]).length).toBe(5);
    });

    it('generates empty array with count 0', () => {
      const result = generateData(
        { type: 'array', items: { type: 'string', length: 3 }, count: 0 },
        { seed: 1 },
      );
      expect(Array.isArray(result)).toBe(true);
      expect((result as unknown[]).length).toBe(0);
    });
  });

  describe('generateData - object', () => {
    it('generates object with properties', () => {
      const result = generateData(
        {
          type: 'object',
          properties: {
            name: { type: 'string', length: 5 },
            age: { type: 'number', min: 18, max: 99 },
          },
        },
        { seed: 10 },
      );
      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('name');
      expect(result).toHaveProperty('age');
      expect(typeof (result as any).name).toBe('string');
      expect(typeof (result as any).age).toBe('number');
    });

    it('respects optional fields', () => {
      const result = generateData(
        {
          type: 'object',
          properties: {
            required: { type: 'string', length: 3 },
            optional: { type: 'string', length: 3, optional: true },
          },
        },
        { seed: 99 },
      );
      expect(result).toHaveProperty('required');
      // optional may or may not be present
    });
  });

  describe('generateData - enum', () => {
    it('picks from values', () => {
      const values = ['a', 'b', 'c'];
      const result = generateData({ type: 'enum', values }, { seed: 5 });
      expect(values).toContain(result);
    });

    it('returns undefined for empty values', () => {
      const result = generateData({ type: 'enum', values: [] }, { seed: 1 });
      expect(result).toBeUndefined();
    });
  });

  describe('generateData - timestamp', () => {
    it('generates ISO timestamp', () => {
      const result = generateData({ type: 'timestamp', format: 'iso' }, { seed: 1 });
      expect(typeof result).toBe('string');
      expect(() => new Date(result as string)).not.toThrow();
    });

    it('generates unix timestamp', () => {
      const result = generateData({ type: 'timestamp', format: 'unix' }, { seed: 1 });
      expect(typeof result).toBe('number');
    });
  });

  describe('generateData - uuid', () => {
    it('generates a valid UUID', () => {
      const result = generateData({ type: 'uuid' });
      expect(typeof result).toBe('string');
      expect((result as string)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe('generateData - email', () => {
    it('generates a valid email', () => {
      const result = generateData({ type: 'email' }, { seed: 42 });
      expect(typeof result).toBe('string');
      expect((result as string)).toMatch(/^[^\s@]+@[^\s@]+$/);
    });
  });

  describe('generateData - phone', () => {
    it('generates a phone number', () => {
      const result = generateData({ type: 'phone' }, { seed: 7 });
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });
  });

  describe('generateData - special', () => {
    it('generates empty string', () => {
      const result = generateData({ type: 'special', boundaryType: 'empty_string' as any });
      expect(result).toBe('');
    });

    it('generates null', () => {
      const result = generateData({ type: 'special', boundaryType: 'null' as any });
      expect(result).toBeNull();
    });

    it('generates unicode', () => {
      const result = generateData({ type: 'special', boundaryType: 'unicode' as any });
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('generates emoji', () => {
      const result = generateData({ type: 'special', boundaryType: 'emoji' as any });
      expect(typeof result).toBe('string');
      expect((result as string)).toContain('🚀');
    });
  });

  describe('seed reproducibility', () => {
    it('same seed produces same output', () => {
      const template: DataTemplate = { type: 'string', length: 20, charset: 'alnum' };
      const a = generateData(template, { seed: 12345 });
      const b = generateData(template, { seed: 12345 });
      expect(a).toEqual(b);
    });

    it('different seeds produce different output', () => {
      const template: DataTemplate = { type: 'string', length: 20, charset: 'alnum' };
      const a = generateData(template, { seed: 1 });
      const b = generateData(template, { seed: 2 });
      expect(a).not.toEqual(b);
    });

    it('number reproducibility with same seed', () => {
      const template: DataTemplate = { type: 'number', min: 0, max: 1000 };
      const a = generateData(template, { seed: 999 });
      const b = generateData(template, { seed: 999 });
      expect(a).toEqual(b);
    });

    it('array reproducibility with same seed', () => {
      const template: DataTemplate = {
        type: 'array',
        items: { type: 'number', min: 0, max: 100 },
        count: 5,
      };
      const a = generateData(template, { seed: 77 });
      const b = generateData(template, { seed: 77 });
      expect(a).toEqual(b);
    });

    it('object reproducibility with same seed', () => {
      const template: DataTemplate = {
        type: 'object',
        properties: {
          x: { type: 'number', min: 0, max: 100 },
          y: { type: 'string', length: 5 },
        },
      };
      const a = generateData(template, { seed: 33 });
      const b = generateData(template, { seed: 33 });
      expect(a).toEqual(b);
    });
  });

  describe('generateBoundaryValues', () => {
    it('generates min boundary for number', () => {
      const result = generateBoundaryValues(100, 'min' as BoundaryMode);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toContain(0);
      expect(result).toContain(1);
      expect(result).toContain(-1);
    });

    it('generates max boundary for number', () => {
      const result = generateBoundaryValues(100, 'max' as BoundaryMode);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toContain(100);
      expect(result).toContain(101);
      expect(result).toContain(Infinity);
    });

    it('generates zero boundary for number', () => {
      const result = generateBoundaryValues(50, 'zero' as BoundaryMode);
      expect(result).toContain(0);
      expect(result).toContain(-0);
    });

    it('generates negative boundary for number', () => {
      const result = generateBoundaryValues(50, 'negative' as BoundaryMode);
      expect(result).toContain(-1);
      expect(result).toContain(-50);
      expect(result.some((v) => Number.isNaN(v as number))).toBe(true);
    });

    it('generates overflow boundary for number', () => {
      const result = generateBoundaryValues(50, 'overflow' as BoundaryMode);
      expect(result).toContain(Number.MAX_SAFE_INTEGER);
      expect(result).toContain(Infinity);
      expect(result).toContain(-Infinity);
    });

    it('generates min boundary for string', () => {
      const result = generateBoundaryValues('hello', 'min' as BoundaryMode);
      expect(result).toContain('');
      expect(result).toContain('h');
      expect(result).toContain('hello');
    });

    it('generates max boundary for string', () => {
      const result = generateBoundaryValues('hi', 'max' as BoundaryMode);
      expect(result).toContain('hi');
      expect(result).toContain('hihi');
    });

    it('returns default for unknown type', () => {
      const result = generateBoundaryValues(true, 'min' as BoundaryMode);
      expect(result).toContain(null);
      expect(result).toContain(undefined);
    });
  });

  describe('resolvePlaceholders', () => {
    it('resolves {{gen.email}} in string', () => {
      const result = resolvePlaceholders('Contact: {{gen.email}}', { seed: 42 });
      expect(typeof result).toBe('string');
      expect((result as string)).toMatch(/Contact: .+@.+/);
    });

    it('resolves {{gen.uuid}} as full placeholder (returns UUID type)', () => {
      const result = resolvePlaceholders('{{gen.uuid}}', { seed: 1 });
      expect(typeof result).toBe('string');
      expect((result as string)).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('resolves {{gen.boolean}} as full placeholder (returns boolean)', () => {
      const result = resolvePlaceholders('{{gen.boolean}}', { seed: 5 });
      expect(typeof result).toBe('boolean');
    });

    it('resolves {{gen.string.length.10}}', () => {
      const result = resolvePlaceholders('{{gen.string.length.10}}', { seed: 3 });
      expect(typeof result).toBe('string');
      expect((result as string).length).toBe(10);
    });

    it('resolves {{gen.number.range.1.100}}', () => {
      const result = resolvePlaceholders('{{gen.number.range.1.100}}', { seed: 7 });
      expect(typeof result).toBe('number');
      expect(result as number).toBeGreaterThanOrEqual(1);
      expect(result as number).toBeLessThanOrEqual(100);
    });

    it('resolves {{gen.phone}}', () => {
      const result = resolvePlaceholders('{{gen.phone}}', { seed: 10 });
      expect(typeof result).toBe('string');
      expect((result as string).length).toBeGreaterThan(0);
    });

    it('resolves placeholders in nested objects', () => {
      const data = {
        user: '{{gen.email}}',
        id: '{{gen.uuid}}',
        nested: { value: '{{gen.number.range.0.50}}' },
      };
      const result = resolvePlaceholders(data, { seed: 42 }) as any;
      expect(result.user).toMatch(/.+@.+/);
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.nested.value).toBeGreaterThanOrEqual(0);
      expect(result.nested.value).toBeLessThanOrEqual(50);
    });

    it('resolves {{gen.enum.a.b.c}}', () => {
      const result = resolvePlaceholders('{{gen.enum.red.green.blue}}', { seed: 3 });
      expect(['red', 'green', 'blue']).toContain(result);
    });

    it('returns non-placeholder strings unchanged', () => {
      const result = resolvePlaceholders('hello world', { seed: 1 });
      expect(result).toBe('hello world');
    });

    it('handles arrays with placeholders', () => {
      const data = ['{{gen.uuid}}', '{{gen.uuid}}', 'static'];
      const result = resolvePlaceholders(data, { seed: 1 }) as unknown[];
      expect(result.length).toBe(3);
      expect(result[2]).toBe('static');
    });
  });

  describe('generateBatch', () => {
    it('generates multiple items', () => {
      const results = generateBatch({ type: 'number', min: 0, max: 100 }, 5, { seed: 42 });
      expect(Array.isArray(results)).toBe(true);
      expect(results.length).toBe(5);
    });

    it('with same seed produces same batch', () => {
      const a = generateBatch({ type: 'string', length: 10 }, 3, { seed: 100 });
      const b = generateBatch({ type: 'string', length: 10 }, 3, { seed: 100 });
      expect(a).toEqual(b);
    });
  });
});
