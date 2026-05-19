import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { GlassCard } from "@/components/ui/GlassCard";
import { SectionTitle } from "@/components/ui/SectionTitle";
import { fonts, theme } from "@/lib/theme";

function InfoRow({ icon, title, text }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; title: string; text: string }) {
  return (
    <View style={styles.infoRow}>
      <View style={styles.iconBubble}>
        <MaterialCommunityIcons name={icon} size={20} color={theme.accent} />
      </View>
      <View style={styles.infoText}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowText}>{text}</Text>
      </View>
    </View>
  );
}

export default function InfoScreen() {
  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Image source={require("../../assets/images/icon.png")} style={styles.appIcon} contentFit="cover" transition={120} />
          <View style={styles.heroCopy}>
            <Text style={styles.heroTitle}>ZEPHYRDRONE</Text>
            <Text style={styles.heroSubtitle}>Piattaforma operativa per missioni UAV, telemetria live e supporto guardiaparchi.</Text>
          </View>
        </View>

        <GlassCard>
          <SectionTitle title="ISTITUTO" />
          <Image source={require("../../assets/images/itis.jpg")} style={styles.logo} contentFit="cover" transition={120} />
          <Text style={styles.meta}>Contesto didattico e tecnico in cui nasce il progetto ZephyrDrone.</Text>
        </GlassCard>

        <GlassCard>
          <SectionTitle title="PROGETTO" />
          <InfoRow icon="quadcopter" title="Missioni UAV" text="Pianificazione waypoint, missioni salvate, POI e gestione operativa sul campo." />
          <InfoRow icon="access-point-network" title="Realtime" text="Middleware Python con WebSocket per stato missione, telemetria e dashboard." />
          <InfoRow icon="server-network" title="Bridge DJI" text="Server Android con DJI Mobile SDK V5 e canale Ktor verso il middleware." />
        </GlassCard>

        <GlassCard>
          <SectionTitle title="STACK" />
          <View style={styles.list}>
            <Text style={styles.item}>React Native + Expo</Text>
            <Text style={styles.item}>Python FastAPI + WebSocket realtime</Text>
            <Text style={styles.item}>Android DJI Mobile SDK V5 + Ktor bridge</Text>
          </View>
        </GlassCard>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, gap: 14, paddingBottom: 106 },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 14,
    borderRadius: 24,
    backgroundColor: "rgba(6, 25, 12, 0.72)",
    borderWidth: 1,
    borderColor: "rgba(82, 247, 122, 0.22)",
  },
  appIcon: {
    width: 82,
    height: 82,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(82, 247, 122, 0.38)",
  },
  heroCopy: { flex: 1, gap: 6 },
  heroTitle: { color: theme.text, letterSpacing: 2.2, fontSize: 22, fontFamily: fonts.heading },
  heroSubtitle: { color: theme.textMuted, lineHeight: 18, fontFamily: fonts.body },
  logo: {
    width: "100%",
    height: 190,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.border,
    overflow: "hidden",
    marginTop: 8,
  },
  meta: { color: theme.textMuted, marginTop: 10, fontFamily: fonts.body, fontSize: 12 },
  list: { gap: 8 },
  item: {
    color: theme.text,
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 20,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "rgba(82, 247, 122, 0.07)",
    borderWidth: 1,
    borderColor: "rgba(82, 247, 122, 0.11)",
  },
  infoRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
  iconBubble: {
    width: 42,
    height: 42,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(82, 247, 122, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(82, 247, 122, 0.22)",
  },
  infoText: { flex: 1, gap: 3 },
  rowTitle: { color: theme.text, fontFamily: fonts.heading, fontSize: 14, letterSpacing: 0.8 },
  rowText: { color: theme.textMuted, fontFamily: fonts.body, fontSize: 12, lineHeight: 17 },
});
