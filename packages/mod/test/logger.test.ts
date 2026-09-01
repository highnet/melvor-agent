import { describe, expect, it } from 'vitest';
import { Logger } from '../src/runtime/logger.js';

describe('the log buffers', () => {
  it('keeps display history after a report drains the queue', () => {
    // The live complaint: the in-game activity list emptied itself every few
    // seconds. One buffer was serving two jobs — what to show and what has yet
    // to be sent — and shipping a report wiped both.
    const log = new Logger();
    log.info('runtime', 'armed');
    log.info('adapter', 'reflex.expandBank fired');

    expect(log.drain()).toHaveLength(2);
    expect(log.tail().map((record) => record.message)).toEqual([
      'armed',
      'reflex.expandBank fired',
    ]);
  });

  it('does not re-send what a report already took', () => {
    const log = new Logger();
    log.info('runtime', 'armed');
    log.drain();
    log.info('runtime', 'objective set');

    expect(log.drain().map((record) => record.message)).toEqual(['objective set']);
  });

  it('puts records back on the queue when a send fails, not into history twice', () => {
    const log = new Logger();
    log.info('runtime', 'armed');
    const failed = log.drain();
    log.requeue(failed);

    expect(log.drain()).toHaveLength(1);
    expect(log.tail()).toHaveLength(1);
  });

  it('bounds both buffers', () => {
    const log = new Logger(3, 2);
    for (let i = 0; i < 10; i += 1) log.info('runtime', `line ${i}`);

    expect(log.tail(100)).toHaveLength(3);
    expect(log.drain()).toHaveLength(2);
  });
});
