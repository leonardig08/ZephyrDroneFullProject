export type FlightMode = 'STABILIZED';
export type CameraMode = 'ORBIT' | 'FPV';
export type CameraSensorMode = 'WIDE' | 'ZOOM' | 'IR';

export type CameraSettings = {
  orbitDistance: number;
  orbitHeight: number;
  orbitYaw: number;
  fpvHeight: number;
  fpvForward: number;
  fpvRight: number;
  fpvGimbalPitch: number;
  fpvGimbalYaw: number;
  fov: number;
};

export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type Attitude = {
  pitch: number;
  roll: number;
  yaw: number;
};

export type Quaternion = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type ManualInput = {
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
};

export type DroneState = {
  position: Vec3;
  velocity: Vec3;
  acceleration: Vec3;
  orientation: Quaternion;
  attitude: Attitude;
  angularVelocity: Vec3;
  angularAcceleration: Vec3;
  motorSpeeds: [number, number, number, number];
  motorRpms: [number, number, number, number];
  windVelocity: Vec3;
  sensors: SensorSample;
  battery: number;
  voltage: number;
  mode: FlightMode;
  armed: boolean;
  debug?: FlightDebugSample;
};

export type SensorSample = {
  gyro: Vec3;
  accelerometer: Vec3;
  gpsPosition: Vec3;
  baroAltitude: number;
  estimatedAttitude: Attitude;
};

export type FlightDebugSample = {
  t: number;
  input: ManualInput;
  hold: {
    active: boolean;
    x: number;
    z: number;
    error: number;
    speed: number;
    radialVelocity: number;
    stoppingDistance: number;
    phase: 'idle' | 'pilot' | 'brake' | 'hold' | 'nav' | 'settled';
  };
  targetVelocity: Vec3;
  desiredAcceleration: Vec3;
  smoothedAcceleration?: Vec3;
  attitudeTarget: Attitude;
  rateTarget?: Vec3;
  throttle: number;
};

export type WorldTrailPoint = Vec3 & {
  t?: number;
};

export type TelemetryMessage = {
  type: 'telemetry';
  position: Vec3;
  velocity: Vec3;
  attitude: Attitude;
  battery: number;
  mode: FlightMode;
  armed: boolean;
};

export type RcProtocolMessage = {
  type: 'rc';
  throttle: number;
  yaw: number;
  pitch: number;
  roll: number;
};

export type CommandProtocolMessage =
  | { type: 'command'; command: 'arm' | 'disarm' | 'toggle-arm' | 'land' | 'return-home' }
  | { type: 'command'; command: 'takeoff'; altitude: number };

export type SimulatorCommand = RcProtocolMessage | CommandProtocolMessage;

export const zeroVec3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });
