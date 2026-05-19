import { AltitudeProfile } from "@/components/ui/AltitudeProfile";
import { FloatingCamera } from "@/components/ui/FloatingCamera";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowPressable } from "@/components/ui/GlowPressable";
import { RainViewerOverlay } from "@/components/ui/RainViewerOverlay";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { useTelemetry } from "@/hooks/useTelemetry";
import {
    getHomePoint,
    getMissionHistory,
    getMissionHistoryDetail,
    getPoiFavorites,
    getSavedMissions,
    loadMissionPreset,
    MissionHistoryItem,
    MissionWaypoint,
    PoiFavorite,
    resumeDeliveryMission,
    SavedMissionSummary,
    saveMissionPreset,
    sendSimpleCmd,
    setHomeToCurrentDronePoint,
    startDeliveryMission,
    startMission,
    suggestTerrainAltitude,
} from "@/lib/api";
import { getStoredHomePoint, persistHomePoint, subscribeHomePoint } from "@/lib/homeStore";
import { deliveryWaypointMarkerImage, droneMapMarker, homeMapMarker, photoWaypointMarkerImage, waypointMarkerImage } from "@/lib/mapMarkerAssets";
import { persistMissionPlan } from "@/lib/missionPlanStore";
import { getMapLayer, getWeatherRadarEnabled, MapLayer, subscribeMapLayer, subscribeWeatherRadar } from "@/lib/runtimeConfig";
import { fonts, theme } from "@/lib/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Modal, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MapView, { MapPressEvent, Marker, Polyline } from "react-native-maps";

type PresetType = "consegna" | "sopralluogo";
type UiWaypoint = {
  id: number;
  latitude: number;
  longitude: number;
  altitude: number;
};

type MissionDialog = {
  title: string;
  message: string;
  primaryLabel: string;
  onPrimary: () => void | Promise<void>;
  secondaryLabel?: string;
};

const DEFAULT_BASE = { latitude: 44.3845, longitude: 7.5432 };
const MIN_MISSION_ALTITUDE = 2;
const MAX_MISSION_ALTITUDE = 500;
const MISSION_SPEED_MPS = 5;
const USABLE_FLIGHT_MINUTES = 38;
const BATTERY_RESERVE_PERCENT = 20;
const TAKEOFF_AND_SETUP_SECONDS = 45;
const PHOTO_ACTION_SECONDS = 12;
const ROUTE_MARGIN = 1.18;
const DEFAULT_PHOTO_COUNT = 1;
const DEFAULT_PHOTO_INTERVAL_SECONDS = 2;
const DEFAULT_PHOTO_TOTAL_SECONDS = 6;
const DEFAULT_PHOTO_GIMBAL_PITCH = -90;

function fmt5(v: number) {
  return v.toFixed(5);
}

function fmtTime(ts?: number | null) {
  if (!ts) return "-";
  return new Date(ts * 1000).toLocaleString();
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function buildPhotoMissionConfig(input: {
  hoverSeconds: number;
  photoCount: number;
  photoIntervalSeconds: number;
  photoTotalSeconds: number;
  gimbalPitch: number;
}) {
  const photoCount = clamp(Math.round(input.photoCount), 1, 10);
  const photoIntervalSeconds = clamp(input.photoIntervalSeconds, 0, 30);
  const sequenceSeconds = Math.max(0, photoCount - 1) * photoIntervalSeconds;
  const photoTotalSeconds = Math.max(input.photoTotalSeconds, sequenceSeconds);
  const hoverSeconds = Math.max(input.hoverSeconds, photoTotalSeconds);
  return {
    hover_seconds: hoverSeconds,
    photo_count: photoCount,
    photo_interval_seconds: photoIntervalSeconds,
    photo_total_seconds: photoTotalSeconds,
    gimbal_pitch: clamp(input.gimbalPitch, -90, 30),
  };
}

function distanceMeters(a: MissionWaypoint, b: MissionWaypoint) {
  const r = 6371000;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function estimateMissionAutonomy(waypoints: MissionWaypoint[]) {
  const horizontalMeters = waypoints.slice(1).reduce((total, wp, idx) => total + distanceMeters(waypoints[idx], wp), 0);
  const climbMeters = waypoints.slice(1).reduce((total, wp, idx) => {
    const previous = waypoints[idx];
    return total + Math.max(0, Number(wp.altitude ?? 0) - Number(previous.altitude ?? 0));
  }, 0);
  const descentMeters = waypoints.slice(1).reduce((total, wp, idx) => {
    const previous = waypoints[idx];
    return total + Math.max(0, Number(previous.altitude ?? 0) - Number(wp.altitude ?? 0));
  }, 0);
  const hoverSeconds = waypoints.reduce((total, wp) => total + Number(wp.hover_seconds ?? 0), 0);
  const photoSeconds = waypoints.reduce((total, wp) => {
    if (wp.action !== "TAKE_PHOTO" && wp.action !== "TAKE_PHOTO_EXPERIMENTAL") return total;
    const configured = Number(wp.photo_total_seconds ?? 0);
    return total + Math.max(PHOTO_ACTION_SECONDS, configured);
  }, 0);
  const flightSeconds =
    (horizontalMeters / MISSION_SPEED_MPS +
      climbMeters / 2 +
      descentMeters / 3 +
      hoverSeconds +
      photoSeconds +
      TAKEOFF_AND_SETUP_SECONDS) *
    ROUTE_MARGIN;
  const requiredPercent = (flightSeconds / 60 / USABLE_FLIGHT_MINUTES) * 100;

  return {
    distanceKm: horizontalMeters / 1000,
    minutes: flightSeconds / 60,
    requiredPercent,
    requiredWithReserve: requiredPercent + BATTERY_RESERVE_PERCENT,
  };
}

function estimateMissionBattery(waypoints: MissionWaypoint[], currentBattery?: number | null) {
  const autonomy = estimateMissionAutonomy(waypoints);
  const currentPercent = typeof currentBattery === "number" ? clamp(currentBattery, 0, 100) : null;
  const estimatedEndPercent = currentPercent == null ? null : clamp(currentPercent - autonomy.requiredPercent, 0, 100);
  const reserveMarginPercent = estimatedEndPercent == null ? null : estimatedEndPercent - BATTERY_RESERVE_PERCENT;
  return {
    ...autonomy,
    currentPercent,
    estimatedEndPercent,
    reserveMarginPercent,
    hasBattery: currentPercent != null,
    isBelowReserve: reserveMarginPercent != null && reserveMarginPercent < 0,
  };
}

function stepAltitudeDown(v: number) {
  if (v <= MIN_MISSION_ALTITUDE) return MIN_MISSION_ALTITUDE;

  if (v <= 10) {
    return clamp(v - 1, MIN_MISSION_ALTITUDE, MAX_MISSION_ALTITUDE);
  }

  return clamp(v - 5, 10, MAX_MISSION_ALTITUDE);
}

function stepAltitudeUp(v: number) {
  if (v < 10) {
    return clamp(v + 1, MIN_MISSION_ALTITUDE, 10);
  }

  return clamp(v + 5, 10, MAX_MISSION_ALTITUDE);
}

function mapTypeFromLayer(layer: MapLayer): "standard" | "satellite" | "hybrid" {
  if (layer === "satellite") return "satellite";
  if (layer === "hybrid") return "hybrid";
  return "standard";
}

function isNearCoordinate(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  return Math.abs(a.latitude - b.latitude) < 0.00002 && Math.abs(a.longitude - b.longitude) < 0.00002;
}

function confirmCritical(title: string, message: string, onConfirm: () => void, destructive = false) {
  Alert.alert(title, message, [
    { text: "Annulla", style: "cancel" },
    { text: "Conferma", style: destructive ? "destructive" : "default", onPress: onConfirm },
  ]);
}

function isSopralluogoPreset(preset: PresetType) {
  return preset === "sopralluogo";
}

export default function MissioniScreen() {
  const { snapshot, connected } = useTelemetry();
  const [preset, setPreset] = useState<PresetType>("consegna");
  const [points, setPoints] = useState<UiWaypoint[]>([]);
  const [altitude, setAltitude] = useState(30);
  const [hoverSeconds, setHoverSeconds] = useState(8);
  const [photoEvery, setPhotoEvery] = useState(2);
  const [photoCount, setPhotoCount] = useState(DEFAULT_PHOTO_COUNT);
  const [photoIntervalSeconds, setPhotoIntervalSeconds] = useState(DEFAULT_PHOTO_INTERVAL_SECONDS);
  const [photoTotalSeconds, setPhotoTotalSeconds] = useState(DEFAULT_PHOTO_TOTAL_SECONDS);
  const [photoGimbalPitch, setPhotoGimbalPitch] = useState(DEFAULT_PHOTO_GIMBAL_PITCH);
  const [layer, setLayer] = useState<MapLayer>(getMapLayer());
  const [weatherRadarEnabled, setWeatherRadarEnabled] = useState(getWeatherRadarEnabled());
  const [homeBase, setHomeBase] = useState(getStoredHomePoint());
  const [poiItems, setPoiItems] = useState<PoiFavorite[]>([]);
  const [selectedPoiId, setSelectedPoiId] = useState<number | null>(null);
  const [poiOpen, setPoiOpen] = useState(false);
  const [history, setHistory] = useState<MissionHistoryItem[]>([]);
  const [historyDetailOpen, setHistoryDetailOpen] = useState(false);
  const [historyDetailTitle, setHistoryDetailTitle] = useState("");
  const [historyDetailWaypoints, setHistoryDetailWaypoints] = useState<MissionWaypoint[]>([]);
  const [savedMissions, setSavedMissions] = useState<SavedMissionSummary[]>([]);
  const [savedMissionOpen, setSavedMissionOpen] = useState(false);
  const [selectedMissionName, setSelectedMissionName] = useState<string>("");
  const [saveModalVisible, setSaveModalVisible] = useState(false);
  const [missionDialog, setMissionDialog] = useState<MissionDialog | null>(null);
  const [missionNameDraft, setMissionNameDraft] = useState("");
  const [deliverySplitIndex, setDeliverySplitIndex] = useState<number | null>(null);
  const [photoIndices, setPhotoIndices] = useState<number[]>([]);
  const [terrainHint, setTerrainHint] = useState("Quota terreno: in attesa waypoint.");
  const askedHomeRef = useRef(false);

  useEffect(() => subscribeMapLayer(setLayer), []);
  useEffect(() => subscribeWeatherRadar(setWeatherRadarEnabled), []);
  useEffect(() => subscribeHomePoint(setHomeBase), []);

  const reloadData = useCallback(async () => {
    try {
      const [poi, hist, saved] = await Promise.all([getPoiFavorites(), getMissionHistory(12), getSavedMissions()]);
      setPoiItems(poi);
      setHistory(hist);
      setSavedMissions(saved);
      if (!selectedMissionName && saved.length > 0) {
        setSelectedMissionName(saved[0].mission_name);
      }
    } catch {
      // ignore
    }
  }, [selectedMissionName]);

  useEffect(() => {
    reloadData();
  }, [reloadData]);

  useEffect(() => {
    setDeliverySplitIndex((prev) => (prev == null || prev < points.length ? prev : null));
    setPhotoIndices((prev) => prev.filter((idx) => idx < points.length));
  }, [points.length]);

  useEffect(() => {
    if (preset !== "consegna") setDeliverySplitIndex(null);
  }, [preset]);

  const isPhotoPoint = useCallback(
    (index: number) => isSopralluogoPreset(preset) && (photoIndices.length > 0 ? photoIndices.includes(index) : index % photoEvery === 0),
    [photoEvery, photoIndices, preset],
  );

  const togglePhotoPoint = (index: number) => {
    setPhotoIndices((prev) => {
      const base = prev.length > 0 ? prev : points.map((_, i) => (i % photoEvery === 0 ? i : -1)).filter((i) => i >= 0);
      return base.includes(index) ? base.filter((i) => i !== index) : [...base, index].sort((a, b) => a - b);
    });
  };

  useEffect(() => {
    (async () => {
      try {
        const home = await getHomePoint();
        if (home.available && home.lat != null && home.lon != null) {
          await persistHomePoint({ lat: home.lat, lon: home.lon });
          return;
        }
      } catch {
        // ignore and fallback to local value
      }
      if (!askedHomeRef.current) {
        askedHomeRef.current = true;
        Alert.alert(
          "Home mancante",
          "Nessuna home impostata. Setta home al punto attuale del drone?",
          [
            { text: "Annulla", style: "cancel" },
            {
              text: "Setta Home",
              onPress: async () => {
                try {
                  const res = await setHomeToCurrentDronePoint();
                  if (res.sent && res.lat != null && res.lon != null) {
                    await persistHomePoint({ lat: res.lat, lon: res.lon });
                    Alert.alert("Home impostata", "Home salvata e pronta per le missioni.");
                  } else {
                    Alert.alert("Errore", res.error ?? "Impossibile impostare home.");
                  }
                } catch {
                  Alert.alert("Errore rete", "Server non raggiungibile.");
                }
              },
            },
          ],
        );
      }
    })();
  }, []);

  const base = useMemo(() => {
    if (homeBase?.lat != null && homeBase?.lon != null) {
      return { latitude: homeBase.lat, longitude: homeBase.lon };
    }
    if (snapshot?.telemetry.latitude != null && snapshot?.telemetry.longitude != null) {
      return { latitude: snapshot.telemetry.latitude, longitude: snapshot.telemetry.longitude };
    }
    return DEFAULT_BASE;
  }, [homeBase?.lat, homeBase?.lon, snapshot?.telemetry.latitude, snapshot?.telemetry.longitude]);

  const initialRegion = useMemo(
    () => ({
      latitude: base.latitude,
      longitude: base.longitude,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    }),
    [base.latitude, base.longitude],
  );

  const payload = useMemo(() => {
    const photoMissionConfig = buildPhotoMissionConfig({
      hoverSeconds,
      photoCount,
      photoIntervalSeconds,
      photoTotalSeconds,
      gimbalPitch: photoGimbalPitch,
    });
    const baseWp: MissionWaypoint = {
      lat: base.latitude,
      lon: base.longitude,
      altitude,
      action: "NONE",
      hover_seconds: 0,
    };

    const missionCore = points.map((p, i): MissionWaypoint => {
      if (isSopralluogoPreset(preset)) {
        const isPhoto = isPhotoPoint(i);
        return {
          lat: p.latitude,
          lon: p.longitude,
          altitude: p.altitude,
          action: isPhoto ? "TAKE_PHOTO_EXPERIMENTAL" : "NONE",
          hover_seconds: isPhoto ? photoMissionConfig.hover_seconds : 0,
          photo_count: isPhoto ? photoMissionConfig.photo_count : undefined,
          photo_interval_seconds: isPhoto ? photoMissionConfig.photo_interval_seconds : undefined,
          photo_total_seconds: isPhoto ? photoMissionConfig.photo_total_seconds : undefined,
          gimbal_pitch: isPhoto ? photoMissionConfig.gimbal_pitch : undefined,
        };
      }
      return {
        lat: p.latitude,
        lon: p.longitude,
        altitude: p.altitude,
        action: "NONE",
        hover_seconds: i === points.length - 1 ? hoverSeconds : 0,
      };
    });

    return [baseWp, ...missionCore, baseWp];
  }, [
    altitude,
    base.latitude,
    base.longitude,
    hoverSeconds,
    isPhotoPoint,
    photoCount,
    photoGimbalPitch,
    photoIntervalSeconds,
    photoTotalSeconds,
    points,
    preset,
  ]);

  const missionProfileWaypoints = useMemo(
    () => {
      const photoMissionConfig = buildPhotoMissionConfig({
        hoverSeconds,
        photoCount,
        photoIntervalSeconds,
        photoTotalSeconds,
        gimbalPitch: photoGimbalPitch,
      });
      return points.map((p, i): MissionWaypoint => {
        const isPhoto = isSopralluogoPreset(preset) && isPhotoPoint(i);
        return {
          lat: p.latitude,
          lon: p.longitude,
          altitude: p.altitude,
          action: isPhoto ? "TAKE_PHOTO_EXPERIMENTAL" : "NONE",
          hover_seconds: preset === "consegna" && i === points.length - 1
            ? hoverSeconds
            : isPhoto
              ? photoMissionConfig.hover_seconds
              : 0,
          photo_count: isPhoto ? photoMissionConfig.photo_count : undefined,
          photo_interval_seconds: isPhoto ? photoMissionConfig.photo_interval_seconds : undefined,
          photo_total_seconds: isPhoto ? photoMissionConfig.photo_total_seconds : undefined,
          gimbal_pitch: isPhoto ? photoMissionConfig.gimbal_pitch : undefined,
        };
      });
    },
    [hoverSeconds, isPhotoPoint, photoCount, photoGimbalPitch, photoIntervalSeconds, photoTotalSeconds, points, preset],
  );

  const missionBatteryEstimate = useMemo(
    () => estimateMissionBattery(payload, snapshot?.battery.percent),
    [payload, snapshot?.battery.percent],
  );

  const droneCoord = useMemo(() => {
    const lat = snapshot?.telemetry.latitude;
    const lon = snapshot?.telemetry.longitude;
    if (lat == null || lon == null) return null;
    return { latitude: lat, longitude: lon };
  }, [snapshot?.telemetry.latitude, snapshot?.telemetry.longitude]);

  const launch = async () => {
    const ensureFlying = () => {
      if (snapshot?.telemetry.is_flying) return true;
      setMissionDialog({
        title: "Decollo richiesto",
        message: "Decolla prima di avviare la missione. Vuoi decollare ora?",
        primaryLabel: "DECOLLA ORA",
        secondaryLabel: "ANNULLA",
        onPrimary: async () => {
          setMissionDialog(null);
          try {
            const res = await sendSimpleCmd("takeoff");
            if (!res.sent) {
              setMissionDialog({
                title: "Decollo non riuscito",
                message: res.error ?? "Comando non inviato dal middleware.",
                primaryLabel: "OK",
                onPrimary: () => setMissionDialog(null),
              });
            }
          } catch {
            setMissionDialog({
              title: "Server non raggiungibile",
              message: "Impossibile inviare il decollo al middleware Python.",
              primaryLabel: "OK",
              onPrimary: () => setMissionDialog(null),
            });
          }
        },
      });
      return false;
    };

    const sendMission = async () => {
      if (!ensureFlying()) return;
      try {
        const missionName = missionNameDraft.trim() || selectedMissionName || undefined;
        const res =
          preset === "consegna" && deliverySplitIndex != null
            ? await startDeliveryMission(payload, deliverySplitIndex, MISSION_SPEED_MPS, 9, missionName)
            : await startMission(payload, MISSION_SPEED_MPS, 9, missionName);
        if (res.sent) {
          await persistMissionPlan(payload);
          await reloadData();
          setMissionDialog({
            title: "Missione inviata",
            message: `Preset ${preset.toUpperCase()} pronto con ${payload.length} waypoint tecnici.`,
            primaryLabel: "OK",
            onPrimary: () => setMissionDialog(null),
          });
        } else {
          setMissionDialog({
            title: "Errore invio",
            message: res.error ?? "Comando non inviato.",
            primaryLabel: "OK",
            onPrimary: () => setMissionDialog(null),
          });
        }
      } catch {
        setMissionDialog({
          title: "Errore rete",
          message: "Server Python non raggiungibile.",
          primaryLabel: "OK",
          onPrimary: () => setMissionDialog(null),
        });
      }
    };

    if (!homeBase) {
      setMissionDialog({
        title: "Home richiesta",
        message: "Imposta prima la Home del drone per calcolare correttamente la missione.",
        primaryLabel: "OK",
        onPrimary: () => setMissionDialog(null),
      });
      return;
    }
    if (points.length < 1) {
      setMissionDialog({
        title: "Missione incompleta",
        message: "Aggiungi almeno un waypoint operativo prima di inviare la missione.",
        primaryLabel: "OK",
        onPrimary: () => setMissionDialog(null),
      });
      return;
    }
    if (preset === "consegna" && deliverySplitIndex == null) {
      setMissionDialog({
        title: "Nessun punto consegna",
        message: "La tua missione non ha punti di consegna in cui atterrare, vuoi continuare lo stesso?",
        primaryLabel: "CONTINUA",
        secondaryLabel: "ANNULLA",
        onPrimary: async () => {
          setMissionDialog(null);
          await sendMission();
        },
      });
      return;
    }
    if (isSopralluogoPreset(preset) && !points.some((_, i) => isPhotoPoint(i))) {
      setMissionDialog({
        title: "Nessun punto foto",
        message: "La tua missione non ha punti foto, vuoi continuare lo stesso?",
        primaryLabel: "CONTINUA",
        secondaryLabel: "ANNULLA",
        onPrimary: async () => {
          setMissionDialog(null);
          await sendMission();
        },
      });
      return;
    }

    const estimate = missionBatteryEstimate;
    if (estimate.isBelowReserve) {
      setMissionDialog({
        title: "Autonomia insufficiente",
        message:
          `Batteria attuale ${estimate.currentPercent?.toFixed(0)}%. ` +
          `Consumo stimato ${estimate.requiredPercent.toFixed(0)}%, arrivo previsto a ${estimate.estimatedEndPercent?.toFixed(0)}%. ` +
          `Riserva minima ${BATTERY_RESERVE_PERCENT}% (${estimate.minutes.toFixed(1)} min, ${estimate.distanceKm.toFixed(2)} km). Vuoi inviare comunque?`,
        primaryLabel: "INVIA COMUNQUE",
        secondaryLabel: "ANNULLA",
        onPrimary: async () => {
          setMissionDialog(null);
          await sendMission();
        },
      });
      return;
    }

    await sendMission();
  };

  const saveCurrentMission = async () => {
    const missionName = missionNameDraft.trim();
    if (!missionName) {
      Alert.alert("Nome richiesto", "Inserisci nome missione.");
      return;
    }
    if (points.length < 1) {
      Alert.alert("Missione vuota", "Aggiungi almeno un waypoint operativo.");
      return;
    }
    const photoMissionConfig = buildPhotoMissionConfig({
      hoverSeconds,
      photoCount,
      photoIntervalSeconds,
      photoTotalSeconds,
      gimbalPitch: photoGimbalPitch,
    });
    const operational = points.map((p, i): MissionWaypoint => {
      const isPhoto = isSopralluogoPreset(preset) && isPhotoPoint(i);
      return {
        lat: p.latitude,
        lon: p.longitude,
        altitude: p.altitude,
        action: isPhoto ? "TAKE_PHOTO_EXPERIMENTAL" : "NONE",
        hover_seconds: preset === "consegna" && i === points.length - 1
          ? hoverSeconds
          : isPhoto
            ? photoMissionConfig.hover_seconds
            : 0,
        photo_count: isPhoto ? photoMissionConfig.photo_count : undefined,
        photo_interval_seconds: isPhoto ? photoMissionConfig.photo_interval_seconds : undefined,
        photo_total_seconds: isPhoto ? photoMissionConfig.photo_total_seconds : undefined,
        gimbal_pitch: isPhoto ? photoMissionConfig.gimbal_pitch : undefined,
      };
    });
    try {
      const res = await saveMissionPreset({
        mission_name: missionName,
        preset,
        waypoints: operational,
        auto_speed: 5,
        max_speed: 9,
        finished_action: "GO_HOME",
      });
      if (!res.saved) {
        Alert.alert("Errore", res.error ?? "Salvataggio missione fallito.");
        return;
      }
      setSelectedMissionName(missionName);
      setSaveModalVisible(false);
      await reloadData();
      Alert.alert("Missione salvata", `Preset "${missionName}" salvato su Python JSON.`);
    } catch {
      Alert.alert("Errore rete", "Server Python non raggiungibile.");
    }
  };

  const loadSelectedMission = async () => {
    if (!selectedMissionName) return;
    try {
      const res = await loadMissionPreset(selectedMissionName);
      if (!res.found || !res.item) {
        Alert.alert("Errore", res.error ?? "Missione non trovata.");
        return;
      }
      const hasExperimentalPhotos = (res.item.waypoints || []).some((wp) => wp.action === "TAKE_PHOTO_EXPERIMENTAL");
      const loadedPreset =
        res.item.preset === "sopralluogo" || res.item.preset === "sopralluogo_experimental" || hasExperimentalPhotos
            ? "sopralluogo"
            : "consegna";
      setPreset(loadedPreset);
      if (loadedPreset !== "sopralluogo") {
        setPhotoCount(DEFAULT_PHOTO_COUNT);
        setPhotoIntervalSeconds(DEFAULT_PHOTO_INTERVAL_SECONDS);
        setPhotoTotalSeconds(DEFAULT_PHOTO_TOTAL_SECONDS);
        setPhotoGimbalPitch(DEFAULT_PHOTO_GIMBAL_PITCH);
      }
      setPhotoIndices(
        loadedPreset === "sopralluogo"
          ? (res.item.waypoints || [])
              .map((wp, i) => (wp.action === "TAKE_PHOTO_EXPERIMENTAL" || wp.action === "TAKE_PHOTO" ? i : -1))
              .filter((i) => i >= 0)
          : [],
      );
      const firstPhotoWaypoint = (res.item.waypoints || []).find((wp) => wp.action === "TAKE_PHOTO_EXPERIMENTAL" || wp.action === "TAKE_PHOTO");
      if (firstPhotoWaypoint) {
        setPhotoCount(clamp(Number(firstPhotoWaypoint.photo_count ?? DEFAULT_PHOTO_COUNT), 1, 10));
        setPhotoIntervalSeconds(clamp(Number(firstPhotoWaypoint.photo_interval_seconds ?? DEFAULT_PHOTO_INTERVAL_SECONDS), 0, 30));
        setPhotoTotalSeconds(Math.max(
          Number(firstPhotoWaypoint.photo_total_seconds ?? DEFAULT_PHOTO_TOTAL_SECONDS),
          Number(firstPhotoWaypoint.photo_interval_seconds ?? DEFAULT_PHOTO_INTERVAL_SECONDS) * Math.max(0, Number(firstPhotoWaypoint.photo_count ?? DEFAULT_PHOTO_COUNT) - 1),
        ));
        setPhotoGimbalPitch(clamp(Number(firstPhotoWaypoint.gimbal_pitch ?? DEFAULT_PHOTO_GIMBAL_PITCH), -90, 30));
      }
      const loadedPoints: UiWaypoint[] = (res.item.waypoints || []).map((wp, i) => ({
        id: Date.now() + i,
        latitude: wp.lat,
        longitude: wp.lon,
        altitude: Number(wp.altitude || altitude),
      }));
      setPoints(loadedPoints);
      setMissionNameDraft(res.item.mission_name || "");
      if (loadedPoints.length > 0) {
        setAltitude(Math.round(Number(loadedPoints[0].altitude || altitude)));
      }
      setSavedMissionOpen(false);
      Alert.alert("Missione caricata", `Caricata: ${res.item.mission_name}`);
    } catch {
      Alert.alert("Errore rete", "Server Python non raggiungibile.");
    }
  };

  const onMapPress = async (ev: MapPressEvent) => {
    const { latitude, longitude } = ev.nativeEvent.coordinate;
    const prev = points.length > 0 ? points[points.length - 1] : { latitude: base.latitude, longitude: base.longitude };
    const id = Date.now() + points.length;
    setPoints((current) => [
      ...current,
      {
        id,
        latitude,
        longitude,
        altitude,
      },
    ]);
    setTerrainHint(`WP aggiunto a ${altitude}m. Calcolo quota terreno in corso...`);
    try {
      const terrain = await suggestTerrainAltitude({
        lat: latitude,
        lon: longitude,
        prev_lat: prev.latitude,
        prev_lon: prev.longitude,
        home_lat: base.latitude,
        home_lon: base.longitude,
        base_agl: altitude,
      });
      if (terrain.ok && Number.isFinite(terrain.suggested_altitude)) {
        const smartAltitude = clamp(Math.round(terrain.suggested_altitude), MIN_MISSION_ALTITUDE, MAX_MISSION_ALTITUDE);
        setPoints((current) => current.map((p) => (p.id === id ? { ...p, altitude: smartAltitude } : p)));
        setTerrainHint(
          `Quota intelligente WP: ${smartAltitude}m | Terreno medio ${terrain.terrain?.average_elevation ?? "-"}m, max ${terrain.terrain?.max_elevation ?? "-"}m`,
        );
      } else {
        setTerrainHint("Quota terreno non disponibile: uso altitudine corrente.");
      }
    } catch {
      setTerrainHint(`Server quota non raggiungibile: WP mantenuto a ${altitude}m.`);
    }
  };

  const visiblePath = useMemo(
    () => [
      { latitude: base.latitude, longitude: base.longitude },
      ...points.map((p) => ({ latitude: p.latitude, longitude: p.longitude })),
      { latitude: base.latitude, longitude: base.longitude },
    ],
    [base.latitude, base.longitude, points],
  );

  function movePoint(index: number, delta: -1 | 1) {
    const to = index + delta;
    setPoints((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const tmp = next[index];
      next[index] = next[to];
      next[to] = tmp;
      return next;
    });
    setDeliverySplitIndex((prev) => {
      if (prev === index) return to;
      if (prev === to) return index;
      return prev;
    });
    setPhotoIndices((prev) =>
      prev
        .map((idx) => {
          if (idx === index) return to;
          if (idx === to) return index;
          return idx;
        })
        .sort((a, b) => a - b),
    );
  }

  function removePoint(index: number) {
    setPoints((prev) => prev.filter((_, i) => i !== index));
    setDeliverySplitIndex((prev) => {
      if (prev == null) return null;
      if (prev === index) return null;
      return prev > index ? prev - 1 : prev;
    });
    setPhotoIndices((prev) => prev.filter((idx) => idx !== index).map((idx) => (idx > index ? idx - 1 : idx)));
  }

  function addSelectedPoi() {
    const poi = poiItems.find((p) => p.id === selectedPoiId);
    if (!poi) {
      Alert.alert("POI non selezionato", "Seleziona un POI dal menu.");
      return;
    }
    setPoints((prev) => [
      ...prev,
      {
        id: Date.now() + prev.length,
        latitude: poi.lat,
        longitude: poi.lon,
        altitude: poi.altitude || altitude,
      },
    ]);
    setPoiOpen(false);
  }

  const selectedPoi = poiItems.find((p) => p.id === selectedPoiId);

  const loadHistoryDetail = async (item: MissionHistoryItem) => {
    try {
      const detail = await getMissionHistoryDetail(item.id);
      const raw = detail.waypoints ?? [];
      const operational =
        raw.length >= 3 &&
        Math.abs(raw[0].lat - raw[raw.length - 1].lat) < 0.00001 &&
        Math.abs(raw[0].lon - raw[raw.length - 1].lon) < 0.00001
          ? raw.slice(1, -1)
          : raw;
      setHistoryDetailTitle(item.mission_name || `Missione ${item.id}`);
      setHistoryDetailWaypoints(operational);
      setHistoryDetailOpen(true);
    } catch {
      Alert.alert("Errore rete", "Impossibile caricare il riepilogo missione.");
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="always" nestedScrollEnabled>
        <Text style={styles.title}>MISSION CREATOR</Text>
        <Text style={styles.subtitle}>Mappa + lista waypoint ordinabile + inserimento POI da SQLite</Text>

        <GlassCard>
          <SectionTitle title="STATO MISSIONE LIVE" />
          <View style={styles.liveRow}>
            <Text style={[styles.liveBadge, connected ? styles.ok : styles.err]}>{connected ? "ONLINE" : "OFFLINE"}</Text>
            <Text style={styles.liveText}>
              Stato: {snapshot?.mission.state ?? "IDLE"} | WP: {snapshot?.mission.waypoint_index ?? "-"}
            </Text>
          </View>
          <Text style={styles.note}>
            Home: {homeBase ? `${fmt5(homeBase.lat)}, ${fmt5(homeBase.lon)}` : "NON IMPOSTATA"} | Layer {layer.toUpperCase()}
          </Text>
          {snapshot?.delivery?.waiting_operator ? (
            <View style={styles.rowSingle}>
              <GlowPressable
                style={[styles.actionBtn, styles.actionPrimary]}
                onPress={() =>
                  confirmCritical(
                    "Conferma rientro consegna",
                    "Vuoi autorizzare la seconda tratta e far rientrare il drone alla base?",
                    () => {
                      void (async () => {
                        try {
                          const res = await resumeDeliveryMission();
                          if (!res.sent) {
                            Alert.alert("Ripartenza non riuscita", res.error ?? "Comando non inviato");
                            return;
                          }
                          Alert.alert("Cargo rilasciato", "Cargo rilasciato. Seconda tratta missione consegna avviata.");
                        } catch {
                          Alert.alert("Errore rete", "Server non raggiungibile.");
                        }
                      })();
                    },
                  )
                }
              >
                <Text style={styles.actionText}>RIPARTI CONSEGNA</Text>
              </GlowPressable>
            </View>
          ) : null}
          <View style={styles.rowSingle}>
            <GlowPressable
              style={[styles.actionBtn, styles.actionPrimary]}
              onPress={() =>
                confirmCritical(
                  "Conferma nuova Home",
                  "Vuoi impostare la Home al punto attuale del drone? Cambia il punto di rientro delle missioni.",
                  () => {
                    void (async () => {
                      try {
                        const res = await setHomeToCurrentDronePoint();
                        if (res.sent && res.lat != null && res.lon != null) {
                          await persistHomePoint({ lat: res.lat, lon: res.lon });
                          Alert.alert("Home aggiornata", "Home impostata al punto attuale del drone.");
                        } else {
                          Alert.alert("Errore", res.error ?? "Impossibile impostare home.");
                        }
                      } catch {
                        Alert.alert("Errore rete", "Server non raggiungibile.");
                      }
                    })();
                  },
                )
              }
            >
              <Text style={styles.actionText}>SET HOME (POSIZIONE ATTUALE)</Text>
            </GlowPressable>
          </View>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="PRESET" />
          <View style={styles.presetRow}>
            <GlowPressable style={[styles.preset, preset === "consegna" && styles.presetActive]} onPress={() => setPreset("consegna")}>
              <Text style={styles.presetText}>CONSEGNA</Text>
            </GlowPressable>
            <GlowPressable style={[styles.preset, preset === "sopralluogo" && styles.presetActive]} onPress={() => setPreset("sopralluogo")}>
              <Text style={styles.presetText}>SOPRALLUOGO</Text>
            </GlowPressable>
          </View>
          {preset === "consegna" ? (
            <Text style={styles.note}>
              Effettua consegna qui: {deliverySplitIndex != null ? `WP ${deliverySplitIndex + 1}` : "seleziona un waypoint nella lista"}
            </Text>
          ) : (
            <Text style={styles.note}>
              Punti foto: {points.length === 0 ? "aggiungi waypoint" : points.map((_, i) => (isPhotoPoint(i) ? `WP ${i + 1}` : "")).filter(Boolean).join(", ") || "nessuno"}
            </Text>
          )}
        </GlassCard>

        <GlassCard>
          <SectionTitle title="SALVA / CARICA" />
          <Text style={styles.note}>Nome missione: {missionNameDraft.trim() || "(non impostato)"}</Text>
          <View style={styles.row}>
            <GlowPressable style={[styles.actionBtn, styles.actionPrimary]} onPress={() => setSaveModalVisible(true)}>
              <Text style={styles.actionText}>SALVA</Text>
            </GlowPressable>
            {savedMissions.length > 0 ? (
              <GlowPressable style={[styles.actionBtn, styles.actionPrimary]} onPress={loadSelectedMission}>
                <Text style={styles.actionText}>CARICA</Text>
              </GlowPressable>
            ) : null}
          </View>
          {savedMissions.length > 0 ? (
            <>
              <GlowPressable style={styles.selectBtn} onPress={() => setSavedMissionOpen((v) => !v)}>
                <Text style={styles.selectText}>{selectedMissionName || "Seleziona missione salvata"}</Text>
              </GlowPressable>
              {savedMissionOpen ? (
                <View style={styles.dropdown}>
                  {savedMissions.map((m) => (
                    <GlowPressable
                      key={`saved-${m.mission_name}`}
                      style={styles.dropdownItem}
                      onPress={() => {
                        setSelectedMissionName(m.mission_name);
                        setSavedMissionOpen(false);
                      }}
                    >
                      <Text style={styles.dropdownText}>{m.mission_name}</Text>
                      <Text style={styles.dropdownMeta}>WP {m.waypoints_count}</Text>
                    </GlowPressable>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
        </GlassCard>

        <GlassCard>
          <SectionTitle title="POI PREFERITI" />
          <GlowPressable style={styles.selectBtn} onPress={() => setPoiOpen((v) => !v)}>
            <Text style={styles.selectText}>{selectedPoi ? `${selectedPoi.name} (${fmt5(selectedPoi.lat)}, ${fmt5(selectedPoi.lon)})` : "Seleziona POI"}</Text>
          </GlowPressable>
          {poiOpen ? (
            <View style={styles.dropdown}>
              {poiItems.length === 0 ? (
                <Text style={styles.note}>Nessun POI salvato.</Text>
              ) : (
                poiItems.map((poi) => (
                  <GlowPressable
                    key={`poi-pick-${poi.id}`}
                    style={styles.dropdownItem}
                    onPress={() => {
                      setSelectedPoiId(poi.id);
                      setPoiOpen(false);
                    }}
                  >
                    <Text style={styles.dropdownText}>{poi.name}</Text>
                    <Text style={styles.dropdownMeta}>{fmt5(poi.lat)}, {fmt5(poi.lon)}</Text>
                  </GlowPressable>
                ))
              )}
            </View>
          ) : null}
          <View style={styles.row}>
            <GlowPressable style={[styles.actionBtn, styles.actionPrimary]} onPress={addSelectedPoi}>
              <Text style={styles.actionText}>AGGIUNGI POI ALLA LISTA WAYPOINT</Text>
            </GlowPressable>
          </View>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="PARAMETRI RAPIDI" />
          <View style={styles.row}>
            <View style={styles.paramBox}>
              <Text style={styles.paramLabel}>ALTITUDINE (m)</Text>
              <View style={styles.counterRow}>
                <GlowPressable style={styles.stepBtn} onPress={() => setAltitude((v) => stepAltitudeDown(v))}>
                  <Text style={styles.stepText}>-</Text>
                </GlowPressable>
                <Text style={styles.paramValue}>{altitude}</Text>
                <GlowPressable style={styles.stepBtn} onPress={() => setAltitude((v) => stepAltitudeUp(v))}>
                  <Text style={styles.stepText}>+</Text>
                </GlowPressable>
              </View>
            </View>
            <View style={styles.paramBox}>
              <Text style={styles.paramLabel}>{preset === "consegna" ? "HOVER FINALE (s)" : "FOTO OGNI N WP"}</Text>
              <View style={styles.counterRow}>
                <GlowPressable
                  style={styles.stepBtn}
                  onPress={() =>
                    preset === "consegna"
                      ? setHoverSeconds((v) => clamp(v - 2, 0, 120))
                      : setPhotoEvery((v) => clamp(v - 1, 1, 10))
                  }
                >
                  <Text style={styles.stepText}>-</Text>
                </GlowPressable>
                <Text style={styles.paramValue}>{preset === "consegna" ? hoverSeconds : photoEvery}</Text>
                <GlowPressable
                  style={styles.stepBtn}
                  onPress={() =>
                    preset === "consegna"
                      ? setHoverSeconds((v) => clamp(v + 2, 0, 120))
                      : setPhotoEvery((v) => clamp(v + 1, 1, 10))
                  }
                >
                  <Text style={styles.stepText}>+</Text>
                </GlowPressable>
              </View>
            </View>
          </View>
        </GlassCard>

        {preset === "sopralluogo" ? (
          <GlassCard>
            <SectionTitle title="ROUTINE FOTO WAYPOINT" />
            <View style={styles.row}>
              <View style={styles.paramBox}>
                <Text style={styles.paramLabel}>NUMERO CICLI FOTO</Text>
                <View style={styles.counterRow}>
                  <GlowPressable style={styles.stepBtn} onPress={() => setPhotoCount((v) => clamp(v - 1, 1, 10))}>
                    <Text style={styles.stepText}>-</Text>
                  </GlowPressable>
                  <Text style={styles.paramValue}>{photoCount}</Text>
                  <GlowPressable style={styles.stepBtn} onPress={() => setPhotoCount((v) => clamp(v + 1, 1, 10))}>
                    <Text style={styles.stepText}>+</Text>
                  </GlowPressable>
                </View>
              </View>
              <View style={styles.paramBox}>
                <Text style={styles.paramLabel}>INTERVALLO TRA CICLI (s)</Text>
                <View style={styles.counterRow}>
                  <GlowPressable style={styles.stepBtn} onPress={() => setPhotoIntervalSeconds((v) => clamp(v - 1, 0, 30))}>
                    <Text style={styles.stepText}>-</Text>
                  </GlowPressable>
                  <Text style={styles.paramValue}>{photoIntervalSeconds}</Text>
                  <GlowPressable style={styles.stepBtn} onPress={() => setPhotoIntervalSeconds((v) => clamp(v + 1, 0, 30))}>
                    <Text style={styles.stepText}>+</Text>
                  </GlowPressable>
                </View>
              </View>
            </View>
            <View style={styles.row}>
              <View style={styles.paramBox}>
                <Text style={styles.paramLabel}>TEMPO TOTALE MINIMO (s)</Text>
                <View style={styles.counterRow}>
                  <GlowPressable style={styles.stepBtn} onPress={() => setPhotoTotalSeconds((v) => clamp(v - 1, 0, 120))}>
                    <Text style={styles.stepText}>-</Text>
                  </GlowPressable>
                  <Text style={styles.paramValue}>{photoTotalSeconds}</Text>
                  <GlowPressable style={styles.stepBtn} onPress={() => setPhotoTotalSeconds((v) => clamp(v + 1, 0, 120))}>
                    <Text style={styles.stepText}>+</Text>
                  </GlowPressable>
                </View>
              </View>
              <View style={styles.paramBox}>
                <Text style={styles.paramLabel}>PITCH GIMBAL FOTO</Text>
                <View style={styles.counterRow}>
                  <GlowPressable style={styles.stepBtn} onPress={() => setPhotoGimbalPitch((v) => clamp(v - 5, -90, 30))}>
                    <Text style={styles.stepText}>-</Text>
                  </GlowPressable>
                  <Text style={styles.paramValue}>{photoGimbalPitch}</Text>
                  <GlowPressable style={styles.stepBtn} onPress={() => setPhotoGimbalPitch((v) => clamp(v + 5, -90, 30))}>
                    <Text style={styles.stepText}>+</Text>
                  </GlowPressable>
                </View>
              </View>
            </View>
            <Text style={styles.note}>
              Ogni waypoint foto farà hover, imposterà il pitch gimbal scelto e lancerà la sequenza WIDE + ZOOM + IR per ogni ciclo.
            </Text>
          </GlassCard>
        ) : null}

        {missionProfileWaypoints.length > 0 ? (
          <GlassCard>
            <SectionTitle title="RIEPILOGO MISSIONE" />
            <AltitudeProfile waypoints={missionProfileWaypoints} />
            <Text style={styles.note}>
              Profilo calcolato sui waypoint operativi della missione.
            </Text>
            <View style={styles.autonomyBox}>
              <Text style={styles.autonomyTitle}>AUTONOMIA STIMATA</Text>
              <View style={styles.autonomyRow}>
                <Text style={styles.autonomyLabel}>MISSIONE</Text>
                <Text style={styles.autonomyValue}>
                  {missionBatteryEstimate.minutes.toFixed(1)} min | {missionBatteryEstimate.distanceKm.toFixed(2)} km
                </Text>
              </View>
              <View style={styles.autonomyRow}>
                <Text style={styles.autonomyLabel}>CONSUMO</Text>
                <Text style={styles.autonomyValue}>{missionBatteryEstimate.requiredPercent.toFixed(0)}%</Text>
              </View>
              <View style={styles.autonomyRow}>
                <Text style={styles.autonomyLabel}>BATTERIA ORA</Text>
                <Text style={styles.autonomyValue}>
                  {missionBatteryEstimate.hasBattery ? `${missionBatteryEstimate.currentPercent?.toFixed(0)}%` : "telemetria assente"}
                </Text>
              </View>
              <View style={styles.autonomyRow}>
                <Text style={styles.autonomyLabel}>FINE MISSIONE</Text>
                <Text style={[styles.autonomyValue, missionBatteryEstimate.isBelowReserve ? styles.autonomyDanger : styles.autonomyOk]}>
                  {missionBatteryEstimate.hasBattery ? `${missionBatteryEstimate.estimatedEndPercent?.toFixed(0)}%` : "-"}
                </Text>
              </View>
              <Text style={[styles.note, missionBatteryEstimate.isBelowReserve ? styles.autonomyDanger : null]}>
                {missionBatteryEstimate.hasBattery
                  ? missionBatteryEstimate.isBelowReserve
                    ? `Attenzione: sotto la riserva minima del ${BATTERY_RESERVE_PERCENT}% di ${Math.abs(missionBatteryEstimate.reserveMarginPercent ?? 0).toFixed(0)} punti.`
                    : `Margine sopra riserva: ${(missionBatteryEstimate.reserveMarginPercent ?? 0).toFixed(0)} punti.`
                  : "La stima usera' la batteria reale appena arriva la telemetria dal drone."}
              </Text>
            </View>
          </GlassCard>
        ) : null}

        <GlassCard>
          <SectionTitle title="MAPPA OPERATIVA (TAP PER WAYPOINT)" />
          <View style={styles.mapWrap}>
            <MapView
              style={styles.map}
              mapType={mapTypeFromLayer(layer)}
              initialRegion={initialRegion}
              onPress={onMapPress}
              showsCompass
              showsScale
            >
              <RainViewerOverlay enabled={weatherRadarEnabled} />
              {droneCoord ? (
                <Marker
                  coordinate={droneCoord}
                  title="DRONE"
                  description={`ALT ${(snapshot?.telemetry.altitude ?? 0).toFixed(1)} m`}
                  anchor={{ x: 0.5, y: 0.5 }}
                  image={droneMapMarker}
                  zIndex={1000}
                />
              ) : null}
              <Marker
                coordinate={base}
                title="BASE / HOME"
                description="Punto di partenza e rientro missione"
                anchor={{ x: 0.5, y: 0.5 }}
                image={homeMapMarker}
                zIndex={900}
              />
              {points.map((p, i) => {
                const coord = { latitude: p.latitude, longitude: p.longitude };
                if (isNearCoordinate(coord, base)) return null;
                return (
                  <Marker
                    key={p.id}
                    coordinate={coord}
                    title={`WP ${i + 1}`}
                    description={
                      preset === "consegna" && deliverySplitIndex === i
                        ? `PUNTO CONSEGNA | ALT ${p.altitude}m`
                        : isSopralluogoPreset(preset) && isPhotoPoint(i)
                          ? `PUNTO FOTO | ALT ${p.altitude}m`
                        : `ALT ${p.altitude}m`
                    }
                    anchor={{ x: 0.5, y: 0.5 }}
                    image={
                      preset === "consegna" && deliverySplitIndex === i
                        ? deliveryWaypointMarkerImage(i)
                        : isSopralluogoPreset(preset) && isPhotoPoint(i)
                          ? photoWaypointMarkerImage(i)
                        : waypointMarkerImage(i)
                    }
                    zIndex={preset === "consegna" && deliverySplitIndex === i ? 700 : isSopralluogoPreset(preset) && isPhotoPoint(i) ? 650 : 500}
                  />
                );
              })}
              {visiblePath.length >= 2 ? <Polyline coordinates={visiblePath} strokeColor="rgba(82,247,122,0.92)" strokeWidth={3} /> : null}
            </MapView>
          </View>
          <Text style={styles.note}>Sequenza inviata: BASE, waypoint operativi, BASE.</Text>
          <Text style={styles.note}>{terrainHint}</Text>
          <View style={styles.row}>
            <GlowPressable style={styles.actionBtn} onPress={() => setPoints((p) => p.slice(0, -1))}>
              <Text style={styles.actionText}>UNDO</Text>
            </GlowPressable>
            <GlowPressable style={styles.actionBtn} onPress={() => setPoints([])}>
              <Text style={styles.actionText}>CLEAR</Text>
            </GlowPressable>
            <GlowPressable style={[styles.actionBtn, styles.actionPrimary]} onPress={launch}>
              <Text style={styles.actionText}>INVIA</Text>
            </GlowPressable>
          </View>
        </GlassCard>

        <GlassCard>
          <SectionTitle title={`LISTA WAYPOINT (${points.length})`} />
          {points.length === 0 ? (
            <Text style={styles.note}>Aggiungi waypoint dalla mappa o dai POI.</Text>
          ) : (
            points.map((p, i) => (
              <View key={`list-wp-${p.id}`} style={styles.wpRow}>
                <View style={styles.wpInfo}>
                  <Text style={styles.wpTitle}>
                    WP {i + 1}
                    {preset === "consegna" && deliverySplitIndex === i ? " | CONSEGNA" : ""}
                    {isSopralluogoPreset(preset) && isPhotoPoint(i) ? " | FOTO" : ""}
                  </Text>
                  <Text style={styles.wpMeta}>{fmt5(p.latitude)}, {fmt5(p.longitude)} | ALT {p.altitude}m</Text>
                </View>
                <View style={styles.wpBtns}>
                  <GlowPressable style={styles.wpBtn} onPress={() => movePoint(i, -1)}>
                    <Text style={styles.wpBtnText}>^</Text>
                  </GlowPressable>
                  <GlowPressable style={styles.wpBtn} onPress={() => movePoint(i, 1)}>
                    <Text style={styles.wpBtnText}>v</Text>
                  </GlowPressable>
                  {preset === "consegna" ? (
                    <GlowPressable
                      style={[styles.wpBtn, deliverySplitIndex === i ? styles.wpBtnActive : null]}
                      onPress={() => setDeliverySplitIndex((prev) => (prev === i ? null : i))}
                    >
                      <Text style={styles.wpBtnText}>{deliverySplitIndex === i ? "CONSEGNA ON" : "CONSEGNA"}</Text>
                    </GlowPressable>
                  ) : (
                    <GlowPressable
                      style={[styles.wpBtn, isPhotoPoint(i) ? styles.wpBtnActive : null]}
                      onPress={() => togglePhotoPoint(i)}
                    >
                      <Text style={styles.wpBtnText}>{isPhotoPoint(i) ? "FOTO ON" : "FOTO"}</Text>
                    </GlowPressable>
                  )}
                  <GlowPressable
                    style={styles.wpBtn}
                    onPress={() =>
                      setPoints((prev) =>
                        prev.map((x, idx) =>
                          idx === i
                            ? { ...x, altitude: stepAltitudeUp(x.altitude) }
                            : x
                        )
                      )
                    }
                  >
                    <Text style={styles.wpBtnText}>+ALT</Text>
                  </GlowPressable>

                  <GlowPressable
                    style={styles.wpBtn}
                    onPress={() =>
                      setPoints((prev) =>
                        prev.map((x, idx) =>
                          idx === i
                            ? { ...x, altitude: stepAltitudeDown(x.altitude) }
                            : x
                        )
                      )
                    }
                  >
                    <Text style={styles.wpBtnText}>-ALT</Text>
                  </GlowPressable>
                  <GlowPressable style={[styles.wpBtn, styles.wpBtnDanger]} onPress={() => removePoint(i)}>
                    <Text style={styles.wpBtnText}>X</Text>
                  </GlowPressable>
                </View>
              </View>
            ))
          )}
        </GlassCard>

        <GlassCard>
          <SectionTitle title="STORICO MISSIONI (SQLITE)" right={<GlowPressable onPress={reloadData}><Text style={styles.linkText}>RICARICA</Text></GlowPressable>} />
          {history.length === 0 ? (
            <Text style={styles.note}>Nessuna missione nello storico.</Text>
          ) : (
            history.map((m) => (
              <GlowPressable key={`mh-${m.id}`} style={styles.histRow} onPress={() => loadHistoryDetail(m)}>
                <Text style={styles.histTitle}>{m.mission_name || `Missione ${m.id}`}</Text>
                <Text style={styles.histMeta}>
                  {m.status} | WP {m.total_waypoints} | Start {fmtTime(m.started_at)} | End {fmtTime(m.ended_at)}
                </Text>
              </GlowPressable>
            ))
          )}
        </GlassCard>
      </ScrollView>
      <Modal transparent visible={saveModalVisible} animationType="fade" onRequestClose={() => setSaveModalVisible(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Inserisci nome missione</Text>
            <TextInput
              style={styles.modalInput}
              value={missionNameDraft}
              onChangeText={setMissionNameDraft}
              placeholder="es. Sopralluogo Nord"
              placeholderTextColor="rgba(214,244,255,0.45)"
              autoFocus
            />
            <View style={styles.row}>
              <GlowPressable style={styles.actionBtn} onPress={() => setSaveModalVisible(false)}>
                <Text style={styles.actionText}>ANNULLA</Text>
              </GlowPressable>
              <GlowPressable style={[styles.actionBtn, styles.actionPrimary]} onPress={saveCurrentMission}>
                <Text style={styles.actionText}>CONFERMA SALVA</Text>
              </GlowPressable>
            </View>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={historyDetailOpen} animationType="fade" onRequestClose={() => setHistoryDetailOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{historyDetailTitle}</Text>
            <AltitudeProfile waypoints={historyDetailWaypoints} />
            <Text style={styles.note}>Riepilogo quota dei waypoint missione salvati nello storico.</Text>
            <GlowPressable style={[styles.actionBtn, styles.actionPrimary]} onPress={() => setHistoryDetailOpen(false)}>
              <Text style={styles.actionText}>CHIUDI</Text>
            </GlowPressable>
          </View>
        </View>
      </Modal>
      <Modal transparent visible={missionDialog != null} animationType="fade" onRequestClose={() => setMissionDialog(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, styles.confirmCard]}>
            <View style={styles.confirmIcon}>
              <Text style={styles.confirmIconText}>!</Text>
            </View>
            <Text style={styles.modalTitle}>{missionDialog?.title}</Text>
            <Text style={styles.confirmText}>{missionDialog?.message}</Text>
            <View style={styles.row}>
              {missionDialog?.secondaryLabel ? (
                <GlowPressable style={styles.actionBtn} onPress={() => setMissionDialog(null)}>
                  <Text style={styles.actionText}>{missionDialog.secondaryLabel}</Text>
                </GlowPressable>
              ) : null}
              <GlowPressable style={[styles.actionBtn, styles.actionPrimary]} onPress={() => void missionDialog?.onPrimary()}>
                <Text style={styles.actionText}>{missionDialog?.primaryLabel ?? "OK"}</Text>
              </GlowPressable>
            </View>
          </View>
        </View>
      </Modal>
      <FloatingCamera bottom={104} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, gap: 14, paddingBottom: 90 },
  title: { color: theme.text, fontSize: 22, letterSpacing: 2.4, fontFamily: fonts.heading },
  subtitle: { color: theme.textMuted, fontFamily: fonts.body },
  liveRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveBadge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  liveText: { color: theme.textMuted, fontFamily: fonts.body, fontSize: 12 },
  ok: { color: theme.accent2, borderColor: "rgba(125,255,166,0.5)" },
  err: { color: theme.danger, borderColor: "rgba(255,106,106,0.5)" },
  presetRow: { flexDirection: "row", gap: 10 },
  preset: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  presetActive: {
    borderColor: "rgba(82,247,122,0.72)",
    backgroundColor: "rgba(82,247,122,0.12)",
  },
  presetText: { color: theme.text, fontFamily: fonts.mono, letterSpacing: 1.4, fontSize: 12 },
  row: { flexDirection: "row", gap: 10 },
  rowSingle: { marginTop: 8 },
  paramBox: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  paramLabel: { color: theme.textMuted, fontFamily: fonts.mono, fontSize: 11, marginBottom: 8 },
  counterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  stepBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(82,247,122,0.12)",
  },
  stepText: { color: theme.text, fontFamily: fonts.mono, fontSize: 16 },
  paramValue: { color: theme.text, fontFamily: fonts.heading, fontSize: 20, letterSpacing: 1.2 },
  mapWrap: {
    marginTop: 6,
    height: 380,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(125,255,166,0.28)",
    overflow: "hidden",
  },
  map: { flex: 1 },
  note: { marginTop: 8, color: theme.textMuted, fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
  autonomyBox: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 10,
    backgroundColor: "rgba(255,255,255,0.025)",
    gap: 6,
  },
  autonomyTitle: { color: theme.text, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.2 },
  autonomyRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  autonomyLabel: { color: theme.textMuted, fontFamily: fonts.mono, fontSize: 10, flex: 1 },
  autonomyValue: { color: theme.text, fontFamily: fonts.mono, fontSize: 12, textAlign: "right", flex: 1.4 },
  autonomyOk: { color: theme.accent2 },
  autonomyDanger: { color: theme.danger },
  actionBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    alignItems: "center",
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  actionPrimary: {
    borderColor: "rgba(82,247,122,0.72)",
    backgroundColor: "rgba(82,247,122,0.14)",
  },
  actionText: { color: theme.text, fontFamily: fonts.mono, letterSpacing: 1.1, fontSize: 11 },
  selectBtn: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  selectText: { color: theme.text, fontFamily: fonts.body, fontSize: 12 },
  dropdown: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    overflow: "hidden",
  },
  dropdownItem: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderBottomWidth: 1,
    borderBottomColor: "rgba(82,247,122,0.14)",
  },
  dropdownText: { color: theme.text, fontFamily: fonts.body, fontWeight: "700" },
  dropdownMeta: { color: theme.textMuted, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  wpRow: {
    gap: 8,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  wpInfo: { width: "100%" },
  wpTitle: { color: theme.text, fontFamily: fonts.body, fontWeight: "700" },
  wpMeta: { color: theme.textMuted, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
  wpBtns: { flexDirection: "row", gap: 6, flexWrap: "wrap", width: "100%" },
  wpBtn: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: "rgba(82,247,122,0.1)",
  },
  wpBtnActive: {
    borderColor: "rgba(125,255,166,0.7)",
    backgroundColor: "rgba(125,255,166,0.18)",
  },
  wpBtnDanger: { borderColor: "rgba(255,106,106,0.6)", backgroundColor: "rgba(255,106,106,0.16)" },
  wpBtnText: { color: theme.text, fontFamily: fonts.mono, fontSize: 11 },
  histRow: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  histTitle: { color: theme.text, fontFamily: fonts.body, fontWeight: "700" },
  histMeta: { color: theme.textMuted, fontFamily: fonts.mono, fontSize: 11, marginTop: 3 },
  linkText: { color: theme.accent, fontFamily: fonts.mono, fontSize: 11 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20,
  },
  modalCard: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(4,18,10,0.98)",
    padding: 14,
    gap: 10,
  },
  confirmCard: {
    borderRadius: 22,
    borderColor: "rgba(82,247,122,0.42)",
    backgroundColor: "rgba(3,15,8,0.98)",
    padding: 18,
  },
  confirmIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(167,255,106,0.55)",
    backgroundColor: "rgba(82,247,122,0.14)",
    alignSelf: "center",
  },
  confirmIconText: { color: theme.accent2, fontFamily: fonts.heading, fontSize: 24, lineHeight: 28 },
  confirmText: { color: theme.textMuted, fontFamily: fonts.body, fontSize: 14, lineHeight: 20, textAlign: "center" },
  modalTitle: { color: theme.text, fontFamily: fonts.heading, letterSpacing: 1.4, fontSize: 18 },
  modalInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
    color: theme.text,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontFamily: fonts.body,
  },
});
