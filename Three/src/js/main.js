/**
 * src/js/main.js
 * ---------------------------------------------------------------------------
 * Punto de entrada y "raíz de composición" de Vitro Ball.
 *
 * Aquí se crean los módulos, se conectan entre sí y se registra qué hace cada
 * estado de la FSM. La lógica concreta vive en cada módulo:
 *
 *   StateManager  -> reglas de transición entre estados
 *   SceneManager  -> todo lo 3D (escena, cámara, placeholders)
 *   PhysicsWorld  -> Cannon-es
 *   UIManager     -> todo el DOM superpuesto
 *
 * Flujo:  LOADING -> MENU -> TRANSITION -> GAMEPLAY
 *                      \-> HISTORY / HOW_TO_PLAY (escena 3D en pausa)
 * ---------------------------------------------------------------------------
 */

import '../style.css';

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { StateManager, GameState } from './stateManager.js';
import { SceneManager, LEVEL_LAYOUTS, MACHINE_IDS } from './sceneManager.js';
import { PhysicsWorld } from './physics.js';
import { UIManager } from './uiManager.js';

// ===========================================================================
// 1. Renderer + post-procesado (bloom para el efecto neón)
// ===========================================================================

// Bloom activado por defecto. Para probar sin él (equipos lentos): http://localhost:5173/?bloom=0
const USE_BLOOM = new URLSearchParams(window.location.search).get('bloom') !== '0';

const canvas = document.getElementById('webgl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !USE_BLOOM, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const sceneManager = new SceneManager({ aspect: window.innerWidth / window.innerHeight });

let composer = null;
if (USE_BLOOM) {
  // Con post-procesado se pierde el antialiasing del canvas, así que el
  // render target del composer lleva MSAA (samples: 4).
  const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    type: THREE.HalfFloatType,
    samples: 4,
  });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(sceneManager.scene, sceneManager.camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.55, 0.25));
  composer.addPass(new OutputPass());
}

// ===========================================================================
// 2. Sesión de juego (puntuaciones y turnos)
// ===========================================================================

const session = { players: 1, scores: [0], current: 0 };

function startSession(players) {
  session.players = players;
  session.scores = Array(players).fill(0);
  session.current = 0;
}

// ===========================================================================
// 3. Física, FSM y UI
// ===========================================================================

const physics = new PhysicsWorld({
  onBumperHit: (id, points) => {
    session.scores[session.current] += points;
    sceneManager.flashBumper(id);
    ui.updateScores(session.scores, session.current);
  },
  onDrain: () => {
    // En 2 Players, al perder la bola pasa el turno al otro jugador.
    if (session.players === 2) session.current = (session.current + 1) % 2;
    ui.updateScores(session.scores, session.current);
  },
});

const fsm = new StateManager();

const ui = new UIManager(document.getElementById('ui-root'), {
  onSelectMachine: (id) => selectMachine(id),
  onHoverMachine: (id) => sceneManager.setHovered(id),
  onOpenPage: (page) => fsm.transitionTo(page === 'HISTORY' ? GameState.HISTORY : GameState.HOW_TO_PLAY),
  onBackToMenu: () => fsm.transitionTo(GameState.MENU),
  onExitGame: () => fsm.transitionTo(GameState.MENU),
});

/**
 * El menú solo acepta clics cuando ya terminó su animación de entrada; así no
 * se puede elegir una máquina a mitad de un vuelo de cámara.
 */
let menuReady = false;

/** Inicia la transición hacia una máquina (solo desde el menú). */
function selectMachine(machineId) {
  if (menuReady && fsm.is(GameState.MENU)) fsm.transitionTo(GameState.TRANSITION, { machineId });
}

// ===========================================================================
// 4. Qué hace cada estado
// ===========================================================================

fsm.register(GameState.LOADING, {
  async onEnter() {
    ui.showLoading();
    await sceneManager.loadAssets((progress) => ui.setLoadingProgress(progress));

    // El canvas aparece mientras la pantalla de carga se desvanece (fundido cruzado).
    const hidingLoader = ui.hideLoading();
    ui.revealScene();
    await hidingLoader;

    await fsm.transitionTo(GameState.MENU);
  },
});

fsm.register(GameState.MENU, {
  async onEnter({ from }) {
    menuReady = false;
    if (from === GameState.LOADING) {
      ui.showMenu();
      await sceneManager.playIntro();
    } else if (from === GameState.GAMEPLAY) {
      // Sale de la mesa: cámara de vuelta al menú y la mesa se pliega sobre el cubo.
      await Promise.all([sceneManager.unloadLevel(), sceneManager.flyToMenu()]);
      ui.showMenu();
    } else {
      // Viene de una página de UI: la escena sigue tal cual estaba.
      ui.showMenu();
    }
    menuReady = true;
  },
  async onExit() {
    menuReady = false;
    sceneManager.setHovered(null);
    ui.setCursor('default');
    await ui.hideMenu();
  },
});

fsm.register(GameState.TRANSITION, {
  async onEnter({ payload }) {
    const { machineId } = payload;

    // 1) La cámara vuela hasta la vista de pájaro sobre la máquina elegida.
    const arrived = await sceneManager.flyToMachine(machineId);
    if (!arrived) return;

    // 2) Al llegar se cargan los placeholders de esa mesa y se crea su física.
    const meshes = await sceneManager.loadLevel(machineId);
    physics.buildLevel(LEVEL_LAYOUTS[machineId], meshes);

    // 3) Empieza la partida.
    await fsm.transitionTo(GameState.GAMEPLAY, { machineId });
  },
});

fsm.register(GameState.GAMEPLAY, {
  onEnter({ payload }) {
    const layout = LEVEL_LAYOUTS[payload.machineId];
    startSession(layout.players);
    ui.showHud({ players: layout.players });
    ui.updateScores(session.scores, session.current);
  },
  async onExit() {
    releaseAllFlippers();
    physics.dispose();
    await ui.hideHud();
  },
});

// HISTORY y HOW_TO_PLAY comparten comportamiento: página HTML + escena 3D en pausa
// (la pausa la aplica el bucle de animación con fsm.isUIPage()).
for (const page of [GameState.HISTORY, GameState.HOW_TO_PLAY]) {
  fsm.register(page, {
    onEnter: () => ui.showPage(page),
    onExit: () => ui.hidePage(),
  });
}

// ===========================================================================
// 5. Entrada del usuario
// ===========================================================================

const pointer = new THREE.Vector2();

function toNdc(event) {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  return pointer;
}

// --- Ratón / toque sobre el canvas ---
const activeTouches = new Map(); // pointerId -> 'left' | 'right'

canvas.addEventListener('pointermove', (event) => {
  if (!menuReady || !fsm.is(GameState.MENU)) return;
  const id = sceneManager.pick(...toNdc(event).toArray());
  sceneManager.setHovered(id);
  ui.setCursor(id ? 'pointer' : 'default');
});

canvas.addEventListener('click', (event) => {
  if (!menuReady || !fsm.is(GameState.MENU)) return;
  const id = sceneManager.pick(...toNdc(event).toArray());
  if (id) selectMachine(id);
});

// En partida, tocar la mitad izquierda/derecha de la pantalla acciona el flipper.
canvas.addEventListener('pointerdown', (event) => {
  if (!fsm.is(GameState.GAMEPLAY) || event.pointerType === 'mouse') return;
  const side = event.clientX < window.innerWidth / 2 ? 'left' : 'right';
  activeTouches.set(event.pointerId, side);
  physics.setFlipper(side, true);
});
const releaseTouch = (event) => {
  const side = activeTouches.get(event.pointerId);
  if (!side) return;
  activeTouches.delete(event.pointerId);
  physics.setFlipper(side, [...activeTouches.values()].includes(side));
};
canvas.addEventListener('pointerup', releaseTouch);
canvas.addEventListener('pointercancel', releaseTouch);

// --- Teclado ---
const FLIPPER_KEYS = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
};
const heldKeys = new Set();

function releaseAllFlippers() {
  heldKeys.clear();
  activeTouches.clear();
  physics.setFlipper('left', false);
  physics.setFlipper('right', false);
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') {
    if (fsm.is(GameState.GAMEPLAY, GameState.HISTORY, GameState.HOW_TO_PLAY)) fsm.transitionTo(GameState.MENU);
    return;
  }

  const side = FLIPPER_KEYS[event.code];
  if (!side || !fsm.is(GameState.GAMEPLAY)) return;
  event.preventDefault();
  heldKeys.add(event.code);
  physics.setFlipper(side, true);
});

window.addEventListener('keyup', (event) => {
  const side = FLIPPER_KEYS[event.code];
  if (!side) return;
  heldKeys.delete(event.code);
  // El flipper sigue activo si queda pulsada la otra tecla de ese mismo lado (A + ←).
  const stillHeld = [...heldKeys].some((code) => FLIPPER_KEYS[code] === side);
  physics.setFlipper(side, stillHeld);
});

// Si la pestaña pierde el foco con una tecla pulsada, no queda el flipper "atascado".
window.addEventListener('blur', releaseAllFlippers);

// ===========================================================================
// 6. Redimensionado
// ===========================================================================

window.addEventListener('resize', () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  composer?.setSize(width, height);
  sceneManager.onResize(width / height);
});

// ===========================================================================
// 7. Bucle de animación
// ===========================================================================

const timer = new THREE.Timer();
timer.connect(document); // ignora el tiempo que la pestaña pasa en segundo plano
let elapsed = 0;

function frame(timestamp) {
  // Se consume siempre el delta: al salir de una pausa no hay un salto brusco de tiempo.
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);

  // UI_PAGES: la escena 3D está en pausa (ni se actualiza ni se renderiza).
  if (fsm.isUIPage()) return;

  elapsed += dt;
  sceneManager.update(dt, elapsed);

  if (fsm.is(GameState.GAMEPLAY)) physics.update(dt);

  // Las etiquetas HTML siguen a los placeholders mientras el menú está activo.
  if (fsm.is(GameState.MENU)) {
    for (const id of MACHINE_IDS) {
      const { x, y, visible } = sceneManager.projectToScreen(id, window.innerWidth, window.innerHeight);
      ui.setMachineLabelPosition(id, x, y, visible);
    }
  }

  if (composer) composer.render();
  else renderer.render(sceneManager.scene, sceneManager.camera);
}

renderer.setAnimationLoop(frame);

// ===========================================================================
// 8. Arranque
// ===========================================================================

fsm.start(GameState.LOADING);