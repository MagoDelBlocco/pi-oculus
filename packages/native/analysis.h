#ifndef OCULUS_ANALYSIS_H
#define OCULUS_ANALYSIS_H

#include "pattern_detect.h"
#include <string_view>
#include <vector>

namespace oculus {
namespace analysis {

struct FileMetrics {
    int cyclomatic;
    int cognitive;
    int maxNesting;
    int linesOfCode;
    double entropy;
    std::vector<pattern::PatternHit> patterns;
};

// Single-pass analysis: builds the skip mask once and reuses it across all
// scanners. Equivalent to calling cyclomatic/cognitive/nesting/entropy/lines/
// detectPatterns individually but avoids redundant string copies and mask
// rebuilds.
FileMetrics AnalyzeFile(std::string_view source);

} // namespace analysis
} // namespace oculus

#endif // OCULUS_ANALYSIS_H
