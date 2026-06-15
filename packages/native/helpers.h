#ifndef OCULUS_HELPERS_H
#define OCULUS_HELPERS_H

#include <string>
#include <string_view>
#include <vector>
#include <cstdint>
#include <algorithm>
#include <cctype>
#include <regex>

namespace oculus {

// Delimiter-based serialization (avoids JSON.parse in N-API)
inline constexpr char BLOCK_DELIM = '\x01';
inline constexpr char FIELD_DELIM = '\x02';

// Split string on delimiter
std::vector<std::string> splitOn(std::string_view s, char delim);

// Join strings with delimiter
std::string joinWith(const std::vector<std::string>& parts, char delim);

// Case-insensitive string find
size_t ifind(std::string_view haystack, std::string_view needle);

// Normalize line endings (CRLF -> LF)
std::string normalizeNewlines(std::string_view s);

// Trim trailing whitespace from each line
std::string trimTrailingWhitespace(std::string_view s);

// Simple hash (djb2 variant for speed)
uint32_t hashString(std::string_view s);

// Hash a range of lines (lineStart to lineEnd, 1-indexed)
uint32_t hashRange(std::string_view content, int lineStart, int lineEnd);

// Count occurrences of needle in haystack
size_t countOccurrences(std::string_view haystack, std::string_view needle);

// Check if string starts with prefix (case-insensitive)
bool startsWithCI(std::string_view s, std::string_view prefix);

// Check if string ends with suffix (case-insensitive)
bool endsWithCI(std::string_view s, std::string_view suffix);

// Convert to lowercase in place
std::string toLower(std::string_view s);

// Escape a string for JSON embedding
std::string escapeJson(std::string_view s);

// Parse integer from string, with default
int parseInt(std::string_view s, int defaultValue);

// Clamp value between min and max
template<typename T>
T clamp(T val, T minVal, T maxVal) {
    return std::max(minVal, std::min(maxVal, val));
}

} // namespace oculus

#endif // OCULUS_HELPERS_H
