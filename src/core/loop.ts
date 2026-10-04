// =============================================================================
// core/loop.ts — fixed-timestep simulation with an adaptive render stage.
//
// Why fixed step: every movement constant in config.ts (accelerate 5.5, friction
// 5.2, airaccelerate 12) is only correct at a fixed dt. On a 240 Hz monitor a
// variable step would silently change the handling, which is exactly the class of
// bug that makes a "CS-like" prototype feel wrong.
// =============================================================================

import { MAX_CATCHUP_STEPS, TICK_DT } from './config';

export interface LoopCallbacks {
  /** Advance the simulation exactly one fixed step. `tick` is monotonic. */
  step: (tick: number, dt: number) => void;
  /** Called once per animation frame after all steps, with an alpha in [0,1). */
  render: (alpha: number, frameDt: number) => void;
}

export class GameLoop {
  tick = 0;
  /** Simulation time in ticks (tick * TICK_DT). */
  simTime = 0;
  /** Smoothed frames per second. */
  fps = 0;
  /** Smoothed simulation milliseconds per step. */
  simMs = 0;
  /** Milliseconds spent in the last render callback. */
  renderMs = 0;
  /** Number of steps dropped because we fell too far behind. */
  droppedSteps = 0;
  /** True while paused (e.g. the tab is hidden). */
  paused = false;

  private accumulator = 0;
  private last = 0;
  private running = false;
  private rafId = 0;
  private readonly callbacks: LoopCallbacks;

  constructor(callbacks: LoopCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** Manually advance the simulation; used by deterministic tests. */
  stepManual(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.tick++;
      this.simTime = this.tick * TICK_DT;
      this.callbacks.step(this.tick, TICK_DT);
    }
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.frame);

    let frameDt = (now - this.last) / 1000;
    this.last = now;
    if (frameDt > 0.25) frameDt = 0.25; // tab was hidden / debugger pause
    if (frameDt <= 0) frameDt = TICK_DT;
    this.fps = this.fps === 0 ? 1 / frameDt : this.fps * 0.9 + (1 / frameDt) * 0.1;

    if (this.paused) {
      this.callbacks.render(0, frameDt);
      return;
    }

    this.accumulator += frameDt;

    let steps = 0;
    const simStart = performance.now();
    while (this.accumulator >= TICK_DT) {
      if (steps >= MAX_CATCHUP_STEPS) {
        // Drop the backlog rather than death-spiral. Reported in the perf panel.
        const backlog = Math.floor(this.accumulator / TICK_DT);
        this.droppedSteps += backlog;
        this.accumulator = 0;
        break;
      }
      this.accumulator -= TICK_DT;
      this.tick++;
      this.simTime = this.tick * TICK_DT;
      this.callbacks.step(this.tick, TICK_DT);
      steps++;
    }
    const simElapsed = performance.now() - simStart;
    if (steps > 0) {
      this.simMs = this.simMs === 0 ? simElapsed / steps : this.simMs * 0.9 + (simElapsed / steps) * 0.1;
    }

    const renderStart = performance.now();
    this.callbacks.render(this.accumulator / TICK_DT, frameDt);
    this.renderMs = performance.now() - renderStart;
  };
}
