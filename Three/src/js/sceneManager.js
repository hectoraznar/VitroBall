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
  blue: 0x6c7cff,
  red: 0xff4d6d,
  pink: 0xe58cff,
});

const TABLE = Object.freeze({ width: 12, length: 18 }); // mesa de UN jugador
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

/** Flipper con el pivote en `pivot` [x, z]. El derecho es el espejo exacto del izquierdo. */
function flipperDef(side, pivot, length = 1.9) {
  const rest = side === 'left' ? -0.52 : 0.52; // ~30° hacia abajo
  return { side, pivot, length, thickness: 0.5, restAngle: rest, activeAngle: -rest };
}

/**
 * Mesa de UN jugador, copiada del modelo de Blender (Arcade2Players, mesa azul).
 * Coordenadas [x, z] con x en [-12, 0]: carril del muelle a la izquierda
 * (x < -10.5) y el borde x = 0 es el centro de la máquina de 2 jugadores.
 * Paredes: [id, desde, hasta, opciones]. rail = raíl metálico encima.
 */
const PLAYFIELD = {
  walls: [
    ['lane', [-10.4, 9], [-10.2, -6.3], { rail: true }],
    ['lane-top', [-12, -7.6], [-9.2, -9], { rail: true }],
    ['out-1', [-10.2, 2.1], [-8.6, 3.8]],
    ['out-2', [-8.6, 3.8], [-8.3, 5.9], { rail: true }],
    ['out-3', [-8.3, 5.9], [-7.3, 7.0], { rail: true }],
    ['in-1', [-0.7, 0.6], [-1.5, 3.4]],
    ['in-2', [-1.5, 3.4], [-1.9, 5.9], { rail: true }],
    ['in-3', [-1.9, 5.9], [-3.1, 7.0], { rail: true }],
    ['roof', [-0.7, 0.6], [0, 0.1]], // tejadillo: la bola no se cuela entre las dos mesas
  ],
  bumpers: [
    { id: 'planet-l', pos: [-8.2, -5.5], radius: 0.75, points: 100, color: 0xdfe3ff },
    { id: 'planet-r', pos: [-3.6, -7.3], radius: 0.75, points: 100, color: 0xdfe3ff },
    { id: 'diamond', pos: [-4.9, 1.0], radius: 0.95, sides: 4, points: 150 },
    { id: 'moon-l', pos: [-6.6, 3.6], radius: 0.7, points: 100 },
    { id: 'moon-r', pos: [-3.8, 3.6], radius: 0.7, points: 100 },
    // Estrellas: sensores sin rebote que dan puntos al pasar por encima.
    ...[[-6.3, -5.6], [-3.5, -5.6], [-8.2, -3.1], [-4.9, -3.1], [-1.8, -3.1], [-6.9, -0.25], [-2.9, -0.25]].map((pos, i) => ({
      id: `star-${i}`, pos, radius: 0.35, points: 50, star: true, color: PALETTE.amber,
    })),
  ],
  flippers: [flipperDef('left', [-7.4, 7.2]), flipperDef('right', [-3.0, 7.2])],
  lane: [-12, -10.55],
  plunger: [-11.27, 8.6],
  spawn: [-11.27, 7.7],
};

/**
 * Coloca la mesa de un jugador en la máquina.
 * side: 0 = solitario (centrada), -1 = J1 (izquierda), +1 = J2 (derecha, espejo de J1).
 */
function placeHalf(def, { player, side, accent }) {
  const mirror = side > 0;
  const px = (x) => (mirror ? -x : x + (side === 0 ? TABLE.width / 2 : 0));
  const point = ([x, z]) => [px(x), z];
  const tag = (id) => `p${player}-${id}`;
  const swap = { left: 'right', right: 'left' };

  return {
    player,
    side,
    accent,
    centerX: px(-TABLE.width / 2),
    flipperMidX: (px(def.flippers[0].pivot[0]) + px(def.flippers[1].pivot[0])) / 2,
    lane: def.lane.map(px).sort((a, b) => a - b),
    spawn: point(def.spawn),
    walls: def.walls.map(([id, a, b, opts]) => ({ ...wallBetween(tag(id), point(a), point(b)), ...opts, color: accent })),
    bumpers: def.bumpers.map((b) => ({ ...b, id: tag(b.id), pos: point(b.pos), color: b.color ?? accent })),
    flippers: def.flippers.map((f) => {
      const s = mirror ? swap[f.side] : f.side; // en espejo el izquierdo pasa a ser el derecho
      return { ...flipperDef(s, point(f.pivot), f.length), id: tag(`flipper-${s}`), player, color: accent };
    }),
    plunger: { id: tag('plunger'), player, pos: point(def.plunger), width: 1.3, color: PALETTE.pink },
  };
}

/** Une una o dos mesas en un layout completo (paredes exteriores con raíles y extras centrales). */
function createLayout({ id, name, mode, accent, halves, extraBumpers = [], extraWalls = [], core = null }) {
  const T = WALL_THICKNESS;
  const width = TABLE.width * halves.length;
  const hw = width / 2;
  const hl = TABLE.length / 2;
  const outer = (wallId, x) => ({ id: wallId, pos: [x, WALL_HEIGHT / 2, 0], size: [T, WALL_HEIGHT, TABLE.length + T * 2], rotY: 0, rail: true });

  return {
    id,
    name,
    mode, // 'solo' | 'versus'
    players: halves.length,
    accent,
    table: { width, length: TABLE.length },
    halves: halves.map(({ player, side, accent, centerX, flipperMidX, lane, spawn }) => ({ player, side, accent, centerX, flipperMidX, lane, spawn })),
    walls: [
      outer('wall-left', -hw - T / 2),
      outer('wall-right', hw + T / 2),
      { id: 'wall-top', pos: [0, WALL_HEIGHT / 2, -hl - T / 2], size: [width + T * 2, WALL_HEIGHT, T], rotY: 0, rail: true },
      ...halves.flatMap((half) => half.walls),
      ...extraWalls,
    ],
    bumpers: [...halves.flatMap((half) => half.bumpers), ...extraBumpers],
    flippers: halves.flatMap((half) => half.flippers),
    plungers: halves.map((half) => half.plunger),
    core, // El Núcleo: zona central que dispara la bola a la mesa rival
    ball: { radius: 0.35 },
  };
}

export const LEVEL_LAYOUTS = Object.freeze({
  // Máquina 1: Solitario — la mesa azul del modelo, sola.
  machine1: createLayout({
    id: 'machine1',
    name: 'Nebulosa',
    mode: 'solo',
    accent: PALETTE.blue,
    halves: [placeHalf(PLAYFIELD, { player: 0, side: 0, accent: PALETTE.blue })],
  }),

  // Máquina 2: Multijugador — dos mesas lado a lado que comparten la zona de arriba.
  machine2: createLayout({
    id: 'machine2',
    name: 'Púlsar',
    mode: 'versus',
    accent: PALETTE.magenta,
    halves: [
      placeHalf(PLAYFIELD, { player: 0, side: -1, accent: PALETTE.blue }),
      placeHalf(PLAYFIELD, { player: 1, side: 1, accent: PALETTE.red }),
    ],
    extraBumpers: [
      { id: 'center-tri', pos: [0, -2.4], radius: 0.9, sides: 3, points: 250, color: PALETTE.violet },
    ],
    // Isla central maciza entre las dos mesas: tapa el hueco del medio (punta en rombo arriba).
    extraWalls: [
      { id: 'island-cap', pos: [0, WALL_HEIGHT / 2, 0.45], size: [1.2, WALL_HEIGHT, 1.2], rotY: Math.PI / 4, color: PALETTE.violet, rail: true },
      { id: 'island-top', pos: [0, WALL_HEIGHT / 2, 3.2], size: [1.8, WALL_HEIGHT, 5.6], rotY: 0, color: PALETTE.violet },
      { id: 'island-low', pos: [0, WALL_HEIGHT / 2, 7.9], size: [3.6, WALL_HEIGHT, 3.8], rotY: 0, color: PALETTE.violet },
    ],
    core: { pos: [0, -6.2], radius: 1.25 },
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
  #tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
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

  /**
   * Punto de la mesa bajo el cursor/dedo, en coordenadas del layout ([x, z]
   * con el centro de la mesa en 0,0). Sirve para saber qué flipper se toca
   * sin depender de cómo esté girada la cámara.
   * @returns {{ x: number, z: number } | null}
   */
  pickTablePoint(ndcX, ndcY) {
    if (!this.#level) return null;
    this.#raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    const hit = this.#raycaster.ray.intersectPlane(this.#tablePlane, this.#tmpVec);
    if (!hit) return null;
    const origin = this.#level.group.position;
    return { x: hit.x - origin.x, z: hit.z - origin.z };
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

  /**
   * Pose cenital (vista de pájaro) sobre la mesa de una máquina.
   * En multijugador la mesa es doble de ancha: J1 a la izquierda y J2 a la derecha.
   */
  #getTopDownPose(machineId) {
    const base = this.#machines.get(machineId).basePosition;
    const { table } = LEVEL_LAYOUTS[machineId];
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    // Margen extra arriba/abajo: deja sitio al HUD (puntuaciones y ayuda de teclas).
    const heightForLength = (table.length / 2 + 3) / tanHalf;
    const heightForWidth = (table.width / 2 + 1.5) / (tanHalf * this.camera.aspect);
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
    const { group, meshes, bumpers, portal, ball, trail } = this.#buildLevelMeshes(layout);

    group.position.copy(machine.basePosition);
    group.scale.setScalar(0.55);
    this.scene.add(group);
    // Se ocultan todos los cubos del menú: la mesa doble es larga y podría taparse con el otro.
    for (const { group: cube } of this.#machines.values()) cube.visible = false;
    this.#level = { machineId, group, bumpers, portal, ball, trail };

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
    const { group } = this.#level;
    gsap.killTweensOf(group.scale);
    this.scene.remove(group);
    disposeObject(group);
    for (const { group: cube } of this.#machines.values()) cube.visible = true;
    this.#level = null;
    this.#activeMachineId = null;
  }

  /** Destello de un bumper al recibir un golpe. */
  flashBumper(id) {
    const bumper = this.#level?.bumpers.get(id);
    if (bumper) bumper.flash = 1;
  }

  /** Habilidad Ninja: activa/desactiva el rastro que deja la bola invisible. */
  setBallTrail(active) {
    const trail = this.#level?.trail;
    if (!trail) return;
    trail.active = active;
    trail.points.visible = active;
    if (active) {
      // Se rellena con la posición actual para que el rastro no salga del origen.
      const { x, y, z } = this.#level.ball.position;
      for (let i = 0; i < trail.positions.length; i += 3) trail.positions.set([x, y, z], i);
      trail.points.geometry.attributes.position.needsUpdate = true;
    }
  }

  /** Destello del portal central cuando la bola cruza de una mesa a otra (multijugador). */
  flashPortal() {
    if (this.#level?.portal) this.#level.portal.flash = 1;
  }

  #buildLevelMeshes(layout) {
    const group = new THREE.Group();
    const accent = layout.accent;
    const bumpers = new Map();

    // Materiales de pared por color (cada mesa lleva el de su jugador).
    const wallMaterials = new Map();
    const wallMaterialsFor = (color) => {
      if (!wallMaterials.has(color)) {
        wallMaterials.set(color, {
          wall: new THREE.MeshStandardMaterial({ color: PALETTE.panel, emissive: color, emissiveIntensity: 0.3, metalness: 0.4, roughness: 0.5 }),
          edge: new THREE.LineBasicMaterial({ color }),
        });
      }
      return wallMaterials.get(color);
    };
    // Raíles cromados como los de las máquinas reales.
    const railMaterial = new THREE.MeshStandardMaterial({ color: 0xd8dcf0, emissive: 0x2a2a44, metalness: 0.95, roughness: 0.22 });

    // --- Mesa ------------------------------------------------------------
    const { table } = layout;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(table.width + 1.4, 0.5, table.length + 1.4),
      new THREE.MeshStandardMaterial({ color: 0x0d0a30, roughness: 0.9 })
    );
    base.position.y = -0.25;
    group.add(base);

    // Una superficie por media mesa, con el color de su jugador.
    for (const half of layout.halves) {
      const surface = new THREE.Mesh(
        new THREE.PlaneGeometry(TABLE.width, TABLE.length),
        new THREE.MeshStandardMaterial({ map: this.#makeTableTexture(half.accent), roughness: 0.6, metalness: 0.1 })
      );
      surface.rotation.x = -Math.PI / 2;
      surface.position.set(half.centerX, 0.01, 0);
      group.add(surface);
    }

    // --- Portal (solo multijugador): línea central de la zona compartida, brilla al cruzar ---
    let portal = null;
    if (layout.core) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false });
      const { pos, radius } = layout.core;
      const mesh = new THREE.Mesh(new THREE.RingGeometry(radius * 0.8, radius, 40), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(pos[0], 0.03, pos[1]);
      group.add(mesh);
      portal = { material, mesh, flash: 0 };
    }

    // --- Paredes y guías ---------------------------------------------------
    for (const wall of layout.walls) {
      const { wall: wallMaterial, edge } = wallMaterialsFor(wall.color ?? accent);
      const geometry = new THREE.BoxGeometry(...wall.size);
      const mesh = new THREE.Mesh(geometry, wallMaterial);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edge));
      if (wall.rail) {
        // Tubo a lo largo de la pared (su eje largo es X, salvo las paredes laterales, que van en Z).
        const alongZ = wall.size[2] > wall.size[0];
        const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, alongZ ? wall.size[2] : wall.size[0], 10), railMaterial);
        rail.rotation.set(alongZ ? Math.PI / 2 : 0, 0, alongZ ? 0 : Math.PI / 2);
        rail.position.y = wall.size[1] / 2 + 0.12;
        mesh.add(rail);
      }
      mesh.position.set(...wall.pos);
      mesh.rotation.y = wall.rotY ?? 0;
      group.add(mesh);
    }

    // --- Bumpers (sides = polígono: triángulo, rombo...) y estrellas -------
    for (const def of layout.bumpers) {
      const material = new THREE.MeshStandardMaterial({ color: 0x120d3a, emissive: def.color, emissiveIntensity: 0.9, roughness: 0.4 });
      if (def.star) {
        const star = new THREE.Mesh(new THREE.OctahedronGeometry(def.radius), material);
        star.scale.y = 0.4;
        star.position.set(def.pos[0], 0.2, def.pos[1]);
        group.add(star);
        bumpers.set(def.id, { material, ring: star, flash: 0 });
        continue;
      }
      const body = new THREE.Mesh(new THREE.CylinderGeometry(def.radius, def.radius, 1.2, def.sides ?? 32), material);
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

    // --- Flippers (grupo en el pivote; la caja se desplaza para girar sobre su extremo) ---
    const flipperMeshes = {};
    for (const def of layout.flippers) {
      const dir = def.side === 'left' ? 1 : -1;
      const flipper = new THREE.Group();

      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(def.length, 0.8, def.thickness),
        new THREE.MeshStandardMaterial({ color: 0x2a1f6b, emissive: def.color, emissiveIntensity: 0.8, roughness: 0.4 })
      );
      arm.position.x = (dir * def.length) / 2;

      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.42, 0.9, 20),
        new THREE.MeshStandardMaterial({ color: 0x2a1f6b, emissive: def.color, emissiveIntensity: 1.2 })
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

    // Rastro de la habilidad Ninja: últimas posiciones de la bola invisible.
    const TRAIL_POINTS = 60;
    const trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    const trailPoints = new THREE.Points(
      trailGeometry,
      new THREE.PointsMaterial({ color: PALETTE.amber, size: 0.22, transparent: true, opacity: 0.55, depthWrite: false })
    );
    trailPoints.visible = false;
    trailPoints.frustumCulled = false;
    group.add(trailPoints);
    const trail = { points: trailPoints, positions: trailPositions, active: false };

    // --- Muelles: cabeza octogonal (como en el modelo) + resorte detrás ------
    const plungerMeshes = {};
    for (const def of layout.plungers) {
      const plunger = new THREE.Group();
      const head = new THREE.Mesh(
        new THREE.CylinderGeometry(def.width / 2, def.width / 2, 0.6, 8),
        new THREE.MeshStandardMaterial({ color: 0x2a1f6b, emissive: def.color, emissiveIntensity: 1.1 })
      );
      head.rotation.x = Math.PI / 2;
      const spring = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1.6, 10), railMaterial);
      spring.rotation.x = Math.PI / 2;
      spring.position.z = 1.1;
      plunger.add(head, spring);
      plunger.position.set(def.pos[0], 0.4, def.pos[1]);
      group.add(plunger);
      plungerMeshes[def.id] = plunger;
    }

    // Luz general: una por mesa, sobre su centro y con su color
    for (const half of layout.halves) {
      const tableLight = new THREE.PointLight(half.accent, 220, 40, 2);
      tableLight.position.set(half.centerX, 10, 0);
      group.add(tableLight);
    }

    return { group, meshes: { ball, flippers: flipperMeshes, plungers: plungerMeshes }, bumpers, portal, ball, trail };
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

      const { trail, ball } = this.#level;
      if (trail.active) {
        trail.positions.copyWithin(3, 0, trail.positions.length - 3);
        trail.positions.set([ball.position.x, ball.position.y, ball.position.z], 0);
        trail.points.geometry.attributes.position.needsUpdate = true;
      }

      const { portal } = this.#level;
      if (portal) {
        portal.flash = Math.max(0, portal.flash - dt * 2.5);
        portal.material.opacity = 0.3 + Math.sin(elapsed * 3) * 0.1 + portal.flash * 0.6;
        portal.mesh.scale.setScalar(1 + portal.flash * 0.5);
      }
    }
  }
}