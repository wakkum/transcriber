import { describe, expect, it } from 'vitest';
import { isNewer } from './update';

describe('isNewer', () => {
  it('compares versions by number, not as text', () => {
    expect(isNewer('v0.1.2', '0.1.1')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('v0.1.1', '0.1.1')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
  });
  it('treats anything unreadable as not newer', () => {
    expect(isNewer('latest', '0.1.1')).toBe(false);
    expect(isNewer('2.0', '0.1.1')).toBe(false);
    expect(isNewer('9.9.9<script>', '0.1.1')).toBe(false);
    expect(isNewer('1.0.0', '')).toBe(false);
  });
});
