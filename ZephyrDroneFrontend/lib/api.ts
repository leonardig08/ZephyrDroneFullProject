import {
  CameraMode,
  getApiBase,
  getOperatorId,
  getOperatorName,
  getWsBase,
  setCurrentCameraMode,
  setPhotoCaptureActive,
  setRecordingActive,
} from "@/lib/runtimeConfig";

export type MissionWaypoint = {
  lat: number;
  lon: number;
  altitude: number;
  action?: "NONE" | "TAKE_PHOTO" | "TAKE_PHOTO_EXPERIMENTAL" | "RECORD_START" | "RECORD_STOP";
  hover_seconds?: number;
  photo_count?: number;
  photo_interval_seconds?: number;
  photo_total_seconds?: number;
  gimbal_pitch?: number;
};

export type DroneSnapshot = {
  connected: boolean;
  product_name?: string | null;
  current_camera?: CameraMode | null;
  telemetry: {
    latitude?: number | null;
    longitude?: number | null;
    altitude?: number | null;
    pitch?: number | null;
    roll?: number | null;
    yaw?: number | null;
    velocity_x?: number | null;
    velocity_y?: number | null;
    velocity_z?: number | null;
    gimbal_pitch?: number | null;
    gimbal_roll?: number | null;
    gimbal_yaw?: number | null;
    gimbal_yaw_relative?: number | null;
    is_flying?: boolean;
    gps_signal?: number | null;
  };
  battery: {
    percent?: number | null;
    temperature?: number | null;
  };
  mission: {
    state?: string | null;
    waypoint_index?: number | null;
    mission_name?: string | null;
    wayline_id?: number | null;
  };
  delivery?: {
    waiting_operator?: boolean;
    pending_return?: boolean;
    split_waypoint_index?: number | null;
  };
  landing_confirmation_needed?: boolean;
  reservation?: DroneReservationState;
};

type CmdResp = { sent: boolean; ack?: boolean | null; error?: string };

export type DroneReservationHolder = {
  operator_id: string;
  operator_name: string;
  client_host?: string;
  reserved_at?: number;
  expires_at?: number;
  ttl_seconds?: number;
  position?: number;
};

export type DroneReservationState = {
  held: boolean;
  holder?: DroneReservationHolder | null;
  queue: DroneReservationHolder[];
  queue_length: number;
  lease_ttl_seconds: number;
};

export type ManagedDrone = {
  id: string;
  name: string;
  model: string;
  connected: boolean;
  product_name?: string | null;
  reservation: DroneReservationState;
};

export type DroneReservationResponse = {
  ok: boolean;
  reserved: boolean;
  queued?: boolean;
  queue_position?: number;
  error?: string;
  drone: Omit<ManagedDrone, "reservation">;
  reservation: DroneReservationState;
};

function operatorHeaders() {
  const id = getOperatorId();
  return id ? { "X-Operator-Id": id, "X-Operator-Name": getOperatorName() } : {};
}

async function post<T = CmdResp>(path: string, params?: Record<string, string | number | boolean>) {
  const url = new URL(`${getApiBase()}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }
  const res = await fetch(url.toString(), { method: "POST", headers: operatorHeaders() });
  return (await res.json()) as T;
}

export async function sendSimpleCmd(cmd: string) {
  return post(`/cmd/${cmd}`);
}

export async function takePhoto() {
  setPhotoCaptureActive(true);
  try {
    const res = await post<CmdResp & { camera?: CameraMode }>("/cmd/take_photo");
    if (res.camera) setCurrentCameraMode(res.camera);
    return res;
  } finally {
    setPhotoCaptureActive(false);
  }
}

export async function toggleRecording() {
  const res = await post<CmdResp & { recording?: boolean }>("/cmd/toggle_record");
  if (typeof res.recording === "boolean") setRecordingActive(res.recording);
  return res;
}

export async function setZoom(ratio: number) {
  return post("/cmd/set_zoom", { ratio });
}

export async function measureThermalSpot(x: number, y: number, source = "react") {
  return post<CmdResp & { x?: number; y?: number; temperature?: number }>("/cmd/thermal_spot_measure", {
    x,
    y,
    source,
  });
}

export async function switchCamera(camera: "WIDE" | "ZOOM" | "IR") {
  const res = await post<CmdResp & { camera?: CameraMode }>("/cmd/switch_camera", { camera });
  if (res.sent && res.camera) setCurrentCameraMode(res.camera);
  return res;
}

export async function getCurrentCamera() {
  const res = await fetch(`${getApiBase()}/camera/current`);
  const data = (await res.json()) as { camera?: CameraMode };
  if (data.camera) setCurrentCameraMode(data.camera);
  return data;
}

export async function startMission(waypoints: MissionWaypoint[], autoSpeed = 5, maxSpeed = 8, missionName?: string) {
  const res = await fetch(`${getApiBase()}/cmd/start_mission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders() },
    body: JSON.stringify({
      waypoints,
      auto_speed: autoSpeed,
      max_speed: maxSpeed,
      finished_action: "GO_HOME",
      mission_name: missionName,
    }),
  });
  return (await res.json()) as CmdResp;
}

export async function startDeliveryMission(
  waypoints: MissionWaypoint[],
  deliverySplitIndex: number,
  autoSpeed = 5,
  maxSpeed = 8,
  missionName?: string,
) {
  const res = await fetch(`${getApiBase()}/cmd/start_mission`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders() },
    body: JSON.stringify({
      waypoints,
      auto_speed: autoSpeed,
      max_speed: maxSpeed,
      finished_action: "GO_HOME",
      mission_name: missionName,
      delivery_split_index: deliverySplitIndex,
    }),
  });
  return (await res.json()) as CmdResp & { delivery_split_applied?: boolean };
}

export async function resumeDeliveryMission() {
  return post<CmdResp>("/cmd/resume_delivery_mission");
}

export async function rotateGimbalSpeed(pitch_speed: number, yaw_speed: number, roll_speed = 0) {
  return post("/cmd/gimbal_rotate_speed", { pitch_speed, yaw_speed, roll_speed });
}

export async function rotateGimbalAngle(
  input: { pitch?: number; yaw?: number; roll?: number; relative?: boolean; duration?: number },
) {
  return post("/cmd/gimbal_rotate_angle", {
    ...input,
    relative: input.relative ?? true,
    duration: input.duration ?? 0.3,
  });
}

export async function resetGimbal(reset_type = "PITCH_YAW") {
  return post("/cmd/gimbal_reset", { reset_type });
}

export type NetworkSettings = {
  kotlin_host: string;
  kotlin_port: number;
  kotlin_ws_url?: string;
  go2rtc_url: string;
};

export type RtspInfo = {
  kotlin_host?: string;
  kotlin_port?: number;
  direct_rtsp_url?: string;
  rtsp_url?: string;
  go2rtc_api?: string;
  stream?: string;
};

export type HomePoint = {
  available: boolean;
  lat?: number | null;
  lon?: number | null;
};

export type PoiFavorite = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  altitude: number;
  note?: string | null;
  created_at: number;
  updated_at: number;
};

export type MissionHistoryItem = {
  id: number;
  mission_uuid: string;
  mission_name?: string | null;
  status: string;
  started_at: number;
  ended_at?: number | null;
  total_waypoints: number;
  last_state?: string | null;
};

export type MissionHistoryDetail = {
  found: boolean;
  mission?: MissionHistoryItem;
  waypoints?: MissionWaypoint[];
  error?: string;
};

export type SavedMissionSummary = {
  mission_name: string;
  preset?: string | null;
  waypoints_count: number;
  updated_at?: number | null;
};

export type SavedMissionItem = {
  mission_name: string;
  preset?: string | null;
  waypoints: MissionWaypoint[];
  auto_speed?: number;
  max_speed?: number;
  finished_action?: string;
  created_at?: number;
  updated_at?: number;
};

export type TerrainSuggestion = {
  ok: boolean;
  suggested_altitude: number;
  clearance_agl?: number;
  terrain?: {
    home_elevation?: number;
    target_elevation?: number;
    average_elevation?: number;
    min_elevation?: number;
    max_elevation?: number;
    ruggedness?: number;
  };
  error?: string;
};

export function getTelemetryWsUrl() {
  return getWsBase();
}

export function getApiBaseUrl() {
  return getApiBase();
}

export async function getDroneFleet() {
  const res = await fetch(`${getApiBase()}/drones`);
  const data = (await res.json()) as { items?: ManagedDrone[] };
  return data.items ?? [];
}

export async function reserveDrone(droneId: string) {
  const res = await fetch(`${getApiBase()}/drones/${droneId}/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders() },
    body: JSON.stringify({ operator_id: getOperatorId(), operator_name: getOperatorName() }),
  });
  return (await res.json()) as DroneReservationResponse;
}

export async function heartbeatDrone(droneId: string) {
  const res = await fetch(`${getApiBase()}/drones/${droneId}/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders() },
    body: JSON.stringify({ operator_id: getOperatorId() }),
  });
  return (await res.json()) as DroneReservationResponse;
}

export async function releaseDrone(droneId: string) {
  const res = await fetch(`${getApiBase()}/drones/${droneId}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...operatorHeaders() },
    body: JSON.stringify({ operator_id: getOperatorId() }),
  });
  return (await res.json()) as DroneReservationResponse & { released?: boolean };
}

export async function getNetworkSettings() {
  const res = await fetch(`${getApiBase()}/settings/network`);
  return (await res.json()) as NetworkSettings;
}

export async function getRtspInfo() {
  const res = await fetch(`${getApiBase()}/rtsp_info`);
  return (await res.json()) as RtspInfo;
}

export async function saveNetworkSettings(payload: {
  kotlin_host: string;
  kotlin_port: number;
  go2rtc_url: string;
}) {
  const res = await fetch(`${getApiBase()}/settings/network`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as NetworkSettings & { saved: boolean; reconnect_triggered?: boolean; error?: string };
}

export async function getHomePoint() {
  const res = await fetch(`${getApiBase()}/home`);
  return (await res.json()) as HomePoint;
}

export async function suggestTerrainAltitude(input: {
  lat: number;
  lon: number;
  prev_lat?: number;
  prev_lon?: number;
  home_lat?: number;
  home_lon?: number;
  base_agl?: number;
}) {
  const url = new URL(`${getApiBase()}/terrain/suggest_altitude`);
  Object.entries(input).forEach(([key, value]) => {
    if (value != null) url.searchParams.set(key, String(value));
  });
  const res = await fetch(url.toString());
  return (await res.json()) as TerrainSuggestion;
}

export async function setHomePoint(lat: number, lon: number) {
  return post<HomePoint & { sent: boolean }>("/cmd/set_home", { lat, lon });
}

export async function setHomeToCurrentDronePoint() {
  return post<HomePoint & { sent: boolean; error?: string }>("/cmd/set_home_current");
}

export async function getPoiFavorites() {
  const res = await fetch(`${getApiBase()}/poi`);
  const data = (await res.json()) as { items?: PoiFavorite[] };
  return data.items ?? [];
}

export async function createPoiFavorite(payload: {
  name: string;
  lat: number;
  lon: number;
  altitude?: number;
  note?: string;
}) {
  const res = await fetch(`${getApiBase()}/poi`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as { saved: boolean; item?: PoiFavorite; error?: string };
}

export async function deletePoiFavorite(id: number) {
  const res = await fetch(`${getApiBase()}/poi/${id}`, { method: "DELETE" });
  return (await res.json()) as { deleted: boolean };
}

export async function getMissionHistory(limit = 30) {
  const url = new URL(`${getApiBase()}/missions/history`);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url.toString());
  const data = (await res.json()) as { items?: MissionHistoryItem[] };
  return data.items ?? [];
}

export async function getMissionHistoryDetail(missionId: number) {
  const res = await fetch(`${getApiBase()}/missions/history/${missionId}`);
  const data = (await res.json()) as MissionHistoryDetail;
  return {
    ...data,
    waypoints: (data.waypoints ?? []).map((wp) => ({
      lat: Number(wp.lat),
      lon: Number(wp.lon),
      altitude: Number(wp.altitude ?? 0),
      action: wp.action ?? "NONE",
      hover_seconds: Number(wp.hover_seconds ?? 0),
      photo_count: Number(wp.photo_count ?? 1),
      photo_interval_seconds: Number(wp.photo_interval_seconds ?? 0),
      photo_total_seconds: Number(wp.photo_total_seconds ?? 0),
      gimbal_pitch: wp.gimbal_pitch == null ? undefined : Number(wp.gimbal_pitch),
    })),
  };
}

export async function getSavedMissions() {
  const res = await fetch(`${getApiBase()}/missions/saved`);
  const data = (await res.json()) as { items?: SavedMissionSummary[] };
  return data.items ?? [];
}

export async function saveMissionPreset(payload: {
  mission_name: string;
  preset: string;
  waypoints: MissionWaypoint[];
  auto_speed: number;
  max_speed: number;
  finished_action: string;
}) {
  const res = await fetch(`${getApiBase()}/missions/saved`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as { saved: boolean; item?: SavedMissionItem; error?: string };
}

export async function loadMissionPreset(missionName: string) {
  const url = new URL(`${getApiBase()}/missions/saved/load`);
  url.searchParams.set("mission_name", missionName);
  const res = await fetch(url.toString());
  return (await res.json()) as { found: boolean; item?: SavedMissionItem; error?: string };
}
