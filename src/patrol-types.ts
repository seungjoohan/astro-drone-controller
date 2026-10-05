import type { Vec3 } from './types';

export interface PatrolConfig {
  coverageTarget: number;
  revisitSeconds: number;
  fleetSize: number;
  populationCount: number;
  populationSeed: number;
  crowdedRevisitSeconds: number;
  crowdedCellPopulation: number;
}

export type PatrolFault = 'malfunction' | 'deviation';
export type PatrolDroneStatus = 'patrolling' | 'deviating' | 'unresponsive' | 'offline';

export interface PatrolCell {
  id: number;
  position: Vec3;
  lastVisited: number | null;
  assignedDroneId: number | null;
  population: number;
  targetRevisitSeconds: number;
}

export interface PatrolDrone {
  id: number;
  color: string;
  status: PatrolDroneStatus;
  fault: PatrolFault | null;
  position: Vec3;
  route: Vec3[];
  assignedCellIds: number[];
  routeIndex: number;
  cycleSeconds: number;
}

export interface PatrolEvent {
  id: number;
  time: number;
  message: string;
}

export interface FleetRecommendation {
  count: number;
  achievable: boolean;
  estimatedCoverage: number;
  revisitSeconds: number;
}

export interface PopulationMetrics {
  totalPeople: number;
  onTimePeople: number;
  onTimeCoverage: number | null;
  inViewPeople: number;
  inViewCoverage: number | null;
  unseenPeople: number;
  meanAgeSeconds: number | null;
  normalizedGapCost: number | null;
  hotspotCells: number;
  hotspotOnTimeCells: number;
}

export interface PatrolSnapshot {
  config: PatrolConfig;
  time: number;
  drones: PatrolDrone[];
  cells: PatrolCell[];
  coverage: number;
  everCovered: number;
  uncoveredCells: number;
  maxAge: number | null;
  recommendedFleet: FleetRecommendation;
  estimatedCoverage: number;
  predictedRevisitSeconds: number;
  activeCount: number;
  revision: number;
  events: PatrolEvent[];
  population: PopulationMetrics;
}
