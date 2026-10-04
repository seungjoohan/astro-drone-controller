import { describe, expect, it } from 'vitest';
import { passesGate } from './course';
import type { Gate } from './types';

const gate: Gate = { position: { x: 0, y: 6, z: -24 }, radius: 3.8, yaw: 0 };

describe('gate crossings', () => {
  it('detects a fast crossing even when neither endpoint is inside the ring', () => {
    expect(passesGate({ x: 0, y: 6, z: -10 }, { x: 0, y: 6, z: -40 }, gate)).toBe(true);
  });
  it('rejects crossings outside the opening and motion beside the gate', () => {
    expect(passesGate({ x: 5, y: 6, z: -20 }, { x: 5, y: 6, z: -26 }, gate)).toBe(false);
    expect(passesGate({ x: 0, y: 6, z: -20 }, { x: 0, y: 6, z: -22 }, gate)).toBe(false);
  });
  it('handles rotated gates', () => {
    expect(passesGate({ x: -4, y: 6, z: -24 }, { x: 4, y: 6, z: -24 }, { ...gate, yaw: Math.PI / 2 })).toBe(true);
  });

  it('counts landing exactly on the plane once', () => {
    expect(passesGate({ x: 0, y: 6, z: -20 }, { x: 0, y: 6, z: -24 }, gate)).toBe(true);
    expect(passesGate({ x: 0, y: 6, z: -24 }, { x: 0, y: 6, z: -26 }, gate)).toBe(false);
  });
});
