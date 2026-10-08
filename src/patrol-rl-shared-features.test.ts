import { describe, expect, it } from 'vitest';
import { RL_ACTION_COUNT, RL_DRONE_FEATURES, RL_GRID_CHANNELS, RL_GRID_SIZE, RL_HOVER_ACTION,
  RL_MAX_DRONES, RL_OBSERVATION_SIZE, RL_RETURN_ACTION, RL_STANDBY_ACTION } from './patrol-rl-contract';
import { SHARED_ACTOR_FEATURE_SIZE, sharedActorFeatures } from './patrol-rl-shared-features';

const DRONE_OFFSET = RL_GRID_SIZE ** 2 * RL_GRID_CHANNELS;
const GLOBAL_OFFSET = DRONE_OFFSET + RL_MAX_DRONES * RL_DRONE_FEATURES;

function observation(): number[] {
  const values = Array<number>(RL_OBSERVATION_SIZE).fill(0);
  for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 1) {
    values.splice(cell * RL_GRID_CHANNELS, RL_GRID_CHANNELS, 1, (cell % 16 + 1) / 17,
      (Math.floor(cell / 16) + 1) / 17, (cell % 7 + 1) / 9, Number(cell % 3 !== 0));
  }
  const drones = [
    [1, -0.5, 0.25, 0.8, 0.75, 1, 0, 0, 0, 0, 0, -0.25, 0.5, 1],
    [1, 0.25, -0.5, 0.6, 0.5, 1, 0, 0, 0, 0, 0, 0.5, -0.25, 1],
    [1, 0.5, 0.25, 0.4, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  ];
  drones.forEach((drone, slot) => values.splice(DRONE_OFFSET + slot * RL_DRONE_FEATURES, RL_DRONE_FEATURES, ...drone));
  values.splice(GLOBAL_OFFSET, 18, 1, 1, 0, 2 / 3, 1, 1, 0.5, 0.1, 0.2, 0.5, 0.125, -0.25, 0.95, 1 / 30, 0.125, 0.08, 0.1, 3 / 8);
  return values;
}

function features(values: Float32Array, slot = 0, action = RL_HOVER_ACTION): number[] {
  const offset = (slot * RL_ACTION_COUNT + action) * SHARED_ACTOR_FEATURE_SIZE;
  return Array.from(values.subarray(offset, offset + SHARED_ACTOR_FEATURE_SIZE));
}

function transformObservation(values: number[], reflect: boolean): number[] {
  const transformed = [...values];
  for (let row = 0; row < RL_GRID_SIZE; row += 1) {
    for (let column = 0; column < RL_GRID_SIZE; column += 1) {
      const destinationColumn = reflect ? RL_GRID_SIZE - 1 - column : RL_GRID_SIZE - 1 - row;
      const destinationRow = reflect ? row : column;
      for (let channel = 0; channel < RL_GRID_CHANNELS; channel += 1) {
        transformed[(destinationRow * RL_GRID_SIZE + destinationColumn) * RL_GRID_CHANNELS + channel]
          = values[(row * RL_GRID_SIZE + column) * RL_GRID_CHANNELS + channel];
      }
    }
  }
  const transform = (offset: number) => {
    transformed[offset] = reflect ? -values[offset] : -values[offset + 1];
    transformed[offset + 1] = reflect ? values[offset + 1] : values[offset];
  };
  for (let slot = 0; slot < RL_MAX_DRONES; slot += 1) {
    transform(DRONE_OFFSET + slot * RL_DRONE_FEATURES + 1);
    transform(DRONE_OFFSET + slot * RL_DRONE_FEATURES + 11);
  }
  transform(GLOBAL_OFFSET + 10);
  return transformed;
}

describe('shared drone/action actor features', () => {
  it('emits float32 [8,27,68] features without changing inputs and preserves the declared feature order', () => {
    const input = observation();
    const before = [...input];
    const output = sharedActorFeatures(input);
    expect(output).toBeInstanceOf(Float32Array);
    expect(output).toHaveLength(RL_MAX_DRONES * RL_ACTION_COUNT * 68);
    expect(output.every(Number.isFinite)).toBe(true);
    expect(input).toEqual(before);
    expect(sharedActorFeatures(new Float32Array(input))).toEqual(output);
    const hovered = features(output);
    expect(hovered.slice(0, 10)).toEqual([0, 3, 4, 5, 6, 7, 8, 9, 10, 13]
      .map(index => Math.fround(input[DRONE_OFFSET + index])));
    expect(hovered.slice(10, 26)).toEqual(input.slice(GLOBAL_OFFSET).filter((_value, index) => index !== 10 && index !== 11).map(Math.fround));
    expect(hovered.slice(26, 32)).toEqual([0, 1, 0, 0, 0, 0]);
    expect(hovered.slice(41, 48)).toEqual(Array(7).fill(0));
    expect(hovered.slice(55, 62)).toEqual(Array(7).fill(0));
    const moved = features(output, 0, 2);
    expect(moved.slice(26, 31)).toEqual([1, 0, 0, 0, 1]);
    expect(moved[31]).toBeCloseTo(Math.fround(2 / 3) * 30 * 5 / Math.hypot(640, 640), 7);
  });

  it('leaves padded egos entirely zero and ignores absent peer payloads', () => {
    expect(sharedActorFeatures(Array(RL_OBSERVATION_SIZE).fill(0)).every(value => value === 0)).toBe(true);
    const input = observation();
    const output = sharedActorFeatures(input);
    const modified = [...input];
    for (let feature = 1; feature < RL_DRONE_FEATURES; feature += 1) modified[DRONE_OFFSET + 6 * RL_DRONE_FEATURES + feature] = feature * 123;
    expect(sharedActorFeatures(modified)).toEqual(output);
    expect(Array.from(output.subarray(3 * RL_ACTION_COUNT * 68)).every(value => value === 0)).toBe(true);
  });

  it('has exact inverse-permutation equality across present, duplicated and padded slots', () => {
    const input = observation();
    input.splice(DRONE_OFFSET + 4 * RL_DRONE_FEATURES, RL_DRONE_FEATURES,
      ...input.slice(DRONE_OFFSET + RL_DRONE_FEATURES, DRONE_OFFSET + 2 * RL_DRONE_FEATURES));
    const permutation = [4, 2, 0, 7, 1, 6, 3, 5];
    const permuted = [...input];
    permutation.forEach((source, destination) => permuted.splice(DRONE_OFFSET + destination * RL_DRONE_FEATURES, RL_DRONE_FEATURES,
      ...input.slice(DRONE_OFFSET + source * RL_DRONE_FEATURES, DRONE_OFFSET + (source + 1) * RL_DRONE_FEATURES)));
    const originalFeatures = sharedActorFeatures(input);
    const permutedFeatures = sharedActorFeatures(permuted);
    permutation.forEach((source, destination) => {
      for (let action = 0; action < RL_ACTION_COUNT; action += 1) {
        expect(features(permutedFeatures, destination, action)).toEqual(features(originalFeatures, source, action));
      }
    });
  });

  it('uses unitless weighted raster means and valid support rather than population counts', () => {
    const input = observation();
    for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 1) input.splice(cell * RL_GRID_CHANNELS, 5, 1, 0.5, 0.25, 0.75, 1);
    const output = sharedActorFeatures(input);
    for (const offset of [34, 48]) {
      expect(features(output).slice(offset, offset + 7)).toEqual([0.5, 0.25, 0.75, 1, 0.125, 0.375, 1]);
    }
    for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 2) input[cell * RL_GRID_CHANNELS] = 0;
    const partial = features(sharedActorFeatures(input));
    expect(partial[40]).toBeGreaterThan(0);
    expect(partial[40]).toBeLessThan(1);
    expect(partial.slice(34, 40)).toEqual([0.5, 0.25, 0.75, 1, 0.125, 0.375]);
    for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 1) input[cell * RL_GRID_CHANNELS] = 0;
    expect(features(sharedActorFeatures(input)).slice(34, 62)).toEqual(Array(28).fill(0));
  });

  it('does not give sensing credit to return or standby, while retaining their geometric targets', () => {
    const output = sharedActorFeatures(observation());
    const hovered = features(output);
    for (const action of [RL_RETURN_ACTION, RL_STANDBY_ACTION]) {
      const commanded = features(output, 0, action);
      for (const offset of [34, 48]) {
        expect(commanded.slice(offset, offset + 7)).toEqual(Array(7).fill(0));
        expect(commanded.slice(offset + 7, offset + 14)).toEqual(hovered.slice(offset, offset + 7).map(value => Math.fround(-value)));
      }
    }
    const returned = features(output, 0, RL_RETURN_ACTION);
    expect(returned.slice(26, 31)).toEqual([0, 0, 1, 0, 1]);
    expect(returned[32]).toBe(0);
    expect(returned[31]).toBeCloseTo(Math.hypot(200, 160) / Math.hypot(640, 640), 7);
    expect(returned[33]).toBeCloseTo(-returned[31], 7);
    const standby = features(output, 0, RL_STANDBY_ACTION);
    expect(standby.slice(26, 32)).toEqual([0, 0, 0, 1, 0, 0]);
    expect(standby[32]).toBe(hovered[32]);
    expect(standby[33]).toBe(0);
  });

  it('places rectangular raster centers at their actual width and depth for both kernel scales', () => {
    const input = observation();
    input[GLOBAL_OFFSET + 1] = 0.5;
    input[DRONE_OFFSET + 1] = 0;
    input[DRONE_OFFSET + 2] = 0;
    for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 1) input[cell * RL_GRID_CHANNELS] = 0;
    input.splice((8 * 16 + 8) * RL_GRID_CHANNELS, 5, 1, 0.25, 0.5, 0.5, 1);
    input.splice((10 * 16 + 8) * RL_GRID_CHANNELS, 5, 1, 0.75, 0.5, 0.5, 1);
    const output = features(sharedActorFeatures(input));
    for (const [scale, radius] of [64, 192].entries()) {
      const firstWeight = 1 / (1 + (20 ** 2 + 10 ** 2) / radius ** 2) ** 2;
      const secondWeight = 1 / (1 + (20 ** 2 + 50 ** 2) / radius ** 2) ** 2;
      expect(output[34 + scale * 14]).toBeCloseTo((firstWeight * 0.25 + secondWeight * 0.75) / (firstWeight + secondWeight), 7);
      let totalWeight = 0;
      for (let row = 0; row < 16; row += 1) {
        for (let column = 0; column < 16; column += 1) {
          const horizontal = (column + 0.5) * 40 - 320;
          const vertical = (row + 0.5) * 20 - 160;
          totalWeight += 1 / (1 + (horizontal ** 2 + vertical ** 2) / radius ** 2) ** 2;
        }
      }
      expect(output[40 + scale * 14]).toBeCloseTo((firstWeight + secondWeight) / totalWeight, 7);
    }
  });

  it('responds separately to population, history, and peer position/destination changes', () => {
    const input = observation();
    const base = features(sharedActorFeatures(input));
    const demand = [...input];
    const history = [...input];
    for (let cell = 0; cell < RL_GRID_SIZE ** 2; cell += 1) {
      demand[cell * RL_GRID_CHANNELS + 1] *= 0.5;
      history[cell * RL_GRID_CHANNELS + 2] *= 0.5;
    }
    const demandFeatures = features(sharedActorFeatures(demand));
    const historyFeatures = features(sharedActorFeatures(history));
    expect(demandFeatures[34]).toBeCloseTo(base[34] / 2, 7);
    expect(demandFeatures[35]).toBe(base[35]);
    expect(historyFeatures[34]).toBe(base[34]);
    expect(historyFeatures[35]).toBeCloseTo(base[35] / 2, 7);
    const peer = [...input];
    peer[DRONE_OFFSET + RL_DRONE_FEATURES + 1] = input[DRONE_OFFSET + 1];
    peer[DRONE_OFFSET + RL_DRONE_FEATURES + 2] = input[DRONE_OFFSET + 2];
    peer[DRONE_OFFSET + RL_DRONE_FEATURES + 11] = input[DRONE_OFFSET + 1];
    peer[DRONE_OFFSET + RL_DRONE_FEATURES + 12] = input[DRONE_OFFSET + 2];
    const peerFeatures = features(sharedActorFeatures(peer));
    expect(peerFeatures.slice(0, 62)).toEqual(base.slice(0, 62));
    expect(peerFeatures[62]).toBeGreaterThan(base[62]);
    expect(peerFeatures[63]).toBeGreaterThan(base[63]);
    expect(peerFeatures[64]).toBe(1);
    expect(peerFeatures[65]).toBe(1);
    expect(peerFeatures[66]).toBe(0);
    expect(peerFeatures[67]).toBe(Math.fround(1 / 7));
  });

  it('counts approximate active peers only from observed patrol and availability bits', () => {
    const input = observation();
    input[DRONE_OFFSET + RL_DRONE_FEATURES + 13] = 0;
    const output = features(sharedActorFeatures(input));
    expect(output[62]).toBeGreaterThan(0);
    expect(output[63]).toBeGreaterThan(0);
    expect(output.slice(64, 68)).toEqual([0, 0, 1, 0]);
  });

  for (const reflect of [false, true]) {
    it(`approximately preserves geometry under ${reflect ? 'reflection' : 'quarter rotation'} with corresponding actions`, () => {
      const input = observation();
      const base = sharedActorFeatures(input);
      const transformed = sharedActorFeatures(transformObservation(input, reflect));
      let maximumDifference = 0;
      for (let slot = 0; slot < RL_MAX_DRONES; slot += 1) {
        for (let action = 0; action < RL_ACTION_COUNT; action += 1) {
          const direction = Math.floor(action / 3);
          const transformedAction = action >= RL_HOVER_ACTION ? action : ((reflect ? 4 - direction + 8 : direction + 2) % 8) * 3 + action % 3;
          const before = features(base, slot, action);
          const after = features(transformed, slot, transformedAction);
          before.forEach((value, index) => { maximumDifference = Math.max(maximumDifference, Math.abs(value - after[index])); });
        }
      }
      expect(maximumDifference).toBeLessThan(1e-6);
    });
  }

  it('accepts finite zero or signed synthetic geometry using positive floors', () => {
    const input = observation();
    for (const value of [0, -1]) {
      for (const index of [0, 1, 3, 4]) input[GLOBAL_OFFSET + index] = value;
      expect(sharedActorFeatures(input).every(Number.isFinite)).toBe(true);
    }
  });

  it('rejects malformed, sparse, non-finite and float32-overflow observations', () => {
    expect(() => sharedActorFeatures([])).toThrow();
    expect(() => sharedActorFeatures(new Array<number>(RL_OBSERVATION_SIZE))).toThrow();
    for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
      const input = observation();
      input[10] = value;
      expect(() => sharedActorFeatures(input)).toThrow();
    }
  });
});
