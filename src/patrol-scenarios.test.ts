import { describe, expect, it } from 'vitest';
import { PATROL_DEFAULTS } from './patrol';
import { DEFAULT_ENVIRONMENT, validateEnvironment } from './patrol-environment';
import { createScenarios, PILOT_PROTOCOL } from './patrol-scenarios';

describe('bounded generalization scenarios', () => {
  it('preserves the classic pilot unless a new profile or environment is selected', () => {
    expect(createScenarios(PATROL_DEFAULTS, 'training')).toEqual(createScenarios(PATROL_DEFAULTS, 'training', { profile: 'current' }));
    expect(createScenarios(PATROL_DEFAULTS, 'training')[0]).toEqual({
      populationSeed: 104771, warmupSeconds: PILOT_PROTOCOL.warmupSeconds, evaluationSeconds: PILOT_PROTOCOL.trainingSeconds,
    });
  });

  it('holds out corridor geometry and reserves disjoint final-test seeds', () => {
    const options = { profile: 'diverse' as const };
    const training = createScenarios(PATROL_DEFAULTS, 'training', options);
    const validation = createScenarios(PATROL_DEFAULTS, 'validation', options);
    const failure = createScenarios(PATROL_DEFAULTS, 'failure', options);
    const final = createScenarios(PATROL_DEFAULTS, 'final', options);
    expect(new Set(training.map(scenario => scenario.family))).toEqual(new Set(['compact-circle', 'district']));
    expect(validation.every(scenario => scenario.family === 'corridor')).toBe(true);
    const seeds = [...training, ...validation, ...failure, ...final].map(scenario => scenario.populationSeed);
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(createScenarios(PATROL_DEFAULTS, 'training', options)).toEqual(training);
    expect(createScenarios(PATROL_DEFAULTS, 'validation', options)).toEqual(validation);
  });

  it('widens a deterministic paired suite without changing earlier cases or leaking seeds between splits', () => {
    const config = { ...PATROL_DEFAULTS, populationSeed: 2147483647 };
    const small = createScenarios(config, 'training', { profile: 'diverse', scenarioCount: 3 });
    const defaults = createScenarios(config, 'training', { profile: 'diverse' });
    const large = createScenarios(config, 'training', { profile: 'diverse', scenarioCount: 12 });
    expect(small).toHaveLength(3);
    expect(defaults).toHaveLength(6);
    expect(large).toHaveLength(12);
    expect(large.slice(0, 3)).toEqual(small);
    expect(large.slice(0, 6)).toEqual(defaults);
    expect(large.filter(scenario => scenario.family === 'district')).toHaveLength(4);
    const validation = createScenarios(config, 'validation', { profile: 'diverse', scenarioCount: 12 });
    expect(validation).toHaveLength(6);
    const all = [...large, ...validation, ...createScenarios(config, 'failure', { profile: 'diverse', scenarioCount: 12 }), ...createScenarios(config, 'final', { profile: 'diverse', scenarioCount: 12 })];
    expect(new Set(all.map(scenario => scenario.populationSeed)).size).toBe(all.length);
    expect(all.every(scenario => scenario.populationSeed >= 1 && scenario.populationSeed <= 2147483647)).toBe(true);
    expect(createScenarios(config, 'training', { profile: 'current', scenarioCount: 12 })).toEqual(createScenarios(config, 'training'));
    expect(() => createScenarios(config, 'training', { profile: 'diverse', scenarioCount: 2 })).toThrow();
  });

  it('uses valid physical conditions and observes at least three nominal battery/recharge cycles', () => {
    for (const kind of ['training', 'validation', 'failure', 'final'] as const) {
      for (const scenario of createScenarios(PATROL_DEFAULTS, kind, { profile: 'diverse' })) {
        const environment = scenario.environment!;
        expect(validateEnvironment(environment)).toEqual(environment);
        expect(environment.batteryEnabled).toBe(true);
        expect(scenario.evaluationSeconds).toBeGreaterThanOrEqual(3 * (environment.enduranceSeconds + environment.rechargeSeconds));
        expect(scenario.populationCount).toBeGreaterThan(0);
        expect(scenario.populationCount).toBeLessThanOrEqual(50000);
      }
    }
    const current = createScenarios(PATROL_DEFAULTS, 'training', { environment: { ...DEFAULT_ENVIRONMENT, batteryEnabled: true } });
    expect(current[0].evaluationSeconds).toBe(1260);
  });

  it('pairs physical cases across fleet sizes and preserves fixed service requirements', () => {
    const config = { ...PATROL_DEFAULTS, coverageTarget: 97, crowdedRevisitSeconds: 11 };
    const small = createScenarios({ ...config, fleetSize: 1 }, 'training', { profile: 'diverse' });
    const large = createScenarios({ ...config, fleetSize: 8 }, 'training', { profile: 'diverse' });
    expect(small).toEqual(large);
    expect(config).toEqual({ ...PATROL_DEFAULTS, coverageTarget: 97, crowdedRevisitSeconds: 11 });
    expect(createScenarios({ ...config, populationCount: 0 }, 'validation', { profile: 'diverse' }).every(scenario => scenario.populationCount === 0)).toBe(true);
    const faults = createScenarios({ ...config, fleetSize: 1 }, 'failure', { profile: 'diverse' });
    expect(faults[0].fault).toMatchObject({ droneId: 1, kind: 'malfunction' });
  });
});
