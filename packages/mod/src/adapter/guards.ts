/**
 * Realms whose content the agent refuses to engage with.
 *
 * Empty, by operator decision. Into the Abyss and the Eternal realm were
 * excluded from the start because the combat gate's assumptions do not carry
 * over to them, and lifting that was always stated as a decision only the
 * operator could make — the planner was never allowed to negotiate it. That
 * decision has now been made: nothing is excluded.
 *
 * The set is kept rather than deleted, and every call site still consults it,
 * so re-excluding a realm is a one-line change instead of an archaeology
 * exercise across nine files.
 *
 * What this does *not* change is the survivability gate. Abyssal enemies are
 * screened by the same combat-level ceiling as everything else, and that screen
 * was written for the base game — the original comment's warning is still true,
 * it is simply no longer a reason to refuse. The brief permits the character to
 * die; it does not permit irreversible damage, and the categorical refusals
 * below are untouched because they are about destroying things that cannot be
 * recovered, not about which content is in scope.
 */
const REFUSED_REALM_IDS: ReadonlySet<string> = new Set([]);

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
    return `realm ${realm.name} (${realm.id}) is on the refusal list`;
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
