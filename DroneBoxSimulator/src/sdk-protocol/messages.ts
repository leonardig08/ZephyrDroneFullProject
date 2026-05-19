import type { CommandProtocolMessage, RcProtocolMessage, TelemetryMessage } from '../sim/types';

export type SdkInboundMessage = RcProtocolMessage | CommandProtocolMessage;
export type SdkOutboundMessage = TelemetryMessage;

export const isSdkInboundMessage = (message: unknown): message is SdkInboundMessage => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  const candidate = message as Partial<SdkInboundMessage>;
  return candidate.type === 'rc' || candidate.type === 'command';
};
