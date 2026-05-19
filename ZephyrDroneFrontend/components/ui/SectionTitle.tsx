import { ReactNode, useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { fonts, theme } from "@/lib/theme";

type Props = {
  title: string;
  right?: ReactNode;
};

export function SectionTitle({ title, right }: Props) {
  const pulse = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
        Animated.timing(pulse, { toValue: 0.3, duration: 900, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Animated.View style={[styles.pulse, { opacity: pulse }]} />
        <Text style={styles.title}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  left: { flexDirection: "row", alignItems: "center", gap: 8 },
  pulse: {
    width: 8,
    height: 8,
    borderRadius: 999,
    backgroundColor: theme.accent2,
    shadowColor: theme.accent2,
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  title: {
    color: theme.text,
    fontSize: 13,
    letterSpacing: 1.8,
    fontFamily: fonts.mono,
  },
});
