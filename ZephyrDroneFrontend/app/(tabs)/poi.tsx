import { FloatingCamera } from "@/components/ui/FloatingCamera";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowPressable } from "@/components/ui/GlowPressable";
import { RainViewerOverlay } from "@/components/ui/RainViewerOverlay";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { useTelemetry } from "@/hooks/useTelemetry";
import { createPoiFavorite, deletePoiFavorite, getPoiFavorites, PoiFavorite } from "@/lib/api";
import {
    getMapLayer,
    getServerHost,
    getWeatherRadarEnabled,
    MapLayer,
    subscribeMapLayer,
    subscribeServerHost,
    subscribeWeatherRadar,
} from "@/lib/runtimeConfig";
import { fonts, theme } from "@/lib/theme";
import { useEffect, useMemo, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MapView, { MapPressEvent, Marker } from "react-native-maps";

function mapTypeFromLayer(layer: MapLayer): "standard" | "satellite" | "hybrid" {
  if (layer === "satellite") return "satellite";
  if (layer === "hybrid") return "hybrid";
  return "standard";
}

export default function PoiScreen() {
  const { snapshot } = useTelemetry();
  const [host, setHost] = useState(getServerHost());
  const [layer, setLayer] = useState<MapLayer>(getMapLayer());
  const [weatherRadarEnabled, setWeatherRadarEnabled] = useState(getWeatherRadarEnabled());
  const [items, setItems] = useState<PoiFavorite[]>([]);
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [altitude, setAltitude] = useState("30");
  const [note, setNote] = useState("");

  useEffect(() => subscribeServerHost(setHost), []);
  useEffect(() => subscribeMapLayer(setLayer), []);
  useEffect(() => subscribeWeatherRadar(setWeatherRadarEnabled), []);

  const apiBase = useMemo(() => `http://${host}:8000`, [host]);
  const telemetryLat = snapshot?.telemetry.latitude;
  const telemetryLon = snapshot?.telemetry.longitude;

  const initialRegion = useMemo(() => {
    if (telemetryLat != null && telemetryLon != null) {
      return {
        latitude: telemetryLat,
        longitude: telemetryLon,
        latitudeDelta: 0.012,
        longitudeDelta: 0.012,
      };
    }
    return {
      latitude: 44.3845,
      longitude: 7.5432,
      latitudeDelta: 0.012,
      longitudeDelta: 0.012,
    };
  }, [telemetryLat, telemetryLon]);
  const draftCoord = useMemo(() => {
    const latNum = Number(lat);
    const lonNum = Number(lon);
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return null;
    return { latitude: latNum, longitude: lonNum };
  }, [lat, lon]);

  async function reload() {
    try {
      setItems(await getPoiFavorites());
    } catch {
      Alert.alert("Errore", "Impossibile caricare i POI.");
    }
  }

  useEffect(() => {
    reload();
  }, []);

  const onMapPress = (ev: MapPressEvent) => {
    const c = ev.nativeEvent.coordinate;
    setLat(c.latitude.toFixed(6));
    setLon(c.longitude.toFixed(6));
  };

  const onSave = async () => {
    const latNum = Number(lat);
    const lonNum = Number(lon);
    const altNum = Number(altitude || "30");
    if (!name.trim()) {
      Alert.alert("Nome richiesto", "Inserisci un nome per il POI.");
      return;
    }
    if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
      Alert.alert("Coordinate non valide", "Inserisci coordinate corrette.");
      return;
    }
    try {
      const res = await createPoiFavorite({
        name: name.trim(),
        lat: latNum,
        lon: lonNum,
        altitude: Number.isFinite(altNum) ? altNum : 30,
        note: note.trim(),
      });
      if (!res.saved) {
        Alert.alert("Errore", res.error ?? "Salvataggio POI fallito.");
        return;
      }
      setName("");
      setNote("");
      await reload();
    } catch {
      Alert.alert("Rete non raggiungibile", `Impossibile salvare POI su ${apiBase}. Controlla IP/porta e server Python.`);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="always" nestedScrollEnabled>
        <Text style={styles.title}>POI PREFERITI</Text>
        <Text style={styles.subtitle}>Salvataggio su SQLite backend. Tap sulla mappa o inserimento manuale.</Text>

        <GlassCard>
          <SectionTitle title="MAPPA" />
          <View style={styles.mapWrap}>
            <MapView
              style={styles.map}
              mapType={mapTypeFromLayer(layer)}
              initialRegion={initialRegion}
              onPress={onMapPress}
            >
              <RainViewerOverlay enabled={weatherRadarEnabled} />
              {items.map((poi) => (
                <Marker
                  key={`poi-${poi.id}`}
                  coordinate={{ latitude: poi.lat, longitude: poi.lon }}
                  title={poi.name}
                  description={`ALT ${poi.altitude}m`}
                  pinColor={theme.warning}
                />
              ))}
              {draftCoord ? (
                <Marker
                  coordinate={draftCoord}
                  title="NUOVO POI"
                  description="Posizione in modifica"
                  pinColor={theme.accent}
                />
              ) : null}
            </MapView>
          </View>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="NUOVO POI" />
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Nome POI" placeholderTextColor="#8aa8b7" />
          <View style={styles.row}>
            <TextInput style={[styles.input, styles.half]} value={lat} onChangeText={setLat} placeholder="Latitudine" placeholderTextColor="#8aa8b7" />
            <TextInput style={[styles.input, styles.half]} value={lon} onChangeText={setLon} placeholder="Longitudine" placeholderTextColor="#8aa8b7" />
          </View>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.half]}
              value={altitude}
              onChangeText={setAltitude}
              placeholder="Altitudine"
              keyboardType="numeric"
              placeholderTextColor="#8aa8b7"
            />
            <GlowPressable style={[styles.btn, styles.btnPrimary]} onPress={onSave}>
              <Text style={styles.btnText}>SALVA POI</Text>
            </GlowPressable>
          </View>
          <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="Nota opzionale" placeholderTextColor="#8aa8b7" />
        </GlassCard>

        <GlassCard>
          <SectionTitle title={`ELENCO (${items.length})`} />
          {items.length === 0 ? (
            <Text style={styles.note}>Nessun POI salvato.</Text>
          ) : (
            items.map((poi) => (
              <View key={poi.id} style={styles.poiRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.poiName}>{poi.name}</Text>
                  <Text style={styles.poiMeta}>
                    {poi.lat.toFixed(5)}, {poi.lon.toFixed(5)} | ALT {poi.altitude}m
                  </Text>
                </View>
                <GlowPressable
                  style={styles.btn}
                  onPress={async () => {
                    try {
                      const res = await deletePoiFavorite(poi.id);
                      if (res.deleted) await reload();
                    } catch {
                      Alert.alert("Rete non raggiungibile", `Impossibile eliminare POI su ${apiBase}.`);
                    }
                  }}
                >
                  <Text style={styles.btnText}>ELIMINA</Text>
                </GlowPressable>
              </View>
            ))
          )}
        </GlassCard>
        <Text style={styles.note}>Server API: {apiBase}</Text>
      </ScrollView>
      <FloatingCamera bottom={104} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, gap: 14, paddingBottom: 90 },
  title: { color: theme.text, fontSize: 22, letterSpacing: 2.4, fontFamily: fonts.heading },
  subtitle: { color: theme.textMuted, fontFamily: fonts.body },
  mapWrap: {
    marginTop: 6,
    height: 300,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: "hidden",
  },
  map: { flex: 1 },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(255,255,255,0.03)",
    paddingHorizontal: 10,
    paddingVertical: 10,
    color: theme.text,
    fontFamily: fonts.body,
    marginBottom: 8,
  },
  row: { flexDirection: "row", gap: 10 },
  half: { flex: 1 },
  btn: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 10,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  btnPrimary: {
    flex: 1,
    borderColor: "rgba(77,216,255,0.72)",
    backgroundColor: "rgba(77,216,255,0.12)",
  },
  btnText: { color: theme.text, fontFamily: fonts.mono, letterSpacing: 1.1, fontSize: 11 },
  note: { color: theme.textMuted, fontFamily: fonts.body, fontSize: 12 },
  poiRow: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    backgroundColor: "rgba(255,255,255,0.02)",
  },
  poiName: { color: theme.text, fontFamily: fonts.body, fontWeight: "700" },
  poiMeta: { color: theme.textMuted, fontFamily: fonts.mono, fontSize: 11, marginTop: 2 },
});
