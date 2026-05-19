import { StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { fonts, theme } from "@/lib/theme";
import type { MissionWaypoint } from "@/lib/api";

type Props = {
  waypoints: MissionWaypoint[];
  speedMps?: number;
  compact?: boolean;
};

type ChartPoint = {
  x: number;
  y: number;
  altitude: number;
  distance: number;
};

const CHART_HEIGHT = 96;
const CHART_WIDTH = 300;

function toRad(v: number) {
  return (v * Math.PI) / 180;
}

function distanceMeters(a: MissionWaypoint, b: MissionWaypoint) {
  const r = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function formatDistance(meters: number) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function formatDuration(seconds: number) {
  if (seconds <= 0) return "-";
  const mins = Math.max(1, Math.round(seconds / 60));
  return `${mins} min`;
}

function buildChart(waypoints: MissionWaypoint[]) {
  const valid = waypoints.filter((wp) => Number.isFinite(wp.lat) && Number.isFinite(wp.lon));
  if (valid.length === 0) return { points: [] as ChartPoint[], distance: 0, minAlt: 0, maxAlt: 0 };

  const distances = valid.map(() => 0);
  for (let i = 1; i < valid.length; i += 1) {
    distances[i] = distances[i - 1] + distanceMeters(valid[i - 1], valid[i]);
  }

  const totalDistance = distances[distances.length - 1] || 1;
  const alts = valid.map((wp) => Number(wp.altitude || 0));
  const minAlt = Math.min(...alts);
  const maxAlt = Math.max(...alts);
  const altRange = Math.max(1, maxAlt - minAlt);

  const points = valid.map((wp, i) => {
    const altitude = Number(wp.altitude || 0);
    return {
      x: (distances[i] / totalDistance) * CHART_WIDTH,
      y: CHART_HEIGHT - ((altitude - minAlt) / altRange) * (CHART_HEIGHT - 16) - 8,
      altitude,
      distance: distances[i],
    };
  });

  return {
    points,
    distance: distances[distances.length - 1] || 0,
    minAlt,
    maxAlt,
  };
}

export function AltitudeProfile({ waypoints, speedMps = 5, compact = false }: Props) {
  const { points, distance, minAlt, maxAlt } = buildChart(waypoints);
  const duration = speedMps > 0 ? distance / speedMps : 0;
  const hasProfile = points.length >= 2;

  return (
    <View style={[styles.wrap, compact && styles.wrapCompact]}>
      <View style={styles.header}>
        <View style={styles.headerTitle}>
          <MaterialCommunityIcons name="terrain" size={16} color={theme.accent} />
          <Text style={styles.title}>PROFILO QUOTA</Text>
        </View>
        <Text style={styles.headerMeta}>{formatDuration(duration)}</Text>
      </View>

      <View style={styles.chartFrame}>
        <View style={styles.gridLineTop} />
        <View style={styles.gridLineMid} />
        <View style={styles.gridLineBottom} />
        {hasProfile ? (
          <>
            {points.slice(0, -1).map((p, i) => {
              const next = points[i + 1];
              const dx = next.x - p.x;
              const dy = next.y - p.y;
              const len = Math.sqrt(dx * dx + dy * dy);
              const angle = `${Math.atan2(dy, dx)}rad`;
              return (
                <View
                  key={`alt-seg-${i}`}
                  style={[
                    styles.segment,
                    {
                      width: len,
                      left: p.x + dx / 2 - len / 2,
                      top: p.y + dy / 2,
                      transform: [{ rotate: angle }],
                    },
                  ]}
                />
              );
            })}
            {points.map((p, i) => (
              <View key={`alt-dot-${i}`} style={[styles.dot, { left: p.x - 3, top: p.y - 3 }]} />
            ))}
          </>
        ) : (
          <Text style={styles.empty}>Aggiungi waypoint per vedere il profilo</Text>
        )}
      </View>

      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>DIST</Text>
          <Text style={styles.statValue}>{formatDistance(distance)}</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>MIN</Text>
          <Text style={styles.statValue}>{Math.round(minAlt)} m</Text>
        </View>
        <View style={styles.stat}>
          <Text style={styles.statLabel}>MAX</Text>
          <Text style={styles.statValue}>{Math.round(maxAlt)} m</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(87,255,128,0.24)",
    backgroundColor: "rgba(1,16,8,0.48)",
    padding: 10,
    overflow: "hidden",
  },
  wrapCompact: {
    marginTop: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  headerTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  title: {
    color: theme.text,
    fontFamily: fonts.mono,
    fontSize: 11,
    fontWeight: "700",
  },
  headerMeta: {
    color: theme.accent2,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  chartFrame: {
    width: "100%",
    height: CHART_HEIGHT,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(87,255,128,0.18)",
    backgroundColor: "rgba(0,0,0,0.22)",
    overflow: "hidden",
  },
  gridLineTop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 16,
    borderTopWidth: 1,
    borderTopColor: "rgba(87,255,128,0.08)",
  },
  gridLineMid: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 48,
    borderTopWidth: 1,
    borderTopColor: "rgba(87,255,128,0.12)",
  },
  gridLineBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 16,
    borderTopWidth: 1,
    borderTopColor: "rgba(87,255,128,0.08)",
  },
  segment: {
    position: "absolute",
    height: 3,
    borderRadius: 999,
    backgroundColor: theme.accent,
    shadowColor: theme.accent,
    shadowOpacity: 0.75,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 0 },
  },
  dot: {
    position: "absolute",
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: theme.accent2,
    borderWidth: 1,
    borderColor: "rgba(226,255,232,0.9)",
  },
  empty: {
    color: theme.textMuted,
    fontFamily: fonts.body,
    fontSize: 12,
    alignSelf: "center",
    marginTop: 36,
  },
  stats: {
    flexDirection: "row",
    gap: 8,
    marginTop: 9,
  },
  stat: {
    flex: 1,
    borderRadius: 8,
    backgroundColor: "rgba(87,255,128,0.08)",
    paddingVertical: 7,
    paddingHorizontal: 8,
  },
  statLabel: {
    color: theme.textMuted,
    fontFamily: fonts.mono,
    fontSize: 9,
    marginBottom: 2,
  },
  statValue: {
    color: theme.text,
    fontFamily: fonts.heading,
    fontSize: 15,
  },
});
