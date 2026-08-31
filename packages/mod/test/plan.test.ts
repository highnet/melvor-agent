import { commandSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { objective } from './fixtures.js';

describe('plans', () => {
  it('accepts a sequence a session can leave behind', () => {
    const parsed = commandSchema.safeParse({
      type: 'set_plan',
      objectives: [objective(), objective({ id: 'obj-2' })],
    });

    expect(parsed.success).toBe(true);
  });

  it('refuses an empty plan', () => {
    // An empty plan is indistinguishable from no plan, and silently accepting
    // one would leave the agent believing it had instructions it does not have.
    expect(commandSchema.safeParse({ type: 'set_plan', objectives: [] }).success).toBe(false);
  });

  it('caps how far ahead a plan may reach', () => {
    // A plan is not a schedule. Every step is chosen against candidates that
    // exist now, so the ninth step would be written against a character that no
    // longer resembles the one that will run it.
    const tooLong = Array.from({ length: 9 }, (_, index) => objective({ id: `obj-${index}` }));

    expect(commandSchema.safeParse({ type: 'set_plan', objectives: tooLong }).success).toBe(false);
  });
});
