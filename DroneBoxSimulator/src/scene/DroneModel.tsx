import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { DroneState } from '../sim/types';

const MAVIC_MODEL_URL = new URL('./DroneNormalizzato.glb', import.meta.url).href;
const TARGET_DRONE_SPAN_M = 0.55;
const PROPELLER_NODE_NAMES = [
  'ElicaDietroSinistra',
  'ElicaDietroDestra',
  'ElicaDavantiDestra',
  'ElicaDavantiSinistra'
] as const;
const PROPELLER_GHOST_RPM_START = 1400;
const PROPELLER_GHOST_RPM_FULL = 7200;

export class DroneModel {
  readonly group = new THREE.Group();
  private readonly propellers: THREE.Object3D[] = [];
  private readonly propellerGhosts: Array<{ host: THREE.Object3D; ghosts: THREE.Object3D[] } | null> = [];
  private readonly fallbackFrame = new THREE.Group();
  private readonly fallbackPropellers = new THREE.Group();
  private loadedModel: THREE.Object3D | null = null;

  constructor() {
    this.group.name = 'DronePhysicsRoot';
    this.createFallbackModel();
    this.fallbackFrame.visible = false;
    this.fallbackPropellers.visible = false;
    this.loadModel();
  }

  update(state: DroneState, dt: number) {
    this.group.position.set(state.position.x, state.position.y, state.position.z);
    this.group.quaternion.set(state.orientation.x, state.orientation.y, state.orientation.z, state.orientation.w);

    state.motorRpms.forEach((rpm, index) => {
      const propeller = this.propellers[index];
      if (!propeller) {
        return;
      }

      const spin = (rpm / 60) * (propeller.userData.spinDirection ?? 1) * dt * Math.PI * 2;
      propeller.rotateY(spin);
      this.updatePropellerGhosts(propeller, rpm, index);
    });
  }

  dispose() {
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
  }

  private createFallbackModel() {
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#d7eef8', metalness: 0.35, roughness: 0.32 });
    const armMaterial = new THREE.MeshStandardMaterial({ color: '#18242e', metalness: 0.2, roughness: 0.45 });
    const propMaterial = new THREE.MeshStandardMaterial({ color: '#44e0b7', transparent: true, opacity: 0.7 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.18), bodyMaterial);
    body.castShadow = true;
    this.fallbackFrame.add(body);

    const armGeometry = new THREE.BoxGeometry(0.42, 0.025, 0.035);
    const armA = new THREE.Mesh(armGeometry, armMaterial);
    armA.rotation.y = Math.PI / 4;
    const armB = new THREE.Mesh(armGeometry, armMaterial);
    armB.rotation.y = -Math.PI / 4;
    this.fallbackFrame.add(armA, armB);

    const motorGeometry = new THREE.CylinderGeometry(0.045, 0.045, 0.04, 24);
    const propGeometry = new THREE.BoxGeometry(0.24, 0.006, 0.025);
    const motorPositions = [
      [-0.19, 0, 0.19],
      [0.19, 0, 0.19],
      [0.19, 0, -0.19],
      [-0.19, 0, -0.19]
    ] as const;

    motorPositions.forEach(([x, y, z], index) => {
      const motor = new THREE.Mesh(motorGeometry, armMaterial);
      motor.position.set(x, y, z);
      motor.castShadow = true;

      const propeller = new THREE.Mesh(propGeometry, propMaterial);
      propeller.position.set(x, y + 0.035, z);
      propeller.userData.spinDirection = index % 2 === 0 ? 1 : -1;
      this.propellers.push(propeller);
      this.fallbackFrame.add(motor);
      this.fallbackPropellers.add(propeller);
    });

    this.group.add(this.fallbackFrame, this.fallbackPropellers);
  }

  private loadModel() {
    const loader = new GLTFLoader();

    loader.load(
      MAVIC_MODEL_URL,
      (gltf) => {
        const model = gltf.scene;
        model.name = 'DjiMavic3Glb';
        this.prepareLoadedModel(model);

        this.loadedModel = model;
        this.group.add(model);
        this.fallbackFrame.visible = false;

        const loadedPropellers = this.findNamedPropellers(model) ?? this.findPropellerPivots(model);
        if (loadedPropellers.length >= 4) {
          this.clearPropellerGhosts();
          this.propellers.splice(0, this.propellers.length, ...loadedPropellers.slice(0, 4));
          this.fallbackPropellers.visible = false;
        }
      },
      undefined,
      (error) => {
        console.warn('Drone GLB could not be loaded; using procedural fallback.', error);
        this.fallbackFrame.visible = true;
        this.fallbackPropellers.visible = true;
      }
    );
  }

  private findNamedPropellers(model: THREE.Object3D): THREE.Object3D[] | null {
    const propellers = PROPELLER_NODE_NAMES.map((name, index) => {
      const propeller = model.getObjectByName(name);
      if (propeller) {
        propeller.userData.spinDirection = index % 2 === 0 ? 1 : -1;
      }
      return propeller;
    });

    return propellers.every(Boolean) ? (propellers as THREE.Object3D[]) : null;
  }

  private prepareLoadedModel(model: THREE.Object3D) {
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });

    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const horizontalSpan = Math.max(size.x, size.z);
    const scale = Number.isFinite(horizontalSpan) && horizontalSpan > 0 ? TARGET_DRONE_SPAN_M / horizontalSpan : 1;

    model.scale.setScalar(scale);
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  }

  private findPropellerPivots(model: THREE.Object3D): THREE.Object3D[] {
    model.updateWorldMatrix(true, true);

    const candidates: Array<{ mesh: THREE.Mesh; center: THREE.Vector3; score: number }> = [];
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      const box = new THREE.Box3().setFromObject(object);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const horizontalLength = Math.max(size.x, size.z);
      const horizontalWidth = Math.min(size.x, size.z);
      const radius = Math.hypot(center.x - this.group.position.x, center.z - this.group.position.z);

      // Real propellers are usually thin, elongated meshes near the four outer corners.
      const isThin = size.y < 0.045;
      const isBladeLike = horizontalLength > 0.06 && horizontalLength / Math.max(horizontalWidth, 0.005) > 2.4;
      const isOutboard = radius > 0.12;
      if (isThin && isBladeLike && isOutboard) {
        candidates.push({ mesh: object, center, score: radius + horizontalLength - size.y });
      }
    });

    const selected = candidates
      .sort((a, b) => b.score - a.score)
      .filter((candidate, index, all) => {
        const firstAtCorner = all.findIndex((other) => candidate.center.distanceTo(other.center) < 0.08);
        return firstAtCorner === index;
      })
      .slice(0, 4);

    return selected.map(({ mesh, center }, index) => this.wrapMeshWithPivot(mesh, center, index));
  }

  private wrapMeshWithPivot(mesh: THREE.Mesh, worldCenter: THREE.Vector3, index: number) {
    const parent = mesh.parent;
    const pivot = new THREE.Object3D();
    pivot.name = `DetectedPropellerPivot_${index + 1}`;
    pivot.userData.spinDirection = index % 2 === 0 ? 1 : -1;

    if (!parent) {
      return mesh;
    }

    parent.add(pivot);
    pivot.position.copy(parent.worldToLocal(worldCenter.clone()));
    pivot.attach(mesh);
    return pivot;
  }

  private updatePropellerGhosts(propeller: THREE.Object3D, rpm: number, index: number) {
    const ghostSet = this.ensurePropellerGhosts(propeller, index);
    const amount = THREE.MathUtils.smoothstep(rpm, PROPELLER_GHOST_RPM_START, PROPELLER_GHOST_RPM_FULL);
    const spinDirection = propeller.userData.spinDirection ?? 1;
    const offsets = [-0.18, 0.18];

    ghostSet.forEach((ghost, ghostIndex) => {
      ghost.visible = amount > 0.02;
      ghost.position.copy(propeller.position);
      ghost.quaternion.copy(propeller.quaternion);
      ghost.scale.copy(propeller.scale);
      ghost.rotateY(offsets[ghostIndex] * spinDirection);
      ghost.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) {
          return;
        }

        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => {
          material.opacity = amount * 0.22;
        });
      });
    });
  }

  private ensurePropellerGhosts(propeller: THREE.Object3D, index: number) {
    const existing = this.propellerGhosts[index];
    if (existing?.host === propeller) {
      return existing.ghosts;
    }

    existing?.ghosts.forEach((ghost) => ghost.removeFromParent());
    const parent = propeller.parent;
    if (!parent) {
      this.propellerGhosts[index] = { host: propeller, ghosts: [] };
      return [];
    }

    const ghosts = [-1, 1].map(() => {
      const ghost = propeller.clone(true);
      ghost.name = `${propeller.name || 'Propeller'}_MotionGhost`;
      ghost.visible = false;
      ghost.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) {
          return;
        }

        object.castShadow = false;
        object.receiveShadow = false;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const ghostMaterials = materials.map((material) => {
          const clone = material.clone();
          clone.transparent = true;
          clone.opacity = 0;
          clone.depthWrite = false;
          return clone;
        });
        object.material = Array.isArray(object.material) ? ghostMaterials : ghostMaterials[0];
      });
      parent.add(ghost);
      return ghost;
    });

    this.propellerGhosts[index] = { host: propeller, ghosts };
    return ghosts;
  }

  private clearPropellerGhosts() {
    this.propellerGhosts.forEach((entry) => {
      entry?.ghosts.forEach((ghost) => ghost.removeFromParent());
    });
    this.propellerGhosts.splice(0, this.propellerGhosts.length);
  }
}
