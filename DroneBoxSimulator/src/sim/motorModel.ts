import type { ManualInput } from './types';
import { MAVIC_3T_SPECS } from './mavic3tSpecs';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const mixQuadXMotors = (input: ManualInput, voltage: number): [number, number, number, number] => {
  const voltageScale = clamp(voltage / MAVIC_3T_SPECS.battery.nominalVoltage, 0.86, 1.05);
  const base = clamp(input.throttle * voltageScale, MAVIC_3T_SPECS.motor.idleCommand, 0.95);

  const pitch = input.pitch * 0.225;
  const roll = input.roll * 0.225;
  const yaw = input.yaw * 0.072;

  const deltas = [pitch + roll - yaw, pitch - roll + yaw, -pitch + roll + yaw, -pitch - roll - yaw] as const;
  const maxDelta = Math.max(...deltas);
  const minDelta = Math.min(...deltas);
  const positiveScale = maxDelta > 0 ? (1 - base) / maxDelta : 1;
  const negativeScale = minDelta < 0 ? base / -minDelta : 1;
  const scale = clamp(Math.min(1, positiveScale, negativeScale), 0, 1);

  return deltas.map((delta) => clamp(base + delta * scale, 0, 1)) as [number, number, number, number];
};
