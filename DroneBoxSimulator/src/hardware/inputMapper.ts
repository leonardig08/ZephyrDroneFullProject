import type { ManualInput, SimulatorCommand } from '../sim/types';

type InputMapperEvents = {
  onInput: (input: ManualInput) => void;
  onCommand: (command: SimulatorCommand) => void;
  isGamepadEnabled?: () => boolean;
  canToggleArmWithGamepad?: () => boolean;
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const applyDeadzone = (value: number, deadzone = 0.08) => {
  const magnitude = Math.abs(value);
  if (magnitude < deadzone) {
    return 0;
  }

  return Math.sign(value) * ((magnitude - deadzone) / (1 - deadzone));
};
const expo = (value: number) => value * 0.55 + value * value * value * 0.45;

export class KeyboardInputMapper {
  private pressed = new Set<string>();
  private frame = 0;
  private previousArmButton = false;
  private previousArmCombo = false;
  private previousLandButton = false;
  private previousRthButton = false;

  constructor(private readonly events: InputMapperEvents) {}

  start() {
    window.addEventListener('keydown', this.keydown);
    window.addEventListener('keyup', this.keyup);
    this.tick();
  }

  stop() {
    window.removeEventListener('keydown', this.keydown);
    window.removeEventListener('keyup', this.keyup);
    cancelAnimationFrame(this.frame);
  }

  private keydown = (event: KeyboardEvent) => {
    if (event.repeat) {
      return;
    }

    this.pressed.add(event.code);
    if (['Space', 'ShiftLeft', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(event.code)) {
      event.preventDefault();
    }

    if (event.code === 'KeyR') {
      this.events.onCommand({ type: 'command', command: 'toggle-arm' });
    }

    if (event.code === 'KeyX') {
      this.events.onCommand({ type: 'command', command: 'disarm' });
    }

    if (event.code === 'Digit0') {
      this.events.onCommand({ type: 'command', command: 'disarm' });
    }

  };

  private keyup = (event: KeyboardEvent) => {
    this.pressed.delete(event.code);
  };

  private tick = () => {
    const keyboardInput = this.keyboardInput();
    const gamepadInput = this.events.isGamepadEnabled?.() ? this.gamepadInput() : null;
    const input = gamepadInput ?? keyboardInput;

    this.events.onInput(input);
    this.frame = requestAnimationFrame(this.tick);
  };

  private keyboardInput(): ManualInput {
    const verticalStick = this.pressed.has('Space') ? 1 : this.pressed.has('ShiftLeft') ? 0 : 0.5;
    return {
      throttle: clamp(verticalStick, 0, 1),
      yaw: (this.pressed.has('KeyE') ? 1 : 0) + (this.pressed.has('KeyQ') ? -1 : 0),
      pitch: (this.pressed.has('KeyW') ? 1 : 0) + (this.pressed.has('KeyS') ? -1 : 0),
      roll: (this.pressed.has('KeyD') ? 1 : 0) + (this.pressed.has('KeyA') ? -1 : 0)
    };
  }

  private gamepadInput(): ManualInput | null {
    const gamepad = navigator.getGamepads().find((pad) => pad && /dualshock|dualsense|wireless controller|playstation/i.test(pad.id));
    if (!gamepad) {
      return null;
    }

    const armButton = Boolean(gamepad.buttons[9]?.pressed);
    const landButton = Boolean(gamepad.buttons[1]?.pressed);
    const rthButton = Boolean(gamepad.buttons[8]?.pressed);

    const rawLeftX = gamepad.axes[0] ?? 0;
    const rawRightX = gamepad.axes[2] ?? 0;
    const rawLeftY = gamepad.axes[1] ?? 0;
    const rawRightY = gamepad.axes[3] ?? 0;
    const armCombo =
      rawLeftX > 0.72 &&
      rawRightX < -0.72 &&
      Math.abs(rawLeftY) < 0.58 &&
      Math.abs(rawRightY) < 0.58;

    if (
      ((armButton && !this.previousArmButton) ||
        (armCombo && !this.previousArmCombo)) &&
      (this.events.canToggleArmWithGamepad?.() ?? true)
    ) {
      this.events.onCommand({ type: 'command', command: 'toggle-arm' });
    }
    if (landButton && !this.previousLandButton) {
      this.events.onCommand({ type: 'command', command: 'land' });
    }
    if (rthButton && !this.previousRthButton) {
      this.events.onCommand({ type: 'command', command: 'return-home' });
    }
    this.previousArmButton = armButton;
    this.previousArmCombo = armCombo;
    this.previousLandButton = landButton;
    this.previousRthButton = rthButton;

    const leftX = expo(applyDeadzone(rawLeftX));
    const leftY = expo(applyDeadzone(-rawLeftY));
    const rightX = expo(applyDeadzone(rawRightX));
    const rightY = expo(applyDeadzone(-rawRightY));

    return {
      throttle: clamp(0.5 + leftY * 0.5, 0, 1),
      yaw: clamp(leftX, -1, 1),
      pitch: clamp(rightY, -1, 1),
      roll: clamp(rightX, -1, 1)
    };
  }
}
