import Foundation

/// Plain-language reasons the organizer stopped, from the receipt's reason codes. Codes that carry
/// no meaning for the owner are dropped; repeats collapse; order follows the codes.
enum ReviewReasonCopy {
    static func sentence(for code: String) -> String? {
        switch code {
        case "no_candidate_fit": "None of your notes fit this."
        case "ambiguous_intent": "It could belong in more than one place."
        case "low_information", "low_confidence": "There was not enough to file it with confidence."
        case "duplicate_suspected", "duplicate_suggestion", "duplicate_notes": "It looks like something you already have."
        case "warmup": "Your first few captures always come to you first."
        case "planner_ambiguity": "Unfiled could not settle on one destination."
        case "revision_conflict": "The destination note changed while this was being filed."
        case "structure_conflict": "The destination's structure did not accept it."
        case "explicit_destination_unavailable": "The note you named is not available."
        case "conflict_requires_review": "A conflict needs your decision."
        case "provider_unavailable": "Your AI key was not available."
        case "provider_key_invalid": "Your AI key was rejected."
        case "rate_limited": "The AI service was busy."
        default: nil
        }
    }

    static func sentences(for codes: [String]) -> [String] {
        var seen: Set<String> = []
        return codes.compactMap(sentence(for:)).filter { seen.insert($0).inserted }
    }
}
