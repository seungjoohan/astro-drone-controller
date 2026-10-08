import { describe, expect, it } from 'vitest';
import { DEFAULT_ENVIRONMENT, insideEnvironment } from './patrol-environment';
import { RL_ACTION_COUNT, RL_GRID_SIZE, RL_HOVER_ACTION, RL_MAX_DRONES, RL_OBSERVATION_SIZE, RL_RETURN_ACTION, RL_STANDBY_ACTION } from './patrol-rl-contract';
import { RLPatrolEnvironment, actionDestination, actionMasks, observationFromSnapshot, patrolReward, selectValidatedRLFleet } from './patrol-rl-environment';
import { createRLScenarios, populationForScenario } from './patrol-rl-scenarios';
import type { RLEpisodeResult } from './patrol-rl-environment';
import type { RLScenario } from './patrol-rl-scenarios';
import type { RLRewardProfile } from './patrol-rl-reward';

function scenario(overrides: Partial<RLScenario> = {}): RLScenario {
  const generated = createRLScenarios('validation', 42, 1)[0];
  return { ...generated, environment: { ...DEFAULT_ENVIRONMENT, depot: { x: 0, z: 0 } },
    warmupSeconds: 0, durationSeconds: 5, ...overrides };
}

function hover(): number[] { return Array<number>(RL_MAX_DRONES).fill(RL_HOVER_ACTION); }

function complete(fleetSize = 2): RLEpisodeResult {
  const environment = new RLPatrolEnvironment(scenario(), fleetSize);
  environment.step(hover());
  return environment.result();
}

function passing(fleetSize = 2): RLEpisodeResult {
  const result = complete(fleetSize);
  return { ...result, qualifyingProtocol: true, metrics: { ...result.metrics,
    geographicFeasible: true, hotspotFeasible: true, neverObservedPeople: 0, energyViolations: 0, reserveViolations: 0 } };
}

describe('headless neural patrol environment', () => {
  it('emits finite centralized observations and masks unused slots', () => {
    const environment = new RLPatrolEnvironment(scenario(), 3);
    const { observation, masks } = environment.observation();
    expect(observation).toHaveLength(RL_OBSERVATION_SIZE);
    expect(observation.every(Number.isFinite)).toBe(true);
    expect(masks).toHaveLength(RL_MAX_DRONES);
    expect(masks.every(mask => mask.length === RL_ACTION_COUNT && mask.some(Boolean))).toBe(true);
    expect(masks.slice(3).every(mask => mask.filter(Boolean).length === 1 && mask[RL_HOVER_ACTION])).toBe(true);
  });

  it('removes ownership and baseline routes without changing staging', () => {
    const neural = new RLPatrolEnvironment(scenario(), 8);
    const uniform = new RLPatrolEnvironment(scenario(), 8, { controller: 'uniform' });
    const adaptive = new RLPatrolEnvironment(scenario(), 8, { controller: 'adaptive' });
    expect(neural.snapshot().drones.map(drone => drone.position)).toEqual(uniform.snapshot().drones.map(drone => drone.position));
    expect(neural.snapshot().drones.map(drone => drone.position)).toEqual(adaptive.snapshot().drones.map(drone => drone.position));
    expect(neural.snapshot().cells.every(cell => cell.assignedDroneId === null)).toBe(true);
    expect(neural.snapshot().drones.every(drone => drone.route.length === 1 && drone.assignedCellIds.length === 0)).toBe(true);
    expect(uniform.snapshot().cells.some(cell => cell.assignedDroneId !== null)).toBe(true);
  });

  it('allows all physically valid directions regardless of region or density', () => {
    const environment = new RLPatrolEnvironment(scenario(), 2);
    const snapshot = environment.snapshot();
    snapshot.drones[0].position = { x: 0, y: 260, z: 0 };
    const masks = actionMasks(snapshot, [1, 2]);
    expect(masks[0].slice(0, 24).every(Boolean)).toBe(true);
    snapshot.cells.forEach(cell => { cell.population = 0; cell.assignedDroneId = 2; });
    expect(actionMasks(snapshot, [1, 2])).toEqual(masks);
  });

  it('masks geofence and battery violations, not useful cross-region moves', () => {
    const environment = new RLPatrolEnvironment(scenario(), 1);
    const snapshot = environment.snapshot();
    snapshot.drones[0].position = { x: 319, y: 260, z: 0 };
    const masks = actionMasks(snapshot, [1]);
    expect(masks[0][0]).toBe(false);
    for (let action = 0; action < 24; action += 1) {
      if (masks[0][action]) expect(insideEnvironment(actionDestination(snapshot, snapshot.drones[0], action), snapshot.environment)).toBe(true);
    }
    snapshot.environment.batteryEnabled = true;
    snapshot.drones[0].batteryFraction = 0.21;
    const energyMasks = actionMasks(snapshot, [1]);
    expect(energyMasks[0][RL_HOVER_ACTION]).toBe(false);
    expect(energyMasks[0][RL_RETURN_ACTION]).toBe(true);
  });

  it('does not expose pending fault injection flags as privileged observations', () => {
    const snapshot = new RLPatrolEnvironment(scenario(), 1).snapshot();
    const raster = Array<number>(RL_GRID_SIZE ** 2).fill(0);
    const observed = observationFromSnapshot(snapshot, [1], raster);
    const masks = actionMasks(snapshot, [1]);
    snapshot.drones[0].fault = 'malfunction';
    snapshot.drones[0].status = 'unresponsive';
    snapshot.events.push({ id: 99, time: 0, message: 'Injected fault' });
    expect(observationFromSnapshot(snapshot, [1], raster)).toEqual(observed);
    expect(actionMasks(snapshot, [1])).toEqual(masks);
    snapshot.drones[0].status = 'offline';
    expect(observationFromSnapshot(snapshot, [1], raster)).not.toEqual(observed);
    expect(actionMasks(snapshot, [1])[0].filter(Boolean)).toHaveLength(1);
  });

  it('rejects invalid and sparse actions before advancing or counting commands', () => {
    const environment = new RLPatrolEnvironment(scenario(), 2);
    const actions = new Array<number>(8);
    actions[0] = RL_RETURN_ACTION;
    expect(() => environment.step(actions)).toThrow('Invalid or masked RL action');
    expect(() => environment.step(Array(8).fill(NaN))).toThrow();
    expect(environment.snapshot().time).toBe(0);
    environment.step(hover());
    expect(environment.result().commandedReturns).toBe(0);
  });

  it('gives baselines and neural controllers the same action-independent population timeline', () => {
    const mission = scenario({ family: 'moving', durationSeconds: 60 });
    const neural = new RLPatrolEnvironment(mission, 2);
    const uniform = new RLPatrolEnvironment(mission, 2, { controller: 'uniform' });
    while (!neural.done) {
      neural.step(hover());
      uniform.step();
      expect(neural.snapshot().cells.map(cell => cell.population)).toEqual(uniform.snapshot().cells.map(cell => cell.population));
    }
    expect(neural.result().personSeconds).toBe(uniform.result().personSeconds);
  });

  it('scores old population through its interval instead of charging newly arrived demand retroactively', () => {
    const mission = scenario({ family: 'surge', durationSeconds: 150 });
    const environment = new RLPatrolEnvironment(mission, 1);
    const positions = environment.snapshot().cells.map(cell => cell.position);
    let expected = 0;
    for (let time = 0; time < 150; time += 5) {
      expected += populationForScenario(mission, positions, time).reduce((total, people) => total + people, 0) * 5;
      environment.step(hover());
    }
    expect(environment.result().personSeconds).toBe(expected);
  });

  it('excludes warmup from metrics and reports time limits as bootstrappable truncations', () => {
    const environment = new RLPatrolEnvironment(scenario({ warmupSeconds: 5 }), 2);
    expect(() => environment.result()).toThrow('Incomplete');
    expect(environment.step(hover())).toMatchObject({ terminated: false, truncated: false });
    expect(environment.step(hover())).toMatchObject({ terminated: false, truncated: true });
    expect(environment.result().metrics.durationSeconds).toBe(5);
    expect(environment.result().inventoryDroneSeconds).toBe(20);
    expect(() => environment.step(hover())).toThrow('completed');
  });

  it('records scheduled-but-unapplied faults instead of claiming a successful stress test', () => {
    const mission = scenario({ durationSeconds: 60, fault: { atSeconds: 55, kind: 'deviation' } });
    const environment = new RLPatrolEnvironment(mission, 1);
    while (!environment.done) {
      const actions = hover();
      const mask = environment.observation().masks[0];
      if (mask[RL_STANDBY_ACTION]) actions[0] = RL_STANDBY_ACTION;
      else if (mask[RL_RETURN_ACTION]) actions[0] = RL_RETURN_ACTION;
      environment.step(actions);
    }
    expect(environment.result()).toMatchObject({ fault: true, faultApplied: false });
  });

  it('allows failures and confirmation without restoring baseline ownership', () => {
    const environment = new RLPatrolEnvironment(scenario({ durationSeconds: 15, fault: { atSeconds: 2, kind: 'malfunction' } }), 2);
    while (!environment.done) environment.step(hover());
    expect(environment.result().faultApplied).toBe(true);
    expect(environment.snapshot().drones[0].status).toBe('offline');
    expect(environment.snapshot().cells.every(cell => cell.assignedDroneId === null)).toBe(true);
  });

  it('penalizes shorter sub-deadline gaps less and retains a fleet cost while charging', () => {
    const environment = new RLPatrolEnvironment(scenario(), 2);
    const previous = environment.snapshot();
    const snapshot = environment.snapshot();
    snapshot.time = 5;
    snapshot.cells.forEach(cell => { cell.lastVisited = 4; });
    const shortGap = patrolReward(snapshot, 100, previous);
    snapshot.cells.forEach(cell => { cell.lastVisited = 0; });
    const longGap = patrolReward(snapshot, 100, previous);
    expect(shortGap).toBeGreaterThan(longGap);
    snapshot.drones.forEach(drone => { drone.serviceState = 'charging'; });
    expect(patrolReward(snapshot, 100, previous)).toBe(longGap);
    snapshot.drones.push({ ...snapshot.drones[0], id: 3 });
    expect(patrolReward(snapshot, 100, previous)).toBeCloseTo(longGap - 0.02, 10);
  });

  it('preserves empty-population N/A metrics rather than reporting perfect service', () => {
    const mission = scenario();
    mission.config.populationCount = 0;
    const environment = new RLPatrolEnvironment(mission, 1);
    environment.step(hover());
    expect(environment.result()).toMatchObject({ personSeconds: 0, unobservedFraction: null, hotspotWorstAgeSeconds: null });
    expect(environment.result().metrics.populationOnTime).toBeNull();
  });

  it('defaults to coverage priority and rejects unknown reward profiles', () => {
    expect(new RLPatrolEnvironment(scenario(), 2).rewardProfile).toBe('coverage-v2');
    expect(() => new RLPatrolEnvironment(scenario(), 2, { rewardProfile: 'unknown' as RLRewardProfile })).toThrow(/reward profile/);
  });

  it('changes rewards without changing physical trajectories, masks, faults or service metrics', () => {
    const mission = createRLScenarios('validation', 42, 3)[2];
    const settings = { warmupSeconds: 20, durationSeconds: 600, slotSeed: 73 };
    const legacy = new RLPatrolEnvironment(mission, 8, { ...settings, rewardProfile: 'legacy-v1' });
    const coverage = new RLPatrolEnvironment(mission, 8, { ...settings, rewardProfile: 'coverage-v2' });
    let legacyReward = 0;
    let coverageReward = 0;
    while (!legacy.done) {
      expect(coverage.snapshot()).toEqual(legacy.snapshot());
      expect(coverage.observation()).toEqual(legacy.observation());
      const actions = legacy.observation().masks.map(mask => mask.findIndex(Boolean));
      legacyReward += legacy.step(actions).reward;
      coverageReward += coverage.step(actions).reward;
    }
    expect(coverage.snapshot()).toEqual(legacy.snapshot());
    const before = legacy.result();
    const after = coverage.result();
    const serviceOnly = ({ reward: _reward, rewardProfile: _profile, rewardComponents: _components, ...rest }: RLEpisodeResult) => rest;
    expect(serviceOnly(after)).toEqual(serviceOnly(before));
    expect(before.rewardProfile).toBe('legacy-v1');
    expect(after.rewardProfile).toBe('coverage-v2');
    expect(before.reward).toBe(legacyReward);
    expect(after.reward).toBe(coverageReward);
    expect(before.reward).not.toBe(after.reward);
    for (const result of [before, after]) {
      expect(Object.values(result.rewardComponents).reduce((total, value) => total + value, 0)).toBeCloseTo(result.reward, 7);
    }
    const changed = coverage.result();
    changed.rewardComponents.fleet = 999;
    expect(coverage.result().rewardComponents.fleet).toBe(after.rewardComponents.fleet);
  });
});

describe('strict learned-fleet qualification', () => {
  it('chooses the smallest fleet only after every healthy validation case passes', () => {
    const two = passing(2);
    const three = passing(3);
    const ids = [two.scenarioId, 'second-case'];
    expect(selectValidatedRLFleet([two, three], ids)).toBeNull();
    const results = [two, { ...two, scenarioId: 'second-case' }, three, { ...three, scenarioId: 'second-case' }];
    expect(selectValidatedRLFleet(results, ids)).toBe(2);
    results[0].metrics = { ...two.metrics, hotspotFeasible: false };
    expect(selectValidatedRLFleet(results, ids)).toBe(3);
  });

  it('never qualifies short, incomplete, duplicate, failed or shield-dependent evidence', () => {
    const valid = passing();
    for (const changes of [{ qualifyingProtocol: false }, { forcedReturns: 1 }, { rejectedCommands: 1 }, { fault: true }, { split: 'train' as const },
      { metrics: { ...valid.metrics, reserveViolations: 1 } }, { metrics: { ...valid.metrics, geographicFeasible: false } }]) {
      expect(selectValidatedRLFleet([{ ...valid, ...changes }], [valid.scenarioId])).toBeNull();
    }
    expect(selectValidatedRLFleet([valid, valid], [valid.scenarioId])).toBeNull();
    expect(selectValidatedRLFleet([valid], [])).toBeNull();
  });
});
