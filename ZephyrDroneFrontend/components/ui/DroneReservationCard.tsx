import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Image, StyleSheet, Text, View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { getDroneFleet, heartbeatDrone, ManagedDrone, releaseDrone, reserveDrone } from "@/lib/api";
import { getOperatorId, subscribeOperatorId } from "@/lib/runtimeConfig";
import { fonts, theme } from "@/lib/theme";
import { GlowPressable } from "@/components/ui/GlowPressable";

type Props = {
  compact?: boolean;
  onReserved?: () => void;
  onReservationChange?: (reserved: boolean) => void;
};

export function DroneReservationCard({ compact = false, onReserved, onReservationChange }: Props) {
  const [drone, setDrone] = useState<ManagedDrone | null>(null);
  const [status, setStatus] = useState("Ricerca drone operativo...");
  const [busy, setBusy] = useState(false);
  const [operatorId, setOperatorId] = useState(getOperatorId());

  const reservation = drone?.reservation;
  const holder = reservation?.holder;
  const isMine = Boolean(holder?.operator_id && holder.operator_id === operatorId);
  const myQueuePosition = useMemo(() => {
    const item = reservation?.queue.find((q) => q.operator_id === operatorId);
    return item?.position ?? null;
  }, [operatorId, reservation?.queue]);

  const refresh = useCallback(async () => {
    try {
      const items = await getDroneFleet();
      const first = items[0] ?? null;
      setDrone(first);
      if (!first) {
        setStatus("Nessun drone pubblicato dal server Python.");
      } else if (first.reservation.holder?.operator_id === operatorId) {
        setStatus("Drone riservato a questo operatore.");
      } else if (first.reservation.held) {
        const queued = first.reservation.queue.find((q) => q.operator_id === operatorId);
        setStatus(queued ? `In coda operativa, posizione ${queued.position}.` : "Drone occupato da un altro operatore.");
      } else {
        setStatus("Drone disponibile per il controllo.");
      }
    } catch {
      setStatus("Server Python non raggiungibile.");
    }
  }, [operatorId]);

  useEffect(() => subscribeOperatorId(setOperatorId), []);

  useEffect(() => {
    onReservationChange?.(isMine);
  }, [isMine, onReservationChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!drone || (!isMine && myQueuePosition == null)) return;
    const timer = setInterval(() => {
      void heartbeatDrone(drone.id).then((res) => {
        setDrone({ ...res.drone, reservation: res.reservation });
      }).catch(() => undefined);
    }, isMine ? 30000 : 45000);
    return () => clearInterval(timer);
  }, [drone, isMine, myQueuePosition]);

  const occupy = async () => {
    if (!drone || busy) return;
    setBusy(true);
    try {
      const res = await reserveDrone(drone.id);
      setDrone({ ...res.drone, reservation: res.reservation });
      if (res.reserved) {
        setStatus("Controllo acquisito. Drone riservato.");
        onReserved?.();
        onReservationChange?.(true);
      } else {
        const pos = res.queue_position ?? res.reservation.queue_length;
        setStatus(`Drone occupato. Sei in coda: posizione ${pos}.`);
        Alert.alert("Drone occupato", `Un altro operatore sta controllando il drone. Sei stato inserito in coda, posizione ${pos}.`);
      }
    } catch {
      setStatus("Errore prenotazione drone.");
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    if (!drone || busy) return;
    setBusy(true);
    try {
      const res = await releaseDrone(drone.id);
      setDrone({ ...res.drone, reservation: res.reservation });
      setStatus(res.released ? "Prenotazione rilasciata." : "Nessuna prenotazione attiva da rilasciare.");
      onReservationChange?.(false);
    } catch {
      setStatus("Errore rilascio drone.");
    } finally {
      setBusy(false);
    }
  };

  const actionText = isMine ? "RILASCIA" : reservation?.held ? "ENTRA IN CODA" : "OCCUPA DRONE";
  const stateText = isMine ? "IN CONTROLLO" : reservation?.held ? "OCCUPATO" : "DISPONIBILE";

  return (
    <View style={[styles.card, compact && styles.cardCompact]}>
      <View style={styles.header}>
        <View style={[styles.stateDot, isMine ? styles.dotMine : reservation?.held ? styles.dotBusy : styles.dotFree]} />
        <Text style={styles.stateText}>{stateText}</Text>
      </View>
      <Image source={require("../../assets/images/drone-selector.png")} style={[styles.droneImage, compact && styles.droneImageCompact]} resizeMode="contain" />
      <Text style={styles.name}>{drone?.name ?? "Zephyr Mavic 3T"}</Text>
      <Text style={styles.model}>{drone?.model ?? "DJI Mavic 3T Enterprise"}</Text>
      <View style={styles.metaRow}>
        <MaterialCommunityIcons name="access-point" size={15} color={theme.accent} />
        <Text style={styles.meta}>{drone?.connected ? "Bridge drone online" : "Bridge non connesso/mock"}</Text>
      </View>
      {holder && !isMine ? <Text style={styles.queueText}>Occupato da: {holder.operator_name}</Text> : null}
      {myQueuePosition != null ? <Text style={styles.queueText}>Coda: posizione {myQueuePosition}</Text> : null}
      <Text style={styles.status}>{status}</Text>
      <GlowPressable style={[styles.actionBtn, isMine ? styles.releaseBtn : styles.reserveBtn]} onPress={isMine ? release : occupy} disabled={busy || !drone}>
        <Text style={styles.actionText}>{busy ? "ATTENDI..." : actionText}</Text>
      </GlowPressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "100%",
    borderRadius: 26,
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.3)",
    backgroundColor: "rgba(3,16,8,0.68)",
    padding: 16,
    alignItems: "center",
    overflow: "hidden",
  },
  cardCompact: { padding: 14 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start" },
  stateDot: { width: 9, height: 9, borderRadius: 99 },
  dotMine: { backgroundColor: "#52F77A" },
  dotFree: { backgroundColor: "#A7FF6A" },
  dotBusy: { backgroundColor: "#FFB84D" },
  stateText: { color: theme.text, fontFamily: fonts.mono, fontSize: 11, letterSpacing: 1.4 },
  droneImage: { width: "100%", height: 145, marginTop: -4 },
  droneImageCompact: { height: 110 },
  name: { color: theme.text, fontFamily: fonts.heading, fontSize: 19, letterSpacing: 1.2, textAlign: "center" },
  model: { color: theme.textMuted, fontFamily: fonts.body, fontSize: 12, marginTop: 3, textAlign: "center" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 10 },
  meta: { color: theme.textMuted, fontFamily: fonts.body, fontSize: 12 },
  queueText: { color: "#FFDB8A", fontFamily: fonts.mono, fontSize: 11, marginTop: 8, textAlign: "center" },
  status: { color: theme.textMuted, fontFamily: fonts.body, fontSize: 12, textAlign: "center", marginTop: 10 },
  actionBtn: {
    width: "100%",
    marginTop: 13,
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
  },
  reserveBtn: { backgroundColor: "rgba(82,247,122,0.18)", borderColor: "rgba(82,247,122,0.62)" },
  releaseBtn: { backgroundColor: "rgba(255,184,77,0.14)", borderColor: "rgba(255,184,77,0.48)" },
  actionText: { color: theme.text, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1.5, fontWeight: "800" },
});
