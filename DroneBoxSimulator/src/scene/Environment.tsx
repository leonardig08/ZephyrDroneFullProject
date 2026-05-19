import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGrassField } from './GrassField';

const houseAsset = new URL('./house_game_ready.glb', import.meta.url).href;
const pineAsset = new URL('./pine_tree_game-ready.glb', import.meta.url).href;
const vanAsset = new URL('./apocalyptic_old_van__driveable_with_interior.glb', import.meta.url).href;
const grassBaseColor = new URL('./textures/grass/2K/Poliigon_GrassPatchyGround_4585_BaseColor.jpg', import.meta.url).href;
const grassNormal = new URL('./textures/grass/2K/Poliigon_GrassPatchyGround_4585_Normal.png', import.meta.url).href;
const grassRoughness = new URL('./textures/grass/2K/Poliigon_GrassPatchyGround_4585_Roughness.jpg', import.meta.url).href;
const grassAo = new URL('./textures/grass/2K/Poliigon_GrassPatchyGround_4585_AmbientOcclusion.jpg', import.meta.url).href;
const WORLD_SIZE_M = 620;

/**
 * World convention:
 * 1 Three.js unit = 1 real meter.
 *
 * Typical reference sizes:
 * - DJI Mavic 3T visual span: ~0.55 m including props
 * - van height: ~2.1 m
 * - small one/two-floor house: ~5.8-7.2 m
 * - pine tree: ~10-18 m
 * - grass clump: ~0.25-0.65 m
 */

type ModelPlacement = {
  x: number;
  z: number;
  rotation?: number;

  /**
   * Preferred for real-world scale. The model will be normalized to this height in meters.
   */
  heightM?: number;

  /**
   * Fallback/manual scale for assets that should not be normalized.
   */
  scale?: number;
};

type ThermalMaterial = THREE.Material | THREE.Material[];
type GrassField = ReturnType<typeof createGrassField>;

const configureGroundTexture = (texture: THREE.Texture, repeat = 64) => {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  return texture;
};

const configureColorTexture = (texture: THREE.Texture, repeat = 64) => {
  texture.colorSpace = THREE.SRGBColorSpace;
  return configureGroundTexture(texture, repeat);
};

const seededRandom = (seed: number) => {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
};

const configureAsset = (object: THREE.Object3D) => {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    child.castShadow = true;
    child.receiveShadow = true;
    child.frustumCulled = true;
  });
};

const getObjectSize = (object: THREE.Object3D) => {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  return { box, size };
};

const placeObjectOnGround = (object: THREE.Object3D) => {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);

  if (!Number.isFinite(box.min.y)) {
    return;
  }

  object.position.y -= box.min.y;
};

/**
 * Normalizes imported GLB assets so that visual sizes are in real meters.
 * This avoids the common problem where one GLB is in centimeters, another in meters,
 * and another in arbitrary Blender units.
 */
const scaleObjectToHeight = (object: THREE.Object3D, targetHeightM: number) => {
  object.scale.setScalar(1);
  object.position.y = 0;

  const { size } = getObjectSize(object);
  if (!Number.isFinite(size.y) || size.y <= 0.0001) {
    return;
  }

  object.scale.setScalar(targetHeightM / size.y);
  placeObjectOnGround(object);
};

const addModelScatter = (
  scene: THREE.Scene,
  loader: GLTFLoader,
  url: string,
  placements: ModelPlacement[],
  onObjectReady?: (object: THREE.Object3D) => void
) => {
  const group = new THREE.Group();
  scene.add(group);

  loader.load(url, (gltf) => {
    configureAsset(gltf.scene);

    placements.forEach((placement) => {
      const clone = gltf.scene.clone(true);

      clone.position.set(placement.x, 0, placement.z);
      clone.rotation.y = placement.rotation ?? 0;

      if (placement.heightM !== undefined) {
        scaleObjectToHeight(clone, placement.heightM);
      } else {
        clone.scale.setScalar(placement.scale ?? 1);
        placeObjectOnGround(clone);
      }

      group.add(clone);
      onObjectReady?.(clone);
    });
  });

  return group;
};

const createProceduralSky = () => {
  const sunDirection = new THREE.Vector3(0.52, 0.62, 0.28).normalize();
  const geometry = new THREE.SphereGeometry(780, 64, 32);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDirection: { value: sunDirection },
      uTopColor: { value: new THREE.Color('#2a88df') },
      uBottomColor: { value: new THREE.Color('#8ed6ff') },
      uHorizonColor: { value: new THREE.Color('#d8f1ff') },
      uCloudTop: { value: new THREE.Color('#ffffff') },
      uCloudMid: { value: new THREE.Color('#e4eaf4') },
      uCloudBottom: { value: new THREE.Color('#aeb8c7') },
      uSunColor: { value: new THREE.Color('#fff1a8') }
    },
    vertexShader: `
      varying vec3 vWorldDirection;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldDirection = normalize(worldPosition.xyz - cameraPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform float uTime;
      uniform vec3 uSunDirection;
      uniform vec3 uTopColor;
      uniform vec3 uBottomColor;
      uniform vec3 uHorizonColor;
      uniform vec3 uCloudTop;
      uniform vec3 uCloudMid;
      uniform vec3 uCloudBottom;
      uniform vec3 uSunColor;
      varying vec3 vWorldDirection;

      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      float fbm(vec2 p) {
        float value = 0.0;
        float amplitude = 0.52;
        mat2 rotate = mat2(0.78, -0.62, 0.62, 0.78);
        for (int i = 0; i < 6; i++) {
          value += valueNoise(p) * amplitude;
          p = rotate * p * 2.04 + 13.7;
          amplitude *= 0.52;
        }
        return value;
      }

      void main() {
        vec3 dir = normalize(vWorldDirection);
        float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
        float dome = pow(up, 0.72);

        vec3 sky = mix(uBottomColor, uTopColor, dome);
        float horizon = exp(-abs(dir.y) * 8.5);
        sky = mix(sky, uHorizonColor, horizon * 0.42);

        vec2 cloudUv = dir.xz / max(0.16, dir.y + 0.34);
        cloudUv *= 1.05;
        vec2 wind = vec2(uTime * 0.012, uTime * -0.004);
        float low = fbm(cloudUv + wind);
        float mid = fbm(cloudUv * 1.85 + wind * 1.7 + vec2(24.2, 7.4));
        float high = fbm(cloudUv * 3.2 + wind * 2.25 + vec2(-8.1, 19.7));

        float mass = low * 0.58 + mid * 0.34 + high * 0.18;
        float cloudMask = smoothstep(0.48, 0.74, mass);
        float cloudCore = smoothstep(0.62, 0.92, mass + mid * 0.14);
        float cloudHorizonFade = smoothstep(0.02, 0.24, dir.y) * (1.0 - smoothstep(0.76, 1.0, dir.y));
        cloudMask *= cloudHorizonFade;
        cloudCore *= cloudHorizonFade;

        float sunDot = max(dot(dir, normalize(uSunDirection)), 0.0);
        float sunDisc = smoothstep(0.9982, 0.9996, sunDot);
        float sunGlow = pow(sunDot, 52.0) * 0.58 + pow(sunDot, 9.0) * 0.16;

        float lightOnCloud = clamp(dot(normalize(vec3(dir.x, 0.42, dir.z)), normalize(uSunDirection)) * 0.5 + 0.5, 0.0, 1.0);
        vec3 cloudColor = mix(uCloudBottom, uCloudMid, mid);
        cloudColor = mix(cloudColor, uCloudTop, cloudCore * 0.78 + lightOnCloud * 0.24);
        cloudColor += uSunColor * pow(sunDot, 18.0) * cloudMask * 0.28;
        sky = mix(sky, cloudColor, cloudMask * 0.86);
        sky += uSunColor * sunGlow;
        sky = mix(sky, uSunColor * 1.25, sunDisc);

        gl_FragColor = vec4(sky, 1.0);
      }
    `
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'ProceduralCloudSky';
  mesh.renderOrder = -10;

  return {
    object: mesh,
    sunDirection,
    update: (elapsed: number) => {
      material.uniforms.uTime.value = elapsed;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    }
  };
};

export const createEnvironment = (
  scene: THREE.Scene,
  options: { grassEnabled?: boolean } = {}
) => {
  scene.background = new THREE.Color('#b9d9f1');
  scene.fog = new THREE.Fog('#b9d9f1', 180, 620);

  const sky = createProceduralSky();
  scene.add(sky.object);

  const hemi = new THREE.HemisphereLight('#e8f4ff', '#415b36', 2.0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#fff1c9', 2.55);
  sun.position.copy(sky.sunDirection).multiplyScalar(36);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  const textureLoader = new THREE.TextureLoader();
  const gltfLoader = new GLTFLoader();
  const originalMaterials = new WeakMap<THREE.Mesh, ThermalMaterial>();
  let thermalMode = false;

  const thermalGroundMaterial = new THREE.MeshStandardMaterial({
    color: '#6c706c',
    emissive: '#3b3f3b',
    emissiveIntensity: 0.04,
    roughness: 0.96,
    metalness: 0
  });
  const thermalRunwayMaterial = new THREE.MeshStandardMaterial({
    color: '#4c5050',
    emissive: '#252828',
    emissiveIntensity: 0.03,
    roughness: 0.9,
    metalness: 0
  });
  const thermalWarmObjectMaterial = new THREE.MeshStandardMaterial({
    color: '#eef1e8',
    emissive: '#e4e5d7',
    emissiveIntensity: 0.12,
    roughness: 0.86,
    metalness: 0
  });
  const thermalTreeMaterial = new THREE.MeshStandardMaterial({
    color: '#c9cec3',
    emissive: '#b8bcaf',
    emissiveIntensity: 0.06,
    roughness: 0.92,
    metalness: 0
  });
  const thermalObjects: Array<{
    object: THREE.Object3D;
    material: THREE.Material;
  }> = [];

  const setObjectThermalMaterial = (
    object: THREE.Object3D,
    enabled: boolean,
    thermalMaterial: THREE.Material
  ) => {
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }

      if (!originalMaterials.has(child)) {
        originalMaterials.set(child, child.material);
      }

      child.material = enabled
        ? thermalMaterial
        : originalMaterials.get(child) ?? child.material;
    });
  };

  const registerThermalObject = (
    object: THREE.Object3D,
    material: THREE.Material
  ) => {
    thermalObjects.push({ object, material });
    setObjectThermalMaterial(object, thermalMode, material);
  };

  // 620 x 620 meters.
  const groundGeometry = new THREE.PlaneGeometry(WORLD_SIZE_M, WORLD_SIZE_M, 160, 160);
  groundGeometry.setAttribute('uv2', new THREE.BufferAttribute(groundGeometry.attributes.uv.array, 2));
  const ground = new THREE.Mesh(
    groundGeometry,
    new THREE.MeshStandardMaterial({
      map: configureColorTexture(textureLoader.load(grassBaseColor), 94),
      normalMap: configureGroundTexture(textureLoader.load(grassNormal), 94),
      roughnessMap: configureGroundTexture(textureLoader.load(grassRoughness), 94),
      aoMap: configureGroundTexture(textureLoader.load(grassAo), 94),
      color: '#7faa59',
      roughness: 0.92,
      metalness: 0,
      normalScale: new THREE.Vector2(0.55, 0.55)
    })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  registerThermalObject(ground, thermalGroundMaterial);

  // 8 x 18 meters: small takeoff/landing service strip.
  const runwayMaterial = new THREE.MeshStandardMaterial({ color: '#202a2b', roughness: 0.78 });
  const runway = new THREE.Mesh(new THREE.PlaneGeometry(8, 18), runwayMaterial);
  runway.rotation.x = -Math.PI / 2;
  runway.position.y = 0.012;
  runway.receiveShadow = true;
  scene.add(runway);
  registerThermalObject(runway, thermalRunwayMaterial);

  const padMaterial = new THREE.MeshStandardMaterial({
    color: '#284038',
    emissive: '#0b3a25',
    emissiveIntensity: 0.12,
    roughness: 0.72
  });
  const padRing = new THREE.Mesh(new THREE.RingGeometry(5.2, 5.8, 96), padMaterial);
  padRing.rotation.x = -Math.PI / 2;
  padRing.position.y = 0.016;
  padRing.receiveShadow = true;
  scene.add(padRing);
  registerThermalObject(padRing, thermalRunwayMaterial);

  const markerMaterial = new THREE.MeshStandardMaterial({
    color: '#75f5bd',
    emissive: '#1edb88',
    emissiveIntensity: 0.28,
    roughness: 0.45
  });
  const markerGeometry = new THREE.BoxGeometry(0.18, 0.06, 1.4);
  const markers: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i += 1) {
    const marker = new THREE.Mesh(markerGeometry, markerMaterial);
    const angle = i * Math.PI * 0.5;
    marker.position.set(Math.sin(angle) * 6.9, 0.045, Math.cos(angle) * 6.9);
    marker.rotation.y = angle;
    marker.castShadow = true;
    marker.receiveShadow = true;
    markers.push(marker);
    scene.add(marker);
    registerThermalObject(marker, thermalWarmObjectMaterial);
  }

  let grassField: GrassField | null = null;
  const setGrassEnabled = (enabled: boolean) => {
    if (enabled && grassField === null) {
      grassField = createGrassField();
      grassField.setThermalMode(thermalMode);
      scene.add(grassField.object);
    } else if (!enabled && grassField !== null) {
      scene.remove(grassField.object);
      grassField.dispose();
      grassField = null;
    }
  };
  setGrassEnabled(Boolean(options.grassEnabled));

  const rand = seededRandom(91);
  const pinePlacements: ModelPlacement[] = [];
  let pineAttempts = 0;
  while (pinePlacements.length < 20 && pineAttempts < 360) {
    pineAttempts += 1;
    const angle = rand() * Math.PI * 2;
    const radius = 34 + rand() * 95;
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    const distanceFromPad = Math.hypot(x, z);
    const distanceFromHouseZone = Math.min(
      Math.hypot(x + 36, z + 48),
      Math.hypot(x - 42, z + 44),
      Math.hypot(x + 54, z - 24)
    );
    const distanceFromOtherPines = pinePlacements.every((pine) => Math.hypot(pine.x - x, pine.z - z) > 18);
    if (distanceFromPad < 22 || distanceFromHouseZone < 14 || !distanceFromOtherPines) {
      continue;
    }

    pinePlacements.push({
      x,
      z,
      heightM: 10 + rand() * 8,
      rotation: rand() * Math.PI * 2
    });
  }

  const housePlacements: ModelPlacement[] = [
    { x: -34, z: -42, heightM: 4.2, rotation: 0.62 },
    { x: -50, z: -28, heightM: 4.0, rotation: -0.22 },
    { x: -22, z: -62, heightM: 4.5, rotation: 1.28 },
    { x: 34, z: -48, heightM: 4.1, rotation: -1.2 },
    { x: 52, z: -26, heightM: 4.35, rotation: -0.64 },
    { x: 36, z: 36, heightM: 4.0, rotation: 2.1 },
    { x: -42, z: 38, heightM: 4.3, rotation: -2.45 },
    { x: -62, z: 14, heightM: 3.9, rotation: 0.9 },
    { x: 64, z: 18, heightM: 4.25, rotation: 2.62 }
  ];

  const vanPlacements: ModelPlacement[] = [{ x: -9.8, z: 10.6, heightM: 2.15, rotation: -0.78 }];

  const pineAssets = addModelScatter(scene, gltfLoader, pineAsset, pinePlacements, (object) =>
    registerThermalObject(object, thermalTreeMaterial)
  );
  const houseAssets = addModelScatter(scene, gltfLoader, houseAsset, housePlacements, (object) =>
    registerThermalObject(object, thermalWarmObjectMaterial)
  );
  const vanAssets = addModelScatter(scene, gltfLoader, vanAsset, vanPlacements, (object) =>
    registerThermalObject(object, thermalWarmObjectMaterial)
  );

  return {
    update: (elapsed: number) => {
      grassField?.update(elapsed);
      sky.update(elapsed);
    },
    setGrassEnabled,
    setThermalMode: (enabled: boolean) => {
      if (thermalMode === enabled) {
        return;
      }

      thermalMode = enabled;
      grassField?.setThermalMode(enabled);
      thermalObjects.forEach(({ object, material }) => {
        setObjectThermalMaterial(object, enabled, material);
      });
    },
    dispose: () => {
      grassField?.dispose();
      thermalGroundMaterial.dispose();
      thermalRunwayMaterial.dispose();
      thermalWarmObjectMaterial.dispose();
      thermalTreeMaterial.dispose();
      scene.remove(pineAssets, houseAssets, vanAssets);

      scene.remove(sky.object);
      sky.dispose();

      ground.geometry.dispose();
      runway.geometry.dispose();
      runwayMaterial.dispose();
      padRing.geometry.dispose();
      padMaterial.dispose();
      markerGeometry.dispose();
      markerMaterial.dispose();
    }
  };
};
