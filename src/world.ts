import type { Gate } from './types';

export const WORLD_RADIUS = 160;
export const GROUND_HEIGHT = 0.3;
export const MAX_ALTITUDE = 90;
export const GATES: Gate[] = [
  { position: { x: 0, y: 6, z: -24 }, yaw: 0, radius: 3.8 },
  { position: { x: 0, y: 9, z: -52 }, yaw: 0, radius: 3.8 },
  { position: { x: 24, y: 12, z: -78 }, yaw: -0.65, radius: 3.8 },
  { position: { x: 56, y: 9, z: -64 }, yaw: -1.95, radius: 3.8 },
  { position: { x: 58, y: 7, z: -24 }, yaw: Math.PI, radius: 3.8 },
  { position: { x: 25, y: 6, z: 3 }, yaw: 2.25, radius: 3.8 },
];
