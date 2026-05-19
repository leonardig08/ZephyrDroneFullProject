import * as FileSystem from "expo-file-system/legacy";

export type StoredHomePoint = {
  lat: number;
  lon: number;
};

type HomeListener = (home: StoredHomePoint | null) => void;

const CONFIG_PATH = `${FileSystem.documentDirectory ?? ""}zephyr_home_point.json`;
let storedHomePoint: StoredHomePoint | null = null;
const listeners = new Set<HomeListener>();

export function getStoredHomePoint() {
  return storedHomePoint;
}

export function subscribeHomePoint(listener: HomeListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((cb) => cb(storedHomePoint));
}

export function setStoredHomePoint(home: StoredHomePoint | null) {
  storedHomePoint = home;
  notify();
}

export async function persistHomePoint(home: StoredHomePoint | null) {
  setStoredHomePoint(home);
  if (!FileSystem.documentDirectory) return;
  await FileSystem.writeAsStringAsync(
    CONFIG_PATH,
    JSON.stringify({ home }, null, 2),
  );
}

export async function loadPersistedHomePoint() {
  if (!FileSystem.documentDirectory) return storedHomePoint;
  try {
    const info = await FileSystem.getInfoAsync(CONFIG_PATH);
    if (!info.exists) return storedHomePoint;
    const raw = await FileSystem.readAsStringAsync(CONFIG_PATH);
    const parsed = JSON.parse(raw) as { home?: StoredHomePoint | null };
    const home = parsed.home;
    if (home && typeof home.lat === "number" && typeof home.lon === "number") {
      setStoredHomePoint(home);
    }
  } catch {
    // ignore parse/read errors
  }
  return storedHomePoint;
}
