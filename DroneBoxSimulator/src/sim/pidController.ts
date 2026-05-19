const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export type PidOptions = {
  kp: number;
  ki?: number;
  kd?: number;
  integralLimit?: number;
  outputLimit?: number;
  derivativeAlpha?: number;
  derivativeLimit?: number;
  outputSlewRate?: number;
  integratorLeak?: number;
};

export class PidController {
  private integral = 0;
  private previousMeasurement = 0;
  private derivative = 0;
  private output = 0;
  private initialized = false;

  private readonly kp: number;
  private readonly ki: number;
  private readonly kd: number;
  private readonly integralLimit: number;
  private readonly outputLimit: number;
  private readonly derivativeAlpha: number;
  private readonly derivativeLimit: number;
  private readonly outputSlewRate: number;
  private readonly integratorLeak: number;

  constructor(options: PidOptions);
  constructor(kp: number, ki?: number, kd?: number, integralLimit?: number, outputLimit?: number, derivativeAlpha?: number);
  constructor(
    optionsOrKp: PidOptions | number,
    ki = 0,
    kd = 0,
    integralLimit = 1,
    outputLimit = 1,
    derivativeAlpha = 0.18
  ) {
    const options =
      typeof optionsOrKp === 'number'
        ? { kp: optionsOrKp, ki, kd, integralLimit, outputLimit, derivativeAlpha }
        : optionsOrKp;

    this.kp = options.kp;
    this.ki = options.ki ?? 0;
    this.kd = options.kd ?? 0;
    this.integralLimit = options.integralLimit ?? 1;
    this.outputLimit = options.outputLimit ?? 1;
    this.derivativeAlpha = options.derivativeAlpha ?? 0.18;
    this.derivativeLimit = options.derivativeLimit ?? Infinity;
    this.outputSlewRate = options.outputSlewRate ?? Infinity;
    this.integratorLeak = options.integratorLeak ?? 0;
  }

  update(target: number, measurement: number, dt: number) {
    if (!Number.isFinite(dt) || dt <= 0) {
      return this.output;
    }

    const safeDt = clamp(dt, 1 / 1000, 1 / 60);

    if (!this.initialized) {
      this.previousMeasurement = measurement;
      this.initialized = true;
    }

    const error = target - measurement;
    const pTerm = this.kp * error;

    const measurementDerivative = -(measurement - this.previousMeasurement) / safeDt;
    const limitedDerivative = clamp(measurementDerivative, -this.derivativeLimit, this.derivativeLimit);
    this.derivative += (limitedDerivative - this.derivative) * clamp(this.derivativeAlpha, 0, 1);
    const dTerm = this.kd * this.derivative;

    if (this.integratorLeak > 0) {
      this.integral *= Math.exp(-this.integratorLeak * safeDt);
    }

    const candidateIntegral = clamp(this.integral + error * safeDt, -this.integralLimit, this.integralLimit);
    const candidateOutput = pTerm + this.ki * candidateIntegral + dTerm;

    const blockedHigh = candidateOutput > this.outputLimit && error > 0;
    const blockedLow = candidateOutput < -this.outputLimit && error < 0;
    if (!blockedHigh && !blockedLow) {
      this.integral = candidateIntegral;
    }

    let nextOutput = clamp(pTerm + this.ki * this.integral + dTerm, -this.outputLimit, this.outputLimit);

    if (Number.isFinite(this.outputSlewRate)) {
      const maxStep = this.outputSlewRate * safeDt;
      nextOutput = this.output + clamp(nextOutput - this.output, -maxStep, maxStep);
    }

    this.previousMeasurement = measurement;
    this.output = nextOutput;
    return nextOutput;
  }

  reset(measurement = 0) {
    this.integral = 0;
    this.previousMeasurement = measurement;
    this.derivative = 0;
    this.output = 0;
    this.initialized = false;
  }
}
