import { RL_ACTION_COUNT, RL_CONTROL_SECONDS, RL_DIRECTIONS, RL_DRONE_FEATURES, RL_GRID_CHANNELS, RL_GRID_SIZE,
  RL_HOVER_ACTION, RL_MAX_DRONES, RL_OBSERVATION_SIZE, RL_RETURN_ACTION, RL_SPEED_FRACTIONS, RL_STANDBY_ACTION } from './patrol-rl-contract';

export const SHARED_ACTOR_FEATURE_SIZE = 68;

const DRONE_OFFSET = RL_GRID_SIZE ** 2 * RL_GRID_CHANNELS;
const GLOBAL_OFFSET = DRONE_OFFSET + RL_MAX_DRONES * RL_DRONE_FEATURES;
const MINIMUM_SCALE = 1e-6;
const EGO_INDICES = [0, 3, 4, 5, 6, 7, 8, 9, 10, 13];
const GLOBAL_INDICES = Array.from({ length: 18 }, (_, index) => index).filter(index => index !== 10 && index !== 11);

interface Position {
  x: number;
  z: number;
}

interface RasterCell extends Position {
  valid: boolean;
  statistics: number[];
}

interface Peer {
  features: Float32Array;
  position: Position;
  destination: Position;
  active: boolean;
}

function radialWeight(distanceSquared: number, radiusSquared: number): number {
  const denominator = 1 + distanceSquared / radiusSquared;
  return 1 / (denominator * denominator);
}

function mapStatistics(position: Position, raster: readonly RasterCell[], radiusSquared: number): Float64Array {
  const statistics = new Float64Array(14);
  const allWeights = [0, 0];
  const validWeights = [0, 0];
  for (const cell of raster) {
    const distanceSquared = (cell.x - position.x) ** 2 + (cell.z - position.z) ** 2;
    const weights = [radialWeight(distanceSquared, radiusSquared), radialWeight(distanceSquared, radiusSquared * 9)];
    for (let scale = 0; scale < 2; scale += 1) {
      const weight = weights[scale];
      allWeights[scale] += weight;
      if (!cell.valid) continue;
      validWeights[scale] += weight;
      for (let feature = 0; feature < 6; feature += 1) statistics[scale * 7 + feature] += weight * cell.statistics[feature];
    }
  }
  for (let scale = 0; scale < 2; scale += 1) {
    for (let feature = 0; feature < 6; feature += 1) {
      statistics[scale * 7 + feature] = validWeights[scale] ? statistics[scale * 7 + feature] / validWeights[scale] : 0;
    }
    statistics[scale * 7 + 6] = allWeights[scale] ? validWeights[scale] / allWeights[scale] : 0;
  }
  return statistics;
}

function comparePeers(first: Peer, second: Peer): number {
  for (let feature = 0; feature < RL_DRONE_FEATURES; feature += 1) {
    if (first.features[feature] !== second.features[feature]) return first.features[feature] - second.features[feature];
  }
  return 0;
}

function peerStatistics(position: Position, peers: readonly Peer[], radiusSquared: number, diagonal: number): number[] {
  let positionWeight = 0;
  let destinationWeight = 0;
  let activePositionWeight = 0;
  let activeDestinationWeight = 0;
  let activeCount = 0;
  let nearestActiveDistance = Infinity;
  for (const peer of peers) {
    const distanceSquared = (peer.position.x - position.x) ** 2 + (peer.position.z - position.z) ** 2;
    const currentWeight = radialWeight(distanceSquared, radiusSquared);
    const targetWeight = radialWeight((peer.destination.x - position.x) ** 2 + (peer.destination.z - position.z) ** 2, radiusSquared);
    positionWeight += currentWeight;
    destinationWeight += targetWeight;
    if (!peer.active) continue;
    activeCount += 1;
    activePositionWeight += currentWeight;
    activeDestinationWeight += targetWeight;
    nearestActiveDistance = Math.min(nearestActiveDistance, Math.hypot(peer.position.x - position.x, peer.position.z - position.z));
  }
  return [peers.length ? positionWeight / peers.length : 0, peers.length ? destinationWeight / peers.length : 0,
    activeCount ? activePositionWeight / activeCount : 0, activeCount ? activeDestinationWeight / activeCount : 0,
    activeCount ? Math.min(1, nearestActiveDistance / diagonal) : 1, activeCount / (RL_MAX_DRONES - 1)];
}

export function sharedActorFeatures(observation: readonly number[] | Float32Array): Float32Array {
  if (!(Array.isArray(observation) || observation instanceof Float32Array) || observation.length !== RL_OBSERVATION_SIZE) {
    throw new Error('Invalid shared actor observation length or type');
  }
  const canonical = new Float32Array(RL_OBSERVATION_SIZE);
  for (let index = 0; index < RL_OBSERVATION_SIZE; index += 1) {
    if (typeof observation[index] !== 'number' || !Number.isFinite(observation[index]) || !Number.isFinite(Math.fround(observation[index]))) {
      throw new Error('Invalid shared actor observation value');
    }
    canonical[index] = observation[index];
  }
  const result = new Float32Array(RL_MAX_DRONES * RL_ACTION_COUNT * SHARED_ACTOR_FEATURE_SIZE);
  const width = Math.max(MINIMUM_SCALE, canonical[GLOBAL_OFFSET] * 640);
  const depth = Math.max(MINIMUM_SCALE, canonical[GLOBAL_OFFSET + 1] * 640);
  const maxSpeed = Math.max(MINIMUM_SCALE, canonical[GLOBAL_OFFSET + 3] * 30);
  const radius = Math.max(MINIMUM_SCALE, canonical[GLOBAL_OFFSET + 4] * 64);
  const radiusSquared = radius * radius;
  const diagonal = Math.max(MINIMUM_SCALE, Math.hypot(width, depth));
  const depot = { x: canonical[GLOBAL_OFFSET + 10] * width / 2, z: canonical[GLOBAL_OFFSET + 11] * depth / 2 };
  const globalFeatures = GLOBAL_INDICES.map(index => canonical[GLOBAL_OFFSET + index]);
  const raster = Array.from({ length: RL_GRID_SIZE ** 2 }, (_, index): RasterCell => {
    const offset = index * RL_GRID_CHANNELS;
    const population = canonical[offset + 1];
    const localAge = canonical[offset + 2];
    const globalAge = canonical[offset + 3];
    return { x: ((index % RL_GRID_SIZE + 0.5) / RL_GRID_SIZE - 0.5) * width,
      z: ((Math.floor(index / RL_GRID_SIZE) + 0.5) / RL_GRID_SIZE - 0.5) * depth,
      valid: canonical[offset] > 0,
      statistics: [population, localAge, globalAge, canonical[offset + 4], population * localAge, population * globalAge] };
  });
  const drones = Array.from({ length: RL_MAX_DRONES }, (_, slot): Peer => {
    const features = canonical.subarray(DRONE_OFFSET + slot * RL_DRONE_FEATURES, DRONE_OFFSET + (slot + 1) * RL_DRONE_FEATURES);
    return { features, position: { x: features[1] * width / 2, z: features[2] * depth / 2 },
      destination: { x: features[11] * width / 2, z: features[12] * depth / 2 }, active: features[5] > 0 && features[13] > 0 };
  });
  for (let slot = 0; slot < RL_MAX_DRONES; slot += 1) {
    const drone = drones[slot];
    if (drone.features[0] <= 0) continue;
    const peers = drones.filter((peer, index) => index !== slot && peer.features[0] > 0).sort(comparePeers);
    const egoFeatures = EGO_INDICES.map(index => drone.features[index]);
    const currentStatistics = mapStatistics(drone.position, raster, radiusSquared);
    const currentDepotDistance = Math.hypot(drone.position.x - depot.x, drone.position.z - depot.z);
    for (let action = 0; action < RL_ACTION_COUNT; action += 1) {
      const moving = action < RL_HOVER_ACTION;
      const hovering = action === RL_HOVER_ACTION;
      const returning = action === RL_RETURN_ACTION;
      const standingBy = action === RL_STANDBY_ACTION;
      const speedFraction = moving ? RL_SPEED_FRACTIONS[action % RL_SPEED_FRACTIONS.length] : returning ? 1 : 0;
      const direction = moving ? RL_DIRECTIONS[Math.floor(action / RL_SPEED_FRACTIONS.length)] : null;
      const distance = maxSpeed * speedFraction * RL_CONTROL_SECONDS;
      const target = returning ? depot : direction ? { x: drone.position.x + direction.x * distance,
        z: drone.position.z + direction.z * distance } : drone.position;
      const targetDepotDistance = Math.hypot(target.x - depot.x, target.z - depot.z);
      const targetStatistics = moving ? mapStatistics(target, raster, radiusSquared) : hovering ? currentStatistics : new Float64Array(14);
      const offset = (slot * RL_ACTION_COUNT + action) * SHARED_ACTOR_FEATURE_SIZE;
      result.set(egoFeatures, offset);
      result.set(globalFeatures, offset + 10);
      result.set([Number(moving), Number(hovering), Number(returning), Number(standingBy), speedFraction,
        Math.hypot(target.x - drone.position.x, target.z - drone.position.z) / diagonal,
        targetDepotDistance / diagonal, (targetDepotDistance - currentDepotDistance) / diagonal], offset + 26);
      for (let scale = 0; scale < 2; scale += 1) {
        for (let feature = 0; feature < 7; feature += 1) {
          result[offset + 34 + scale * 14 + feature] = targetStatistics[scale * 7 + feature];
          result[offset + 41 + scale * 14 + feature] = targetStatistics[scale * 7 + feature] - currentStatistics[scale * 7 + feature];
        }
      }
      result.set(peerStatistics(target, peers, radiusSquared, diagonal), offset + 62);
    }
  }
  if (!result.every(Number.isFinite)) throw new Error('Non-finite shared actor features');
  return result;
}
