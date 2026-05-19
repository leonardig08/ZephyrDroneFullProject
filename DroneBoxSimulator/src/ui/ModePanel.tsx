import type { DroneState, SimulatorCommand } from '../sim/types';

export const ModePanel = ({
  state,
  onCommand
}: {
  state: DroneState | null;
  onCommand: (command: SimulatorCommand) => void;
}) => (
  <section className="flightActions">
    <div className="buttonGrid">
      <button className={state?.armed ? 'danger' : 'primaryAction'} onClick={() => onCommand({ type: 'command', command: 'toggle-arm' })}>
        {state?.armed ? 'Disarm' : 'Arm'}
      </button>
      <button onClick={() => onCommand({ type: 'command', command: 'takeoff', altitude: 1 })}>Takeoff 1m</button>
      <button onClick={() => onCommand({ type: 'command', command: 'land' })}>Land</button>
      <button onClick={() => onCommand({ type: 'command', command: 'return-home' })}>RTH</button>
    </div>
  </section>
);
