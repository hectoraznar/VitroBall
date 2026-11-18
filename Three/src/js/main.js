/**
 * src/js/main.js
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
  const target = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(sceneManager.scene, sceneManager.camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.55, 0.25));
  composer.addPass(new OutputPass());
}

const RULES = Object.freeze({ balls: 3, crossPoints: 50, drainBonus: 500, corePoints: 300 });
const VITRO = Object.freeze({ cooldown: { default: 1.2, ninja: 15 }, ninjaTime: 5, tiltShakes: 3, tiltWindow: 6, tiltTime: 3 });
const MULT_CONFIG = Object.freeze({ values: [2, 4, 0.5, 0.25], spawnCooldown: 4, bubbleLife: 10, buffDuration: 10 });

const playerStyles = ['default', 'default'];

const session = {
  mode: 'solo', scores: [0], balls: [RULES.balls], ballSide: 0,
  started: false, over: false, time: 0, ghost: 0, vitro: [],
  activeMultiplier: 1, activeBuffTimer: 0, tableBubble: null, spawnTimer: MULT_CONFIG.spawnCooldown
};

let currentLevel = null;
function refreshHud() { ui.updateScores(session.scores, session.ballSide, session.balls, RULES.balls); }

function startGame() {
  const layout = LEVEL_LAYOUTS[currentLevel.machineId];
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

  session.activeMultiplier = 1;
  session.activeBuffTimer = 0;
  session.tableBubble = null;
  session.spawnTimer = MULT_CONFIG.spawnCooldown;
  sceneManager.hideMultiplier();
  physics.removeMultiplierTrigger();
  ui.updateMultiplierUI(null, 0, false);

  releaseAllFlippers();
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
      state.tilt = VITRO.tiltTime;
      state.shakes = [];
      physics.setTilted(player, true);
    }
  }
  state.cooldown = VITRO.cooldown[style];
}

function tickMultipliers(dt) {
  if (!session.started || session.over) return;

  // 1. Actualizar Buff Activado (y actualizar la UI cada frame)
  if (session.activeBuffTimer > 0) {
    session.activeBuffTimer -= dt;
    if (session.activeBuffTimer <= 0) {
      session.activeMultiplier = 1; // Se acaba el efecto
      session.activeBuffTimer = 0;
      ui.updateMultiplierUI(null, 0, false);
    } else {
      // Actualizamos la UI mientras el buff está activo para que baje el tiempo
      ui.updateMultiplierUI(session.activeMultiplier, session.activeBuffTimer, false);
    }
  }

  // 2. Actualizar Burbuja en la Mesa
  if (session.tableBubble) {
    session.tableBubble.timeLeft -= dt;
    if (session.tableBubble.timeLeft <= 0) {
      // Desaparece sin coger
      session.tableBubble = null;
      sceneManager.hideMultiplier();
      physics.removeMultiplierTrigger();
      session.spawnTimer = MULT_CONFIG.spawnCooldown;

      if (session.activeBuffTimer <= 0) ui.updateMultiplierUI(null, 0, false);
    } else {
      // Solo actualizamos la UI de la burbuja si el jugador NO tiene un buff activo
      if (session.activeBuffTimer <= 0) {
        ui.updateMultiplierUI(session.tableBubble.value, session.tableBubble.timeLeft, true);
      }
    }
  }
  // 3. Spawnear nueva Burbuja si no hay
  else if (session.activeBuffTimer <= 0) {
    session.spawnTimer -= dt;
    if (session.spawnTimer <= 0) {
      const value = MULT_CONFIG.values[Math.floor(Math.random() * MULT_CONFIG.values.length)];

      // --- NUEVAS COORDENADAS SEGURAS ---
      // X: de -2 a +4 (centro-derecha, evitando el carril de la izquierda y las paredes)
      // Z: de -5 a +3 (evitando los flippers y el desagüe)
      const px = -2 + Math.random() * 6;
      const pz = -5 + Math.random() * 8;
      const pos = [px, pz];

      session.tableBubble = { value, timeLeft: MULT_CONFIG.bubbleLife, pos };
      sceneManager.showMultiplier(value, pos);
      physics.setMultiplierTrigger(value, pos);

      ui.updateMultiplierUI(value, MULT_CONFIG.bubbleLife, true);
    }
  }
}

function tickVitro(dt) {
  if (!session.started) return;
  session.time += dt;
  tickMultipliers(dt);

  if (session.ghost > 0) {
    session.ghost -= dt;
    if (session.ghost <= 0) { physics.ghost = false; sceneManager.setBallTrail(false); }
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

function saveRecord(score) {
  const key = `vitroball-best-${session.mode}`;
  let best = 0;
  try { best = Number(localStorage.getItem(key)) || 0; if (score > best) localStorage.setItem(key, String(score)); } catch { }
  return { best: Math.max(best, score), isNew: score > best };
}

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
  ui.showGameOver({ title: `¡Gana el Jugador ${2 - loser}!`, text: `Jugador 1: ${fmt(session.scores[0])}  ·  Jugador 2: ${fmt(session.scores[1])}${record}` });
}

const physics = new PhysicsWorld({
  onBumperHit: (id, points, player) => {
    sceneManager.flashBumper(id);
    if (session.over) return;
    const finalPoints = Math.round(points * session.activeMultiplier);
    session.scores[player] += finalPoints;
    refreshHud();
  },
  onCross: (toPlayer, fromPlayer) => {
    sceneManager.flashPortal();
    session.ballSide = toPlayer;
    if (!session.over) session.scores[fromPlayer] += Math.round(RULES.crossPoints * session.activeMultiplier);
    refreshHud();
  },
  onCore: (fromPlayer) => {
    sceneManager.flashPortal();
    if (!session.over) session.scores[fromPlayer] += Math.round(RULES.corePoints * session.activeMultiplier);
    refreshHud();
  },
  onDrain: (player) => {
    if (session.over) return;
    session.balls[player] -= 1;
    session.ballSide = player;
    refreshHud();
    if (session.balls[player] === 0) endGame(player);
  },
  onMultiplierHit: (value) => {
    if (!session.tableBubble) return;

    // El jugador ha cogido la burbuja
    session.activeMultiplier = value;
    session.activeBuffTimer = MULT_CONFIG.buffDuration;

    // Quitar burbuja de la mesa
    session.tableBubble = null;
    sceneManager.hideMultiplier();
    physics.removeMultiplierTrigger();
    session.spawnTimer = MULT_CONFIG.spawnCooldown;

    // Forzar la actualización inmediata de la UI
    ui.updateMultiplierUI(value, MULT_CONFIG.buffDuration, false);
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
  onStyleChange: (player, style) => { playerStyles[player] = style; },
  onStart: () => beginPlay(),
  onRestart: () => { if (fsm.is(GameState.GAMEPLAY)) startGame(); },
});

let menuReady = false;
function selectMachine(machineId) { if (menuReady && fsm.is(GameState.MENU)) fsm.transitionTo(GameState.TRANSITION, { machineId }); }

fsm.register(GameState.LOADING, {
  async onEnter() {
    ui.showLoading();
    await sceneManager.loadAssets((progress) => ui.setLoadingProgress(progress));
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
      await Promise.all([sceneManager.unloadLevel(), sceneManager.flyToMenu()]);
      ui.showMenu();
    } else {
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
    const arrived = await sceneManager.flyToMachine(machineId);
    if (!arrived) return;
    const meshes = await sceneManager.loadLevel(machineId);
    currentLevel = { machineId, meshes };
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

for (const page of [GameState.HISTORY, GameState.HOW_TO_PLAY]) {
  fsm.register(page, {
    onEnter: () => ui.showPage(page),
    onExit: () => ui.hidePage(),
  });
}

const pointer = new THREE.Vector2();
function toNdc(event) {
  pointer.set((event.clientX / window.innerWidth) * 2 - 1, -(event.clientY / window.innerHeight) * 2 + 1);
  return pointer;
}
const activeTouches = new Map();

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

const sameControl = (a, b) => a && b && a.player === b.player && a.part === b.part;

function pressControl({ player, part }, pressed) {
  if (!session.started) {
    if (pressed && part === 'plunger') beginPlay();
    return;
  }
  if (part === 'vitro') {
    if (pressed) useVitro(player);
  } else if (part === 'plunger') physics.setPlunger(player, pressed);
  else physics.setFlipper(player, part, pressed);
}

function controlAtTouch(event) {
  const point = sceneManager.pickTablePoint(...toNdc(event).toArray());
  if (!point || !currentLevel) return null;
  const { halves } = LEVEL_LAYOUTS[currentLevel.machineId];
  const half = halves.find((h) => h.side * point.x >= 0) ?? halves[0];
  const inLane = point.x > half.lane[0] - 0.5 && point.x < half.lane[1] + 0.3;
  return { player: half.player, part: inLane ? 'plunger' : point.x < half.flipperMidX ? 'left' : 'right' };
}

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
  const stillHeld = [...heldKeys].some((code) => sameControl(keys[code], target));
  pressControl(target, stillHeld);
});

window.addEventListener('blur', releaseAllFlippers);

window.addEventListener('resize', () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  composer?.setSize(width, height);
  sceneManager.onResize(width / height);
});

const timer = new THREE.Timer();
timer.connect(document);
let elapsed = 0;

function frame(timestamp) {
  timer.update(timestamp);
  const dt = Math.min(timer.getDelta(), 0.1);
  if (fsm.isUIPage()) return;
  elapsed += dt;
  sceneManager.update(dt, elapsed);

  if (fsm.is(GameState.GAMEPLAY)) {
    physics.update(dt);
    tickVitro(dt);
  }

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
fsm.start(GameState.LOADING);