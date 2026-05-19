import * as FileSystem from "expo-file-system/legacy";
import { MissionWaypoint } from "@/lib/api";

type MissionListener = (waypoints: MissionWaypoint[]) => void;

const CONFIG_PATH = `${FileSystem.documentDirectory ?? ""}zephyr_mission_plan.json`;
let lastMissionWaypoints: MissionWaypoint[] = [];
const listeners = new Set<MissionListener>();

export function getLastMissionWaypoints() {
  return lastMissionWaypoints;
}

export function subscribeMissionPlan(listener: MissionListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  listeners.forEach((cb) => cb(lastMissionWaypoints));
}

export function setLastMissionWaypoints(waypoints: MissionWaypoint[]) {
  lastMissionWaypoints = waypoints;
  notify();
}

export async function persistMissionPlan(waypoints: MissionWaypoint[]) {
  setLastMissionWaypoints(waypoints);
  if (!FileSystem.documentDirectory) return;
  await FileSystem.writeAsStringAsync(
    CONFIG_PATH,
    JSON.stringify({ waypoints }, null, 2),
  );
}

export async function loadPersistedMissionPlan() {
  if (!FileSystem.documentDirectory) return lastMissionWaypoints;
  try {
    const info = await FileSystem.getInfoAsync(CONFIG_PATH);
    if (!info.exists) return lastMissionWaypoints;
    const raw = await FileSystem.readAsStringAsync(CONFIG_PATH);
    const parsed = JSON.parse(raw) as { waypoints?: MissionWaypoint[] };
    if (Array.isArray(parsed.waypoints)) {
      setLastMissionWaypoints(parsed.waypoints);
    }
  } catch {
    // ignore parse/read errors
  }
  return lastMissionWaypoints;
}
