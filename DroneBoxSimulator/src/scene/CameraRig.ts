import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraMode, CameraSensorMode, DroneState } from '../sim/types';

const ORBIT_CAMERA_TUNING = {
  distance: 2.75,
  height: 1.15,
  yaw: Math.PI * 0.72
} as const;

export const FPV_CAMERA_TUNING = {
  right: 0,
  height: 0.05,
  forward: -0.22,
  fov: 70,
  near: 0.03,
  far: 900,
  gimbalStartSpeed: THREE.MathUtils.degToRad(24),
  gimbalMaxSpeed: THREE.MathUtils.degToRad(115),
  gimbalAcceleration: THREE.MathUtils.degToRad(180),
  minGimbalPitch: THREE.MathUtils.degToRad(-80),
  maxGimbalPitch: THREE.MathUtils.degToRad(30),
  minGimbalYaw: THREE.MathUtils.degToRad(-70),
  maxGimbalYaw: THREE.MathUtils.degToRad(70),
  maxOpticalZoom: 56
} as const;

export class CameraRig {
  private readonly worldUp = new THREE.Vector3(0, 1, 0);
  private readonly fpvOffset = new THREE.Vector3();
  private readonly droneQuaternion = new THREE.Quaternion();
  private readonly droneYawQuaternion = new THREE.Quaternion();
  private readonly gimbalQuaternion = new THREE.Quaternion();
  private readonly fpvPosition = new THREE.Vector3();
  private readonly fpvLookDirection = new THREE.Vector3();
  private readonly fpvLookTarget = new THREE.Vector3();
  private readonly pressedKeys = new Set<string>();
  private cameraMode: CameraMode = 'ORBIT';
  private gimbalPitch = 0;
  private gimbalYaw = 0;
  private gimbalPitchRate = 0;
  private gimbalYawRate = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controls: OrbitControls
  ) {
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;
    this.controls.screenSpacePanning = false;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 65;
    this.controls.minPolarAngle = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.target.set(0, 0.2, 0);
    this.camera.up.copy(this.worldUp);
    window.addEventListener('keydown', this.handleGimbalKeyDown);
    window.addEventListener('keyup', this.handleGimbalKeyUp);
  }

  update(state: DroneState, mode: CameraMode, sensorMode: CameraSensorMode, zoom = 1, dt = 1 / 60) {
    const dronePosition = new THREE.Vector3(state.position.x, state.position.y, state.position.z);
    const target = dronePosition.clone().add(new THREE.Vector3(0, 0.18, 0));

    if (mode !== this.cameraMode) {
      this.cameraMode = mode;
      this.controls.enabled = mode === 'ORBIT';
      if (mode === 'ORBIT') {
        this.resetOrbitCamera(target);
      }
    }

    if (mode === 'FPV') {
      this.updateFpvCamera(state, dronePosition, sensorMode, zoom, dt);
      return;
    }

    this.camera.up.copy(this.worldUp);
    this.controls.enabled = true;
    const targetDelta = target.clone().sub(this.controls.target);
    this.controls.target.copy(target);
    this.camera.position.add(targetDelta);
    this.controls.update();
  }

  dispose() {
    window.removeEventListener('keydown', this.handleGimbalKeyDown);
    window.removeEventListener('keyup', this.handleGimbalKeyUp);
    this.controls.dispose();
  }

  private updateFpvCamera(
    state: DroneState,
    dronePosition: THREE.Vector3,
    sensorMode: CameraSensorMode,
    zoom: number,
    dt: number
  ) {
    this.controls.enabled = false;
    const opticalZoom = sensorMode === 'ZOOM'
      ? THREE.MathUtils.clamp(zoom, 1, FPV_CAMERA_TUNING.maxOpticalZoom)
      : 1;
    this.updateGimbalInput(dt, opticalZoom);
    this.droneQuaternion.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w);
    this.fpvOffset.set(FPV_CAMERA_TUNING.right, FPV_CAMERA_TUNING.height, FPV_CAMERA_TUNING.forward);

    this.fpvPosition.copy(this.fpvOffset).applyQuaternion(this.droneQuaternion).add(dronePosition);
    this.gimbalQuaternion.setFromEuler(new THREE.Euler(this.gimbalPitch, this.gimbalYaw, 0, 'YXZ'));
    this.droneYawQuaternion.setFromAxisAngle(this.worldUp, state.attitude.yaw);
    this.fpvLookDirection.set(0, 0, -1).applyQuaternion(this.gimbalQuaternion).applyQuaternion(this.droneYawQuaternion).normalize();
    this.fpvLookTarget.copy(this.fpvPosition).add(this.fpvLookDirection);

    this.camera.fov = THREE.MathUtils.clamp(FPV_CAMERA_TUNING.fov / opticalZoom, 1.5, FPV_CAMERA_TUNING.fov);
    this.camera.near = FPV_CAMERA_TUNING.near;
    this.camera.far = FPV_CAMERA_TUNING.far;
    this.camera.up.copy(this.worldUp);
    this.camera.position.copy(this.fpvPosition);
    this.camera.lookAt(this.fpvLookTarget);
    this.camera.updateProjectionMatrix();
  }

  private resetOrbitCamera(target: THREE.Vector3) {
    this.camera.fov = 72;
    this.camera.near = 0.03;
    this.camera.far = 900;
    this.camera.up.copy(this.worldUp);
    this.controls.target.copy(target);
    this.camera.position.set(
      target.x + Math.sin(ORBIT_CAMERA_TUNING.yaw) * ORBIT_CAMERA_TUNING.distance,
      target.y + ORBIT_CAMERA_TUNING.height,
      target.z + Math.cos(ORBIT_CAMERA_TUNING.yaw) * ORBIT_CAMERA_TUNING.distance
    );
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private updateGimbalInput(dt: number, opticalZoom: number) {
    const pitchInput = (this.pressedKeys.has('ArrowUp') ? 1 : 0) + (this.pressedKeys.has('ArrowDown') ? -1 : 0);
    const yawInput = (this.pressedKeys.has('ArrowLeft') ? 1 : 0) + (this.pressedKeys.has('ArrowRight') ? -1 : 0);
    const zoomSlowdown = 1 / Math.sqrt(Math.max(1, opticalZoom));
    const scaledDt = dt * zoomSlowdown;

    this.gimbalPitchRate = this.updateGimbalRate(this.gimbalPitchRate, pitchInput, scaledDt);
    this.gimbalYawRate = this.updateGimbalRate(this.gimbalYawRate, yawInput, scaledDt);

    this.gimbalPitch = THREE.MathUtils.clamp(
      this.gimbalPitch + this.gimbalPitchRate * scaledDt,
      FPV_CAMERA_TUNING.minGimbalPitch,
      FPV_CAMERA_TUNING.maxGimbalPitch
    );
    this.gimbalYaw = THREE.MathUtils.clamp(
      this.gimbalYaw + this.gimbalYawRate * scaledDt,
      FPV_CAMERA_TUNING.minGimbalYaw,
      FPV_CAMERA_TUNING.maxGimbalYaw
    );

    if (
      this.gimbalPitch === FPV_CAMERA_TUNING.minGimbalPitch ||
      this.gimbalPitch === FPV_CAMERA_TUNING.maxGimbalPitch
    ) {
      this.gimbalPitchRate = 0;
    }
    if (
      this.gimbalYaw === FPV_CAMERA_TUNING.minGimbalYaw ||
      this.gimbalYaw === FPV_CAMERA_TUNING.maxGimbalYaw
    ) {
      this.gimbalYawRate = 0;
    }
  }

  private updateGimbalRate(currentRate: number, input: number, dt: number) {
    if (input === 0) {
      return 0;
    }

    const signedStartSpeed = input * FPV_CAMERA_TUNING.gimbalStartSpeed;
    const acceleratedRate = currentRate + input * FPV_CAMERA_TUNING.gimbalAcceleration * dt;
    const sameDirectionRate = Math.sign(acceleratedRate) === input ? acceleratedRate : signedStartSpeed;
    const rate = Math.abs(sameDirectionRate) < FPV_CAMERA_TUNING.gimbalStartSpeed ? signedStartSpeed : sameDirectionRate;

    return THREE.MathUtils.clamp(rate, -FPV_CAMERA_TUNING.gimbalMaxSpeed, FPV_CAMERA_TUNING.gimbalMaxSpeed);
  }

  private handleGimbalKeyDown = (event: KeyboardEvent) => {
    if (this.cameraMode !== 'FPV') {
      return;
    }

    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      return;
    }

    event.preventDefault();
    this.pressedKeys.add(event.code);
  };

  private handleGimbalKeyUp = (event: KeyboardEvent) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
      return;
    }

    event.preventDefault();
    this.pressedKeys.delete(event.code);
  };
}
