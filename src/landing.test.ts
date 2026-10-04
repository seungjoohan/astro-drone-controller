import { describe, expect, it } from 'vitest';
import { FLIGHT_MAPS } from './maps';
import type { BuildingTier } from './maps';
import { DronePhysics, SAFE_LANDING_HORIZONTAL_SPEED, SAFE_LANDING_VERTICAL_SPEED } from './physics';
import { ZERO_CONTROLS } from './types';
import type { FlightControls } from './types';
import { GROUND_HEIGHT } from './world';

function advance(physics: DronePhysics, seconds: number, controls: Partial<FlightControls> = {}): void {
  for (let frameIndex = 0; frameIndex < Math.round(seconds * 120); frameIndex += 1) {
    physics.step({ ...ZERO_CONTROLS, ...controls }, 1 / 120);
  }
}

function rooftopDrone(tiers: BuildingTier[] = [{ width: 24, depth: 24, base: 0, height: 10 }]): DronePhysics {
  const physics = new DronePhysics();
  physics.setMap({
    ...FLIGHT_MAPS.nyc,
    buildings: [{ x: 30, z: 0, style: 'stone', variant: 0, tiers }],
  });
  physics.state.position = { x: 30, y: 12, z: 0 };
  physics.arm();
  return physics;
}

describe('surface landings', () => {
  it('defines safe touchdown limits for vertical and horizontal speed', () => {
    expect(SAFE_LANDING_VERTICAL_SPEED).toBe(3);
    expect(SAFE_LANDING_HORIZONTAL_SPEED).toBe(2);
  });

  it('records one gentle rooftop touchdown and stays settled with wind and controls', () => {
    const physics = rooftopDrone();
    advance(physics, 2, { throttle: -0.5 });
    expect(physics.state.position).toEqual({ x: 30, y: 10.35, z: 0 });
    expect(physics.state.surface).toBe('rooftop');
    expect(physics.state.surfaceHeight).toBe(10);
    expect(physics.state.crashed).toBe(false);
    expect(physics.state.armed).toBe(true);
    expect(physics.state.landingCount).toBe(1);
    expect(physics.lastLanding?.surface).toBe('rooftop');
    expect(physics.lastLanding?.verticalSpeed).toBeGreaterThan(1);
    expect(physics.lastLanding?.verticalSpeed).toBeLessThanOrEqual(SAFE_LANDING_VERTICAL_SPEED);
    expect(physics.lastLanding?.horizontalSpeed).toBe(0);
    const touchdown = { ...physics.lastLanding };
    physics.wind = true;
    advance(physics, 4, { throttle: -1, roll: 1, pitch: 1, yaw: 0.5 });
    expect(physics.state.position).toEqual({ x: 30, y: 10.35, z: 0 });
    expect(physics.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(physics.state.landingCount).toBe(1);
    expect(physics.lastLanding).toEqual(touchdown);
  });

  it('keeps a disarmed rooftop drone supported without consuming flight time or battery', () => {
    const physics = rooftopDrone();
    advance(physics, 2, { throttle: -0.5 });
    physics.disarm();
    const restingState = structuredClone(physics.state);
    physics.wind = true;
    advance(physics, 5, { throttle: 1, roll: 1 });
    expect(physics.state.position).toEqual(restingState.position);
    expect(physics.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(physics.state.time).toBe(restingState.time);
    expect(physics.state.battery).toBe(restingState.battery);
    expect(physics.state.surface).toBe('rooftop');
    expect(physics.state.crashed).toBe(false);
    expect(physics.state.armed).toBe(false);
  });

  it('takes off from an exact roof surface and counts a subsequent touchdown once', () => {
    const physics = rooftopDrone();
    advance(physics, 2, { throttle: -0.5 });
    physics.step({ ...ZERO_CONTROLS, throttle: 1 }, 1 / 120);
    expect(physics.state.position.y).toBeGreaterThan(10.35);
    expect(physics.state.surface).toBeNull();
    expect(physics.state.crashed).toBe(false);
    advance(physics, 0.5, { throttle: 1 });
    advance(physics, 3, { throttle: -0.5 });
    expect(physics.state.position.y).toBe(10.35);
    expect(physics.state.surface).toBe('rooftop');
    expect(physics.state.landingCount).toBe(2);
  });

  it('lands on an exposed lower terrace instead of the upper setback', () => {
    const physics = rooftopDrone([
      { width: 24, depth: 24, base: 0, height: 10 },
      { width: 8, depth: 8, base: 10, height: 10 },
    ]);
    physics.state.position.x = 38;
    advance(physics, 2, { throttle: -0.5 });
    expect(physics.state.position).toEqual({ x: 38, y: 10.35, z: 0 });
    expect(physics.state.surfaceHeight).toBe(10);
    expect(physics.state.surface).toBe('rooftop');
    expect(physics.state.landingCount).toBe(1);
    expect(physics.state.crashed).toBe(false);
  });

  it('lands on the highest setback when descending over its footprint', () => {
    const physics = rooftopDrone([
      { width: 24, depth: 24, base: 0, height: 10 },
      { width: 8, depth: 8, base: 10, height: 10 },
    ]);
    physics.state.position.y = 22;
    advance(physics, 2, { throttle: -0.5 });
    expect(physics.state.position.y).toBe(20.35);
    expect(physics.state.surfaceHeight).toBe(20);
    expect(physics.state.surface).toBe('rooftop');
    expect(physics.state.crashed).toBe(false);
  });

  it('rejects a slow descent with excessive horizontal touchdown speed', () => {
    const physics = rooftopDrone();
    physics.state.position.y = 10.351;
    physics.state.velocity = { x: 4, y: -1, z: 0 };
    physics.step(ZERO_CONTROLS, 1 / 120);
    expect(physics.state.crashed).toBe(true);
    expect(physics.crashReason).toBe('rooftop');
    expect(physics.state.armed).toBe(false);
    expect(physics.state.landingCount).toBe(0);
    expect(physics.lastLanding).toBeNull();
  });

  it('rejects a hard vertical roof impact and freezes the crashed drone', () => {
    const physics = rooftopDrone();
    physics.state.position.y = 10.36;
    physics.state.velocity.y = -6;
    physics.disarm();
    physics.step(ZERO_CONTROLS, 1 / 120);
    expect(physics.state.position.y).toBe(10.35);
    expect(physics.state.crashed).toBe(true);
    expect(physics.crashReason).toBe('rooftop');
    expect(physics.state.landingCount).toBe(0);
    const crashedPosition = { ...physics.state.position };
    physics.arm();
    advance(physics, 1, { throttle: 1 });
    expect(physics.state.position).toEqual(crashedPosition);
    expect(physics.state.armed).toBe(false);
  });

  it('treats even a slow facade contact as a building collision', () => {
    const physics = rooftopDrone();
    physics.state.position = { x: 17.5, y: 5, z: 0 };
    advance(physics, 2, { roll: 0.01 });
    expect(physics.state.crashed).toBe(true);
    expect(physics.crashReason).toBe('building');
    expect(physics.state.landingCount).toBe(0);
  });

  it('rejects contact with the underside of a raised tier', () => {
    const physics = rooftopDrone([{ width: 24, depth: 24, base: 8, height: 2 }]);
    physics.state.position.y = 7.5;
    advance(physics, 2, { throttle: 0.05 });
    expect(physics.state.position.y).toBeCloseTo(7.65, 8);
    expect(physics.state.crashed).toBe(true);
    expect(physics.crashReason).toBe('building');
    expect(physics.state.landingCount).toBe(0);
  });

  it('rejects a roof edge touchdown without room for the whole drone', () => {
    const physics = rooftopDrone();
    physics.state.position.x = 41.8;
    advance(physics, 2, { throttle: -0.5 });
    expect(physics.state.crashed).toBe(true);
    expect(physics.crashReason).toBe('building');
    expect(physics.state.landingCount).toBe(0);
  });

  it('records safe ground landings and applies the horizontal speed limit there too', () => {
    const physics = new DronePhysics();
    physics.arm();
    advance(physics, 0.5, { throttle: 1 });
    advance(physics, 3, { throttle: -0.5 });
    expect(physics.state.position.y).toBe(GROUND_HEIGHT);
    expect(physics.state.surface).toBe('ground');
    expect(physics.state.surfaceHeight).toBe(0);
    expect(physics.state.landingCount).toBe(1);
    expect(physics.lastLanding?.surface).toBe('ground');
    physics.reset();
    physics.arm();
    physics.state.position.y = GROUND_HEIGHT + 0.001;
    physics.state.velocity = { x: 4, y: -1, z: 0 };
    physics.step(ZERO_CONTROLS, 1 / 120);
    expect(physics.state.crashed).toBe(true);
    expect(physics.crashReason).toBe('ground');
    expect(physics.state.landingCount).toBe(0);
  });

  it('clears landing feedback and rooftop support on reset and map changes', () => {
    const physics = rooftopDrone();
    advance(physics, 2, { throttle: -0.5 });
    physics.reset();
    expect(physics.state.surface).toBe('ground');
    expect(physics.state.surfaceHeight).toBe(0);
    expect(physics.state.position).toEqual({ x: 0, y: GROUND_HEIGHT, z: 0 });
    expect(physics.state.landingCount).toBe(0);
    expect(physics.lastLanding).toBeNull();
    physics.state.position = { x: 30, y: 12, z: 0 };
    physics.arm();
    advance(physics, 2, { throttle: -0.5 });
    expect(physics.state.landingCount).toBe(1);
    physics.setMap(FLIGHT_MAPS['pine-valley']);
    expect(physics.state.surface).toBe('ground');
    expect(physics.state.landingCount).toBe(0);
    expect(physics.lastLanding).toBeNull();
    expect(physics.crashReason).toBeNull();
  });
});
