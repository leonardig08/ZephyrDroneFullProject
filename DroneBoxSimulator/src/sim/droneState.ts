import type { DroneState } from './types';
import { quaternionFromAttitude } from './math3d';

const GROUND_CLEARANCE_M = 0;

export const createInitialDroneState = (): DroneState => ({
  position: { x: 0, y: GROUND_CLEARANCE_M, z: 0 },
  velocity: { x: 0, y: 0, z: 0 },
  acceleration: { x: 0, y: 0, z: 0 },
  orientation: quaternionFromAttitude({ pitch: 0, roll: 0, yaw: 0 }),
  attitude: { pitch: 0, roll: 0, yaw: 0 },
  angularVelocity: { x: 0, y: 0, z: 0 },
  angularAcceleration: { x: 0, y: 0, z: 0 },
  motorSpeeds: [0, 0, 0, 0],
  motorRpms: [0, 0, 0, 0],
  windVelocity: { x: 0, y: 0, z: 0 },
  sensors: {
    gyro: { x: 0, y: 0, z: 0 },
    accelerometer: { x: 0, y: 0, z: 0 },
    gpsPosition: { x: 0, y: GROUND_CLEARANCE_M, z: 0 },
    baroAltitude: GROUND_CLEARANCE_M,
    estimatedAttitude: { pitch: 0, roll: 0, yaw: 0 }
  },
  battery: 100,
  voltage: 17.6,
  mode: 'STABILIZED',
  armed: false
});
