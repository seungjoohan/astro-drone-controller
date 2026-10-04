import { describe, expect, it, vi } from 'vitest';
import { FLIGHT_MAPS } from './maps';
import { GATES, MAX_ALTITUDE, WORLD_RADIUS } from './world';

describe('flight maps', () => {
  it('keeps the original training ground and course available', () => {
    const valley = FLIGHT_MAPS['pine-valley'];
    expect(valley.id).toBe('pine-valley');
    expect(valley.gates).toEqual(GATES);
    expect(valley.radius).toBe(WORLD_RADIUS);
    expect(valley.maxAltitude).toBe(MAX_ALTITUDE);
    expect(valley.buildings).toEqual([]);
  });

  it('generates the same dense city on every load', async () => {
    const originalBuildings = FLIGHT_MAPS.nyc.buildings;
    vi.resetModules();
    const reloadedMaps = await import('./maps');
    expect(reloadedMaps.FLIGHT_MAPS.nyc.buildings).toEqual(originalBuildings);
    expect(originalBuildings.length).toBeGreaterThan(200);
    expect(new Set(originalBuildings.map(building => `${building.x},${building.z}`)).size).toBe(originalBuildings.length);
    expect(originalBuildings.filter(building => building.tiers.some(tier => tier.base + tier.height >= 80)).length).toBeGreaterThan(40);
  });

  it('leaves flight room above its tallest skyscraper', () => {
    const city = FLIGHT_MAPS.nyc;
    const rooftops = city.buildings.flatMap(building => building.tiers.map(tier => tier.base + tier.height));
    expect(Math.max(...rooftops)).toBe(238);
    expect(city.maxAltitude).toBe(300);
    expect(Math.max(...rooftops)).toBeLessThan(city.maxAltitude - 40);
    expect(city.buildings.some(building => building.style === 'landmark')).toBe(true);
  });

  it('keeps the launch column clear of every building tier', () => {
    for (const building of FLIGHT_MAPS.nyc.buildings) {
      for (const tier of building.tiers) {
        const clearanceX = Math.max(Math.abs(building.x) - tier.width / 2, 0);
        const clearanceZ = Math.max(Math.abs(building.z) - tier.depth / 2, 0);
        expect(Math.hypot(clearanceX, clearanceZ)).toBeGreaterThan(5);
      }
    }
  });

  it('places every complete gate opening clear of buildings and within flight bounds', () => {
    const city = FLIGHT_MAPS.nyc;
    expect(city.gates).toHaveLength(6);
    for (const gate of city.gates) {
      expect(gate.position.y - gate.radius).toBeGreaterThan(0);
      expect(gate.position.y + gate.radius).toBeLessThan(city.maxAltitude);
      expect(Math.hypot(gate.position.x, gate.position.z) + gate.radius).toBeLessThan(city.radius);
      for (const building of city.buildings) {
        for (const tier of building.tiers) {
          const clearanceX = Math.max(Math.abs(gate.position.x - building.x) - tier.width / 2, 0);
          const clearanceY = Math.max(tier.base - gate.position.y, gate.position.y - tier.base - tier.height, 0);
          const clearanceZ = Math.max(Math.abs(gate.position.z - building.z) - tier.depth / 2, 0);
          expect(Math.hypot(clearanceX, clearanceY, clearanceZ)).toBeGreaterThan(gate.radius + 0.5);
        }
      }
    }
  });
});
