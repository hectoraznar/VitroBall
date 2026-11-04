/**
 * src/js/sceneManager.js
 * ---------------------------------------------------------------------------
 * Todo lo que se ve en 3D: escena, luces, cámara, placeholders de las máquinas
 * y de los niveles, raycasting y animaciones de cámara (GSAP).
 *
 * No toca el DOM de la UI ni crea cuerpos físicos. Con la UI solo hay dos
 * puntos de contacto, ambos en forma de datos: `projectToScreen()` (posición
 * 2D de una etiqueta) y `pick()` (qué máquina hay bajo el cursor).
 *
 * Los .glb todavía no existen, así que TODO son placeholders (cajas,
 * cilindros y esferas). Busca los bloques "GLTF (futuro)" para ver dónde
 * se enchufarán los modelos reales.
 * ---------------------------------------------------------------------------
 */

import * as THREE from 'three';
import gsap from 'gsap';
// GLTF (futuro): descomentar cuando existan los .glb exportados desde Blender.
// import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ===========================================================================
// Constantes y paleta neón
// ===========================================================================

export const MACHINE_IDS = ['machine1', 'machine2'];

export const PALETTE = Object.freeze({
  space: 0x06041a,
  panel: 0x1c1558,
  cyan: 0x35f0ff,
  magenta: 0xff3df2,
  amber: 0xffc247,
  violet: 0x8a5cff,
});

const TABLE = Object.freeze({ width: 12, length: 22 });
const WALL_HEIGHT = 1.5;
const WALL_THICKNESS = 0.5;

// ===========================================================================
// Layouts de nivel (datos puros).
// El SceneManager los usa para crear meshes y physics.js para crear cuerpos.
// Coordenadas [x, z] sobre la mesa; el centro de la mesa es (0, 0).
// ===========================================================================

/** Pared recta entre dos puntos [x, z]. */
function wallBetween(id, [x1, z1], [x2, z2]) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  return {
    id,
    pos: [(x1 + x2) / 2, WALL_HEIGHT / 2, (z1 + z2) / 2],
    size: [Math.hypot(dx, dz) + WALL_THICKNESS * 0.5, WALL_HEIGHT, WALL_THICKNESS],
    rotY: -Math.atan2(dz, dx), // mismo convenio de giro en Three.js y Cannon
  };
}

/**
 * Definición de un flipper. Ángulos de giro alrededor de Y (mismo convenio en
 * Three.js y Cannon). El izquierdo descansa apuntando hacia abajo (-ángulo) y
 * sube al activarse (+ángulo); el derecho es el espejo exacto.
 */
function flipperDef(side) {
  const sign = side === 'left' ? -1 : 1; // lado de la mesa donde está el pivote
  const rest = sign * 0.52; // ~30°
  return {
    id: `flipper-${side}`,
    side,
    pivot: [sign * 3.3, 8.8],
    length: 2.7,
    thickness: 0.55,
    restAngle: rest,
    activeAngle: -rest,
  };
}

/** Estructura común a todas las mesas: paredes, guías hacia los flippers y flippers. */
function createBaseLayout({ id, name, players, accent, bumpers, ramps }) {
  const hw = TABLE.width / 2;
  const hl = TABLE.length / 2;
  const T = WALL_THICKNESS;

  const flippers = ['left', 'right'].map(flipperDef);

  return {
    id,
    name,
    players,
    accent,
    table: { ...TABLE },
    walls: [
      { id: 'wall-left', pos: [-hw - T / 2, WALL_HEIGHT / 2, 0], size: [T, WALL_HEIGHT, TABLE.length + T * 2], rotY: 0 },
      { id: 'wall-right', pos: [hw + T / 2, WALL_HEIGHT / 2, 0], size: [T, WALL_HEIGHT, TABLE.length + T * 2], rotY: 0 },
      wallBetween('wall-top', [-3, -hl], [3, -hl]),
      wallBetween('corner-left', [-hw, -7.5], [-3, -hl]),
      wallBetween('corner-right', [hw, -7.5], [3, -hl]),
      wallBetween('guide-left', [-hw, 5.2], [-3.75, 8.2]),
      wallBetween('guide-right', [hw, 5.2], [3.75, 8.2]),
    ],
    bumpers,
    ramps,
    flippers,
    ball: { radius: 0.45, spawn: [0, -9] },
  };
}

export const LEVEL_LAYOUTS = Object.freeze({
  // Máquina 1: "1 Player" — tres bumpers en triángulo y una rampa.
  machine1: createBaseLayout({
    id: 'machine1',
    name: 'Nebulosa',
    players: 1,
    accent: PALETTE.cyan,
    bumpers: [
      { id: 'b1', pos: [-2.8, -3.2], radius: 0.95, points: 100, color: PALETTE.cyan },
      { id: 'b2', pos: [2.8, -3.2], radius: 0.95, points: 100, color: PALETTE.amber },
      { id: 'b3', pos: [0, -6.2], radius: 0.95, points: 250, color: PALETTE.magenta },
    ],
    ramps: [{ id: 'r1', pos: [-2.6, 1.8], size: [2.0, 0.3, 4.5], angle: 0.2, yaw: -0.5 }],
  }),

  // Máquina 2: "2 Players" — cuatro bumpers en rombo y dos rampas.
  machine2: createBaseLayout({
    id: 'machine2',
    name: 'Púlsar',
    players: 2,
    accent: PALETTE.magenta,
    bumpers: [
      { id: 'b1', pos: [0, -7], radius: 0.85, points: 250, color: PALETTE.amber },
      { id: 'b2', pos: [-3, -4], radius: 0.85, points: 100, color: PALETTE.magenta },
      { id: 'b3', pos: [3, -4], radius: 0.85, points: 100, color: PALETTE.cyan },
      { id: 'b4', pos: [0, -1.5], radius: 0.85, points: 150, color: PALETTE.violet },
    ],
    ramps: [
      { id: 'r1', pos: [-2.8, 2.6], size: [1.8, 0.3, 4], angle: 0.2, yaw: -0.5 },
      { id: 'r2', pos: [2.8, 2.6], size: [1.8, 0.3, 4], angle: 0.2, yaw: 0.5 },
    ],
  }),
});

// ===========================================================================
// Utilidades
// ===========================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function disposeObject(root) {
  root.traverse((obj) => {
    obj.geometry?.dispose();
    const materials = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const material of materials) {
      material.map?.dispose();
      material.dispose();
    }
  });
}

// ===========================================================================
// SceneManager
// ===========================================================================

export class SceneManager {
  #machines = new Map(); // id -> { id, group, mesh, material, basePosition, hover, hoverTarget }
  #pickables = [];
  #level = null; // { machineId, group, bumpers: Map<id, { material, ring, flash }> }
  #mode = 'menu'; // 'menu' | 'flying' | 'game'  (decide cómo reaccionar al resize)
  #activeMachineId = null;
  #cameraFlight = null; // { tween, resolve }
  #helperCamera = new THREE.PerspectiveCamera();
  #raycaster = new THREE.Raycaster();
  #tmpVec = new THREE.Vector3();
  #stars = null;
  #planet = null;
  #built = false;

  /** @param {{ aspect: number }} options */
  constructor({ aspect }) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.space);
    this.scene.fog = new THREE.Fog(PALETTE.space, 45, 170);

    this.camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 600);
    this.#setupLights();
  }

  // ------------------------------------------------------------------------
  // Carga de assets
  // ------------------------------------------------------------------------

  /**
   * Carga los assets de la escena y construye los placeholders.
   * Por ahora SIMULA la carga con timeouts para que se vea la pantalla de carga.
   * @param {(progress: number) => void} onProgress  Valor 0..1
   */
  async loadAssets(onProgress = () => {}) {
    // --- Modo placeholder (actual): carga simulada -------------------------
    const steps = 22;
    for (let i = 1; i <= steps; i++) {
      await sleep(120);
      onProgress(i / steps);
    }

    /* --- GLTF (futuro): carga real con progreso ----------------------------
    const manager = new THREE.LoadingManager();
    manager.onProgress = (_url, loaded, total) => onProgress(loaded / total);
    const loader = new GLTFLoader(manager);

    // Con Vite, los archivos de src/assets se referencian así:
    const url = (name) => new URL(`../assets/models/${name}`, import.meta.url).href;
    const [machine1, machine2] = await Promise.all([
      loader.loadAsync(url('machine1.glb')),
      loader.loadAsync(url('machine2.glb')),
    ]);
    this.models = { machine1: machine1.scene, machine2: machine2.scene };
    // Después, en #createMachine(), usar this.models[id] en lugar de la caja.
    ------------------------------------------------------------------------ */

    this.#buildMenuScene();
    onProgress(1);
  }

  // ------------------------------------------------------------------------
  // Escena del menú
  // ------------------------------------------------------------------------

  #setupLights() {
    this.scene.add(new THREE.AmbientLight(0x7a6cff, 1.1));

    const key = new THREE.DirectionalLight(0xdde6ff, 2.2);
    key.position.set(8, 20, 14);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(PALETTE.magenta, 1.2);
    rim.position.set(-12, 8, -10);
    this.scene.add(rim);
  }

  #buildMenuScene() {
    if (this.#built) return;
    this.#built = true;

    // Rejilla neón que da sensación de plataforma espacial.
    const grid = new THREE.GridHelper(180, 90, PALETTE.magenta, 0x2a1f6b);
    grid.position.y = -2.4;
    grid.material.transparent = true;
    grid.material.opacity = 0.4;
    this.scene.add(grid);

    this.#createStarfield();
    this.#createPlanet();

    this.#createMachine('machine1', -8, PALETTE.cyan);
    this.#createMachine('machine2', 8, PALETTE.magenta);

    this.#snapCamera(this.#getMenuPose());
  }

  #createStarfield() {
    const count = 1600;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const tint = [new THREE.Color(0xffffff), new THREE.Color(0xbfe9ff), new THREE.Color(0xffd0fb)];

    for (let i = 0; i < count; i++) {
      // Punto aleatorio sobre una cáscara esférica, lejos de la cámara.
      const radius = 140 + Math.random() * 180;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      tint[i % 3].toArray(colors, i * 3);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.#stars = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({ size: 1.6, vertexColors: true, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.9, depthWrite: false })
    );
    this.scene.add(this.#stars);
  }

  #createPlanet() {
    const group = new THREE.Group();
    group.position.set(-70, 30, -150);

    group.add(
      new THREE.Mesh(
        new THREE.SphereGeometry(16, 40, 40),
        new THREE.MeshStandardMaterial({ color: 0x2b1a78, emissive: PALETTE.violet, emissiveIntensity: 0.35, roughness: 0.8, fog: false })
      )
    );

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(21, 30, 80),
      new THREE.MeshBasicMaterial({ color: PALETTE.magenta, side: THREE.DoubleSide, transparent: true, opacity: 0.45, fog: false })
    );
    ring.rotation.x = Math.PI / 2.4;
    group.add(ring);

    this.#planet = group;
    this.scene.add(group);
  }

  /** Placeholder de una máquina de pinball: una caja con aristas neón. */
  #createMachine(id, x, color) {
    // GLTF (futuro): si existe this.models?.[id], añadir ese modelo al grupo en lugar de la caja.
    const group = new THREE.Group();
    group.position.set(x, 0, 0);

    const geometry = new THREE.BoxGeometry(6, 2.4, 11);
    const material = new THREE.MeshStandardMaterial({
      color: PALETTE.panel,
      emissive: color,
      emissiveIntensity: 0.12,
      metalness: 0.6,
      roughness: 0.35,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.machineId = id;

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color }));

    // Panel luminoso sobre la tapa: sugiere la mesa de juego.
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(4.6, 9.6),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false })
    );
    top.rotation.x = -Math.PI / 2;
    top.position.y = 1.21;

    const glow = new THREE.PointLight(color, 120, 22, 2);
    glow.position.set(0, 5, 3);

    group.add(mesh, edges, top, glow);
    this.scene.add(group);

    this.#pickables.push(mesh);
    this.#machines.set(id, {
      id,
      group,
      mesh,
      material,
      color,
      basePosition: group.position.clone(),
      hover: 0,
      hoverTarget: 0,
    });
  }

  // ------------------------------------------------------------------------
  // Interacción (raycasting) y proyección a pantalla
  // ------------------------------------------------------------------------

  /**
   * ¿Qué máquina hay bajo el cursor?
   * @param {number} ndcX  -1..1
   * @param {number} ndcY  -1..1
   * @returns {string|null}
   */
  pick(ndcX, ndcY) {
    this.#raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const hits = this.#raycaster.intersectObjects(this.#pickables, false);
    return hits[0]?.object.userData.machineId ?? null;
  }

  /** Resalta una máquina (null = ninguna). */
  setHovered(id) {
    for (const machine of this.#machines.values()) {
      machine.hoverTarget = machine.id === id ? 1 : 0;
    }
  }

  /**
   * Posición en píxeles del punto de anclaje de la etiqueta de una máquina.
   * La UI usa este dato para colocar el texto HTML encima del placeholder.
   */
  projectToScreen(id, width, height) {
    const machine = this.#machines.get(id);
    if (!machine) return { x: 0, y: 0, visible: false };

    // Se ancla a la posición base (no a la oscilación del cubo) para que el botón no tiemble.
    this.#tmpVec.set(machine.basePosition.x, machine.basePosition.y + 3.4, machine.basePosition.z).project(this.camera);
    return {
      x: (this.#tmpVec.x * 0.5 + 0.5) * width,
      y: (-this.#tmpVec.y * 0.5 + 0.5) * height,
      visible: this.#tmpVec.z < 1 && Math.abs(this.#tmpVec.x) < 1.2 && Math.abs(this.#tmpVec.y) < 1.2,
    };
  }

  // ------------------------------------------------------------------------
  // Cámara
  // ------------------------------------------------------------------------

  /** Pose de la cámara en el menú: encuadra las dos máquinas (también en móvil vertical). */
  #getMenuPose() {
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distForWidth = 13.5 / (tanHalf * this.camera.aspect);
    const distance = Math.max(20, distForWidth);
    return {
      position: new THREE.Vector3(0, distance * 0.35, distance),
      target: new THREE.Vector3(0, 0.5, 0),
      up: new THREE.Vector3(0, 1, 0),
    };
  }

  /** Pose cenital (vista de pájaro) sobre la mesa de una máquina. */
  #getTopDownPose(machineId) {
    const base = this.#machines.get(machineId).basePosition;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // Margen extra arriba/abajo: deja sitio al HUD (puntuaciones y ayuda de teclas).
    const heightForLength = (TABLE.length / 2 + 3) / tanHalf;
    const heightForWidth = (TABLE.width / 2 + 1.5) / (tanHalf * this.camera.aspect);
    return {
      position: new THREE.Vector3(base.x, Math.max(heightForLength, heightForWidth), 0),
      target: new THREE.Vector3(base.x, 0, 0),
      up: new THREE.Vector3(0, 0, -1), // -Z queda arriba en pantalla
    };
  }

  #poseQuaternion({ position, target, up }) {
    this.#helperCamera.position.copy(position);
    this.#helperCamera.up.copy(up);
    this.#helperCamera.lookAt(target);
    return this.#helperCamera.quaternion.clone();
  }

  #snapCamera(pose) {
    this.camera.up.copy(pose.up);
    this.camera.position.copy(pose.position);
    this.camera.quaternion.copy(this.#poseQuaternion(pose));
  }

  /**
   * Animación de cámara con GSAP. Interpola posición (lerp) y orientación
   * (slerp), lo que funciona incluso al pasar a una vista totalmente vertical.
   * @returns {Promise<boolean>} true si llegó al destino, false si se interrumpió.
   */
  #flyCamera(pose, duration, ease = 'power3.inOut') {
    this.#killCameraFlight();
    this.#mode = 'flying';

    const startPos = this.camera.position.clone();
    const startQuat = this.camera.quaternion.clone();
    const endQuat = this.#poseQuaternion(pose);
    const progress = { t: 0 };

    return new Promise((resolve) => {
      const tween = gsap.to(progress, {
        t: 1,
        duration,
        ease,
        onUpdate: () => {
          this.camera.position.lerpVectors(startPos, pose.position, progress.t);
          this.camera.quaternion.slerpQuaternions(startQuat, endQuat, progress.t);
        },
        onComplete: () => {
          this.#snapCamera(pose);
          this.#cameraFlight = null;
          resolve(true);
        },
      });
      this.#cameraFlight = { tween, resolve };
    });
  }

  #killCameraFlight() {
    if (!this.#cameraFlight) return;
    this.#cameraFlight.tween.kill();
    this.#cameraFlight.resolve(false);
    this.#cameraFlight = null;
  }

  /** Entrada desde la pantalla de carga: la cámara se acerca a las máquinas. */
  async playIntro() {
    const pose = this.#getMenuPose();
    this.#snapCamera({ ...pose, position: pose.position.clone().multiplyScalar(2.1).setY(pose.position.y * 2.8) });
    const arrived = await this.#flyCamera(pose, 2.6, 'power2.out');
    if (arrived) this.#mode = 'menu';
  }

  /** Vuelve a la vista del menú. */
  async flyToMenu() {
    const arrived = await this.#flyCamera(this.#getMenuPose(), 1.8);
    if (arrived) this.#mode = 'menu';
  }

  /** Vista de pájaro sobre la máquina elegida. */
  async flyToMachine(machineId) {
    this.#activeMachineId = machineId;
    const arrived = await this.#flyCamera(this.#getTopDownPose(machineId), 2.2);
    if (arrived) this.#mode = 'game';
    return arrived;
  }

  /** Mantiene el encuadre correcto al redimensionar la ventana. */
  onResize(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (this.#mode === 'menu') this.#snapCamera(this.#getMenuPose());
    else if (this.#mode === 'game' && this.#activeMachineId) this.#snapCamera(this.#getTopDownPose(this.#activeMachineId));
  }

  // ------------------------------------------------------------------------
  // Niveles (placeholders específicos de cada mesa)
  // ------------------------------------------------------------------------

  /**
   * Construye la mesa de la máquina elegida. El cubo del menú se oculta y la
   * mesa "se materializa" sobre él.
   * @returns {Promise<{ ball: THREE.Object3D, flippers: Record<string, THREE.Object3D> }>}
   *   Los meshes dinámicos, que physics.js sincronizará con sus cuerpos.
   */
  async loadLevel(machineId) {
    this.unloadLevelImmediately();

    const layout = LEVEL_LAYOUTS[machineId];
    const machine = this.#machines.get(machineId);
    const { group, meshes, bumpers } = this.#buildLevelMeshes(layout);

    group.position.copy(machine.basePosition);
    group.scale.setScalar(0.55);
    this.scene.add(group);
    machine.group.visible = false;
    this.#level = { machineId, group, bumpers };

    await new Promise((resolve) => {
      gsap.to(group.scale, { x: 1, y: 1, z: 1, duration: 0.7, ease: 'back.out(1.5)', onComplete: resolve });
    });
    return meshes;
  }

  /** Quita la mesa con una animación inversa y vuelve a mostrar el cubo del menú. */
  async unloadLevel() {
    if (!this.#level) return;
    const { group } = this.#level;
    await new Promise((resolve) => {
      gsap.to(group.scale, { x: 0.55, y: 0.55, z: 0.55, duration: 0.6, ease: 'power2.in', onComplete: resolve });
    });
    this.unloadLevelImmediately();
  }

  unloadLevelImmediately() {
    if (!this.#level) return;
    const { machineId, group } = this.#level;
    gsap.killTweensOf(group.scale);
    this.scene.remove(group);
    disposeObject(group);
    this.#machines.get(machineId).group.visible = true;
    this.#level = null;
    this.#activeMachineId = null;
  }

  /** Destello de un bumper al recibir un golpe. */
  flashBumper(id) {
    const bumper = this.#level?.bumpers.get(id);
    if (bumper) bumper.flash = 1;
  }

  #buildLevelMeshes(layout) {
    const group = new THREE.Group();
    const accent = layout.accent;
    const bumpers = new Map();

    const wallMaterial = new THREE.MeshStandardMaterial({
      color: PALETTE.panel,
      emissive: accent,
      emissiveIntensity: 0.3,
      metalness: 0.4,
      roughness: 0.5,
    });
    const edgeMaterial = new THREE.LineBasicMaterial({ color: accent });

    // --- Mesa ------------------------------------------------------------
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(TABLE.width + 1.4, 0.5, TABLE.length + 1.4),
      new THREE.MeshStandardMaterial({ color: 0x0d0a30, roughness: 0.9 })
    );
    base.position.y = -0.25;
    group.add(base);

    const surface = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE.width, TABLE.length),
      new THREE.MeshStandardMaterial({ map: this.#makeTableTexture(accent), roughness: 0.6, metalness: 0.1 })
    );
    surface.rotation.x = -Math.PI / 2;
    surface.position.y = 0.01;
    group.add(surface);

    // --- Paredes y guías ---------------------------------------------------
    for (const wall of layout.walls) {
      const geometry = new THREE.BoxGeometry(...wall.size);
      const mesh = new THREE.Mesh(geometry, wallMaterial);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial));
      mesh.position.set(...wall.pos);
      mesh.rotation.y = wall.rotY ?? 0;
      group.add(mesh);
    }

    // --- Bumpers -----------------------------------------------------------
    for (const def of layout.bumpers) {
      const material = new THREE.MeshStandardMaterial({ color: 0x120d3a, emissive: def.color, emissiveIntensity: 0.9, roughness: 0.4 });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(def.radius, def.radius, 1.2, 32), material);
      body.position.set(def.pos[0], 0.6, def.pos[1]);

      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(def.radius * 0.7, 0.07, 10, 40),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.62;
      body.add(ring);

      group.add(body);
      bumpers.set(def.id, { material, ring, flash: 0 });
    }

    // --- Rampas ------------------------------------------------------------
    for (const def of layout.ramps) {
      const [width, thickness, length] = def.size;
      const geometry = new THREE.BoxGeometry(width, thickness, length);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.35, transparent: true, opacity: 0.6 })
      );
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: 0xffffff })));
      mesh.rotation.order = 'YXZ'; // primero inclina (X), luego gira en diagonal (Y)
      mesh.rotation.y = def.yaw ?? 0;
      mesh.rotation.x = def.angle;
      // Misma fórmula que physics.js: el extremo bajo toca el suelo.
      mesh.position.set(def.pos[0], (thickness / 2) * Math.cos(def.angle) + (length / 2) * Math.sin(def.angle), def.pos[1]);
      group.add(mesh);
    }

    // --- Flippers (grupo en el pivote; la caja se desplaza para girar sobre su extremo) ---
    const flipperMeshes = {};
    for (const def of layout.flippers) {
      const dir = def.side === 'left' ? 1 : -1;
      const flipper = new THREE.Group();

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(def.length, 0.8, def.thickness),
        new THREE.MeshStandardMaterial({ color: 0x2a1f6b, emissive: PALETTE.amber, emissiveIntensity: 0.8, roughness: 0.4 })
      );
      arm.position.x = (dir * def.length) / 2;

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.42, 0.9, 20),
        new THREE.MeshStandardMaterial({ color: 0x2a1f6b, emissive: PALETTE.amber, emissiveIntensity: 1.2 })
      );

      flipper.add(arm, cap);
      flipper.position.set(def.pivot[0], 0.4, def.pivot[1]);
      flipper.rotation.y = def.restAngle;
      group.add(flipper);
      flipperMeshes[def.id] = flipper;
    }

    // --- Bola --------------------------------------------------------------
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(layout.ball.radius, 32, 24),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: PALETTE.amber, emissiveIntensity: 1.1, roughness: 0.2 })
    );
    ball.visible = false; // physics.js la muestra cuando la lanza
    ball.add(new THREE.PointLight(PALETTE.amber, 14, 9, 2)); // la bola ilumina la mesa
    group.add(ball);

    // Luz general de la mesa
    const tableLight = new THREE.PointLight(accent, 260, 45, 2);
    tableLight.position.set(0, 10, 0);
    group.add(tableLight);

    return { group, meshes: { ball, flippers: flipperMeshes }, bumpers };
  }

  /** Textura de la mesa dibujada en un canvas: estrellas, rejilla y órbitas. */
  #makeTableTexture(accentHex) {
    const width = 512;
    const height = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const accent = `#${new THREE.Color(accentHex).getHexString()}`;

    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#1c1458');
    bg.addColorStop(1, '#07041c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // Rejilla tenue
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.08;
    ctx.lineWidth = 1;
    for (let p = 0; p <= width; p += 64) {
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, height);
      ctx.stroke();
    }
    for (let p = 0; p <= height; p += 64) {
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(width, p);
      ctx.stroke();
    }

    // Estrellas (generador pseudoaleatorio fijo: la mesa siempre luce igual)
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = '#ffffff';
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 90; i++) ctx.fillRect(rand() * width, rand() * height, 2, 2);

    // Órbitas concéntricas alrededor de un "planeta"
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 3;
    for (const radius of [90, 150, 210]) {
      ctx.beginPath();
      ctx.arc(width / 2, 400, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(width / 2, 400, 46, 0, Math.PI * 2);
    ctx.fill();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }

  // ------------------------------------------------------------------------
  // Bucle
  // ------------------------------------------------------------------------

  /** Animaciones ambientales y efectos. No toca la física. */
  update(dt, elapsed) {
    if (this.#stars) this.#stars.rotation.y += dt * 0.004;
    if (this.#planet) this.#planet.rotation.y += dt * 0.02;

    let index = 0;
    for (const machine of this.#machines.values()) {
      machine.hover += (machine.hoverTarget - machine.hover) * Math.min(1, dt * 8);
      machine.group.position.y = machine.basePosition.y + Math.sin(elapsed * 1.2 + index * 1.7) * 0.15;
      machine.group.scale.setScalar(1 + machine.hover * 0.05);
      machine.material.emissiveIntensity = 0.12 + machine.hover * 0.55;
      index++;
    }

    if (this.#level) {
      for (const bumper of this.#level.bumpers.values()) {
        bumper.flash = Math.max(0, bumper.flash - dt * 4);
        bumper.material.emissiveIntensity = 0.9 + bumper.flash * 3.5;
        bumper.ring.scale.setScalar(1 + bumper.flash * 0.18);
      }
    }
  }
}