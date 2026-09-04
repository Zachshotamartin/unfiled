/**
 * Plain-language reasons the organizer stopped, from a receipt's reason codes. The same sentences
 * the phone shows (apps/ios/Unfiled/Features/Review/ReviewReasonCopy.swift): codes that carry no
 * meaning for the owner are dropped, repeats collapse, and the order follows the codes.
 */
const REASON_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  no_candidate_fit: "None of your notes fit this.",
  ambiguous_intent: "It could belong in more than one place.",
  low_information: "There was not enough to file it with confidence.",
  low_confidence: "There was not enough to file it with confidence.",
  duplicate_suspected: "It looks like something you already have.",
  duplicate_suggestion: "It looks like something you already have.",
  duplicate_notes: "It looks like something you already have.",
  warmup: "Your first few captures always come to you first.",
  planner_ambiguity: "Unfiled could not settle on one destination.",
  revision_conflict: "The destination note changed while this was being filed.",
  structure_conflict: "The destination's structure did not accept it.",
  explicit_destination_unavailable: "The note you named is not available.",
  conflict_requires_review: "A conflict needs your decision.",
  provider_unavailable: "Your AI key was not available.",
  provider_key_invalid: "Your AI key was rejected.",
  rate_limited: "The AI service was busy."
});

export function reviewReasonSentence(code: string): string | null {
  return REASON_SENTENCES[code] ?? null;
}

export function reviewReasonSentences(codes: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const sentences: string[] = [];
  for (const code of codes) {
    const sentence = reviewReasonSentence(code);
    if (sentence === null || seen.has(sentence)) continue;
    seen.add(sentence);
    sentences.push(sentence);
  }
  return sentences;
}
