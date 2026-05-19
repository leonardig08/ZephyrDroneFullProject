export const MAVIC_3T_SPECS = {
  massKg: 0.92,
  maxTakeoffMassKg: 1.05,
  armLengthM: 0.19,
  propellerDiameterM: 0.239,
  propellerPitchM: 0.135,
  propellerCt: 0.115,
  propellerCq: 0.016,
  airDensityKgM3: 1.225,
  maxSingleMotorThrustN: 6.35,
  frontalAreaM2: 0.052,
  sideAreaM2: 0.068,
  verticalAreaM2: 0.16,
  dragCoefficient: 1.05,
  maxHorizontalSpeedNormalMs: 12,
  maxTiltNormalRad: 0.61,
  motor: {
    response: 34,
    thrustCoeff: 6.35 / (16500 * 16500),
    torqueCoeff: 0.0000000032,
    idleCommand: 0.075
  },
  landing: {
  fastDescentMs: 2.35,
  slowDescentMs: 0.12,
  flareStartM: 8.5,
  touchdownSlowM: 0.45
},
  controller: {
    inputSmooth: 14,
    inputExpo: 0.42,
    maxJerkMs3: 95,
    maxBrakeJerkMs3: 95,
    maxHorizontalAccelerationMs2: 9.5,
    maxBrakeAccelerationMs2: 9.5,
    tiltSlewRateRadS: 8.6,
    tiltReturnSlewRateRadS: 13.5,
    velocityKp: 5.2,
    brakeVelocityKp: 5.7,
    holdVelocityKp: 3.1,
    velocityDamping: 0.12,
    brakeSnapSpeedMs: 0.075,
    holdSnapSpeedMs: 0.055,
    holdSnapDistanceM: 0.08,
    yawAccelRadS2: 4.8,
    yawBrakeAccelRadS2: 7.5,
    yawRateMaxRadS: 1.55,
    yawHoldKp: 3.4,
    yawHoldDamping: 0.48,
    angleKp: 9.2,
    angleRateLimitRadS: 4.8
  },
  linearDrag: {
    x: 0.22,
    y: 0.68,
    z: 0.22
  },
  groundEffect: {
    strength: 0.11,
    maxMultiplier: 1.12
  },
  sensors: {
    gyroNoiseRadS: 0.0035,
    accelerometerNoiseMs2: 0.045,
    gpsNoiseM: 0.018,
    baroNoiseM: 0.012,
    attitudeComplementaryAlpha: 0.035
  },
  gpsHold: {
    maxCommandSpeedMs: 12,
    positionKp: 0.95,
    maxHoldSpeedMs: 1.15,
    maxNavSpeedMs: 3.3,
    stoppingDecelMs2: 6.6,
    stoppingDistanceMargin: 1.15
  },
  angularDrag: {
    pitch: 0.2,
    yaw: 0.16,
    roll: 0.2,
    x: 0.2,
    y: 0.16,
    z: 0.2
  },
  maxAscentSpeedMs: 6,
  maxDescentSpeedMs: 6,
  altitudeHold: {
  velocityKp: 4.6,
  holdKp: 1.65,
  brakeKp: 6.8,
  maxAccelerationMs2: 9.5,
  maxBrakeAccelerationMs2: 11.5,
  maxJerkMs3: 85,
  takeoffClimbMs: 1.35
},
  maxWindResistanceMs: 12,
  battery: {
    capacityWh: 77,
    nominalVoltage: 15.4,
    fullVoltage: 17.6,
    emptyVoltage: 12.8,
    internalResistanceOhm: 0.065,
    hoverPowerW: 122,
    maxPowerW: 760
  }
} as const;

export const MAVIC_3T_INERTIA = {
  x: 0.0115,
  y: 0.018,
  z: 0.014
} as const;
