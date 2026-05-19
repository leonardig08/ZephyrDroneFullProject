import { ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, ViewStyle } from "react-native";
import { theme } from "@/lib/theme";

type Props = {
  children: ReactNode;
  style?: ViewStyle;
};

export function GlassCard({ children, style }: Props) {
  const fade = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(8)).current;
  const pulse = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(rise, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 1800, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
        Animated.timing(pulse, { toValue: 0.35, duration: 1800, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
      ]),
    );
    pulseLoop.start();

    return () => {
      pulseLoop.stop();
    };
  }, [fade, rise, pulse]);

  return (
    <Animated.View style={[styles.card, style, { opacity: fade, transform: [{ translateY: rise }] }]}>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.topGlow,
          {
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.14, 0.3] }),
          },
        ]}
      />
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.panel,
    padding: 14,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
    overflow: "hidden",
  },
  topGlow: {
    position: "absolute",
    left: 10,
    right: 10,
    top: 0,
    height: 2,
    borderRadius: 999,
    backgroundColor: theme.accent,
  },
});
