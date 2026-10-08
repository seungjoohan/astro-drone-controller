import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENT } from './patrol-environment';
import { RL_HOVER_ACTION, RL_MAX_DRONES, RL_RETURN_ACTION } from './patrol-rl-contract';
import { RLPatrolEnvironment } from './patrol-rl-environment';
import { PatrolPreviewSession, createNYCPreviewScenario } from './patrol-rl-playback';
import type { PatrolPreviewPolicy } from './patrol-rl-playback';
import type { RLScenario } from './patrol-rl-scenarios';

function scenario(overrides: Partial<RLScenario> = {}): RLScenario {
  return { ...createNYCPreviewScenario(),
    environment: { ...DEFAULT_ENVIRONMENT, width: 240, depth: 240, batteryEnabled: true, enduranceSeconds: 120, rechargeSeconds: 30, depot: { x: 0, z: 0 } },
    warmupSeconds: 0, durationSeconds: 150,
    fault: { atSeconds: 17, kind: 'malfunction' },
    ...overrides,
  };
}

function scriptedPolicy(): PatrolPreviewPolicy {
  let decision = 0;
  return { act: (_observation, masks) => {
    const actions = masks.map((mask, slot) => {
      if (decision % 10 === 4 && mask[RL_RETURN_ACTION]) return RL_RETURN_ACTION;
      const preferred = (decision * 3 + slot * 6) % RL_HOVER_ACTION;
      return mask[preferred] ? preferred : mask.findIndex(Boolean);
    });
    decision += 1;
    return actions;
  } };
}

describe('trained patrol live playback', () => {
  it('matches evaluator observations, actions and snapshots through movement, charging and faults', () => {
    const mission = scenario();
    const reference = new RLPatrolEnvironment(mission, 3);
    const expectedPolicy = scriptedPolicy();
    const actualPolicy = scriptedPolicy();
    let expectedObservation = reference.observation();
    let expectedActions: number[] = [];
    const preview = new PatrolPreviewSession(mission, 3, 'neural', { act: (observation, masks) => {
      expect(observation).toEqual(expectedObservation.observation);
      expect(masks).toEqual(expectedObservation.masks);
      const actions = actualPolicy.act(observation, masks);
      expect(actions).toEqual(expectedActions);
      return actions;
    } });
    expect(preview.snapshot()).toEqual(reference.snapshot());
    while (!reference.done) {
      expectedObservation = reference.observation();
      expectedActions = expectedPolicy.act(expectedObservation.observation, expectedObservation.masks);
      reference.step(expectedActions);
      preview.advance(5);
      expect(preview.snapshot()).toEqual(reference.snapshot());
    }
    expect(preview.done).toBe(true);
    expect(preview.decisions).toBe(30);
    expect(preview.snapshot().energy.completedCharges).toBeGreaterThan(0);
    expect(preview.snapshot().drones[0].status).toBe('offline');
    expect(preview.snapshot().cells.every(cell => cell.assignedDroneId === null)).toBe(true);
    expect(preview.auditCoverage).toBeGreaterThanOrEqual(0);
    expect(preview.auditCoverage).toBeLessThanOrEqual(100);
  });

  it.each(['uniform', 'adaptive'] as const)('matches the %s baseline on the identical population and fault timeline', controller => {
    const mission = scenario();
    const reference = new RLPatrolEnvironment(mission, 3, { controller });
    const preview = new PatrolPreviewSession(mission, 3, controller);
    while (!reference.done) {
      reference.step();
      preview.advance(5);
      expect(preview.snapshot()).toEqual(reference.snapshot());
    }
    expect(preview.decisions).toBe(0);
  });

  it('buffers frame deltas, pauses without choosing actions and is independent of frame chunking', () => {
    const mission = scenario();
    const whole = new PatrolPreviewSession(mission, 3, 'neural', scriptedPolicy());
    const frames = new PatrolPreviewSession(mission, 3, 'neural', scriptedPolicy());
    const before = frames.snapshot();
    frames.advance(0);
    frames.advance(0.2);
    expect(frames.snapshot()).toEqual(before);
    expect(frames.decisions).toBe(0);
    frames.advance(0.3);
    expect(frames.snapshot().time).toBe(0.5);
    expect(frames.decisions).toBe(1);
    const paused = frames.snapshot();
    frames.advance(0);
    expect(frames.snapshot()).toEqual(paused);
    whole.advance(150);
    for (let frame = 0; frame < 1495; frame += 1) frames.advance(0.1);
    expect(frames.snapshot()).toEqual(whole.snapshot());
    expect(frames.auditCoverage).toBe(whole.auditCoverage);
    expect(frames.decisions).toBe(whole.decisions);
  });

  it('matches non-grid fault and warmup boundaries and stops exactly at the episode end', () => {
    const mission = scenario({ warmupSeconds: 1.3, durationSeconds: 9.9, fault: { atSeconds: 3.2, kind: 'deviation', droneId: 7 } });
    const reference = new RLPatrolEnvironment(mission, 2);
    const policy = scriptedPolicy();
    const preview = new PatrolPreviewSession(mission, 2, 'neural', scriptedPolicy());
    while (!reference.done) {
      const input = reference.observation();
      reference.step(policy.act(input.observation, input.masks));
      preview.advance(5);
      expect(preview.snapshot()).toEqual(reference.snapshot());
    }
    expect(preview.snapshot().time).toBeCloseTo(11.2, 10);
    const completed = preview.snapshot();
    preview.advance(1000);
    expect(preview.snapshot()).toEqual(completed);
    expect(preview.decisions).toBe(3);
  });

  it('does not reveal a scheduled fault to the policy before injection', () => {
    const faulty = new PatrolPreviewSession(scenario(), 3, 'neural', scriptedPolicy());
    const healthy = new PatrolPreviewSession(scenario({ fault: undefined }), 3, 'neural', scriptedPolicy());
    faulty.advance(17);
    healthy.advance(17);
    expect(faulty.snapshot()).toEqual(healthy.snapshot());
    faulty.advance(0.5);
    healthy.advance(0.5);
    expect(faulty.snapshot().drones[0].fault).toBe('malfunction');
    expect(healthy.snapshot().drones[0].fault).toBeNull();
  });

  it('copies scenario state and snapshots so display code cannot mutate the episode', () => {
    const mission = scenario();
    const preview = new PatrolPreviewSession(mission, 3, 'uniform');
    const expected = new PatrolPreviewSession(scenario(), 3, 'uniform');
    mission.seed = 1;
    mission.config.populationCount = 0;
    mission.environment.depot.x = 50;
    const displayed = preview.snapshot();
    displayed.drones[0].position.x = 999;
    displayed.cells[0].population = 0;
    preview.advance(30);
    expected.advance(30);
    expect(preview.snapshot()).toEqual(expected.snapshot());
  });

  it('rejects invalid configuration, timing and policy actions before advancing physics', () => {
    expect(() => new PatrolPreviewSession(scenario(), 0, 'uniform')).toThrow('fleet size');
    expect(() => new PatrolPreviewSession(scenario(), 9, 'uniform')).toThrow('fleet size');
    expect(() => new PatrolPreviewSession(scenario(), 3, 'neural')).toThrow('policy');
    expect(() => new PatrolPreviewSession(scenario(), 3, 'uniform', scriptedPolicy())).toThrow('policy');
    expect(() => new PatrolPreviewSession(scenario({ seed: 0 }), 3, 'uniform')).toThrow('scenario');
    expect(() => new PatrolPreviewSession(scenario({ durationSeconds: Infinity }), 3, 'uniform')).toThrow('scenario');
    expect(() => new PatrolPreviewSession(scenario({ fault: { atSeconds: -1, kind: 'deviation' } }), 3, 'uniform')).toThrow('fault');
    const preview = new PatrolPreviewSession(scenario(), 3, 'neural', { act: () => new Array<number>(RL_MAX_DRONES) });
    for (const value of [-1, NaN, Infinity]) expect(() => preview.advance(value)).toThrow('elapsed time');
    expect(() => preview.advance(0.5)).toThrow('Invalid or masked');
    expect(preview.snapshot().time).toBe(0);
    expect(preview.decisions).toBe(0);
  });

  it('keeps the NYC preview separate from benchmark evidence', () => {
    const mission = createNYCPreviewScenario();
    expect(mission).toMatchObject({ id: 'preview-nyc', split: 'validation', family: 'moving', seed: 42,
      environment: { width: 640, depth: 640, shape: 'circle', batteryEnabled: true },
      config: { populationCount: 5000, crowdedRevisitSeconds: 15, crowdedCellPopulation: 80, coverageTarget: 95, revisitSeconds: 120 } });
  });
});
