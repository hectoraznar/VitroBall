/**
 * src/js/uiManager.js
 */
import { LoadingScreen } from './loadingScreen.js';

const FADE_MS = 300;

const VITRO_HELP = `
  <h3 class="page__subtitle">¡VITRO! — habilidades</h3>
  <ul class="rules">
    <li>Antes de cada partida, cada jugador elige su estilo.</li>
    <li><strong>Default — Sacudida:</strong> sacude la máquina para mover la bola y llevarla hacia más puntos. Si sacudes 3 veces en 6 s, <strong>TILT</strong>: tus flippers se bloquean 3 s.</li>
    <li><strong>Ninja — Sombra:</strong> durante 5 s la bola se vuelve invisible y solo deja un rastro. Se recarga en 15 s.</li>
  </ul>
`;

const PAGES = {
  HOW_TO_PLAY: {
    title: 'Cómo jugar',
    html: `
      <div class="mode-tabs" role="tablist" aria-label="Modo de juego">
        <button type="button" role="tab" class="mode-tab" data-mode="solo">Solitario</button>
        <button type="button" role="tab" class="mode-tab mode-tab--versus" data-mode="versus">Multijugador</button>
      </div>

      <section class="mode-panel" data-mode-panel="solo" role="tabpanel" aria-label="Solitario">
        <p>Una mesa, una bola y tú. Cada bola empieza en el carril de la izquierda, sobre el muelle: tensa el muelle, suéltalo para lanzarla y mantenla en juego con los flippers.</p>
        <ul class="rules">
          <li>Tienes <strong>3 bolas</strong>.</li>
          <li>Cuanto más tiempo tenses el muelle, más fuerte sale la bola. Si se queda corta, vuelve al muelle y puedes lanzarla otra vez.</li>
          <li>Planetas, lunas y rombo dan <strong>100–150</strong> puntos al golpearlos; cada estrella por la que pasa la bola da <strong>50</strong>.</li>
          <li>Si la bola cae por el desagüe, entre los flippers, pierdes esa bola y sale la siguiente.</li>
          <li>Si la bola se queda parada, la mesa la sacude sola.</li>
          <li>La partida acaba cuando te quedas sin bolas.</li>
        </ul>
        <dl class="controls">
          <div><dt><kbd>←</kbd> <kbd>A</kbd></dt><dd>Flipper izquierdo</dd></div>
          <div><dt><kbd>→</kbd> <kbd>D</kbd></dt><dd>Flipper derecho</dd></div>
          <div><dt><kbd>W</kbd> <kbd>↑</kbd> <kbd>Espacio</kbd></dt><dd>Mantén para tensar el muelle, suelta para lanzar</dd></div>
          <div><dt><kbd>S</kbd> <kbd>↓</kbd></dt><dd>Habilidad VITRO de tu estilo</dd></div>
          <div><dt>Pantalla táctil</dt><dd>Toca el carril para el muelle, o la mitad izquierda / derecha de la mesa para los flippers</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Salir de la partida y volver al menú</dd></div>
        </dl>
        ${VITRO_HELP}
        <button type="button" class="btn btn--play" data-play="machine1">Jugar en solitario</button>
      </section>

      <section class="mode-panel" data-mode-panel="versus" role="tabpanel" aria-label="Multijugador" hidden>
        <p>Dos mesas lado a lado que comparten la zona de arriba. En el centro está <strong>El Núcleo</strong>, un anillo de luz: si la bola entra, sale disparada hacia la mesa de tu rival. Defiende tu mitad y cuélasela al otro.</p>
        <ul class="rules">
          <li>El <strong class="p1">Jugador 1</strong> juega en la mesa de la izquierda (azul) y el <strong class="p2">Jugador 2</strong> en la de la derecha (roja). Se juega a la vez, en el mismo teclado.</li>
          <li>Cada uno lanza sus bolas con el muelle de su carril exterior: mantén para tensar, suelta para lanzar.</li>
          <li>Cada jugador tiene <strong>3 bolas</strong>.</li>
          <li>Regla de oro: los puntos de una mitad son de quien juega en ella. Las piezas del centro puntúan para quien golpeó la bola por última vez.</li>
          <li>Meter la bola en El Núcleo: <strong>+300</strong>. Pasarla a la mesa rival: <strong>+50</strong>.</li>
          <li>Si la bola cae por tu desagüe, pierdes una bola y tu rival gana <strong>+500</strong>. La siguiente bola sale de tu muelle.</li>
          <li>Si te quedas sin bolas y tu rival aún tiene alguna, <strong>gana él al instante</strong>.</li>
        </ul>
        <dl class="controls">
          <div><dt><span class="p1">J1</span> <kbd>A</kbd> <kbd>D</kbd></dt><dd>Flipper izquierdo / derecho</dd></div>
          <div><dt><span class="p1">J1</span> <kbd>W</kbd> <kbd>S</kbd></dt><dd>Muelle (mantén y suelta) / habilidad VITRO</dd></div>
          <div><dt><span class="p2">J2</span> <kbd>←</kbd> <kbd>→</kbd></dt><dd>Flipper izquierdo / derecho</dd></div>
          <div><dt><span class="p2">J2</span> <kbd>↑</kbd> <kbd>↓</kbd></dt><dd>Muelle (mantén y suelta) / habilidad VITRO</dd></div>
          <div><dt>Pantalla táctil</dt><dd>Cada jugador toca su mesa: el carril para el muelle, o el lado del flipper que quiere mover</dd></div>
          <div><dt><kbd>Esc</kbd></dt><dd>Salir de la partida y volver al menú</dd></div>
        </dl>
        ${VITRO_HELP}
        <button type="button" class="btn btn--play" data-play="machine2">Jugar multijugador</button>
      </section>
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
  constructor(root, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.loading = null;
    this.labels = new Map();

    this.menuLayer = this.#buildMenu();
    this.pageLayer = this.#buildPage();
    this.hudLayer = this.#buildHud();
    root.append(this.menuLayer, this.pageLayer, this.hudLayer);
  }

  showLoading() { this.loading = new LoadingScreen(this.root); this.loading.start(); }
  setLoadingProgress(progress) { this.loading?.setProgress(progress); }
  async hideLoading() { await this.loading?.hide(); this.loading = null; }
  revealScene() { document.body.classList.add('scene-ready'); }
  setCursor(cursor) { document.body.style.cursor = cursor; }

  #buildMenu() {
    const layer = this.#createLayer('menu');
    const machines = [
      { id: 'machine1', text: 'Solitario' },
      { id: 'machine2', text: 'Multijugador' },
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

  showMenu() { return this.#show(this.menuLayer); }
  hideMenu() { return this.#hide(this.menuLayer); }

  setMachineLabelPosition(id, x, y, visible) {
    const label = this.labels.get(id);
    if (!label) return;
    label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    label.style.visibility = visible ? 'visible' : 'hidden';
  }

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
    layer.querySelector('.page__body').addEventListener('click', (event) => {
      const tab = event.target.closest('[data-mode]');
      if (tab) this.#selectMode(tab.dataset.mode);
      const play = event.target.closest('[data-play]');
      if (play) this.callbacks.onPlayMachine(play.dataset.play);
    });
    return layer;
  }

  showPage(pageId) {
    const page = PAGES[pageId];
    this.pageLayer.querySelector('.page__title').textContent = page.title;
    this.pageLayer.querySelector('.page__body').innerHTML = page.html;
    this.pageLayer.setAttribute('aria-label', page.title);
    this.#selectMode('solo');
    this.#show(this.pageLayer);
    this.pageLayer.querySelector('.page__back').focus({ preventScroll: true });
  }

  #selectMode(mode) {
    this.pageLayer.querySelectorAll('[data-mode]').forEach((tab) => {
      tab.setAttribute('aria-selected', String(tab.dataset.mode === mode));
    });
    this.pageLayer.querySelectorAll('[data-mode-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.modePanel !== mode;
    });
  }

  hidePage() { return this.#hide(this.pageLayer); }

  #buildHud() {
    const layer = this.#createLayer('hud');
    layer.innerHTML = `
      <div class="hud__scores" aria-live="off"></div>
      <button type="button" class="btn hud__exit">Salir</button>
      <p class="hud__hint"></p>
      <div class="hud__over" role="dialog" aria-labelledby="hud-over-title" hidden>
        <h2 class="hud__over-title" id="hud-over-title"></h2>
        <p class="hud__over-text"></p>
        <div class="hud__over-actions">
          <button type="button" class="btn" data-action="restart">Jugar otra vez</button>
          <button type="button" class="btn" data-action="menu">Menú</button>
        </div>
      </div>
      <div class="hud__over hud__styles" role="dialog" aria-labelledby="hud-styles-title" hidden>
        <h2 class="hud__over-title" id="hud-styles-title">Elige tu estilo</h2>
        <div class="styles__rows"></div>
        <p class="styles__help">
          <strong>Default</strong> — Sacudida: empuja la bola. ¡Si abusas, TILT y tus flippers se bloquean!<br />
          <strong>Ninja</strong> — La bola se vuelve invisible 5 s y solo deja un rastro.
        </p>
        <button type="button" class="btn btn--play" data-action="start">¡A jugar!</button>
      </div>
      <div class="hud__multiplier" hidden>
        <span class="hud__multiplier-label">Multiplicador</span>
        <span class="hud__multiplier-value">x1</span>
        <span class="hud__multiplier-time">0s</span>
      </div>
    `;
    layer.querySelector('[data-action="start"]').addEventListener('click', () => this.callbacks.onStart());
    layer.querySelector('.styles__rows').addEventListener('click', (event) => {
      const button = event.target.closest('[data-style]');
      if (!button) return;
      const player = Number(button.dataset.player);
      this.#markStyle(player, button.dataset.style);
      this.callbacks.onStyleChange(player, button.dataset.style);
    });
    layer.querySelector('.hud__exit').addEventListener('click', () => this.callbacks.onExitGame());
    layer.querySelector('[data-action="restart"]').addEventListener('click', () => this.callbacks.onRestart());
    layer.querySelector('[data-action="menu"]').addEventListener('click', () => this.callbacks.onExitGame());
    return layer;
  }

  showHud({ players, mode }) {
    const scores = this.hudLayer.querySelector('.hud__scores');
    scores.innerHTML = Array.from(
      { length: players },
      (_, i) => `<div class="score" data-player="${i}">
        <span class="score__label">Jugador ${i + 1}</span>
        <span class="score__value">0</span>
        <span class="score__balls" aria-label="Bolas restantes"></span>
        <span class="score__vitro"></span>
      </div>`
    ).join('');
    this.hudLayer.querySelector('.hud__hint').innerHTML =
      mode === 'versus'
        ? '<span class="p1">J1</span> <kbd>A</kbd> <kbd>D</kbd> · <kbd>W</kbd> muelle · <kbd>S</kbd> VITRO &nbsp;|&nbsp; <span class="p2">J2</span> <kbd>←</kbd> <kbd>→</kbd> · <kbd>↑</kbd> muelle · <kbd>↓</kbd> VITRO'
        : '<kbd>←</kbd> <kbd>→</kbd> Flippers · <kbd>Espacio</kbd> Muelle · <kbd>S</kbd> VITRO';
    this.hudLayer.classList.toggle('layer--versus', mode === 'versus');
    this.hideGameOver();
    return this.#show(this.hudLayer);
  }

  updateScores(scores, activePlayer, balls, maxBalls) {
    this.hudLayer.querySelectorAll('.score').forEach((el, i) => {
      el.classList.toggle('is-active', i === activePlayer);
      el.querySelector('.score__value').textContent = scores[i].toLocaleString('es-ES');
      const ballsEl = el.querySelector('.score__balls');
      ballsEl.textContent = '●'.repeat(balls[i]) + '○'.repeat(maxBalls - balls[i]);
      ballsEl.setAttribute('aria-label', `${balls[i]} bolas restantes`);
    });
  }

  updateVitro(states) {
    this.hudLayer.querySelectorAll('.score__vitro').forEach((el, i) => {
      const { cooldown, tilt } = states[i];
      const text = tilt > 0 ? `TILT ${Math.ceil(tilt)}s` : cooldown > 0 ? `VITRO ${Math.ceil(cooldown)}s` : 'VITRO ✓';
      if (el.textContent === text) return;
      el.textContent = text;
      el.classList.toggle('is-ready', tilt <= 0 && cooldown <= 0);
      el.classList.toggle('is-tilt', tilt > 0);
    });
  }

  updateMultiplierUI(value, timeLeft, isBubble) {
    const el = this.hudLayer.querySelector('.hud__multiplier');
    if (!el) return;

    if (value === null) {
      el.hidden = true;
      return;
    }

    el.hidden = false;
    el.querySelector('.hud__multiplier-value').textContent = `x${value}`;
    el.querySelector('.hud__multiplier-time').textContent = `${Math.ceil(timeLeft)}s`;

    const label = el.querySelector('.hud__multiplier-label');
    label.textContent = isBubble ? 'Burbuja en mesa' : 'Efecto activo';

    if (value >= 1) {
      el.style.borderColor = 'var(--neon-cyan)';
      el.style.color = 'var(--neon-cyan)';
    } else {
      el.style.borderColor = '#ff4d6d';
      el.style.color = '#ff4d6d';
    }
  }

  showStylePicker(styles) {
    const panel = this.hudLayer.querySelector('.hud__styles');
    panel.querySelector('.styles__rows').innerHTML = styles
      .map(
        (_, i) => `<div class="styles__row">
          <span class="p${i + 1}">Jugador ${i + 1}</span>
          <button type="button" class="mode-tab" data-player="${i}" data-style="default">Default</button>
          <button type="button" class="mode-tab mode-tab--versus" data-player="${i}" data-style="ninja">Ninja</button>
        </div>`
      )
      .join('');
    styles.forEach((style, i) => this.#markStyle(i, style));
    panel.hidden = false;
    panel.querySelector('[data-action="start"]').focus({ preventScroll: true });
  }

  hideStylePicker() {
    this.hudLayer.querySelector('.hud__styles').hidden = true;
  }

  #markStyle(player, style) {
    this.hudLayer.querySelectorAll(`.styles__rows [data-player="${player}"]`).forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.style === style));
    });
    const label = this.hudLayer.querySelector(`.score[data-player="${player}"] .score__label`);
    if (label) label.textContent = `Jugador ${player + 1} · ${style === 'ninja' ? 'Ninja' : 'Default'}`;
  }

  showGameOver({ title, text }) {
    const panel = this.hudLayer.querySelector('.hud__over');
    panel.querySelector('.hud__over-title').textContent = title;
    panel.querySelector('.hud__over-text').textContent = text;
    panel.hidden = false;
    panel.querySelector('[data-action="restart"]').focus({ preventScroll: true });
  }

  hideGameOver() {
    this.hudLayer.querySelector('.hud__over').hidden = true;
  }

  hideHud() {
    return this.#hide(this.hudLayer);
  }

  #createLayer(name) {
    const layer = document.createElement('section');
    layer.className = `layer layer--${name}`;
    layer.hidden = true;
    return layer;
  }

  #show(layer) {
    layer.hidden = false;
    void layer.offsetWidth;
    layer.classList.add('is-visible');
  }

  async #hide(layer) {
    layer.classList.remove('is-visible');
    await new Promise((resolve) => setTimeout(resolve, FADE_MS));
    if (!layer.classList.contains('is-visible')) layer.hidden = true;
  }
}