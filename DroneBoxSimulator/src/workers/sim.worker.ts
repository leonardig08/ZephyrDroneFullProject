import { createInitialDroneState } from '../sim/droneState';
import { PhysicsLoop } from '../sim/physicsLoop';
import type { SimulatorCommand } from '../sim/types';

const loop = new PhysicsLoop(createInitialDroneState());
let lastTime = performance.now();
let accumulator = 0;
const fixedDt = 1 / 500;

self.onmessage = (event: MessageEvent<SimulatorCommand>) => {
  loop.handleCommand(event.data);
};

setInterval(() => {
  const now = performance.now();
  accumulator += Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  while (accumulator >= fixedDt) {
    loop.step(fixedDt);
    accumulator -= fixedDt;
  }

  self.postMessage({
    state: loop.snapshot(),
    telemetry: loop.telemetry()
  });
}, 1000 / 60);
