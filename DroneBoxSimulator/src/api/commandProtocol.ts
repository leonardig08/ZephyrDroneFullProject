import type { SimulatorCommand } from '../sim/types';
import { isSdkInboundMessage } from '../sdk-protocol/messages';

export const parseCommandProtocol = (raw: string): SimulatorCommand | null => {
  try {
    const message = JSON.parse(raw) as unknown;
    return isSdkInboundMessage(message) ? message : null;
  } catch {
    return null;
  }
};
