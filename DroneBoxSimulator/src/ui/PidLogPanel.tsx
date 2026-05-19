import type { DroneState, FlightDebugSample } from '../sim/types';

const formatSample = (state: DroneState, debug: FlightDebugSample) =>
  JSON.stringify({
    t: Number(debug.t.toFixed(3)),
    pos: roundVec(state.position),
    vel: roundVec(state.velocity),
    att: roundAtt(state.attitude),
    input: debug.input,
    hold: {
      active: debug.hold.active,
      x: Number(debug.hold.x.toFixed(3)),
      z: Number(debug.hold.z.toFixed(3)),
      error: Number(debug.hold.error.toFixed(3)),
      speed: Number(debug.hold.speed.toFixed(3)),
      radialVelocity: Number(debug.hold.radialVelocity.toFixed(3)),
      stoppingDistance: Number(debug.hold.stoppingDistance.toFixed(3)),
      phase: debug.hold.phase
    },
    targetVelocity: roundVec(debug.targetVelocity),
    desiredAcceleration: roundVec(debug.desiredAcceleration),
    smoothedAcceleration: debug.smoothedAcceleration ? roundVec(debug.smoothedAcceleration) : undefined,
    attitudeTarget: roundAtt(debug.attitudeTarget),
    rateTarget: debug.rateTarget ? roundVec(debug.rateTarget) : undefined,
    throttle: Number(debug.throttle.toFixed(3))
  });

const roundVec = (vec: { x: number; y: number; z: number }) => ({
  x: Number(vec.x.toFixed(3)),
  y: Number(vec.y.toFixed(3)),
  z: Number(vec.z.toFixed(3))
});

const roundAtt = (attitude: { pitch: number; roll: number; yaw: number }) => ({
  pitch: Number(((attitude.pitch * 180) / Math.PI).toFixed(2)),
  roll: Number(((attitude.roll * 180) / Math.PI).toFixed(2)),
  yaw: Number(((attitude.yaw * 180) / Math.PI).toFixed(2))
});

export const appendPidLogSample = (buffer: string[], state: DroneState | null) => {
  if (!state?.debug) {
    return buffer;
  }

  const sample = formatSample(state, state.debug);
  const previous = buffer[buffer.length - 1];
  if (sample === previous) {
    return buffer;
  }

  return [...buffer, sample].slice(-240);
};

export const PidLogPanel = ({
  samples,
  onClear
}: {
  samples: string[];
  onClear: () => void;
}) => {
  const copyLog = async () => {
    await navigator.clipboard.writeText(samples.join('\n'));
  };

  return (
    <section className="pidLog">
      <button onClick={copyLog}>Copy PID log</button>
      <button onClick={onClear}>Clear</button>
      <span>{samples.length} samples</span>
    </section>
  );
};
