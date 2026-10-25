export const MAX_MAP_ROTATION_LENGTH = 1000;

export function isSameMapRotation(first: readonly string[], second: readonly string[]) {
  return first.length === second.length && first.every((map, index) => map === second[index]);
}

export const SERVER_MAPS: readonly string[] = [
  "TO_Coxwell",
  "TO_DarkForest",
  "TO_Lionspire",
  "TO_RudhelmSiege",
  "TO_Galencourt",
  "TO_Falmire",
  "TO_Raid",
  "TO_Stronghold",
  "TO_Bulwark",
  "TO_Library",
  "TO_Bridgetown",
  "TO_Montcrux",
  "TO_Citadel",
  "TDM_Wardenglade",
  "TDM_Wardenglade_horse",
  "TDM_TournamentGrounds",
  "TDM_FightingPit",
  "TDM_Courtyard",
  "TDM_Hippodrome",
  "TDM_Desert",
  "TDM_FrozenWreck",
  "FFA_FightingPit",
  "FFA_Wardenglade",
  "FFA_TournamentGrounds",
  "FFA_Courtyard",
  "FFA_Hippodrome",
  "FFA_Duelyard",
  "FFA_Desert",
  "FFA_Bazaar",
  "FFA_FrozenWreck",
  "LTS_Wardenglade",
  "LTS_TournamentGrounds",
  "LTS_FightingPit",
  "LTS_Courtyard",
  "LTS_Galencourt",
  "LTS_Falmire",
  "PR_LTS_Raid",
  "Brawl_GreatHall",
  "Brawl_RudhelmHall",
  "Brawl_Cathedral",
  "BRAWL_Midsommar",
  "BOW_Galencourt",
  "BOW_Falmire",
  "BOW_Wardenglade",
];

export type MapPreset = "lts" | "duelyard";

export function getPresetMaps(preset: MapPreset): string[] {
  return preset === "duelyard" ? ["FFA_Duelyard"] : SERVER_MAPS.filter((name) => name.startsWith("LTS_"));
}
