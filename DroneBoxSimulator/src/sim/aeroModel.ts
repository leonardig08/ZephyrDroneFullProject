import type { Vec3 } from './types';
import { MAVIC_3T_SPECS } from './mavic3tSpecs';
import { sub } from './math3d';

export const dragForce = (velocity: Vec3, windVelocity: Vec3): Vec3 => {
  const relativeAirVelocity = sub(velocity, windVelocity);
  return {
    x: -relativeAirVelocity.x * MAVIC_3T_SPECS.linearDrag.x,
    y: -relativeAirVelocity.y * MAVIC_3T_SPECS.linearDrag.y,
    z: -relativeAirVelocity.z * MAVIC_3T_SPECS.linearDrag.z
  };
};

export const angularDragTorque = (angularVelocity: Vec3): Vec3 => ({
  x: -angularVelocity.x * MAVIC_3T_SPECS.angularDrag.x,
  y: -angularVelocity.y * MAVIC_3T_SPECS.angularDrag.y,
  z: -angularVelocity.z * MAVIC_3T_SPECS.angularDrag.z
});
