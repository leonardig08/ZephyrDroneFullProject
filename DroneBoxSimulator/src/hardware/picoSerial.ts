import { parseCommandProtocol } from '../api/commandProtocol';
import type { SimulatorCommand } from '../sim/types';

type SerialPortLike = {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
};

type NavigatorWithSerial = Navigator & {
  serial?: {
    requestPort(): Promise<SerialPortLike>;
  };
};

export class PicoSerial {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;

  async connect(onCommand: (command: SimulatorCommand) => void) {
    const serial = (navigator as NavigatorWithSerial).serial;
    if (!serial) {
      throw new Error('Web Serial API non disponibile in questo browser.');
    }

    this.port = await serial.requestPort();
    await this.port.open({ baudRate: 115200 });

    if (!this.port.readable) {
      return;
    }

    const decoder = new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>;
    const textStream = this.port.readable.pipeThrough(decoder);
    this.reader = textStream.getReader();
    void this.readLoop(onCommand);
  }

  async disconnect() {
    await this.reader?.cancel();
    this.reader = null;
    await this.port?.close();
    this.port = null;
  }

  private async readLoop(onCommand: (command: SimulatorCommand) => void) {
    let buffer = '';

    while (this.reader) {
      const { value, done } = await this.reader.read();
      if (done || value === undefined) {
        break;
      }

      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const command = parseCommandProtocol(line.trim());
        if (command) {
          onCommand(command);
        }
      }
    }
  }
}
