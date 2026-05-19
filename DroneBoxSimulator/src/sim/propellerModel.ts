import { MAVIC_3T_SPECS } from './mavic3tSpecs';

export const maxMotorRpm = Math.sqrt(MAVIC_3T_SPECS.maxSingleMotorThrustN / MAVIC_3T_SPECS.motor.thrustCoeff);

export const motorCommandToTargetRpm = (motorCommand: number) => motorCommand * maxMotorRpm;

export const updateMotorRpm = (
  currentRpm: number,
  targetRpm: number,
  dt: number,
  response: number = MAVIC_3T_SPECS.motor.response
) => {
  const alpha = 1 - Math.exp(-response * Math.max(0, dt));
  return currentRpm + (targetRpm - currentRpm) * alpha;
};

export const motorThrustNewtonsFromRpm = (rpm: number) => MAVIC_3T_SPECS.motor.thrustCoeff * rpm * rpm;

export const motorTorqueFromRpm = (rpm: number, direction: 1 | -1) =>
  direction * MAVIC_3T_SPECS.motor.torqueCoeff * rpm * rpm;
