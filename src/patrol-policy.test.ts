import { describe, expect, it } from 'vitest';
import { PatrolSystem, PATROL_LIMITS } from './patrol';
import { DEFAULT_POLICY_PARAMETERS, POLICY_PARAMETER_LIMITS, PopulationPolicy, validateStrategy } from './patrol-policy';
import type { PatrolStrategy, PolicyParameters } from './patrol-learning-types';
import { DEFAULT_ENVIRONMENT } from './patrol-environment';

function adaptive(): PatrolStrategy {
  return { kind: 'adaptive', parameters: { ...DEFAULT_POLICY_PARAMETERS } };
}

describe('patrol strategy validation', () => {
  it('accepts bounded strategies and returns independent values', () => {
    const source = adaptive();
    const validated = validateStrategy(source);
    expect(validated).toEqual(source);
    expect(validated).not.toBe(source);
    if (source.kind === 'adaptive' && validated?.kind === 'adaptive') {
      source.parameters.populationWeight = 0;
      expect(validated.parameters.populationWeight).toBe(DEFAULT_POLICY_PARAMETERS.populationWeight);
    }
    expect(validateStrategy({ kind: 'uniform' })).toEqual({ kind: 'uniform' });
  });

  it('rejects missing, extra, nonnumeric and out-of-range settings', () => {
    for (const invalid of [null, [], {}, { kind: 'other' }, { kind: 'uniform', parameters: {} }, { kind: 'adaptive', parameters: {} }]) expect(validateStrategy(invalid)).toBeNull();
    for (const [key, [minimum, maximum]] of Object.entries(POLICY_PARAMETER_LIMITS)) {
      for (const invalid of [NaN, Infinity, -Infinity, '2', null, minimum - 0.001, maximum + 0.001]) {
        expect(validateStrategy({ kind: 'adaptive', parameters: { ...DEFAULT_POLICY_PARAMETERS, [key]: invalid } })).toBeNull();
      }
    }
    expect(validateStrategy({ kind: 'adaptive', parameters: { ...DEFAULT_POLICY_PARAMETERS, futureFault: 1 } })).toBeNull();
  });
});

describe('population-aware patrol policy', () => {
  it('targets geographic holes even when the population grid reports every point fresh', () => {
    const environment = { ...DEFAULT_ENVIRONMENT, shape: 'rectangle' as const, width: 120, depth: 120 };
    const positions = [{ x: -40, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 }];
    const cells = positions.map((position, id) => ({ id, position, population: 0, targetRevisitSeconds: 120, lastVisited: 120 }));
    const policy = new PopulationPolicy(positions, 60, 32, 40, environment);
    policy.observeSegment({ x: -30, y: 260, z: -60 }, { x: -30, y: 260, z: 60 }, 119, 1);
    const commands = policy.choose(cells, [{ id: 1, position: { x: -30, y: 260, z: 0 }, destination: null, committed: false }], 120, 120, 18, DEFAULT_POLICY_PARAMETERS);
    expect(commands.get(1)!.x).toBeGreaterThan(0);
    expect(cells.every(cell => cell.lastVisited === 120)).toBe(true);
  });
  it('uses camera footprints between samples rather than just sample centers', () => {
    const positions = [{ x: -20, y: 0, z: -20 }, { x: 20, y: 0, z: -20 }, { x: -20, y: 0, z: 20 }, { x: 20, y: 0, z: 20 }];
    const cells = positions.map((position, id) => ({ id, position, population: 100, targetRevisitSeconds: 15, lastVisited: null }));
    const policy = new PopulationPolicy(positions, 320, 32, 40);
    const commands = policy.choose(cells, [{ id: 1, position: { x: 0, y: 260, z: -40 }, destination: null, committed: false }], 0, 120, 18, { ...DEFAULT_POLICY_PARAMETERS, coverageWeight: 0.01, populationWeight: 20, travelPenalty: 0 });
    expect(commands.get(1)).toEqual({ x: 0, y: 260, z: 0 });
    expect(cells.every(cell => cell.lastVisited === null)).toBe(true);
  });

  it('starts from exactly the same staging positions as the uniform baseline', () => {
    for (const fleetSize of [1, 4, 8]) {
      const baseline = new PatrolSystem({ fleetSize }).snapshot();
      const candidate = new PatrolSystem({ fleetSize }, adaptive()).snapshot();
      expect(candidate.drones.map(drone => drone.position)).toEqual(baseline.drones.map(drone => drone.position));
      expect(candidate.cells.map(cell => cell.lastVisited)).toEqual(baseline.cells.map(cell => cell.lastVisited));
      expect(candidate.estimatedCoverage).toBeNull();
      expect(candidate.predictedRevisitSeconds).toBeNull();
    }
  });

  it('keeps strategy snapshots detached and retains the applied policy on reset', () => {
    const source = adaptive();
    const system = new PatrolSystem({}, source);
    const snapshot = system.snapshot();
    if (source.kind === 'adaptive') source.parameters.populationWeight = 0;
    if (snapshot.strategy.kind === 'adaptive') snapshot.strategy.parameters.coverageWeight = 30;
    system.step(20);
    system.reset({ populationSeed: 997, fleetSize: 4 });
    expect(system.snapshot().strategy).toEqual(adaptive());
    expect(system.snapshot().time).toBe(0);
    expect(system.snapshot().config.fleetSize).toBe(4);
  });

  it('changes strategy without moving aircraft, erasing observations or restarting clocks', () => {
    const system = new PatrolSystem();
    system.step(77.25);
    system.injectFault(2, 'malfunction');
    const before = system.snapshot();
    system.setStrategy(adaptive());
    const after = system.snapshot();
    expect(after.time).toBe(before.time);
    expect(after.drones.map(drone => drone.position)).toEqual(before.drones.map(drone => drone.position));
    expect(after.drones.map(drone => drone.status)).toEqual(before.drones.map(drone => drone.status));
    expect(after.cells.map(cell => cell.lastVisited)).toEqual(before.cells.map(cell => cell.lastVisited));
    system.step(3);
    expect(system.snapshot().drones[1].status).toBe('offline');
    const adaptiveState = system.snapshot();
    system.setStrategy({ kind: 'uniform' });
    expect(system.snapshot().drones.map(drone => drone.position)).toEqual(adaptiveState.drones.map(drone => drone.position));
    expect(system.snapshot().predictedRevisitSeconds).not.toBeNull();
  });

  it('rejects invalid policy replacement before mutating mission state', () => {
    const system = new PatrolSystem({}, adaptive());
    system.step(15);
    const before = system.snapshot();
    expect(() => system.setStrategy({ kind: 'adaptive', parameters: { ...DEFAULT_POLICY_PARAMETERS, commitmentSeconds: 0 } })).toThrow('Invalid patrol strategy');
    expect(system.snapshot()).toEqual(before);
  });

  it('preserves pending deviation evidence through decisions, replans and strategy swaps', () => {
    const system = new PatrolSystem({}, adaptive());
    system.step(4.25);
    system.injectFault(1, 'malfunction');
    system.step(1);
    system.injectFault(2, 'deviation');
    const route = system.snapshot().drones[1].route;
    system.step(1.5);
    system.setStrategy({ kind: 'uniform' });
    system.setStrategy(adaptive());
    expect(system.snapshot().drones[1].route).toEqual(route);
    system.step(0.5);
    expect(system.snapshot().drones[0].status).toBe('offline');
    expect(system.snapshot().drones[1].status).toBe('deviating');
    expect(system.snapshot().drones[1].route).toEqual(route);
    system.step(2);
    expect(system.snapshot().drones[1].status).toBe('offline');
    const snapshot = system.snapshot();
    const assigned = snapshot.drones.filter(drone => drone.status === 'patrolling').flatMap(drone => drone.assignedCellIds);
    expect(new Set(assigned).size).toBe(snapshot.cells.length);
    expect(assigned.length).toBe(snapshot.cells.length);
  });

  it('does not redistribute a pending aircraft region before health confirmation', () => {
    for (const kind of ['malfunction', 'deviation'] as const) {
      const system = new PatrolSystem({}, adaptive());
      system.step(10.25);
      const before = system.snapshot();
      system.injectFault(2, kind);
      system.step(2.75);
      const pending = system.snapshot();
      expect(pending.drones[1].status).toBe(kind === 'malfunction' ? 'unresponsive' : 'deviating');
      expect(pending.cells.map(cell => cell.assignedDroneId)).toEqual(before.cells.map(cell => cell.assignedDroneId));
      expect(pending.drones[1].assignedCellIds).toEqual(before.drones[1].assignedCellIds);
      expect(pending.drones[1].route).toEqual(before.drones[1].route);
      expect(pending.revision).toBe(before.revision);
      system.step(2);
      const confirmed = system.snapshot();
      expect(confirmed.drones[1].status).toBe('offline');
      expect(confirmed.cells.every(cell => cell.assignedDroneId !== 2)).toBe(true);
      expect(confirmed.revision).toBe(before.revision + 1);
    }
  });

  it('detects deviations while hovering at an adaptive destination', () => {
    const system = new PatrolSystem({ fleetSize: 1 }, adaptive());
    const internal = system as unknown as { drones: { position: { x: number; y: number; z: number }; route: { x: number; y: number; z: number }[]; routeIndex: number }[] };
    internal.drones[0].position = { ...internal.drones[0].route[0] };
    system.injectFault(1, 'deviation');
    system.step(5);
    expect(system.snapshot().drones[0].status).toBe('offline');
  });

  it('preserves physical bounds, altitude lanes and speed limits', () => {
    const system = new PatrolSystem({ fleetSize: 8 }, adaptive());
    let previous = system.snapshot();
    for (let sample = 0; sample < 100; sample += 1) {
      system.step(0.5);
      const next = system.snapshot();
      for (const drone of next.drones) {
        const start = previous.drones[drone.id - 1].position;
        expect(Math.hypot(drone.position.x, drone.position.z)).toBeLessThanOrEqual(320 + 1e-8);
        expect(drone.position.y).toBe(260 + (drone.id - 1) * 4);
        expect(Math.hypot(drone.position.x - start.x, drone.position.z - start.z)).toBeLessThanOrEqual(PATROL_LIMITS.speed * 0.5 + 1e-8);
        expect(drone.route.every(position => Math.hypot(position.x, position.z) <= 320 + 1e-8)).toBe(true);
      }
      previous = next;
    }
  });

  it('makes the same decisions regardless of caller step size', () => {
    const coarse = new PatrolSystem({}, adaptive());
    const fine = new PatrolSystem({}, adaptive());
    coarse.step(120);
    for (let step = 0; step < 1200; step += 1) fine.step(0.1);
    const first = coarse.snapshot();
    const second = fine.snapshot();
    expect(first.coverage).toBe(second.coverage);
    expect(first.revision).toBe(second.revision);
    first.drones.forEach((drone, index) => {
      expect(drone.position.x).toBeCloseTo(second.drones[index].position.x, 6);
      expect(drone.position.z).toBeCloseTo(second.drones[index].position.z, 6);
      expect(drone.route).toEqual(second.drones[index].route);
    });
    first.cells.forEach((cell, index) => {
      if (cell.lastVisited === null) expect(second.cells[index].lastVisited).toBeNull();
      else expect(cell.lastVisited).toBeCloseTo(second.cells[index].lastVisited!, 6);
    });
  });

  it('handles zero healthy aircraft without inventing coverage or replacements', () => {
    const system = new PatrolSystem({ fleetSize: 2 }, adaptive());
    system.step(120);
    system.injectFault(1, 'malfunction');
    system.injectFault(2, 'malfunction');
    system.step(125);
    const snapshot = system.snapshot();
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.coverage).toBe(0);
    expect(snapshot.cells.every(cell => cell.assignedDroneId === null)).toBe(true);
    const position = snapshot.drones[0].position;
    system.restoreDrone(1);
    expect(system.snapshot().drones).toHaveLength(2);
    expect(system.snapshot().drones[0].position).toEqual(position);
    expect(system.snapshot().cells.every(cell => cell.assignedDroneId === 1)).toBe(true);
  });

  it('gives the planner detached observations without fault-injection capabilities', () => {
    const system = new PatrolSystem({}, adaptive());
    system.step(40);
    const before = system.snapshot();
    const internal = system as unknown as { policy: { choose: (...arguments_: unknown[]) => Map<number, { x: number; y: number; z: number }> } };
    internal.policy.choose = (...arguments_) => {
      const cells = arguments_[0] as { position: { x: number }; lastVisited: number | null }[];
      const aircraft = arguments_[1] as { id: number; position: { x: number; y: number; z: number }; destination: { x: number; y: number; z: number } | null }[];
      const parameters = arguments_[5] as PolicyParameters;
      expect(Object.keys(aircraft[0]).sort()).toEqual(['committed', 'destination', 'id', 'position']);
      cells[0].position.x = 9999;
      cells[0].lastVisited = 9999;
      parameters.populationWeight = 0;
      const commands = new Map(aircraft.map(drone => [drone.id, { ...drone.position }]));
      aircraft[0].position.x = 9999;
      return commands;
    };
    system.setStrategy(adaptive());
    const after = system.snapshot();
    expect(after.cells.map(cell => [cell.position, cell.lastVisited])).toEqual(before.cells.map(cell => [cell.position, cell.lastVisited]));
    expect(after.drones.map(drone => drone.position)).toEqual(before.drones.map(drone => drone.position));
    expect(after.strategy).toEqual(adaptive());
  });

  it('rejects invalid destinations and unsupported aircraft before applying any command', () => {
    const system = new PatrolSystem({}, adaptive());
    const internal = system as unknown as { policy: { choose: () => Map<number, { x: number; y: number; z: number }> } };
    const before = system.snapshot();
    for (const invalid of [{ x: 321, y: 260, z: 0 }, { x: NaN, y: 260, z: 0 }, { x: 0, y: 400, z: 0 }]) {
      internal.policy.choose = () => new Map(before.drones.map(drone => [drone.id, drone.id === 1 ? invalid : { ...drone.position }]));
      expect(() => system.setStrategy(adaptive())).toThrow('invalid destination');
      expect(system.snapshot().drones).toEqual(before.drones);
      expect(system.snapshot().cells).toEqual(before.cells);
    }
    internal.policy.choose = () => new Map([[99, { x: 0, y: 260, z: 0 }]]);
    expect(() => system.setStrategy(adaptive())).toThrow('unavailable aircraft');
  });

  it('retains useful geographic behavior when there are no people', () => {
    const system = new PatrolSystem({ populationCount: 0 }, adaptive());
    system.step(300);
    expect(system.snapshot().population.normalizedGapCost).toBeNull();
    expect(system.snapshot().everCovered).toBe(100);
    expect(system.snapshot().coverage).toBeGreaterThanOrEqual(95);
  });

  it('improves the population-gap diagnostic on the matched baseline seed', () => {
    const baseline = new PatrolSystem();
    const candidate = new PatrolSystem({}, adaptive());
    baseline.step(600);
    candidate.step(600);
    let baselineGap = 0;
    let candidateGap = 0;
    let baselinePopulation = 0;
    let candidatePopulation = 0;
    for (let sample = 0; sample < 240; sample += 1) {
      baseline.step(0.5);
      candidate.step(0.5);
      const reference = baseline.snapshot();
      const trial = candidate.snapshot();
      baselineGap += reference.population.normalizedGapCost!;
      candidateGap += trial.population.normalizedGapCost!;
      baselinePopulation += reference.population.onTimeCoverage!;
      candidatePopulation += trial.population.onTimeCoverage!;
      expect(trial.coverage).toBeGreaterThanOrEqual(95);
    }
    expect(candidateGap).toBeLessThan(baselineGap * 0.6);
    expect(candidatePopulation / 240).toBeGreaterThan(baselinePopulation / 240 + 10);
  });
});
