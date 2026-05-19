import type { Attitude } from './types';

export const computeFpvGimbal = (attitude: Attitude): Attitude => ({
  pitch: attitude.pitch * 0.35,
  roll: attitude.roll * 0.2,
  yaw: attitude.yaw
});
