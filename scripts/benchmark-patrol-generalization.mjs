import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';

const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
try {
  const { PATROL_DEFAULTS } = await server.ssrLoadModule('/src/patrol.ts');
  const { DEFAULT_ENVIRONMENT } = await server.ssrLoadModule('/src/patrol-environment.ts');
  const { runSearch } = await server.ssrLoadModule('/src/patrol-search.ts');
  const { EVALUATOR_VERSION, createScenarios } = await server.ssrLoadModule('/src/patrol-evaluator.ts');
  const { createCheckpoint } = await server.ssrLoadModule('/src/patrol-learning-checkpoint.ts');
  const settings = {
    config: { ...PATROL_DEFAULTS }, environment: { ...DEFAULT_ENVIRONMENT }, profile: 'diverse',
    optimizerSeed: 42, generations: 1, budgetSeconds: 120, scenarioCount: 6,
  };
  let previousEvaluations = -1;
  const progress = await runSearch(settings, current => {
    if (current.evaluations !== previousEvaluations) {
      process.stdout.write(`${current.evaluations} batches · ${current.elapsedSeconds.toFixed(1)} s · ${current.message}\n`);
      previousEvaluations = current.evaluations;
    }
  });
  const checkpoint = createCheckpoint(settings, progress);
  const report = {
    createdAt: new Date().toISOString(), evaluatorVersion: EVALUATOR_VERSION,
    note: 'Bounded synthetic robustness pilot, not a universal policy or real-aircraft endurance result. Final-test cases remain unevaluated. Fleet counts include charging aircraft. No requirements are relaxed.',
    scenarioManifest: {
      training: createScenarios(settings.config, 'training', settings),
      validation: createScenarios(settings.config, 'validation', settings),
      failure: createScenarios(settings.config, 'failure', settings),
    },
    checkpoint,
  };
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/patrol-generalization-results.json', `${JSON.stringify(report, null, 2)}\n`);
  const summary = progress.candidates.filter(candidate => candidate.strategy.kind === 'adaptive').map(candidate => ({
    fleetSize: candidate.fleetSize,
    speedFraction: candidate.strategy.parameters.speedFraction,
    trainingCases: candidate.training.scenarioResults?.length,
    validationCases: candidate.validation?.scenarioResults?.length ?? 0,
    denseAreaMinimum: candidate.validation?.auditAreaMinimum,
    worstCaseGap: candidate.validation?.worstCaseGapCost,
    completedCharges: candidate.validation?.completedCharges,
    energyViolations: candidate.validation?.energyViolations,
    reserveViolations: candidate.validation?.reserveViolations,
  }));
  process.stdout.write(`${JSON.stringify({ status: progress.status, evaluations: progress.evaluations, recommendedId: progress.recommendedId, summary }, null, 2)}\n`);
} finally {
  await server.close();
}
