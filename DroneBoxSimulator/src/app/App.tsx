import { useEffect, useRef, useState } from 'react';
import { defaultZephyrWsUrl, ZephyrBridge } from '../api/zephyrBridge';
import { KeyboardInputMapper } from '../hardware/inputMapper';
import { DroneScene } from '../scene/DroneScene';
import { quaternionFromAttitude } from '../sim/math3d';
import type { CameraMode, CameraSensorMode, DroneState, SimulatorCommand, TelemetryMessage, WorldTrailPoint } from '../sim/types';
import { ViewerPage } from '../mobile/ViewerPage';
import { ModePanel } from '../ui/ModePanel';
import { TelemetryPanel } from '../ui/TelemetryPanel';
import bgVideo from '../ui/bg.mp4';

type WorkerMessage = {
  state: DroneState;
  telemetry: TelemetryMessage;
};

type AppMode = 'HOME' | 'DRONEBOX' | 'ZEPHYR';
type HomeView = 'MAIN' | 'INFO';

const lerp = (from: number, to: number, alpha: number) => from + (to - from) * alpha;
const angleDelta = (target: number, current: number) =>
  Math.atan2(Math.sin(target - current), Math.cos(target - current));
const lerpAngle = (from: number, to: number, alpha: number) =>
  from + angleDelta(to, from) * alpha;

const smoothVec3 = (
  from: DroneState['position'],
  to: DroneState['position'],
  alpha: number
) => ({
  x: lerp(from.x, to.x, alpha),
  y: lerp(from.y, to.y, alpha),
  z: lerp(from.z, to.z, alpha)
});

const smoothZephyrState = (
  current: DroneState,
  target: DroneState,
  dt: number,
  targetAge: number
): DroneState => {
  const predictionSeconds = Math.min(targetAge, 0.34);
  const predictedPosition = {
    x: target.position.x + target.velocity.x * predictionSeconds,
    y: target.position.y + target.velocity.y * predictionSeconds,
    z: target.position.z + target.velocity.z * predictionSeconds
  };
  const positionAlpha = 1 - Math.exp(-dt * 7.5);
  const velocityAlpha = 1 - Math.exp(-dt * 9);
  const attitudeAlpha = 1 - Math.exp(-dt * 8);
  const attitude = {
    pitch: lerpAngle(current.attitude.pitch, target.attitude.pitch, attitudeAlpha),
    roll: lerpAngle(current.attitude.roll, target.attitude.roll, attitudeAlpha),
    yaw: lerpAngle(current.attitude.yaw, target.attitude.yaw, attitudeAlpha)
  };
  const position = smoothVec3(current.position, predictedPosition, positionAlpha);
  const velocity = smoothVec3(current.velocity, target.velocity, velocityAlpha);

  return {
    ...target,
    position,
    velocity,
    attitude,
    orientation: quaternionFromAttitude(attitude),
    sensors: {
      ...target.sensors,
      gpsPosition: position,
      baroAltitude: position.y,
      estimatedAttitude: attitude
    },
    battery: lerp(current.battery, target.battery, 1 - Math.exp(-dt * 4))
  };
};

export const App = () => {
  const isViewerRoute = window.location.pathname === '/viewer';
  const [appMode, setAppMode] = useState<AppMode>('HOME');
  const [homeView, setHomeView] = useState<HomeView>('MAIN');
  const [state, setState] = useState<DroneState | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>('ORBIT');
  const [cameraSensorMode, setCameraSensorMode] = useState<CameraSensorMode>('WIDE');
  const [fpvZoom, setFpvZoom] = useState(1);
  const [zephyrStatus, setZephyrStatus] = useState('Ready');
  const [zephyrProduct, setZephyrProduct] = useState('Zephyr');
  const [zephyrMission, setZephyrMission] = useState('READY');
  const [trail, setTrail] = useState<WorldTrailPoint[]>([]);
  const [ps4Enabled, setPs4Enabled] = useState(false);
  const [grassEnabled, setGrassEnabled] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const zephyrRef = useRef<ZephyrBridge | null>(null);
  const stateRef = useRef<DroneState | null>(null);
  const zephyrTargetRef = useRef<DroneState | null>(null);
  const zephyrTargetTimeRef = useRef(0);
  const ps4EnabledRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    ps4EnabledRef.current = ps4Enabled;
  }, [ps4Enabled]);

  useEffect(() => {
    if (appMode !== 'DRONEBOX') {
      return;
    }

    const worker = new Worker(new URL('../workers/sim.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      setState(event.data.state);
    };

    const mapper = new KeyboardInputMapper({
      onInput: (nextInput) => worker.postMessage({ type: 'rc', ...nextInput }),
      onCommand: (command) => worker.postMessage(command),
      isGamepadEnabled: () => ps4EnabledRef.current,
      canToggleArmWithGamepad: () => {
        const current = stateRef.current;
        return Boolean(
          current &&
          current.position.y <= 0.06 &&
          Math.abs(current.velocity.y) < 0.22
        );
      }
    });
    mapper.start();

    return () => {
      mapper.stop();
      worker.terminate();
      workerRef.current = null;
    };
  }, [appMode]);

  useEffect(() => {
    if (appMode !== 'ZEPHYR') {
      return;
    }

    let animationFrame = 0;
    let lastTime = performance.now();
    const tick = () => {
      const now = performance.now();
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const target = zephyrTargetRef.current;
      if (target) {
        const targetAge = Math.max(0, (now - zephyrTargetTimeRef.current) / 1000);
        setState((current) => current ? smoothZephyrState(current, target, dt, targetAge) : target);
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationFrame);
    };
  }, [appMode]);

  useEffect(() => {
    return () => {
      zephyrRef.current?.disconnect();
      workerRef.current?.terminate();
    };
  }, []);

  if (isViewerRoute) {
    return <ViewerPage />;
  }

  const sendCommand = (command: SimulatorCommand) => {
    if (appMode === 'ZEPHYR') {
      zephyrRef.current?.sendSimulatorCommand(command);
      return;
    }

    workerRef.current?.postMessage(command);
  };

  const resetSession = () => {
    workerRef.current?.terminate();
    workerRef.current = null;
    zephyrRef.current?.disconnect();
    zephyrRef.current = null;
    zephyrTargetRef.current = null;
    zephyrTargetTimeRef.current = 0;
    setTrail([]);
    setState(null);
    setCameraMode('ORBIT');
    setCameraSensorMode('WIDE');
    setFpvZoom(1);
  };

  const startDroneBox = () => {
    resetSession();
    setHomeView('MAIN');
    setAppMode('DRONEBOX');
  };

  const startZephyr = () => {
    resetSession();
    setHomeView('MAIN');
    setAppMode('ZEPHYR');

    const bridge = new ZephyrBridge(
      defaultZephyrWsUrl(),
      (frame) => {
        zephyrTargetRef.current = frame.state;
        zephyrTargetTimeRef.current = performance.now();
        if (!stateRef.current) {
          setState(frame.state);
        }
        setTrail(frame.trail);
        setZephyrProduct(frame.productName);
        setZephyrMission(frame.missionState);
        setZephyrStatus(frame.connected ? 'Live' : 'Waiting');
      },
      setZephyrStatus
    );
    zephyrRef.current = bridge;
    bridge.connect();
  };

  const returnHome = () => {
    resetSession();
    setHomeView('MAIN');
    setAppMode('HOME');
  };

  if (appMode === 'HOME') {
    return (
      <main className="startScreen">
        <video className="startVideo" src={bgVideo} autoPlay muted loop playsInline />
        <div className="startShade" />
        <header className="startNav">
          <strong>DroneBox</strong>
          <button onClick={() => setHomeView(homeView === 'INFO' ? 'MAIN' : 'INFO')}>
            {homeView === 'INFO' ? 'Home' : 'Informazioni'}
          </button>
        </header>

        {homeView === 'MAIN' ? (
          <section className="startPanel heroPanel">
            <p className="startLabel">Flight simulator</p>
            <h1>DroneBox Simulator</h1>
            <p className="startCopy">
              Simulazione FPV e orbitale per testare controllo, PID, camere e procedure di volo in un ambiente 3D leggero.
            </p>
            <div className="startActions">
              <button className="startButton primary" onClick={startDroneBox}>
                <span>Avvia DroneBox</span>
                <small>Sim locale</small>
              </button>
              <button className="startButton" onClick={startZephyr}>
                <span>Collega Zephyr</span>
                <small>Bridge live</small>
              </button>
              <button className="startButton ghost" onClick={() => setHomeView('INFO')}>
                <span>Informazioni</span>
                <small>Caratteristiche</small>
              </button>
            </div>
          </section>
        ) : (
          <section className="startPanel infoPanel">
            <p className="startLabel">Informazioni</p>
            <h1>Un banco prova per il volo virtuale</h1>
            <p>
              DroneBox Simulator è un simulatore 3D per provare comportamento del drone, controlli manuali,
              sequenze di takeoff e landing, RTH, camera FPV con gimbal, sensori wide/zoom/IR e telemetria in tempo reale.
            </p>
            <div className="infoGrid">
              <article>
                <strong>Fisica di volo</strong>
                <span>Motori, inerzia, drag, ground effect, batteria e controllo verticale con profili morbidi.</span>
              </article>
              <article>
                <strong>Camera e missione</strong>
                <span>Vista orbitale, FPV stabilizzata, zoom fino a 56x, simulazione IR white hot e trail di volo.</span>
              </article>
              <article>
                <strong>Integrazione</strong>
                <span>Input da tastiera o controller, telemetria live e modalita bridge per collegarsi alla pipeline Zephyr.</span>
              </article>
            </div>
            <p className="projectNote">
              È un progetto parallelo a ZephyrDrone: nasce per sperimentare e validare idee di controllo,
              interfaccia e simulazione senza bloccare lo sviluppo principale.
            </p>
            <div className="startActions compactActions">
              <button className="startButton primary" onClick={startDroneBox}>Avvia DroneBox</button>
              <button className="startButton" onClick={() => setHomeView('MAIN')}>Torna alla home</button>
            </div>
          </section>
        )}
      </main>
    );
  }

  const isZephyr = appMode === 'ZEPHYR';

  return (
    <main className="appShell">
      <DroneScene
        state={state}
        cameraMode={cameraMode}
        cameraSensorMode={cameraSensorMode}
        fpvZoom={fpvZoom}
        grassEnabled={grassEnabled}
      />

      <header className="topBar">
        <div>
          <h1>{isZephyr ? zephyrProduct : 'DroneBox'}</h1>
          <p>{isZephyr ? `${zephyrStatus} / ${zephyrMission}` : ps4Enabled ? 'PS4' : 'Keyboard'}</p>
        </div>
        <span className={state?.armed ? 'statusPill armed' : 'statusPill'}>{state?.armed ? 'ARMED' : 'SAFE'}</span>
        <div className="cameraSelector">
          <button className={cameraMode === 'ORBIT' ? 'active' : ''} onClick={() => setCameraMode('ORBIT')}>Orbit</button>
          <button className={cameraMode === 'FPV' ? 'active' : ''} onClick={() => setCameraMode('FPV')}>FPV</button>
        </div>
        <button className="serialButton" onClick={returnHome}>Main</button>
      </header>

      <TelemetryPanel state={state} />

      <aside className="rightDock">
        {cameraMode === 'FPV' && (
          <section className="fpvSensorPanel">
            <div className="panelHeader compact">
              <div>
                <span>FPV</span>
                <strong>Sensor</strong>
              </div>
              <small>{cameraSensorMode === 'ZOOM' ? `${fpvZoom.toFixed(0)}x` : cameraSensorMode}</small>
            </div>
            <div className="sensorGrid">
              <button className={cameraSensorMode === 'WIDE' ? 'active' : ''} onClick={() => setCameraSensorMode('WIDE')}>Wide</button>
              <button className={cameraSensorMode === 'ZOOM' ? 'active' : ''} onClick={() => setCameraSensorMode('ZOOM')}>Zoom</button>
              <button className={cameraSensorMode === 'IR' ? 'active' : ''} onClick={() => setCameraSensorMode('IR')}>IR</button>
            </div>
            {cameraSensorMode === 'ZOOM' && (
              <label className="zoomControl">
                <span>Zoom {fpvZoom.toFixed(0)}x</span>
                <input
                  type="range"
                  min="1"
                  max="56"
                  step="1"
                  value={fpvZoom}
                  onChange={(event) => setFpvZoom(Number(event.target.value))}
                />
              </label>
            )}
          </section>
        )}
        <ModePanel state={state} onCommand={sendCommand} />
        {!isZephyr && (
          <>
            <label className="ps4Toggle">
              <input type="checkbox" checked={grassEnabled} onChange={(event) => setGrassEnabled(event.target.checked)} />
              <span>Erba / carico GPU</span>
            </label>
            <label className="ps4Toggle">
              <input type="checkbox" checked={ps4Enabled} onChange={(event) => setPs4Enabled(event.target.checked)} />
              <span>PS4 controller</span>
            </label>
          </>
        )}
      </aside>
    </main>
  );
};
