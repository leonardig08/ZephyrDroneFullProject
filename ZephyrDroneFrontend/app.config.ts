import type { ExpoConfig } from "expo/config";
import appJson from "./app.json";

const baseConfig = appJson.expo as ExpoConfig;

export default (): ExpoConfig => {
  const androidGoogleMapsApiKey = (process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? "").trim();

  return {
    ...baseConfig,
    android: {
      ...(baseConfig.android ?? {}),
      usesCleartextTraffic: true,
      config: {
        ...((baseConfig.android as ExpoConfig["android"] & { config?: Record<string, unknown> })?.config ?? {}),
        googleMaps: {
          apiKey: androidGoogleMapsApiKey,
        },
      },
    },
  };
};
