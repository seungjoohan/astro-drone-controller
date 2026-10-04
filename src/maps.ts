import type { Gate } from './types';
import { GATES, MAX_ALTITUDE, WORLD_RADIUS } from './world';

export type MapId = 'pine-valley' | 'nyc';
export type BuildingStyle = 'brick' | 'stone' | 'glass' | 'landmark';

export interface BuildingTier {
  width: number;
  depth: number;
  height: number;
  base: number;
}

export interface CityBuilding {
  x: number;
  z: number;
  style: BuildingStyle;
  variant: number;
  tiers: BuildingTier[];
}

export interface FlightMap {
  id: MapId;
  name: string;
  subtitle: string;
  radius: number;
  maxAltitude: number;
  gates: Gate[];
  buildings: CityBuilding[];
}

export const CITY_BLOCK_SIZE = 64;
export const CITY_PARK = { x: -32, z: 32, width: 44, depth: 44 };

function createCityBuildings(): CityBuilding[] {
  let seed = 4077;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const buildings: CityBuilding[] = [];
  for (let column = -4; column < 4; column += 1) {
    for (let row = -4; row < 4; row += 1) {
      const centerX = (column + 0.5) * CITY_BLOCK_SIZE;
      const centerZ = (row + 0.5) * CITY_BLOCK_SIZE;
      if (centerX === CITY_PARK.x && centerZ === CITY_PARK.z) continue;
      if (column === 0 && row === -2) {
        buildings.push({ x: centerX, z: centerZ, style: 'landmark', variant: 0, tiers: [
          { width: 38, depth: 38, base: 0, height: 72 },
          { width: 28, depth: 28, base: 72, height: 42 },
          { width: 19, depth: 19, base: 114, height: 32 },
          { width: 11, depth: 11, base: 146, height: 20 },
          { width: 3, depth: 3, base: 166, height: 25 },
        ] });
        continue;
      }
      if (column === -2 && row === -3) {
        buildings.push({ x: centerX, z: centerZ, style: 'glass', variant: 3, tiers: [
          { width: 35, depth: 35, base: 0, height: 132 },
          { width: 28, depth: 28, base: 132, height: 52 },
          { width: 19, depth: 19, base: 184, height: 30 },
          { width: 2, depth: 2, base: 214, height: 24 },
        ] });
        continue;
      }
      for (const horizontal of [-1, 1]) {
        for (const depth of [-1, 1]) {
          const variant = Math.floor(random() * 5);
          const style: BuildingStyle = random() > 0.57 ? 'glass' : random() > 0.48 ? 'stone' : 'brick';
          const height = style === 'glass' ? 65 + random() * 83 : 15 + random() * 46;
          const width = 16 + random() * 4;
          const length = 16 + random() * 4;
          const tiers: BuildingTier[] = [{ width, depth: length, base: 0, height }];
          if (height > 80) tiers.push({ width: width * 0.68, depth: length * 0.68, base: height, height: 9 + random() * 12 });
          buildings.push({ x: centerX + horizontal * 11, z: centerZ + depth * 11, style, variant, tiers });
        }
      }
    }
  }
  return buildings;
}

export const FLIGHT_MAPS: Record<MapId, FlightMap> = {
  'pine-valley': {
    id: 'pine-valley', name: 'Pine Valley', subtitle: 'OPEN TRAINING GROUND / 01',
    radius: WORLD_RADIUS, maxAltitude: MAX_ALTITUDE, gates: GATES, buildings: [],
  },
  nyc: {
    id: 'nyc', name: 'Midtown NYC', subtitle: 'NYC-INSPIRED CITY / 02',
    radius: 320, maxAltitude: 300, buildings: createCityBuildings(),
    gates: [
      { position: { x: 0, y: 10, z: -48 }, yaw: 0, radius: 5 },
      { position: { x: 0, y: 24, z: -112 }, yaw: 0, radius: 5 },
      { position: { x: 64, y: 44, z: -128 }, yaw: Math.PI / 2, radius: 5 },
      { position: { x: 128, y: 64, z: -64 }, yaw: 0, radius: 5 },
      { position: { x: 64, y: 34, z: 0 }, yaw: Math.PI / 2, radius: 5 },
      { position: { x: 0, y: 12, z: 32 }, yaw: 0, radius: 5 },
    ],
  },
};
