import type { DroneState } from '../sim/types';

const fixed = (value: number, digits = 2) => value.toFixed(digits);
const deg = (radians: number) => `${fixed((radians * 180) / Math.PI, 1)} deg`;

export const TelemetryPanel = ({ state }: { state: DroneState | null }) => {
  if (!state) {
    return <aside className="telemetry">Waiting...</aside>;
  }

  const horizontalSpeed = Math.hypot(state.velocity.x, state.velocity.z);
  const hold = state.debug?.hold;

  return (
    <aside className="telemetry">
      <div className="telemetryGrid">
        <div>
          <span>ALT</span>
          <strong>{fixed(state.position.y, 1)} m</strong>
        </div>
        <div>
          <span>V/S</span>
          <strong>{fixed(state.velocity.y, 1)} m/s</strong>
        </div>
        <div>
          <span>BAT</span>
          <strong>{fixed(state.battery, 0)}%</strong>
        </div>
        <div>
          <span>H/S</span>
          <strong>{fixed(horizontalSpeed, 2)} m/s</strong>
        </div>
      </div>
      <div className="telemetryLine">
        <span>X {fixed(state.position.x)}</span>
        <span>Z {fixed(state.position.z)}</span>
        {hold && <span>Hold {hold.phase} {fixed(hold.error, 2)} m</span>}
        <span>P {deg(state.attitude.pitch)}</span>
        <span>R {deg(state.attitude.roll)}</span>
        <span>Y {deg(state.attitude.yaw)}</span>
      </div>
    </aside>
  );
};
