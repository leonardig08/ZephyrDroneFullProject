import { angularDragTorque, dragForce } from "./aeroModel";
import { updateBattery } from "./batteryModel";
import { FlightController } from "./flightController";
import { MAVIC_3T_INERTIA, MAVIC_3T_SPECS } from "./mavic3tSpecs";
import {
  attitudeFromQuaternion,
  clamp,
  integrateOrientation,
  rotateVecByQuat,
} from "./math3d";
import { mixQuadXMotors } from "./motorModel";
import {
  motorCommandToTargetRpm,
  motorThrustNewtonsFromRpm,
  motorTorqueFromRpm,
  updateMotorRpm,
} from "./propellerModel";
import type {
  DroneState,
  ManualInput,
  SimulatorCommand,
  TelemetryMessage,
  Vec3,
} from "./types";

const GRAVITY = 9.81;
const GROUND_CLEARANCE_M = 0;
const RTH_ALTITUDE_M = 12;
const MAX_SUBSTEP = 1 / 240;
const MAX_FRAME_DT = 1 / 20;
const DISARMED_MOTOR_BRAKE_RESPONSE = 4.8;
const MANUAL_LANDING_PROFILE_ALTITUDE_M = 10.0;

const addForce = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});
const horizontalSpeed = (value: Vec3) => Math.hypot(value.x, value.z);

export class PhysicsLoop {
  private input: ManualInput = { throttle: 0.5, yaw: 0, pitch: 0, roll: 0 };
  private controller = new FlightController();
  private takeoffTarget: number | null = null;
  private altitudeTarget = GROUND_CLEARANCE_M;
  private verticalVelocityTarget = 0;
  private verticalAccelerationTarget = 0;
  private previousVerticalStickActive = false;
  private verticalBrakeActive = false;
  private homePosition = { x: 0, z: 0 };
  private navMode:
    | "manual"
    | "takeoff"
    | "landing"
    | "rth-climb"
    | "rth-return"
    | "rth-land" = "manual";
  private touchdownTimer = 0;
  private groundContact = false;
  private landingCancelStickLock = false;

  constructor(private readonly state: DroneState) {
    if (this.state.position.y < GROUND_CLEARANCE_M) {
      this.state.position.y = GROUND_CLEARANCE_M;
    }
    this.altitudeTarget = Math.max(GROUND_CLEARANCE_M, this.state.position.y);
  }

  handleCommand(message: SimulatorCommand) {
    if (message.type === "rc") {
      const nextInput = {
        throttle: clamp(message.throttle, 0, 1),
        yaw: clamp(message.yaw, -1, 1),
        pitch: clamp(message.pitch, -1, 1),
        roll: clamp(message.roll, -1, 1),
      };
      const stickPressed =
        Math.abs((nextInput.throttle - 0.5) * 2) > 0.08 ||
        Math.abs(nextInput.yaw) > 0.08 ||
        Math.hypot(nextInput.pitch, nextInput.roll) > 0.08;
      const verticalStick = (nextInput.throttle - 0.5) * 2;
      const autonomousMode =
        this.navMode === "landing" ||
        this.navMode === "rth-climb" ||
        this.navMode === "rth-return" ||
        this.navMode === "rth-land";

      this.input = {
        throttle: nextInput.throttle,
        yaw: nextInput.yaw,
        pitch: nextInput.pitch,
        roll: nextInput.roll,
      };

      if (stickPressed && autonomousMode) {
        this.cancelAutonomousToManualHold(Math.abs(verticalStick) > 0.08);
      }

      if (this.navMode === "manual") {
        this.controller.releaseExternalHold();
      }
      return;
    }

    if (message.command === "arm") {
      this.state.armed = true;
      this.captureHome();
      this.altitudeTarget = Math.max(GROUND_CLEARANCE_M, this.state.position.y);
    } else if (message.command === "disarm") {
      this.disarm();
    } else if (message.command === "toggle-arm") {
      if (!this.state.armed) {
        this.state.armed = true;
        this.captureHome();
        this.altitudeTarget = Math.max(
          GROUND_CLEARANCE_M,
          this.state.position.y,
        );
      } else if (this.isGrounded()) {
        this.state.armed = false;
        this.state.motorSpeeds = [0, 0, 0, 0];
      }
      this.navMode = "manual";
    } else if (message.command === "takeoff") {
      this.state.armed = true;

      const targetAltitude = message.altitude ?? 1.2;

      this.takeoffTarget = Math.max(GROUND_CLEARANCE_M + 0.8, targetAltitude);
      this.altitudeTarget = GROUND_CLEARANCE_M;
      this.verticalVelocityTarget = MAVIC_3T_SPECS.altitudeHold.takeoffClimbMs;
      this.verticalAccelerationTarget = 0;
      this.verticalBrakeActive = false;
      this.previousVerticalStickActive = false;

      this.navMode = "takeoff";

      this.captureHome();
      this.controller.setHoldPosition(
        this.state.position.x,
        this.state.position.z,
      );
    } else if (message.command === "land") {
      this.touchdownTimer = 0;
      this.groundContact = false;
      this.state.armed = true;
      this.takeoffTarget = null;
      this.navMode = "landing";
      this.altitudeTarget = Math.max(GROUND_CLEARANCE_M, this.state.position.y);
      this.controller.setHoldPosition(
        this.state.position.x,
        this.state.position.z,
      );
    } else if (message.command === "return-home") {
      this.state.armed = true;
      this.takeoffTarget = null;
      this.navMode = "rth-climb";
      this.altitudeTarget = Math.max(RTH_ALTITUDE_M, this.state.position.y);
      this.controller.setHoldPosition(
        this.state.position.x,
        this.state.position.z,
      );
    }
  }

  step(dt: number) {
    const frameDt = clamp(dt, 0, MAX_FRAME_DT);
    const steps = Math.max(1, Math.ceil(frameDt / MAX_SUBSTEP));
    const subDt = frameDt / steps;

    for (let i = 0; i < steps; i += 1) {
      this.stepInternal(subDt);
    }
  }

  telemetry(): TelemetryMessage {
    return {
      type: "telemetry",
      position: { ...this.state.position },
      velocity: { ...this.state.velocity },
      attitude: { ...this.state.attitude },
      battery: this.state.battery,
      mode: this.state.mode,
      armed: this.state.armed,
    };
  }

  snapshot(): DroneState {
    return structuredClone(this.state);
  }

  private stepInternal(dt: number) {
    this.updateNavigation(dt);
    const autopilotInput = this.withAltitudeHold(
      this.withTakeoffAssist(this.input),
      dt,
    );
    const controlledInput = this.state.armed
      ? this.controller.compute(this.state, autopilotInput, dt)
      : { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    this.state.debug = this.controller.getDebugSample() ?? undefined;

    const motorCommands: [number, number, number, number] = this.state.armed
      ? mixQuadXMotors(controlledInput, this.state.voltage)
      : [0, 0, 0, 0];

    this.state.motorRpms = this.state.motorRpms.map((rpm, index) =>
      updateMotorRpm(
        rpm,
        motorCommandToTargetRpm(motorCommands[index]),
        dt,
        this.state.armed ? undefined : DISARMED_MOTOR_BRAKE_RESPONSE,
      ),
    ) as [number, number, number, number];
    this.state.motorSpeeds = motorCommands;

    const thrusts = this.state.armed
      ? this.state.motorRpms.map(motorThrustNewtonsFromRpm) as [
          number,
          number,
          number,
          number,
        ]
      : [0, 0, 0, 0] as [number, number, number, number];
    const totalThrust =
      thrusts.reduce((sum, value) => sum + value, 0) *
      this.groundEffectMultiplier();
    const lift = rotateVecByQuat(
      { x: 0, y: totalThrust, z: 0 },
      this.state.orientation,
    );
    const gravity = { x: 0, y: -GRAVITY * MAVIC_3T_SPECS.massKg, z: 0 };
    const drag = dragForce(this.state.velocity, this.state.windVelocity);
    const totalForce = addForce(addForce(lift, gravity), drag);

    this.state.acceleration = {
      x: totalForce.x / MAVIC_3T_SPECS.massKg,
      y: totalForce.y / MAVIC_3T_SPECS.massKg,
      z: totalForce.z / MAVIC_3T_SPECS.massKg,
    };

    this.state.velocity.x += this.state.acceleration.x * dt;
    this.state.velocity.y += this.state.acceleration.y * dt;
    this.state.velocity.z += this.state.acceleration.z * dt;

    this.limitHorizontalSpeed();

    this.applyMicroStopSnap();

    this.state.position.x += this.state.velocity.x * dt;
    this.state.position.y += this.state.velocity.y * dt;
    this.state.position.z += this.state.velocity.z * dt;

    const torque = this.computeRotorTorque(thrusts);
    const damping = angularDragTorque(this.state.angularVelocity);
    this.state.angularAcceleration = {
      x: (torque.x + damping.x) / MAVIC_3T_INERTIA.x,
      y: (torque.y + damping.y) / MAVIC_3T_INERTIA.y,
      z: (torque.z + damping.z) / MAVIC_3T_INERTIA.z,
    };

    this.state.angularVelocity.x = clamp(
      this.state.angularVelocity.x + this.state.angularAcceleration.x * dt,
      -6.5,
      6.5,
    );
    this.state.angularVelocity.y = clamp(
      this.state.angularVelocity.y + this.state.angularAcceleration.y * dt,
      -4.2,
      4.2,
    );
    this.state.angularVelocity.z = clamp(
      this.state.angularVelocity.z + this.state.angularAcceleration.z * dt,
      -6.5,
      6.5,
    );

    this.state.orientation = integrateOrientation(
      this.state.orientation,
      this.state.angularVelocity,
      dt,
    );
    this.state.attitude = attitudeFromQuaternion(this.state.orientation);
    this.updateSensors();
    this.resolveGroundContact();

    const load =
      this.state.motorSpeeds.reduce((sum, speed) => sum + speed * speed, 0) / 4;
    const battery = updateBattery({
      batteryPercent: this.state.battery,
      throttleLoad: load,
      dt,
    });
    this.state.battery = battery.battery;
    this.state.voltage = battery.voltage;
  }

  private computeRotorTorque(thrusts: [number, number, number, number]): Vec3 {
    const arm = MAVIC_3T_SPECS.armLengthM / Math.SQRT2;
    const positions = [
      { x: -arm, z: -arm },
      { x: arm, z: -arm },
      { x: -arm, z: arm },
      { x: arm, z: arm },
    ] as const;
    const yawDirections = [-1, 1, 1, -1] as const;

    return thrusts.reduce(
      (torque, thrust, index) => ({
        x: torque.x - positions[index].z * thrust,
        y:
          torque.y +
          motorTorqueFromRpm(this.state.motorRpms[index], yawDirections[index]),
        z: torque.z - positions[index].x * thrust,
      }),
      { x: 0, y: 0, z: 0 },
    );
  }

  private withTakeoffAssist(input: ManualInput): ManualInput {
    if (this.navMode !== "takeoff" || this.takeoffTarget === null) {
      return input;
    }

    const verticalStick = (input.throttle - 0.5) * 2;

    // Se il pilota prende controllo verticale, esci dal takeoff automatico.
    if (Math.abs(verticalStick) > 0.12) {
      this.takeoffTarget = null;
      this.navMode = "manual";
      this.altitudeTarget = Math.max(GROUND_CLEARANCE_M, this.state.position.y);
      this.verticalVelocityTarget = 0;
      this.verticalAccelerationTarget = 0;
      this.verticalBrakeActive = false;
      return input;
    }

    const remaining = this.takeoffTarget - this.state.position.y;

    // Arrivato alla quota target: chiudi takeoff e passa ad altitude hold.
    if (remaining <= 0.04) {
      this.takeoffTarget = null;
      this.navMode = "manual";
      this.altitudeTarget = Math.max(GROUND_CLEARANCE_M, this.state.position.y);
      this.verticalVelocityTarget = 0;
      this.verticalAccelerationTarget = 0;
      this.verticalBrakeActive = true;
      return { ...input, throttle: 0.5 };
    }

    const climbSpeed = Math.min(
      MAVIC_3T_SPECS.altitudeHold.takeoffClimbMs,
      Math.max(0.35, remaining * 1.35),
    );

    this.verticalVelocityTarget = climbSpeed;

    this.altitudeTarget = Math.min(
      this.takeoffTarget,
      this.altitudeTarget + climbSpeed * (1 / 60),
    );

    // Importante: non dare 0.62 fisso.
    // Lascia che withAltitudeHold generi il throttle corretto.
    return { ...input, throttle: 0.5 };
  }

  private withAltitudeHold(input: ManualInput, dt: number): ManualInput {
    const verticalStick = (input.throttle - 0.5) * 2;
    const onGround =
      this.state.position.y <= GROUND_CLEARANCE_M + 0.025 &&
      Math.abs(this.state.velocity.y) < 0.22;

    const landingMode =
      this.navMode === "landing" || this.navMode === "rth-land";

    if (landingMode) {
      this.verticalBrakeActive = false;
    }

    if (
      onGround &&
      this.navMode === "manual" &&
      this.takeoffTarget === null &&
      verticalStick <= 0.05
    ) {
      this.altitudeTarget = GROUND_CLEARANCE_M;
      this.verticalVelocityTarget = 0;
      this.verticalAccelerationTarget = 0;
      this.previousVerticalStickActive = false;
      this.verticalBrakeActive = false;
      return { ...input, throttle: 0 };
    }

    if (this.landingCancelStickLock && Math.abs(verticalStick) <= 0.055) {
      this.landingCancelStickLock = false;
    }

    const effectiveVerticalStick = this.landingCancelStickLock ? 0 : verticalStick;
    const pilotCanChangeAltitude = this.navMode === "manual";
    const takeoffMode = this.navMode === "takeoff";
    const agl = Math.max(0, this.state.position.y - GROUND_CLEARANCE_M);
    const manualDescentStick =
      pilotCanChangeAltitude && effectiveVerticalStick < -0.055;
    const manualLandingDescent =
      manualDescentStick && agl <= MANUAL_LANDING_PROFILE_ALTITUDE_M;
    const manualCruiseDescent = manualDescentStick && !manualLandingDescent;
    const verticalStickActive =
      pilotCanChangeAltitude && Math.abs(effectiveVerticalStick) > 0.055;
    const releaseStarted =
      this.previousVerticalStickActive &&
      !verticalStickActive &&
      pilotCanChangeAltitude;
    const altitudeHold = MAVIC_3T_SPECS.altitudeHold;

    if (takeoffMode && this.takeoffTarget !== null) {
      this.verticalBrakeActive = false;

      const remaining = this.takeoffTarget - this.state.position.y;

      this.verticalVelocityTarget = Math.min(
        MAVIC_3T_SPECS.altitudeHold.takeoffClimbMs,
        Math.max(0.25, remaining * 1.4),
      );

      this.altitudeTarget = Math.min(
        this.takeoffTarget,
        this.altitudeTarget + this.verticalVelocityTarget * dt,
      );

      if (remaining <= 0.04) {
        this.takeoffTarget = null;
        this.navMode = "manual";
        this.verticalVelocityTarget = 0;
        this.verticalAccelerationTarget = 0;
        this.verticalBrakeActive = true;
        this.altitudeTarget = Math.max(
          GROUND_CLEARANCE_M,
          this.state.position.y,
        );
      }
    } else if (verticalStickActive) {
      this.takeoffTarget = null;
      this.verticalBrakeActive = false;

      if (manualLandingDescent) {
        this.verticalVelocityTarget = -this.computeLandingDescentSpeed(agl);
        this.altitudeTarget = this.state.position.y;
      } else if (manualCruiseDescent) {
        this.verticalVelocityTarget =
          effectiveVerticalStick * MAVIC_3T_SPECS.maxDescentSpeedMs;
        this.altitudeTarget = this.state.position.y;
      } else {
        this.verticalVelocityTarget =
          effectiveVerticalStick * MAVIC_3T_SPECS.maxAscentSpeedMs;

        this.altitudeTarget = Math.max(
          GROUND_CLEARANCE_M,
          this.altitudeTarget + this.verticalVelocityTarget * dt,
        );
      }
    } else if (!landingMode) {
      if (releaseStarted) {
        this.verticalBrakeActive = true;
        this.verticalVelocityTarget = 0;
        this.altitudeTarget = Math.max(
          GROUND_CLEARANCE_M,
          this.state.position.y,
        );
      }

      if (this.verticalBrakeActive) {
        this.verticalVelocityTarget = 0;

        if (Math.abs(this.state.velocity.y) < 0.025) {
          this.verticalBrakeActive = false;
          this.state.velocity.y = 0;
          this.verticalAccelerationTarget = 0;
          this.altitudeTarget = Math.max(
            GROUND_CLEARANCE_M,
            this.state.position.y,
          );
        }
      }

      if (!this.verticalBrakeActive) {
        const altitudeError = this.altitudeTarget - this.state.position.y;

        if (
          Math.abs(altitudeError) < 0.025 &&
          Math.abs(this.state.velocity.y) < 0.04
        ) {
          this.verticalVelocityTarget = 0;
          this.verticalAccelerationTarget *= Math.exp(-4.5 * dt);
        } else {
          this.verticalVelocityTarget = clamp(
            altitudeError * altitudeHold.holdKp,
            -0.75,
            0.85,
          );
        }
      }
    }

    this.previousVerticalStickActive = verticalStickActive;

    const altitudeError = this.altitudeTarget - this.state.position.y;
    const desiredVerticalAcceleration = this.verticalBrakeActive
      ? clamp(
          -this.state.velocity.y * altitudeHold.brakeKp,
          -altitudeHold.maxBrakeAccelerationMs2,
          altitudeHold.maxBrakeAccelerationMs2,
        )
      : landingMode || manualLandingDescent
        ? clamp(
            (this.verticalVelocityTarget - this.state.velocity.y) * 2.2,
        -2.2,
        1.8,
          )
        : clamp(
            (this.verticalVelocityTarget - this.state.velocity.y) *
              altitudeHold.velocityKp +
              altitudeError * 0.55,
            -altitudeHold.maxAccelerationMs2,
            altitudeHold.maxAccelerationMs2,
          );

    const jerk =
      landingMode || manualLandingDescent
        ? 22
        : this.verticalBrakeActive
          ? altitudeHold.maxJerkMs3 * 1.05
          : altitudeHold.maxJerkMs3;

    this.verticalAccelerationTarget += clamp(
      desiredVerticalAcceleration - this.verticalAccelerationTarget,
      -jerk * dt,
      jerk * dt,
    );
    if (!verticalStickActive && !takeoffMode && !landingMode) {
      this.verticalAccelerationTarget *= Math.exp(-3.2 * dt);
    }

    const hoverCommand = this.hoverCommand() / this.mixerVoltageScale();
    const maxThrustAccel =
      (MAVIC_3T_SPECS.maxSingleMotorThrustN * 4) / MAVIC_3T_SPECS.massKg;
    const throttleCorrection = this.verticalAccelerationTarget / maxThrustAccel;

    return {
      ...input,
      throttle: clamp(
        hoverCommand + throttleCorrection,
        MAVIC_3T_SPECS.motor.idleCommand,
        0.88,
      ),
    };
  }

  private updateNavigation(dt: number) {
    if (!this.state.armed) {
      return;
    }

    if (this.navMode === "landing" || this.navMode === "rth-land") {
      const agl = Math.max(0, this.state.position.y - GROUND_CLEARANCE_M);

      if (this.groundContact) {
        this.verticalVelocityTarget = 0;
        this.verticalAccelerationTarget = 0;
        this.altitudeTarget = GROUND_CLEARANCE_M;
        this.touchdownTimer += dt;

        return;
      }

      this.touchdownTimer = 0;

      this.verticalVelocityTarget = -this.computeLandingDescentSpeed(agl);

      // Landing is velocity-controlled. Do not chase a descending altitude target,
      // otherwise altitude error either pushes the drone down too hard or makes it hover at ~10 cm.
      this.altitudeTarget = this.state.position.y;

      return;
    }

    if (this.navMode === "rth-climb") {
      if (this.state.position.y >= this.altitudeTarget - 0.35) {
        this.navMode = "rth-return";
        this.controller.setHoldPosition(this.homePosition.x, this.homePosition.z);
      }
      return;
    }

    if (this.navMode === "rth-return") {
      this.altitudeTarget = Math.max(RTH_ALTITUDE_M, this.state.position.y);
      const distanceHome = Math.hypot(
        this.state.position.x - this.homePosition.x,
        this.state.position.z - this.homePosition.z,
      );
      const speed = horizontalSpeed(this.state.velocity);
      if (distanceHome < 0.6 && speed < 0.45) {
        this.navMode = "rth-land";
        this.altitudeTarget = Math.max(
          GROUND_CLEARANCE_M,
          this.state.position.y,
        );
      }
    }
  }

  private computeLandingDescentSpeed(
    agl = Math.max(0, this.state.position.y - GROUND_CLEARANCE_M),
  ) {
    const landing = MAVIC_3T_SPECS.landing;
    const currentDescentSpeed = Math.max(0, -this.state.velocity.y);
    const landingUpAccelerationLimit = 0.8;
    const brakingDistance =
      (currentDescentSpeed * currentDescentSpeed -
        landing.slowDescentMs * landing.slowDescentMs) /
      (2 * landingUpAccelerationLimit);
    const flareDistance = Math.max(
      landing.flareStartM,
      landing.touchdownSlowM + Math.max(0, brakingDistance),
    );
    const flareT = clamp(
      (agl - landing.touchdownSlowM) /
        Math.max(0.001, flareDistance - landing.touchdownSlowM),
      0,
      1,
    );
    const smoothFlareT = flareT * flareT * (3 - 2 * flareT);

    return (
      landing.slowDescentMs +
      (landing.fastDescentMs - landing.slowDescentMs) * smoothFlareT
    );
  }

  private cancelAutonomousToManualHold(lockVerticalStick = true) {
    this.navMode = "manual";
    this.takeoffTarget = null;
    this.verticalVelocityTarget = 0;
    this.verticalAccelerationTarget = 0;
    this.verticalBrakeActive = true;
    this.previousVerticalStickActive = lockVerticalStick;
    this.altitudeTarget = Math.max(GROUND_CLEARANCE_M, this.state.position.y);
    this.touchdownTimer = 0;
    this.groundContact = false;
    this.landingCancelStickLock = lockVerticalStick;
  }

  private applyMicroStopSnap() {
    const debug = this.controller.getDebugSample();
    const phase = debug?.hold.phase;
    const noHorizontalInput =
      Math.hypot(this.input.pitch, this.input.roll) < 0.04;
    const speed = horizontalSpeed(this.state.velocity);

    if (
      noHorizontalInput &&
      (phase === "brake" || phase === "hold" || phase === "settled") &&
      speed < 0.028
    ) {
      this.state.velocity.x = 0;
      this.state.velocity.z = 0;
    }
  }

  private limitHorizontalSpeed() {
    const speed = horizontalSpeed(this.state.velocity);
    const maxSpeed = MAVIC_3T_SPECS.maxHorizontalSpeedNormalMs;

    if (speed <= maxSpeed || speed <= 0.0001) {
      return;
    }

    const scale = maxSpeed / speed;
    this.state.velocity.x *= scale;
    this.state.velocity.z *= scale;
  }

  private resolveGroundContact() {
    const landingMode =
      this.navMode === "landing" || this.navMode === "rth-land";
    const penetration = GROUND_CLEARANCE_M - this.state.position.y;

    if (penetration <= 0) {
      const restingOnGround =
        landingMode &&
        this.state.position.y <= GROUND_CLEARANCE_M + 0.002 &&
        Math.abs(this.state.velocity.y) < 0.035;

      this.groundContact = restingOnGround;
      return;
    }

    // Collision constraint only: prevents ground penetration after the physics step.
    this.state.position.y = GROUND_CLEARANCE_M;

    if (this.state.velocity.y < 0) {
      this.state.velocity.y = 0;
    }

    this.state.velocity.x *= 0.82;
    this.state.velocity.z *= 0.82;
    this.state.angularVelocity.x *= 0.65;
    this.state.angularVelocity.z *= 0.65;

    this.groundContact = landingMode;
  }

  private isGrounded() {
    return (
      this.state.position.y <= GROUND_CLEARANCE_M + 0.06 &&
      Math.abs(this.state.velocity.y) < 0.22
    );
  }

  private updateSensors() {
    const noise = (amount: number) => (Math.random() * 2 - 1) * amount;
    const sensors = MAVIC_3T_SPECS.sensors;
    this.state.sensors.gyro = {
      x: this.state.angularVelocity.x + noise(sensors.gyroNoiseRadS),
      y: this.state.angularVelocity.y + noise(sensors.gyroNoiseRadS),
      z: this.state.angularVelocity.z + noise(sensors.gyroNoiseRadS),
    };
    this.state.sensors.accelerometer = {
      x: this.state.acceleration.x + noise(sensors.accelerometerNoiseMs2),
      y:
        this.state.acceleration.y +
        GRAVITY +
        noise(sensors.accelerometerNoiseMs2),
      z: this.state.acceleration.z + noise(sensors.accelerometerNoiseMs2),
    };
    this.state.sensors.gpsPosition = {
      x: this.state.position.x + noise(sensors.gpsNoiseM),
      y: this.state.position.y + noise(sensors.gpsNoiseM),
      z: this.state.position.z + noise(sensors.gpsNoiseM),
    };
    this.state.sensors.baroAltitude =
      this.state.position.y + noise(sensors.baroNoiseM);
    const alpha = sensors.attitudeComplementaryAlpha;
    this.state.sensors.estimatedAttitude = {
      pitch:
        this.state.sensors.estimatedAttitude.pitch +
        (this.state.attitude.pitch -
          this.state.sensors.estimatedAttitude.pitch) *
          alpha,
      roll:
        this.state.sensors.estimatedAttitude.roll +
        (this.state.attitude.roll - this.state.sensors.estimatedAttitude.roll) *
          alpha,
      yaw:
        this.state.sensors.estimatedAttitude.yaw +
        (this.state.attitude.yaw - this.state.sensors.estimatedAttitude.yaw) *
          alpha,
    };
  }

  private groundEffectMultiplier() {
    const height = Math.max(0.08, this.state.position.y - GROUND_CLEARANCE_M);
    return clamp(
      1 + MAVIC_3T_SPECS.groundEffect.strength / (height + 0.38),
      1,
      MAVIC_3T_SPECS.groundEffect.maxMultiplier,
    );
  }

  private captureHome() {
    if (this.state.position.y <= GROUND_CLEARANCE_M + 0.1) {
      this.homePosition = {
        x: this.state.position.x,
        z: this.state.position.z,
      };
    }
  }

  private hoverCommand() {
    const totalMaxThrust = MAVIC_3T_SPECS.maxSingleMotorThrustN * 4;
    const upContribution = Math.max(
      0.5,
      rotateVecByQuat({ x: 0, y: 1, z: 0 }, this.state.orientation).y,
    );
    const liftMultiplier = this.groundEffectMultiplier() * upContribution;
    return Math.sqrt(
      (MAVIC_3T_SPECS.massKg * GRAVITY) / (totalMaxThrust * liftMultiplier),
    );
  }

  private mixerVoltageScale() {
    return clamp(
      this.state.voltage / MAVIC_3T_SPECS.battery.nominalVoltage,
      0.86,
      1.05,
    );
  }

  private disarm() {
    this.state.armed = false;
    this.state.motorSpeeds = [0, 0, 0, 0];
    this.altitudeTarget = GROUND_CLEARANCE_M;
    this.verticalVelocityTarget = 0;
    this.verticalAccelerationTarget = 0;
    this.previousVerticalStickActive = false;
    this.verticalBrakeActive = false;
    this.navMode = "manual";
    this.takeoffTarget = null;
    this.controller.reset();
    this.touchdownTimer = 0;
    this.groundContact = false;
  }
}
