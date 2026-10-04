import { FLIGHT_MAPS } from './maps';
import type { BuildingTier, CityBuilding, FlightMap } from './maps';
import type { FlightControls, FlightMode, FlightState, Vec3 } from './types';
import { GROUND_HEIGHT } from './world';

const MAX_FRAME_DELTA = 0.1;
const MAX_STEP = 1 / 120;
const BATTERY_SECONDS = 8 * 60;
const DRONE_RADIUS = 0.4;
const DRONE_HALF_HEIGHT = 0.35;
const CONTACT_EPSILON = 1e-8;

export const SAFE_LANDING_VERTICAL_SPEED = 3;
export const SAFE_LANDING_HORIZONTAL_SPEED = 2;

interface BuildingImpact {
  time: number;
  rooftop: boolean;
  height: number;
}

interface Landing {
  surface: 'ground' | 'rooftop';
  verticalSpeed: number;
  horizontalSpeed: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function input(value: number): number {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

function approach(current: number, target: number, response: number, delta: number): number {
  return target + (current - target) * Math.exp(-response * delta);
}

function boxImpact(start: Vec3, end: Vec3, minimum: Vec3, maximum: Vec3): number | null {
  let entry = -Infinity;
  let exit = Infinity;
  for (const axis of ['x', 'y', 'z'] as const) {
    const travel = end[axis] - start[axis];
    if (Math.abs(travel) < 1e-12) {
      if (start[axis] < minimum[axis] || start[axis] > maximum[axis]) return null;
      continue;
    }
    const near = (minimum[axis] - start[axis]) / travel;
    const far = (maximum[axis] - start[axis]) / travel;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
    if (entry > exit) return null;
  }
  if (entry > 1 || exit < 0 || (entry < 0 && exit <= CONTACT_EPSILON)) return null;
  return Math.max(0, entry);
}

function fitsRooftop(position: Vec3, building: CityBuilding, tier: BuildingTier): boolean {
  return Math.abs(position.x - building.x) + DRONE_RADIUS <= tier.width / 2 + CONTACT_EPSILON
    && Math.abs(position.z - building.z) + DRONE_RADIUS <= tier.depth / 2 + CONTACT_EPSILON;
}

function buildingImpact(start: Vec3, end: Vec3, buildings: CityBuilding[]): BuildingImpact | null {
  let firstImpact: BuildingImpact | null = null;
  for (const building of buildings) {
    for (const tier of building.tiers) {
      const height = tier.base + tier.height;
      const impact = boxImpact(start, end, {
        x: building.x - tier.width / 2 - DRONE_RADIUS,
        y: tier.base - DRONE_HALF_HEIGHT,
        z: building.z - tier.depth / 2 - DRONE_RADIUS,
      }, {
        x: building.x + tier.width / 2 + DRONE_RADIUS,
        y: height + DRONE_HALF_HEIGHT,
        z: building.z + tier.depth / 2 + DRONE_RADIUS,
      });
      if (impact === null) continue;
      const position = {
        x: start.x + (end.x - start.x) * impact,
        y: start.y + (end.y - start.y) * impact,
        z: start.z + (end.z - start.z) * impact,
      };
      const rooftop = end.y < start.y && start.y >= height + DRONE_HALF_HEIGHT - CONTACT_EPSILON
        && Math.abs(position.y - height - DRONE_HALF_HEIGHT) <= CONTACT_EPSILON
        && fitsRooftop(position, building, tier);
      if (firstImpact === null || impact < firstImpact.time - CONTACT_EPSILON
        || (Math.abs(impact - firstImpact.time) <= CONTACT_EPSILON && !rooftop)) {
        firstImpact = { time: impact, rooftop, height };
      }
    }
  }
  return firstImpact;
}

function initialState(): FlightState {
  return {
    position: { x: 0, y: GROUND_HEIGHT, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    armed: false,
    crashed: false,
    surface: 'ground',
    surfaceHeight: 0,
    landingCount: 0,
    time: 0,
    distance: 0,
    maxSpeed: 0,
    battery: 100,
  };
}

export class DronePhysics {
  state: FlightState = initialState();
  flightMap: FlightMap = FLIGHT_MAPS['pine-valley'];
  mode: FlightMode = 'assisted';
  wind = false;
  crashReason: 'ground' | 'building' | 'rooftop' | null = null;
  lastLanding: Landing | null = null;

  setMap(map: FlightMap): void {
    this.flightMap = map;
    this.reset();
  }

  reset(): void {
    this.state = initialState();
    this.crashReason = null;
    this.lastLanding = null;
  }

  arm(): void {
    if (!this.state.crashed && this.state.battery > 0) {
      this.state.armed = true;
    }
  }

  disarm(): void {
    this.state.armed = false;
  }

  step(controls: FlightControls, delta: number): void {
    if (!Number.isFinite(delta) || delta <= 0 || this.state.crashed) return;

    const frameDelta = Math.min(delta, MAX_FRAME_DELTA);
    const stepCount = Math.ceil(frameDelta / MAX_STEP);
    const stepDelta = frameDelta / stepCount;
    const normalizedControls: FlightControls = {
      throttle: input(controls.throttle),
      yaw: input(controls.yaw),
      pitch: input(controls.pitch),
      roll: input(controls.roll),
    };

    for (let stepIndex = 0; stepIndex < stepCount; stepIndex += 1) {
      this.integrate(normalizedControls, stepDelta);
      if (this.state.crashed) break;
    }
  }

  private integrate(controls: FlightControls, delta: number): void {
    const state = this.state;
    const supported = this.hasSupport();
    if (!supported) {
      state.surface = null;
      state.surfaceHeight = 0;
    }
    const sport = this.mode === 'sport';
    const previousPosition = { ...state.position };

    if (state.armed || !supported) state.time += delta;

    if (state.armed) {
      state.battery = Math.max(0, state.battery - (100 * delta) / BATTERY_SECONDS);
      if (state.battery < 1e-8) {
        state.battery = 0;
        this.disarm();
      }
    }

    if (state.armed) {
      const yawRate = sport ? 2.6 : 1.6;
      state.yaw += controls.yaw * yawRate * delta;
      state.yaw = Math.atan2(Math.sin(state.yaw), Math.cos(state.yaw));
    }

    if (supported && (!state.armed || controls.throttle <= 0)) {
      state.velocity = { x: 0, y: 0, z: 0 };
      state.pitch = 0;
      state.roll = 0;
      return;
    }

    state.surface = null;
    state.surfaceHeight = 0;

    if (state.armed) {

      const horizontalInput = Math.hypot(controls.pitch, controls.roll);
      const inputScale = Math.max(1, horizontalInput);
      const horizontalSpeed = sport ? 24 : 12;
      const forwardSpeed = (controls.pitch / inputScale) * horizontalSpeed;
      const sidewaysSpeed = (controls.roll / inputScale) * horizontalSpeed;
      const response = horizontalInput > 0.01 ? (sport ? 1.5 : 2.8) : (sport ? 0.8 : 4.8);
      const windSpeed = this.wind ? 1.8 : 0;
      const windX = windSpeed * Math.sin(state.time * 0.47 + 0.9);
      const windZ = windSpeed * Math.cos(state.time * 0.31);
      const targetX = forwardSpeed * Math.sin(state.yaw) + sidewaysSpeed * Math.cos(state.yaw) + windX;
      const targetZ = -forwardSpeed * Math.cos(state.yaw) + sidewaysSpeed * Math.sin(state.yaw) + windZ;

      state.velocity.x = approach(state.velocity.x, targetX, response, delta);
      state.velocity.z = approach(state.velocity.z, targetZ, response, delta);
      const verticalSpeed = controls.throttle >= 0 ? (sport ? 8 : 5) : (sport ? 5 : 2.4);
      state.velocity.y = approach(state.velocity.y, controls.throttle * verticalSpeed, 8, delta);

      const tilt = sport ? 0.48 : 0.3;
      state.pitch = approach(state.pitch, -controls.pitch * tilt, 7, delta);
      state.roll = approach(state.roll, -controls.roll * tilt, 7, delta);
    } else {
      state.velocity.x *= Math.exp(-0.3 * delta);
      state.velocity.z *= Math.exp(-0.3 * delta);
      state.velocity.y = Math.max(-50, state.velocity.y - 9.81 * delta);
      state.pitch = approach(state.pitch, 0, 3, delta);
      state.roll = approach(state.roll, 0, 3, delta);
    }

    state.position.x += state.velocity.x * delta;
    state.position.y += state.velocity.y * delta;
    state.position.z += state.velocity.z * delta;

    if (state.position.y >= this.flightMap.maxAltitude) {
      state.position.y = this.flightMap.maxAltitude;
      state.velocity.y = Math.min(0, state.velocity.y);
    }

    const radius = Math.hypot(state.position.x, state.position.z);
    if (radius > this.flightMap.radius) {
      const normalX = state.position.x / radius;
      const normalZ = state.position.z / radius;
      state.position.x = normalX * this.flightMap.radius;
      state.position.z = normalZ * this.flightMap.radius;
      const outwardSpeed = Math.max(0, state.velocity.x * normalX + state.velocity.z * normalZ);
      state.velocity.x -= outwardSpeed * normalX;
      state.velocity.z -= outwardSpeed * normalZ;
    }

    const speed = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z);
    state.maxSpeed = Math.max(state.maxSpeed, speed);

    const impact = buildingImpact(previousPosition, state.position, this.flightMap.buildings);
    const groundImpact = state.position.y <= GROUND_HEIGHT
      ? previousPosition.y <= GROUND_HEIGHT ? 0
        : clamp((previousPosition.y - GROUND_HEIGHT) / (previousPosition.y - state.position.y), 0, 1)
      : null;
    if (impact !== null && (groundImpact === null || impact.time <= groundImpact)) {
      for (const axis of ['x', 'y', 'z'] as const) {
        state.position[axis] = previousPosition[axis] + (state.position[axis] - previousPosition[axis]) * impact.time;
      }
      if (impact.rooftop) {
        this.touchDown('rooftop', impact.height);
      } else {
        state.crashed = true;
        this.crashReason = 'building';
        this.disarm();
        state.velocity = { x: 0, y: 0, z: 0 };
      }
    } else if (groundImpact !== null) {
      for (const axis of ['x', 'y', 'z'] as const) {
        state.position[axis] = previousPosition[axis] + (state.position[axis] - previousPosition[axis]) * groundImpact;
      }
      this.touchDown('ground', 0);
    }

    state.distance += Math.hypot(
      state.position.x - previousPosition.x,
      state.position.y - previousPosition.y,
      state.position.z - previousPosition.z,
    );
  }

  private hasSupport(): boolean {
    const state = this.state;
    if (state.velocity.y > 0) return false;
    if (state.surface === 'ground') return Math.abs(state.position.y - GROUND_HEIGHT) <= CONTACT_EPSILON;
    if (state.surface !== 'rooftop'
      || Math.abs(state.position.y - state.surfaceHeight - DRONE_HALF_HEIGHT) > CONTACT_EPSILON) return false;
    return this.flightMap.buildings.some(building => building.tiers.some(tier =>
      Math.abs(tier.base + tier.height - state.surfaceHeight) <= CONTACT_EPSILON
      && fitsRooftop(state.position, building, tier)));
  }

  private touchDown(surface: 'ground' | 'rooftop', height: number): void {
    const state = this.state;
    const verticalSpeed = Math.max(0, -state.velocity.y);
    const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
    state.position.y = surface === 'ground' ? GROUND_HEIGHT : height + DRONE_HALF_HEIGHT;
    state.surface = surface;
    state.surfaceHeight = height;
    if (verticalSpeed > SAFE_LANDING_VERTICAL_SPEED || horizontalSpeed > SAFE_LANDING_HORIZONTAL_SPEED) {
      state.crashed = true;
      this.crashReason = surface;
      this.disarm();
    } else {
      state.landingCount += 1;
      this.lastLanding = { surface, verticalSpeed, horizontalSpeed };
    }
    state.velocity = { x: 0, y: 0, z: 0 };
    state.pitch = 0;
    state.roll = 0;
  }
}
