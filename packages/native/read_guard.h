#ifndef OCULUS_READ_GUARD_H
#define OCULUS_READ_GUARD_H

#include <napi.h>
#include "helpers.h"
#include <string>
#include <string_view>

namespace oculus {
namespace read_guard {

// Match oldText against file content. Returns match count.
// Handles CRLF normalization and trailing whitespace tolerance.
int MatchOldText(const std::string& content, const std::string& oldText);

// Find line range of a unique match. Returns {start, end} or {-1, -1} if not found/ambiguous.
Napi::Value FindMatchRange(const Napi::CallbackInfo& info);

// Correct indentation mismatch between oldText and file content.
// Returns corrected oldText if indentation-only change, empty string if no correction.
std::string CorrectIndentation(const std::string& text, const std::string& fileContent);

// Compute hash of a line range (1-indexed inclusive).
Napi::Value ComputeHash(const Napi::CallbackInfo& info);

// Count how many times oldText appears in content.
Napi::Value CountMatches(const Napi::CallbackInfo& info);

// Check if a line range is within previously read bounds.
bool IsInRange(int lineStart, int lineEnd, const std::vector<std::pair<int, int>>& readRanges);

// Normalize text for matching (CRLF -> LF, trim trailing whitespace).
std::string NormalizeForMatch(std::string_view s);

} // namespace read_guard
} // namespace oculus

#endif // OCULUS_READ_GUARD_H
