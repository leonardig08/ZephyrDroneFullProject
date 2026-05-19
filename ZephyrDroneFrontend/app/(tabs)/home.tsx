import { AltitudeProfile } from "@/components/ui/AltitudeProfile";
import { FloatingCamera } from "@/components/ui/FloatingCamera";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowPressable } from "@/components/ui/GlowPressable";
import { LiveFrameImage } from "@/components/ui/LiveFrameImage";
import { RainViewerOverlay } from "@/components/ui/RainViewerOverlay";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { useTelemetry } from "@/hooks/useTelemetry";
import { getCurrentCamera, resumeDeliveryMission, sendSimpleCmd, setZoom, switchCamera } from "@/lib/api";
import { droneMapMarker, homeMapMarker, waypointMarkerImage } from "@/lib/mapMarkerAssets";
import { getLastMissionWaypoints, subscribeMissionPlan } from "@/lib/missionPlanStore";
import {
  getCurrentCameraMode,
  getMapLayer,
  getMockFeedEnabled,
  getPhotoCaptureActive,
  getRecordingActive,
  getServerHost,
  getWeatherRadarEnabled,
  MapLayer,
  subscribePhotoCaptureActive,
  subscribeRecordingActive,
  setCurrentCameraMode,
  subscribeCurrentCameraMode,
  subscribeMapLayer,
  subscribeMockFeed,
  subscribeServerHost,
  subscribeWeatherRadar,
} from "@/lib/runtimeConfig";
import { fonts, theme } from "@/lib/theme";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useIsFocused } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, Easing, Image, ScrollView, StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline } from "react-native-maps";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function mapTypeFromLayer(layer: MapLayer): "standard" | "satellite" | "hybrid" {
  if (layer === "satellite") return "satellite";
  if (layer === "hybrid") return "hybrid";
  return "standard";
}

function isNearCoordinate(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  return Math.abs(a.latitude - b.latitude) < 0.00002 && Math.abs(a.longitude - b.longitude) < 0.00002;
}

async function cmd(name: string) {
  try {
    await sendSimpleCmd(name);
  } catch {
    // best effort
  }
}

function confirmCritical(title: string, message: string, onConfirm: () => void, destructive = false) {
  Alert.alert(title, message, [
    { text: "Annulla", style: "cancel" },
    { text: "Conferma", style: destructive ? "destructive" : "default", onPress: onConfirm },
  ]);
}

async function safeRun(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    // best effort camera controls
  }
}

export default function HomeScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const { snapshot } = useTelemetry();
  const [videoExpanded, setVideoExpanded] = useState(false);
  const [host, setHost] = useState(getServerHost());
  const [mapLayer, setMapLayer] = useState<MapLayer>(getMapLayer());
  const [weatherRadarEnabled, setWeatherRadarEnabled] = useState(getWeatherRadarEnabled());
  const [mockFeedEnabled, setMockFeedEnabled] = useState(getMockFeedEnabled());
  const [cameraMode, setCameraMode] = useState<"WIDE" | "ZOOM" | "IR">(getCurrentCameraMode());
  const [recordingActive, setRecordingUi] = useState(getRecordingActive());
  const [photoCaptureActive, setPhotoCaptureUi] = useState(getPhotoCaptureActive());
  const [zoomValue, setZoomValue] = useState(1);
  const [missionPlan, setMissionPlan] = useState(getLastMissionWaypoints());
  const [videoY, setVideoY] = useState(0);
  const [videoH, setVideoH] = useState(0);
  const [showDetachedCamera, setShowDetachedCamera] = useState(false);
  const scrollYRef = useRef(0);
  const heroPulse = useRef(new Animated.Value(0.55)).current;

  useEffect(() => subscribeServerHost(setHost), []);
  useEffect(() => subscribeMockFeed(setMockFeedEnabled), []);
  useEffect(() => subscribeCurrentCameraMode(setCameraMode), []);
  useEffect(() => subscribeRecordingActive(setRecordingUi), []);
  useEffect(() => subscribePhotoCaptureActive(setPhotoCaptureUi), []);
  useEffect(() => subscribeMapLayer(setMapLayer), []);
  useEffect(() => subscribeWeatherRadar(setWeatherRadarEnabled), []);
  useEffect(() => subscribeMissionPlan(setMissionPlan), []);
  useEffect(() => {
    safeRun(getCurrentCamera);
  }, []);
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(heroPulse, { toValue: 1, duration: 1800, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
        Animated.timing(heroPulse, { toValue: 0.55, duration: 1800, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [heroPulse]);

  const speed = useMemo(() => {
    const t = snapshot?.telemetry;
    if (!t?.velocity_x && !t?.velocity_y && !t?.velocity_z) return "0.0";
    const x = t.velocity_x ?? 0;
    const y = t.velocity_y ?? 0;
    const z = t.velocity_z ?? 0;
    return (Math.sqrt(x * x + y * y + z * z) * 3.6).toFixed(1);
  }, [snapshot]);

  const droneCoord = useMemo(() => {
    const lat = snapshot?.telemetry.latitude;
    const lon = snapshot?.telemetry.longitude;
    if (lat == null || lon == null) return null;
    return { latitude: lat, longitude: lon };
  }, [snapshot?.telemetry.latitude, snapshot?.telemetry.longitude]);

  const missionState = snapshot?.mission.state ?? "IDLE";
  const deliveryMissionActive = Boolean(snapshot?.delivery?.waiting_operator || snapshot?.delivery?.pending_return);
  const missionLoaded =
    missionPlan.length > 0 &&
    (deliveryMissionActive || !["IDLE", "READY", "FINISHED", "STOPPED"].includes(missionState.toUpperCase()));
  const activeMissionPlan = useMemo(() => (missionLoaded ? missionPlan : []), [missionLoaded, missionPlan]);

  const region = useMemo(() => {
    if (droneCoord) {
      return {
        ...droneCoord,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      };
    }
    if (activeMissionPlan.length > 0) {
      return {
        latitude: activeMissionPlan[0].lat,
        longitude: activeMissionPlan[0].lon,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02,
      };
    }
    return {
      latitude: 44.3845,
      longitude: 7.5432,
      latitudeDelta: 0.02,
      longitudeDelta: 0.02,
    };
  }, [activeMissionPlan, droneCoord]);

  const missionHomeCoord = useMemo(() => {
    if (activeMissionPlan.length > 0) {
      return { latitude: activeMissionPlan[0].lat, longitude: activeMissionPlan[0].lon };
    }
    return null;
  }, [activeMissionPlan]);

  const updateDetached = (nextScroll: number) => {
    const next = nextScroll > videoY + videoH - 28 && videoH > 0;
    setShowDetachedCamera((prev) => (prev === next ? prev : next));
  };
  const runCommand = (name: string) => {
    const sensitive: Record<string, { title: string; message: string }> = {
      takeoff: { title: "Conferma decollo", message: "Vuoi avviare il decollo ora?" },
      return_home: { title: "Conferma RTH", message: "Vuoi ordinare il rientro automatico alla home?" },
      land: { title: "Conferma atterraggio", message: "Vuoi avviare l'atterraggio ora?" },
      confirm_landing: { title: "Conferma atterraggio finale", message: "Confermi la chiusura della procedura di atterraggio?" },
    };
    const item = sensitive[name];
    if (!item) {
      void cmd(name);
      return;
    }
    confirmCritical(item.title, item.message, () => void cmd(name), ["takeoff", "land", "confirm_landing"].includes(name));
  };

  const changeCamera = async (next: "WIDE" | "ZOOM" | "IR") => {
    const res = await safeRun(() => switchCamera(next));
    if (!res?.sent || res.ack === false) return;
    setCurrentCameraMode(next);
    if (next === "ZOOM") safeRun(() => setZoom(zoomValue));
  };

  const bumpZoom = (delta: number) => {
    const next = Math.max(1, Math.min(56, Number((zoomValue + delta).toFixed(1))));
    setZoomValue(next);
    safeRun(() => setZoom(next));
  };

  const streamSrc = mockFeedEnabled ? (cameraMode === "IR" ? "ir" : cameraMode === "ZOOM" ? "zoom" : "dji") : "dji";

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={styles.content}
        scrollEventThrottle={16}
        onScroll={(ev) => {
          const y = ev.nativeEvent.contentOffset.y;
          scrollYRef.current = y;
          updateDetached(y);
        }}
      >
        <View style={styles.heroRow}>
          <View style={styles.heroLogoClip}>
            <Image source={require("../../assets/images/zephyr-logo.png")} style={styles.heroLogo} resizeMode="cover" />
          </View>
          <Animated.View style={[styles.heroDot, { opacity: heroPulse }]} />
        </View>
        <Text style={styles.heroSubtitle}>Video live, stato missione e mappa operativa in tempo reale.</Text>
        <GlowPressable style={styles.infoQuickBtn} onPress={() => router.push("/(tabs)/info")}>
          <MaterialCommunityIcons name="information-outline" size={16} color={theme.text} />
          <Text style={styles.infoQuickBtnText}>INFO PROGETTO</Text>
        </GlowPressable>

        <GlassCard>
          <SectionTitle
            title="VIDEO LIVE"
            right={
              <GlowPressable style={styles.smallBtn} onPress={() => setVideoExpanded((v) => !v)}>
                <Text style={styles.smallBtnText}>{videoExpanded ? "RIDUCI" : "ESPANDI"}</Text>
              </GlowPressable>
            }
          />
          <View
            style={[styles.videoWrap, videoExpanded && styles.videoWrapExpanded]}
            onLayout={(ev) => {
              setVideoY(ev.nativeEvent.layout.y);
              setVideoH(ev.nativeEvent.layout.height);
              updateDetached(scrollYRef.current);
            }}
          >
            <LiveFrameImage host={host} src={streamSrc} style={styles.video} intervalMs={130} paused={!isFocused} />
            <View style={styles.videoHud}>
              <Text style={[styles.hudPill, cameraMode === "IR" ? styles.hudDanger : styles.hudOk]}>{cameraMode}</Text>
              <View style={styles.videoHudRight}>
                {photoCaptureActive ? <Text style={[styles.hudPill, styles.hudWarn]}>PHOTO</Text> : null}
                {recordingActive ? <Text style={[styles.hudPill, styles.hudRec]}>REC</Text> : null}
              </View>
            </View>
            <View style={styles.cameraControls}>
              {(["WIDE", "ZOOM", "IR"] as const).map((mode) => (
                <GlowPressable
                  key={`home-cam-${mode}`}
                  style={[styles.cameraPill, cameraMode === mode && styles.cameraPillActive]}
                  onPress={() => changeCamera(mode)}
                >
                  <Text style={styles.cameraPillText}>{mode}</Text>
                </GlowPressable>
              ))}
              {cameraMode === "ZOOM" ? (
                <View style={styles.zoomInline}>
                  <GlowPressable style={styles.zoomBtn} onPress={() => bumpZoom(-1)}>
                    <Text style={styles.zoomBtnText}>-</Text>
                  </GlowPressable>
                  <Text style={styles.zoomValue}>{zoomValue.toFixed(1)}x</Text>
                  <GlowPressable style={styles.zoomBtn} onPress={() => bumpZoom(1)}>
                    <Text style={styles.zoomBtnText}>+</Text>
                  </GlowPressable>
                </View>
              ) : null}
            </View>
          </View>
          <Text style={styles.meta}>Fonte reale: MediaMTX/go2rtc RTSP-WebRTC. Frame HTTP solo in mock feed.</Text>
        </GlassCard>

        {snapshot?.delivery?.waiting_operator ? (
          <GlassCard>
            <SectionTitle title="CONSEGNA OPERATORE" />
            <Text style={styles.meta}>
              Il drone ha completato la tratta di consegna ed e in attesa conferma per rientrare.
            </Text>
            <View style={styles.rowSingle}>
              <GlowPressable
                style={[styles.btnWide, styles.btnGood]}
                onPress={() =>
                  confirmCritical(
                    "Conferma rientro consegna",
                    "Vuoi completare la consegna e autorizzare il drone a ripartire verso la base?",
                    () => {
                      void (async () => {
                        try {
                          const res = await resumeDeliveryMission();
                          if (!res.sent) {
                            Alert.alert("Ripartenza non riuscita", res.error ?? "Comando non inviato");
                            return;
                          }
                          Alert.alert("Cargo rilasciato", "Cargo rilasciato. Rientro consegna avviato.");
                        } catch {
                          Alert.alert("Errore rete", "Server non raggiungibile.");
                        }
                      })();
                    },
                  )
                }
              >
                <Text style={styles.btnText}>COMPLETA CONSEGNA E RITORNA</Text>
              </GlowPressable>
            </View>
          </GlassCard>
        ) : null}

        <GlassCard>
          <SectionTitle title="STATO MISSIONE" />
          <View style={styles.statsRow}>
            <Stat label="MISSIONE" value={missionState} />
            <Stat label="WP ATTIVO" value={`${snapshot?.mission.waypoint_index ?? "-"}`} />
            <Stat label="BAT" value={`${snapshot?.battery.percent ?? "-"} %`} />
          </View>
          <View style={styles.statsRow}>
            <Stat label="ALT" value={`${(snapshot?.telemetry.altitude ?? 0).toFixed(1)} m`} />
            <Stat label="VEL" value={`${speed} km/h`} />
            <Stat label="GPS" value={`${snapshot?.telemetry.gps_signal ?? "-"} lvl`} />
          </View>
          <Text style={styles.meta}>
            Plan attivo: {activeMissionPlan.length} waypoint | Layer: {mapLayer.toUpperCase()}
          </Text>
          {activeMissionPlan.length >= 2 ? <AltitudeProfile waypoints={activeMissionPlan} compact /> : null}
        </GlassCard>

        <GlassCard>
          <SectionTitle title="MAPPA OPERATIVA" />
          <View style={styles.mapWrap}>
            <MapView style={styles.map} mapType={mapTypeFromLayer(mapLayer)} initialRegion={region} showsCompass showsScale>
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
              {missionLoaded && missionHomeCoord ? (
                <Marker
                  coordinate={missionHomeCoord}
                  title="BASE / HOME"
                  description="Partenza e rientro missione"
                  anchor={{ x: 0.5, y: 0.5 }}
                  image={homeMapMarker}
                  zIndex={900}
                />
              ) : null}
              {activeMissionPlan.length > 0
                ? activeMissionPlan.map((wp, i) => {
                    const coord = { latitude: wp.lat, longitude: wp.lon };
                    if (missionHomeCoord && isNearCoordinate(coord, missionHomeCoord)) return null;
                    return (
                      <Marker
                        key={`mwp-${i}`}
                        coordinate={coord}
                        title={`WP ${i + 1}`}
                        description={`ALT ${wp.altitude}m`}
                        anchor={{ x: 0.5, y: 0.5 }}
                        image={waypointMarkerImage(i)}
                        zIndex={500}
                      />
                    );
                  })
                : null}
              {activeMissionPlan.length >= 2 ? (
                <Polyline
                  coordinates={activeMissionPlan.map((wp) => ({ latitude: wp.lat, longitude: wp.lon }))}
                  strokeColor="rgba(82,247,122,0.92)"
                  strokeWidth={3}
                />
              ) : null}
            </MapView>
          </View>
          <Text style={styles.meta}>
            {missionLoaded
              ? "Waypoint missione visibili."
              : "Missione non caricata: viene mostrata solo la posizione drone con altitudine."}
          </Text>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="COMANDI RAPIDI" />
          <View style={styles.grid}>
            <GlowPressable style={[styles.btn, styles.btnGood]} onPress={() => runCommand("takeoff")}>
              <Text style={styles.btnText}>DECOLLO</Text>
            </GlowPressable>
            <GlowPressable style={[styles.btn, styles.btnWarn]} onPress={() => runCommand("return_home")}>
              <Text style={styles.btnText}>RTH</Text>
            </GlowPressable>
            <GlowPressable style={[styles.btn, styles.btnDanger]} onPress={() => runCommand("land")}>
              <Text style={styles.btnText}>ATTERRA</Text>
            </GlowPressable>
            <GlowPressable style={[styles.btn, styles.btnNeutral]} onPress={() => runCommand("confirm_landing")}>
              <Text style={styles.btnText}>CONF. ATTERR.</Text>
            </GlowPressable>
          </View>
        </GlassCard>
      </ScrollView>
      <FloatingCamera defaultExpanded visible={isFocused && showDetachedCamera} bottom={104} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, gap: 14, paddingBottom: 92 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  heroLogoClip: {
    width: 234,
    height: 54,
    borderRadius: 30,
    overflow: "hidden",
    backgroundColor: "rgba(2,7,4,0.72)",
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.24)",
  },
  heroLogo: {
    width: "100%",
    height: "100%",
  },
  heroTitle: { color: theme.text, letterSpacing: 3, fontSize: 24, fontFamily: fonts.heading },
  heroDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: theme.accent2,
    shadowColor: theme.accent2,
    shadowOpacity: 0.7,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  heroSubtitle: { color: theme.textMuted, lineHeight: 18, fontFamily: fonts.body },
  infoQuickBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(77,216,255,0.08)",
  },
  infoQuickBtnText: {
    color: theme.text,
    fontFamily: fonts.mono,
    fontSize: 11,
    letterSpacing: 0.9,
  },
  videoWrap: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: "hidden",
    height: 180,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
  videoHud: {
    position: "absolute",
    top: 8,
    left: 8,
    right: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  videoHudRight: { flexDirection: "row", gap: 6 },
  hudPill: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3,
    fontFamily: fonts.mono,
    fontSize: 11,
    backgroundColor: "rgba(0,0,0,0.36)",
    color: theme.text,
  },
  hudOk: { color: theme.accent2, borderColor: "rgba(125,255,166,0.55)" },
  hudDanger: { color: theme.danger, borderColor: "rgba(255,106,106,0.5)" },
  hudWarn: { color: "#ffd166", borderColor: "rgba(255,209,102,0.55)" },
  hudRec: { color: "#ff6b6b", borderColor: "rgba(255,107,107,0.55)" },
  videoWrapExpanded: { height: 300 },
  video: { width: "100%", height: "100%" },
  cameraControls: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    flexWrap: "wrap",
  },
  cameraPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.28)",
    backgroundColor: "rgba(1,10,5,0.7)",
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  cameraPillActive: {
    borderColor: "rgba(82,247,122,0.82)",
    backgroundColor: "rgba(82,247,122,0.2)",
  },
  cameraPillText: {
    color: theme.text,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 1,
  },
  zoomInline: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.28)",
    backgroundColor: "rgba(1,10,5,0.76)",
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  zoomBtn: {
    width: 24,
    height: 24,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(82,247,122,0.16)",
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.42)",
  },
  zoomBtnText: { color: theme.text, fontFamily: fonts.heading, fontSize: 15, lineHeight: 17 },
  zoomValue: { color: theme.accent, fontFamily: fonts.mono, fontSize: 11, minWidth: 40, textAlign: "center" },
  smallBtn: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(77,216,255,0.1)",
  },
  smallBtnText: { color: theme.text, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.1 },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontFamily: fonts.mono,
    marginBottom: 8,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  ok: { color: theme.accent2, borderColor: "rgba(125,255,166,0.55)" },
  err: { color: theme.danger, borderColor: "rgba(255,106,106,0.5)" },
  meta: { color: theme.textMuted, fontFamily: fonts.body, marginTop: 8, fontSize: 12 },
  statsRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  stat: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 8,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  statLabel: { color: theme.textMuted, fontSize: 11, fontFamily: fonts.mono, marginBottom: 4 },
  statValue: { color: theme.text, fontSize: 14, fontFamily: fonts.body, fontWeight: "700" },
  mapWrap: {
    marginTop: 6,
    height: 300,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: "hidden",
  },
  map: { flex: 1 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  rowSingle: { marginTop: 8 },
  btnWide: { width: "100%" },
  btn: { width: "48.5%", borderRadius: 12, borderWidth: 1, alignItems: "center", paddingVertical: 12 },
  btnText: { color: theme.text, letterSpacing: 1.4, fontFamily: fonts.mono, fontSize: 12 },
  btnGood: { borderColor: "rgba(125,255,166,0.45)", backgroundColor: "rgba(125,255,166,0.12)" },
  btnWarn: { borderColor: "rgba(255,214,108,0.42)", backgroundColor: "rgba(255,214,108,0.12)" },
  btnDanger: { borderColor: "rgba(255,106,106,0.5)", backgroundColor: "rgba(255,106,106,0.12)" },
  btnNeutral: { borderColor: theme.border, backgroundColor: "rgba(77,216,255,0.08)" },
  droneMarkerWrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  droneMarkerIcon: {
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(77,216,255,0.8)",
    backgroundColor: "rgba(6,11,24,0.92)",
  },
  droneAltChip: {
    marginTop: 3,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(125,255,166,0.65)",
    backgroundColor: "rgba(6,11,24,0.9)",
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  droneAltText: { color: theme.accent2, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.5 },
});
