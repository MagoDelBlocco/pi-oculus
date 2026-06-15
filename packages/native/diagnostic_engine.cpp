#include "diagnostic_engine.h"
#include <algorithm>
#include <cctype>
#include <climits>

namespace oculus {
namespace diagnostic {

int SeverityWeight(std::string_view severity) {
    std::string lower = toLower(severity);
    if (lower == "error") return 100;
    if (lower == "warning") return 50;
    if (lower == "info") return 20;
    if (lower == "hint") return 10;
    return 30; // unknown severity defaults to moderate
}

double ProximityScore(int diagLine, int touchStart, int touchEnd) {
    if (touchStart < 0 || touchEnd < 0) return 50.0; // No touch context, neutral

    int distance = 0;
    if (diagLine < touchStart) {
        distance = touchStart - diagLine;
    } else if (diagLine > touchEnd) {
        distance = diagLine - touchEnd;
    }

    // Score: 100 at distance 0, decaying to 0 at distance 50+
    if (distance == 0) return 100.0;
    if (distance >= 50) return 0.0;
    return 100.0 * (1.0 - static_cast<double>(distance) / 50.0);
}

double ProximityScoreLines(int diagLine, const std::vector<int>& touchedLines,
                            int touchStart, int touchEnd) {
    if (touchedLines.empty()) {
        return ProximityScore(diagLine, touchStart, touchEnd);
    }
    int best = INT32_MAX;
    for (int line : touchedLines) {
        int d = diagLine > line ? diagLine - line : line - diagLine;
        if (d < best) best = d;
        if (best == 0) break;
    }
    if (best == 0) return 100.0;
    if (best >= 50) return 0.0;
    return 100.0 * (1.0 - static_cast<double>(best) / 50.0);
}

double BlastRadiusScore(int blastRadius) {
    if (blastRadius <= 0) return 0.0;
    if (blastRadius == 1) return 30.0;  // Single file
    if (blastRadius <= 3) return 60.0;  // 2-3 files
    if (blastRadius <= 10) return 85.0; // 4-10 files
    return 100.0; // 10+ files
}

double FixabilityScore(bool hasFix, int fixCount) {
    if (!hasFix) return 0.0;
    if (fixCount == 0) return 30.0;   // Has fix but none applicable now
    if (fixCount == 1) return 80.0;  // Single clear fix
    return 100.0;                     // Multiple fixes available
}

double AgePenalty(int age) {
    // Age is turns since first emitted. Newer = less penalty.
    // 0 turns = 0 penalty, 10+ turns = max penalty (reduced score)
    if (age <= 0) return 0.0;
    if (age >= 10) return 20.0; // Max 20 point penalty for very old issues
    return static_cast<double>(age) * 2.0;
}

double ScoreDiagnostic(const DiagnosticInput& diag) {
    // Weights: severity 40%, proximity 25%, blast 20%, fixability 10%, age 5%
    double severityScore = static_cast<double>(SeverityWeight(diag.severity));
    double proximity = ProximityScoreLines(diag.line, diag.touchedLines,
                                           diag.touchedStart, diag.touchedEnd);
    double blast = BlastRadiusScore(diag.blastRadius);
    double fixability = FixabilityScore(diag.hasFix, diag.fixCount);
    double age = AgePenalty(diag.age);
    
    double weighted = 
        severityScore * 0.40 +
        proximity * 0.25 +
        blast * 0.20 +
        fixability * 0.10;
    
    // Age is a penalty, not a score component
    double finalScore = weighted - age;
    
    return oculus::clamp(finalScore, 0.0, 100.0);
}

std::vector<std::pair<std::string, double>> ScoreBatch(const std::vector<DiagnosticInput>& diagnostics) {
    std::vector<std::pair<std::string, double>> results;
    results.reserve(diagnostics.size());
    
    for (const auto& diag : diagnostics) {
        double score = ScoreDiagnostic(diag);
        results.emplace_back(diag.id, score);
    }
    
    std::sort(results.begin(), results.end(),
        [](const auto& a, const auto& b) { return a.second > b.second; });
    
    return results;
}

} // namespace diagnostic
} // namespace oculus
