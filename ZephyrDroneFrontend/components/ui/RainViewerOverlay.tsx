import { useEffect, useState } from "react";
import { UrlTile } from "react-native-maps";

type RainViewerFrame = {
  time: number;
  path: string;
};

type RainViewerResponse = {
  host?: string;
  radar?: {
    past?: RainViewerFrame[];
    nowcast?: RainViewerFrame[];
  };
};

type Props = {
  enabled: boolean;
};

const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
const RADAR_OPACITY = 0.18;

function latestFrame(data: RainViewerResponse) {
  const frames = [...(data.radar?.nowcast ?? []), ...(data.radar?.past ?? [])];
  return frames.sort((a, b) => b.time - a.time)[0] ?? null;
}

export function RainViewerOverlay({ enabled }: Props) {
  const [template, setTemplate] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      setTemplate(null);
      return;
    }

    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(RAINVIEWER_API);
        const data = (await res.json()) as RainViewerResponse;
        const frame = latestFrame(data);
        if (!data.host || !frame || cancelled) return;
        setTemplate(`${data.host}${frame.path}/512/{z}/{x}/{y}/2/0_1.png`);
      } catch {
        if (!cancelled) setTemplate(null);
      }
    };

    void load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

  if (!enabled || !template) return null;

  return (
    <UrlTile
      urlTemplate={template}
      maximumZ={7}
      maximumNativeZ={7}
      minimumZ={0}
      zIndex={4}
      tileSize={512}
      opacity={RADAR_OPACITY}
      flipY={false}
    />
  );
}
