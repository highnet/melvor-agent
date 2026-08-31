/**
 * The adapter layer: the only place in this repo that touches the Melvor API.
 *
 * Everything else — policy, runtime, UI, planner — goes through this module.
 * A game update then breaks exactly one directory, and `docs/API.md` is
 * generated from this file's public surface so the reference cannot go stale.
 *
 * Two invariants hold throughout:
 *
 * - No action returns `void`. Every one returns an `ActionResult` carrying
 *   before/after evidence, because the game's own return conventions are
 *   inconsistent and a non-throwing call proves nothing.
 * - Nothing acts while offline progress is resolving.
 */

export { act, type ActSpec } from './act.js';
export { readBankQuantity, sellItem, type SaleProjection } from './bank.js';
export {
  disengageCombat,
  engageMonster,
  readCombatGateInputs,
  type CombatProjection,
} from './combat.js';
export {
  FARMING_ID,
  harvestFarmPlot,
  plantFarmPlot,
  readFarmPlots,
  readPlantableSeeds,
  type FarmPlotState,
} from './farming.js';
export {
  equipFood,
  equipItem,
  readEquipCandidates,
  type EquipProjection,
} from './equipment.js';
export { buyShopPurchase, readShopCandidates, type PurchaseProjection } from './shop.js';
export {
  readBlockedOpportunities,
  readGatherCandidates,
  readSellCandidates,
  readShopObjectiveCandidates,
} from './candidates.js';
export { ARTISAN_SKILL_IDS, isArtisanSkill } from './artisan.js';
export { MISC_SKILL_IDS, isMiscSkill } from './skills-misc.js';
export {
  FISHING_ID,
  GATHERING_SKILL_IDS,
  STARTABLE_SKILL_IDS,
  MINING_ID,
  WOODCUTTING_ID,
  startGathering,
  stopGathering,
  type GatheringProjection,
} from './gathering.js';
export { onGameEvent, onGameLoop, Subscriptions, type Disposer } from './events.js';
export {
  CATEGORICALLY_REFUSED,
  checkCharacterAllowed,
  checkRealmAllowed,
  isRefusedRealm,
} from './guards.js';
export {
  readCharacterName,
  readCompletionPercent,
  readCurrency,
  readGameVersion,
  readIsInOnlineLoop,
  readSnapshot,
  readTotalLevel,
} from './readers.js';
export { dumpRegistries } from './registries.js';
export { CharacterSettings, type PersistenceHealth } from './storage.js';
export { addSidebarPanel, type PanelHandle } from './sidebar.js';
export { exportSave } from './save.js';
export type {
  ActionResult,
  ActiveActionState,
  BankState,
  Candidate,
  CombatState,
  FailureReason,
  Objective,
  SkillState,
  StateSnapshot,
} from './surface.js';
