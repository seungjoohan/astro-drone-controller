import { RL_ACTION_COUNT, RL_CONTROL_SECONDS, RL_DIRECTIONS, RL_DRONE_FEATURES, RL_GRID_CHANNELS,
  RL_GRID_SIZE, RL_HOVER_ACTION, RL_MAX_DRONES, RL_RETURN_ACTION, RL_SPEED_FRACTIONS,
  RL_STANDBY_ACTION } from './patrol-rl-contract';
import { SHARED_ACTOR_FEATURE_SIZE, sharedActorFeatures } from './patrol-rl-shared-features';

export const COORDINATED_ACTOR_FEATURE_SIZE = 80;

const DRONE_OFFSET = RL_GRID_SIZE ** 2 * RL_GRID_CHANNELS;
const GLOBAL_OFFSET = DRONE_OFFSET + RL_MAX_DRONES * RL_DRONE_FEATURES;
const MINIMUM_SCALE = 1e-6;
const PEER_SCALE = RL_MAX_DRONES - 1;

interface Position {
  x: number;
  z: number;
}

interface Drone {
  features: Float32Array;
  position: Position;
  present: boolean;
  available: boolean;
}

interface Intent {
  endpoint: Position;
  midpoint: Position;
}

export interface CoordinatedActorContext {
  order: readonly number[];
  features: (slot: number, actionsBySlot: readonly number[]) => Float32Array;
}

function validAction(action: number): boolean {
  return Number.isInteger(action) && action >= 0 && action < RL_ACTION_COUNT;
}

function diskOverlap(distance: number, radius: number): number {
  const ratio = distance / (2 * radius);
  if (ratio >= 1) return 0;
  return Math.max(0, Math.min(1, 2 * (Math.acos(ratio) - ratio * Math.sqrt(1 - ratio * ratio)) / Math.PI));
}

function distance(first: Position, second: Position): number {
  return Math.hypot(first.x - second.x, first.z - second.z);
}

export function createCoordinatedActorContext(observation: readonly number[] | Float32Array): CoordinatedActorContext {
  const base = sharedActorFeatures(observation);
  const canonical = new Float32Array(observation);
  const width = Math.max(MINIMUM_SCALE, canonical[GLOBAL_OFFSET] * 640);
  const depth = Math.max(MINIMUM_SCALE, canonical[GLOBAL_OFFSET + 1] * 640);
  const speed = Math.max(MINIMUM_SCALE, canonical[GLOBAL_OFFSET + 3] * 30);
  const radius = Math.max(MINIMUM_SCALE, canonical[GLOBAL_OFFSET + 4] * 64);
  const diagonal = Math.max(MINIMUM_SCALE, Math.hypot(width, depth));
  const drones = Array.from({ length: RL_MAX_DRONES }, (_, slot): Drone => {
    const features = canonical.subarray(DRONE_OFFSET + slot * RL_DRONE_FEATURES, DRONE_OFFSET + (slot + 1) * RL_DRONE_FEATURES);
    const present = features[0] > 0;
    return { features, present, available: present && features[10] <= 0 && features[13] > 0,
      position: { x: features[1] * width / 2, z: features[2] * depth / 2 } };
  });
  const order = Object.freeze(Array.from({ length: RL_MAX_DRONES }, (_, slot) => slot).sort((first, second) => {
    const firstDrone = drones[first];
    const secondDrone = drones[second];
    if (firstDrone.present !== secondDrone.present) return firstDrone.present ? -1 : 1;
    if (firstDrone.present) {
      for (let feature = 0; feature < RL_DRONE_FEATURES; feature += 1) {
        if (firstDrone.features[feature] !== secondDrone.features[feature]) return firstDrone.features[feature] - secondDrone.features[feature];
      }
    }
    return first - second;
  }));
  const intent = (drone: Drone, action: number): Intent => {
    const direction = action < RL_HOVER_ACTION ? RL_DIRECTIONS[Math.floor(action / RL_SPEED_FRACTIONS.length)] : undefined;
    const travel = direction ? speed * RL_SPEED_FRACTIONS[action % RL_SPEED_FRACTIONS.length] * RL_CONTROL_SECONDS : 0;
    const endpoint = direction ? { x: drone.position.x + direction.x * travel, z: drone.position.z + direction.z * travel } : drone.position;
    return { endpoint, midpoint: { x: (drone.position.x + endpoint.x) / 2, z: (drone.position.z + endpoint.z) / 2 } };
  };
  const features = (slot: number, actionsBySlot: readonly number[]): Float32Array => {
    if (!Number.isInteger(slot) || slot < 0 || slot >= RL_MAX_DRONES) throw new Error('Invalid coordinated actor slot');
    if (!Array.isArray(actionsBySlot) || actionsBySlot.length !== RL_MAX_DRONES) throw new Error('Invalid coordinated actor actions');
    const rank = order.indexOf(slot);
    const earlier = order.slice(0, rank);
    if (!earlier.every(previous => validAction(actionsBySlot[previous]))) throw new Error('Invalid coordinated actor prefix action');
    const result = new Float32Array(RL_ACTION_COUNT * COORDINATED_ACTOR_FEATURE_SIZE);
    const drone = drones[slot];
    if (!drone.present) return result;
    const controllable = earlier.filter(previous => drones[previous].available);
    const sensing = controllable.filter(previous => actionsBySlot[previous] <= RL_HOVER_ACTION)
      .map(previous => intent(drones[previous], actionsBySlot[previous]));
    const context = [controllable.length / PEER_SCALE,
      order.slice(rank + 1).filter(following => drones[following].available).length / PEER_SCALE,
      sensing.length / PEER_SCALE,
      controllable.filter(previous => actionsBySlot[previous] === RL_RETURN_ACTION).length / PEER_SCALE,
      controllable.filter(previous => actionsBySlot[previous] === RL_STANDBY_ACTION).length / PEER_SCALE,
      drones.filter((peer, peerSlot) => peerSlot !== slot && peer.present
        && (peer.features[6] > 0 || peer.features[7] > 0 || peer.features[8] > 0)).length / PEER_SCALE];
    for (let action = 0; action < RL_ACTION_COUNT; action += 1) {
      const offset = action * COORDINATED_ACTOR_FEATURE_SIZE;
      const baseOffset = (slot * RL_ACTION_COUNT + action) * SHARED_ACTOR_FEATURE_SIZE;
      result.set(base.subarray(baseOffset, baseOffset + SHARED_ACTOR_FEATURE_SIZE), offset);
      result.set(context, offset + SHARED_ACTOR_FEATURE_SIZE);
      let endpointSum = 0;
      let endpointMaximum = 0;
      let midpointSum = 0;
      let midpointMaximum = 0;
      let nearestEndpoint = 1;
      let nearestMidpoint = 1;
      if (drone.available && action <= RL_HOVER_ACTION) {
        const candidate = intent(drone, action);
        for (const previous of sensing) {
          const endpointDistance = distance(candidate.endpoint, previous.endpoint);
          const midpointDistance = distance(candidate.midpoint, previous.midpoint);
          const endpointOverlap = diskOverlap(endpointDistance, radius);
          const midpointOverlap = diskOverlap(midpointDistance, radius);
          endpointSum += endpointOverlap;
          endpointMaximum = Math.max(endpointMaximum, endpointOverlap);
          midpointSum += midpointOverlap;
          midpointMaximum = Math.max(midpointMaximum, midpointOverlap);
          nearestEndpoint = Math.min(nearestEndpoint, endpointDistance / diagonal);
          nearestMidpoint = Math.min(nearestMidpoint, midpointDistance / diagonal);
        }
      }
      result.set([endpointSum / PEER_SCALE, endpointMaximum, midpointSum / PEER_SCALE, midpointMaximum,
        nearestEndpoint, nearestMidpoint], offset + SHARED_ACTOR_FEATURE_SIZE + context.length);
    }
    if (!result.every(Number.isFinite)) throw new Error('Non-finite coordinated actor features');
    return result;
  };
  return Object.freeze({ order, features });
}

export function coordinatedActorFeatures(observation: readonly number[] | Float32Array, recordedActions: readonly number[]): Float32Array {
  if (!Array.isArray(recordedActions) || recordedActions.length !== RL_MAX_DRONES
    || !Array.from(recordedActions).every(validAction)) throw new Error('Invalid coordinated actor recorded actions');
  const context = createCoordinatedActorContext(observation);
  const result = new Float32Array(RL_MAX_DRONES * RL_ACTION_COUNT * COORDINATED_ACTOR_FEATURE_SIZE);
  for (const slot of context.order) result.set(context.features(slot, recordedActions), slot * RL_ACTION_COUNT * COORDINATED_ACTOR_FEATURE_SIZE);
  return result;
}
