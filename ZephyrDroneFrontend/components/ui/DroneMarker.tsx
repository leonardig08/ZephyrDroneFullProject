import { fonts, theme } from "@/lib/theme";
import { Image, StyleSheet, Text, View } from "react-native";

type Props = {
  altitude?: number | null;
};

export function DroneMarker({ altitude }: Props) {
  return (
    <View style={styles.wrap}>
      <Image source={require("../../assets/images/drone-marker.png")} style={styles.marker} resizeMode="contain" />
      <View style={styles.altChip}>
        <Text style={styles.altText}>{Number(altitude ?? 0).toFixed(1)} m</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: "center",
    justifyContent: "center",
  },
  marker: {
    width: 22,
    height: 22,
  },
  altChip: {
    marginTop: -4,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(167,255,106,0.72)",
    backgroundColor: "rgba(1,10,5,0.9)",
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  altText: {
    color: theme.accent2,
    fontFamily: fonts.mono,
    fontSize: 10,
  },
});
