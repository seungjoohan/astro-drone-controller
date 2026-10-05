import { PatrolSystem } from './patrol';
import { PatrolCoverageAudit } from './patrol-audit';
import { DEFAULT_ENVIRONMENT, validateEnvironment } from './patrol-environment';
import { PILOT_PROTOCOL } from './patrol-scenarios';
import type { EvaluationScenario } from './patrol-scenarios';
import type { EvaluationMetrics, PatrolStrategy, ScenarioEvaluationResult } from './patrol-learning-types';
import type { PatrolConfig, PatrolSnapshot } from './patrol-types';

export { createScenarios, PILOT_PROTOCOL, scenarioSeeds } from './patrol-scenarios';
export type { EvaluationScenario } from './patrol-scenarios';
export const EVALUATOR_VERSION = 'patrol-robustness-v2-energy-grid40-audit10-dt0.5';

export interface EvaluationControls {
  checkpoint?: () => Promise<void>;
}

export class EvaluationAccumulator {
  private duration = 0;
  private areaIntegral = 0;
  private auditIntegral = 0;
  private auditMinimum = 100;
  private targetIntegral = 0;
  private populationIntegral = 0;
  private hotspotIntegral = 0;
  private ageIntegral = 0;
  private gapIntegral = 0;
  private populationDuration = 0;
  private hotspotDuration = 0;
  private areaMinimum = 100;
  private maxAge = 0;
  private unseen = 0;
  private hotspotsAlwaysFresh = true;

  add(snapshot: PatrolSnapshot, seconds: number, auditCoverage = snapshot.coverage): void {
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Evaluation interval must be positive and finite.');
    this.duration += seconds;
    this.areaMinimum = Math.min(this.areaMinimum, snapshot.coverage);
    this.areaIntegral += snapshot.coverage * seconds;
    this.auditMinimum = Math.min(this.auditMinimum, auditCoverage);
    this.auditIntegral += auditCoverage * seconds;
    if (snapshot.coverage + 1e-8 >= snapshot.config.coverageTarget && auditCoverage + 1e-8 >= snapshot.config.coverageTarget) this.targetIntegral += seconds;
    let hotspotPeople = 0;
    let hotspotFresh = 0;
    for (const cell of snapshot.cells) {
      const age = cell.lastVisited === null ? snapshot.time + cell.targetRevisitSeconds : Math.max(0, snapshot.time - cell.lastVisited);
      this.maxAge = Math.max(this.maxAge, age);
      if (cell.population < snapshot.config.crowdedCellPopulation) continue;
      hotspotPeople += cell.population;
      if (cell.lastVisited !== null && age <= cell.targetRevisitSeconds + 1e-8) hotspotFresh += cell.population;
    }
    if (hotspotPeople) {
      this.hotspotIntegral += 100 * hotspotFresh / hotspotPeople * seconds;
      this.hotspotDuration += seconds;
      if (hotspotFresh < hotspotPeople) this.hotspotsAlwaysFresh = false;
    }
    if (snapshot.population.totalPeople) {
      this.populationIntegral += snapshot.population.onTimeCoverage! * seconds;
      this.ageIntegral += snapshot.population.meanAgeSeconds! * seconds;
      this.gapIntegral += snapshot.population.normalizedGapCost! * seconds;
      this.populationDuration += seconds;
    }
    this.unseen = Math.max(this.unseen, snapshot.population.unseenPeople);
  }

  metrics(scenarios = 1, distanceMeters = 0): EvaluationMetrics {
    if (!this.duration) throw new Error('An incomplete evaluation cannot be scored.');
    return {
      scenarios,
      durationSeconds: this.duration,
      areaMinimum: this.areaMinimum,
      areaMean: Math.min(100, Math.max(this.areaMinimum, this.areaIntegral / this.duration)),
      auditAreaMinimum: this.auditMinimum,
      auditAreaMean: Math.min(100, Math.max(this.auditMinimum, this.auditIntegral / this.duration)),
      areaTargetFraction: this.targetIntegral / this.duration,
      populationOnTime: this.populationDuration ? Math.min(100, this.populationIntegral / this.populationDuration) : null,
      hotspotOnTime: this.hotspotDuration ? Math.min(100, this.hotspotIntegral / this.hotspotDuration) : null,
      meanAgeSeconds: this.populationDuration ? this.ageIntegral / this.populationDuration : null,
      gapCost: this.populationDuration ? this.gapIntegral / this.populationDuration : null,
      maxObservationAge: this.maxAge,
      neverObservedPeople: this.unseen,
      distanceMeters,
      geographicFeasible: this.targetIntegral >= this.duration - 1e-8,
      hotspotFeasible: this.hotspotsAlwaysFresh,
    };
  }
}

export async function evaluateScenarios(config: PatrolConfig, strategy: PatrolStrategy, scenarios: EvaluationScenario[], controls: EvaluationControls = {}): Promise<EvaluationMetrics> {
  if (!scenarios.length) throw new Error('At least one scenario is required.');
  const accumulator = new EvaluationAccumulator();
  const scenarioResults: ScenarioEvaluationResult[] = [];
  let distanceMeters = 0;
  for (const scenario of scenarios) {
    if (!Number.isFinite(scenario.warmupSeconds) || scenario.warmupSeconds < 0 || scenario.warmupSeconds > 3600 || !Number.isFinite(scenario.evaluationSeconds) || scenario.evaluationSeconds <= 0 || scenario.evaluationSeconds > 20000) throw new Error('Invalid evaluation duration.');
    if (!Number.isInteger(scenario.populationSeed) || scenario.populationSeed < 1 || scenario.populationSeed > 2147483647) throw new Error('Invalid scenario seed.');
    const populationCount = scenario.populationCount ?? config.populationCount;
    if (!Number.isInteger(populationCount) || populationCount < 0 || populationCount > 50000) throw new Error('Invalid scenario population.');
    const environment = validateEnvironment(scenario.environment ?? DEFAULT_ENVIRONMENT);
    if (!environment) throw new Error('Invalid scenario environment.');
    if (scenario.fault && (!Number.isInteger(scenario.fault.droneId) || scenario.fault.droneId < 1 || scenario.fault.droneId > config.fleetSize
      || !['malfunction', 'deviation'].includes(scenario.fault.kind) || !Number.isFinite(scenario.fault.timeSeconds)
      || scenario.fault.timeSeconds < 0 || scenario.fault.timeSeconds >= scenario.warmupSeconds + scenario.evaluationSeconds)) throw new Error('Invalid fault scenario.');
    await controls.checkpoint?.();
    const scenarioAccumulator = new EvaluationAccumulator();
    let scenarioDistance = 0;
    const system = new PatrolSystem({ ...config, populationSeed: scenario.populationSeed, populationCount }, strategy, environment);
    const audit = new PatrolCoverageAudit(10, environment);
    const end = scenario.warmupSeconds + scenario.evaluationSeconds;
    let snapshot = system.snapshot();
    audit.observe(snapshot);
    let faultInjected = false;
    while (snapshot.time < end - 1e-8) {
      await controls.checkpoint?.();
      if (!faultInjected && scenario.fault && snapshot.time >= scenario.fault.timeSeconds - 1e-8) {
        system.injectFault(scenario.fault.droneId, scenario.fault.kind);
        faultInjected = true;
      }
      const boundary = snapshot.time < scenario.warmupSeconds - 1e-8 ? scenario.warmupSeconds : end;
      const faultBoundary = !faultInjected && scenario.fault && scenario.fault.timeSeconds > snapshot.time + 1e-8 ? scenario.fault.timeSeconds : end;
      const interval = Math.min(PILOT_PROTOCOL.stepSeconds, boundary - snapshot.time, faultBoundary - snapshot.time);
      const previous = snapshot;
      system.step(interval);
      snapshot = system.snapshot();
      audit.observe(snapshot);
      if (previous.time >= scenario.warmupSeconds - 1e-8) {
        const auditCoverage = audit.measure(snapshot.time, config.revisitSeconds).coverage;
        accumulator.add(snapshot, interval, auditCoverage);
        scenarioAccumulator.add(snapshot, interval, auditCoverage);
        const distance = snapshot.drones.reduce((total, drone, index) => total + Math.hypot(drone.position.x - previous.drones[index].position.x, drone.position.z - previous.drones[index].position.z), 0);
        distanceMeters += distance;
        scenarioDistance += distance;
      }
    }
    scenarioResults.push({
      id: scenario.id ?? `current-${scenario.populationSeed}`,
      family: scenario.family ?? 'current',
      populationSeed: scenario.populationSeed,
      populationCount,
      environment,
      metrics: {
        ...scenarioAccumulator.metrics(1, scenarioDistance),
        energyViolations: snapshot.energy.strandedDrones,
        reserveViolations: snapshot.energy.reserveViolations,
        energyUsed: snapshot.energy.energyUsed,
        completedCharges: snapshot.energy.completedCharges,
      },
    });
    await controls.checkpoint?.();
  }
  const caseMetrics = scenarioResults.map(result => result.metrics);
  const gapCosts = caseMetrics.flatMap(metrics => metrics.gapCost === null ? [] : [metrics.gapCost]);
  return {
    ...accumulator.metrics(scenarios.length, distanceMeters),
    scenarioResults,
    feasibleScenarioFraction: caseMetrics.filter(metrics => metrics.geographicFeasible && metrics.hotspotFeasible
      && metrics.neverObservedPeople === 0 && !metrics.energyViolations && !metrics.reserveViolations).length / scenarios.length,
    worstCaseGapCost: gapCosts.length ? Math.max(...gapCosts) : null,
    energyViolations: caseMetrics.reduce((total, metrics) => total + (metrics.energyViolations ?? 0), 0),
    reserveViolations: caseMetrics.reduce((total, metrics) => total + (metrics.reserveViolations ?? 0), 0),
    energyUsed: caseMetrics.reduce((total, metrics) => total + (metrics.energyUsed ?? 0), 0),
    completedCharges: caseMetrics.reduce((total, metrics) => total + (metrics.completedCharges ?? 0), 0),
  };
}
