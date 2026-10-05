import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { PatrolSystem, PATROL_LIMITS } = await server.ssrLoadModule('/src/patrol.ts');
  const radius = 320;
  const sensorRadius = PATROL_LIMITS.sensorRadius;
  const results = [];

  function observationIntervals(point, route) {
    const intervals = [];
    let elapsed = 0;
    for (let index = 0; index < route.length; index += 1) {
      const start = route[index];
      const end = route[(index + 1) % route.length];
      const horizontal = end.x - start.x;
      const depth = end.z - start.z;
      const length = Math.hypot(horizontal, depth);
      const duration = length / PATROL_LIMITS.speed;
      const projection = ((point.x - start.x) * horizontal + (point.z - start.z) * depth) / length;
      const perpendicularSquared = (point.x - start.x) ** 2 + (point.z - start.z) ** 2 - projection ** 2;
      if (perpendicularSquared <= sensorRadius ** 2) {
        const span = Math.sqrt(sensorRadius ** 2 - Math.max(0, perpendicularSquared));
        const begin = Math.max(0, (projection - span) / PATROL_LIMITS.speed);
        const finish = Math.min(duration, (projection + span) / PATROL_LIMITS.speed);
        if (begin <= finish) intervals.push([elapsed + begin, elapsed + finish]);
      }
      elapsed += duration;
    }
    return { period: elapsed, intervals };
  }

  function lastSeen(time, schedule) {
    if (!schedule.intervals.length) return -Infinity;
    const phase = time % schedule.period;
    let latest = schedule.intervals.at(-1)[1] - schedule.period;
    for (const [begin, end] of schedule.intervals) {
      if (begin > phase) break;
      latest = Math.min(phase, end);
    }
    return time - phase + latest;
  }

  for (const fleetSize of [4, 5]) {
    const system = new PatrolSystem({ fleetSize });
    const snapshot = system.snapshot();
    const routes = snapshot.drones.map(drone => drone.route);
    for (const spacing of [40, 10, 5]) {
      const points = [];
      for (let depth = -radius + spacing / 2; depth < radius; depth += spacing) {
        for (let horizontal = -radius + spacing / 2; horizontal < radius; horizontal += spacing) {
          if (Math.hypot(horizontal, depth) <= radius) points.push({ x: horizontal, z: depth });
        }
      }
      const schedules = points.map(point => routes.map(route => observationIntervals(point, route)));
      let minimumCoverage = 100;
      let maximumCoverage = 0;
      let totalCoverage = 0;
      let belowTarget = 0;
      const sampleCount = 1200;
      for (let time = 240; time < 240 + sampleCount; time += 1) {
        let covered = 0;
        for (const pointSchedules of schedules) {
          if (pointSchedules.some(schedule => time - lastSeen(time, schedule) <= 120 + 1e-8)) covered += 1;
        }
        const coverage = covered / points.length * 100;
        minimumCoverage = Math.min(minimumCoverage, coverage);
        maximumCoverage = Math.max(maximumCoverage, coverage);
        totalCoverage += coverage;
        if (coverage < 95) belowTarget += 1;
      }
      results.push({ fleetSize, spacing, pointCount: points.length, minimumCoverage, maximumCoverage, meanCoverage: totalCoverage / sampleCount, belowTargetSeconds: belowTarget, sampleCount, everCovered: 100 * schedules.filter(point => point.some(schedule => schedule.intervals.length)).length / schedules.length, routeCycles: snapshot.drones.map(drone => drone.cycleSeconds) });
    }
  }
  console.log(JSON.stringify(results, null, 2));
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/patrol-fidelity-results.json', JSON.stringify({ method: 'Analytical swept footprints on periodic healthy routes. Spatial midpoint grids within radius320, 1-second evaluation cadence, t240..1439 inclusive, 120-second freshness.', results }, null, 2));
} finally {
  await server.close();
}
