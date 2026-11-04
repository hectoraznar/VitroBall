/**
 * src/js/loadingScreen.js
 * ---------------------------------------------------------------------------
 * Pantalla de carga: el título "Vitro Ball" donde la "o" de "Vitro" es un aro
 * neón (un agujero) y dentro rebota una bola.
 *
 * El rebote es una mini simulación 2D (gravedad + colisión contra un círculo),
 * por eso las trayectorias son parábolas reales y no una animación en bucle.
 * Todo vive en el DOM: no usa Three.js.
 * ---------------------------------------------------------------------------
 */

const RESTITUTION = 0.86; // energía que conserva la bola en cada choque
const GRAVITY_FACTOR = 16; // gravedad = radio del aro * factor (escala con la tipografía)

export class LoadingScreen {
  #root;
  #ring;
  #ball;
  #fill;
  #percent;
  #bar;

  #rafId = 0;
  #lastTime = 0;
  #metrics = { R: 0, r: 0 }; // radio útil del aro y radio de la bola, en px
  #pos = { x: 0, y: 0 };
  #vel = { x: 0, y: 0 };
  #resizeObserver = null;
  #reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** @param {HTMLElement} container Elemento donde se inserta la pantalla. */
  constructor(container) {
    this.#root = document.createElement('div');
    this.#root.className = 'loading';
    this.#root.innerHTML = `
      <div class="loading__stars" aria-hidden="true"></div>
      <h1 class="loading__title" aria-label="Vitro Ball">
        <span aria-hidden="true">Vitr<span class="loading__o"><span class="loading__ball"></span></span></span>
        <span aria-hidden="true">Ball</span>
      </h1>
      <div class="loading__progress">
        <div class="loading__track" role="progressbar" aria-label="Progreso de carga"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="loading__fill"></div>
        </div>
        <span class="loading__percent">Cargando 0%</span>
      </div>
    `;
    container.appendChild(this.#root);

    this.#ring = this.#root.querySelector('.loading__o');
    this.#ball = this.#root.querySelector('.loading__ball');
    this.#fill = this.#root.querySelector('.loading__fill');
    this.#percent = this.#root.querySelector('.loading__percent');
    this.#bar = this.#root.querySelector('.loading__track');
  }

  /** Arranca la animación de la bola. */
  start() {
    this.#measure();

    // Si cambia el tamaño de la tipografía (resize), se recalculan las medidas.
    this.#resizeObserver = new ResizeObserver(() => this.#measure());
    this.#resizeObserver.observe(this.#ring);

    if (this.#reducedMotion) {
      // Accesibilidad: sin movimiento, la bola queda reposando abajo del aro.
      this.#pos = { x: 0, y: this.#metrics.R - this.#metrics.r };
      this.#render();
      return;
    }

    this.#launch();
    this.#lastTime = performance.now();
    this.#rafId = requestAnimationFrame(this.#tick);
  }

  /** @param {number} progress Valor entre 0 y 1. */
  setProgress(progress) {
    const p = Math.min(1, Math.max(0, progress));
    const pct = Math.round(p * 100);
    this.#fill.style.transform = `scaleX(${p})`;
    this.#percent.textContent = `Cargando ${pct}%`;
    this.#bar.setAttribute('aria-valuenow', String(pct));
  }

  /** Desvanece la pantalla y se limpia. Resuelve cuando termina el fundido. */
  hide() {
    return new Promise((resolve) => {
      this.#root.classList.add('is-leaving');
      // Margen de seguridad por si transitionend no llega a dispararse.
      setTimeout(() => {
        this.destroy();
        resolve();
      }, 800);
    });
  }

  /** Detiene la animación y elimina el DOM. */
  destroy() {
    cancelAnimationFrame(this.#rafId);
    this.#resizeObserver?.disconnect();
    this.#root.remove();
  }

  // ------------------------------------------------------------------------
  // Simulación 2D (coordenadas relativas al centro del aro, y positiva = abajo)
  // ------------------------------------------------------------------------

  #measure() {
    // clientWidth = área interior del aro (sin el borde neón).
    const R = this.#ring.clientWidth / 2;
    const r = this.#ball.offsetWidth / 2;
    this.#metrics = { R, r };
  }

  /** Lanza la bola hacia arriba con un tiro parabólico. */
  #launch() {
    const { R, r } = this.#metrics;
    const g = R * GRAVITY_FACTOR;
    const reach = (R - r) * 1.75; // altura que alcanzará el rebote
    this.#vel.y = -Math.sqrt(2 * g * reach);
    this.#vel.x = (Math.random() < 0.5 ? -1 : 1) * R * (1.6 + Math.random() * 1.4);
  }

  #tick = (now) => {
    const dt = Math.min((now - this.#lastTime) / 1000, 1 / 30);
    this.#lastTime = now;

    const { R, r } = this.#metrics;
    if (R > 0) {
      const g = R * GRAVITY_FACTOR;
      const limit = R - r;

      // Integración
      this.#vel.y += g * dt;
      this.#pos.x += this.#vel.x * dt;
      this.#pos.y += this.#vel.y * dt;

      // Colisión con la pared circular del aro
      const dist = Math.hypot(this.#pos.x, this.#pos.y);
      if (dist > limit) {
        const nx = this.#pos.x / dist;
        const ny = this.#pos.y / dist;
        this.#pos.x = nx * limit;
        this.#pos.y = ny * limit;

        const vn = this.#vel.x * nx + this.#vel.y * ny; // velocidad hacia la pared
        if (vn > 0) {
          this.#vel.x -= (1 + RESTITUTION) * vn * nx;
          this.#vel.y -= (1 + RESTITUTION) * vn * ny;
        }
      }

      // Si la bola casi se detiene abajo, se relanza para que nunca pare.
      const speed = Math.hypot(this.#vel.x, this.#vel.y);
      if (speed < R * 1.4 && this.#pos.y > limit * 0.6) this.#launch();
    }

    this.#render();
    this.#rafId = requestAnimationFrame(this.#tick);
  };

  #render() {
    this.#ball.style.transform = `translate(${this.#pos.x}px, ${this.#pos.y}px)`;
  }
}