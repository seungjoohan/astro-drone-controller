import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyDeadzone, ControllerInput, DEFAULT_CONFIG, shapeAxis, validateConfig } from './input';
import { ZERO_CONTROLS } from './types';

function makeGamepad(axes: number[] = [0, 0, 0, 0], pressed: number[] = [], id = 'ASTRO C40', index = 0): Gamepad {
  return {
    axes,
    buttons: Array.from({ length: 12 }, (_, buttonIndex) => ({
      pressed: pressed.includes(buttonIndex),
      touched: pressed.includes(buttonIndex),
      value: Number(pressed.includes(buttonIndex)),
    })),
    connected: true,
    id,
    index,
    mapping: '',
    timestamp: 0,
    vibrationActuator: null,
  } as unknown as Gamepad;
}

function emitKey(surface: EventTarget, code: string, type = 'keydown', repeat = false, target?: EventTarget): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    code: { value: code },
    repeat: { value: repeat },
    ...(target ? { target: { value: target } } : {}),
  });
  surface.dispatchEvent(event);
  return event;
}

afterEach(() => vi.unstubAllGlobals());

describe('axis shaping', () => {
  it('removes neutral noise while preserving signed full travel', () => {
    expect(applyDeadzone(0.079, 0.08)).toBe(0);
    expect(applyDeadzone(-0.08, 0.08)).toBe(0);
    expect(applyDeadzone(0.54, 0.08)).toBeCloseTo(0.5);
    expect(applyDeadzone(-0.54, 0.08)).toBeCloseTo(-0.5);
    expect(applyDeadzone(1, 0.08)).toBe(1);
    expect(applyDeadzone(-1, 0.08)).toBe(-1);
    expect(applyDeadzone(Number.NaN, 0.08)).toBe(0);
  });

  it('softens the center with expo and caps sensitivity at full output', () => {
    expect(shapeAxis(0.5, 0, 1, 1)).toBe(0.125);
    expect(shapeAxis(-0.5, 0, 1, 1)).toBe(-0.125);
    expect(shapeAxis(0.9, 0, 0, 2)).toBe(1);
    expect(shapeAxis(-0.9, 0, 0, 2)).toBe(-1);
  });
});

describe('config validation', () => {
  it('falls back safely for corrupted stored values', () => {
    expect(validateConfig(null)).toEqual(DEFAULT_CONFIG);
    const config = validateConfig({
      deadzone: Number.NaN,
      expo: 2,
      sensitivity: -20,
      axes: { throttle: { index: -1, inverted: 'yes' }, pitch: { index: 6, inverted: false } },
      buttons: { arm: 1.5, pause: 5 },
    });
    expect(config.deadzone).toBe(DEFAULT_CONFIG.deadzone);
    expect(config.expo).toBe(1);
    expect(config.sensitivity).toBe(0.2);
    expect(config.axes.throttle).toEqual(DEFAULT_CONFIG.axes.throttle);
    expect(config.axes.pitch).toEqual({ index: 6, inverted: false });
    expect(config.buttons.arm).toBe(DEFAULT_CONFIG.buttons.arm);
    expect(config.buttons.pause).toBe(5);
  });

  it('returns independent nested mappings', () => {
    const config = validateConfig(DEFAULT_CONFIG);
    config.axes.throttle.index = 10;
    config.buttons.arm = 6;
    expect(DEFAULT_CONFIG.axes.throttle.index).toBe(1);
    expect(DEFAULT_CONFIG.buttons.arm).toBe(0);
  });
});

describe('controller lifecycle', () => {
  it('uses fresh snapshots and requires release before a held connection button activates', () => {
    let gamepad = makeGamepad([0, -1, 0, 0], [0]);
    vi.stubGlobal('navigator', { getGamepads: () => [gamepad] });
    const input = new ControllerInput();
    expect(input.poll().actions).toEqual([]);
    expect(input.poll().controls.throttle).toBe(1);
    gamepad = makeGamepad();
    input.poll();
    gamepad = makeGamepad([0, 0, 0, 0], [0]);
    expect(input.poll().actions).toEqual(['arm']);
    expect(input.poll().actions).toEqual([]);
    input.dispose();
  });

  it('neutralizes the disconnect frame and reports it only once', () => {
    let gamepad: Gamepad | null = makeGamepad([1, -1, 0, 0]);
    vi.stubGlobal('navigator', { getGamepads: () => [gamepad] });
    const input = new ControllerInput();
    expect(input.poll().controls.yaw).toBe(1);
    gamepad = null;
    const disconnected = input.poll();
    expect(disconnected.disconnected).toBe(true);
    expect(disconnected.controls).toEqual(ZERO_CONTROLS);
    expect(disconnected.actions).toEqual([]);
    expect(input.poll().disconnected).toBe(false);
    input.dispose();
  });

  it('prefers the Astro controller and allows arbitrary remapping', () => {
    const generic = makeGamepad([1, 0, 0, 0], [], 'Generic controller', 0);
    const astro = makeGamepad([0, 0, 0, -1, 0, 0.5], [], 'ASTRO C40', 1);
    vi.stubGlobal('navigator', { getGamepads: () => [generic, astro] });
    const input = new ControllerInput();
    const config = validateConfig({ ...DEFAULT_CONFIG, deadzone: 0, expo: 0 });
    config.axes.yaw = { index: 5, inverted: true };
    input.setConfig(config);
    const frame = input.poll();
    expect(frame.gamepad).toBe(astro);
    expect(frame.controls.pitch).toBe(1);
    expect(frame.controls.yaw).toBe(-0.5);
    input.dispose();
  });

  it('calibrates neutral drift without reducing full stick travel', () => {
    let gamepad = makeGamepad([0.1, -0.15, 0.05, 0]);
    vi.stubGlobal('navigator', { getGamepads: () => [gamepad] });
    const input = new ControllerInput();
    expect(input.calibrate()).toBe(true);
    expect(input.poll().controls).toEqual(ZERO_CONTROLS);
    gamepad = makeGamepad([1, -1, -1, 1]);
    expect(input.poll().controls).toEqual({ throttle: 1, yaw: 1, pitch: -1, roll: -1 });
    input.resetConfig();
    gamepad = makeGamepad([0.3, 0, 0, 0]);
    expect(input.poll().controls.yaw).toBeGreaterThan(0);
    input.dispose();
  });

  it('handles denied browser API and storage access', () => {
    vi.stubGlobal('navigator', { getGamepads: () => { throw new Error('SecurityError'); } });
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Storage denied'); },
      setItem: () => { throw new Error('Storage denied'); },
    });
    const input = new ControllerInput();
    expect(input.poll().supported).toBe(false);
    expect(input.poll().controls).toEqual(ZERO_CONTROLS);
    expect(input.calibrate()).toBe(false);
    expect(() => input.resetConfig()).not.toThrow();
    input.dispose();
  });
});

describe('keyboard flight controls', () => {
  it('overrides only active keyboard axes and clears held keys on blur', () => {
    const surface = new EventTarget();
    vi.stubGlobal('window', surface);
    vi.stubGlobal('navigator', { getGamepads: () => [makeGamepad([1, 1, -1, 0])] });
    const input = new ControllerInput();
    emitKey(surface, 'KeyW');
    const arrowEvent = emitKey(surface, 'ArrowUp');
    const frame = input.poll();
    expect(frame.controls).toEqual({ throttle: 1, yaw: 1, pitch: 1, roll: -1 });
    expect(frame.source).toBe('keyboard');
    expect(arrowEvent.defaultPrevented).toBe(true);
    emitKey(surface, 'ArrowUp', 'keyup');
    expect(input.poll().controls.pitch).toBe(0);
    surface.dispatchEvent(new Event('blur'));
    expect(input.poll().controls.throttle).toBe(-1);
    input.dispose();
  });

  it('queues actions once and discards repeated keydown events', () => {
    const surface = new EventTarget();
    vi.stubGlobal('window', surface);
    const input = new ControllerInput();
    expect(emitKey(surface, 'Space').defaultPrevented).toBe(true);
    expect(input.poll().actions).toEqual(['arm']);
    emitKey(surface, 'Space', 'keydown', true);
    expect(input.poll().actions).toEqual([]);
    emitKey(surface, 'Escape');
    expect(input.poll().actions).toEqual(['pause']);
    input.dispose();
    emitKey(surface, 'KeyW');
    expect(input.poll().controls).toEqual(ZERO_CONTROLS);
  });

  it('leaves form keyboard events alone', () => {
    class FormElement extends EventTarget {
      closest(): FormElement { return this; }
    }
    const surface = new EventTarget();
    const field = new FormElement();
    vi.stubGlobal('window', surface);
    vi.stubGlobal('Element', FormElement);
    const input = new ControllerInput();
    expect(emitKey(surface, 'Space', 'keydown', false, field).defaultPrevented).toBe(false);
    emitKey(surface, 'ArrowUp', 'keydown', false, field);
    expect(input.poll().actions).toEqual([]);
    expect(input.poll().controls).toEqual(ZERO_CONTROLS);
    input.dispose();
  });

  it('flies while a button has focus and releases keys after focus changes', () => {
    class FocusElement extends EventTarget {
      constructor(private tag: 'button' | 'input') { super(); }
      closest(selector: string): FocusElement | null {
        return selector.split(', ').includes(this.tag) ? this : null;
      }
    }
    const surface = new EventTarget();
    const button = new FocusElement('button');
    const field = new FocusElement('input');
    vi.stubGlobal('window', surface);
    vi.stubGlobal('Element', FocusElement);
    const input = new ControllerInput();
    emitKey(surface, 'KeyW', 'keydown', false, button);
    emitKey(surface, 'ArrowUp', 'keydown', false, button);
    emitKey(surface, 'KeyC', 'keydown', false, button);
    const frame = input.poll();
    expect(frame.controls.throttle).toBe(1);
    expect(frame.controls.pitch).toBe(1);
    expect(frame.actions).toEqual(['camera']);
    expect(emitKey(surface, 'Space', 'keydown', false, button).defaultPrevented).toBe(false);
    expect(input.poll().actions).toEqual([]);
    emitKey(surface, 'KeyW', 'keyup', false, field);
    emitKey(surface, 'ArrowUp', 'keyup', false, field);
    expect(input.poll().controls).toEqual(ZERO_CONTROLS);
    input.dispose();
  });
});
