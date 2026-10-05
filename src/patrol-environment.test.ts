import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENT, ENVIRONMENT_PRESETS, energyRate, environmentKey, insideEnvironment, validateEnvironment } from './patrol-environment';

describe('patrol environment contracts', () => {
  it('validates and detaches every preset without changing classic assumptions', () => {
    for (const preset of Object.values(ENVIRONMENT_PRESETS)) {
      const parsed = validateEnvironment(preset)!;
      expect(parsed).toEqual(preset);
      expect(parsed.depot).not.toBe(preset.depot);
    }
    expect(DEFAULT_ENVIRONMENT.batteryEnabled).toBe(false);
    expect(DEFAULT_ENVIRONMENT.maxSpeed).toBe(18);
    expect(DEFAULT_ENVIRONMENT.width).toBe(640);
  });

  it('rejects invalid hardware, geometry, and unreachable depot coordinates', () => {
    for (const invalid of [null, {}, { ...DEFAULT_ENVIRONMENT, maxSpeed: NaN }, { ...DEFAULT_ENVIRONMENT, enduranceSeconds: 0 },
      { ...DEFAULT_ENVIRONMENT, depth: 500 }, { ...DEFAULT_ENVIRONMENT, chargingPads: 1.5 },
      { ...DEFAULT_ENVIRONMENT, reserveFraction: 0 }, { ...DEFAULT_ENVIRONMENT, depot: { x: 320, z: 320 } }]) {
      expect(validateEnvironment(invalid)).toBeNull();
    }
  });

  it('checks circle and rectangular boundaries independently', () => {
    expect(insideEnvironment({ x: 300, z: 100 }, DEFAULT_ENVIRONMENT)).toBe(true);
    expect(insideEnvironment({ x: 300, z: 200 }, DEFAULT_ENVIRONMENT)).toBe(false);
    expect(insideEnvironment({ x: 290, z: 70 }, ENVIRONMENT_PRESETS.corridor)).toBe(true);
    expect(insideEnvironment({ x: 0, z: 90 }, ENVIRONMENT_PRESETS.corridor)).toBe(false);
  });

  it('uses fixed synthetic consumption and fingerprints physical settings rather than labels', () => {
    expect(energyRate(18, DEFAULT_ENVIRONMENT) * DEFAULT_ENVIRONMENT.enduranceSeconds).toBeCloseTo(1);
    expect(energyRate(0, DEFAULT_ENVIRONMENT)).toBeGreaterThan(0);
    expect(energyRate(9, DEFAULT_ENVIRONMENT)).toBeLessThan(energyRate(18, DEFAULT_ENVIRONMENT));
    expect(environmentKey(DEFAULT_ENVIRONMENT)).toBe(environmentKey({ ...DEFAULT_ENVIRONMENT, id: 'renamed' }));
    expect(environmentKey(DEFAULT_ENVIRONMENT)).not.toBe(environmentKey({ ...DEFAULT_ENVIRONMENT, maxSpeed: 20 }));
  });
});
