import { Image, StyleSheet, Text, View } from "react-native";
import { fonts, theme } from "@/lib/theme";

type Props = {
  index: number;
  altitude?: number | null;
};

export function WaypointMarker({ index, altitude }: Props) {
  return (
    <View style={styles.wrap}>
      <View style={styles.dotWrap}>
        <Image source={require("../../assets/images/waypoint-dot.png")} style={styles.markerImage} resizeMode="contain" />
        <Text style={styles.num}>{index + 1}</Text>
      </View>
      {altitude != null ? (
        <View style={styles.alt} collapsable={false}>
          <Text style={styles.altText}>{Math.round(altitude)}m</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 44,
    height: 50,
    alignItems: "center",
    justifyContent: "flex-start",
    backgroundColor: "transparent",
  },
  dotWrap: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  markerImage: { width: 34, height: 34 },
  num: {
    position: "absolute",
    color: "#031006",
    fontFamily: fonts.heading,
    fontSize: 13,
    lineHeight: 15,
    includeFontPadding: false,
  },
  alt: {
    marginTop: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(82,247,122,0.55)",
    backgroundColor: "rgba(2,7,4,0.82)",
    paddingHorizontal: 5,
    paddingVertical: 1,
    minWidth: 30,
    alignItems: "center",
  },
  altText: { color: theme.text, fontFamily: fonts.mono, fontSize: 8, includeFontPadding: false },
});
