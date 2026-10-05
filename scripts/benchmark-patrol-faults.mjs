import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const stepSeconds = 0.25;
const faultTime = 600;
const horizon = 1800;

function summarize(rows) {
  const metrics = ['area', 'populationOnTime', 'hotspotOnTime', 'gapCost', 'meanAge', 'inView', 'maxAge'];
  const summary = { samples: rows.length, duration: rows.length * stepSeconds };
  for (const metric of metrics) {
    const values = rows.map(row => row[metric]);
    summary[metric] = { mean: values.reduce((sum, value) => sum + value, 0) / values.length, min: Math.min(...values), max: Math.max(...values) };
  }
  summary.areaTargetFraction = rows.filter(row => row.area >= 95).length / rows.length;
  return summary;
}

function recovery(rows, origin) {
  let first120 = null;
  let goodRun = 0;
  let lastBelow = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].area >= 95) goodRun += 1;
    else {
      goodRun = 0;
      lastBelow = index;
    }
    if (first120 === null && goodRun >= 120 / stepSeconds + 1) first120 = rows[index - 120 / stepSeconds].time - origin;
  }
  const sustainedStart = lastBelow + 1;
  const observedSustainedSeconds = sustainedStart < rows.length ? rows.at(-1).time - rows[sustainedStart].time : 0;
  return {
    first120Seconds: first120,
    sustainedRestOfRunSeconds: observedSustainedSeconds >= 120 ? rows[sustainedStart].time - origin : null,
    observedSustainedSeconds,
  };
}

try {
  const { PatrolSystem } = await server.ssrLoadModule('/src/patrol.ts');
  const results = [];
  const cases = [
    ...['malfunction', 'deviation'].flatMap(fault => Array.from({ length: 5 }, (_, index) => ({ fleetSize: 5, droneId: index + 1, fault }))),
    ...Array.from({ length: 6 }, (_, index) => ({ fleetSize: 6, droneId: index + 1, fault: 'malfunction' })),
    { fleetSize: 5, droneId: 1, fault: 'malfunction', restoreTime: 900 },
  ];
  for (const scenario of cases) {
    const system = new PatrolSystem({ fleetSize: scenario.fleetSize, populationCount: 5000, populationSeed: 42, coverageTarget: 95, revisitSeconds: 120, crowdedRevisitSeconds: 15, crowdedCellPopulation: 80 });
    const rows = [];
    let detectionTime = null;
    let lastSnapshot;
    for (let tick = 0; tick < horizon / stepSeconds; tick += 1) {
      const currentTime = tick * stepSeconds;
      if (currentTime === faultTime) system.injectFault(scenario.droneId, scenario.fault);
      if (currentTime === scenario.restoreTime) system.restoreDrone(scenario.droneId);
      system.step(stepSeconds);
      if (currentTime < 300) continue;
      const snapshot = system.snapshot();
      lastSnapshot = snapshot;
      detectionTime ??= snapshot.events.find(event => event.message.startsWith(`Drone ${scenario.droneId} `) && event.message.includes('confirmed;'))?.time ?? null;
      const population = snapshot.population;
      rows.push({ time: snapshot.time, area: snapshot.coverage, populationOnTime: population.onTimeCoverage, hotspotOnTime: 100 * population.hotspotOnTimeCells / population.hotspotCells, gapCost: population.normalizedGapCost, meanAge: population.meanAgeSeconds, inView: population.inViewCoverage, maxAge: snapshot.maxAge });
    }
    const postFaultRows = rows.filter(row => row.time > faultTime + 1e-6);
    const result = {
      ...scenario,
      detectionLatency: detectionTime - faultTime,
      hotspotCells: lastSnapshot.population.hotspotCells,
      warmBaseline: summarize(rows.filter(row => row.time <= faultTime + 1e-6)),
      first120: summarize(postFaultRows.filter(row => row.time <= faultTime + 120 + 1e-6)),
      first600: summarize(postFaultRows.filter(row => row.time <= faultTime + 600 + 1e-6)),
      tail600: summarize(postFaultRows.filter(row => row.time > horizon - 600 + 1e-6)),
      postFault1200: summarize(postFaultRows),
      recovery: recovery(postFaultRows, faultTime),
      restoreRecovery: scenario.restoreTime ? recovery(rows.filter(row => row.time > scenario.restoreTime + 1e-6), scenario.restoreTime) : null,
      finalEvents: lastSnapshot.events,
    };
    results.push(result);
    console.log(JSON.stringify({ fleet: scenario.fleetSize, fault: scenario.fault, id: scenario.droneId, restore: scenario.restoreTime ?? null, detection: result.detectionLatency, areaMin: result.postFault1200.area.min, areaMean: result.postFault1200.area.mean, areaPass: result.postFault1200.areaTargetFraction, popMean: result.tail600.populationOnTime.mean, hotMean: result.tail600.hotspotOnTime.mean, recovery: result.recovery, restoreRecovery: result.restoreRecovery }));
  }
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/patrol-fault-results.json', JSON.stringify({ config: { stepSeconds, faultTime, horizon, populationCount: 5000, populationSeed: 42 }, results }, null, 2));
} finally {
  await server.close();
}
