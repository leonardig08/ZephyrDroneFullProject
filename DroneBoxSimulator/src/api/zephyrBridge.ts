import type { DroneState, WorldTrailPoint } from '../sim/types';
import type { SimulatorCommand } from '../sim/types';
import { quaternionFromAttitude } from '../sim/math3d';

type ZephyrTelemetry = {
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  pitch?: number | null;
  roll?: number | null;
  yaw?: number | null;
  velocity_x?: number | null;
  velocity_y?: number | null;
  velocity_z?: number | null;
  is_flying?: boolean;
};

type ZephyrSnapshot = {
  connected?: boolean;
  product_name?: string | null;
  telemetry?: ZephyrTelemetry;
  battery?: {
    percent?: number | null;
  };
  mission?: {
    state?: string | null;
  };
  position_history?: Array<{ lat?: number | null; lon?: number | null; alt?: number | null; t?: number }>;
};

export type ZephyrBridgeFrame = {
  state: DroneState;
  trail: WorldTrailPoint[];
  connected: boolean;
  productName: string;
  missionState: string;
};

export const defaultZephyrWsUrl = () => {
  const isPythonHost = location.port === '8000';
  const host = isPythonHost ? location.host : '127.0.0.1:8000';
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${host}/ws/telemetry`;
};

export class ZephyrBridge {
  private socket: WebSocket | null = null;
  private origin: { lat: number; lon: number } | null = null;

  constructor(
    private readonly url: string,
    private readonly onFrame: (frame: ZephyrBridgeFrame) => void,
    private readonly onStatus: (status: string) => void
  ) {}

  connect() {
    this.disconnect();
    this.onStatus(`Connecting to ${this.url}`);
    this.socket = new WebSocket(this.url);

    this.socket.addEventListener('open', () => {
      this.onStatus('Connected to Zephyr Python middleware');
    });

    this.socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return;
      }

      const frame = this.parseFrame(event.data);
      if (frame) {
        this.onFrame(frame);
      }
    });

    this.socket.addEventListener('close', () => {
      this.onStatus('Zephyr middleware disconnected');
    });

    this.socket.addEventListener('error', () => {
      this.onStatus('Cannot connect to Zephyr middleware');
    });
  }

  disconnect() {
    this.socket?.close();
    this.socket = null;
  }

  sendSimulatorCommand(command: SimulatorCommand) {
    if (this.socket?.readyState !== WebSocket.OPEN || command.type !== 'command') {
      return;
    }

    const zephyrCommand = toZephyrCommand(command);
    if (zephyrCommand) {
      this.socket.send(JSON.stringify(zephyrCommand));
    }
  }

  private parseFrame(raw: string): ZephyrBridgeFrame | null {
    let message: unknown;
    try {
      message = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }

    const snapshot = this.extractSnapshot(message);
    if (!snapshot?.telemetry) {
      return null;
    }

    const telemetry = snapshot.telemetry;
    const lat = numberOrNull(telemetry.latitude);
    const lon = numberOrNull(telemetry.longitude);
    const altitude = numberOrNull(telemetry.altitude) ?? 0;
    if (lat !== null && lon !== null && this.origin === null) {
      this.origin = { lat, lon };
    }

    const position = lat !== null && lon !== null && this.origin ? latLonToWorld(lat, lon, altitude, this.origin) : { x: 0, y: altitude, z: 0 };
    const trail: WorldTrailPoint[] = this.origin
      ? (snapshot.position_history ?? [])
          .map<WorldTrailPoint | null>((point) => {
            const pointLat = numberOrNull(point.lat);
            const pointLon = numberOrNull(point.lon);
            if (pointLat === null || pointLon === null) {
              return null;
            }
            const trailPoint: WorldTrailPoint = latLonToWorld(pointLat, pointLon, numberOrNull(point.alt) ?? 0, this.origin!);
            if (point.t !== undefined) {
              trailPoint.t = point.t;
            }
            return trailPoint;
          })
          .filter((point): point is WorldTrailPoint => point !== null)
      : [];

    // Zephyr telemetry follows the common NED convention:
    // velocity_x = north, velocity_y = east, velocity_z = down.
    // Three world here is X=east, Y=up, Z=-north.
    const velocityNorth = numberOrNull(telemetry.velocity_x) ?? 0;
    const velocityEast = numberOrNull(telemetry.velocity_y) ?? 0;
    const velocityDown = numberOrNull(telemetry.velocity_z) ?? 0;
    const velocity = {
      x: velocityEast,
      y: -velocityDown,
      z: -velocityNorth
    };
    const attitude = {
      pitch: degreesToRadians(numberOrNull(telemetry.pitch) ?? 0),
      roll: -degreesToRadians(numberOrNull(telemetry.roll) ?? 0),
      yaw: -degreesToRadians(numberOrNull(telemetry.yaw) ?? 0)
    };

    return {
      state: {
        position,
        velocity,
        acceleration: { x: 0, y: 0, z: 0 },
        orientation: quaternionFromAttitude(attitude),
        attitude,
        angularVelocity: { x: 0, y: 0, z: 0 },
        angularAcceleration: { x: 0, y: 0, z: 0 },
        motorSpeeds: snapshot.telemetry.is_flying ? [0.54, 0.54, 0.54, 0.54] : [0, 0, 0, 0],
        motorRpms: snapshot.telemetry.is_flying ? [8900, 8900, 8900, 8900] : [0, 0, 0, 0],
        windVelocity: { x: 0, y: 0, z: 0 },
        sensors: {
          gyro: { x: 0, y: 0, z: 0 },
          accelerometer: { x: 0, y: 0, z: 0 },
          gpsPosition: position,
          baroAltitude: position.y,
          estimatedAttitude: attitude
        },
        battery: numberOrNull(snapshot.battery?.percent) ?? 0,
        voltage: 15.4,
        mode: 'STABILIZED',
        armed: Boolean(snapshot.connected)
      },
      trail,
      connected: Boolean(snapshot.connected),
      productName: snapshot.product_name || 'Zephyr Mavic 3T',
      missionState: snapshot.mission?.state || 'READY'
    };
  }

  private extractSnapshot(message: unknown): ZephyrSnapshot | null {
    if (!message || typeof message !== 'object') {
      return null;
    }

    const candidate = message as { state_snapshot?: ZephyrSnapshot };
    return candidate.state_snapshot ?? (message as ZephyrSnapshot);
  }
}

const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const degreesToRadians = (degrees: number) => (degrees * Math.PI) / 180;

const latLonToWorld = (lat: number, lon: number, alt: number, origin: { lat: number; lon: number }) => {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos((origin.lat * Math.PI) / 180);

  return {
    x: (lon - origin.lon) * metersPerDegreeLon,
    y: alt,
    z: -(lat - origin.lat) * metersPerDegreeLat
  };
};

const toZephyrCommand = (command: Extract<SimulatorCommand, { type: 'command' }>) => {
  if (command.command === 'takeoff') {
    return { type: 'takeoff', altitude: command.altitude };
  }
  if (command.command === 'disarm') {
    return { type: 'land' };
  }
  if (command.command === 'land') {
    return { type: 'land' };
  }
  if (command.command === 'return-home') {
    return { type: 'return_home' };
  }
  if (command.command === 'arm' || command.command === 'toggle-arm') {
    return { type: 'takeoff' };
  }
  return null;
};
