/**
 * src/js/physics.js
 * ---------------------------------------------------------------------------
 * Física de la mesa con Cannon-es.
 *
 * Recibe un "layout" (datos puros, ver LEVEL_LAYOUTS en sceneManager.js) y los
 * meshes que ya creó el SceneManager. Crea los cuerpos físicos y, en cada
 * paso, copia posición/rotación de los cuerpos dinámicos a sus meshes.
 *
 * Convención de ejes (la mesa está plana, vista desde arriba):
 *   +X = derecha   |   +Y = arriba   |   -Z = "arriba" de la pantalla
 *   +Z = hacia el jugador (por ahí está el desagüe)
 *
 * La inclinación real de un pinball se simula con la gravedad: además de caer
 * hacia -Y (para apoyarse en el suelo) tiene una componente Z que empuja la
 * bola hacia los flippers.
 *
 * Multijugador: dos mesas lado a lado (J1 en x < 0, J2 en x > 0) que comparten
 * la zona de arriba. Si la bola pasa por arriba al otro lado, cae en la mesa
 * del rival. Cada mesa tiene su muelle en el carril exterior.
 * ---------------------------------------------------------------------------
 */

import * as CANNON from 'cannon-es';

// --- Parámetros de ajuste (tócalos para cambiar la "sensación" del juego) ---
export const PHYSICS_CONFIG = Object.freeze({
  fixedStep: 1 / 120, // paso fijo: estable y evita que la bola atraviese paredes
  gravityY: -30, // mantiene la bola pegada al suelo
  gravityZ: 26, // "inclinación" de la mesa: tira de la bola hacia el jugador
  maxBallSpeed: 48, // límite de velocidad (evita túneles de colisión)
  bumperKick: 17, // impulso extra al chocar contra un bumper
  flipperSpeedUp: 16, // rad/s al pulsar
  flipperSpeedDown: 9, // rad/s al soltar
  spawnDelay: 0.7, // segundos antes de lanzar la bola
  drainZMargin: 0.6, // la bola se da por perdida si z > mitad de la mesa - margen
  stuckTime: 2.5, // segundos casi parada antes de que el "auto-tilt" la sacuda
  stuckSpeed: 0.4, // por debajo de esta velocidad se considera parada
  crossMargin: 1, // multijugador: la bola "cambia de mesa" al pasar esta distancia del centro
  plungerPull: 0.9, // recorrido del muelle al tensarlo
  plungerPullTime: 1, // segundos para tensarlo del todo
  plungerSpeedMin: 18, // velocidad de disparo sin tensar...
  plungerSpeedMax: 46, // ...y totalmente tensado
  starCooldown: 0.6, // segundos antes de que una estrella vuelva a puntuar
  coreSpeed: 15, // El Núcleo dispara la bola hacia la mesa rival a esta velocidad
  coreCooldown: 1,
});

const AXIS_Y = new CANNON.Vec3(0, 1, 0);

export class PhysicsWorld {
  /**
   * @param {{ onBumperHit?: (id: string, points: number, player: number) => void,
   *           onCore?: (fromPlayer: number) => void,
   *           onCross?: (toPlayer: number, fromPlayer: number) => void,
   *           onDrain?: (player: number) => void }} callbacks
   *   player = índice del jugador (0 = J1, 1 = J2). En solitario siempre 0.
   */
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.world = null;
    this.ball = null;
    this.ballMesh = null;
    this.flippers = [];
    this.plungers = [];
    this.layout = null;

    this._time = 0;
    this._accumulator = 0;
    this._spawnTimer = 0;
    this._ballInPlay = false;
    this._pendingKicks = [];
    this._idleTime = 0;
    this._serving = true; // false al terminar la partida: no se lanzan más bolas
    this._server = 0; // jugador hacia el que sale la próxima bola
    this._ballSide = 0; // mitad en la que está la bola (con margen, ver crossMargin)
    this._lastHitter = null; // último jugador que tocó la bola con un flipper
    this._tilted = new Set(); // jugadores con los flippers bloqueados (TILT)
    this._coreReadyAt = 0;
    this.ghost = false; // habilidad Ninja: la bola se vuelve invisible
  }

  /** ¿Hay un nivel construido? */
  get isActive() {
    return this.world !== null;
  }

  /**
   * Construye el mundo físico de una mesa.
   * @param {object} layout  Layout del nivel (datos puros).
   * @param {{ ball: THREE.Object3D, flippers: Record<string, THREE.Object3D> }} meshes
   * @param {{ server?: number, serving?: boolean }} options
   *   server: jugador hacia el que sale la primera bola. serving: false = espera a startServing().
   */
  buildLevel(layout, meshes, { server = 0, serving = true } = {}) {
    this.dispose();
    this.layout = layout;
    this.ballMesh = meshes.ball;
    this._serving = serving;
    this._server = server;
    this._tilted.clear();
    this.ghost = false;

    const world = new CANNON.World({
      gravity: new CANNON.Vec3(0, PHYSICS_CONFIG.gravityY, PHYSICS_CONFIG.gravityZ),
    });
    world.allowSleep = false;
    world.solver.iterations = 14;
    this.world = world;

    this.#createMaterials();
    this.#createTable(layout);
    this.#createWalls(layout);
    this.#createBumpers(layout);
    this.#createFlippers(layout, meshes.flippers);
    this.#createPlungers(layout, meshes.plungers);
    this.#createBall(layout);

    // La bola espera un instante antes de caer: así el jugador la ve aparecer.
    this.#parkBall(PHYSICS_CONFIG.spawnDelay);
  }

  /**
   * Pulsa/suelta un flipper.
   * @param {number} player  0 = J1, 1 = J2
   * @param {'left'|'right'} side  Desde el punto de vista de ese jugador.
   */
  setFlipper(player, side, pressed) {
    for (const flipper of this.flippers) {
      if (flipper.player === player && flipper.side === side) flipper.pressed = pressed;
    }
  }

  /** Tensa (pressed = true) o suelta el muelle de un jugador. Al soltar, dispara. */
  setPlunger(player, pressed) {
    for (const plunger of this.plungers) {
      if (plunger.player === player && !plunger.firing) plunger.pulling = pressed;
    }
  }

  releaseFlippers() {
    for (const flipper of this.flippers) flipper.pressed = false;
    for (const plunger of this.plungers) plunger.pulling = false;
  }

  startServing() {
    this._serving = true;
  }

  /** Habilidad Default: sacude la mesa y empuja la bola. false si no hay bola que sacudir. */
  nudge() {
    const { ball } = this;
    if (!this._ballInPlay || this.#inLane(ball.position)) return false;
    ball.velocity.x += (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3);
    ball.velocity.z -= 9;
    return true;
  }

  /** TILT: bloquea (o desbloquea) los flippers de un jugador. */
  setTilted(player, tilted) {
    if (tilted) this._tilted.add(player);
    else this._tilted.delete(player);
  }

  /** Fin de partida: la bola actual termina y no sale ninguna más. */
  stopServing() {
    this._serving = false;
  }

  /** Avanza la simulación `dt` segundos con pasos fijos. */
  update(dt) {
    if (!this.world) return;

    const step = PHYSICS_CONFIG.fixedStep;
    this._accumulator += Math.min(dt, 0.05);

    while (this._accumulator >= step) {
      this._accumulator -= step;

      // Bola "aparcando" tras un desagüe o al empezar.
      if (!this._ballInPlay && this._serving) {
        this._spawnTimer -= step;
        if (this._spawnTimer <= 0) this.#launchBall();
      }

      this._time += step;
      this.#stepFlippers(step);
      this.#stepPlungers(step);
      this.world.step(step);
      this.#afterStep();
    }

    this.#syncMeshes();
  }

  /** Libera el mundo físico (al salir de la partida). */
  dispose() {
    if (this.ball) this.ball.removeEventListener('collide', this._onBallCollide);
    this.world = null;
    this.ball = null;
    this.ballMesh = null;
    this.flippers = [];
    this.plungers = [];
    this.layout = null;
    this._pendingKicks = [];
    this._accumulator = 0;
    this._ballInPlay = false;
  }

  // ------------------------------------------------------------------------
  // Construcción
  // ------------------------------------------------------------------------

  #createMaterials() {
    const make = (name) => new CANNON.Material(name);
    this.mats = {
      ball: make('ball'),
      table: make('table'),
      wall: make('wall'),
      bumper: make('bumper'),
      flipper: make('flipper'),
    };
    const pair = (a, b, friction, restitution) =>
      this.world.addContactMaterial(
        new CANNON.ContactMaterial(this.mats[a], this.mats[b], { friction, restitution })
      );

    pair('ball', 'table', 0.04, 0.05);
    pair('ball', 'wall', 0.02, 0.55);
    pair('ball', 'bumper', 0.0, 0.7);
    pair('ball', 'flipper', 0.1, 0.3);
  }

  #createTable({ table }) {
    const half = new CANNON.Vec3(table.width / 2 + 0.6, 0.25, table.length / 2 + 0.6);

    // Suelo: la superficie superior queda en y = 0.
    const floor = new CANNON.Body({ mass: 0, material: this.mats.table });
    floor.addShape(new CANNON.Box(half));
    floor.position.set(0, -0.25, 0);
    this.world.addBody(floor);

    // "Cristal" invisible: evita que la bola salte por encima de las paredes.
    const glass = new CANNON.Body({ mass: 0, material: this.mats.wall });
    glass.addShape(new CANNON.Box(new CANNON.Vec3(half.x, 0.25, half.z)));
    glass.position.set(0, 2.75, 0);
    this.world.addBody(glass);
  }

  #createWalls({ walls }) {
    for (const wall of walls) {
      const body = new CANNON.Body({ mass: 0, material: this.mats.wall });
      body.addShape(new CANNON.Box(new CANNON.Vec3(wall.size[0] / 2, wall.size[1] / 2, wall.size[2] / 2)));
      body.position.set(...wall.pos);
      body.quaternion.setFromAxisAngle(AXIS_Y, wall.rotY ?? 0);
      this.world.addBody(body);
    }
  }

  #createBumpers({ bumpers }) {
    for (const bumper of bumpers) {
      const height = 1.2;
      // Las estrellas son triggers: avisan del contacto pero la bola las atraviesa.
      const body = new CANNON.Body({ mass: 0, material: this.mats.bumper, isTrigger: Boolean(bumper.star) });
      // En cannon-es el eje del cilindro ya es Y (vertical), y sus polígonos
      // (sides = 3, 4...) salen con la misma orientación que en Three.js.
      body.addShape(new CANNON.Cylinder(bumper.radius, bumper.radius, height, bumper.sides ?? 20));
      body.position.set(bumper.pos[0], height / 2, bumper.pos[1]);
      body.userData = { type: 'bumper', id: bumper.id, points: bumper.points, star: Boolean(bumper.star), lastHit: -Infinity };
      this.world.addBody(body);
    }
  }

  /**
   * Flippers: cuerpos KINEMATIC. No los mueven las fuerzas; los rotamos
   * nosotros con una velocidad angular controlada. Cannon usa esa velocidad
   * para transmitir el golpe a la bola.
   */
  #createFlippers({ flippers }, flipperMeshes) {
    for (const def of flippers) {
      const dir = def.side === 'left' ? 1 : -1; // hacia dónde se extiende desde el pivote
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.mats.flipper });

      // El pivote es el origen del cuerpo; la caja se desplaza para que gire sobre su extremo.
      body.addShape(
        new CANNON.Box(new CANNON.Vec3(def.length / 2, 0.4, def.thickness / 2)),
        new CANNON.Vec3((dir * def.length) / 2, 0, 0)
      );
      body.position.set(def.pivot[0], 0.4, def.pivot[1]);
      body.quaternion.setFromAxisAngle(AXIS_Y, def.restAngle);
      body.userData = { type: 'flipper', player: def.player };
      this.world.addBody(body);

      this.flippers.push({
        id: def.id,
        player: def.player,
        side: def.side,
        body,
        mesh: flipperMeshes[def.id],
        angle: def.restAngle,
        restAngle: def.restAngle,
        activeAngle: def.activeAngle,
        pressed: false,
      });
    }
  }

  /**
   * Muelles: cuerpos KINEMATIC en el fondo del carril. Al tensar retroceden
   * despacio (la bola los sigue por la gravedad); al soltar avanzan rápido
   * hasta su posición de reposo y empujan la bola carril arriba.
   */
  #createPlungers({ plungers }, plungerMeshes = {}) {
    for (const def of plungers) {
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.mats.flipper });
      body.addShape(new CANNON.Box(new CANNON.Vec3(def.width / 2, 0.4, 0.3)));
      body.position.set(def.pos[0], 0.4, def.pos[1]);
      this.world.addBody(body);
      this.plungers.push({ player: def.player, body, mesh: plungerMeshes[def.id], restZ: def.pos[1], tension: 0, pulling: false, firing: false });
    }
  }

  #createBall({ ball }) {
    this.ball = new CANNON.Body({
      mass: 1,
      material: this.mats.ball,
      shape: new CANNON.Sphere(ball.radius),
      linearDamping: 0.02,
      angularDamping: 0.3,
    });
    this._onBallCollide = (event) => {
      const data = event.body?.userData;
      if (data?.type === 'bumper') this._pendingKicks.push(event.body);
      else if (data?.type === 'flipper') this._lastHitter = data.player;
    };
    this.ball.addEventListener('collide', this._onBallCollide);
  }

  // ------------------------------------------------------------------------
  // Bucle
  // ------------------------------------------------------------------------

  #stepFlippers(dt) {
    for (const f of this.flippers) {
      const target = f.pressed && !this._tilted.has(f.player) ? f.activeAngle : f.restAngle;
      const diff = target - f.angle;

      if (Math.abs(diff) < 1e-5) {
        f.body.angularVelocity.set(0, 0, 0);
        continue;
      }

      const speed = f.pressed ? PHYSICS_CONFIG.flipperSpeedUp : PHYSICS_CONFIG.flipperSpeedDown;
      const maxStep = speed * dt;

      if (Math.abs(diff) <= maxStep) {
        // Llegó al tope: se fija el ángulo exacto y se detiene.
        f.angle = target;
        f.body.angularVelocity.set(0, 0, 0);
        f.body.quaternion.setFromAxisAngle(AXIS_Y, target);
      } else {
        const delta = Math.sign(diff) * maxStep;
        f.angle += delta;
        f.body.angularVelocity.set(0, delta / dt, 0);
      }
    }
  }

  #stepPlungers(dt) {
    for (const p of this.plungers) {
      const { body } = p;
      if (p.firing) {
        // Disparo: avanza con velocidad (Cannon la usa para empujar la bola) hasta el reposo.
        if (body.position.z <= p.restZ) {
          body.position.z = p.restZ;
          body.velocity.z = 0;
          p.firing = false;
          p.tension = 0;
        }
      } else if (p.pulling) {
        p.tension = Math.min(1, p.tension + dt / PHYSICS_CONFIG.plungerPullTime);
        body.position.z = p.restZ + p.tension * PHYSICS_CONFIG.plungerPull;
      } else if (p.tension > 0) {
        const { plungerSpeedMin: min, plungerSpeedMax: max } = PHYSICS_CONFIG;
        body.velocity.z = -(min + p.tension * (max - min));
        p.firing = true;
      }
    }
  }

  /** ¿La bola está en el carril de algún muelle? */
  #inLane(position) {
    return position.z > -6 && this.layout.halves.some(({ lane }) => position.x > lane[0] && position.x < lane[1]);
  }

  #afterStep() {
    const { ball } = this;
    if (!this._ballInPlay) return;

    // Impulsos de los bumpers (se aplican tras el paso para no pelear con el solver).
    for (const bumper of this._pendingKicks) {
      const data = bumper.userData;
      if (data.star) {
        // Estrella: solo puntos, sin impulso, y no repite mientras la bola sigue encima.
        if (this._time - data.lastHit > PHYSICS_CONFIG.starCooldown) {
          this.callbacks.onBumperHit?.(data.id, data.points, this.#pointsOwner(bumper));
        }
        data.lastHit = this._time;
        continue;
      }
      const dx = ball.position.x - bumper.position.x;
      const dz = ball.position.z - bumper.position.z;
      const len = Math.hypot(dx, dz) || 1;
      ball.velocity.x += (dx / len) * PHYSICS_CONFIG.bumperKick;
      ball.velocity.z += (dz / len) * PHYSICS_CONFIG.bumperKick;
      // Los puntos son de quien golpeó la bola; si nadie la ha tocado aún, del dueño de esa mitad.
      this.callbacks.onBumperHit?.(data.id, data.points, this.#pointsOwner(bumper));
    }
    this._pendingKicks.length = 0;

    // El Núcleo (multijugador): la bola que entra sale disparada hacia la mesa rival.
    const { core } = this.layout;
    if (core && this._time >= this._coreReadyAt && Math.hypot(ball.position.x - core.pos[0], ball.position.z - core.pos[1]) < core.radius) {
      const from = this._ballSide;
      const dir = this.layout.halves.find((h) => h.player !== from).side; // hacia el lado del rival
      ball.velocity.set(dir * PHYSICS_CONFIG.coreSpeed, 0, -3);
      this._coreReadyAt = this._time + PHYSICS_CONFIG.coreCooldown;
      this.callbacks.onCore?.(from);
    }

    // Multijugador: ¿la bola ha pasado a la otra mesa? El margen evita avisos
    // repetidos si la bola titubea justo en la línea central.
    if (this.layout.halves.length > 1 && Math.abs(ball.position.x) > PHYSICS_CONFIG.crossMargin) {
      const side = this.#halfAt(ball.position.x).player;
      if (side !== this._ballSide) {
        const from = this._ballSide;
        this._ballSide = side;
        this.callbacks.onCross?.(side, from);
      }
    }

    // Límite de velocidad
    const speed = ball.velocity.length();
    if (speed > PHYSICS_CONFIG.maxBallSpeed) ball.velocity.scale(PHYSICS_CONFIG.maxBallSpeed / speed, ball.velocity);

    // Auto-tilt: si la bola lleva un rato casi parada (atascada), se le da una sacudida.
    // En el carril del muelle es normal que esté quieta: espera a que el jugador dispare.
    const inLane = this.#inLane(ball.position);
    if (speed < PHYSICS_CONFIG.stuckSpeed && !inLane) this._idleTime += PHYSICS_CONFIG.fixedStep;
    else this._idleTime = 0;
    if (this._idleTime > PHYSICS_CONFIG.stuckTime) {
      ball.velocity.x += (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 3);
      ball.velocity.z -= 6;
      this._idleTime = 0;
    }

    // Desagüe (cae por debajo de los flippers) o bola fuera de la mesa
    const { table } = this.layout;
    const drained = !inLane && ball.position.z > table.length / 2 - PHYSICS_CONFIG.drainZMargin;
    const escaped =
      ball.position.y < -3 || Math.abs(ball.position.x) > table.width / 2 + 1.5 || Math.abs(ball.position.z) > table.length / 2 + 1.5;
    if (drained || escaped) {
      const loser = this.#halfAt(ball.position.x).player;
      this._server = loser; // la siguiente bola sale hacia quien la perdió
      this.callbacks.onDrain?.(loser);
      this.#parkBall(PHYSICS_CONFIG.spawnDelay + 0.5);
    }
  }

  /**
   * Regla de oro: los puntos son de quien juega en esa mitad. Las piezas del
   * centro (x = 0) son de quien golpeó la bola por última vez.
   */
  #pointsOwner(bumper) {
    const central = this.layout.halves.length > 1 && Math.abs(bumper.position.x) < 0.01;
    return central && this._lastHitter !== null ? this._lastHitter : this.#halfAt(bumper.position.x).player;
  }

  /** Mesa en la que cae una coordenada x (J1 a la izquierda, J2 a la derecha; en solitario, la única). */
  #halfAt(x) {
    const { halves } = this.layout;
    return halves.find((half) => half.side * x >= 0) ?? halves[0];
  }

  /** Copia el estado físico a los meshes (solo lo que se mueve). */
  #syncMeshes() {
    if (this.ballMesh && this.ball) {
      this.ballMesh.visible = this._ballInPlay && !this.ghost;
      this.ballMesh.position.copy(this.ball.position);
      this.ballMesh.quaternion.copy(this.ball.quaternion);
    }
    for (const f of this.flippers) {
      f.mesh?.position.copy(f.body.position);
      f.mesh?.quaternion.copy(f.body.quaternion);
    }
    for (const p of this.plungers) p.mesh?.position.copy(p.body.position);
  }

  // ------------------------------------------------------------------------
  // Ciclo de vida de la bola
  // ------------------------------------------------------------------------

  /** Saca la bola del mundo y programa su próximo lanzamiento. */
  #parkBall(delay) {
    if (this._ballInPlay) this.world.removeBody(this.ball);
    this._ballInPlay = false;
    this._spawnTimer = delay;
    this._pendingKicks.length = 0;
    this._idleTime = 0;
  }

  /** Coloca la bola en el punto de salida de quien saca y la deja caer por gravedad. */
  #launchBall() {
    const { ball: ballDef } = this.layout;
    const { spawn } = this.layout.halves[this._server];
    const { ball } = this;

    ball.position.set(spawn[0], ballDef.radius, spawn[1]);
    ball.velocity.set(0, 0, 0); // se queda sobre el muelle hasta que el jugador dispara
    ball.angularVelocity.set(0, 0, 0);
    ball.quaternion.set(0, 0, 0, 1);

    this.world.addBody(ball);
    this._ballInPlay = true;
    this._ballSide = this._server;
    this._lastHitter = null;
  }
}