import type { Attitude, Quaternion, Vec3 } from './types';

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const quat = (x = 0, y = 0, z = 0, w = 1): Quaternion => ({ x, y, z, w });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (value: Vec3, amount: number): Vec3 => ({ x: value.x * amount, y: value.y * amount, z: value.z * amount });
export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const length = (value: Vec3) => Math.hypot(value.x, value.y, value.z);
export const normalizeVec = (value: Vec3): Vec3 => {
  const magnitude = length(value);
  return magnitude > 0.000001 ? scale(value, 1 / magnitude) : vec3();
};

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const clampVec = (value: Vec3, min: number, max: number): Vec3 => ({
  x: clamp(value.x, min, max),
  y: clamp(value.y, min, max),
  z: clamp(value.z, min, max)
});

export const normalizeQuat = (value: Quaternion): Quaternion => {
  const magnitude = Math.hypot(value.x, value.y, value.z, value.w);
  if (magnitude <= 0.000001) {
    return quat();
  }

  return {
    x: value.x / magnitude,
    y: value.y / magnitude,
    z: value.z / magnitude,
    w: value.w / magnitude
  };
};

export const multiplyQuat = (a: Quaternion, b: Quaternion): Quaternion => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
});

export const rotateVecByQuat = (value: Vec3, q: Quaternion): Vec3 => {
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  const ix = qw * value.x + qy * value.z - qz * value.y;
  const iy = qw * value.y + qz * value.x - qx * value.z;
  const iz = qw * value.z + qx * value.y - qy * value.x;
  const iw = -qx * value.x - qy * value.y - qz * value.z;

  return {
    x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
    y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
    z: iz * qw + iw * -qz + ix * -qy - iy * -qx
  };
};

export const integrateOrientation = (orientation: Quaternion, angularVelocity: Vec3, dt: number): Quaternion => {
  const speed = length(angularVelocity);
  if (speed < 0.000001) {
    return orientation;
  }

  const axis = scale(angularVelocity, 1 / speed);
  const halfAngle = speed * dt * 0.5;
  const sinHalf = Math.sin(halfAngle);
  const delta = quat(axis.x * sinHalf, axis.y * sinHalf, axis.z * sinHalf, Math.cos(halfAngle));
  return normalizeQuat(multiplyQuat(orientation, delta));
};

export const attitudeFromQuaternion = (q: Quaternion): Attitude => {
  const sinp = 2 * (q.w * q.x - q.z * q.y);
  const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * Math.PI * 0.5 : Math.asin(sinp);
  const roll = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.x * q.x + q.z * q.z));
  const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.x * q.x + q.y * q.y));
  return { pitch, roll, yaw };
};

export const quaternionFromAttitude = ({ pitch, roll, yaw }: Attitude): Quaternion => {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);

  return normalizeQuat({
    x: sp * cy * cr + cp * sy * sr,
    y: cp * sy * cr - sp * cy * sr,
    z: cp * cy * sr - sp * sy * cr,
    w: cp * cy * cr + sp * sy * sr
  });
};
