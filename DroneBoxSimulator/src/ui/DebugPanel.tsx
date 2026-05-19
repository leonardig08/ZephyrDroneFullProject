import type { ManualInput } from '../sim/types';

export const DebugPanel = ({ input }: { input: ManualInput }) => (
  <section className="inputStrip">
    <span>{input.throttle === 0.5 ? 'Hold' : input.throttle > 0.5 ? 'Climb' : 'Descend'}</span>
    <span>Yaw {input.yaw.toFixed(0)}</span>
    <span>Pitch {input.pitch.toFixed(0)}</span>
    <span>Roll {input.roll.toFixed(0)}</span>
  </section>
);
