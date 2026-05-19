import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Tabs } from "expo-router";
import { theme } from "@/lib/theme";

const TAB_ICON_SIZE = 16;

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        lazy: true,
        freezeOnBlur: true,
        tabBarStyle: {
          backgroundColor: "rgba(2,12,6,0.94)",
          borderTopColor: "rgba(87,255,128,0.26)",
          borderTopWidth: 1,
          height: 80,
          paddingBottom: 10,
          paddingTop: 8,
          marginHorizontal: 10,
          marginBottom: 10,
          borderRadius: 14,
          position: "absolute",
          overflow: "hidden",
        },
        tabBarLabelStyle: { fontSize: 10, letterSpacing: 0, fontWeight: "700" },
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarItemStyle: { borderRadius: 10, marginHorizontal: 1 },
        tabBarAllowFontScaling: false,
      }}
    >
      <Tabs.Screen
        name="home"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => <MaterialCommunityIcons name="radar" size={TAB_ICON_SIZE} color={color} />,
        }}
      />
      <Tabs.Screen
        name="missioni"
        options={{
          title: "Missioni",
          tabBarIcon: ({ color }) => <MaterialCommunityIcons name="routes" size={TAB_ICON_SIZE} color={color} />,
        }}
      />
      <Tabs.Screen
        name="poi"
        options={{
          title: "POI",
          tabBarIcon: ({ color }) => <MaterialCommunityIcons name="map-marker-radius" size={TAB_ICON_SIZE} color={color} />,
        }}
      />
      <Tabs.Screen
        name="camera"
        options={{
          title: "Camera",
          tabBarIcon: ({ color }) => <MaterialCommunityIcons name="cctv" size={TAB_ICON_SIZE} color={color} />,
        }}
      />
      <Tabs.Screen
        name="controlli"
        options={{
          title: "Controlli",
          tabBarIcon: ({ color }) => <MaterialCommunityIcons name="controller-classic-outline" size={TAB_ICON_SIZE} color={color} />,
        }}
      />
      <Tabs.Screen
        name="impostazioni"
        options={{
          title: "Impost.",
          tabBarIcon: ({ color }) => <MaterialCommunityIcons name="cog-outline" size={TAB_ICON_SIZE} color={color} />,
        }}
      />
      <Tabs.Screen
        name="info"
        options={{
          href: null,
          title: "Info",
        }}
      />
    </Tabs>
  );
}
