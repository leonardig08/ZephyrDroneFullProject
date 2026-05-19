import { useEffect, useMemo, useState } from "react";
import { Image } from "expo-image";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import {
  getMockFeedEnabled,
  getWsBase,
  subscribeMockFeed,
  subscribeServerHost,
} from "@/lib/runtimeConfig";

type Props = {
  host: string;
  src?: string;
  intervalMs?: number;
  paused?: boolean;
  style?: object;
  contentFit?: "cover" | "contain" | "fill" | "none" | "scale-down";
};

export function LiveFrameImage({
  host: _host,
  src = "dji",
  paused = false,
  style,
  contentFit = "cover",
}: Props) {
  const [mockFeedEnabled, setMockFeedEnabled] = useState(getMockFeedEnabled());
  const [telemetryWsUrl, setTelemetryWsUrl] = useState(getWsBase());

  useEffect(() => subscribeMockFeed(setMockFeedEnabled), []);
  useEffect(() => subscribeServerHost(() => setTelemetryWsUrl(getWsBase())), []);

  const feedSrc = useMemo(() => {
    if (!mockFeedEnabled) return src;

    const normalized = src.toLowerCase();

    if (normalized.includes("ir") || normalized.includes("thermal")) return "mock_ir";
    if (normalized.includes("zoom")) return "mock_zoom";

    return "mock_wide";
  }, [mockFeedEnabled, src]);

  const host = useMemo(() => {
    return hostFromTelemetryWs(telemetryWsUrl);
  }, [telemetryWsUrl]);

  const uri = useMemo(() => {
    return `http://${host}:8000/video/frame?src=${feedSrc}&_t=${feedSrc}`;
  }, [host, feedSrc]);

  const webRtcHtml = useMemo(() => {
    return makeWebRtcHtml(host, src);
  }, [host, src]);

  if (!mockFeedEnabled) {
    return (
      <View pointerEvents="none" style={[styles.realFeedPlaceholder, style]}>
        {!paused ? (
          <WebView
            key={`${host}-${src}`}
            source={{ html: webRtcHtml, baseUrl: `http://${host}:1984` }}
            style={styles.frame}
            containerStyle={styles.webViewContainer}
            scrollEnabled={false}
            javaScriptEnabled
            domStorageEnabled
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            mixedContentMode="always"
            originWhitelist={["*"]}
            setSupportMultipleWindows={false}
            androidLayerType="hardware"
            overScrollMode="never"
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            onError={(ev) =>
              console.warn("go2rtc custom WebView error", ev.nativeEvent.description)
            }
            onHttpError={(ev) =>
              console.warn("go2rtc custom WebView HTTP", ev.nativeEvent.statusCode)
            }
          />
        ) : null}
      </View>
    );
  }

  return (
    <View pointerEvents="none" style={[styles.realFeedPlaceholder, style]}>
      <Image
        source={{ uri }}
        style={styles.frame}
        contentFit={contentFit}
        transition={0}
        cachePolicy="none"
      />
    </View>
  );
}

function makeWebRtcHtml(host: string, src: string) {
  const safeSrc = src || "dji";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">

  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
    }

    * {
      box-sizing: border-box;
    }

    video {
      position: fixed;
      inset: 0;
      display: block;
      width: 100vw;
      height: 100vh;
      object-fit: cover;
      background: #000;
    }
  </style>
</head>

<body>
  <video id="video" autoplay muted playsinline webkit-playsinline></video>

  <script>
    async function start() {
      const video = document.getElementById("video");

      const pc = new RTCPeerConnection();

      pc.addTransceiver("video", {
        direction: "recvonly"
      });

      pc.ontrack = function(event) {
        video.srcObject = event.streams[0];
        video.play().catch(function() {});
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch("http://${host}:1984/api/webrtc?src=${safeSrc}", {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp"
        },
        body: offer.sdp
      });

      const answer = await response.text();

      await pc.setRemoteDescription({
        type: "answer",
        sdp: answer
      });
    }

    start().catch(function(error) {
      document.body.innerHTML =
        "<pre style='color:white;background:black;font-size:11px;white-space:pre-wrap;margin:0;padding:8px'>" +
        error +
        "</pre>";
    });
  </script>
</body>
</html>
`;
}

function hostFromTelemetryWs(wsUrl: string) {
  try {
    return new URL(wsUrl).hostname;
  } catch {
    return wsUrl
      .replace(/^wss?:\/\//i, "")
      .replace(/\/.*$/, "")
      .split(":")[0];
  }
}

const styles = StyleSheet.create({
  realFeedPlaceholder: {
    flex: 1,
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: "#000",
  },

  webViewContainer: {
    flex: 1,
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: "#000",
  },

  frame: {
    flex: 1,
    width: "100%",
    height: "100%",
    overflow: "hidden",
    backgroundColor: "#000",
  },
});