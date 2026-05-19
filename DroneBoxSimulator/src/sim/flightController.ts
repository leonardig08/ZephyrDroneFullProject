import { PidController } from './pidController';
import { MAVIC_3T_SPECS } from './mavic3tSpecs';
import type { Attitude, DroneState, FlightDebugSample, ManualInput, Vec3 } from './types';
import { add, sub, rotateVecByQuat } from './math3d';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const normalizeAngle = (value: number) => Math.atan2(Math.sin(value), Math.cos(value));
const angleDelta = (target: number, current: number) => normalizeAngle(target - current);
const horizontalSpeed = (value: Vec3) => Math.hypot(value.x, value.z);

const zeroVec = (): Vec3 => ({ x: 0, y: 0, z: 0 });

export class FlightController {
  private pitchRatePid = new PidController({
    kp: 0.48,
    ki: 0.006,
    kd: 0.030,
    integralLimit: 0.18,
    outputLimit: 1,
    derivativeAlpha: 0.16,
    derivativeLimit: 14,
    outputSlewRate: 30,
    integratorLeak: 2.2
  });

  private rollRatePid = new PidController({
    kp: 0.48,
    ki: 0.006,
    kd: 0.030,
    integralLimit: 0.18,
    outputLimit: 1,
    derivativeAlpha: 0.16,
    derivativeLimit: 14,
    outputSlewRate: 30,
    integratorLeak: 2.2
  });

  private yawRatePid = new PidController({
    kp: 0.92,
    ki: 0.002,
    kd: 0.018,
    integralLimit: 0.08,
    outputLimit: 1,
    derivativeAlpha: 0.18,
    derivativeLimit: 12,
    outputSlewRate: 22,
    integratorLeak: 3.2
  });

  private smoothedInput: ManualInput = { throttle: 0.5, yaw: 0, pitch: 0, roll: 0 };
  private horizontalAccelTarget: Vec3 = zeroVec();
  private tiltTarget = { pitch: 0, roll: 0 };
  private yawHold: number | null = null;
  private yawRateTarget = 0;
  private rateTarget: Vec3 = zeroVec();
  private holdPosition: { x: number; z: number } | null = null;
  private externalHold = false;
  private previousHorizontalStickActive = false;
  private lastDebug: FlightDebugSample | null = null;
  private holdPhase: FlightDebugSample['hold']['phase'] = 'idle';
  private radialVelocity = 0;
  private stoppingDistance = 0;

  compute(state: DroneState, input: ManualInput, dt: number): ManualInput {
    const safeDt = clamp(dt, 1 / 1000, 1 / 60);
    const shapedInput = this.shapeInput(input, safeDt);
    const attitudeTarget = this.computeHorizontalAttitudeTarget(state, shapedInput, safeDt);

    const pitchCorrection = this.computeAxisCommand(
      this.pitchRatePid,
      attitudeTarget.pitch,
      state.attitude.pitch,
      state.angularVelocity.x,
      safeDt
    );
    const rollCorrection = this.computeAxisCommand(
      this.rollRatePid,
      attitudeTarget.roll,
      state.attitude.roll,
      state.angularVelocity.z,
      safeDt
    );
    const yawCorrection = this.computeYawCommand(state, shapedInput, safeDt);

    return {
      throttle: shapedInput.throttle,
      yaw: yawCorrection,
      pitch: pitchCorrection,
      roll: rollCorrection
    };
  }

  reset() {
    this.pitchRatePid.reset();
    this.rollRatePid.reset();
    this.yawRatePid.reset();
    this.smoothedInput = { throttle: 0.5, yaw: 0, pitch: 0, roll: 0 };
    this.horizontalAccelTarget = zeroVec();
    this.tiltTarget = { pitch: 0, roll: 0 };
    this.yawHold = null;
    this.yawRateTarget = 0;
    this.rateTarget = zeroVec();
    this.holdPosition = null;
    this.externalHold = false;
    this.previousHorizontalStickActive = false;
    this.lastDebug = null;
    this.holdPhase = 'idle';
    this.radialVelocity = 0;
    this.stoppingDistance = 0;
  }

  setHoldPosition(x: number, z: number) {
    this.holdPosition = { x, z };
    this.externalHold = true;
    this.holdPhase = 'nav';
    this.horizontalAccelTarget = zeroVec();
  }

  releaseExternalHold() {
    this.externalHold = false;
  }

  getDebugSample() {
    return this.lastDebug;
  }

  private computeHorizontalAttitudeTarget(state: DroneState, input: ManualInput, dt: number): Attitude {
    if (state.position.y < 0.22) {
      this.holdPosition = { x: state.position.x, z: state.position.z };
      this.horizontalAccelTarget = zeroVec();
      this.tiltTarget = { pitch: 0, roll: 0 };
      this.holdPhase = 'idle';
      const attitudeTarget = { pitch: 0, roll: 0, yaw: state.attitude.yaw };
      this.lastDebug = this.makeDebugSample(state, input, zeroVec(), zeroVec(), attitudeTarget);
      return attitudeTarget;
    }

    const stickMagnitude = Math.hypot(input.pitch, input.roll);
    const stickActive = stickMagnitude > 0.045 && !this.externalHold;
    const yaw = state.attitude.yaw;
  

// Assi reali del drone ricavati dal quaternion fisico.
// Così quando il drone ruota davvero, anche il frame di controllo ruota davvero.
const bodyForwardWorld = rotateVecByQuat(
  { x: 0, y: 0, z: -1 },
  state.orientation
);

const bodyRightWorld = rotateVecByQuat(
  { x: 1, y: 0, z: 0 },
  state.orientation
);

const forward = {
  x: bodyForwardWorld.x,
  z: bodyForwardWorld.z
};

const right = {
  x: bodyRightWorld.x,
  z: bodyRightWorld.z
};
const forwardLen = Math.hypot(forward.x, forward.z) || 1;
forward.x /= forwardLen;
forward.z /= forwardLen;

const rightLen = Math.hypot(right.x, right.z) || 1;
right.x /= rightLen;
right.z /= rightLen;

    const currentVelocity = { x: state.velocity.x, y: 0, z: state.velocity.z };
    const speed = horizontalSpeed(currentVelocity);

    let desiredVelocity = zeroVec();
    let maxAcceleration :number = MAVIC_3T_SPECS.controller.maxHorizontalAccelerationMs2;
    let maxJerk :number= MAVIC_3T_SPECS.controller.maxJerkMs3;

    if (stickActive) {
      this.holdPosition = null;
      this.holdPhase = 'pilot';
      desiredVelocity = {
        x: (forward.x * input.pitch + right.x * input.roll) * MAVIC_3T_SPECS.gpsHold.maxCommandSpeedMs,
        y: 0,
        z: (forward.z * input.pitch + right.z * input.roll) * MAVIC_3T_SPECS.gpsHold.maxCommandSpeedMs
      };
    } else {
      const shouldBrake = this.previousHorizontalStickActive || (this.holdPosition === null && speed > MAVIC_3T_SPECS.controller.brakeSnapSpeedMs);

      if (shouldBrake && !this.externalHold) {
  this.holdPhase = 'brake';
  this.holdPosition = null;
  desiredVelocity = zeroVec();

  maxAcceleration = MAVIC_3T_SPECS.controller.maxBrakeAccelerationMs2;
  maxJerk = MAVIC_3T_SPECS.controller.maxBrakeJerkMs3;
} else {
        if (this.holdPosition === null) {
          this.holdPosition = { x: state.position.x, z: state.position.z };
          this.horizontalAccelTarget = zeroVec();
        }

        desiredVelocity = this.computePositionHoldVelocity(state);
        maxAcceleration = MAVIC_3T_SPECS.controller.maxHorizontalAccelerationMs2;
        maxJerk = MAVIC_3T_SPECS.controller.maxJerkMs3;
      }
    }

    this.previousHorizontalStickActive = stickActive;

    const desiredAcceleration = this.computeHorizontalAcceleration(
      state,
      desiredVelocity,
      maxAcceleration,
      maxJerk,
      dt
    );


    const bodyForwardAccel =
  desiredAcceleration.x * forward.x +
  desiredAcceleration.z * forward.z;

const bodyRightAccel =
  desiredAcceleration.x * right.x +
  desiredAcceleration.z * right.z;

    const attitudeTarget = this.computeTiltTarget(bodyForwardAccel, bodyRightAccel, state.attitude.yaw, dt);
    this.lastDebug = this.makeDebugSample(state, input, desiredVelocity, desiredAcceleration, attitudeTarget);
    return attitudeTarget;
  }

  private computePositionHoldVelocity(state: DroneState): Vec3 {
    if (this.holdPosition === null) {
      this.holdPhase = 'idle';
      this.radialVelocity = 0;
      this.stoppingDistance = 0;
      return zeroVec();
    }

    const errorX = this.holdPosition.x - state.position.x;
    const errorZ = this.holdPosition.z - state.position.z;
    const distance = Math.hypot(errorX, errorZ);
    const speed = Math.hypot(state.velocity.x, state.velocity.z);

    if (distance < MAVIC_3T_SPECS.controller.holdSnapDistanceM && speed < MAVIC_3T_SPECS.controller.holdSnapSpeedMs) {
      this.holdPhase = 'settled';
      this.radialVelocity = speed;
      this.stoppingDistance = 0;
      return zeroVec();
    }

    if (distance <= 0.0001) {
      this.holdPhase = this.externalHold ? 'nav' : 'hold';
      this.radialVelocity = speed;
      this.stoppingDistance = 0;
      return zeroVec();
    }

    const dirX = errorX / distance;
    const dirZ = errorZ / distance;
    const radialVelocity = state.velocity.x * dirX + state.velocity.z * dirZ;
    const stoppingDistance =
      radialVelocity > 0
        ? (radialVelocity * radialVelocity * MAVIC_3T_SPECS.gpsHold.stoppingDistanceMargin) /
          (2 * MAVIC_3T_SPECS.gpsHold.stoppingDecelMs2)
        : 0;

    const maxSpeed = this.externalHold ? MAVIC_3T_SPECS.gpsHold.maxNavSpeedMs : MAVIC_3T_SPECS.gpsHold.maxHoldSpeedMs;
    const proportionalSpeed = distance * MAVIC_3T_SPECS.gpsHold.positionKp;
    const stoppingLimitedSpeed = Math.sqrt(Math.max(0, 2 * MAVIC_3T_SPECS.gpsHold.stoppingDecelMs2 * distance));
    const desiredSpeed = clamp(Math.min(proportionalSpeed, stoppingLimitedSpeed), 0, maxSpeed);

    this.holdPhase = this.externalHold ? 'nav' : 'hold';
    this.radialVelocity = radialVelocity;
    this.stoppingDistance = stoppingDistance;

    return { x: dirX * desiredSpeed, y: 0, z: dirZ * desiredSpeed };
  }

  private computeHorizontalAcceleration(
    state: DroneState,
    desiredVelocity: Vec3,
    maxAcceleration: number,
    maxJerk: number,
    dt: number
  ): Vec3 {
    const braking = this.holdPhase === 'brake';
    const settled = this.holdPhase === 'settled';
    const currentVelocity = { x: state.velocity.x, y: 0, z: state.velocity.z };
    const speed = horizontalSpeed(currentVelocity);

    if ((braking || settled) && speed < MAVIC_3T_SPECS.controller.brakeSnapSpeedMs) {
      this.horizontalAccelTarget = zeroVec();
      return zeroVec();
    }

    const velocityKp = braking
      ? MAVIC_3T_SPECS.controller.brakeVelocityKp
      : this.holdPhase === 'hold' || settled
        ? MAVIC_3T_SPECS.controller.holdVelocityKp
        : MAVIC_3T_SPECS.controller.velocityKp;

    const rawAcceleration = this.clampHorizontalMagnitude(
      {
        x: (desiredVelocity.x - state.velocity.x) * velocityKp - state.velocity.x * MAVIC_3T_SPECS.controller.velocityDamping,
        y: 0,
        z: (desiredVelocity.z - state.velocity.z) * velocityKp - state.velocity.z * MAVIC_3T_SPECS.controller.velocityDamping
      },
      maxAcceleration
    );

    const maxDelta = maxJerk * dt;
    const delta = this.clampHorizontalMagnitude(sub(rawAcceleration, this.horizontalAccelTarget), maxDelta);
    let nextAcceleration = add(this.horizontalAccelTarget, delta);

    if (braking && speed > 0.0001) {
      const dotWithVelocity = nextAcceleration.x * state.velocity.x + nextAcceleration.z * state.velocity.z;
      if (dotWithVelocity > 0) {
        nextAcceleration = zeroVec();
      }
    }

    this.horizontalAccelTarget = nextAcceleration;
    return nextAcceleration;
  }

  private computeAxisCommand(
    ratePid: PidController,
    targetAngle: number,
    currentAngle: number,
    currentRate: number,
    dt: number
  ) {
    const angleError = targetAngle - currentAngle;
    const desiredRate = clamp(
      angleError * MAVIC_3T_SPECS.controller.angleKp,
      -MAVIC_3T_SPECS.controller.angleRateLimitRadS,
      MAVIC_3T_SPECS.controller.angleRateLimitRadS
    );

    if (ratePid === this.pitchRatePid) {
      this.rateTarget.x = desiredRate;
    } else {
      this.rateTarget.z = desiredRate;
    }

    return ratePid.update(desiredRate, currentRate, dt);
  }

  private computeYawCommand(state: DroneState, input: ManualInput, dt: number) {
    if (this.yawHold === null) {
      this.yawHold = state.attitude.yaw;
    }

    const stickActive = Math.abs(input.yaw) > 0.045;
    const maxYawRate = MAVIC_3T_SPECS.controller.yawRateMaxRadS;
    const rawTargetRate = stickActive
      ? -input.yaw * maxYawRate
      : clamp(
          angleDelta(this.yawHold, state.attitude.yaw) * MAVIC_3T_SPECS.controller.yawHoldKp -
            state.angularVelocity.y * MAVIC_3T_SPECS.controller.yawHoldDamping,
          -maxYawRate,
          maxYawRate
        );

    const yawAccel = stickActive ? MAVIC_3T_SPECS.controller.yawAccelRadS2 : MAVIC_3T_SPECS.controller.yawBrakeAccelRadS2;
    this.yawRateTarget += clamp(rawTargetRate - this.yawRateTarget, -yawAccel * dt, yawAccel * dt);

    if (stickActive) {
      this.yawHold = state.attitude.yaw;
    } else if (Math.abs(this.yawRateTarget) < 0.01 && Math.abs(state.angularVelocity.y) < 0.015) {
      this.yawRateTarget = 0;
      this.yawHold = state.attitude.yaw;
    }

    this.rateTarget.y = this.yawRateTarget;
    return this.yawRatePid.update(this.yawRateTarget, state.angularVelocity.y, dt);
  }

  private shapeInput(input: ManualInput, dt: number): ManualInput {
    const expo = (value: number) => {
      const cubic = value * value * value;
      return value * (1 - MAVIC_3T_SPECS.controller.inputExpo) + cubic * MAVIC_3T_SPECS.controller.inputExpo;
    };

    const target = {
      throttle: input.throttle,
      yaw: expo(input.yaw),
      pitch: expo(input.pitch),
      roll: expo(input.roll)
    };

    const alpha = 1 - Math.exp(-MAVIC_3T_SPECS.controller.inputSmooth * dt);
    this.smoothedInput = {
      throttle: this.smoothedInput.throttle + (target.throttle - this.smoothedInput.throttle) * alpha,
      yaw: this.smoothedInput.yaw + (target.yaw - this.smoothedInput.yaw) * alpha,
      pitch: this.smoothedInput.pitch + (target.pitch - this.smoothedInput.pitch) * alpha,
      roll: this.smoothedInput.roll + (target.roll - this.smoothedInput.roll) * alpha
    };

    return this.smoothedInput;
  }

  private computeTiltTarget(bodyForwardAccel: number, bodyRightAccel: number, yaw: number, dt: number): Attitude {
    let pitch = -bodyForwardAccel / 9.81;
let roll = -bodyRightAccel / 9.81;

    const magnitude = Math.hypot(pitch, roll);
    if (magnitude > MAVIC_3T_SPECS.maxTiltNormalRad) {
      const scale = MAVIC_3T_SPECS.maxTiltNormalRad / magnitude;
      pitch *= scale;
      roll *= scale;
    }

    const returningToLevel = Math.hypot(pitch, roll) < Math.hypot(this.tiltTarget.pitch, this.tiltTarget.roll);
    const slewRate = returningToLevel
      ? MAVIC_3T_SPECS.controller.tiltReturnSlewRateRadS
      : MAVIC_3T_SPECS.controller.tiltSlewRateRadS;
    const maxStep = slewRate * dt;
    const deltaPitch = pitch - this.tiltTarget.pitch;
    const deltaRoll = roll - this.tiltTarget.roll;
    const deltaMagnitude = Math.hypot(deltaPitch, deltaRoll);

    if (deltaMagnitude > maxStep && deltaMagnitude > 0.000001) {
      const scale = maxStep / deltaMagnitude;
      this.tiltTarget.pitch += deltaPitch * scale;
      this.tiltTarget.roll += deltaRoll * scale;
    } else {
      this.tiltTarget = { pitch, roll };
    }

    if (Math.abs(this.tiltTarget.pitch) < 0.0005) this.tiltTarget.pitch = 0;
    if (Math.abs(this.tiltTarget.roll) < 0.0005) this.tiltTarget.roll = 0;

    return { pitch: this.tiltTarget.pitch, roll: this.tiltTarget.roll, yaw };
  }

  private clampHorizontalMagnitude(value: Vec3, maxMagnitude: number): Vec3 {
    const magnitude = Math.hypot(value.x, value.z);
    if (magnitude <= maxMagnitude || magnitude <= 0.000001) {
      return { x: value.x, y: 0, z: value.z };
    }

    const scale = maxMagnitude / magnitude;
    return { x: value.x * scale, y: 0, z: value.z * scale };
  }

  private makeDebugSample(
    state: DroneState,
    input: ManualInput,
    targetVelocity: Vec3,
    desiredAcceleration: Vec3,
    attitudeTarget: Attitude
  ): FlightDebugSample {
    const holdError = this.holdPosition
      ? Math.hypot(this.holdPosition.x - state.position.x, this.holdPosition.z - state.position.z)
      : 0;

    return {
      t: performance.now() / 1000,
      input: { ...input },
      hold: {
        active: this.holdPosition !== null || this.holdPhase === 'brake',
        x: this.holdPosition?.x ?? state.position.x,
        z: this.holdPosition?.z ?? state.position.z,
        error: holdError,
        speed: Math.hypot(state.velocity.x, state.velocity.z),
        radialVelocity: this.radialVelocity,
        stoppingDistance: this.stoppingDistance,
        phase: this.holdPhase
      },
      targetVelocity,
      desiredAcceleration,
      smoothedAcceleration: this.horizontalAccelTarget,
      attitudeTarget,
      rateTarget: this.rateTarget,
      throttle: input.throttle
    };
  }
}
