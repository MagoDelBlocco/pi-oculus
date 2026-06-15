#include "analysis.h"
#include "pattern_detect.h"
#include "text_analysis.h"

namespace oculus {
namespace analysis {

FileMetrics AnalyzeFile(std::string_view source) {
    const std::vector<bool> skip = oculus::pattern::BuildSkipMask(source);
    FileMetrics m;
    m.cyclomatic = oculus::text::CyclomaticComplexityWithMask(source, skip);
    m.cognitive = oculus::text::CognitiveComplexityWithMask(source, skip);
    m.maxNesting = oculus::text::MaxNestingDepthWithMask(source, skip);
    m.linesOfCode = oculus::text::LinesOfCode(source);
    m.entropy = oculus::text::CodeEntropy(source);
    m.patterns = oculus::pattern::DetectPatternsWithMask(source, skip);
    return m;
}

} // namespace analysis
} // namespace oculus
