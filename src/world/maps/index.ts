// =============================================================================
// maps/index.ts — which map a mode plays on.
//
// The mode table owns the map *name* (`MODES[mode].mapName`), so nothing outside
// this file has to know that a duel is a different arena from de_dust2. Both
// builders return a fresh, editable copy, so a match can mutate its map without
// touching the frozen module-level data.
// =============================================================================

import { MODES, type MatchModeId } from '../../core/config';
import type { MapData } from '../../core/types';
import { buildAimDuelLite } from './aim_duel_lite';
import { buildDust2Lite } from './de_dust2_lite';

/** Fresh map data for a mode. */
export function buildMapForMode(mode: MatchModeId): MapData {
  return MODES[mode].mapName === 'aim_duel_lite' ? buildAimDuelLite() : buildDust2Lite();
}

/** The mode's map name, without paying for a bake. */
export function mapNameForMode(mode: MatchModeId): string {
  return MODES[mode].mapName;
}