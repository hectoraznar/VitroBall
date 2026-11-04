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
 * hacia -Y (para apoyarse en el suelo) tiene una componente +Z que empuja la
 * bola hacia los flippers.
 * ---------------------------------------------------------------------------
 */

import * as CANNON from 'cannon-es';

// --- Parámetros de ajuste (tócalos para cambiar la "sensación" del juego) ---
export const PHYSICS_CONFIG = Object.freeze({
  fixedStep: 1 / 120, // paso fijo: estable y evita que la bola atraviese paredes
  gravityY: -30, // mantiene la bola pegada al suelo
  gravityZ: 18, // "inclinación" de la mesa: tira de la bola hacia el jugador
  maxBallSpeed: 42, // límite de velocidad (evita túneles de colisión)
  bumperKick: 15, // impulso extra al chocar contra un bumper
  flipperSpeedUp: 16, // rad/s al pulsar
  flipperSpeedDown: 9, // rad/s al soltar
  spawnDelay: 0.7, // segundos antes de lanzar la bola
  drainZMargin: 0.6, // la bola se da por perdida si z > mitad de la mesa - margen
  stuckTime: 2.5, // segundos casi parada antes de que el "auto-tilt" la sacuda
  stuckSpeed: 0.4, // por debajo de esta velocidad se considera parada
});

const AXIS_Y = new CANNON.Vec3(0, 1, 0);
const AXIS_X = new CANNON.Vec3(1, 0, 0);
const Q_TILT = new CANNON.Quaternion();
const Q_YAW = new CANNON.Quaternion();

export class PhysicsWorld {
  /**
   * @param {{ onBumperHit?: (id: string, points: number) => void,
   *           onDrain?: () => void }} callbacks
   */
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.world = null;
    this.ball = null;
    this.ballMesh = null;
    this.flippers = [];
    this.layout = null;

    this._accumulator = 0;
    this._spawnTimer = 0;
    this._ballInPlay = false;
    this._pendingKicks = [];
    this._idleTime = 0;
  }

  /** ¿Hay un nivel construido? */
  get isActive() {
    return this.world !== null;
  }

  /**
   * Construye el mundo físico de una mesa.
   * @param {object} layout  Layout del nivel (datos puros).
   * @param {{ ball: THREE.Object3D, flippers: Record<string, THREE.Object3D> }} meshes
   */
  buildLevel(layout, meshes) {
    this.dispose();
    this.layout = layout;
    this.ballMesh = meshes.ball;

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
    this.#createRamps(layout);
    this.#createFlippers(layout, meshes.flippers);
    this.#createBall(layout);

    // La bola espera un instante antes de caer: así el jugador la ve aparecer.
    this.#parkBall(PHYSICS_CONFIG.spawnDelay);
  }

  /** Pulsa/suelta un flipper. side: 'left' | 'right' */
  setFlipper(side, pressed) {
    for (const flipper of this.flippers) {
      if (flipper.side === side) flipper.pressed = pressed;
    }
  }

  /** Avanza la simulación `dt` segundos con pasos fijos. */
  update(dt) {
    if (!this.world) return;

    const step = PHYSICS_CONFIG.fixedStep;
    this._accumulator += Math.min(dt, 0.05);

    while (this._accumulator >= step) {
      this._accumulator -= step;

      // Bola "aparcando" tras un desagüe o al empezar.
      if (!this._ballInPlay) {
        this._spawnTimer -= step;
        if (this._spawnTimer <= 0) this.#launchBall();
      }

      this.#stepFlippers(step);
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
      const body = new CANNON.Body({ mass: 0, material: this.mats.bumper });
      // En cannon-es el eje del cilindro ya es Y (vertical), como necesitamos.
      body.addShape(new CANNON.Cylinder(bumper.radius, bumper.radius, height, 20));
      body.position.set(bumper.pos[0], height / 2, bumper.pos[1]);
      body.userData = { type: 'bumper', id: bumper.id, points: bumper.points };
      this.world.addBody(body);
    }
  }

  #createRamps({ ramps }) {
    for (const ramp of ramps) {
      const [width, thickness, length] = ramp.size;
      // Centro calculado para que el extremo bajo toque el suelo (y = 0).
      const y = (thickness / 2) * Math.cos(ramp.angle) + (length / 2) * Math.sin(ramp.angle);
      const body = new CANNON.Body({ mass: 0, material: this.mats.wall });
      body.addShape(new CANNON.Box(new CANNON.Vec3(width / 2, thickness / 2, length / 2)));
      body.position.set(ramp.pos[0], y, ramp.pos[1]);
      // Orientación = giro en diagonal (Y) aplicado sobre la inclinación (X).
      Q_TILT.setFromAxisAngle(AXIS_X, ramp.angle);
      Q_YAW.setFromAxisAngle(AXIS_Y, ramp.yaw ?? 0);
      Q_YAW.mult(Q_TILT, body.quaternion);
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
      this.world.addBody(body);

      this.flippers.push({
        id: def.id,
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

  #createBall({ ball }) {
    this.ball = new CANNON.Body({
      mass: 1,
      material: this.mats.ball,
      shape: new CANNON.Sphere(ball.radius),
      linearDamping: 0.02,
      angularDamping: 0.3,
    });
    this._onBallCollide = (event) => {
      if (event.body?.userData?.type === 'bumper') this._pendingKicks.push(event.body);
    };
    this.ball.addEventListener('collide', this._onBallCollide);
  }

  // ------------------------------------------------------------------------
  // Bucle
  // ------------------------------------------------------------------------

  #stepFlippers(dt) {
    for (const f of this.flippers) {
      const target = f.pressed ? f.activeAngle : f.restAngle;
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

  #afterStep() {
    const { ball } = this;
    if (!this._ballInPlay) return;

    // Impulsos de los bumpers (se aplican tras el paso para no pelear con el solver).
    for (const bumper of this._pendingKicks) {
      const dx = ball.position.x - bumper.position.x;
      const dz = ball.position.z - bumper.position.z;
      const len = Math.hypot(dx, dz) || 1;
      ball.velocity.x += (dx / len) * PHYSICS_CONFIG.bumperKick;
      ball.velocity.z += (dz / len) * PHYSICS_CONFIG.bumperKick;
      this.callbacks.onBumperHit?.(bumper.userData.id, bumper.userData.points);
    }
    this._pendingKicks.length = 0;

    // Límite de velocidad
    const speed = ball.velocity.length();
    if (speed > PHYSICS_CONFIG.maxBallSpeed) ball.velocity.scale(PHYSICS_CONFIG.maxBallSpeed / speed, ball.velocity);

    // Auto-tilt: si la bola lleva un rato casi parada (atascada), se le da una sacudida.
    if (speed < PHYSICS_CONFIG.stuckSpeed) this._idleTime += PHYSICS_CONFIG.fixedStep;
    else this._idleTime = 0;
    if (this._idleTime > PHYSICS_CONFIG.stuckTime) {
      ball.velocity.x += (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 3);
      ball.velocity.z -= 6;
      this._idleTime = 0;
    }

    // Desagüe (cae por debajo de los flippers) o bola fuera de la mesa
    const { table } = this.layout;
    const drained = ball.position.z > table.length / 2 - PHYSICS_CONFIG.drainZMargin;
    const escaped = ball.position.y < -3 || Math.abs(ball.position.x) > table.width / 2 + 1.5 || ball.position.z < -table.length / 2 - 1.5;
    if (drained || escaped) {
      this.callbacks.onDrain?.();
      this.#parkBall(PHYSICS_CONFIG.spawnDelay + 0.5);
    }
  }

  /** Copia el estado físico a los meshes (solo lo que se mueve). */
  #syncMeshes() {
    if (this.ballMesh && this.ball) {
      this.ballMesh.visible = this._ballInPlay;
      this.ballMesh.position.copy(this.ball.position);
      this.ballMesh.quaternion.copy(this.ball.quaternion);
    }
    for (const f of this.flippers) {
      f.mesh?.position.copy(f.body.position);
      f.mesh?.quaternion.copy(f.body.quaternion);
    }
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

  /** Coloca la bola en el punto de salida y la deja caer por gravedad. */
  #launchBall() {
    const { ball: ballDef } = this.layout;
    const { ball } = this;

    ball.position.set(ballDef.spawn[0], ballDef.radius, ballDef.spawn[1]);
    ball.velocity.set((Math.random() - 0.5) * 6, 0, 0); // pequeña variación para que no sea siempre igual
    ball.angularVelocity.set(0, 0, 0);
    ball.quaternion.set(0, 0, 0, 1);

    this.world.addBody(ball);
    this._ballInPlay = true;
  }
}