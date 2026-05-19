import * as FileSystem from "expo-file-system/legacy";

type HostListener = (host: string) => void;
type MapLayerListener = (layer: MapLayer) => void;
type WeatherRadarListener = (enabled: boolean) => void;
type MockFeedListener = (enabled: boolean) => void;
type CameraModeListener = (mode: CameraMode) => void;
type RecordingListener = (active: boolean) => void;
type PhotoActivityListener = (active: boolean) => void;
type OperatorListener = (operatorId: string) => void;
type GpsDeviationWarningsListener = (enabled: boolean) => void;
export type MapLayer = "standard" | "satellite" | "hybrid";
export type CameraMode = "WIDE" | "ZOOM" | "IR";

const DEFAULT_HOST = "10.101.30.14";
const DEFAULT_MAP_LAYER: MapLayer = "hybrid";
const DEFAULT_WEATHER_RADAR_ENABLED = false;
const DEFAULT_GPS_DEVIATION_WARNINGS_ENABLED = true;
const CONFIG_PATH = `${FileSystem.documentDirectory ?? ""}zephyr_frontend_settings.json`;
let serverHost = DEFAULT_HOST;
let mapLayer: MapLayer = DEFAULT_MAP_LAYER;
let weatherRadarEnabled = DEFAULT_WEATHER_RADAR_ENABLED;
let gpsDeviationWarningsEnabled = DEFAULT_GPS_DEVIATION_WARNINGS_ENABLED;
let mockFeedEnabled = false;
let currentCameraMode: CameraMode = "WIDE";
let recordingActive = false;
let photoCaptureActive = false;
let operatorId = "";
let operatorName = "Operatore App";
const listeners = new Set<HostListener>();
const mapLayerListeners = new Set<MapLayerListener>();
const weatherRadarListeners = new Set<WeatherRadarListener>();
const mockFeedListeners = new Set<MockFeedListener>();
const cameraModeListeners = new Set<CameraModeListener>();
const recordingListeners = new Set<RecordingListener>();
const photoActivityListeners = new Set<PhotoActivityListener>();
const operatorListeners = new Set<OperatorListener>();
const gpsDeviationWarningsListeners = new Set<GpsDeviationWarningsListener>();
let writeQueue: Promise<void> = Promise.resolve();

function normalizeHost(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_HOST;
  return trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^ws:\/\//i, "")
    .replace(/\/+$/, "")
    .split(":")[0];
}

type PersistedConfig = {
  serverHost?: string;
  mapLayer?: string;
  weatherRadarEnabled?: boolean;
  gpsDeviationWarningsEnabled?: boolean;
  operatorId?: string;
  operatorName?: string;
};

async function readPersistedConfig(): Promise<PersistedConfig> {
  if (!FileSystem.documentDirectory) return {};
  try {
    const info = await FileSystem.getInfoAsync(CONFIG_PATH);
    if (!info.exists) return {};
    const raw = await FileSystem.readAsStringAsync(CONFIG_PATH);
    const parsed = JSON.parse(raw) as PersistedConfig;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

async function writePersistedConfig(next: PersistedConfig) {
  if (!FileSystem.documentDirectory) return;
  // Prevent a past rejected write from poisoning all future writes.
  writeQueue = writeQueue.catch(() => undefined).then(() =>
    FileSystem.writeAsStringAsync(CONFIG_PATH, JSON.stringify(next, null, 2)),
  );
  await writeQueue;
}

export function getServerHost() {
  return serverHost;
}

export function getMapLayer() {
  return mapLayer;
}

export function getWeatherRadarEnabled() {
  return weatherRadarEnabled;
}

export function getGpsDeviationWarningsEnabled() {
  return gpsDeviationWarningsEnabled;
}

export function getMockFeedEnabled() {
  return mockFeedEnabled;
}

export function getCurrentCameraMode() {
  return currentCameraMode;
}

export function getRecordingActive() {
  return recordingActive;
}

export function getPhotoCaptureActive() {
  return photoCaptureActive;
}

export function getOperatorId() {
  return operatorId;
}

export function getOperatorName() {
  return operatorName;
}

function normalizeMapLayer(input: string): MapLayer {
  const v = (input || "").trim().toLowerCase();
  if (v === "standard" || v === "satellite" || v === "hybrid") return v;
  return DEFAULT_MAP_LAYER;
}

export function setServerHost(nextHost: string) {
  const normalized = normalizeHost(nextHost);
  if (!normalized || normalized === serverHost) return serverHost;
  serverHost = normalized;
  listeners.forEach((cb) => cb(serverHost));
  return serverHost;
}

export function subscribeServerHost(listener: HostListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setMapLayer(nextLayer: string) {
  const normalized = normalizeMapLayer(nextLayer);
  if (normalized === mapLayer) return mapLayer;
  mapLayer = normalized;
  mapLayerListeners.forEach((cb) => cb(mapLayer));
  return mapLayer;
}

export function subscribeMapLayer(listener: MapLayerListener) {
  mapLayerListeners.add(listener);
  return () => mapLayerListeners.delete(listener);
}

export function setWeatherRadarEnabled(enabled: boolean) {
  if (enabled === weatherRadarEnabled) return weatherRadarEnabled;
  weatherRadarEnabled = enabled;
  weatherRadarListeners.forEach((cb) => cb(weatherRadarEnabled));
  return weatherRadarEnabled;
}

export function subscribeWeatherRadar(listener: WeatherRadarListener) {
  weatherRadarListeners.add(listener);
  return () => weatherRadarListeners.delete(listener);
}

export function setGpsDeviationWarningsEnabled(enabled: boolean) {
  if (enabled === gpsDeviationWarningsEnabled) return gpsDeviationWarningsEnabled;
  gpsDeviationWarningsEnabled = enabled;
  gpsDeviationWarningsListeners.forEach((cb) => cb(gpsDeviationWarningsEnabled));
  return gpsDeviationWarningsEnabled;
}

export function subscribeGpsDeviationWarnings(listener: GpsDeviationWarningsListener) {
  gpsDeviationWarningsListeners.add(listener);
  return () => gpsDeviationWarningsListeners.delete(listener);
}

export function setMockFeedEnabled(enabled: boolean) {
  if (enabled === mockFeedEnabled) return mockFeedEnabled;
  mockFeedEnabled = enabled;
  mockFeedListeners.forEach((cb) => cb(mockFeedEnabled));
  return mockFeedEnabled;
}

export function subscribeMockFeed(listener: MockFeedListener) {
  mockFeedListeners.add(listener);
  return () => mockFeedListeners.delete(listener);
}

export function setCurrentCameraMode(mode: string) {
  const normalized = String(mode || "").toUpperCase();
  if (normalized !== "WIDE" && normalized !== "ZOOM" && normalized !== "IR") return currentCameraMode;
  if (normalized === currentCameraMode) return currentCameraMode;
  currentCameraMode = normalized;
  cameraModeListeners.forEach((cb) => cb(currentCameraMode));
  return currentCameraMode;
}

export function subscribeCurrentCameraMode(listener: CameraModeListener) {
  cameraModeListeners.add(listener);
  return () => cameraModeListeners.delete(listener);
}

export function setRecordingActive(active: boolean) {
  if (active === recordingActive) return recordingActive;
  recordingActive = active;
  recordingListeners.forEach((cb) => cb(recordingActive));
  return recordingActive;
}

export function subscribeRecordingActive(listener: RecordingListener) {
  recordingListeners.add(listener);
  return () => recordingListeners.delete(listener);
}

export function setPhotoCaptureActive(active: boolean) {
  if (active === photoCaptureActive) return photoCaptureActive;
  photoCaptureActive = active;
  photoActivityListeners.forEach((cb) => cb(photoCaptureActive));
  return photoCaptureActive;
}

export function subscribePhotoCaptureActive(listener: PhotoActivityListener) {
  photoActivityListeners.add(listener);
  return () => photoActivityListeners.delete(listener);
}

export function subscribeOperatorId(listener: OperatorListener) {
  operatorListeners.add(listener);
  return () => operatorListeners.delete(listener);
}

export function getApiBase() {
  return `http://${serverHost}:8000`;
}

export function getWsBase() {
  return `ws://${serverHost}:8000/ws/telemetry`;
}

export function getGo2RtcBase() {
  return `http://${serverHost}:1984`;
}

function isIpv4(v: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
}

function subnetPrefix(host: string): string | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

async function fetchWithTimeout(url: string, timeoutMs = 900) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function isServerStatusReachable(host: string, timeoutMs = 900) {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  try {
    const res = await fetchWithTimeout(`http://${normalized}:8000/status`, timeoutMs);
    if (!res.ok) return false;
    const data = (await res.json()) as {
      service?: string;
      status?: string;
      drone?: unknown;
      bridge_connected?: unknown;
    };
    const byService = String(data?.service ?? "").toLowerCase().includes("zephyr");
    const byStatus = String(data?.status ?? "").toLowerCase() === "ok";
    const byShape = data?.drone != null && typeof data?.bridge_connected === "boolean";
    return byService || byStatus || byShape;
  } catch {
    return false;
  }
}

function startupSubnetPrefixes(host: string) {
  const prefixes = new Set<string>();
  const current = subnetPrefix(host);
  if (current) prefixes.add(current);
  [
    "192.168.1",
    "192.168.0",
    "192.168.4",
    "192.168.8",
    "192.168.43",
    "192.168.100",
    "10.101.30",
    "10.0.1",
    "10.0.0",
    "10.10.0",
    "172.16.0",
    "172.20.10",
  ].forEach((p) => prefixes.add(p));
  return Array.from(prefixes);
}

export async function discoverServerHost(baseHost: string, timeoutMs = 650) {
  const host = normalizeHost(baseHost);
  if (!isIpv4(host)) return null;
  const prefix = subnetPrefix(host);
  if (!prefix) return null;

  const selfLast = Number(host.split(".")[3] || "0");
  const candidates: number[] = [];
  for (let d = 0; d <= 40; d += 1) {
    const left = selfLast - d;
    const right = selfLast + d;
    if (left >= 1 && left <= 254) candidates.push(left);
    if (d !== 0 && right >= 1 && right <= 254) candidates.push(right);
  }
  for (let i = 1; i <= 254; i += 1) {
    if (!candidates.includes(i)) candidates.push(i);
  }

  const chunkSize = 32;
  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const results = await Promise.all(
      chunk.map(async (n) => {
        const ip = `${prefix}.${n}`;
        return (await isServerStatusReachable(ip, timeoutMs)) ? ip : null;
      }),
    );
    const found = results.find((x) => x != null);
    if (found) return found;
  }
  return null;
}

export async function ensureServerHostOnStartup() {
  const persisted = await loadPersistedServerHost();
  if (await isServerStatusReachable(persisted, 900)) {
    return { host: persisted, reachable: true, discovered: false };
  }
  for (const prefix of startupSubnetPrefixes(persisted)) {
    const seed = `${prefix}.${isIpv4(persisted) && subnetPrefix(persisted) === prefix ? persisted.split(".")[3] : "1"}`;
    const found = await discoverServerHost(seed, 520);
    if (found) {
      const saved = await persistServerHost(found);
      return { host: saved, reachable: true, discovered: true };
    }
  }
  return { host: persisted, reachable: false, discovered: false };
}

export async function loadPersistedServerHost() {
  const parsed = await readPersistedConfig();
  if (parsed.serverHost) setServerHost(parsed.serverHost);
  if (parsed.mapLayer) setMapLayer(parsed.mapLayer);
  if (typeof parsed.weatherRadarEnabled === "boolean") setWeatherRadarEnabled(parsed.weatherRadarEnabled);
  if (typeof parsed.gpsDeviationWarningsEnabled === "boolean") {
    setGpsDeviationWarningsEnabled(parsed.gpsDeviationWarningsEnabled);
  }
  if (parsed.operatorId) {
    operatorId = parsed.operatorId;
  } else {
    operatorId = `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await writePersistedConfig({ ...parsed, operatorId, operatorName });
  }
  if (parsed.operatorName) operatorName = parsed.operatorName;
  operatorListeners.forEach((cb) => cb(operatorId));
  setMockFeedEnabled(false);
  return serverHost;
}

export async function persistServerHost(nextHost: string) {
  const next = setServerHost(nextHost);
  const current = await readPersistedConfig();
  const mergedLayer = current.mapLayer ?? mapLayer;
  const mergedWeatherRadarEnabled =
    typeof current.weatherRadarEnabled === "boolean" ? current.weatherRadarEnabled : weatherRadarEnabled;
  const mergedGpsDeviationWarningsEnabled =
    typeof current.gpsDeviationWarningsEnabled === "boolean" ? current.gpsDeviationWarningsEnabled : gpsDeviationWarningsEnabled;
  const payload = {
    serverHost: next,
    mapLayer: mergedLayer,
    weatherRadarEnabled: mergedWeatherRadarEnabled,
    gpsDeviationWarningsEnabled: mergedGpsDeviationWarningsEnabled,
    operatorId,
    operatorName,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await writePersistedConfig(payload);
    const verify = await readPersistedConfig();
    const savedHost = verify.serverHost ? normalizeHost(verify.serverHost) : "";
    if (savedHost && savedHost === next) {
      return savedHost;
    }
  }
  throw new Error("Persistenza host fallita");
}

export async function persistMapLayer(nextLayer: string) {
  const next = setMapLayer(nextLayer);
  const current = await readPersistedConfig();
  const mergedHost = current.serverHost ? normalizeHost(current.serverHost) : serverHost;
  const mergedWeatherRadarEnabled =
    typeof current.weatherRadarEnabled === "boolean" ? current.weatherRadarEnabled : weatherRadarEnabled;
  const mergedGpsDeviationWarningsEnabled =
    typeof current.gpsDeviationWarningsEnabled === "boolean" ? current.gpsDeviationWarningsEnabled : gpsDeviationWarningsEnabled;
  if (mergedHost && mergedHost !== serverHost) {
    setServerHost(mergedHost);
  }
  const finalHost = mergedHost || serverHost;
  await writePersistedConfig({
    serverHost: finalHost,
    mapLayer: next,
    weatherRadarEnabled: mergedWeatherRadarEnabled,
    gpsDeviationWarningsEnabled: mergedGpsDeviationWarningsEnabled,
    operatorId,
    operatorName,
  });
  const verify = await readPersistedConfig();
  if (verify.mapLayer) {
    setMapLayer(verify.mapLayer);
  }
  if (verify.serverHost) {
    setServerHost(verify.serverHost);
  }
  return mapLayer;
}

export async function persistWeatherRadarEnabled(enabled: boolean) {
  const next = setWeatherRadarEnabled(enabled);
  const current = await readPersistedConfig();
  const mergedHost = current.serverHost ? normalizeHost(current.serverHost) : serverHost;
  const mergedLayer = current.mapLayer ? normalizeMapLayer(current.mapLayer) : mapLayer;
  const mergedGpsDeviationWarningsEnabled =
    typeof current.gpsDeviationWarningsEnabled === "boolean" ? current.gpsDeviationWarningsEnabled : gpsDeviationWarningsEnabled;
  await writePersistedConfig({
    serverHost: mergedHost,
    mapLayer: mergedLayer,
    weatherRadarEnabled: next,
    gpsDeviationWarningsEnabled: mergedGpsDeviationWarningsEnabled,
    operatorId,
    operatorName,
  });
  const verify = await readPersistedConfig();
  if (verify.serverHost) setServerHost(verify.serverHost);
  if (verify.mapLayer) setMapLayer(verify.mapLayer);
  if (typeof verify.weatherRadarEnabled === "boolean") setWeatherRadarEnabled(verify.weatherRadarEnabled);
  return weatherRadarEnabled;
}

export async function persistGpsDeviationWarningsEnabled(enabled: boolean) {
  const next = setGpsDeviationWarningsEnabled(enabled);
  const current = await readPersistedConfig();
  const mergedHost = current.serverHost ? normalizeHost(current.serverHost) : serverHost;
  const mergedLayer = current.mapLayer ? normalizeMapLayer(current.mapLayer) : mapLayer;
  const mergedWeatherRadarEnabled =
    typeof current.weatherRadarEnabled === "boolean" ? current.weatherRadarEnabled : weatherRadarEnabled;
  await writePersistedConfig({
    serverHost: mergedHost,
    mapLayer: mergedLayer,
    weatherRadarEnabled: mergedWeatherRadarEnabled,
    gpsDeviationWarningsEnabled: next,
    operatorId,
    operatorName,
  });
  const verify = await readPersistedConfig();
  if (verify.serverHost) setServerHost(verify.serverHost);
  if (verify.mapLayer) setMapLayer(verify.mapLayer);
  if (typeof verify.weatherRadarEnabled === "boolean") setWeatherRadarEnabled(verify.weatherRadarEnabled);
  if (typeof verify.gpsDeviationWarningsEnabled === "boolean") {
    setGpsDeviationWarningsEnabled(verify.gpsDeviationWarningsEnabled);
  }
  return gpsDeviationWarningsEnabled;
}

export async function persistMockFeedEnabled(enabled: boolean) {
  return setMockFeedEnabled(enabled);
}
