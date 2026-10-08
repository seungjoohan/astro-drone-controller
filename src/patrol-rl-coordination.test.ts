import { describe, expect, it } from 'vitest';
import { RL_ACTION_COUNT, RL_DRONE_FEATURES, RL_GRID_CHANNELS, RL_GRID_SIZE, RL_HOVER_ACTION,
  RL_MAX_DRONES, RL_OBSERVATION_SIZE, RL_RETURN_ACTION, RL_STANDBY_ACTION } from './patrol-rl-contract';
import { COORDINATED_ACTOR_FEATURE_SIZE, coordinatedActorFeatures, createCoordinatedActorContext } from './patrol-rl-coordination';
import { SHARED_ACTOR_FEATURE_SIZE, sharedActorFeatures } from './patrol-rl-shared-features';

const DRONE_OFFSET = RL_GRID_SIZE ** 2 * RL_GRID_CHANNELS;
const GLOBAL_OFFSET = DRONE_OFFSET + RL_MAX_DRONES * RL_DRONE_FEATURES;
const SLOT_SIZE = RL_ACTION_COUNT * COORDINATED_ACTOR_FEATURE_SIZE;

function setDrone(observation: number[], slot: number, position: number, battery = 0.5): void {
  observation.splice(DRONE_OFFSET + slot * RL_DRONE_FEATURES, RL_DRONE_FEATURES,
    1, position, 0, battery, 0, 1, 0, 0, 0, 0, 0, position, 0, 1);
}

function observation(count = 3): number[] {
  const values = Array<number>(RL_OBSERVATION_SIZE).fill(0);
  for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 1) {
    values.splice(cell * RL_GRID_CHANNELS, RL_GRID_CHANNELS, 1, 0.25, 0.5, 0.75, 1);
  }
  for (let slot = 0; slot < count; slot += 1) setDrone(values, slot, (slot - 1) / 2, (slot + 4) / 10);
  values.splice(GLOBAL_OFFSET, 18, 0.5, 0.5, 0, 16 / 30, 0.5, 1, 300 / 1800,
    90 / 1800, 0.2, 0.25, 0, 0, 0.95, 120 / 3600, 15 / 120, 0.08, 0.08, count / 8);
  return values;
}

function actions(): number[] {
  return Array<number>(RL_MAX_DRONES).fill(RL_HOVER_ACTION);
}

function contextFeatures(rows: Float32Array, action = RL_HOVER_ACTION): number[] {
  const offset = action * COORDINATED_ACTOR_FEATURE_SIZE + SHARED_ACTOR_FEATURE_SIZE;
  return Array.from(rows.subarray(offset, offset + 12));
}

describe('autoregressive coordination features', () => {
  it('appends twelve bounded features without changing the original 68 or the input', () => {
    const input = observation();
    const before = [...input];
    const base = sharedActorFeatures(input);
    const output = coordinatedActorFeatures(input, actions());
    expect(COORDINATED_ACTOR_FEATURE_SIZE).toBe(80);
    expect(output).toHaveLength(RL_MAX_DRONES * RL_ACTION_COUNT * 80);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(input).toEqual(before);
    expect(coordinatedActorFeatures(new Float32Array(input), actions())).toEqual(output);
    for (let slot = 0; slot < RL_MAX_DRONES; slot += 1) {
      for (let action = 0; action < RL_ACTION_COUNT; action += 1) {
        const offset = (slot * RL_ACTION_COUNT + action) * COORDINATED_ACTOR_FEATURE_SIZE;
        const baseOffset = (slot * RL_ACTION_COUNT + action) * SHARED_ACTOR_FEATURE_SIZE;
        expect(output.subarray(offset, offset + SHARED_ACTOR_FEATURE_SIZE)).toEqual(base.subarray(baseOffset, baseOffset + SHARED_ACTOR_FEATURE_SIZE));
        expect(Array.from(output.subarray(offset + SHARED_ACTOR_FEATURE_SIZE, offset + COORDINATED_ACTOR_FEATURE_SIZE))
          .every(value => value >= 0 && value <= 1)).toBe(true);
      }
    }
  });

  it('exactly matches incremental decoding and teacher forcing for every candidate and slot', () => {
    const input = observation(8);
    const context = createCoordinatedActorContext(input);
    const recorded = [2, 8, 14, 20, RL_RETURN_ACTION, RL_STANDBY_ACTION, 0, RL_HOVER_ACTION];
    const complete = coordinatedActorFeatures(input, recorded);
    const prefix = Array<number>(RL_MAX_DRONES).fill(-1);
    for (const slot of context.order) {
      expect(context.features(slot, prefix)).toEqual(complete.subarray(slot * SLOT_SIZE, (slot + 1) * SLOT_SIZE));
      prefix[slot] = recorded[slot];
    }
    expect(prefix).toEqual(recorded);
  });

  it('does not read its own or any future action, while earlier intentions change later candidates', () => {
    const input = observation(2);
    setDrone(input, 0, 0, 0.4);
    setDrone(input, 1, 0, 0.5);
    const context = createCoordinatedActorContext(input);
    const future = actions();
    const before = context.features(0, future);
    future.fill(NaN);
    expect(context.features(0, future)).toEqual(before);
    future[0] = RL_HOVER_ACTION;
    const hovered = context.features(1, future);
    future[0] = RL_RETURN_ACTION;
    const returned = context.features(1, future);
    expect(contextFeatures(hovered)[2]).toBe(Math.fround(1 / 7));
    expect(contextFeatures(returned)[2]).toBe(0);
    expect(contextFeatures(returned)[3]).toBe(Math.fround(1 / 7));
    expect(hovered).not.toEqual(returned);
  });

  it('measures co-located and disjoint sensing disks without imposing a logit or action', () => {
    const input = observation(2);
    setDrone(input, 0, 0, 0.4);
    setDrone(input, 1, 0, 0.5);
    const context = createCoordinatedActorContext(input);
    const hovered = contextFeatures(context.features(1, actions()));
    expect(hovered).toEqual([Math.fround(1 / 7), 0, Math.fround(1 / 7), 0, 0, 0,
      Math.fround(1 / 7), 1, Math.fround(1 / 7), 1, 0, 0]);
    const spread = actions();
    spread[0] = 2;
    const moved = contextFeatures(context.features(1, spread));
    expect(moved[6]).toBe(0);
    expect(moved[7]).toBe(0);
    expect(moved[8]).toBeGreaterThan(0);
    expect(moved[9]).toBeLessThan(1);
    expect(moved[10]).toBeCloseTo(Math.fround(16 / 30) * 30 * 5 / Math.hypot(320, 320), 7);
    expect(moved[11]).toBeCloseTo(moved[10] / 2, 7);
  });

  it('distinguishes crossing trajectories from separated endpoints using their midpoints', () => {
    const input = observation(2);
    const context = createCoordinatedActorContext(input);
    const prefix = actions();
    prefix[0] = 2;
    const rows = context.features(1, prefix);
    const crossing = contextFeatures(rows, 14);
    const stationary = contextFeatures(rows, RL_HOVER_ACTION);
    expect(crossing[7]).toBe(0);
    expect(crossing[9]).toBeCloseTo(1, 6);
    expect(stationary[7]).toBeCloseTo(1, 6);
    expect(stationary[9]).toBeGreaterThan(0);
    expect(stationary[9]).toBeLessThan(crossing[9]);
  });

  it('reports returning and standby intentions but never credits their cameras', () => {
    const input = observation(3);
    setDrone(input, 0, 0, 0.4);
    setDrone(input, 1, 0, 0.5);
    setDrone(input, 2, 0, 0.6);
    const prefix = actions();
    prefix[0] = RL_RETURN_ACTION;
    prefix[1] = RL_STANDBY_ACTION;
    const rows = createCoordinatedActorContext(input).features(2, prefix);
    expect(contextFeatures(rows)).toEqual([Math.fround(2 / 7), 0, 0, Math.fround(1 / 7), Math.fround(1 / 7), 0, 0, 0, 0, 0, 1, 1]);
    const hovering = createCoordinatedActorContext(input).features(2, actions());
    for (const action of [RL_RETURN_ACTION, RL_STANDBY_ACTION]) {
      expect(contextFeatures(hovering, action).slice(6)).toEqual([0, 0, 0, 0, 1, 1]);
    }
  });

  it.each([6, 7, 8, 10])('excludes forced hover for unavailable service/offline bit %s', serviceFeature => {
    const input = observation(2);
    input[DRONE_OFFSET + 5] = 0;
    input[DRONE_OFFSET + serviceFeature] = 1;
    input[DRONE_OFFSET + 13] = 0;
    const context = createCoordinatedActorContext(input);
    const later = contextFeatures(context.features(1, actions()));
    expect(later.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(later[5]).toBe(serviceFeature === 10 ? 0 : Math.fround(1 / 7));
    expect(later.slice(6)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(contextFeatures(context.features(0, actions())).slice(6)).toEqual([0, 0, 0, 0, 1, 1]);
  });

  it('allows controllable standby drones to reactivate sensing and ignores inconsistent offline availability', () => {
    const input = observation(2);
    input[DRONE_OFFSET + 5] = 0;
    input[DRONE_OFFSET + 9] = 1;
    expect(contextFeatures(createCoordinatedActorContext(input).features(1, actions()))[2]).toBe(Math.fround(1 / 7));
    input[DRONE_OFFSET + 10] = 1;
    expect(contextFeatures(createCoordinatedActorContext(input).features(1, actions()))[2]).toBe(0);
  });

  it('preserves physical ordering and features when distinct present slots are relabeled', () => {
    const input = observation();
    const originalActions = actions();
    originalActions[0] = 2;
    originalActions[1] = RL_RETURN_ACTION;
    const permutation = [4, 2, 0, 7, 1, 6, 3, 5];
    const relabeled = [...input];
    permutation.forEach((source, destination) => relabeled.splice(DRONE_OFFSET + destination * RL_DRONE_FEATURES, RL_DRONE_FEATURES,
      ...input.slice(DRONE_OFFSET + source * RL_DRONE_FEATURES, DRONE_OFFSET + (source + 1) * RL_DRONE_FEATURES)));
    const original = coordinatedActorFeatures(input, originalActions);
    const changed = coordinatedActorFeatures(relabeled, permutation.map(source => originalActions[source]));
    expect(createCoordinatedActorContext(relabeled).order.slice(0, 3).map(slot => permutation[slot]))
      .toEqual(createCoordinatedActorContext(input).order.slice(0, 3));
    permutation.forEach((source, destination) => {
      expect(changed.subarray(destination * SLOT_SIZE, (destination + 1) * SLOT_SIZE))
        .toEqual(original.subarray(source * SLOT_SIZE, (source + 1) * SLOT_SIZE));
    });
  });

  it('breaks exact physical ties deterministically by slot and leaves padded rows zero', () => {
    const input = observation(2);
    setDrone(input, 0, 0);
    setDrone(input, 1, 0);
    const context = createCoordinatedActorContext(input);
    expect(context.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(contextFeatures(context.features(0, actions()))[2]).toBe(0);
    expect(contextFeatures(context.features(1, actions()))[2]).toBe(Math.fround(1 / 7));
    const output = coordinatedActorFeatures(input, actions());
    expect(output.subarray(2 * SLOT_SIZE).every(value => value === 0)).toBe(true);
    for (let feature = 1; feature < RL_DRONE_FEATURES; feature += 1) input[DRONE_OFFSET + 6 * RL_DRONE_FEATURES + feature] = feature * 100;
    expect(coordinatedActorFeatures(input, actions())).toEqual(output);
  });

  it('protects cached observations, base rows, order and caller actions from mutation', () => {
    const input = observation();
    const chosen = actions();
    const context = createCoordinatedActorContext(input);
    const before = context.features(1, chosen);
    input.fill(0);
    expect(context.features(1, chosen)).toEqual(before);
    const corrupt = context.features(1, chosen);
    corrupt.fill(123);
    expect(context.features(1, chosen)).toEqual(before);
    expect(chosen).toEqual(actions());
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.order)).toBe(true);
  });

  it('rejects malformed observations, slots, action vectors and earlier actions', () => {
    for (const input of [[], Array(RL_OBSERVATION_SIZE).fill(Infinity), Array(RL_OBSERVATION_SIZE).fill(1e100),
      Array(RL_OBSERVATION_SIZE), new Float64Array(RL_OBSERVATION_SIZE)]) {
      expect(() => createCoordinatedActorContext(input as number[])).toThrow();
    }
    const context = createCoordinatedActorContext(observation());
    for (const slot of [-1, RL_MAX_DRONES, 0.5, NaN]) expect(() => context.features(slot, actions())).toThrow();
    for (const invalid of [[], actions().slice(1), new Float32Array(8)]) {
      expect(() => context.features(0, invalid as number[])).toThrow();
      expect(() => coordinatedActorFeatures(observation(), invalid as number[])).toThrow();
    }
    for (const invalid of [-1, RL_ACTION_COUNT, 1.5, NaN, Infinity, undefined]) {
      const chosen = actions();
      chosen[0] = invalid as number;
      expect(() => context.features(1, chosen)).toThrow();
      expect(() => coordinatedActorFeatures(observation(), chosen)).toThrow();
    }
    expect(() => coordinatedActorFeatures(observation(), Array(RL_MAX_DRONES))).toThrow();
    expect(() => context.features(0, Array<number>(RL_MAX_DRONES).fill(-1))).not.toThrow();
  });
});
