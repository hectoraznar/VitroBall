/**
 * src/js/uiManager.js
 * ---------------------------------------------------------------------------
 * Toda la interfaz HTML/CSS superpuesta al canvas: pantalla de carga, menú
 * (etiquetas sobre las máquinas + botones), páginas a pantalla completa y HUD.
 *
 * Regla de oro: este archivo NO importa Three.js ni Cannon. Solo recibe datos
 * (posiciones en píxeles, puntuaciones) y avisa con callbacks cuando el
 * usuario hace algo. Quien decide qué ocurre es main.js.
 * ---------------------------------------------------------------------------
 */

import { LoadingScreen } from './loadingScreen.js';

const FADE_MS = 300; // debe coincidir con la transición de opacidad de .layer en style.css

/** Contenido de las páginas a pantalla completa (texto provisional, edítalo a tu gusto). */
const PAGES = {
  HOW_TO_PLAY: {
    title: 'Cómo jugar',
    html: `
      <p>Elige una máquina en el menú. La cámara se coloca sobre la mesa y la bola cae sola: tu trabajo es que no llegue al desagüe.</p>
      <dl class="controls">
        <div><dt><kbd>←</kbd> <kbd>A</kbd></dt><dd>Flipper izquierdo</dd></div>
        <div><dt><kbd>→</kbd> <kbd>D</kbd></dt><dd>Flipper derecho</dd></div>
        <div><dt>Pantalla táctil</dt><dd>Toca la mitad izquierda o derecha</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Salir de la partida y volver al menú</dd></div>
      </dl>
      <p>Los bumpers dan puntos al golpearlos. En 2 Players, los jugadores se turnan cada vez que la bola se pierde.</p>
    `,
  },
  HISTORY: {
    title: 'Historia',
    html: `
      <p>La estación Vitro-9 flota en el borde de una nebulosa que nadie ha cartografiado. Sus tripulantes la construyeron para investigar el vidrio de origen estelar; con el tiempo, también para pasar las noches largas.</p>
      <p>Durante un turno de mantenimiento, un técnico dejó rodar una esfera de vidrio sobre un panel inclinado. El panel la devolvió con una fuerza imposible. Desde entonces, cada mesa de Vitro-9 es una máquina que juega contigo.</p>
      <p>Hoy hay dos activas: Nebulosa, para quien viene solo, y Púlsar, para dos jugadores.</p>
    `,
  },
};

export class UIManager {
  /**
   * @param {HTMLElement} root  Contenedor #ui-root
   * @param {{
   *   onSelectMachine: (id: string) => void,
   *   onHoverMachine: (id: string|null) => void,
   *   onOpenPage: (page: 'HOW_TO_PLAY'|'HISTORY') => void,
   *   onBackToMenu: () => void,
   *   onExitGame: () => void,
   * }} callbacks
   */
  constructor(root, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.loading = null;
    this.labels = new Map(); // id -> HTMLElement

    this.menuLayer = this.#buildMenu();
    this.pageLayer = this.#buildPage();
    this.hudLayer = this.#buildHud();
    root.append(this.menuLayer, this.pageLayer, this.hudLayer);
  }

  // ------------------------------------------------------------------------
  // Pantalla de carga
  // ------------------------------------------------------------------------

  showLoading() {
    this.loading = new LoadingScreen(this.root);
    this.loading.start();
  }

  setLoadingProgress(progress) {
    this.loading?.setProgress(progress);
  }

  async hideLoading() {
    await this.loading?.hide();
    this.loading = null;
  }

  /** Muestra el canvas 3D con un fundido (el CSS hace la transición). */
  revealScene() {
    document.body.classList.add('scene-ready');
  }

  setCursor(cursor) {
    document.body.style.cursor = cursor;
  }

  // ------------------------------------------------------------------------
  // Menú principal
  // ------------------------------------------------------------------------

  #buildMenu() {
    const layer = this.#createLayer('menu');

    const machines = [
      { id: 'machine1', text: '1 Player' },
      { id: 'machine2', text: '2 Players' },
    ];
    for (const { id, text } of machines) {
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'machine-label';
      label.dataset.machine = id;
      label.textContent = text;
      label.addEventListener('click', () => this.callbacks.onSelectMachine(id));
      label.addEventListener('pointerenter', () => this.callbacks.onHoverMachine(id));
      label.addEventListener('pointerleave', () => this.callbacks.onHoverMachine(null));
      label.addEventListener('focus', () => this.callbacks.onHoverMachine(id));
      label.addEventListener('blur', () => this.callbacks.onHoverMachine(null));
      this.labels.set(id, label);
      layer.append(label);
    }

    const nav = document.createElement('nav');
    nav.className = 'menu-nav';
    nav.setAttribute('aria-label', 'Menú principal');
    nav.innerHTML = `
      <button type="button" class="btn" data-page="HOW_TO_PLAY">Cómo Jugar</button>
      <button type="button" class="btn" data-page="HISTORY">Historia</button>
    `;
    nav.addEventListener('click', (event) => {
      const page = event.target.closest('[data-page]')?.dataset.page;
      if (page) this.callbacks.onOpenPage(page);
    });
    layer.append(nav);

    return layer;
  }

  showMenu() {
    return this.#show(this.menuLayer);
  }

  hideMenu() {
    return this.#hide(this.menuLayer);
  }

  /**
   * Coloca la etiqueta de una máquina en coordenadas de pantalla.
   * Se llama cada frame mientras el menú está activo.
   */
  setMachineLabelPosition(id, x, y, visible) {
    const label = this.labels.get(id);
    if (!label) return;
    label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    label.style.visibility = visible ? 'visible' : 'hidden';
  }

  // ------------------------------------------------------------------------
  // Páginas a pantalla completa (Cómo jugar / Historia)
  // ------------------------------------------------------------------------

  #buildPage() {
    const layer = this.#createLayer('page');
    layer.setAttribute('role', 'dialog');
    layer.setAttribute('aria-modal', 'true');
    layer.innerHTML = `
      <article class="page__panel">
        <h2 class="page__title"></h2>
        <div class="page__body"></div>
        <button type="button" class="btn page__back">Volver al Menú</button>
      </article>
    `;
    layer.querySelector('.page__back').addEventListener('click', () => this.callbacks.onBackToMenu());
    return layer;
  }

  showPage(pageId) {
    const page = PAGES[pageId];
    this.pageLayer.querySelector('.page__title').textContent = page.title;
    this.pageLayer.querySelector('.page__body').innerHTML = page.html;
    this.pageLayer.setAttribute('aria-label', page.title);
    this.#show(this.pageLayer);
    this.pageLayer.querySelector('.page__back').focus({ preventScroll: true });
  }

  hidePage() {
    return this.#hide(this.pageLayer);
  }

  // ------------------------------------------------------------------------
  // HUD de partida
  // ------------------------------------------------------------------------

  #buildHud() {
    const layer = this.#createLayer('hud');
    layer.innerHTML = `
      <div class="hud__scores" aria-live="off"></div>
      <button type="button" class="btn hud__exit">Salir</button>
      <p class="hud__hint"><kbd>←</kbd> <kbd>→</kbd> Flippers</p>
    `;
    layer.querySelector('.hud__exit').addEventListener('click', () => this.callbacks.onExitGame());
    return layer;
  }

  /** @param {{ players: number }} info */
  showHud({ players }) {
    const scores = this.hudLayer.querySelector('.hud__scores');
    scores.innerHTML = Array.from(
      { length: players },
      (_, i) => `<div class="score" data-player="${i}">
        <span class="score__label">Jugador ${i + 1}</span>
        <span class="score__value">0</span>
      </div>`
    ).join('');
    return this.#show(this.hudLayer);
  }

  /** @param {number[]} scores  @param {number} activePlayer */
  updateScores(scores, activePlayer) {
    this.hudLayer.querySelectorAll('.score').forEach((el, i) => {
      el.classList.toggle('is-active', i === activePlayer);
      el.querySelector('.score__value').textContent = scores[i].toLocaleString('es-ES');
    });
  }

  hideHud() {
    return this.#hide(this.hudLayer);
  }

  // ------------------------------------------------------------------------
  // Utilidades de capas
  // ------------------------------------------------------------------------

  #createLayer(name) {
    const layer = document.createElement('section');
    layer.className = `layer layer--${name}`;
    layer.hidden = true;
    return layer;
  }

  #show(layer) {
    layer.hidden = false;
    void layer.offsetWidth; // fuerza el reflow para que la transición de opacidad se dispare
    layer.classList.add('is-visible');
  }

  async #hide(layer) {
    layer.classList.remove('is-visible');
    await new Promise((resolve) => setTimeout(resolve, FADE_MS));
    if (!layer.classList.contains('is-visible')) layer.hidden = true;
  }
}