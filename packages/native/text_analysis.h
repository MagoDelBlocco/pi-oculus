#ifndef OCULUS_TEXT_ANALYSIS_H
#define OCULUS_TEXT_ANALYSIS_H

#include <napi.h>
#include <string>
#include <string_view>
#include <vector>
#include <unordered_map>

namespace oculus {
namespace text {

// All scanners ignore positions where `skip[i]` is true (i.e. inside a string
// or comment). The non-`WithMask` overloads build their own mask for convenience.

int CyclomaticComplexity(std::string_view source);
int CyclomaticComplexityWithMask(std::string_view source, const std::vector<bool>& skip);

int CognitiveComplexity(std::string_view source);
int CognitiveComplexityWithMask(std::string_view source, const std::vector<bool>& skip);

int MaxNestingDepth(std::string_view source);
int MaxNestingDepthWithMask(std::string_view source, const std::vector<bool>& skip);

double CodeEntropy(std::string_view source);

int LinesOfCode(std::string_view source);

} // namespace text
} // namespace oculus

#endif // OCULUS_TEXT_ANALYSIS_H
