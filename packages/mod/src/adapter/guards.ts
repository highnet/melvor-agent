/**
 * Realms whose content the agent refuses to engage with entirely.
 *
 * Into the Abyss behaves differently enough that the Phase 2 combat gate's
 * assumptions do not carry over. This is enforced by realm identity rather than
 * by matching names, because a name check is defeated by any renamed or
 * localised content while realm membership is structural.
 *
 * Lifting this is an explicit operator decision, not something the planner can
 * negotiate.
 */
const REFUSED_REALM_IDS: ReadonlySet<string> = new Set([
  // Values of the `RealmIDs` const enum in idEnums.d.ts. Inlined as literals
  // because ambient `const enum` members cannot be referenced under
  // isolatedModules, which the build requires.
  'melvorItA:Abyssal',
  'melvorItA:Eternal',
]);

/** Whether a realm is on the hard refusal list. */
export function isRefusedRealm(realmId: string): boolean {
  return REFUSED_REALM_IDS.has(realmId);
}

/**
 * Whether the currently selected realm is refused.
 *
 * @returns An operator-readable reason, or null when the realm is permitted.
 */
export function checkRealmAllowed(): string | null {
  const realm = game.currentRealm;
  if (isRefusedRealm(realm.id)) {
    return `realm ${realm.name} (${realm.id}) is refused until explicitly whitelisted`;
  }
  return null;
}

/**
 * Whether this character may be automated.
 *
 * The agent is meant to run on a throwaway character. An empty allowlist means
 * "refuse everything" rather than "allow everything": a misconfigured agent must
 * fail closed, since the failure mode is days of unattended play on the wrong save.
 *
 * @param characterName - The loaded character, from `game.characterName`.
 * @param allowlist - Names the operator has explicitly permitted.
 * @returns An operator-readable reason, or null when permitted.
 */
export function checkCharacterAllowed(
  characterName: string,
  allowlist: readonly string[],
): string | null {
  if (allowlist.length === 0) {
    return 'no character allowlist configured; set one in the panel before arming';
  }
  if (!allowlist.includes(characterName)) {
    return `character "${characterName}" is not in the allowlist [${allowlist.join(', ')}]`;
  }
  return null;
}

/**
 * Actions the agent will never take, at any autonomy level.
 *
 * These are refused categorically rather than escalated to the operator: an
 * agent running unattended for days has nobody to ask, and "ask" degrades into
 * "block forever" or, worse, "assume yes".
 *
 * There is deliberately no adapter function for any of these, so this list is
 * documentation of an absence rather than a runtime check that could be
 * bypassed. It exists so the omission is legible, and so a future contributor
 * adding one of these trips over the reason first.
 */
export const CATEGORICALLY_REFUSED = [
  'destroying unique or one-of-a-kind items',
  'spending one-time tokens or consumable unlock items',
  'permanent character choices (gamemode, ironman, skill resets)',
  'deleting or overwriting save slots',
] as const;
