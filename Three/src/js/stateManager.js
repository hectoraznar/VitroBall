/**
 * src/js/stateManager.js
 * ---------------------------------------------------------------------------
 * Máquina de Estados Finitos (FSM) de Vitro Ball.
 *
 * Esta clase NO sabe nada de Three.js, del DOM ni de la física. Solo:
 *   1. Define qué estados existen y qué transiciones están permitidas.
 *   2. Ejecuta los handlers onExit(estadoAnterior) -> onEnter(estadoNuevo).
 *   3. Notifica a los listeners externos.
 *
 * Quien da vida a cada estado es main.js, que registra los handlers.
 * ---------------------------------------------------------------------------
 */

export const GameState = Object.freeze({
  LOADING: 'LOADING',
  MENU: 'MENU',
  TRANSITION: 'TRANSITION',
  GAMEPLAY: 'GAMEPLAY',
  HISTORY: 'HISTORY',
  HOW_TO_PLAY: 'HOW_TO_PLAY',
});

/**
 * UI_PAGES: grupo lógico de estados que muestran una página HTML a pantalla
 * completa. Mientras el estado actual pertenezca a este grupo, la escena 3D
 * queda en pausa (no se actualiza ni se renderiza).
 */
export const UI_PAGES = Object.freeze([GameState.HISTORY, GameState.HOW_TO_PLAY]);

/** Tabla de transiciones permitidas: estado actual -> estados destino. */
const ALLOWED_TRANSITIONS = Object.freeze({
  [GameState.LOADING]: [GameState.MENU],
  [GameState.MENU]: [GameState.TRANSITION, GameState.HISTORY, GameState.HOW_TO_PLAY],
  [GameState.TRANSITION]: [GameState.GAMEPLAY, GameState.MENU],
  [GameState.GAMEPLAY]: [GameState.MENU],
  [GameState.HISTORY]: [GameState.MENU],
  [GameState.HOW_TO_PLAY]: [GameState.MENU, GameState.TRANSITION], // botones "Jugar" de cada modo
});

export class StateManager {
  #state = null;
  #previous = null;
  #handlers = new Map(); // estado -> { onEnter, onExit }
  #listeners = new Set(); // (to, from, payload) => void
  #switching = false; // bloqueo mientras se ejecuta onExit

  /** Estado actual. */
  get current() {
    return this.#state;
  }

  /** Estado anterior (null si todavía no hubo transición). */
  get previous() {
    return this.#previous;
  }

  /**
   * Registra los handlers de un estado.
   * @param {string} state
   * @param {{ onEnter?: Function, onExit?: Function }} handlers
   *   onEnter({ from, payload })  /  onExit({ to, payload }). Pueden ser async.
   */
  register(state, handlers = {}) {
    this.#handlers.set(state, handlers);
    return this;
  }

  /** Suscripción a cambios de estado. Devuelve la función para desuscribirse. */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** ¿El estado actual es alguno de los indicados? */
  is(...states) {
    return states.includes(this.#state);
  }

  /** ¿Estamos en una página de UI a pantalla completa (HISTORY / HOW_TO_PLAY)? */
  isUIPage() {
    return UI_PAGES.includes(this.#state);
  }

  /** ¿Se permite pasar del estado actual a `to`? */
  can(to) {
    return !this.#switching && (ALLOWED_TRANSITIONS[this.#state] ?? []).includes(to);
  }

  /** Estado inicial: no valida transición, solo ejecuta onEnter. */
  async start(initialState, payload = {}) {
    this.#state = initialState;
    this.#listeners.forEach((fn) => fn(initialState, null, payload));
    await this.#run(this.#handlers.get(initialState)?.onEnter, { from: null, payload });
  }

  /**
   * Transición a un nuevo estado.
   * Orden: onExit(actual) -> cambio de estado -> listeners -> onEnter(nuevo).
   * @returns {Promise<boolean>} false si la transición no está permitida.
   */
  async transitionTo(to, payload = {}) {
    if (!this.can(to)) {
      console.warn(`[FSM] Transición no permitida: ${this.#state} -> ${to}`);
      return false;
    }

    const from = this.#state;

    // El bloqueo solo cubre la salida del estado: así onEnter puede encadenar
    // otra transición (p. ej. TRANSITION -> GAMEPLAY) sin problemas.
    this.#switching = true;
    try {
      await this.#run(this.#handlers.get(from)?.onExit, { to, payload });
    } finally {
      this.#switching = false;
    }

    this.#previous = from;
    this.#state = to;
    this.#listeners.forEach((fn) => fn(to, from, payload));

    await this.#run(this.#handlers.get(to)?.onEnter, { from, payload });
    return true;
  }

  /** Ejecuta un handler capturando errores para no romper la FSM. */
  async #run(handler, context) {
    if (!handler) return;
    try {
      await handler(context);
    } catch (error) {
      console.error('[FSM] Error en handler de estado:', error);
    }
  }
}