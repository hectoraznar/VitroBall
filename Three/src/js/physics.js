/**
 * src/js/physics.js
 */
import * as CANNON from 'cannon-es';

export const PHYSICS_CONFIG = Object.freeze({
  fixedStep: 1 / 120, gravityY: -30, gravityZ: 26, maxBallSpeed: 48,
  bumperKick: 17, flipperSpeedUp: 16, flipperSpeedDown: 9,
  spawnDelay: 0.7, drainZMargin: 0.6, stuckTime: 2.5, stuckSpeed: 0.4,
  crossMargin: 1, plungerPull: 0.9, plungerPullTime: 1, plungerSpeedMin: 18,
  plungerSpeedMax: 46, starCooldown: 0.6, coreSpeed: 15, coreCooldown: 1,
});

const AXIS_Y = new CANNON.Vec3(0, 1, 0);

export class PhysicsWorld {
  constructor(callbacks = {}) {
    this.callbacks = callbacks;
    this.world = null; this.ball = null; this.ballMesh = null;
    this.flippers = []; this.plungers = []; this.layout = null;
    this._time = 0; this._accumulator = 0; this._spawnTimer = 0;
    this._ballInPlay = false; this._pendingKicks = []; this._idleTime = 0;
    this._serving = true; this._server = 0; this._ballSide = 0;
    this._lastHitter = null; this._tilted = new Set(); this._coreReadyAt = 0;
    this.ghost = false;
    this.activeMultiplierBody = null;
  }

  get isActive() { return this.world !== null; }

  buildLevel(layout, meshes, { server = 0, serving = true } = {}) {
    this.dispose();
    this.layout = layout;
    this.ballMesh = meshes.ball;
    this._serving = serving; this._server = server;
    this._tilted.clear(); this.ghost = false;

    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, PHYSICS_CONFIG.gravityY, PHYSICS_CONFIG.gravityZ) });
    world.allowSleep = false; world.solver.iterations = 14; this.world = world;

    this.#createMaterials();
    this.#createTable(layout);
    this.#createWalls(layout);
    this.#createBumpers(layout);
    this.#createBoosts(layout); // <-- NUEVO
    this.#createFlippers(layout, meshes.flippers);
    this.#createPlungers(layout, meshes.plungers);
    this.#createBall(layout);

    this.#parkBall(PHYSICS_CONFIG.spawnDelay);
  }

  setMultiplierTrigger(value, pos) {
    this.removeMultiplierTrigger();
    if (!this.world) return;

    const body = new CANNON.Body({ mass: 0, material: this.mats.bumper, isTrigger: true });
    body.addShape(new CANNON.Cylinder(0.8, 0.8, 1.2, 20));
    body.position.set(pos[0], 0.6, pos[1]);
    body.userData = { type: 'multiplier', value: value, lastHit: -Infinity };
    this.world.addBody(body);
    this.activeMultiplierBody = body;
  }

  removeMultiplierTrigger() {
    if (this.activeMultiplierBody && this.world) {
      this.world.removeBody(this.activeMultiplierBody);
      this.activeMultiplierBody = null;
    }
  }

  setFlipper(player, side, pressed) {
    for (const flipper of this.flippers) {
      if (flipper.player === player && flipper.side === side) flipper.pressed = pressed;
    }
  }

  setPlunger(player, pressed) {
    for (const plunger of this.plungers) {
      if (plunger.player === player && !plunger.firing) plunger.pulling = pressed;
    }
  }

  releaseFlippers() {
    for (const flipper of this.flippers) flipper.pressed = false;
    for (const plunger of this.plungers) plunger.pulling = false;
  }

  startServing() { this._serving = true; }

  nudge() {
    const { ball } = this;
    if (!this._ballInPlay || this.#inLane(ball.position)) return false;
    ball.velocity.x += (Math.random() < 0.5 ? -1 : 1) * (4 + Math.random() * 3);
    ball.velocity.z -= 9;
    return true;
  }

  setTilted(player, tilted) {
    if (tilted) this._tilted.add(player);
    else this._tilted.delete(player);
  }

  stopServing() { this._serving = false; }

  update(dt) {
    if (!this.world) return;
    const step = PHYSICS_CONFIG.fixedStep;
    this._accumulator += Math.min(dt, 0.05);
    while (this._accumulator >= step) {
      this._accumulator -= step;
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

  dispose() {
    if (this.ball) this.ball.removeEventListener('collide', this._onBallCollide);
    this.world = null; this.ball = null; this.ballMesh = null;
    this.flippers = []; this.plungers = []; this.layout = null;
    this._pendingKicks = []; this._accumulator = 0; this._ballInPlay = false;
    this.activeMultiplierBody = null;
  }

  #createMaterials() {
    const make = (name) => new CANNON.Material(name);
    this.mats = {
      ball: make('ball'), table: make('table'), wall: make('wall'), bumper: make('bumper'), flipper: make('flipper'),
    };
    const pair = (a, b, friction, restitution) =>
      this.world.addContactMaterial(new CANNON.ContactMaterial(this.mats[a], this.mats[b], { friction, restitution }));
    pair('ball', 'table', 0.04, 0.05);
    pair('ball', 'wall', 0.02, 0.55);
    pair('ball', 'bumper', 0.0, 0.7);
    pair('ball', 'flipper', 0.1, 0.3);
  }

  #createTable({ table }) {
    const half = new CANNON.Vec3(table.width / 2 + 0.6, 0.25, table.length / 2 + 0.6);
    const floor = new CANNON.Body({ mass: 0, material: this.mats.table });
    floor.addShape(new CANNON.Box(half)); floor.position.set(0, -0.25, 0); this.world.addBody(floor);

    const glass = new CANNON.Body({ mass: 0, material: this.mats.wall });
    glass.addShape(new CANNON.Box(new CANNON.Vec3(half.x, 0.25, half.z)));
    glass.position.set(0, 2.75, 0); this.world.addBody(glass);
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
      const body = new CANNON.Body({ mass: 0, material: this.mats.bumper, isTrigger: Boolean(bumper.star) });
      body.addShape(new CANNON.Cylinder(bumper.radius, bumper.radius, height, bumper.sides ?? 20));
      body.position.set(bumper.pos[0], height / 2, bumper.pos[1]);
      body.userData = { type: 'bumper', id: bumper.id, points: bumper.points, star: Boolean(bumper.star), lastHit: -Infinity };
      this.world.addBody(body);
    }
  }

  #createBoosts({ boosts }) {
    if (!boosts) return;
    for (const def of boosts) {
      const body = new CANNON.Body({ mass: 0, material: this.mats.wall, isTrigger: true });
      body.addShape(new CANNON.Box(new CANNON.Vec3(1.5, 1, 1.5)));
      body.position.set(def.pos[0], 0.5, def.pos[1]);

      const dirX = -Math.sin(def.rotY);
      const dirZ = -Math.cos(def.rotY);

      // Guardamos la velocidad que viene desde el layout (def.speed)
      body.userData = { type: 'boost', dirX, dirZ, speed: def.speed ?? 20, lastHit: -Infinity };
      this.world.addBody(body);
    }
  }

  #createFlippers({ flippers }, flipperMeshes) {
    for (const def of flippers) {
      const dir = def.side === 'left' ? 1 : -1;
      const body = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, material: this.mats.flipper });
      body.addShape(new CANNON.Box(new CANNON.Vec3(def.length / 2, 0.4, def.thickness / 2)), new CANNON.Vec3((dir * def.length) / 2, 0, 0));
      body.position.set(def.pivot[0], 0.4, def.pivot[1]);
      body.quaternion.setFromAxisAngle(AXIS_Y, def.restAngle);
      body.userData = { type: 'flipper', player: def.player };
      this.world.addBody(body);
      this.flippers.push({
        id: def.id, player: def.player, side: def.side, body, mesh: flipperMeshes[def.id],
        angle: def.restAngle, restAngle: def.restAngle, activeAngle: def.activeAngle, pressed: false,
      });
    }
  }

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
      mass: 1, material: this.mats.ball, shape: new CANNON.Sphere(ball.radius), linearDamping: 0.02, angularDamping: 0.3,
    });
    this._onBallCollide = (event) => {
      const data = event.body?.userData;
      if (data?.type === 'bumper') this._pendingKicks.push(event.body);
      else if (data?.type === 'flipper') this._lastHitter = data.player;
      else if (data?.type === 'multiplier') {
        if (this._time - data.lastHit > 1) {
          this.callbacks.onMultiplierHit?.(data.value);
          data.lastHit = this._time;
        }
      }
      else if (data?.type === 'boost') {
        if (this._time - data.lastHit > 1) {
          data.lastHit = this._time;

          // Usamos la velocidad específica del boost
          this.ball.velocity.x = data.dirX * data.speed;
          this.ball.velocity.z = data.dirZ * data.speed;
          this.ball.velocity.y = 3;

          this.callbacks.onBoostHit?.();
        }
      }
    };
    this.ball.addEventListener('collide', this._onBallCollide);
  }

  #stepFlippers(dt) {
    for (const f of this.flippers) {
      const target = f.pressed && !this._tilted.has(f.player) ? f.activeAngle : f.restAngle;
      const diff = target - f.angle;
      if (Math.abs(diff) < 1e-5) { f.body.angularVelocity.set(0, 0, 0); continue; }
      const speed = f.pressed ? PHYSICS_CONFIG.flipperSpeedUp : PHYSICS_CONFIG.flipperSpeedDown;
      const maxStep = speed * dt;
      if (Math.abs(diff) <= maxStep) {
        f.angle = target; f.body.angularVelocity.set(0, 0, 0); f.body.quaternion.setFromAxisAngle(AXIS_Y, target);
      } else {
        const delta = Math.sign(diff) * maxStep;
        f.angle += delta; f.body.angularVelocity.set(0, delta / dt, 0);
      }
    }
  }

  #stepPlungers(dt) {
    for (const p of this.plungers) {
      const { body } = p;
      if (p.firing) {
        if (body.position.z <= p.restZ) { body.position.z = p.restZ; body.velocity.z = 0; p.firing = false; p.tension = 0; }
      } else if (p.pulling) {
        p.tension = Math.min(1, p.tension + dt / PHYSICS_CONFIG.plungerPullTime);
        body.position.z = p.restZ + p.tension * PHYSICS_CONFIG.plungerPull;
      } else if (p.tension > 0) {
        const { plungerSpeedMin: min, plungerSpeedMax: max } = PHYSICS_CONFIG;
        body.velocity.z = -(min + p.tension * (max - min)); p.firing = true;
      }
    }
  }

  #inLane(position) { return position.z > -6 && this.layout.halves.some(({ lane }) => position.x > lane[0] && position.x < lane[1]); }

  #afterStep() {
    const { ball } = this;
    if (!this._ballInPlay) return;

    for (const bumper of this._pendingKicks) {
      const data = bumper.userData;
      if (data.star) {
        if (this._time - data.lastHit > PHYSICS_CONFIG.starCooldown) this.callbacks.onBumperHit?.(data.id, data.points, this.#pointsOwner(bumper));
        data.lastHit = this._time; continue;
      }
      const dx = ball.position.x - bumper.position.x;
      const dz = ball.position.z - bumper.position.z;
      const len = Math.hypot(dx, dz) || 1;
      ball.velocity.x += (dx / len) * PHYSICS_CONFIG.bumperKick;
      ball.velocity.z += (dz / len) * PHYSICS_CONFIG.bumperKick;
      this.callbacks.onBumperHit?.(data.id, data.points, this.#pointsOwner(bumper));
    }
    this._pendingKicks.length = 0;

    const { core } = this.layout;
    if (core && this._time >= this._coreReadyAt && Math.hypot(ball.position.x - core.pos[0], ball.position.z - core.pos[1]) < core.radius) {
      const from = this._ballSide;
      const dir = this.layout.halves.find((h) => h.player !== from).side;
      ball.velocity.set(dir * PHYSICS_CONFIG.coreSpeed, 0, -3);
      this._coreReadyAt = this._time + PHYSICS_CONFIG.coreCooldown;
      this.callbacks.onCore?.(from);
    }

    if (this.layout.halves.length > 1 && Math.abs(ball.position.x) > PHYSICS_CONFIG.crossMargin) {
      const side = this.#halfAt(ball.position.x).player;
      if (side !== this._ballSide) {
        const from = this._ballSide; this._ballSide = side;
        this.callbacks.onCross?.(side, from);
      }
    }

    const speed = ball.velocity.length();
    if (speed > PHYSICS_CONFIG.maxBallSpeed) ball.velocity.scale(PHYSICS_CONFIG.maxBallSpeed / speed, ball.velocity);

    const inLane = this.#inLane(ball.position);
    if (speed < PHYSICS_CONFIG.stuckSpeed && !inLane) this._idleTime += PHYSICS_CONFIG.fixedStep;
    else this._idleTime = 0;
    if (this._idleTime > PHYSICS_CONFIG.stuckTime) {
      ball.velocity.x += (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 3);
      ball.velocity.z -= 6; this._idleTime = 0;
    }

    const { table } = this.layout;
    const drained = !inLane && ball.position.z > table.length / 2 - PHYSICS_CONFIG.drainZMargin;
    const escaped = ball.position.y < -3 || Math.abs(ball.position.x) > table.width / 2 + 1.5 || Math.abs(ball.position.z) > table.length / 2 + 1.5;
    if (drained || escaped) {
      const loser = this.#halfAt(ball.position.x).player;
      this._server = loser;
      this.callbacks.onDrain?.(loser);
      this.#parkBall(PHYSICS_CONFIG.spawnDelay + 0.5);
    }
  }

  #pointsOwner(bumper) {
    const central = this.layout.halves.length > 1 && Math.abs(bumper.position.x) < 0.01;
    return central && this._lastHitter !== null ? this._lastHitter : this.#halfAt(bumper.position.x).player;
  }

  #halfAt(x) { const { halves } = this.layout; return halves.find((half) => half.side * x >= 0) ?? halves[0]; }

  #syncMeshes() {
    if (this.ballMesh && this.ball) {
      this.ballMesh.visible = this._ballInPlay && !this.ghost;
      this.ballMesh.position.copy(this.ball.position);
      this.ballMesh.quaternion.copy(this.ball.quaternion);
    }
    for (const f of this.flippers) { f.mesh?.position.copy(f.body.position); f.mesh?.quaternion.copy(f.body.quaternion); }
    for (const p of this.plungers) p.mesh?.position.copy(p.body.position);
  }

  #parkBall(delay) {
    if (this._ballInPlay) this.world.removeBody(this.ball);
    this._ballInPlay = false; this._spawnTimer = delay; this._pendingKicks.length = 0; this._idleTime = 0;
  }

  #launchBall() {
    const { ball: ballDef } = this.layout;
    const { spawn } = this.layout.halves[this._server];
    const { ball } = this;
    ball.position.set(spawn[0], ballDef.radius, spawn[1]);
    ball.velocity.set(0, 0, 0); ball.angularVelocity.set(0, 0, 0); ball.quaternion.set(0, 0, 0, 1);
    this.world.addBody(ball);
    this._ballInPlay = true; this._ballSide = this._server; this._lastHitter = null;
  }
}