#ifndef OCULUS_PATTERN_DETECT_H
#define OCULUS_PATTERN_DETECT_H

#include <string>
#include <string_view>
#include <vector>

namespace oculus {
namespace pattern {

struct PatternHit {
    int line;             // 1-indexed
    int column;           // 1-indexed
    std::string pattern;  // canonical pattern id (e.g. "eval", "debugger")
    std::string snippet;  // matched text (clipped to 80 chars)
};

// Bitmask over `source`: true ⇒ position is inside a string/comment.
// Built once and shared across all scanners (cheap O(n) single pass).
std::vector<bool> BuildSkipMask(std::string_view source);

// Scan source for every known pattern in a single pass.
// Builds its own skip mask.
std::vector<PatternHit> DetectPatterns(std::string_view source);

// Same as DetectPatterns but reuses a pre-built skip mask.
std::vector<PatternHit> DetectPatternsWithMask(
    std::string_view source,
    const std::vector<bool>& skip);

// Individual scanners (exposed for testing). Each builds its own mask.
std::vector<PatternHit> FindEval(std::string_view source);
std::vector<PatternHit> FindDebugger(std::string_view source);
std::vector<PatternHit> FindConsoleLog(std::string_view source);
std::vector<PatternHit> FindEmptyCatch(std::string_view source);
std::vector<PatternHit> FindHardcodedSecrets(std::string_view source);
std::vector<PatternHit> FindAlert(std::string_view source);

} // namespace pattern
} // namespace oculus

#endif // OCULUS_PATTERN_DETECT_H
