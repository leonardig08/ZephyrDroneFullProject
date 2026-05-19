# DroneBox Simulator

Simulatore web 3D modulare per un quadricottero, costruito con Vite, React, TypeScript e Three.js.

## Comandi

```bash
npm install
npm run dev
npm run build
```

## Controlli tastiera

- `R`: arm/disarm
- `M`: cambia modalità FPV/STABILIZED
- `F`: cambia camera orbitale/FPV
- `Space`: aumenta throttle
- `Left Shift`: riduce throttle
- `W/S`: pitch
- `A/D`: roll
- `Q/E`: yaw

## Architettura

- `src/scene`: rendering Three.js, modello drone, ambiente e camera rig.
- `src/sim`: stato drone, fisica, modelli motore/eliche/batteria/aerodinamica e flight controller.
- `src/workers`: loop fisico in Web Worker.
- `src/hardware`: mapper tastiera e bridge Web Serial per Pico W/Arduino.
- `src/api`: protocollo comandi e bridge WebSocket per SDK esterni.
- `src/mobile`: route viewer FPV e QR code.
- `src/ui`: pannelli cockpit e telemetria.
