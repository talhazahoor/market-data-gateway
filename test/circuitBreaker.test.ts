import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  CircuitOpenError,
} from '../src/resilience/circuitBreaker.js';

/** Controllable clock so these tests never sleep. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const fail = () => Promise.reject(new Error('upstream down'));
const succeed = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  it('stays closed and passes results through while calls succeed', async () => {
    const breaker = new CircuitBreaker('v', { failureThreshold: 2, resetTimeoutMs: 100 });
    await expect(breaker.execute(succeed)).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('opens only once the failure threshold is reached', async () => {
    const breaker = new CircuitBreaker('v', { failureThreshold: 3, resetTimeoutMs: 100 });

    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    expect(breaker.state).toBe('closed');
    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    expect(breaker.state).toBe('closed');
    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    expect(breaker.state).toBe('open');
  });

  it('rejects without invoking the call while open', async () => {
    const breaker = new CircuitBreaker('v', { failureThreshold: 1, resetTimeoutMs: 100 });
    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');

    let invoked = false;
    await expect(
      breaker.execute(async () => {
        invoked = true;
        return 'should not run';
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(invoked).toBe(false);
  });

  it('resets consecutive failures after an intervening success', async () => {
    const breaker = new CircuitBreaker('v', { failureThreshold: 2, resetTimeoutMs: 100 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    await expect(breaker.execute(succeed)).resolves.toBe('ok');
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.state).toBe('closed');
  });

  it('moves to half-open once the reset window elapses, then closes on success', async () => {
    const c = clock();
    const breaker = new CircuitBreaker('v', {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: c.now,
    });

    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.state).toBe('open');

    c.advance(999);
    expect(breaker.state).toBe('open');

    c.advance(1);
    expect(breaker.state).toBe('half-open');

    await expect(breaker.execute(succeed)).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('re-opens if the half-open probe fails', async () => {
    const c = clock();
    const breaker = new CircuitBreaker('v', {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: c.now,
    });

    await expect(breaker.execute(fail)).rejects.toThrow();
    c.advance(1000);
    expect(breaker.state).toBe('half-open');

    await expect(breaker.execute(fail)).rejects.toThrow('upstream down');
    expect(breaker.state).toBe('open');
  });

  it('admits only one probe while half-open', async () => {
    const c = clock();
    const breaker = new CircuitBreaker('v', {
      failureThreshold: 1,
      resetTimeoutMs: 1000,
      now: c.now,
    });
    await expect(breaker.execute(fail)).rejects.toThrow();
    c.advance(1000);

    // Hold the probe open so the second caller arrives while it is in flight.
    let release: (v: string) => void = () => {};
    const probe = breaker.execute(() => new Promise<string>((res) => (release = res)));

    await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);

    release('ok');
    await expect(probe).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('does not count neutral outcomes against vendor health', async () => {
    const breaker = new CircuitBreaker('v', { failureThreshold: 2, resetTimeoutMs: 100 });
    await expect(breaker.execute(fail)).rejects.toThrow();
    breaker.recordNeutral();
    await expect(breaker.execute(fail)).rejects.toThrow();
    expect(breaker.state).toBe('closed');
  });
});
