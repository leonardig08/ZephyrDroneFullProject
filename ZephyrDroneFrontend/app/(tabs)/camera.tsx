import { FloatingCamera } from "@/components/ui/FloatingCamera";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowPressable } from "@/components/ui/GlowPressable";
import { LiveFrameImage } from "@/components/ui/LiveFrameImage";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { useTelemetry } from "@/hooks/useTelemetry";
import { getCurrentCamera, measureThermalSpot, resetGimbal, rotateGimbalSpeed, sendSimpleCmd, setZoom, switchCamera, takePhoto, toggleRecording } from "@/lib/api";
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
import { useIsFocused } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

const STREAM_NAME = "dji";
const JOYSTICK_RADIUS = 40;
const ZOOM_MIN = 1;
const ZOOM_MAX = 56;
const GIMBAL_MAX_SPEED = 22;
const GIMBAL_DEADZONE = 0.16;
const GIMBAL_SEND_INTERVAL_MS = 95;
const THERMAL_SOURCE_ASPECT = 16 / 9;

async function safeRun<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch {
    // best effort
    return undefined;
  }
}

export default function CameraScreen() {
  const isFocused = useIsFocused();
  const { snapshot } = useTelemetry();
  const [zoom, setZoomValue] = useState(1);
  const [cam, setCam] = useState<"WIDE" | "ZOOM" | "IR">(getCurrentCameraMode());
  const [host, setHost] = useState(getServerHost());
  const [videoY, setVideoY] = useState(0);
  const [videoH, setVideoH] = useState(0);
  const [videoW, setVideoW] = useState(0);
  const [showDetachedCamera, setShowDetachedCamera] = useState(false);
  const [mockFeedEnabled, setMockFeedEnabled] = useState(getMockFeedEnabled());
  const [recordingActive, setRecordingUi] = useState(getRecordingActive());
  const [photoCaptureActive, setPhotoCaptureUi] = useState(getPhotoCaptureActive());
  const [thermalMeasureEnabled, setThermalMeasureEnabled] = useState(false);
  const [thermalSpot, setThermalSpot] = useState<{
    normX: number;
    normY: number;
    viewX: number;
    viewY: number;
    temperature?: number;
    pending?: boolean;
    error?: string;
  } | null>(null);
  const scrollYRef = useRef(0);
  const [zoomTrackWidth, setZoomTrackWidth] = useState(0);
  const [sensitivityTrackWidth, setSensitivityTrackWidth] = useState(0);
  const [gimbalSensitivity, setGimbalSensitivity] = useState(0.72);
  const lastZoomValueRef = useRef(1);
  const zoomValueRef = useRef(1);
  const knobPos = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const lastZoomSendRef = useRef(0);
  const gimbalTargetVectorRef = useRef({ x: 0, y: 0 });
  const gimbalFilteredVectorRef = useRef({ x: 0, y: 0 });
  const gimbalInFlightRef = useRef(false);
  const gimbalQueuedRef = useRef<{ pitch: number; yaw: number } | null>(null);
  const gimbalLastSentRef = useRef<{ pitch: number; yaw: number }>({ pitch: 0, yaw: 0 });
  const thermalMeasureInFlightRef = useRef(false);
  const thermalTapInFlightRef = useRef(false);
  const thermalTapRequestIdRef = useRef(0);
  const zoomDragStartPageXRef = useRef<number | null>(null);
  const zoomDragStartValueRef = useRef<number>(ZOOM_MIN);

  useEffect(() => {
    const unsubscribe = subscribeServerHost(setHost);
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeMockFeed(setMockFeedEnabled);
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeCurrentCameraMode(setCam);
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeRecordingActive(setRecordingUi);
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    const unsubscribe = subscribePhotoCaptureActive(setPhotoCaptureUi);
    return () => {
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (cam !== "IR") {
      setThermalMeasureEnabled(false);
      setThermalSpot(null);
    }
  }, [cam]);
  useEffect(() => {
    safeRun(getCurrentCamera);
  }, []);

  const activeStreamName = mockFeedEnabled ? (cam === "IR" ? "mock_ir" : cam === "ZOOM" ? "mock_zoom" : "mock_wide") : STREAM_NAME;
  const updateDetached = (nextScroll: number) => {
    const next = nextScroll > videoY + videoH - 28 && videoH > 0;
    setShowDetachedCamera((prev) => (prev === next ? prev : next));
  };

  const applyCurve = useCallback((value: number) => {
    const abs = Math.abs(value);
    if (abs < GIMBAL_DEADZONE) return 0;
    const norm = (abs - GIMBAL_DEADZONE) / (1 - GIMBAL_DEADZONE);
    const curved = Math.pow(norm, 2.2);
    return Math.sign(value) * curved;
  }, []);

  const flushGimbalQueue = useCallback(async () => {
    if (gimbalInFlightRef.current) return;
    const payload = gimbalQueuedRef.current;
    if (!payload) return;
    gimbalQueuedRef.current = null;
    gimbalInFlightRef.current = true;
    try {
      await rotateGimbalSpeed(payload.pitch, payload.yaw, 0);
      gimbalLastSentRef.current = payload;
    } catch {
      // best effort
    } finally {
      gimbalInFlightRef.current = false;
      if (gimbalQueuedRef.current) {
        void flushGimbalQueue();
      }
    }
  }, []);

  const enqueueGimbal = useCallback((pitch: number, yaw: number, force = false) => {
    const p = Number(pitch.toFixed(1));
    const y = Number(yaw.toFixed(1));
    const last = gimbalQueuedRef.current ?? gimbalLastSentRef.current;
    if (!force && Math.abs(last.pitch - p) < 0.6 && Math.abs(last.yaw - y) < 0.6) return;
    gimbalQueuedRef.current = { pitch: p, yaw: y };
    void flushGimbalQueue();
  }, [flushGimbalQueue]);

  useEffect(() => {
    const id = setInterval(() => {
      const target = gimbalTargetVectorRef.current;
      const filtered = gimbalFilteredVectorRef.current;
      const alpha = 0.34;
      filtered.x = filtered.x + (target.x - filtered.x) * alpha;
      filtered.y = filtered.y + (target.y - filtered.y) * alpha;
      const nx = applyCurve(filtered.x);
      const ny = applyCurve(filtered.y);
      const yawSpeed = nx * GIMBAL_MAX_SPEED * gimbalSensitivity;
      const pitchSpeed = -ny * GIMBAL_MAX_SPEED * gimbalSensitivity;
      const active = Math.abs(nx) > 0 || Math.abs(ny) > 0;
      enqueueGimbal(pitchSpeed, yawSpeed, active);
    }, GIMBAL_SEND_INTERVAL_MS);
    return () => clearInterval(id);
  }, [applyCurve, enqueueGimbal, gimbalSensitivity]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderMove: (_, gesture) => {
          const dx = gesture.dx;
          const dy = gesture.dy;
          const len = Math.sqrt(dx * dx + dy * dy);
          const scale = len > JOYSTICK_RADIUS ? JOYSTICK_RADIUS / len : 1;
          const cx = dx * scale;
          const cy = dy * scale;

          knobPos.setValue({ x: cx, y: cy });
          gimbalTargetVectorRef.current = {
            x: cx / JOYSTICK_RADIUS,
            y: cy / JOYSTICK_RADIUS,
          };
        },
        onPanResponderRelease: () => {
          Animated.spring(knobPos, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: false,
            friction: 9,
            tension: 95,
          }).start();
          gimbalTargetVectorRef.current = { x: 0, y: 0 };
          enqueueGimbal(0, 0);
        },
        onPanResponderTerminate: () => {
          Animated.spring(knobPos, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: false,
            friction: 9,
            tension: 95,
          }).start();
          gimbalTargetVectorRef.current = { x: 0, y: 0 };
          enqueueGimbal(0, 0);
        },
      }),
    [enqueueGimbal, knobPos],
  );

  const changeCam = async (next: "WIDE" | "ZOOM" | "IR") => {
    const res = await safeRun(() => switchCamera(next));
    if (!res?.sent || res.ack === false) return;
    setCurrentCameraMode(next);
    if (next === "ZOOM") {
      const keep = Number(lastZoomValueRef.current.toFixed(2));
      setZoomValue(keep);
      await safeRun(() => setZoom(keep));
    }
  };

  const viewPointToThermalPoint = (viewX: number, viewY: number) => {
    if (videoW <= 0 || videoH <= 0) return null;

    const viewAspect = videoW / videoH;
    let renderedW = videoW;
    let renderedH = videoH;
    let offsetX = 0;
    let offsetY = 0;

    if (viewAspect < THERMAL_SOURCE_ASPECT) {
      renderedW = videoH * THERMAL_SOURCE_ASPECT;
      offsetX = (renderedW - videoW) / 2;
    } else if (viewAspect > THERMAL_SOURCE_ASPECT) {
      renderedH = videoW / THERMAL_SOURCE_ASPECT;
      offsetY = (renderedH - videoH) / 2;
    }

    return {
      x: Math.max(0, Math.min(1, (viewX + offsetX) / renderedW)),
      y: Math.max(0, Math.min(1, (viewY + offsetY) / renderedH)),
    };
  };

  const requestThermalSpot = async (viewX: number, viewY: number) => {
    if (cam !== "IR" || !thermalMeasureEnabled) return;
    const point = viewPointToThermalPoint(viewX, viewY);
    if (!point) return;
    const requestId = ++thermalTapRequestIdRef.current;
    setThermalSpot({ normX: point.x, normY: point.y, viewX, viewY, pending: true });
    thermalTapInFlightRef.current = true;
    try {
      const res = await measureThermalSpot(point.x, point.y, "react");
      if (requestId !== thermalTapRequestIdRef.current) return;
      if (res.sent && res.ack !== false && typeof res.temperature === "number") {
        setThermalSpot((prev) =>
          prev && prev.normX === point.x && prev.normY === point.y
            ? { ...prev, temperature: res.temperature, pending: false, error: undefined }
            : prev,
        );
      } else {
        setThermalSpot((prev) =>
          prev && prev.normX === point.x && prev.normY === point.y
            ? { ...prev, pending: false, error: res.error || "Temp non disponibile" }
            : prev,
        );
      }
    } catch {
      if (requestId !== thermalTapRequestIdRef.current) return;
      setThermalSpot((prev) =>
        prev && prev.normX === point.x && prev.normY === point.y
          ? { ...prev, pending: false, error: "Misura fallita" }
          : prev,
      );
    } finally {
      if (requestId === thermalTapRequestIdRef.current) {
        thermalTapInFlightRef.current = false;
      }
    }
  };

  useEffect(() => {
    if (cam !== "IR" || !thermalMeasureEnabled || !thermalSpot) return;
    let cancelled = false;

    const tick = async () => {
      if (thermalMeasureInFlightRef.current || thermalTapInFlightRef.current || cancelled) return;
      thermalMeasureInFlightRef.current = true;
      const spot = thermalSpot;
      setThermalSpot((prev) =>
        prev && prev.temperature === undefined ? { ...prev, pending: true, error: undefined } : prev,
      );
      try {
        const res = await measureThermalSpot(spot.normX, spot.normY, "react");
        if (cancelled) return;
        if (res.sent && res.ack !== false && typeof res.temperature === "number") {
          setThermalSpot((prev) =>
            prev && prev.normX === spot.normX && prev.normY === spot.normY
              ? { ...prev, temperature: res.temperature, pending: false, error: undefined }
              : prev,
          );
        } else {
          setThermalSpot((prev) =>
            prev && prev.normX === spot.normX && prev.normY === spot.normY
              ? { ...prev, pending: false, error: res.error || "Temp non disponibile" }
              : prev,
          );
        }
      } catch {
        if (!cancelled) {
          setThermalSpot((prev) =>
            prev && prev.normX === spot.normX && prev.normY === spot.normY
              ? { ...prev, pending: false, error: "Misura fallita" }
              : prev,
          );
        }
      } finally {
        thermalMeasureInFlightRef.current = false;
      }
    };

    void tick();
    const id = setInterval(() => {
      void tick();
    }, 80);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [cam, thermalMeasureEnabled, thermalSpot?.normX, thermalSpot?.normY]);

  const bumpZoom = async (delta: number) => {
    const next = Number(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomValueRef.current + delta)).toFixed(1));
    zoomValueRef.current = next;
    setZoomValue(next);
    lastZoomValueRef.current = next;
    await safeRun(() => setZoom(next));
  };

  const zoomRatio = (zoom - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN);
  const onZoomGrantByPageX = (pageX: number) => {
    zoomDragStartPageXRef.current = Number.isFinite(pageX) ? pageX : null;
    zoomDragStartValueRef.current = zoomValueRef.current;
  };
  const onZoomMoveByPageX = (pageX: number, commit = false) => {
    if (zoomTrackWidth <= 0) return;
    const startX = zoomDragStartPageXRef.current;
    if (startX == null || !Number.isFinite(pageX)) return;
    const dx = pageX - startX;
    const range = ZOOM_MAX - ZOOM_MIN;
    const deltaZoom = (dx / zoomTrackWidth) * range;
    const raw = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomDragStartValueRef.current + deltaZoom));
    const current = zoomValueRef.current;
    const smoothed = commit ? raw : current + (raw - current) * 0.42;
    const next = Number(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, smoothed)).toFixed(1));
    if (!commit && Math.abs(next - current) < 0.05) return;
    zoomValueRef.current = next;
    setZoomValue(next);
    lastZoomValueRef.current = next;
    const now = Date.now();
    if (commit || now - lastZoomSendRef.current > 170) {
      lastZoomSendRef.current = now;
      safeRun(() => setZoom(next));
    }
  };
  const onZoomReleaseByPageX = (pageX: number) => {
    onZoomMoveByPageX(pageX, true);
    zoomDragStartPageXRef.current = null;
  };
  const setSensitivityFromPageX = (pageX: number) => {
    if (sensitivityTrackWidth <= 0) return;
    const ratio = Math.max(0, Math.min(1, pageX / sensitivityTrackWidth));
    const next = Number((0.25 + ratio * 0.75).toFixed(2));
    setGimbalSensitivity(next);
  };
  const zoomFillPx = Math.max(6, zoomTrackWidth * zoomRatio);
  const zoomThumbPx = Math.max(0, Math.min(Math.max(0, zoomTrackWidth - 34), zoomTrackWidth * zoomRatio - 17));
  const sensitivityRatio = (gimbalSensitivity - 0.25) / 0.75;
  const sensitivityFillPx = Math.max(6, sensitivityTrackWidth * sensitivityRatio);
  const sensitivityThumbPx = Math.max(0, Math.min(Math.max(0, sensitivityTrackWidth - 24), sensitivityTrackWidth * sensitivityRatio - 12));

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
        <Text style={styles.title}>CAMERA LINK</Text>
        <Text style={styles.subtitle}>Feed live + joystick gimbal + controlli camera</Text>

        <GlassCard>
          <SectionTitle title="LIVE FEED" />
          <View
            style={styles.streamWrap}
            onLayout={(ev) => {
              setVideoW(ev.nativeEvent.layout.width);
              setVideoY(ev.nativeEvent.layout.y);
              setVideoH(ev.nativeEvent.layout.height);
              updateDetached(scrollYRef.current);
            }}
            onStartShouldSetResponder={() => cam === "IR" && thermalMeasureEnabled}
            onResponderRelease={(ev) => {
              const { locationX, locationY } = ev.nativeEvent;
              void requestThermalSpot(locationX, locationY);
            }}
          >
            <LiveFrameImage host={host} src={activeStreamName} style={styles.stream} intervalMs={115} paused={!isFocused} />
            {cam === "IR" && thermalSpot ? (
              <View
                pointerEvents="none"
                style={[
                  styles.thermalSpotOverlay,
                  {
                    left: Math.max(0, Math.min(videoW - 16, thermalSpot.viewX - 8)),
                    top: Math.max(0, Math.min(videoH - 16, thermalSpot.viewY - 8)),
                  },
                ]}
              >
                <View style={styles.thermalSpotBox} />
                <View style={styles.thermalTempBubble}>
                  <Text style={styles.thermalTempText}>
                    {thermalSpot.pending && thermalSpot.temperature === undefined
                      ? "..."
                      : thermalSpot.error
                        ? thermalSpot.error
                        : thermalSpot.temperature !== undefined
                          ? `${thermalSpot.temperature.toFixed(1)} C`
                          : "..."}
                  </Text>
                </View>
              </View>
            ) : null}
            <View style={styles.streamHud}>
              <Text style={[styles.hudBadge, cam === "IR" ? styles.err : styles.ok]}>{cam}</Text>
              <View style={styles.streamHudRight}>
                {photoCaptureActive ? <Text style={[styles.hudBadge, styles.warn]}>PHOTO</Text> : null}
                {recordingActive ? <Text style={[styles.hudBadge, styles.rec]}>REC</Text> : null}
              </View>
            </View>
          </View>
          <Text style={styles.note}>
            Sorgente: {mockFeedEnabled ? `/video/frame?src=${activeStreamName}` : "MediaMTX/go2rtc RTSP-WebRTC"}
          </Text>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="CAMERA MODE + ZOOM" />
          <View style={styles.row}>
            {(["WIDE", "ZOOM", "IR"] as const).map((name) => (
              <GlowPressable
                key={name}
                style={[styles.modeBtn, cam === name && styles.modeBtnActive]}
                onPress={() => changeCam(name)}
              >
                <Text style={styles.modeText}>{name}</Text>
              </GlowPressable>
            ))}
          </View>

          {cam === "ZOOM" ? (
            <View style={styles.zoomRow}>
              <Text style={styles.zoomLabel}>ZOOM {zoom.toFixed(1)}x</Text>
              <View
                style={styles.zoomTrack}
                onLayout={(ev) => setZoomTrackWidth(ev.nativeEvent.layout.width)}
                onStartShouldSetResponder={() => true}
                onMoveShouldSetResponder={() => true}
                onResponderTerminationRequest={() => false}
                onResponderGrant={(ev) => onZoomGrantByPageX(ev.nativeEvent.pageX)}
                onResponderMove={(ev) => onZoomMoveByPageX(ev.nativeEvent.pageX)}
                onResponderRelease={(ev) => onZoomReleaseByPageX(ev.nativeEvent.pageX)}
                onResponderTerminate={(ev) => onZoomReleaseByPageX(ev.nativeEvent.pageX)}
              >
                <View style={styles.zoomTicks} pointerEvents="none">
                  {Array.from({ length: 25 }).map((_, i) => (
                    <View key={`tick-${i}`} style={[styles.zoomTick, i % 5 === 0 ? styles.zoomTickMajor : null]} />
                  ))}
                </View>
                <View style={[styles.zoomFill, { width: zoomFillPx }]} />
                <View style={[styles.zoomThumb, { left: zoomThumbPx }]}>
                  <View style={styles.zoomThumbRing}>
                    <View style={styles.zoomThumbCore} />
                  </View>
                  <View style={styles.zoomThumbGloss} />
                </View>
                <View style={styles.zoomCenterLine} pointerEvents="none" />
              </View>
              <View style={styles.zoomScale}>
                <Text style={styles.zoomScaleText}>{ZOOM_MIN}x</Text>
                <GlowPressable style={styles.zoomNudgeBtn} minPressDurationMs={20} onPress={() => bumpZoom(-0.5)}>
                  <Text style={styles.zoomNudgeTxt}>-</Text>
                </GlowPressable>
                <GlowPressable style={styles.zoomNudgeBtn} minPressDurationMs={20} onPress={() => bumpZoom(0.5)}>
                  <Text style={styles.zoomNudgeTxt}>+</Text>
                </GlowPressable>
                <Text style={styles.zoomScaleText}>{ZOOM_MAX}x</Text>
              </View>
              <View style={styles.zoomQuickRow}>
                {[1, 2, 5, 10, 20, 35, 56].map((zv) => (
                  <GlowPressable
                    key={`zq-${zv}`}
                    style={styles.zoomQuickBtn}
                    onPress={() => {
                      zoomValueRef.current = zv;
                      setZoomValue(zv);
                      lastZoomValueRef.current = zv;
                      safeRun(() => setZoom(zv));
                    }}
                  >
                    <Text style={styles.zoomQuickTxt}>{zv}x</Text>
                  </GlowPressable>
                ))}
              </View>
            </View>
          ) : cam === "IR" ? (
            <View style={styles.thermalMeasurePanel}>
              <GlowPressable
                style={[styles.thermalCheckRow, thermalMeasureEnabled && styles.thermalCheckRowActive]}
                onPress={() => {
                  setThermalMeasureEnabled((prev) => !prev);
                  setThermalSpot(null);
                }}
              >
                <View style={[styles.thermalCheckbox, thermalMeasureEnabled && styles.thermalCheckboxActive]}>
                  {thermalMeasureEnabled ? <Text style={styles.thermalCheckMark}>X</Text> : null}
                </View>
                <Text style={styles.thermalCheckText}>MISURA TEMPERATURA SPOT</Text>
              </GlowPressable>
              <Text style={styles.note}>
                {thermalMeasureEnabled
                  ? "Tocca un punto del feed IR per leggere la temperatura."
                  : "Disattivata: nessun tap sul feed viene misurato."}
              </Text>
            </View>
          ) : (
            <Text style={styles.note}>Zoom visibile solo in modalita ZOOM.</Text>
          )}
        </GlassCard>

        <GlassCard>
          <SectionTitle title="GIMBAL JOYSTICK" />
          <Text style={styles.note}>Joystick smooth: trascina per controlli progressivi, rilascia per stop morbido.</Text>
          <View style={styles.joyZone} {...panResponder.panHandlers}>
            <View style={styles.joyRing}>
              <View style={styles.joyCrossV} />
              <View style={styles.joyCrossH} />
              <View style={styles.joyCenterDot} />
              <Animated.View style={[styles.joyKnob, knobPos.getLayout()]} />
            </View>
          </View>
          <View style={styles.sensitivityRow}>
            <Text style={styles.sensitivityLabel}>SENS {Math.round(gimbalSensitivity * 100)}%</Text>
            <View
              style={styles.sensitivityTrack}
              onLayout={(ev) => setSensitivityTrackWidth(ev.nativeEvent.layout.width)}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={(ev) => setSensitivityFromPageX(ev.nativeEvent.locationX)}
              onResponderMove={(ev) => setSensitivityFromPageX(ev.nativeEvent.locationX)}
              onResponderRelease={(ev) => setSensitivityFromPageX(ev.nativeEvent.locationX)}
            >
              <View style={[styles.sensitivityFill, { width: sensitivityFillPx }]} />
              <View style={[styles.sensitivityThumb, { left: sensitivityThumbPx }]} />
            </View>
          </View>
          <View style={styles.row}>
            <GlowPressable
              style={[styles.actionBtn, styles.actionPrimary]}
              onPress={() => {
                gimbalTargetVectorRef.current = { x: 0, y: 0 };
                gimbalFilteredVectorRef.current = { x: 0, y: 0 };
                knobPos.setValue({ x: 0, y: 0 });
                enqueueGimbal(0, 0);
                safeRun(() => resetGimbal("PITCH_YAW"));
              }}
            >
              <Text style={styles.actionText}>CENTRA GIMBAL</Text>
            </GlowPressable>
          </View>
          <Text style={styles.note}>
            Gimbal: P {`${(snapshot?.telemetry.gimbal_pitch ?? 0).toFixed(1)}°`} | Y {`${(snapshot?.telemetry.gimbal_yaw ?? 0).toFixed(1)}°`}
          </Text>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="AZIONI CAMERA" />
          <View style={styles.row}>
            <GlowPressable style={[styles.actionBtn, recordingActive && styles.actionBtnDisabled]} onPress={() => safeRun(takePhoto)}>
              <Text style={styles.actionText}>SCATTA FOTO</Text>
            </GlowPressable>
            <GlowPressable style={[styles.actionBtn, recordingActive && styles.actionBtnDanger]} onPress={() => safeRun(toggleRecording)}>
              <Text style={styles.actionText}>REC ON/OFF</Text>
            </GlowPressable>
          </View>
          <GlowPressable style={[styles.actionBtn, styles.actionWide]} onPress={() => safeRun(() => sendSimpleCmd("toggle_stream"))}>
            <Text style={styles.actionText}>RIAVVIA STREAM</Text>
          </GlowPressable>
        </GlassCard>
      </ScrollView>
      <FloatingCamera defaultExpanded visible={isFocused && showDetachedCamera} bottom={104} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, gap: 14, paddingBottom: 90 },
  title: { color: theme.text, fontSize: 22, letterSpacing: 2.2, fontFamily: fonts.heading },
  subtitle: { color: theme.textMuted, fontFamily: fonts.body },
  streamWrap: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: "hidden",
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },
  stream: { width: "100%", height: 220 },
  streamHud: {
    position: "absolute",
    top: 8,
    left: 8,
    right: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  hudBadge: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 9,
    paddingVertical: 3,
    fontFamily: fonts.mono,
    fontSize: 11,
    backgroundColor: "rgba(0,0,0,0.32)",
  },
  hudText: {
    color: theme.text,
    fontFamily: fonts.mono,
    fontSize: 11,
    backgroundColor: "rgba(0,0,0,0.32)",
    padding: 4,
    borderRadius: 7,
  },
  ok: { color: theme.accent2, borderColor: "rgba(125,255,166,0.55)" },
  err: { color: theme.danger, borderColor: "rgba(255,106,106,0.5)" },
  warn: { color: "#ffd166", borderColor: "rgba(255,209,102,0.55)" },
  rec: { color: "#ff6b6b", borderColor: "rgba(255,107,107,0.55)" },
  streamHudRight: { flexDirection: "row", gap: 6 },
  thermalSpotOverlay: {
    position: "absolute",
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  thermalSpotBox: {
    width: 16,
    height: 16,
    borderWidth: 2,
    borderColor: "#ffd166",
    backgroundColor: "rgba(255,209,102,0.12)",
  },
  thermalTempBubble: {
    position: "absolute",
    left: 20,
    top: -7,
    minWidth: 58,
    maxWidth: 138,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,209,102,0.65)",
    backgroundColor: "rgba(0,0,0,0.72)",
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  thermalTempText: {
    color: "#ffd166",
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  row: { flexDirection: "row", gap: 10 },
  modeBtn: {
    flex: 1,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  modeBtnActive: {
    borderColor: "rgba(77,216,255,0.65)",
    backgroundColor: "rgba(77,216,255,0.14)",
  },
  modeText: { color: theme.text, fontFamily: fonts.mono, letterSpacing: 1.2 },
  zoomRow: { marginTop: 12, gap: 10 },
  zoomLabel: { color: theme.text, fontFamily: fonts.heading, letterSpacing: 1.3, fontSize: 18 },
  zoomTrack: {
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(180,200,216,0.55)",
    backgroundColor: "rgba(18,25,33,0.98)",
    overflow: "hidden",
    justifyContent: "center",
  },
  zoomTicks: {
    ...StyleSheet.absoluteFillObject,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  zoomTick: {
    width: 1,
    height: 9,
    borderRadius: 1,
    backgroundColor: "rgba(173,181,192,0.35)",
  },
  zoomTickMajor: {
    height: 18,
    backgroundColor: "rgba(223,231,240,0.72)",
  },
  zoomFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(92,136,166,0.28)",
  },
  zoomThumb: {
    position: "absolute",
    top: 4,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: "rgba(220,226,236,0.9)",
    backgroundColor: "rgba(48,57,69,0.98)",
    shadowColor: "#000",
    shadowOpacity: 0.36,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 3 },
    alignItems: "center",
    justifyContent: "center",
  },
  zoomThumbRing: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(208,214,224,0.95)",
    backgroundColor: "rgba(76,84,96,0.96)",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomThumbCore: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "rgba(122,132,146,0.9)",
    backgroundColor: "rgba(24,30,38,0.98)",
  },
  zoomThumbGloss: {
    position: "absolute",
    top: 5,
    left: 7,
    right: 7,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.24)",
  },
  zoomCenterLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    left: "50%",
    marginLeft: -1,
    backgroundColor: "rgba(207,214,224,0.24)",
  },
  zoomScale: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  zoomScaleText: { color: theme.textMuted, fontFamily: fonts.mono, fontSize: 11 },
  zoomNudgeBtn: {
    width: 34,
    height: 26,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(77,216,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  zoomNudgeTxt: { color: theme.text, fontFamily: fonts.mono, fontSize: 15 },
  zoomQuickRow: {
    marginTop: 2,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  zoomQuickBtn: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 9,
    paddingVertical: 5,
    backgroundColor: "rgba(77,216,255,0.1)",
  },
  zoomQuickTxt: { color: theme.text, fontFamily: fonts.mono, fontSize: 11 },
  thermalMeasurePanel: { marginTop: 12, gap: 8 },
  thermalCheckRow: {
    minHeight: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(255,255,255,0.03)",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  thermalCheckRowActive: {
    borderColor: "rgba(255,209,102,0.62)",
    backgroundColor: "rgba(255,209,102,0.12)",
  },
  thermalCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255,209,102,0.6)",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.2)",
  },
  thermalCheckboxActive: {
    backgroundColor: "rgba(255,209,102,0.22)",
  },
  thermalCheckMark: {
    color: "#ffd166",
    fontFamily: fonts.mono,
    fontSize: 15,
    lineHeight: 18,
  },
  thermalCheckText: {
    flex: 1,
    color: theme.text,
    fontFamily: fonts.mono,
    letterSpacing: 1.1,
    fontSize: 12,
  },
  joyZone: {
    marginTop: 8,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  joyRing: {
    width: JOYSTICK_RADIUS * 2 + 22,
    height: JOYSTICK_RADIUS * 2 + 22,
    borderRadius: JOYSTICK_RADIUS + 11,
    borderWidth: 1,
    borderColor: "rgba(77,216,255,0.5)",
    backgroundColor: "rgba(6,18,30,0.9)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  joyCrossV: {
    position: "absolute",
    width: 1,
    top: 8,
    bottom: 8,
    backgroundColor: "rgba(125,255,166,0.22)",
  },
  joyCrossH: {
    position: "absolute",
    height: 1,
    left: 8,
    right: 8,
    backgroundColor: "rgba(125,255,166,0.22)",
  },
  joyCenterDot: {
    position: "absolute",
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(125,255,166,0.5)",
  },
  joyKnob: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(125,255,166,0.8)",
    backgroundColor: "rgba(16,35,44,0.98)",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 2 },
  },
  sensitivityRow: {
    marginTop: 4,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  sensitivityLabel: {
    width: 76,
    color: theme.textMuted,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  sensitivityTrack: {
    flex: 1,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(255,255,255,0.04)",
    overflow: "hidden",
    justifyContent: "center",
  },
  sensitivityFill: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "rgba(125,255,166,0.22)",
  },
  sensitivityThumb: {
    position: "absolute",
    top: 3,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(125,255,166,0.85)",
    backgroundColor: "rgba(16,35,44,0.98)",
  },
  actionBtn: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 11,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  actionBtnDisabled: { opacity: 0.72, borderColor: "rgba(255,209,102,0.45)" },
  actionBtnDanger: { borderColor: "rgba(255,107,107,0.55)" },
  actionPrimary: {
    borderColor: "rgba(125,255,166,0.6)",
    backgroundColor: "rgba(125,255,166,0.14)",
  },
  actionWide: { marginTop: 10 },
  actionText: { color: theme.text, fontFamily: fonts.mono, letterSpacing: 1.2, fontSize: 12 },
  note: { marginTop: 8, color: theme.textMuted, fontFamily: fonts.body, fontSize: 11 },
});
