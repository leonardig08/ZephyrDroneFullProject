import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { theme } from "@/lib/theme";

export function TechBackdrop() {
  const driftA = useRef(new Animated.Value(0)).current;
  const driftB = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loopA = Animated.loop(
      Animated.sequence([
        Animated.timing(driftA, { toValue: 1, duration: 9000, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(driftA, { toValue: 0, duration: 9000, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
      ]),
    );
    const loopB = Animated.loop(
      Animated.sequence([
        Animated.timing(driftB, { toValue: 0, duration: 11000, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(driftB, { toValue: 1, duration: 11000, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
      ]),
    );
    loopA.start();
    loopB.start();
    return () => {
      loopA.stop();
      loopB.stop();
    };
  }, [driftA, driftB]);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.base} />
      <View style={styles.gradientTop} />
      <View style={styles.gradientBottom} />
      <Animated.View
        style={[
          styles.blobA,
          {
            transform: [
              {
                translateX: driftA.interpolate({ inputRange: [0, 1], outputRange: [-30, 22] }),
              },
              {
                translateY: driftA.interpolate({ inputRange: [0, 1], outputRange: [18, -26] }),
              },
            ],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.blobB,
          {
            transform: [
              {
                translateX: driftB.interpolate({ inputRange: [0, 1], outputRange: [26, -16] }),
              },
              {
                translateY: driftB.interpolate({ inputRange: [0, 1], outputRange: [-24, 18] }),
              },
            ],
          },
        ]}
      />
      <View style={styles.grid} />
      <View style={styles.scanLineA} />
      <View style={styles.scanLineB} />
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.bg,
  },
  gradientTop: {
    position: "absolute",
    top: -90,
    left: -80,
    right: -80,
    height: 320,
    borderRadius: 18,
    backgroundColor: "rgba(31, 95, 45, 0.44)",
    transform: [{ rotate: "-9deg" }],
  },
  gradientBottom: {
    position: "absolute",
    bottom: -130,
    left: -80,
    right: -80,
    height: 360,
    borderRadius: 18,
    backgroundColor: "rgba(6, 58, 23, 0.48)",
    transform: [{ rotate: "7deg" }],
  },
  blobA: {
    position: "absolute",
    width: 260,
    height: 420,
    borderRadius: 22,
    backgroundColor: "rgba(82,247,122,0.08)",
    top: -160,
    left: -80,
    transform: [{ rotate: "-16deg" }],
  },
  blobB: {
    position: "absolute",
    width: 240,
    height: 380,
    borderRadius: 22,
    backgroundColor: "rgba(167,255,106,0.07)",
    bottom: -140,
    right: -70,
    transform: [{ rotate: "14deg" }],
  },
  grid: {
    ...StyleSheet.absoluteFillObject,
    borderColor: "rgba(87,255,128,0.055)",
    borderWidth: 1,
  },
  scanLineA: {
    position: "absolute",
    left: -40,
    right: -40,
    top: 118,
    height: 1,
    backgroundColor: "rgba(167,255,106,0.18)",
    transform: [{ rotate: "-5deg" }],
  },
  scanLineB: {
    position: "absolute",
    left: -40,
    right: -40,
    bottom: 138,
    height: 1,
    backgroundColor: "rgba(82,247,122,0.12)",
    transform: [{ rotate: "8deg" }],
  },
});
