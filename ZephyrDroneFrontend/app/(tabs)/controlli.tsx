import { FloatingCamera } from "@/components/ui/FloatingCamera";
import { GlassCard } from "@/components/ui/GlassCard";
import { GlowPressable } from "@/components/ui/GlowPressable";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { useTelemetry } from "@/hooks/useTelemetry";
import { sendSimpleCmd } from "@/lib/api";
import { fonts, theme } from "@/lib/theme";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";

async function safeRun(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch {
    // best effort
  }
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.miniStat}>
      <Text style={styles.miniLabel}>{label}</Text>
      <Text style={styles.miniValue}>{value}</Text>
    </View>
  );
}

export default function ControlliScreen() {
  const { snapshot, connected } = useTelemetry();
  const t = snapshot?.telemetry;
  const runCommand = (name: string) => {
    const sensitive: Record<string, { title: string; message: string; destructive?: boolean }> = {
      takeoff: { title: "Conferma decollo", message: "Vuoi avviare il decollo ora?", destructive: true },
      return_home: { title: "Conferma RTH", message: "Vuoi ordinare il rientro alla home?" },
      land: { title: "Conferma atterraggio", message: "Vuoi avviare l'atterraggio ora?", destructive: true },
      confirm_landing: { title: "Conferma atterraggio finale", message: "Confermi l'atterraggio e lo spegnimento logico della procedura?", destructive: true },
      pause_mission: { title: "Conferma pausa", message: "Vuoi mettere in pausa la missione corrente?" },
      resume_mission: { title: "Conferma ripresa missione", message: "Vuoi riprendere la missione dal punto corrente?" },
      stop_mission: { title: "Conferma stop missione", message: "Vuoi fermare la missione corrente?", destructive: true },
    };
    const item = sensitive[name];
    if (!item) {
      void safeRun(() => sendSimpleCmd(name));
      return;
    }
    Alert.alert(item.title, item.message, [
      { text: "Annulla", style: "cancel" },
      { text: "Conferma", style: item.destructive ? "destructive" : "default", onPress: () => void safeRun(() => sendSimpleCmd(name)) },
    ]);
  };

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>CONTROL STATION</Text>
        <Text style={styles.subtitle}>Comandi volo, missione e gimbal in tempo reale</Text>

        <GlassCard>
          <SectionTitle title="TELEMETRIA ASSETTO" />
          <View style={styles.row}>
            <MiniStat label="PITCH" value={`${(t?.pitch ?? 0).toFixed(1)} deg`} />
            <MiniStat label="ROLL" value={`${(t?.roll ?? 0).toFixed(1)} deg`} />
            <MiniStat label="YAW" value={`${(t?.yaw ?? 0).toFixed(1)} deg`} />
          </View>
          <View style={styles.row}>
            <MiniStat label="GIM P" value={`${(t?.gimbal_pitch ?? 0).toFixed(1)} deg`} />
            <MiniStat label="GIM Y" value={`${(t?.gimbal_yaw ?? 0).toFixed(1)} deg`} />
            <MiniStat label="BAT" value={`${snapshot?.battery.percent ?? "-"} %`} />
          </View>
          <Text style={[styles.linkText, connected ? styles.ok : styles.err]}>
            Link: {connected ? "ONLINE" : "OFFLINE"} - Missione: {snapshot?.mission.state ?? "IDLE"}
          </Text>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="VOLO RAPIDO" />
          <View style={styles.row}>
            <GlowPressable style={[styles.cmdBtn, styles.btnGood]} onPress={() => runCommand("takeoff")}>
              <Text style={styles.cmdText}>DECOLLO</Text>
            </GlowPressable>
            <GlowPressable style={[styles.cmdBtn, styles.btnWarn]} onPress={() => runCommand("return_home")}>
              <Text style={styles.cmdText}>RTH</Text>
            </GlowPressable>
          </View>
          <View style={styles.row}>
            <GlowPressable style={[styles.cmdBtn, styles.btnDanger]} onPress={() => runCommand("land")}>
              <Text style={styles.cmdText}>ATTERRA</Text>
            </GlowPressable>
            <GlowPressable
              style={[styles.cmdBtn, styles.btnNeutral]}
              onPress={() => runCommand("confirm_landing")}
            >
              <Text style={styles.cmdText}>CONF. ATTERR.</Text>
            </GlowPressable>
          </View>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="MISSION CONTROL" />
          <View style={styles.row}>
            <GlowPressable style={styles.cmdBtn} onPress={() => runCommand("pause_mission")}>
              <Text style={styles.cmdText}>PAUSA</Text>
            </GlowPressable>
            <GlowPressable style={styles.cmdBtn} onPress={() => runCommand("resume_mission")}>
              <Text style={styles.cmdText}>RESUME</Text>
            </GlowPressable>
          </View>
          <View style={styles.rowSingle}>
            <GlowPressable style={styles.cmdBtn} onPress={() => runCommand("stop_mission")}>
              <Text style={styles.cmdText}>STOP</Text>
            </GlowPressable>
          </View>
          <Text style={styles.note}>Comandi missione allineati al middleware attivo.</Text>
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
  row: { flexDirection: "row", gap: 10, marginBottom: 10 },
  rowSingle: { marginBottom: 10 },
  miniStat: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    padding: 8,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  miniLabel: { color: theme.textMuted, fontFamily: fonts.mono, fontSize: 11, marginBottom: 3 },
  miniValue: { color: theme.text, fontFamily: fonts.body, fontSize: 14, fontWeight: "700" },
  linkText: {
    marginTop: 4,
    fontFamily: fonts.mono,
    fontSize: 11,
    borderWidth: 1,
    borderRadius: 999,
    alignSelf: "flex-start",
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  ok: { color: theme.accent2, borderColor: "rgba(125,255,166,0.5)" },
  err: { color: theme.danger, borderColor: "rgba(255,106,106,0.5)" },
  cmdBtn: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 10,
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  cmdText: { color: theme.text, fontFamily: fonts.mono, letterSpacing: 1.1, fontSize: 12 },
  btnGood: { borderColor: "rgba(125,255,166,0.45)", backgroundColor: "rgba(125,255,166,0.12)" },
  btnWarn: { borderColor: "rgba(255,214,108,0.42)", backgroundColor: "rgba(255,214,108,0.12)" },
  btnDanger: { borderColor: "rgba(255,106,106,0.5)", backgroundColor: "rgba(255,106,106,0.12)" },
  btnNeutral: { borderColor: theme.border, backgroundColor: "rgba(77,216,255,0.1)" },
  note: { marginTop: 2, color: theme.textMuted, fontFamily: fonts.body, fontSize: 11 },
});
