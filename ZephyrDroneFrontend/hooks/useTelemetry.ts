import { useEffect, useMemo, useState } from "react";
import { DroneSnapshot, getTelemetryWsUrl } from "@/lib/api";
import { getServerHost, setCurrentCameraMode, subscribeServerHost } from "@/lib/runtimeConfig";

type TelemetryState = {
  connected: boolean;
  snapshot: DroneSnapshot | null;
  lastMessageType?: string;
};

const EMPTY: TelemetryState = {
  connected: false,
  snapshot: null,
};
const TELEMETRY_FLUSH_MS = 11; // ~90 FPS UI updates
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 8000;
const STALE_CONNECTION_MS = 4000;
const WATCHDOG_TICK_MS = 1000;

let started = false;
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let currentState: TelemetryState = EMPTY;
const listeners = new Set<(next: TelemetryState) => void>();
let connectionEpoch = 0;
let pendingSnapshot: DroneSnapshot | null = null;
let pendingMessageType: string | undefined;
let reconnectAttempt = 0;
let lastMessageAt = 0;

function publish(next: TelemetryState) {
  currentState = next;
  listeners.forEach((l) => l(next));
}

function flushPendingSnapshot() {
  if (!pendingSnapshot) return;
  publish({
    connected: true,
    snapshot: pendingSnapshot,
    lastMessageType: pendingMessageType,
  });
  pendingSnapshot = null;
  pendingMessageType = undefined;
}

function clearReconnectTimer() {
  if (!retry) return;
  clearTimeout(retry);
  retry = null;
}

function closeSocket() {
  if (!ws) return;
  try {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  } catch {
    // ignore
  } finally {
    ws = null;
  }
}

function scheduleReconnect(epoch: number) {
  if (epoch !== connectionEpoch) return;
  if (retry) return;
  const backoff = Math.min(RETRY_BASE_MS * 2 ** reconnectAttempt, RETRY_MAX_MS);
  const jitter = Math.floor(Math.random() * 250);
  retry = setTimeout(() => {
    retry = null;
    connectNow(epoch);
  }, backoff + jitter);
  reconnectAttempt += 1;
}

function connectNow(epoch: number) {
  if (epoch !== connectionEpoch) return;
  clearReconnectTimer();
  closeSocket();
  const wsUrl = getTelemetryWsUrl();
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    if (epoch !== connectionEpoch) return;
    reconnectAttempt = 0;
    lastMessageAt = Date.now();
    publish({ ...currentState, connected: true });
  };

  ws.onmessage = (ev) => {
    if (epoch !== connectionEpoch) return;
    try {
      const parsed = JSON.parse(ev.data as string) as {
        type?: string;
        camera?: string;
        state_snapshot?: DroneSnapshot;
      };
      if (!parsed.state_snapshot) return;
      lastMessageAt = Date.now();
      const cameraFromSnapshot = parsed.state_snapshot.current_camera;
      const cameraFromMessage = parsed.camera;
      if (cameraFromSnapshot) {
        setCurrentCameraMode(cameraFromSnapshot);
      } else if (cameraFromMessage) {
        setCurrentCameraMode(cameraFromMessage);
      }
      pendingSnapshot = parsed.state_snapshot;
      pendingMessageType = parsed.type;
    } catch {
      // ignore malformed packets
    }
  };

  ws.onerror = () => {
    if (epoch !== connectionEpoch) return;
    pendingSnapshot = null;
    pendingMessageType = undefined;
    publish({ ...currentState, connected: false });
    closeSocket();
    scheduleReconnect(epoch);
  };

  ws.onclose = () => {
    if (epoch !== connectionEpoch) return;
    pendingSnapshot = null;
    pendingMessageType = undefined;
    publish({ ...currentState, connected: false });
    closeSocket();
    scheduleReconnect(epoch);
  };
}

function startTelemetryManager() {
  if (started) return;
  started = true;

  subscribeServerHost(() => {
    connectionEpoch += 1;
    const epoch = connectionEpoch;
    pendingSnapshot = null;
    pendingMessageType = undefined;
    reconnectAttempt = 0;
    clearReconnectTimer();
    closeSocket();
    connectNow(epoch);
  });

  if (!flushTimer) {
    flushTimer = setInterval(flushPendingSnapshot, TELEMETRY_FLUSH_MS);
  }
  if (!watchdogTimer) {
    watchdogTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const staleFor = Date.now() - lastMessageAt;
      if (staleFor < STALE_CONNECTION_MS) return;
      const epoch = connectionEpoch;
      publish({ ...currentState, connected: false });
      closeSocket();
      scheduleReconnect(epoch);
    }, WATCHDOG_TICK_MS);
  }

  connectionEpoch += 1;
  connectNow(connectionEpoch);
}

export function useTelemetry() {
  const [state, setState] = useState<TelemetryState>(currentState);
  const [host, setHost] = useState(getServerHost());

  useEffect(() => subscribeServerHost(setHost), []);

  useEffect(() => {
    startTelemetryManager();
    listeners.add(setState);

    return () => {
      listeners.delete(setState);
    };
  }, [host]);

  return useMemo(() => state, [state]);
}
