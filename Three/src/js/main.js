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
 *                                    \-> TRANSITION (botón "Jugar" de cada modo)
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
// 2. Sesión de juego (puntuaciones y bolas)
// ===========================================================================

const RULES = Object.freeze({
  balls: 3, // bolas por jugador
  crossPoints: 50, // multijugador: pasar la bola a la mesa rival
  drainBonus: 500, // multijugador: el rival pierde una bola
  corePoints: 300, // multijugador: meter la bola en El Núcleo
});

/**
 * VITRO: habilidad única de cada estilo.
 *   default -> Sacudida: empuja la bola. Abusar (3 en 6 s) provoca TILT: flippers bloqueados 3 s.
 *   ninja   -> la bola se vuelve invisible 5 s y solo deja un rastro.
 */
const VITRO = Object.freeze({
  cooldown: { default: 1.2, ninja: 15 },
  ninjaTime: 5,
  tiltShakes: 3,
  tiltWindow: 6,
  tiltTime: 3,
});

/** Estilo elegido por cada jugador (se recuerda entre partidas). */
const playerStyles = ['default', 'default'];

const session = {
  mode: 'solo',
  scores: [0],
  balls: [RULES.balls],
  ballSide: 0, // jugador en cuya mesa está la bola (se resalta en el HUD)
  started: false, // false mientras se eligen estilos
  over: false,
  time: 0,
  ghost: 0, // segundos de bola invisible (Ninja) que quedan
  vitro: [], // por jugador: { cooldown, tilt, shakes: number[] }
};

/** Mesa en juego: { machineId, meshes } (la rellena TRANSITION). */
let currentLevel = null;

function refreshHud() {
  ui.updateScores(session.scores, session.ballSide, session.balls, RULES.balls);
}

/** (Re)empieza la partida en la mesa actual. */
function startGame() {
  const layout = LEVEL_LAYOUTS[currentLevel.machineId];
  // En multijugador la primera bola sale hacia un jugador al azar.
  const server = layout.players > 1 ? Math.floor(Math.random() * layout.players) : 0;

  session.mode = layout.mode;
  session.scores = Array(layout.players).fill(0);
  session.balls = Array(layout.players).fill(RULES.balls);
  session.ballSide = server;
  session.started = false;
  session.over = false;
  session.time = 0;
  session.ghost = 0;
  session.vitro = Array.from({ length: layout.players }, () => ({ cooldown: 0, tilt: 0, shakes: [] }));

  releaseAllFlippers();
  // La bola no sale hasta que se confirman los estilos.
  physics.buildLevel(layout, currentLevel.meshes, { server, serving: false });
  sceneManager.setBallTrail(false);
  ui.hideGameOver();
  ui.showStylePicker(playerStyles.slice(0, layout.players));
  refreshHud();
}

function beginPlay() {
  if (session.started || session.over) return;
  session.started = true;
  ui.hideStylePicker();
  physics.startServing();
}

/** Usa la habilidad VITRO de un jugador. */
function useVitro(player) {
  const state = session.vitro[player];
  if (!session.started || session.over || !state || state.cooldown > 0 || state.tilt > 0) return;
  const style = playerStyles[player];

  if (style === 'ninja') {
    session.ghost = VITRO.ninjaTime;
    physics.ghost = true;
    sceneManager.setBallTrail(true);
  } else {
    if (!physics.nudge()) return;
    state.shakes = state.shakes.filter((t) => session.time - t < VITRO.tiltWindow);
    state.shakes.push(session.time);
    if (state.shakes.length >= VITRO.tiltShakes) {
      // Penalización por abusar de la vibración.
      state.tilt = VITRO.tiltTime;
      state.shakes = [];
      physics.setTilted(player, true);
    }
  }
  state.cooldown = VITRO.cooldown[style];
}

/** Cuenta atrás de habilidades y TILT (cada frame en partida). */
function tickVitro(dt) {
  if (!session.started) return;
  session.time += dt;
  if (session.ghost > 0) {
    session.ghost -= dt;
    if (session.ghost <= 0) {
      physics.ghost = false;
      sceneManager.setBallTrail(false);
    }
  }
  session.vitro.forEach((state, player) => {
    state.cooldown = Math.max(0, state.cooldown - dt);
    if (state.tilt > 0) {
      state.tilt -= dt;
      if (state.tilt <= 0) physics.setTilted(player, false);
    }
  });
  ui.updateVitro(session.vitro);
}

/** Guarda el mejor marcador local de cada modo. */
function saveRecord(score) {
  const key = `vitroball-best-${session.mode}`;
  let best = 0;
  try {
    best = Number(localStorage.getItem(key)) || 0;
    if (score > best) localStorage.setItem(key, String(score));
  } catch {
    // Sin almacenamiento (modo privado): simplemente no hay récord.
  }
  return { best: Math.max(best, score), isNew: score > best };
}

/** @param {number} loser  Jugador que se ha quedado sin bolas. */
function endGame(loser) {
  session.over = true;
  physics.stopServing();

  const fmt = (n) => n.toLocaleString('es-ES');
  const { best, isNew } = saveRecord(Math.max(...session.scores));
  const record = isNew ? ' · ¡Nuevo récord!' : ` · Récord: ${fmt(best)}`;
  if (session.mode === 'solo') {
    ui.showGameOver({ title: 'Fin de la partida', text: `Puntuación final: ${fmt(session.scores[0])}${record}` });
    return;
  }
  // Victoria instantánea: gana quien aún conserva bolas.
  ui.showGameOver({
    title: `¡Gana el Jugador ${2 - loser}!`,
    text: `Jugador 1: ${fmt(session.scores[0])}  ·  Jugador 2: ${fmt(session.scores[1])}${record}`,
  });
}

// ===========================================================================
// 3. Física, FSM y UI
// ===========================================================================

const physics = new PhysicsWorld({
  onBumperHit: (id, points, player) => {
    sceneManager.flashBumper(id);
    if (session.over) return;
    session.scores[player] += points;
    refreshHud();
  },
  onCross: (toPlayer, fromPlayer) => {
    sceneManager.flashPortal();
    session.ballSide = toPlayer;
    if (!session.over) session.scores[fromPlayer] += RULES.crossPoints;
    refreshHud();
  },
  onCore: (fromPlayer) => {
    sceneManager.flashPortal();
    if (!session.over) session.scores[fromPlayer] += RULES.corePoints;
    refreshHud();
  },
  onDrain: (player) => {
    if (session.over) return;
    session.balls[player] -= 1;
    session.ballSide = player; // la siguiente bola sale hacia quien la perdió
    if (session.mode === 'versus') session.scores[1 - player] += RULES.drainBonus;
    refreshHud();
    if (session.balls[player] === 0) endGame(player);
  },
});

const fsm = new StateManager();

const ui = new UIManager(document.getElementById('ui-root'), {
  onSelectMachine: (id) => selectMachine(id),
  onHoverMachine: (id) => sceneManager.setHovered(id),
  onOpenPage: (page) => fsm.transitionTo(page === 'HISTORY' ? GameState.HISTORY : GameState.HOW_TO_PLAY),
  onPlayMachine: (id) => fsm.transitionTo(GameState.TRANSITION, { machineId: id }),
  onBackToMenu: () => fsm.transitionTo(GameState.MENU),
  onExitGame: () => fsm.transitionTo(GameState.MENU),
  onStyleChange: (player, style) => {
    playerStyles[player] = style;
  },
  onStart: () => beginPlay(),
  onRestart: () => {
    if (fsm.is(GameState.GAMEPLAY)) startGame();
  },
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

    // 2) Al llegar se cargan los placeholders de esa mesa.
    const meshes = await sceneManager.loadLevel(machineId);
    currentLevel = { machineId, meshes };

    // 3) Empieza la partida (GAMEPLAY crea la física).
    await fsm.transitionTo(GameState.GAMEPLAY, { machineId });
  },
});

fsm.register(GameState.GAMEPLAY, {
  onEnter({ payload }) {
    const layout = LEVEL_LAYOUTS[payload.machineId];
    ui.showHud({ players: layout.players, mode: layout.mode });
    startGame();
  },
  async onExit() {
    releaseAllFlippers();
    physics.dispose();
    currentLevel = null;
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
const activeTouches = new Map(); // pointerId -> { player, side }

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

// Un "control" es { player, part } con part = 'left' | 'right' (flippers), 'plunger' (muelle) o 'vitro' (habilidad).
const sameControl = (a, b) => a && b && a.player === b.player && a.part === b.part;

function pressControl({ player, part }, pressed) {
  // Mientras se eligen estilos, la tecla del muelle también empieza la partida.
  if (!session.started) {
    if (pressed && part === 'plunger') beginPlay();
    return;
  }
  if (part === 'vitro') {
    if (pressed) useVitro(player);
  } else if (part === 'plunger') physics.setPlunger(player, pressed);
  else physics.setFlipper(player, part, pressed);
}

/**
 * Control que corresponde a un toque: se mira en qué punto de la mesa cae.
 * El carril de la mesa es el muelle; si no, el lado del flipper.
 * Multijugador: J1 juega en x < 0 y J2 en x > 0.
 */
function controlAtTouch(event) {
  const point = sceneManager.pickTablePoint(...toNdc(event).toArray());
  if (!point || !currentLevel) return null;
  const { halves } = LEVEL_LAYOUTS[currentLevel.machineId];
  const half = halves.find((h) => h.side * point.x >= 0) ?? halves[0];
  const inLane = point.x > half.lane[0] - 0.5 && point.x < half.lane[1] + 0.3;
  return { player: half.player, part: inLane ? 'plunger' : point.x < half.flipperMidX ? 'left' : 'right' };
}

// En partida, tocar la mesa a la izquierda/derecha acciona ese flipper; tocar el carril, el muelle.
canvas.addEventListener('pointerdown', (event) => {
  if (!fsm.is(GameState.GAMEPLAY) || event.pointerType === 'mouse') return;
  const target = controlAtTouch(event);
  if (!target) return;
  activeTouches.set(event.pointerId, target);
  pressControl(target, true);
});
const releaseTouch = (event) => {
  const target = activeTouches.get(event.pointerId);
  if (!target) return;
  activeTouches.delete(event.pointerId);
  const stillHeld = [...activeTouches.values()].some((other) => sameControl(other, target));
  pressControl(target, stillHeld);
};
canvas.addEventListener('pointerup', releaseTouch);
canvas.addEventListener('pointercancel', releaseTouch);

// --- Teclado ---
// Mantener pulsada la tecla del muelle lo tensa; al soltarla, dispara.
const FLIPPER_KEYS = {
  solo: {
    ArrowLeft: { player: 0, part: 'left' },
    KeyA: { player: 0, part: 'left' },
    ArrowRight: { player: 0, part: 'right' },
    KeyD: { player: 0, part: 'right' },
    Space: { player: 0, part: 'plunger' },
    KeyW: { player: 0, part: 'plunger' },
    ArrowUp: { player: 0, part: 'plunger' },
    KeyS: { player: 0, part: 'vitro' },
    ArrowDown: { player: 0, part: 'vitro' },
  },
  // Teclas de la presentación: J1 A/D/W/S, J2 flechas.
  versus: {
    KeyA: { player: 0, part: 'left' },
    KeyD: { player: 0, part: 'right' },
    KeyW: { player: 0, part: 'plunger' },
    KeyS: { player: 0, part: 'vitro' },
    ArrowLeft: { player: 1, part: 'left' },
    ArrowRight: { player: 1, part: 'right' },
    ArrowUp: { player: 1, part: 'plunger' },
    ArrowDown: { player: 1, part: 'vitro' },
  },
};
const heldKeys = new Set();

function currentFlipperKeys() {
  return currentLevel ? FLIPPER_KEYS[LEVEL_LAYOUTS[currentLevel.machineId].mode] : {};
}

function releaseAllFlippers() {
  heldKeys.clear();
  activeTouches.clear();
  physics.releaseFlippers();
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') {
    if (fsm.is(GameState.GAMEPLAY, GameState.HISTORY, GameState.HOW_TO_PLAY)) fsm.transitionTo(GameState.MENU);
    return;
  }

  const target = currentFlipperKeys()[event.code];
  if (!target || !fsm.is(GameState.GAMEPLAY)) return;
  event.preventDefault();
  if (event.repeat) return;
  heldKeys.add(event.code);
  pressControl(target, true);
});

window.addEventListener('keyup', (event) => {
  const keys = currentFlipperKeys();
  const target = keys[event.code];
  if (!target) return;
  heldKeys.delete(event.code);
  // El control sigue activo si queda pulsada otra tecla del mismo (A + ←).
  const stillHeld = [...heldKeys].some((code) => sameControl(keys[code], target));
  pressControl(target, stillHeld);
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

  if (fsm.is(GameState.GAMEPLAY)) {
    physics.update(dt);
    tickVitro(dt);
  }

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