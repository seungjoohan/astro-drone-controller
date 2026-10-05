import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
const started = performance.now();
try {
  const { PatrolSystem, PATROL_DEFAULTS, PATROL_LIMITS } = await server.ssrLoadModule('/src/patrol.ts');
  const seeds = [1, 7, 42, 123, 301, 997, 2026, 98765, 104729, 2147483646];
  const warmupSeconds = 600;
  const evaluationSeconds = 1200;
  const sampleSeconds = 0.5;
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const cases = [];

  function evaluate(config, interval = sampleSeconds) {
    const system = new PatrolSystem(config);
    system.step(warmupSeconds);
    const initial = system.snapshot();
    const hotspotIds = initial.cells.filter(cell => cell.population >= initial.config.crowdedCellPopulation).map(cell => cell.id);
    const hotspotPopulation = initial.cells.filter(cell => hotspotIds.includes(cell.id)).reduce((sum, cell) => sum + cell.population, 0);
    const ages = new Map();
    const metrics = {
      area: [], peopleOnTime: [], peopleInView: [], meanAgeSeconds: [], gapCost: [], hotspotsOnTime: [],
    };
    let areaPassSamples = 0;
    let allHotspotsPassSamples = 0;
    let maximumHotspotAgeSeconds = 0;
    let maximumUnseenPeople = 0;
    const samples = Math.round(evaluationSeconds / interval);
    for (let sample = 0; sample < samples; sample += 1) {
      const snapshot = system.snapshot();
      metrics.area.push(snapshot.coverage);
      metrics.peopleOnTime.push(snapshot.population.onTimeCoverage);
      metrics.peopleInView.push(snapshot.population.inViewCoverage);
      metrics.meanAgeSeconds.push(snapshot.population.meanAgeSeconds);
      metrics.gapCost.push(snapshot.population.normalizedGapCost);
      if (snapshot.coverage >= snapshot.config.coverageTarget) areaPassSamples += 1;
      if (snapshot.population.hotspotOnTimeCells === hotspotIds.length) allHotspotsPassSamples += 1;
      maximumUnseenPeople = Math.max(maximumUnseenPeople, snapshot.population.unseenPeople);
      let hotspotOnTimePeople = 0;
      for (const cell of snapshot.cells) {
        const age = cell.lastVisited === null ? snapshot.time + cell.targetRevisitSeconds : Math.max(0, snapshot.time - cell.lastVisited);
        if (cell.population > 0) {
          const bin = Math.ceil(age * 2) / 2;
          ages.set(bin, (ages.get(bin) ?? 0) + cell.population);
        }
        if (cell.population < snapshot.config.crowdedCellPopulation) continue;
        maximumHotspotAgeSeconds = Math.max(maximumHotspotAgeSeconds, age);
        if (cell.lastVisited !== null && age <= cell.targetRevisitSeconds + 1e-8) hotspotOnTimePeople += cell.population;
      }
      metrics.hotspotsOnTime.push(hotspotPopulation ? 100 * hotspotOnTimePeople / hotspotPopulation : null);
      system.step(interval);
    }
    const summaries = Object.fromEntries(Object.entries(metrics).map(([name, values]) => {
      const valid = values.filter(value => value !== null);
      return [name, valid.length ? { mean: average(valid), minimum: Math.min(...valid), maximum: Math.max(...valid) } : null];
    }));
    const totalWeight = [...ages.values()].reduce((sum, value) => sum + value, 0);
    let accumulated = 0;
    let p95AgeSeconds = null;
    for (const [age, weight] of [...ages].sort((first, second) => first[0] - second[0])) {
      accumulated += weight;
      if (accumulated >= 0.95 * totalWeight) {
        p95AgeSeconds = age;
        break;
      }
    }
    return {
      config: initial.config, sampleSeconds: interval, samples, hotspotCells: hotspotIds.length, hotspotPopulation,
      areaTargetPassPercent: 100 * areaPassSamples / samples,
      allHotspotsPassPercent: hotspotIds.length ? 100 * allHotspotsPassSamples / samples : null,
      maximumHotspotAgeSeconds: hotspotIds.length ? maximumHotspotAgeSeconds : null,
      populationWeightedP95AgeSeconds: p95AgeSeconds, maximumUnseenPeople, metrics: summaries,
    };
  }

  for (const fleetSize of [3, 4, 5, 6, 8]) {
    for (const populationSeed of seeds) cases.push(evaluate({ fleetSize, populationSeed }));
    process.stdout.write(`Completed fleet ${fleetSize}\n`);
  }
  for (const populationCount of [1000, 10000, 20000]) {
    for (const populationSeed of seeds) cases.push(evaluate({ populationCount, populationSeed }));
    process.stdout.write(`Completed population ${populationCount}\n`);
  }

  function aggregate(selected) {
    return {
      scenarios: selected.length,
      areaMinimum: Math.min(...selected.map(result => result.metrics.area.minimum)),
      areaMean: average(selected.map(result => result.metrics.area.mean)),
      areaTargetPassPercent: average(selected.map(result => result.areaTargetPassPercent)),
      peopleOnTimeMean: average(selected.map(result => result.metrics.peopleOnTime.mean)),
      peopleOnTimeSeedMeanRange: [Math.min(...selected.map(result => result.metrics.peopleOnTime.mean)), Math.max(...selected.map(result => result.metrics.peopleOnTime.mean))],
      peopleInViewMean: average(selected.map(result => result.metrics.peopleInView.mean)),
      meanAgeSeconds: average(selected.map(result => result.metrics.meanAgeSeconds.mean)),
      p95AgeSeedRangeSeconds: [Math.min(...selected.map(result => result.populationWeightedP95AgeSeconds)), Math.max(...selected.map(result => result.populationWeightedP95AgeSeconds))],
      gapCostMean: average(selected.map(result => result.metrics.gapCost.mean)),
      hotspotsOnTimeMean: selected.some(result => result.metrics.hotspotsOnTime) ? average(selected.filter(result => result.metrics.hotspotsOnTime).map(result => result.metrics.hotspotsOnTime.mean)) : null,
      hotspotMaxAgeSeconds: Math.max(...selected.map(result => result.maximumHotspotAgeSeconds ?? 0)),
      allHotspotsPassPercent: selected.some(result => result.allHotspotsPassPercent !== null) ? average(selected.filter(result => result.allHotspotsPassPercent !== null).map(result => result.allHotspotsPassPercent)) : null,
    };
  }

  const fleetComparison = [3, 4, 5, 6, 8].map(fleetSize => ({ fleetSize, ...aggregate(cases.filter(result => result.config.populationCount === PATROL_DEFAULTS.populationCount && result.config.fleetSize === fleetSize)) }));
  const populationComparison = [1000, 5000, 10000, 20000].map(populationCount => ({ populationCount, ...aggregate(cases.filter(result => result.config.populationCount === populationCount && result.config.fleetSize === PATROL_DEFAULTS.fleetSize)) }));
  const defaultCase = cases.find(result => result.config.populationCount === 5000 && result.config.fleetSize === 5 && result.config.populationSeed === 42);
  const fineSampleDefault = evaluate({}, 0.1);
  const report = {
    createdAt: new Date().toISOString(),
    methodology: { warmupSeconds, evaluationSeconds, sampleSeconds, seeds, defaultConfig: PATROL_DEFAULTS, sensor: PATROL_LIMITS, unchangedPlanner: true, persistedUserRunsAvailable: false, p95AgeBinSeconds: 0.5, note: 'Mission-quality benchmarks against the implemented 208-point overhead sensing model, not measured real-city visibility or browser frame rate. Each reported mean averages equal-duration samples and equal-size seed scenarios. Fault-free warmup excluded. No learning or controller changes.' },
    defaultCase, fineSampleDefault, fleetComparison, populationComparison, cases,
    wallSeconds: (performance.now() - started) / 1000,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/patrol-performance-results.json', `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ defaultCase, fineSampleDefault, fleetComparison, populationComparison, wallSeconds: report.wallSeconds }, null, 2)}\n`);
} finally {
  await server.close();
}
