import { GlowPressable } from "@/components/ui/GlowPressable";
import { LiveFrameImage } from "@/components/ui/LiveFrameImage";
import { getCurrentCamera, setZoom, switchCamera } from "@/lib/api";
import {
  getCurrentCameraMode,
  getMockFeedEnabled,
  getPhotoCaptureActive,
  getRecordingActive,
  getServerHost,
  subscribePhotoCaptureActive,
  subscribeRecordingActive,
  setCurrentCameraMode,
  subscribeCurrentCameraMode,
  subscribeMockFeed,
  subscribeServerHost,
} from "@/lib/runtimeConfig";
import { fonts, theme } from "@/lib/theme";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useEffect, useRef, useState } from "react";
import { Animated, Dimensions, Easing, StyleSheet, Text, View } from "react-native";

type Props = {
  defaultExpanded?: boolean;
  bottom?: number;
  visible?: boolean;
};

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const ZOOM_MIN = 1;
const ZOOM_MAX = 56;
  const HEADER_H = 34;
async function safeRun(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    // camera overlay controls are best-effort
  }
}

export function FloatingCamera({ defaultExpanded = false, bottom = 74, visible = true }: Props) {
  const [open, setOpen] = useState(defaultExpanded);
  const [maximized, setMaximized] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [cameraMode, setCameraMode] = useState<"WIDE" | "ZOOM" | "IR">(getCurrentCameraMode());
  const [mockFeedEnabled, setMockFeedEnabled] = useState(getMockFeedEnabled());
  const [recordingActive, setRecordingUi] = useState(getRecordingActive());
  const [photoCaptureActive, setPhotoCaptureUi] = useState(getPhotoCaptureActive());
  const [zoomValue, setZoomValue] = useState(1);
  const [host, setHost] = useState(getServerHost());

  const openAnim = useRef(new Animated.Value(defaultExpanded ? 1 : 0)).current;
  const modeAnim = useRef(new Animated.Value(0)).current; // 0 = PiP, 1 = max

  useEffect(() => subscribeServerHost(setHost), []);
  useEffect(() => subscribeCurrentCameraMode(setCameraMode), []);
  useEffect(() => subscribeMockFeed(setMockFeedEnabled), []);
  useEffect(() => subscribeRecordingActive(setRecordingUi), []);
  useEffect(() => subscribePhotoCaptureActive(setPhotoCaptureUi), []);
  useEffect(() => {
    safeRun(getCurrentCamera);
  }, []);
  const safeBottom = bottom;

  if (!visible) return null;

  const setOpenAnimated = (next: boolean) => {
    setOpen(next);
    Animated.timing(openAnim, {
      toValue: next ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start(() => {
      if (!next) {
        setMaximized(false);
        setDrawerOpen(false);
      }
    });
  };

  const setModeAnimated = (nextMax: boolean) => {
    setMaximized(nextMax);
    if (!nextMax) setDrawerOpen(false);
    Animated.spring(modeAnim, {
      toValue: nextMax ? 1 : 0,
      damping: 18,
      stiffness: 160,
      mass: 0.8,
      useNativeDriver: false,
    }).start();
  };

  const changeCamera = async (next: "WIDE" | "ZOOM" | "IR") => {
    const res = await safeRun(() => switchCamera(next));
    if (!res?.sent || res.ack === false) return;
    setCurrentCameraMode(next);
    if (next === "ZOOM") safeRun(() => setZoom(zoomValue));
  };

  const bumpZoom = (delta: number) => {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Number((zoomValue + delta).toFixed(1))));
    setZoomValue(next);
    safeRun(() => setZoom(next));
  };

  const streamSrc = mockFeedEnabled ? (cameraMode === "IR" ? "ir" : cameraMode === "ZOOM" ? "zoom" : "dji") : "dji";

  const closedOpacity = openAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const pipOpacity = openAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });



const PIP_W = 240;
const PIP_H = Math.round((PIP_W * 9) / 16) + HEADER_H;

const MAX_W = SCREEN_W - 20;
const MAX_H = Math.round((MAX_W * 9) / 16) + HEADER_H;

const pipW = modeAnim.interpolate({
  inputRange: [0, 1],
  outputRange: [PIP_W, MAX_W],
});

const pipH = modeAnim.interpolate({
  inputRange: [0, 1],
  outputRange: [PIP_H, MAX_H],
});

const pipRight = modeAnim.interpolate({
  inputRange: [0, 1],
  outputRange: [10, 10],
});

const pipBottom = modeAnim.interpolate({
  inputRange: [0, 1],
  outputRange: [safeBottom, safeBottom],
});

const pipRadius = modeAnim.interpolate({
  inputRange: [0, 1],
  outputRange: [16, 22],
});


  return (
    <>
      <Animated.View style={[styles.collapsedWrap, { bottom: safeBottom, opacity: closedOpacity }]}>
        <GlowPressable style={styles.chip} onPress={() => setOpenAnimated(true)}>
          <MaterialCommunityIcons name="video-wireless" size={14} color={theme.accent} />
          <Text style={styles.chipText}>LIVE FEED</Text>
        </GlowPressable>
      </Animated.View>

      <Animated.View
        pointerEvents={open ? "auto" : "none"}
        style={[
          styles.panel,
          {
            width: pipW,
            height: pipH,
            right: pipRight,
            bottom: pipBottom,
            borderRadius: pipRadius,
            opacity: pipOpacity,
   
          },
        ]}
      >
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <MaterialCommunityIcons name="drone" size={15} color={theme.accent2} />
            <Text style={styles.headerText}>{maximized ? "CAMERA MAX" : "CAMERA FEED"}</Text>
          </View>
          <View style={styles.headerActions}>
            <GlowPressable style={styles.iconBtn} onPress={() => setModeAnimated(!maximized)}>
              <MaterialCommunityIcons
                name={maximized ? "arrow-collapse" : "arrow-expand"}
                size={13}
                color={theme.text}
              />
            </GlowPressable>
            <GlowPressable style={styles.iconBtn} onPress={() => setOpenAnimated(false)}>
              <MaterialCommunityIcons name="close" size={13} color={theme.text} />
            </GlowPressable>
          </View>
        </View>

        <View style={styles.videoStage}>
  <LiveFrameImage
    host={host}
    src={streamSrc}
    style={styles.liveFrameClipped}
    paused={!open}
    contentFit="cover"
  />
  <View style={styles.overlayHud}>
    <Text style={[styles.overlayPill, cameraMode === "IR" ? styles.overlayDanger : styles.overlayOk]}>{cameraMode}</Text>
    <View style={styles.overlayHudRight}>
      {photoCaptureActive ? <Text style={[styles.overlayPill, styles.overlayWarn]}>PHOTO</Text> : null}
      {recordingActive ? <Text style={[styles.overlayPill, styles.overlayRec]}>REC</Text> : null}
    </View>
  </View>
</View>

        {maximized ? (
          <View style={styles.cameraDrawerWrap}>
            <GlowPressable style={styles.drawerToggle} onPress={() => setDrawerOpen((v) => !v)}>
              <MaterialCommunityIcons name={drawerOpen ? "chevron-right" : "chevron-left"} size={14} color={theme.text} />
            </GlowPressable>
            {drawerOpen ? (
              <View style={styles.cameraDrawer}>
                {(["WIDE", "ZOOM", "IR"] as const).map((mode) => (
                  <GlowPressable
                    key={`pip-mode-${mode}`}
                    style={[styles.modePill, cameraMode === mode && styles.modePillActive]}
                    onPress={() => changeCamera(mode)}
                  >
                    <Text style={styles.modePillText}>{mode}</Text>
                  </GlowPressable>
                ))}
                {cameraMode === "ZOOM" ? (
                  <View style={styles.zoomMiniRow}>
                    <GlowPressable style={styles.zoomMiniBtn} onPress={() => bumpZoom(-1)}>
                      <Text style={styles.zoomMiniText}>-</Text>
                    </GlowPressable>
                    <Text style={styles.zoomMiniValue}>{zoomValue.toFixed(1)}x</Text>
                    <GlowPressable style={styles.zoomMiniBtn} onPress={() => bumpZoom(1)}>
                      <Text style={styles.zoomMiniText}>+</Text>
                    </GlowPressable>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

      </Animated.View>
    </>
  );
}

const styles = StyleSheet.create({
  collapsedWrap: {
  position: "absolute",
  right: 10,
  zIndex: 80,
},
  chip: {
  flexDirection: "row",
  alignItems: "center",
  gap: 6,
  borderRadius: 999,
  borderWidth: 1,
  borderColor: "rgba(77,216,255,0.72)",
  backgroundColor: "rgba(8,20,36,0.92)",
  paddingHorizontal: 12,
  paddingVertical: 8,
  zIndex: 80,
},
  chipText: { color: theme.text, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 0.6 },

  panel: {
  position: "absolute",
  zIndex: 80,
  overflow: "hidden",
  flexDirection: "column",
  alignItems: "stretch",
  borderWidth: 1,
  borderColor: "rgba(77,216,255,0.62)",
  backgroundColor: "rgba(0,0,0,0.96)",
  shadowColor: "#000",
  shadowOpacity: 0.35,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 0 },
  elevation: 9,
},
  
videoStage: {
  flex: 1,
  width: "100%",
  backgroundColor: "#000",
  overflow: "hidden",
  position: "relative",
},
overlayHud: {
  position: "absolute",
  top: 8,
  left: 8,
  right: 8,
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
},
overlayHudRight: { flexDirection: "row", gap: 6 },
overlayPill: {
  borderRadius: 999,
  borderWidth: 1,
  paddingHorizontal: 8,
  paddingVertical: 3,
  fontFamily: fonts.mono,
  fontSize: 10,
  backgroundColor: "rgba(0,0,0,0.42)",
  color: theme.text,
},
overlayOk: { color: theme.accent2, borderColor: "rgba(125,255,166,0.55)" },
overlayDanger: { color: theme.danger, borderColor: "rgba(255,106,106,0.5)" },
overlayWarn: { color: "#ffd166", borderColor: "rgba(255,209,102,0.55)" },
overlayRec: { color: "#ff6b6b", borderColor: "rgba(255,107,107,0.55)" },

liveFrameClipped: {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: undefined,
  height: undefined,
},

  header: {
  height: HEADER_H,
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
  paddingHorizontal: 10,
  borderBottomWidth: 1,
  borderBottomColor: "rgba(77,216,255,0.2)",
  backgroundColor: "rgba(3,10,18,0.88)",
},
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: { color: theme.text, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 0.7 },
  headerActions: { flexDirection: "row", gap: 6 },
  iconBtn: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 7,
    width: 24,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(77,216,255,0.12)",
  },
video: {
  flex: 1,
  width: "100%",
  maxWidth: "100%",
  height: "100%",
  maxHeight: "100%",
  overflow: "hidden",
},

  hudRow: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  hudText: {
    color: theme.text,
    fontFamily: fonts.mono,
    fontSize: 10,
    letterSpacing: 0.6,
    backgroundColor: "rgba(0,0,0,0.42)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: theme.accent2,
    shadowColor: theme.accent2,
    shadowOpacity: 0.7,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  cameraDrawerWrap: {
    position: "absolute",
    right: 8,
    top: 42,
    alignItems: "flex-end",
    gap: 6,
  },
  drawerToggle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.55)",
    backgroundColor: "rgba(2,7,4,0.74)",
  },
  cameraDrawer: {
    borderRadius: 14,
    borderWidth: 0,
    borderColor: "rgba(82,247,122,0.4)",
    backgroundColor: "rgba(2,7,4,0.78)",
    padding: 6,
    gap: 5,
    alignItems: "stretch",
  },
  modePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(233,255,232,0.16)",
    backgroundColor: "rgba(255,255,255,0.04)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    alignItems: "center",
  },
  modePillActive: {
    borderColor: "rgba(82,247,122,0.72)",
    backgroundColor: "rgba(82,247,122,0.18)",
  },
  modePillText: { color: theme.text, fontFamily: fonts.mono, fontSize: 9, letterSpacing: 0.8 },
  zoomMiniRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 2 },
  zoomMiniBtn: {
    width: 22,
    height: 20,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(82,247,122,0.12)",
  },
  zoomMiniText: { color: theme.text, fontFamily: fonts.mono, fontSize: 12 },
  zoomMiniValue: { minWidth: 42, color: theme.accent2, fontFamily: fonts.mono, fontSize: 10, textAlign: "center" },
});
