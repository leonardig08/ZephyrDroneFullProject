import { ReactNode, useRef } from "react";
import {
  Animated,
  Easing,
  Pressable,
  PressableProps,
  StyleProp,
  StyleSheet,
  ViewStyle,
} from "react-native";
import { theme } from "@/lib/theme";

type Props = Omit<PressableProps, "style" | "children"> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  glowColor?: string;
  glowRadius?: number;
  minPressDurationMs?: number;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function GlowPressable({
  children,
  style,
  glowColor = theme.accent,
  glowRadius = 12,
  minPressDurationMs = 35,
  onPress,
  onPressIn,
  onPressOut,
  ...rest
}: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const glow = useRef(new Animated.Value(0)).current;
  const flash = useRef(new Animated.Value(0)).current;
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const pressStartTsRef = useRef(0);
  const suppressPressRef = useRef(false);
  const MOVE_CANCEL_X_PX = 14;
  const MOVE_CANCEL_Y_PX = 10;

  const handlePressIn: PressableProps["onPressIn"] = (ev) => {
    startXRef.current = ev.nativeEvent.pageX;
    startYRef.current = ev.nativeEvent.pageY;
    pressStartTsRef.current = Date.now();
    suppressPressRef.current = false;
    Animated.parallel([
      Animated.timing(scale, { toValue: 0.972, duration: 85, useNativeDriver: true, easing: Easing.out(Easing.quad) }),
      Animated.timing(glow, { toValue: 1, duration: 90, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
    onPressIn?.(ev);
  };

  const handlePressOut: PressableProps["onPressOut"] = (ev) => {
    const dx = Math.abs(ev.nativeEvent.pageX - startXRef.current);
    const dy = Math.abs(ev.nativeEvent.pageY - startYRef.current);
    if (dx > MOVE_CANCEL_X_PX || dy > MOVE_CANCEL_Y_PX) {
      suppressPressRef.current = true;
    }
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 170, useNativeDriver: true, easing: Easing.out(Easing.back(1.4)) }),
      Animated.timing(glow, { toValue: 0, duration: 180, useNativeDriver: true }),
      Animated.timing(flash, { toValue: 0, duration: 220, useNativeDriver: true }),
    ]).start();
    onPressOut?.(ev);
  };

  const handlePress: PressableProps["onPress"] = (ev) => {
    const heldMs = Date.now() - pressStartTsRef.current;
    if (heldMs < minPressDurationMs) {
      suppressPressRef.current = false;
      return;
    }
    if (suppressPressRef.current) {
      suppressPressRef.current = false;
      return;
    }
    onPress?.(ev);
  };

  const handleTouchMove: PressableProps["onTouchMove"] = (ev) => {
    const touch = ev.nativeEvent.touches?.[0];
    if (!touch) return;
    const dx = Math.abs(touch.pageX - startXRef.current);
    const dy = Math.abs(touch.pageY - startYRef.current);
    if (dx > MOVE_CANCEL_X_PX || dy > MOVE_CANCEL_Y_PX) {
      suppressPressRef.current = true;
    }
  };

  return (
    <AnimatedPressable
      {...rest}
      style={[style, { transform: [{ scale }] }]}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onTouchMove={handleTouchMove}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.overlay,
          {
            backgroundColor: glowColor,
            borderRadius: glowRadius,
            opacity: glow.interpolate({
              inputRange: [0, 1],
              outputRange: [0, 0.17],
            }),
          },
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[
          styles.flash,
          {
            opacity: flash.interpolate({ inputRange: [0, 1], outputRange: [0, 0.2] }),
          },
        ]}
      />
      {children}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  flash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.8)",
  },
});
