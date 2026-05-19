import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CameraRig } from './CameraRig';
import { DroneModel } from './DroneModel';
import { createEnvironment } from './Environment';
import type { CameraMode, CameraSensorMode, DroneState } from '../sim/types';

type DroneSceneProps = {
  state: DroneState | null;
  cameraMode: CameraMode;
  cameraSensorMode: CameraSensorMode;
  fpvZoom: number;
  grassEnabled: boolean;
};

export const DroneScene = ({ state, cameraMode, cameraSensorMode, fpvZoom, grassEnabled }: DroneSceneProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<DroneState | null>(state);
  const cameraModeRef = useRef(cameraMode);
  const cameraSensorModeRef = useRef(cameraSensorMode);
  const fpvZoomRef = useRef(fpvZoom);
  const grassEnabledRef = useRef(grassEnabled);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    cameraModeRef.current = cameraMode;
  }, [cameraMode]);

  useEffect(() => {
    cameraSensorModeRef.current = cameraSensorMode;
  }, [cameraSensorMode]);

  useEffect(() => {
    fpvZoomRef.current = fpvZoom;
  }, [fpvZoom]);

  useEffect(() => {
    grassEnabledRef.current = grassEnabled;
  }, [grassEnabled]);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const container = containerRef.current;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(72, container.clientWidth / container.clientHeight, 0.03, 900);
    camera.position.set(2.2, 1.25, 2.6);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const environment = createEnvironment(scene, { grassEnabled: grassEnabledRef.current });
    const drone = new DroneModel();
    scene.add(drone.group);
    const controls = new OrbitControls(camera, renderer.domElement);
    const cameraRig = new CameraRig(camera, controls);
    const clock = new THREE.Clock();

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener('resize', resize);

    let frame = 0;
    const render = () => {
      const dt = clock.getDelta();
      const elapsed = clock.elapsedTime;
      environment.setThermalMode(
        cameraModeRef.current === 'FPV' && cameraSensorModeRef.current === 'IR'
      );
      environment.setGrassEnabled(grassEnabledRef.current);
      environment.update(elapsed);
      const latestState = stateRef.current;
      if (latestState) {
        drone.update(latestState, dt);
        cameraRig.update(
          latestState,
          cameraModeRef.current,
          cameraSensorModeRef.current,
          fpvZoomRef.current,
          dt
        );
      }

      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      cameraRig.dispose();
      environment.dispose();
      drone.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  const sceneClassName = [
    'scene',
    cameraMode === 'FPV' && cameraSensorMode === 'IR' ? 'irScene' : '',
    cameraMode === 'FPV' && cameraSensorMode === 'ZOOM' && fpvZoom >= 18 ? 'zoomScene' : '',
    cameraMode === 'FPV' && cameraSensorMode === 'ZOOM' && fpvZoom >= 38 ? 'deepZoomScene' : ''
  ].filter(Boolean).join(' ');
  return <div className={sceneClassName} ref={containerRef} />;
};
