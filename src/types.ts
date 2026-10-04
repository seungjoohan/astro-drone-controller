export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FlightControls {
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
}

export type FlightMode = 'assisted' | 'sport';
export type CameraMode = 'chase' | 'fpv' | 'orbit';

export interface FlightState {
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  armed: boolean;
  crashed: boolean;
  surface: 'ground' | 'rooftop' | null;
  surfaceHeight: number;
  landingCount: number;
  time: number;
  distance: number;
  maxSpeed: number;
  battery: number;
}

export interface Gate {
  position: Vec3;
  yaw: number;
  radius: number;
}

export const ZERO_CONTROLS: FlightControls = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
