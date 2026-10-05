import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';

const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { PATROL_DEFAULTS } = await server.ssrLoadModule('/src/patrol.ts');
  const { runSearch, meetsRequirements } = await server.ssrLoadModule('/src/patrol-search.ts');
  const { EVALUATOR_VERSION, PILOT_PROTOCOL, scenarioSeeds, evaluateScenarios } = await server.ssrLoadModule('/src/patrol-evaluator.ts');
  const settings = { config: { ...PATROL_DEFAULTS }, optimizerSeed: 42, generations: 2, budgetSeconds: 60 };
  const progress = await runSearch(settings, () => {});
  const paired = Array.from({ length: 8 }, (_, index) => {
    const fleetSize = index + 1;
    const candidates = progress.candidates.filter(candidate => candidate.fleetSize === fleetSize);
    const adaptive = candidates.find(candidate => candidate.strategy.kind === 'adaptive');
    const uniform = candidates.find(candidate => candidate.strategy.kind === 'uniform');
    return {
      fleetSize,
      adaptive: adaptive?.validation ?? null,
      uniform: uniform?.validation ?? null,
      adaptivePassesStrictChecks: adaptive?.validation ? meetsRequirements(adaptive.validation) : false,
      gapCostReductionPercent: adaptive?.validation?.gapCost != null && uniform?.validation?.gapCost
        ? 100 * (1 - adaptive.validation.gapCost / uniform.validation.gapCost) : null,
    };
  });
  const regressionPolicy = progress.candidates.find(candidate => candidate.fleetSize === 5 && candidate.strategy.kind === 'adaptive');
  const regressionScenarios = [1, 7, 42, 123, 301, 997, 2026, 98765, 104729, 2147483646].map(populationSeed => ({
    populationSeed, warmupSeconds: 600, evaluationSeconds: 1200,
  }));
  process.stdout.write('Pilot finished. Comparing the five-drone diagnostic on the ten published regression seeds.\n');
  const regression = regressionPolicy ? {
    fleetSize: 5,
    protocol: { warmupSeconds: 600, evaluationSeconds: 1200, stepSeconds: PILOT_PROTOCOL.stepSeconds },
    note: 'Development regression, not a sealed test. Uses the learning evaluator and independent dense audit; compare the matched pair, not unlike historical aggregates.',
    adaptive: await evaluateScenarios(settings.config, regressionPolicy.strategy, regressionScenarios),
    uniform: await evaluateScenarios(settings.config, { kind: 'uniform' }, regressionScenarios),
  } : null;
  const report = {
    createdAt: new Date().toISOString(), evaluatorVersion: EVALUATOR_VERSION,
    settings, protocol: PILOT_PROTOCOL, seeds: scenarioSeeds(settings.config.populationSeed),
    note: 'Local seeded parameter search, not neural RL or a proof of fleet optimality. Healthy and fault results are separate. Strict hotspot feasibility is diagnostic pending operator tolerance decisions.',
    progress, paired, regression,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/patrol-learning-results.json', `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: progress.status, evaluations: progress.evaluations, recommendedId: progress.recommendedId, paired, regression }, null, 2)}\n`);
} finally {
  await server.close();
}
