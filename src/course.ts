import type { Gate, Vec3 } from './types';

export function passesGate(previous: Vec3, current: Vec3, gate: Gate): boolean {
  const normal = { x: Math.sin(gate.yaw), z: Math.cos(gate.yaw) };
  const previousDistance = (previous.x - gate.position.x) * normal.x + (previous.z - gate.position.z) * normal.z;
  const currentDistance = (current.x - gate.position.x) * normal.x + (current.z - gate.position.z) * normal.z;
  if (previousDistance === 0 || previousDistance * currentDistance > 0 || Math.abs(previousDistance - currentDistance) < 0.000001) return false;
  const fraction = previousDistance / (previousDistance - currentDistance);
  const crossing = {
    x: previous.x + (current.x - previous.x) * fraction - gate.position.x,
    y: previous.y + (current.y - previous.y) * fraction - gate.position.y,
    z: previous.z + (current.z - previous.z) * fraction - gate.position.z,
  };
  return Math.hypot(crossing.x, crossing.y, crossing.z) < gate.radius - 0.35;
}
