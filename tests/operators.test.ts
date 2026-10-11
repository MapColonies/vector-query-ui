import { describe, expect, it } from 'vitest';
import { isDateType, isNumericType, operatorsFor, spatialOperatorsFor } from '../src/query/operators';

const ids = (ops: { id: string }[]) => ops.map((o) => o.id);

describe('operatorsFor', () => {
  it('offers ordering operators for numeric types', () => {
    expect(ids(operatorsFor({ name: 'height', type: 'xsd:double' } as never))).toEqual(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
  });

  it('offers ordering operators for date types', () => {
    expect(ids(operatorsFor({ name: 'date', type: 'xsd:dateTime' } as never))).toContain('gt');
  });

  it('offers like for text', () => {
    expect(ids(operatorsFor({ name: 'name', type: 'xsd:string' } as never))).toEqual(['eq', 'neq', 'like']);
  });

  it('restricts to equality when values are enumerated', () => {
    const p = { name: 'kind', type: 'xsd:string', possibleValues: ['a', 'b'] };

    expect(ids(operatorsFor(p as never))).toEqual(['eq', 'neq']);
  });
});

describe('type detection', () => {
  it('recognises numeric xsd types', () => {
    expect(isNumericType('xsd:long')).toBe(true);
    expect(isNumericType('xsd:string')).toBe(false);
  });

  it('recognises date xsd types', () => {
    expect(isDateType('xsd:date')).toBe(true);
    expect(isDateType('xsd:int')).toBe(false);
  });
});

describe('spatialOperatorsFor', () => {
  it('returns a non-empty set for both shapes', () => {
    expect(spatialOperatorsFor('bbox').length).toBeGreaterThan(0);
    expect(spatialOperatorsFor('geometry').length).toBeGreaterThan(0);
  });
});
