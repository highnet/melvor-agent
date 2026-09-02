import type { AgentReport } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { describeAttention } from '../src/attention.js';

/**
 * The one field an unattended check reads.
 *
 * Three different failures used to arrive by three different routes and one of
 * them arrived by no route at all: while suspended the mod returned before
 * reporting, so "offline progress never finished" and "the machine was turned
 * off" were the same silence, and `connected: false` carried no reason either
 * way.
 */
const report = (over: Partial<AgentReport> = {}): AgentReport =>
  ({
    runState: 'running',
    snapshot: null,
    objective: null,
    candidates: [],
    blockedOpportunities: [],
    planRemaining: 0,
    logs: [],
    journalEntries: [],
    quality: [],
    blockedReason: null,
    needsAttention: null,
    ...over,
  }) as AgentReport;

describe('describeAttention', () => {
  it('says nothing about a healthy run', () => {
    expect(describeAttention(report(), 1200)).toBeNull();
  });

  it('says nothing before the first report, which is not a failed run', () => {
    // Otherwise the service alarms from the moment it boots with the game shut.
    expect(describeAttention(null, null)).toBeNull();
  });

  it('reports silence, and says what the last known state was', () => {
    const attention = describeAttention(report({ runState: 'suspended' }), 600_000);
    expect(attention).toContain('has not reported');
    expect(attention).toContain('suspended');
  });

  it('prefers silence over anything inside a stale report', () => {
    // A stale report describes a moment that has passed; its contents cannot be
    // the answer to "what is happening now".
    const attention = describeAttention(report({ blockedReason: 'wrong character' }), 600_000);
    expect(attention).toContain('has not reported');
  });

  it("passes the mod's own escalation through verbatim", () => {
    const attention = describeAttention(
      report({ needsAttention: 'no movement for 45min across 4 replan requests' }),
      1200,
    );
    expect(attention).toBe('no movement for 45min across 4 replan requests');
  });

  it('reports a refusal to arm, which is otherwise only visible in the TUI', () => {
    const attention = describeAttention(
      report({ runState: 'blocked', blockedReason: 'stale dump' }),
      1200,
    );
    expect(attention).toContain('stale dump');
  });

  it('stays quiet about a latched kill switch', () => {
    // The operator pulled it. Telling them about their own decision every two
    // minutes is how an alarm gets ignored.
    expect(describeAttention(report({ runState: 'killed' }), 600_000)).toBeNull();
  });
});
