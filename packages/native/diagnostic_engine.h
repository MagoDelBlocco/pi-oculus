#ifndef OCULUS_DIAGNOSTIC_ENGINE_H
#define OCULUS_DIAGNOSTIC_ENGINE_H

#include <napi.h>
#include "helpers.h"
#include <string>
#include <vector>
#include <cmath>

namespace oculus {
namespace diagnostic {

struct DiagnosticInput {
    std::string id;
    std::string filePath;
    int line;
    int column;
    std::string severity;      // "error" | "warning" | "info" | "hint"
    std::string rule;
    std::string message;
    std::string source;
    bool hasFix;               // Known autofix available
    int fixCount;              // Number of applicable fixes
    int blastRadius;           // How many files/symbols depend on this
    int age;                   // Turns since first emitted
    int touchedStart;          // Start of changed-line range in this file (-1 = unknown)
    int touchedEnd;            // End of changed-line range in this file (-1 = unknown)
    // Optional: exact set of touched lines. When present, ProximityScore uses
    // the closest line in this set instead of the bounding box implied by
    // [touchedStart, touchedEnd]. Lets edits at lines 5 and 500 NOT mark
    // everything between them as "near the edit".
    std::vector<int> touchedLines;
};

// Score a single diagnostic (0-100)
double ScoreDiagnostic(const DiagnosticInput& diag);

// Score a batch of diagnostics and return sorted by priority
std::vector<std::pair<std::string, double>> ScoreBatch(const std::vector<DiagnosticInput>& diagnostics);

// Classify severity into priority weight
int SeverityWeight(std::string_view severity);

// Proximity score: higher when closer to touched lines
double ProximityScore(int diagLine, int touchStart, int touchEnd);

// Proximity score against an explicit set of touched lines. Returns 100 when
// `diagLine` is exactly one of the touched lines, decaying linearly with the
// distance to the closest touched line. Falls back to the bounding-box
// behaviour when `touchedLines` is empty.
double ProximityScoreLines(int diagLine, const std::vector<int>& touchedLines,
                            int touchStart, int touchEnd);

// Blast radius score: higher when more dependents
double BlastRadiusScore(int blastRadius);

// Fixability score: higher when autofix is available
double FixabilityScore(bool hasFix, int fixCount);

// Age penalty: higher when older (more turns unresolved)
double AgePenalty(int age);

} // namespace diagnostic
} // namespace oculus

#endif // OCULUS_DIAGNOSTIC_ENGINE_H
