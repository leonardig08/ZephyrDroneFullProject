import { useEffect, useRef, useState } from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { Alert, Animated, Easing, Image, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { MissionWaypoint, sendSimpleCmd, setHomePoint } from "@/lib/api";
import { useTelemetry } from "@/hooks/useTelemetry";
import { loadPersistedHomePoint } from "@/lib/homeStore";
import { getLastMissionWaypoints, loadPersistedMissionPlan, subscribeMissionPlan } from "@/lib/missionPlanStore";
import {
  ensureServerHostOnStartup,
  getGpsDeviationWarningsEnabled,
  getServerHost,
  isServerStatusReachable,
  persistGpsDeviationWarningsEnabled,
  persistServerHost,
  subscribeGpsDeviationWarnings,
} from "@/lib/runtimeConfig";
import { TechBackdrop } from "@/components/ui/TechBackdrop";
import { DroneReservationCard } from "@/components/ui/DroneReservationCard";

SplashScreen.preventAutoHideAsync().catch(() => {
  // ignore if already hidden
});

function TelemetryBootstrap() {
  useTelemetry();
  return null;
}
function LandingConfirmationWatcher() {
  const { snapshot } = useTelemetry();
  const wasNeeded = useRef(false);

  useEffect(() => {
    const needed = !!snapshot?.landing_confirmation_needed;
    if (needed && !wasNeeded.current) {
      Alert.alert(
        "Conferma Atterraggio",
        "Il drone richiede conferma finale per completare l'atterraggio.",
        [
          { text: "Annulla", style: "cancel" },
          {
            text: "CONFERMA",
            style: "default",
            onPress: () => {
              sendSimpleCmd("confirm_landing").catch(() => undefined);
            },
          },
        ]
      );
    }
    wasNeeded.current = needed;
  }, [snapshot?.landing_confirmation_needed]);

  return null;
}

const GPS_DEVIATION_WARNING_METERS = 60;
const GPS_DEVIATION_CONSECUTIVE_SAMPLES = 3;

function distanceMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
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

function distanceToSegmentMeters(point: { lat: number; lon: number }, a: MissionWaypoint, b: MissionWaypoint) {
  const latScale = 111320;
  const lonScale = 111320 * Math.max(0.2, Math.abs(Math.cos((point.lat * Math.PI) / 180)));
  const ax = (a.lon - point.lon) * lonScale;
  const ay = (a.lat - point.lat) * latScale;
  const bx = (b.lon - point.lon) * lonScale;
  const by = (b.lat - point.lat) * latScale;
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 0.001) return distanceMeters(point, { lat: a.lat, lon: a.lon });
  const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / lenSq));
  const x = ax + vx * t;
  const y = ay + vy * t;
  return Math.sqrt(x * x + y * y);
}

function distanceFromMissionRouteMeters(point: { lat: number; lon: number }, plan: MissionWaypoint[]) {
  if (plan.length === 0) return Infinity;
  if (plan.length === 1) return distanceMeters(point, { lat: plan[0].lat, lon: plan[0].lon });
  return plan.slice(1).reduce((closest, wp, idx) => {
    const d = distanceToSegmentMeters(point, plan[idx], wp);
    return Math.min(closest, d);
  }, Infinity);
}

function GpsDeviationWatcher() {
  const { snapshot } = useTelemetry();
  const [missionPlan, setMissionPlan] = useState(getLastMissionWaypoints());
  const [warningsEnabled, setWarningsEnabled] = useState(getGpsDeviationWarningsEnabled());
  const consecutiveDeviationRef = useRef(0);
  const alertOpenRef = useRef(false);
  const alertedMissionRef = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeMissionPlan(setMissionPlan);
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeGpsDeviationWarnings(setWarningsEnabled);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const state = String(snapshot?.mission.state ?? "IDLE").toUpperCase();
    const active =
      missionPlan.length >= 2 &&
      !["IDLE", "READY", "FINISHED", "STOPPED", "FAILED", "ABORTED", "ERROR", "WAITING_OPERATOR"].includes(state);
    if (!active) {
      consecutiveDeviationRef.current = 0;
      alertOpenRef.current = false;
      if (["IDLE", "READY", "FINISHED", "STOPPED", "FAILED", "ABORTED", "ERROR"].includes(state)) {
        alertedMissionRef.current = null;
      }
      return;
    }
    if (!warningsEnabled) return;

    const lat = snapshot?.telemetry.latitude;
    const lon = snapshot?.telemetry.longitude;
    if (lat == null || lon == null) return;

    const deviation = distanceFromMissionRouteMeters({ lat, lon }, missionPlan);
    if (deviation < GPS_DEVIATION_WARNING_METERS) {
      consecutiveDeviationRef.current = 0;
      return;
    }

    consecutiveDeviationRef.current += 1;
    const missionKey = snapshot?.mission.mission_name ?? state;
    if (
      consecutiveDeviationRef.current < GPS_DEVIATION_CONSECUTIVE_SAMPLES ||
      alertOpenRef.current ||
      alertedMissionRef.current === missionKey
    ) {
      return;
    }

    alertOpenRef.current = true;
    alertedMissionRef.current = missionKey;
    Alert.alert(
      "Deviazione GPS",
      "Il gps è deviato molto durante la missione, vuoi continuare o interrompere la missione e rimanere in hover?",
      [
        {
          text: "Continua",
          style: "cancel",
          onPress: () => {
            alertOpenRef.current = false;
          },
        },
        {
          text: "Non avvisare più",
          onPress: () => {
            persistGpsDeviationWarningsEnabled(false).catch(() => undefined);
            alertOpenRef.current = false;
          },
        },
        {
          text: "Interrompi",
          style: "destructive",
          onPress: () => {
            sendSimpleCmd("stop_mission").catch(() => undefined);
            alertOpenRef.current = false;
          },
        },
      ],
    );
  }, [
    missionPlan,
    snapshot?.mission.mission_name,
    snapshot?.mission.state,
    snapshot?.telemetry.latitude,
    snapshot?.telemetry.longitude,
    warningsEnabled,
  ]);

  return null;
}

export default function RootLayout() {
  const [appReady, setAppReady] = useState(false);
  const [showStartupSplash, setShowStartupSplash] = useState(true);
  const [droneReserved, setDroneReserved] = useState(false);
  const [startupStatus, setStartupStatus] = useState("Ricerca server Python...");
  const [serverOverride, setServerOverride] = useState(getServerHost());
  const [activeServerHost, setActiveServerHost] = useState(getServerHost());
  const splashOpacity = useRef(new Animated.Value(1)).current;
  const touchPulse = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    (async () => {
      setStartupStatus("Test IP salvato e autoscan server...");
      const discovery = await ensureServerHostOnStartup().catch(() => null);
      if (discovery?.reachable) {
        setServerOverride(discovery.host);
        setActiveServerHost(discovery.host);
        setStartupStatus(discovery.discovered ? `Server trovato: ${discovery.host}` : `Server salvato OK: ${discovery.host}`);
      } else {
        setStartupStatus("Server non trovato: controlla rete/IP nelle impostazioni.");
      }
      await loadPersistedMissionPlan();
      const savedHome = await loadPersistedHomePoint();
      if (savedHome) {
        try {
          await setHomePoint(savedHome.lat, savedHome.lon);
        } catch {
          // best effort on startup
        }
      }
      setAppReady(true);
    })();
  }, []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(touchPulse, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(touchPulse, { toValue: 0.35, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [touchPulse]);

  useEffect(() => {
    if (!appReady) return;
    SplashScreen.hideAsync().catch(() => undefined);
  }, [appReady, splashOpacity]);

  const enterApp = () => {
    if (!appReady) return;
    if (!droneReserved) {
      Alert.alert(
        "Drone non riservato",
        "Prima occupa il drone dal selettore. Se e gia occupato, l'app ti mette in coda e i comandi restano bloccati.",
      );
      return;
    }
    Animated.timing(splashOpacity, {
      toValue: 0,
      duration: 520,
      useNativeDriver: true,
    }).start(() => {
      setShowStartupSplash(false);
    });
  };

  const applyServerOverride = async () => {
    Keyboard.dismiss();
    const cleaned = serverOverride
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^ws:\/\//i, "")
      .replace(/\/+$/, "")
      .split(":")[0];
    if (!cleaned) {
      Alert.alert("IP mancante", "Inserisci l'IP del server Python.");
      return;
    }
    try {
      setStartupStatus(`Salvo IP manuale: ${cleaned}...`);
      const saved = await persistServerHost(cleaned);
      setServerOverride(saved);
      setActiveServerHost(saved);
      setDroneReserved(false);
      const reachable = await isServerStatusReachable(saved, 1400);
      setStartupStatus(reachable ? `Server raggiungibile: ${saved}` : `IP salvato: ${saved}. Server non risponde ancora su :8000`);
    } catch {
      setStartupStatus("Errore salvataggio IP manuale.");
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#000000" }} edges={["top", "left", "right"]}>
        <StatusBar style="light" backgroundColor="#000000" translucent={false} />
        <TechBackdrop />
        <TelemetryBootstrap />
        <LandingConfirmationWatcher />
        <GpsDeviationWatcher />
        <Stack screenOptions={{ headerShown: false }} />
        {showStartupSplash ? (
          <Animated.View style={[styles.splashWrap, { opacity: splashOpacity }]}>
            <Image source={require("../assets/images/splash-zephyr-tech.png")} style={styles.splashBg} resizeMode="cover" />
            <View style={styles.splashShade} />
            <View style={styles.splashPanel}>
              <Image source={require("../assets/images/splash-icon.png")} style={styles.splashIcon} resizeMode="contain" />
              <Text style={styles.splashTitle}>ZEPHYRDRONE</Text>
              <Text style={styles.splashSubtitle}>PROTEGGI IL TERRITORIO. GUIDA LA MISSIONE.</Text>
              <View style={styles.sloganRule} />
              <View style={styles.overrideRow}>
                <TextInput
                  value={serverOverride}
                  onChangeText={setServerOverride}
                  style={styles.overrideInput}
                  placeholder="IP server Python"
                  placeholderTextColor="rgba(233,255,232,0.4)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                  returnKeyType="done"
                  onSubmitEditing={applyServerOverride}
                />
                <Pressable
                  hitSlop={12}
                  style={({ pressed }) => [styles.overrideBtn, pressed && styles.overrideBtnPressed]}
                  onPress={applyServerOverride}
                >
                  <Text style={styles.overrideBtnText}>USA IP</Text>
                </Pressable>
              </View>
              <Text style={styles.serverLine}>{startupStatus}</Text>
              {appReady ? <DroneReservationCard key={activeServerHost} compact onReservationChange={setDroneReserved} /> : null}
              <Pressable
                style={[styles.enterBtn, (!appReady || !droneReserved) && styles.enterBtnDisabled]}
                onPress={enterApp}
              >
                <Text style={styles.enterBtnText}>{droneReserved ? "ACCEDI ALL'APP" : "RISERVA DRONE PER ACCEDERE"}</Text>
              </Pressable>
              <Animated.Text style={[styles.tapText, { opacity: appReady ? touchPulse : 0.48 }]}>
                {appReady ? "SELEZIONA IL DRONE OPERATIVO" : startupStatus}
              </Animated.Text>
            </View>
          </Animated.View>
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splashWrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#020704",
    zIndex: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  splashBg: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
  },
  splashShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.28)",
  },
  splashPanel: {
    width: "100%",
    maxWidth: 420,
    alignItems: "center",
    borderRadius: 28,
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.32)",
    backgroundColor: "rgba(2,7,4,0.54)",
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  splashIcon: {
    width: 82,
    height: 82,
    borderRadius: 24,
  },
  splashTitle: {
    marginTop: 10,
    color: "#E9FFE8",
    fontSize: 24,
    letterSpacing: 3.2,
    fontWeight: "800",
  },
  splashSubtitle: {
    marginTop: 6,
    color: "rgba(196,232,197,0.82)",
    fontSize: 11,
    letterSpacing: 2,
    textAlign: "center",
    lineHeight: 17,
  },
  sloganRule: {
    marginTop: 14,
    marginBottom: 12,
    width: "72%",
    height: 1,
    borderRadius: 999,
    backgroundColor: "rgba(82,247,122,0.52)",
  },
  overrideRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  overrideInput: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.28)",
    backgroundColor: "rgba(1,10,5,0.64)",
    color: "#E9FFE8",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 12,
    letterSpacing: 0.8,
  },
  overrideBtn: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.58)",
    backgroundColor: "rgba(82,247,122,0.22)",
    paddingHorizontal: 16,
    paddingVertical: 13,
    minWidth: 92,
    alignItems: "center",
  },
  overrideBtnPressed: {
    backgroundColor: "rgba(82,247,122,0.38)",
    transform: [{ scale: 0.98 }],
  },
  overrideBtnText: {
    color: "#E9FFE8",
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1,
  },
  serverLine: {
    alignSelf: "stretch",
    marginTop: -4,
    marginBottom: 10,
    color: "rgba(196,232,197,0.86)",
    fontSize: 10,
    letterSpacing: 0.7,
    textAlign: "center",
  },
  enterBtn: {
    width: "100%",
    marginTop: 12,
    borderRadius: 16,
    paddingVertical: 13,
    alignItems: "center",
    backgroundColor: "rgba(82,247,122,0.2)",
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.7)",
  },
  enterBtnDisabled: {
    opacity: 0.56,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderColor: "rgba(255,255,255,0.14)",
  },
  enterBtnText: {
    color: "#E9FFE8",
    fontSize: 12,
    letterSpacing: 1.6,
    fontWeight: "900",
    textAlign: "center",
  },
  tapText: {
    marginTop: 16,
    color: "#52F77A",
    fontSize: 11,
    letterSpacing: 2.1,
    fontWeight: "800",
    textAlign: "center",
  },
});
