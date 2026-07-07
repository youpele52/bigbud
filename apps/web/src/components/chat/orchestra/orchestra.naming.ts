import { truncate } from "@bigbud/shared/String";

const ORCHESTRA_SCORE_NAME_MIN_LENGTH = 3;
export const ORCHESTRA_SCORE_NAME_MAX_LENGTH = 32;

const ORCHESTRA_SCORE_WORDS = [
  "Adagio",
  "Allegro",
  "Anthem",
  "Aria",
  "Ballad",
  "Barcarolle",
  "Beat",
  "Cadence",
  "Canon",
  "Cantata",
  "Caprice",
  "Carol",
  "Cavatina",
  "Chant",
  "Chorale",
  "Coda",
  "Concerto",
  "Crescendo",
  "Dirge",
  "Elegy",
  "Encore",
  "Etude",
  "Fanfare",
  "Finale",
  "Fugue",
  "Harmony",
  "Interlude",
  "Largo",
  "Legato",
  "Libretto",
  "Lullaby",
  "Madrigal",
  "Melody",
  "Minuet",
  "Motet",
  "Motif",
  "Nocturne",
  "Octave",
  "Opera",
  "Oratorio",
  "Overture",
  "Paean",
  "Partita",
  "Pavana",
  "Pizzicato",
  "Prelude",
  "Refrain",
  "Requiem",
  "Rhapsody",
  "Riff",
  "Rondo",
  "Serenade",
  "Sonata",
  "Syncopa",
  "Tempo",
  "Threnody",
  "Toccata",
  "Tone",
  "Tremolo",
  "Vespers",
] as const;

export function normalizeOrchestraScoreName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function validateOrchestraScoreName(value: string): string | null {
  const normalized = normalizeOrchestraScoreName(value);
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length < ORCHESTRA_SCORE_NAME_MIN_LENGTH) {
    return "Use at least 3 characters or leave it blank.";
  }
  if (normalized.length > ORCHESTRA_SCORE_NAME_MAX_LENGTH) {
    return `Use ${ORCHESTRA_SCORE_NAME_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

export function resolveOrchestraScoreName(value: string): string {
  const normalized = normalizeOrchestraScoreName(value);
  if (normalized.length === 0) {
    return ORCHESTRA_SCORE_WORDS[Math.floor(Math.random() * ORCHESTRA_SCORE_WORDS.length)]!;
  }
  return truncate(normalized, ORCHESTRA_SCORE_NAME_MAX_LENGTH);
}
