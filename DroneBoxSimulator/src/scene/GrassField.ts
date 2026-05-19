import * as THREE from 'three';

const seededRandom = (seed: number) => {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
};

const createBladeGeometry = () => {
  const geometry = new THREE.BufferGeometry();
  const vertices: number[] = [];
  const uvs: number[] = [];

  for (let i = 0; i < 12; i += 1) {
    const angle = i * 2.399963229728653;
    const radius = i === 0 ? 0 : 0.045 + (i % 6) * 0.038;
    const baseX = Math.cos(angle) * radius;
    const baseZ = Math.sin(angle) * radius;
    const width = 0.02 + (i % 3) * 0.006;
    const height = 0.09 + (i % 5) * 0.02;
    const bend = 0.016 + (i % 2) * 0.012;
    const rightX = Math.cos(angle) * width;
    const rightZ = Math.sin(angle) * width;
    const tipX = Math.cos(angle + 0.55) * bend;
    const tipZ = Math.sin(angle + 0.55) * bend;

    vertices.push(
      baseX - rightX, 0, baseZ - rightZ,
      baseX + rightX, 0, baseZ + rightZ,
      baseX + tipX, height, baseZ + tipZ
    );
    uvs.push(0, 0, 1, 0, 0.5, 1);
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geometry.computeVertexNormals();
  return geometry;
};

export const createGrassField = () => {
  const patchCount = 120000;
  const grassExtentM = 500;
  const halfGrassExtentM = grassExtentM * 0.5;
  const gridColumns = Math.ceil(Math.sqrt(patchCount));
  const cellSize = grassExtentM / gridColumns;
  const rand = seededRandom(42);
  const geometry = createBladeGeometry();
  const material = new THREE.ShaderMaterial({
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uThermalMode: { value: 0 },
      uFogColor: { value: new THREE.Color('#9bc7ef') }
    },
    vertexShader: `
      uniform float uTime;
      varying float vHeight;
      varying float vRand;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        vec3 p = position;
        vec4 world = instanceMatrix * vec4(p, 1.0);
        float r = hash(world.xz);
        float sway = sin(uTime * 1.35 + world.x * 0.7 + world.z * 0.55 + r * 6.2831) * 0.008;
        p.x += sway * uv.y;
        p.z += cos(uTime * 1.05 + world.z * 0.4 + r * 3.0) * 0.006 * uv.y;
        vHeight = uv.y;
        vRand = r;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      varying float vHeight;
      varying float vRand;
      uniform float uThermalMode;

      void main() {
        vec3 root = vec3(0.13, 0.25, 0.065);
        vec3 tip = vec3(0.32, 0.50, 0.13);
        vec3 color = mix(root, tip, smoothstep(0.0, 1.0, vHeight));
        color *= 0.82 + vRand * 0.2;
        vec3 thermalRoot = vec3(0.30, 0.31, 0.30);
        vec3 thermalTip = vec3(0.47, 0.49, 0.45);
        vec3 thermalColor = mix(thermalRoot, thermalTip, smoothstep(0.0, 1.0, vHeight));
        color = mix(color, thermalColor, uThermalMode);
        gl_FragColor = vec4(color, 1.0);
      }
    `
  });

  const grass = new THREE.InstancedMesh(geometry, material, patchCount);
  grass.name = 'ShortProceduralGrass';
  grass.frustumCulled = false;
  grass.renderOrder = 2;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < patchCount; i += 1) {
    const localRand = rand();
    const denseCore = localRand < 0.68;
    let x: number;
    let z: number;

    if (denseCore) {
      x = (rand() - 0.5) * 180;
      z = (rand() - 0.5) * 180;
    } else {
      const col = i % gridColumns;
      const row = Math.floor(i / gridColumns);
      x = -halfGrassExtentM + (col + 0.5 + (rand() - 0.5) * 0.76) * cellSize;
      z = -halfGrassExtentM + (row + 0.5 + (rand() - 0.5) * 0.76) * cellSize;
    }
    const runwayAvoidance = Math.abs(x) < 5.2 && Math.abs(z) < 10.2;
    const padAvoidance = Math.hypot(x, z) < 7.4;
    if (runwayAvoidance || padAvoidance) {
      const angle = rand() * Math.PI * 2;
      const radius = 7.8 + rand() * 5.2;
      x = Math.sin(angle) * radius;
      z = Math.cos(angle) * radius;
    }

    dummy.position.set(x, 0.026, z);

    dummy.rotation.set(0, rand() * Math.PI * 2, (rand() - 0.5) * 0.16);
    const nearSpawnBoost = 1 + Math.max(0, 1 - Math.hypot(x, z) / 58) * 0.28;
    const edgeFade =
      THREE.MathUtils.smoothstep(halfGrassExtentM - Math.max(Math.abs(x), Math.abs(z)), 0, 36);
    const widthScale = (2.25 + rand() * 1.05) * nearSpawnBoost * edgeFade;
    const heightScale = (0.78 + rand() * 0.44) * nearSpawnBoost * edgeFade;
    dummy.scale.set(widthScale, heightScale, widthScale);
    dummy.updateMatrix();
    grass.setMatrixAt(i, dummy.matrix);
  }

  grass.instanceMatrix.needsUpdate = true;

  return {
    object: grass,
    update: (time: number) => {
      material.uniforms.uTime.value = time;
    },
    setThermalMode: (enabled: boolean) => {
      material.uniforms.uThermalMode.value = enabled ? 1 : 0;
    },
    dispose: () => {
      geometry.dispose();
      material.dispose();
    }
  };
};
