export const RL_MAX_DRONES = 8;
export const RL_ACTION_COUNT = 27;
export const RL_HOVER_ACTION = 24;
export const RL_RETURN_ACTION = 25;
export const RL_STANDBY_ACTION = 26;
export const RL_CONTROL_SECONDS = 5;
export const RL_SAMPLE_SECONDS = 0.5;
export const RL_GRID_SIZE = 16;
export const RL_GRID_CHANNELS = 5;
export const RL_DRONE_FEATURES = 14;
export const RL_GLOBAL_FEATURES = 18;
export const RL_OBSERVATION_SIZE = RL_GRID_SIZE ** 2 * RL_GRID_CHANNELS + RL_MAX_DRONES * RL_DRONE_FEATURES + RL_GLOBAL_FEATURES;
export const RL_PROTOCOL_VERSION = 'patrol-neural-ppo-v1-grid16-controls5-audit10-dt0.5';

export const RL_DIRECTIONS = Array.from({ length: 8 }, (_, index) => ({
  x: Math.cos(index * Math.PI / 4),
  z: Math.sin(index * Math.PI / 4),
}));

export const RL_SPEED_FRACTIONS = [0.5, 0.75, 1] as const;

export function rlRandom(seed: number): () => number {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 2147483647) throw new Error('RL seed must be an integer in 1–2147483647.');
  let state = seed;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223 | 0;
    return (state >>> 0) / 4294967296;
  };
}
