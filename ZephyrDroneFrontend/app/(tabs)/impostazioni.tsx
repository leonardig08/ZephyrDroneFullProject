import { DroneReservationCard } from "@/components/ui/DroneReservationCard";
import { FloatingCamera } from "@/components/ui/FloatingCamera";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowPressable } from "@/components/ui/GlowPressable";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { getApiBaseUrl, getNetworkSettings, saveNetworkSettings } from "@/lib/api";
import {
    getMapLayer,
    getGpsDeviationWarningsEnabled,
    getMockFeedEnabled,
    getServerHost,
    getWeatherRadarEnabled,
    loadPersistedServerHost,
    persistMapLayer,
    persistGpsDeviationWarningsEnabled,
    persistMockFeedEnabled,
    persistServerHost,
    persistWeatherRadarEnabled,
} from "@/lib/runtimeConfig";
import { fonts, theme } from "@/lib/theme";
import { useEffect, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

export default function ImpostazioniScreen() {
  const [serverHostInput, setServerHostInput] = useState(getServerHost());
  const [kotlinHost, setKotlinHost] = useState("");
  const [kotlinPort, setKotlinPort] = useState("8081");
  const [go2rtcUrl, setGo2rtcUrl] = useState("");
  const [mapLayer, setMapLayer] = useState(getMapLayer());
  const [weatherRadarEnabled, setWeatherRadarEnabled] = useState(getWeatherRadarEnabled());
  const [gpsDeviationWarningsEnabled, setGpsDeviationWarningsEnabled] = useState(getGpsDeviationWarningsEnabled());
  const [mockFeedEnabled, setMockFeedEnabled] = useState(getMockFeedEnabled());
  const [status, setStatus] = useState("Caricamento...");
  const [discovering, setDiscovering] = useState(false);

  useEffect(() => {
    loadPersistedServerHost().then((host) => {
      setServerHostInput(host);
      setMapLayer(getMapLayer());
      setWeatherRadarEnabled(getWeatherRadarEnabled());
      setGpsDeviationWarningsEnabled(getGpsDeviationWarningsEnabled());
      setMockFeedEnabled(getMockFeedEnabled());
      setStatus(`Host persistito caricato: ${host}`);
    });
  }, []);

  const applyAppHost = async () => {
    try {
      const host = await persistServerHost(serverHostInput);
      setServerHostInput(host);
      setStatus(`App collegata a ${host}`);
    } catch (e) {
      setStatus(`Errore salvataggio IP app: ${String(e)}`);
    }
  };

  const loadPythonNetwork = async () => {
    try {
      const s = await getNetworkSettings();
      setKotlinHost(s.kotlin_host ?? "");
      setKotlinPort(String(s.kotlin_port ?? 8081));
      setGo2rtcUrl(s.go2rtc_url ?? "");
      setStatus("Impostazioni Python caricate");
    } catch {
      setStatus("Python non raggiungibile con l'IP attuale");
    }
  };

  const savePythonNetwork = async () => {
    try {
      const payload = {
        kotlin_host: kotlinHost.trim(),
        kotlin_port: Number(kotlinPort || 8081),
        go2rtc_url: go2rtcUrl.trim(),
      };
      const res = await saveNetworkSettings(payload);
      if (!res.saved) {
        Alert.alert("Errore", res.error ?? "Salvataggio fallito");
        return;
      }
      setStatus(
        `Python salvato${res.reconnect_triggered ? " - bridge riconnesso" : ""}`,
      );
    } catch {
      setStatus("Errore salvataggio Python");
    }
  };

  const saveMapLayer = async (layer: "standard" | "satellite" | "hybrid") => {
    try {
      const saved = await persistMapLayer(layer);
      setMapLayer(saved);
      setStatus(`Layer mappa salvato: ${saved.toUpperCase()}`);
    } catch {
      setStatus("Errore salvataggio layer mappa");
    }
  };

  const saveWeatherRadar = async () => {
    try {
      const saved = await persistWeatherRadarEnabled(!weatherRadarEnabled);
      setWeatherRadarEnabled(saved);
      setStatus(`Radar meteo RainViewer: ${saved ? "ON" : "OFF"}`);
    } catch {
      setStatus("Errore salvataggio radar meteo");
    }
  };

  const saveGpsDeviationWarnings = async () => {
    try {
      const saved = await persistGpsDeviationWarningsEnabled(!gpsDeviationWarningsEnabled);
      setGpsDeviationWarningsEnabled(saved);
      setStatus(`Avvisi deviazione GPS: ${saved ? "ON" : "OFF"}`);
    } catch {
      setStatus("Errore salvataggio avvisi deviazione GPS");
    }
  };

  const saveMockFeed = async () => {
    try {
      const saved = await persistMockFeedEnabled(!mockFeedEnabled);
      setMockFeedEnabled(saved);
      setStatus(`Mock camera feed sessione: ${saved ? "ON" : "OFF"}`);
    } catch {
      setStatus("Errore salvataggio mock camera feed");
    }
  };

  const normalizeHost = (raw: string) =>
    raw
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/^ws:\/\//i, "")
      .replace(/\/+$/, "")
      .split(":")[0];

  const testLink = async () => {
    const host = normalizeHost(serverHostInput);
    const api = `http://${host}:8000`;
    const wsUrl = `ws://${host}:8000/ws/telemetry`;
    setStatus(`Test link in corso su ${api} ...`);
    try {
      const r = await fetch(`${api}/status`);
      if (!r.ok) throw new Error(`API ${r.status}`);
    } catch (e) {
      setStatus(`Errore API (${api}/status): ${e}`);
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const t = setTimeout(() => {
          ws.close();
          reject(new Error("timeout ws"));
        }, 2500);
        ws.onopen = () => {
          clearTimeout(t);
          ws.close();
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(t);
          reject(new Error("ws error"));
        };
      });
      setStatus(`Link OK: API + WebSocket raggiungibili su ${host}`);
    } catch (e) {
      setStatus(`API ok, WS ko (${wsUrl}): ${e}`);
    }
  };

  const isIpv4 = (v: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
  const subnetPrefix = (host: string) => {
    const parts = host.split(".");
    if (parts.length !== 4) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}`;
  };
  const localSubnetPrefixes = () => {
    const prefixes = new Set<string>();
    const current = subnetPrefix(normalizeHost(serverHostInput));
    if (current) prefixes.add(current);
    prefixes.add("192.168.1");
    prefixes.add("192.168.0");
    prefixes.add("192.168.4");
    prefixes.add("192.168.8");
    prefixes.add("192.168.43");
    prefixes.add("192.168.100");
    prefixes.add("10.101.30");
    prefixes.add("10.0.1");
    prefixes.add("10.0.0");
    prefixes.add("10.10.0");
    prefixes.add("172.16.0");
    prefixes.add("172.20.10");
    return Array.from(prefixes);
  };
  const fetchWithTimeout = async (url: string, timeoutMs = 800) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { signal: ctrl.signal });
    } finally {
      clearTimeout(t);
    }
  };

  const autoDiscoverServer = async () => {
    const host = normalizeHost(serverHostInput);
    const prefixes = localSubnetPrefixes();
    setDiscovering(true);
    setStatus(`Scan reti: ${prefixes.map((p) => `${p}.0/24`).join(", ")} ...`);

    let found: string | null = null;
    const chunkSize = 24;
    for (const prefix of prefixes) {
      if (found) break;
      const selfLast = isIpv4(host) && subnetPrefix(host) === prefix ? Number(host.split(".")[3] || "0") : 1;
      const candidates: number[] = [];
      for (let d = 0; d <= 60; d += 1) {
        const left = selfLast - d;
        const right = selfLast + d;
        if (left >= 1 && left <= 254) candidates.push(left);
        if (d !== 0 && right >= 1 && right <= 254) candidates.push(right);
      }
      for (let i = 1; i <= 254; i += 1) {
        if (!candidates.includes(i)) candidates.push(i);
      }
      for (let i = 0; i < candidates.length && !found; i += chunkSize) {
        const chunk = candidates.slice(i, i + chunkSize);
        const results = await Promise.all(
          chunk.map(async (n) => {
            const ip = `${prefix}.${n}`;
            try {
              const r = await fetchWithTimeout(`http://${ip}:8000/status`, 750);
              if (!r.ok) return null;
              const data = (await r.json()) as {
                service?: string;
                status?: string;
                drone?: unknown;
                bridge_connected?: unknown;
              };
              const byService = String(data?.service ?? "").toLowerCase().includes("zephyr");
              const byStatus = String(data?.status ?? "").toLowerCase() === "ok";
              const byShape = data?.drone != null && typeof data?.bridge_connected === "boolean";
              if (byService || byStatus || byShape) return ip;
              return null;
            } catch {
              return null;
            }
          }),
        );
        found = results.find((x) => x != null) ?? null;
      }
    }

    setDiscovering(false);
    if (!found) {
      setStatus("Nessun server Zephyr trovato sulla subnet.");
      return;
    }
    try {
      const saved = await persistServerHost(found);
      setServerHostInput(saved);
      setStatus(`Server trovato e salvato: ${saved}`);
    } catch (e) {
      setStatus(`Server trovato (${found}) ma salvataggio fallito: ${String(e)}`);
    }
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>IMPOSTAZIONI RETE</Text>
        <Text style={styles.subtitle}>Salva IP app e configurazione middleware</Text>

        <GlassCard>
          <SectionTitle title="SELEZIONE DRONE" />
          <Text style={styles.note}>Riserva il drone operativo o verifica la tua posizione in coda.</Text>
          <DroneReservationCard compact />
        </GlassCard>

        <GlassCard>
          <SectionTitle title="APP -> PYTHON MIDDLEWARE" />
          <Text style={styles.note}>IP server middleware (porta 8000/1984)</Text>
          <TextInput
            value={serverHostInput}
            onChangeText={setServerHostInput}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="192.168.1.50"
            placeholderTextColor="rgba(214,244,255,0.4)"
          />
          <View style={styles.row}>
            <GlowPressable style={styles.btn} onPress={applyAppHost}>
              <Text style={styles.btnText}>SALVA IP APP</Text>
            </GlowPressable>
            <GlowPressable style={styles.btn} onPress={loadPythonNetwork}>
              <Text style={styles.btnText}>TEST + LOAD PY</Text>
            </GlowPressable>
          </View>
          <View style={styles.row}>
            <GlowPressable style={[styles.btn, styles.btnPrimary]} onPress={testLink}>
              <Text style={styles.btnText}>TEST LINK APP</Text>
            </GlowPressable>
            <GlowPressable style={[styles.btn, styles.btnPrimary]} onPress={autoDiscoverServer} disabled={discovering}>
              <Text style={styles.btnText}>{discovering ? "SCAN..." : "AUTO TROVA SERVER"}</Text>
            </GlowPressable>
          </View>
          <Text style={styles.note}>API attiva (salvata): {getApiBaseUrl()}</Text>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="PYTHON -> CONTROLLER / GO2RTC" />
          <Text style={styles.note}>Questi valori vengono salvati nel middleware Python</Text>
          <TextInput
            value={kotlinHost}
            onChangeText={setKotlinHost}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="Host controller DJI"
            placeholderTextColor="rgba(214,244,255,0.4)"
          />
          <TextInput
            value={kotlinPort}
            onChangeText={setKotlinPort}
            keyboardType="numeric"
            style={styles.input}
            placeholder="Porta Kotlin (8081)"
            placeholderTextColor="rgba(214,244,255,0.4)"
          />
          <TextInput
            value={go2rtcUrl}
            onChangeText={setGo2rtcUrl}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            placeholder="http://127.0.0.1:1984"
            placeholderTextColor="rgba(214,244,255,0.4)"
          />
          <View style={styles.row}>
            <GlowPressable style={styles.btn} onPress={loadPythonNetwork}>
              <Text style={styles.btnText}>RICARICA</Text>
            </GlowPressable>
            <GlowPressable style={[styles.btn, styles.btnPrimary]} onPress={savePythonNetwork}>
              <Text style={styles.btnText}>SALVA PYTHON</Text>
            </GlowPressable>
          </View>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="MAPPA APP" />
          <Text style={styles.note}>Layer usato in Missioni/Home/POI (Google Maps provider)</Text>
          <View style={styles.rowWrap}>
            {(["standard", "satellite", "hybrid"] as const).map((layer) => (
              <GlowPressable
                key={layer}
                style={[styles.modeBtn, mapLayer === layer && styles.modeBtnActive]}
                onPress={() => saveMapLayer(layer)}
              >
                <Text style={styles.modeBtnText}>{layer.toUpperCase()}</Text>
              </GlowPressable>
            ))}
          </View>
          <GlowPressable
            style={[styles.weatherBtn, weatherRadarEnabled && styles.weatherBtnActive]}
            onPress={saveWeatherRadar}
          >
            <Text style={styles.btnText}>RAINVIEWER RADAR {weatherRadarEnabled ? "ON" : "OFF"}</Text>
          </GlowPressable>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="SICUREZZA MISSIONE" />
          <Text style={styles.note}>Avvisa se il drone si allontana molto dalla rotta prevista durante una missione.</Text>
          <GlowPressable
            style={[styles.weatherBtn, gpsDeviationWarningsEnabled && styles.weatherBtnActive]}
            onPress={saveGpsDeviationWarnings}
          >
            <Text style={styles.btnText}>AVVISI DEVIAZIONE GPS {gpsDeviationWarningsEnabled ? "ON" : "OFF"}</Text>
          </GlowPressable>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="SIMULAZIONE / MOCK" />
          <Text style={styles.note}>Solo per questa sessione, sempre OFF al riavvio. Influenza soltanto il feed video camera.</Text>
          <GlowPressable
            style={[styles.weatherBtn, mockFeedEnabled && styles.weatherBtnActive]}
            onPress={saveMockFeed}
          >
            <Text style={styles.btnText}>MOCK FEED CAMERA {mockFeedEnabled ? "ON" : "OFF"}</Text>
          </GlowPressable>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="STATO" />
          <Text style={styles.status}>{status}</Text>
          <Text style={styles.note}>Pagina web Python settings: /settings</Text>
        </GlassCard>
      </ScrollView>
      <FloatingCamera bottom={104} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, gap: 14, paddingBottom: 90 },
  title: { color: theme.text, fontSize: 22, letterSpacing: 2.2, fontFamily: fonts.heading },
  subtitle: { color: theme.textMuted, fontFamily: fonts.body },
  note: { color: theme.textMuted, fontFamily: fonts.body, fontSize: 12, marginBottom: 8 },
  input: {
    borderRadius: 11,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: "rgba(255,255,255,0.03)",
    color: theme.text,
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginBottom: 8,
    fontFamily: fonts.mono,
  },
  row: { flexDirection: "row", gap: 10, marginTop: 2 },
  rowWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  btn: {
    flex: 1,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  btnPrimary: {
    borderColor: "rgba(77,216,255,0.68)",
    backgroundColor: "rgba(77,216,255,0.14)",
  },
  btnText: { color: theme.text, fontFamily: fonts.mono, letterSpacing: 1.1, fontSize: 11 },
  status: {
    color: theme.accent2,
    fontFamily: fonts.mono,
    fontSize: 12,
    borderWidth: 1,
    borderColor: "rgba(125,255,166,0.4)",
    borderRadius: 10,
    padding: 10,
    backgroundColor: "rgba(125,255,166,0.08)",
  },
  modeBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  modeBtnActive: {
    borderColor: "rgba(77,216,255,0.68)",
    backgroundColor: "rgba(77,216,255,0.14)",
  },
  modeBtnText: { color: theme.text, fontFamily: fonts.mono, fontSize: 11 },
  weatherBtn: {
    marginTop: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 10,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  weatherBtnActive: {
    borderColor: "rgba(87,255,128,0.68)",
    backgroundColor: "rgba(87,255,128,0.14)",
  },
});
