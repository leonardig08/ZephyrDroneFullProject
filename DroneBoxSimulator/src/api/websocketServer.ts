import type { TelemetryMessage } from '../sim/types';
import { parseCommandProtocol } from './commandProtocol';

export type WebSocketBridgeOptions = {
  url: string;
  onCommand: (rawCommand: string) => void;
};

export class WebSocketBridge {
  private socket: WebSocket | null = null;

  constructor(private readonly options: WebSocketBridgeOptions) {}

  connect() {
    this.socket = new WebSocket(this.options.url);
    this.socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return;
      }

      const command = parseCommandProtocol(event.data);
      if (command) {
        this.options.onCommand(JSON.stringify(command));
      }
    });
  }

  sendTelemetry(telemetry: TelemetryMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(telemetry));
    }
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
  }
}
