export type ExternalPatrolCommand =
  | { droneId: number; mode: 'patrol'; destination: { x: number; z: number }; speedFraction?: number }
  | { droneId: number; mode: 'return'; destination?: never; speedFraction?: never }
  | { droneId: number; mode: 'standby'; destination?: never; speedFraction?: never };

export interface ExternalPatrolMetrics {
  rejectedCommands: number;
  forcedReturns: number;
}

export function parseExternalPatrolCommand(value: unknown): ExternalPatrolCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const command = value as Record<string, unknown>;
  if (!Number.isInteger(command.droneId) || (command.droneId as number) < 1) return null;
  if (Object.keys(command).some(key => !['droneId', 'mode', 'destination', 'speedFraction'].includes(key))) return null;
  if (command.mode === 'return' || command.mode === 'standby') {
    return command.destination === undefined && command.speedFraction === undefined ? { droneId: command.droneId as number, mode: command.mode } : null;
  }
  if (command.mode !== 'patrol' || !command.destination || typeof command.destination !== 'object' || Array.isArray(command.destination)) return null;
  const destination = command.destination as Record<string, unknown>;
  if (Object.keys(destination).some(key => key !== 'x' && key !== 'z')
    || typeof destination.x !== 'number' || !Number.isFinite(destination.x)
    || typeof destination.z !== 'number' || !Number.isFinite(destination.z)
    || command.speedFraction !== undefined && (typeof command.speedFraction !== 'number' || !Number.isFinite(command.speedFraction) || command.speedFraction < 0.5 || command.speedFraction > 1)) return null;
  return {
    droneId: command.droneId as number, mode: 'patrol', destination: { x: destination.x, z: destination.z },
    ...(command.speedFraction === undefined ? {} : { speedFraction: command.speedFraction as number }),
  };
}
