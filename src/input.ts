import type { FlightControls } from './types';
import { ZERO_CONTROLS } from './types';

export interface InputConfig {
  deadzone: number;
  expo: number;
  sensitivity: number;
  axes: Record<keyof FlightControls, { index: number; inverted: boolean }>;
  buttons: { arm: number; reset: number; camera: number; pause: number };
}

export interface InputFrame {
  controls: FlightControls;
  gamepad: Gamepad | null;
  actions: ('arm' | 'reset' | 'camera' | 'pause')[];
  source: 'keyboard' | 'controller';
  rawAxes: number[];
  rawButtons: number[];
  disconnected: boolean;
  supported: boolean;
}

type InputAction = InputFrame['actions'][number];

export const DEFAULT_CONFIG: InputConfig = {
  deadzone: 0.08,
  expo: 0.3,
  sensitivity: 1,
  axes: {
    throttle: { index: 1, inverted: true },
    yaw: { index: 0, inverted: false },
    pitch: { index: 3, inverted: true },
    roll: { index: 2, inverted: false },
  },
  buttons: { arm: 0, reset: 8, camera: 3, pause: 9 },
};

const CONFIG_KEY = 'astro-flight-lab:input:v1';
const CENTERS_KEY = 'astro-flight-lab:centers:v1';
const CONTROL_NAMES: (keyof FlightControls)[] = ['throttle', 'yaw', 'pitch', 'roll'];
const ACTION_NAMES: InputAction[] = ['arm', 'reset', 'camera', 'pause'];
const FLIGHT_KEYS = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const KEY_ACTIONS: Record<string, InputAction> = {
  Space: 'arm',
  KeyR: 'reset',
  KeyC: 'camera',
  Escape: 'pause',
  KeyP: 'pause',
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, minimum, maximum)
    : fallback;
}

function mappingIndex(value: unknown, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum
    ? value
    : fallback;
}

export function validateConfig(value: unknown): InputConfig {
  const candidate = record(value);
  const axes = record(candidate.axes);
  const buttons = record(candidate.buttons);
  const config: InputConfig = {
    deadzone: boundedNumber(candidate.deadzone, DEFAULT_CONFIG.deadzone, 0, 0.4),
    expo: boundedNumber(candidate.expo, DEFAULT_CONFIG.expo, 0, 1),
    sensitivity: boundedNumber(candidate.sensitivity, DEFAULT_CONFIG.sensitivity, 0.2, 2),
    axes: {} as InputConfig['axes'],
    buttons: {} as InputConfig['buttons'],
  };
  for (const control of CONTROL_NAMES) {
    const axis = record(axes[control]);
    config.axes[control] = {
      index: mappingIndex(axis.index, DEFAULT_CONFIG.axes[control].index, 31),
      inverted: typeof axis.inverted === 'boolean' ? axis.inverted : DEFAULT_CONFIG.axes[control].inverted,
    };
  }
  for (const action of ACTION_NAMES) {
    config.buttons[action] = mappingIndex(buttons[action], DEFAULT_CONFIG.buttons[action], 63);
  }
  return config;
}

export function applyDeadzone(value: number, deadzone: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = clamp(value, -1, 1);
  const threshold = Number.isFinite(deadzone) ? clamp(deadzone, 0, 0.99) : DEFAULT_CONFIG.deadzone;
  if (Math.abs(normalized) <= threshold) return 0;
  return Math.sign(normalized) * (Math.abs(normalized) - threshold) / (1 - threshold);
}

export function shapeAxis(value: number, deadzone: number, expo = DEFAULT_CONFIG.expo, sensitivity = 1): number {
  const normalized = applyDeadzone(value, deadzone);
  const curve = boundedNumber(expo, DEFAULT_CONFIG.expo, 0, 1);
  const gain = boundedNumber(sensitivity, 1, 0.2, 2);
  return clamp(((1 - curve) * normalized + curve * normalized ** 3) * gain, -1, 1);
}

function readStored(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return;
  }
}

function blocksKeyboard(target: EventTarget | null, code?: string): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
  return (code === 'Space' || code === 'Enter') && Boolean(target.closest('button'));
}

export class ControllerInput {
  public config: InputConfig;
  private enabled = true;
  private pressedKeys = new Set<string>();
  private pendingActions: InputAction[] = [];
  private previousButtons: boolean[] = [];
  private selectedId: string | null = null;
  private buttonBaselineNeeded = true;
  private centers = new Map<string, number[]>();

  constructor() {
    this.config = validateConfig(readStored(CONFIG_KEY));
    for (const [controllerId, storedAxes] of Object.entries(record(readStored(CENTERS_KEY)))) {
      if (Array.isArray(storedAxes) && storedAxes.length <= 64
        && storedAxes.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1)) {
        this.centers.set(controllerId, storedAxes);
      }
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDown);
      window.addEventListener('keyup', this.onKeyUp);
      window.addEventListener('blur', this.clear);
      window.addEventListener('focusin', this.onFocus);
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || blocksKeyboard(event.target, event.code) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Space' || event.code.startsWith('Arrow')) event.preventDefault();
    if (FLIGHT_KEYS.has(event.code)) this.pressedKeys.add(event.code);
    const action = KEY_ACTIONS[event.code];
    if (action && !event.repeat) this.pendingActions.push(action);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    this.pressedKeys.delete(event.code);
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') this.clear();
  };

  private onFocus = (event: FocusEvent): void => {
    if (blocksKeyboard(event.target)) this.clear();
  };

  private readGamepad(): { gamepad: Gamepad | null; supported: boolean } {
    try {
      if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
        return { gamepad: null, supported: false };
      }
      const connected = Array.from(navigator.getGamepads()).filter((gamepad): gamepad is Gamepad => Boolean(gamepad?.connected));
      const preferred = connected.find(gamepad => /astro|c40/i.test(gamepad.id));
      return { gamepad: preferred ?? connected[0] ?? null, supported: true };
    } catch {
      return { gamepad: null, supported: false };
    }
  }

  poll(): InputFrame {
    const { gamepad, supported } = this.readGamepad();
    const nextId = gamepad ? `${gamepad.index}:${gamepad.id}` : null;
    const changed = nextId !== this.selectedId;
    const disconnected = this.selectedId !== null && changed;
    const rawAxes = gamepad ? Array.from(gamepad.axes, value => Number.isFinite(value) ? value : 0) : [];
    const rawButtons = gamepad ? Array.from(gamepad.buttons, button => Number.isFinite(button.value) ? button.value : 0) : [];
    const currentButtons = gamepad ? Array.from(gamepad.buttons, button => button.pressed || button.value >= 0.5) : [];
    const actions = this.pendingActions.splice(0);
    const keyboardActive = this.pressedKeys.size > 0 || actions.length > 0;
    const controls = { ...ZERO_CONTROLS };

    if (changed || this.buttonBaselineNeeded) {
      this.previousButtons = currentButtons;
      this.buttonBaselineNeeded = false;
    } else if (gamepad) {
      for (const action of ACTION_NAMES) {
        const buttonIndex = this.config.buttons[action];
        if (currentButtons[buttonIndex] && !this.previousButtons[buttonIndex]) actions.push(action);
      }
    }

    if (gamepad) {
      const centers = this.centers.get(gamepad.id) ?? [];
      for (const control of CONTROL_NAMES) {
        const { index, inverted } = this.config.axes[control];
        const center = centers[index] ?? 0;
        const rawValue = rawAxes[index] ?? center;
        const range = rawValue >= center ? 1 - center : 1 + center;
        const centered = range > 0 ? (rawValue - center) / range : 0;
        controls[control] = shapeAxis(centered * (inverted ? -1 : 1), this.config.deadzone, this.config.expo, this.config.sensitivity);
      }
    }

    const keyboardControls: FlightControls = {
      throttle: Number(this.pressedKeys.has('KeyW')) - Number(this.pressedKeys.has('KeyS')),
      yaw: Number(this.pressedKeys.has('KeyD')) - Number(this.pressedKeys.has('KeyA')),
      pitch: Number(this.pressedKeys.has('ArrowUp')) - Number(this.pressedKeys.has('ArrowDown')),
      roll: Number(this.pressedKeys.has('ArrowRight')) - Number(this.pressedKeys.has('ArrowLeft')),
    };
    for (const control of CONTROL_NAMES) {
      if (keyboardControls[control] !== 0) controls[control] = keyboardControls[control];
    }

    this.selectedId = nextId;
    this.previousButtons = currentButtons;
    if (disconnected) this.clear();

    return {
      controls: disconnected || !this.enabled ? { ...ZERO_CONTROLS } : controls,
      gamepad,
      actions: disconnected || !this.enabled ? [] : [...new Set(actions)],
      source: gamepad && !keyboardActive ? 'controller' : 'keyboard',
      rawAxes,
      rawButtons,
      disconnected,
      supported,
    };
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.clear();
  }

  setConfig(config: InputConfig): void {
    this.config = validateConfig(config);
    this.buttonBaselineNeeded = true;
    writeStored(CONFIG_KEY, this.config);
  }

  calibrate(): boolean {
    const { gamepad } = this.readGamepad();
    if (!gamepad || !gamepad.axes.length || gamepad.axes.some(value => !Number.isFinite(value))) return false;
    this.centers.set(gamepad.id, Array.from(gamepad.axes, value => clamp(value, -1, 1)));
    writeStored(CENTERS_KEY, Object.fromEntries(this.centers));
    return true;
  }

  resetConfig(): void {
    this.setConfig(DEFAULT_CONFIG);
    this.centers.clear();
    writeStored(CENTERS_KEY, {});
  }

  clear = (): void => {
    this.pressedKeys.clear();
    this.pendingActions = [];
    this.buttonBaselineNeeded = true;
  };

  dispose(): void {
    this.clear();
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDown);
      window.removeEventListener('keyup', this.onKeyUp);
      window.removeEventListener('blur', this.clear);
      window.removeEventListener('focusin', this.onFocus);
    }
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}
