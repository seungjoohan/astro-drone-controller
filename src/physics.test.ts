import { describe, expect, it } from 'vitest';
import { FLIGHT_MAPS } from './maps';
import { DronePhysics, SAFE_LANDING_HORIZONTAL_SPEED, SAFE_LANDING_VERTICAL_SPEED } from './physics';
import { ZERO_CONTROLS } from './types';
import type { FlightControls } from './types';
import { GROUND_HEIGHT, MAX_ALTITUDE, WORLD_RADIUS } from './world';

function fly(physics: DronePhysics, seconds: number, controls: Partial<FlightControls> = {}, frequency = 60): void {
  const frameCount = Math.round(seconds * frequency);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    physics.step({ ...ZERO_CONTROLS, ...controls }, 1 / frequency);
  }
}

function airborneDrone(): DronePhysics {
  const physics = new DronePhysics();
  physics.arm();
  fly(physics, 2, { throttle: 1 });
  fly(physics, 1);
  return physics;
}

describe('DronePhysics', () => {
  it('starts grounded and requires arming and positive throttle to take off', () => {
    const physics = new DronePhysics();
    fly(physics, 1, { throttle: 1, pitch: 1 });
    expect(physics.state.position).toEqual({ x: 0, y: GROUND_HEIGHT, z: 0 });
    expect(physics.state.battery).toBe(100);
    expect(physics.state.surface).toBe('ground');
    expect(physics.state.landingCount).toBe(0);
    expect(physics.lastLanding).toBeNull();
    physics.arm();
    fly(physics, 1);
    expect(physics.state.position.y).toBe(GROUND_HEIGHT);
    fly(physics, 1, { throttle: 1 });
    expect(physics.state.position.y).toBeGreaterThan(4);
    expect(physics.state.surface).toBeNull();
  });

  it('holds altitude and brakes horizontally with centered sticks', () => {
    const physics = airborneDrone();
    fly(physics, 2, { pitch: 1 });
    expect(physics.state.position.z).toBeLessThan(-15);
    expect(physics.state.velocity.z).toBeLessThan(-11);
    const altitude = physics.state.position.y;
    fly(physics, 3);
    expect(Math.abs(physics.state.velocity.z)).toBeLessThan(0.001);
    expect(physics.state.position.y).toBeCloseTo(altitude, 3);
    expect(physics.state.pitch).toBeCloseTo(0, 5);
  });

  it('maps right roll and clockwise yaw to the correct world directions', () => {
    const physics = airborneDrone();
    fly(physics, 1, { roll: 1 });
    expect(physics.state.position.x).toBeGreaterThan(7);
    expect(physics.state.roll).toBeLessThan(0);
    fly(physics, 2);
    physics.state.yaw = Math.PI / 2;
    const previousX = physics.state.position.x;
    fly(physics, 1, { pitch: 1 });
    expect(physics.state.position.x - previousX).toBeGreaterThan(7);
    expect(Math.abs(physics.state.velocity.z)).toBeLessThan(0.001);
    fly(physics, 1, { yaw: 0.25 });
    expect(physics.state.yaw).toBeCloseTo(Math.PI / 2 + 0.4, 5);
  });

  it('caps diagonal speed and makes sport mode faster with longer braking', () => {
    const assisted = airborneDrone();
    const sport = airborneDrone();
    sport.mode = 'sport';
    fly(assisted, 4, { pitch: 1, roll: 1 });
    fly(sport, 4, { pitch: 1, roll: 1 });
    expect(Math.hypot(assisted.state.velocity.x, assisted.state.velocity.z)).toBeCloseTo(12, 2);
    expect(Math.hypot(sport.state.velocity.x, sport.state.velocity.z)).toBeGreaterThan(23);
    fly(assisted, 1);
    fly(sport, 1);
    expect(Math.hypot(assisted.state.velocity.x, assisted.state.velocity.z)).toBeLessThan(0.2);
    expect(Math.hypot(sport.state.velocity.x, sport.state.velocity.z)).toBeGreaterThan(10);
  });

  it('keeps altitude and radial position inside the training bounds', () => {
    const physics = airborneDrone();
    physics.mode = 'sport';
    fly(physics, 40, { throttle: 1, pitch: 1, roll: 1 });
    expect(physics.state.position.y).toBe(MAX_ALTITUDE);
    expect(Math.hypot(physics.state.position.x, physics.state.position.z)).toBeCloseTo(WORLD_RADIUS, 6);
    expect(physics.state.velocity.y).toBe(0);
    fly(physics, 2, { pitch: -1, roll: -1, throttle: -0.2 });
    expect(Math.hypot(physics.state.position.x, physics.state.position.z)).toBeLessThan(WORLD_RADIUS - 20);
    expect(physics.state.position.y).toBeLessThan(MAX_ALTITUDE);
  });

  it('allows assisted landing and taking off again', () => {
    const physics = airborneDrone();
    fly(physics, 8, { throttle: -1 });
    expect(physics.state.position.y).toBe(GROUND_HEIGHT);
    expect(physics.state.crashed).toBe(false);
    expect(physics.state.armed).toBe(true);
    expect(physics.state.surface).toBe('ground');
    expect(physics.state.surfaceHeight).toBe(0);
    expect(physics.state.landingCount).toBe(1);
    expect(physics.lastLanding?.surface).toBe('ground');
    const landing = physics.lastLanding;
    fly(physics, 1, { throttle: 1 });
    expect(physics.state.position.y).toBeGreaterThan(4);
    expect(physics.state.surface).toBeNull();
    expect(physics.state.landingCount).toBe(1);
    expect(physics.lastLanding).toBe(landing);
  });

  it('crashes after cutting motors in flight and requires reset before rearming', () => {
    const physics = airborneDrone();
    physics.disarm();
    fly(physics, 5);
    expect(physics.state.position.y).toBe(GROUND_HEIGHT);
    expect(physics.state.crashed).toBe(true);
    expect(physics.crashReason).toBe('ground');
    expect(physics.state.armed).toBe(false);
    physics.arm();
    expect(physics.state.armed).toBe(false);
    physics.reset();
    expect(physics.state.battery).toBe(100);
    expect(physics.state.time).toBe(0);
    expect(physics.state.distance).toBe(0);
    physics.arm();
    expect(physics.state.armed).toBe(true);
  });

  it('treats a fast sport descent as a hard landing', () => {
    const physics = airborneDrone();
    physics.mode = 'sport';
    fly(physics, 4, { throttle: -1 });
    expect(physics.state.crashed).toBe(true);
    expect(physics.state.armed).toBe(false);
    expect(physics.state.position.y).toBe(GROUND_HEIGHT);
  });

  it('settles onto the ground after disarming just above it', () => {
    const physics = new DronePhysics();
    physics.state.position.y = GROUND_HEIGHT + 0.0005;
    fly(physics, 1);
    expect(physics.state.position.y).toBe(GROUND_HEIGHT);
    expect(physics.state.crashed).toBe(false);
  });

  it('records telemetry and exhausts its battery after eight armed minutes', () => {
    const physics = airborneDrone();
    fly(physics, 2, { pitch: 1 });
    expect(physics.state.time).toBeCloseTo(5, 5);
    expect(physics.state.distance).toBeGreaterThan(25);
    expect(physics.state.maxSpeed).toBeGreaterThan(11);
    expect(physics.state.battery).toBeCloseTo(100 - 500 / 480, 5);
    physics.reset();
    physics.arm();
    fly(physics, 481, {}, 10);
    expect(physics.state.battery).toBe(0);
    expect(physics.state.armed).toBe(false);
    physics.arm();
    expect(physics.state.armed).toBe(false);
  });

  it('clamps stalled frames and rejects invalid time and stick values', () => {
    const physics = new DronePhysics();
    physics.arm();
    physics.step({ throttle: 100, yaw: Infinity, pitch: NaN, roll: -Infinity }, 1000);
    expect(physics.state.time).toBeCloseTo(0.1, 8);
    expect(physics.state.position.y).toBeGreaterThan(GROUND_HEIGHT);
    expect(physics.state.position.y).toBeLessThan(1);
    const previousState = structuredClone(physics.state);
    for (const delta of [0, -1, NaN, Infinity]) physics.step(ZERO_CONTROLS, delta);
    expect(physics.state).toEqual(previousState);
    expect(physics.state.yaw).toBe(0);
    expect(physics.state.position.x).toBe(0);
    expect(physics.state.position.z).toBe(0);
  });

  it('produces the same flight path at common render frequencies', () => {
    const slow = new DronePhysics();
    const fast = new DronePhysics();
    slow.arm();
    fast.arm();
    fly(slow, 8, { throttle: 0.4, pitch: 0.6, roll: 0.3, yaw: 0.2 }, 30);
    fly(fast, 8, { throttle: 0.4, pitch: 0.6, roll: 0.3, yaw: 0.2 }, 120);
    expect(slow.state.position.x).toBeCloseTo(fast.state.position.x, 6);
    expect(slow.state.position.y).toBeCloseTo(fast.state.position.y, 6);
    expect(slow.state.position.z).toBeCloseTo(fast.state.position.z, 6);
    expect(slow.state.battery).toBeCloseTo(fast.state.battery, 6);
  });

  it('adds deterministic horizontal wind drift only when enabled', () => {
    const calm = airborneDrone();
    const windy = airborneDrone();
    windy.wind = true;
    fly(calm, 3);
    fly(windy, 3);
    expect(calm.state.position.x).toBe(0);
    expect(Math.hypot(windy.state.position.x, windy.state.position.z)).toBeGreaterThan(1);
    expect(windy.state.position.y).toBeCloseTo(calm.state.position.y, 6);
  });

  it('stops at a city facade, disarms, and freezes until reset', () => {
    const physics = new DronePhysics();
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.state.position = { x: 0, y: 20, z: -96 };
    physics.arm();
    fly(physics, 4, { roll: 1 });
    expect(physics.state.position.x).toBeCloseTo(12.6, 6);
    expect(physics.state.position.y).toBe(20);
    expect(physics.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(physics.state.crashed).toBe(true);
    expect(physics.state.armed).toBe(false);
    expect(physics.crashReason).toBe('building');
    const crashedPosition = { ...physics.state.position };
    physics.arm();
    fly(physics, 2, { throttle: 1, roll: -1 });
    expect(physics.state.position).toEqual(crashedPosition);
    expect(physics.state.armed).toBe(false);
  });

  it('detects a facade crossed entirely within one physics substep', () => {
    const physics = new DronePhysics();
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.state.position = { x: 0, y: 20, z: -96 };
    physics.state.velocity.x = 10000;
    physics.arm();
    physics.step(ZERO_CONTROLS, 1 / 120);
    expect(physics.state.crashed).toBe(true);
    expect(physics.crashReason).toBe('building');
    expect(physics.state.position.x).toBeCloseTo(12.6, 6);
    expect(physics.state.distance).toBeCloseTo(12.6, 6);
  });

  it('allows flight over the tallest tower with clearance', () => {
    const physics = new DronePhysics();
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.state.position = { x: -120, y: 239, z: -160 };
    physics.arm();
    fly(physics, 5, { roll: 1 });
    expect(physics.state.position.x).toBeGreaterThan(-70);
    expect(physics.state.position.y).toBe(239);
    expect(physics.state.crashed).toBe(false);
    expect(physics.crashReason).toBeNull();
  });

  it('keeps the city avenues open for flight at street height', () => {
    const physics = new DronePhysics();
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.state.position.y = 8;
    physics.arm();
    fly(physics, 15, { pitch: 1 });
    expect(physics.state.position.z).toBeLessThan(-170);
    expect(physics.state.position.x).toBe(0);
    expect(physics.state.crashed).toBe(false);
  });

  it('respects tower setbacks instead of colliding with their lower footprint', () => {
    const physics = new DronePhysics();
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.state.position = { x: 20, y: 160, z: -80 };
    physics.arm();
    fly(physics, 2, { pitch: 1 });
    expect(physics.state.position.z).toBeLessThan(-99);
    expect(physics.state.crashed).toBe(false);
  });

  it('softly lands on a roof when descending from above', () => {
    const physics = new DronePhysics();
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.state.position = { x: 32, y: 193, z: -96 };
    physics.arm();
    fly(physics, 2, { throttle: -1 });
    expect(physics.state.position.y).toBeCloseTo(191.35, 6);
    expect(physics.state.crashed).toBe(false);
    expect(physics.state.armed).toBe(true);
    expect(physics.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(physics.crashReason).toBeNull();
    expect(physics.state.surface).toBe('rooftop');
    expect(physics.state.surfaceHeight).toBe(191);
    expect(physics.state.landingCount).toBe(1);
    expect(physics.lastLanding?.surface).toBe('rooftop');
  });

  it.each([
    ['ground', SAFE_LANDING_VERTICAL_SPEED, SAFE_LANDING_HORIZONTAL_SPEED, false],
    ['ground', SAFE_LANDING_VERTICAL_SPEED + 0.01, 0, true],
    ['ground', 1, SAFE_LANDING_HORIZONTAL_SPEED + 0.01, true],
    ['rooftop', SAFE_LANDING_VERTICAL_SPEED, SAFE_LANDING_HORIZONTAL_SPEED, false],
    ['rooftop', SAFE_LANDING_VERTICAL_SPEED + 0.01, 0, true],
    ['rooftop', 1, SAFE_LANDING_HORIZONTAL_SPEED + 0.01, true],
  ] as const)('checks %s landing limits at vertical %s and horizontal %s m/s', (surface, verticalSpeed, horizontalSpeed, crashed) => {
    const physics = new DronePhysics();
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.mode = 'sport';
    physics.state.position = surface === 'ground'
      ? { x: 0, y: GROUND_HEIGHT + 0.0001, z: 0 }
      : { x: 32, y: 191.3501, z: -96 };
    physics.state.velocity = { x: horizontalSpeed, y: -verticalSpeed, z: 0 };
    physics.arm();
    physics.step({ ...ZERO_CONTROLS, throttle: -verticalSpeed / 5, roll: horizontalSpeed / 24 }, 0.001);
    expect(physics.state.crashed).toBe(crashed);
    expect(physics.state.surface).toBe(surface);
    expect(physics.state.landingCount).toBe(crashed ? 0 : 1);
    expect(physics.crashReason).toBe(crashed ? surface : null);
    if (!crashed) {
      expect(physics.lastLanding?.verticalSpeed).toBeCloseTo(verticalSpeed, 8);
      expect(physics.lastLanding?.horizontalSpeed).toBeCloseTo(horizontalSpeed, 8);
    }
  });

  it('lands from a grounded coordinate after a directly changed airborne state', () => {
    const physics = airborneDrone();
    physics.state.position.y = GROUND_HEIGHT;
    physics.state.velocity = { x: 0, y: 0, z: 0 };
    physics.step(ZERO_CONTROLS, 1 / 120);
    expect(physics.state.position).toEqual({ x: 0, y: GROUND_HEIGHT, z: 0 });
    expect(physics.state.surface).toBe('ground');
    expect(physics.state.landingCount).toBe(1);
  });

  it('uses the selected map limits and retains map, wind, and mode after reset', () => {
    const physics = new DronePhysics();
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.mode = 'sport';
    physics.arm();
    fly(physics, 40, { throttle: 1, pitch: 1 });
    expect(physics.state.position.y).toBe(FLIGHT_MAPS.nyc.maxAltitude);
    expect(Math.hypot(physics.state.position.x, physics.state.position.z)).toBeCloseTo(FLIGHT_MAPS.nyc.radius, 6);
    expect(physics.state.crashed).toBe(false);
    physics.wind = true;
    physics.reset();
    expect(physics.flightMap).toBe(FLIGHT_MAPS.nyc);
    expect(physics.mode).toBe('sport');
    expect(physics.wind).toBe(true);
    expect(physics.state.position).toEqual({ x: 0, y: GROUND_HEIGHT, z: 0 });
    expect(physics.state.armed).toBe(false);
  });

  it('clears flight telemetry and collision state when switching maps', () => {
    const physics = new DronePhysics();
    expect(physics.flightMap).toBe(FLIGHT_MAPS['pine-valley']);
    physics.setMap(FLIGHT_MAPS.nyc);
    physics.state.position = { x: 0, y: 20, z: -96 };
    physics.arm();
    fly(physics, 4, { roll: 1 });
    expect(physics.crashReason).toBe('building');
    expect(physics.state.distance).toBeGreaterThan(0);
    physics.setMap(FLIGHT_MAPS['pine-valley']);
    expect(physics.flightMap).toBe(FLIGHT_MAPS['pine-valley']);
    expect(physics.state.position).toEqual({ x: 0, y: GROUND_HEIGHT, z: 0 });
    expect(physics.state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(physics.state.crashed).toBe(false);
    expect(physics.crashReason).toBeNull();
    expect(physics.state.armed).toBe(false);
    expect(physics.state.time).toBe(0);
    expect(physics.state.distance).toBe(0);
    expect(physics.state.maxSpeed).toBe(0);
    expect(physics.state.battery).toBe(100);
  });
});
