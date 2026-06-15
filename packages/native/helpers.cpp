#include "helpers.h"
#include <cstdint>
#include <cstring>
#include <numeric>

namespace oculus {

std::vector<std::string> splitOn(std::string_view s, char delim) {
    std::vector<std::string> parts;
    size_t start = 0;
    size_t pos = 0;
    while (pos < s.size()) {
        if (s[pos] == delim) {
            parts.emplace_back(s.substr(start, pos - start));
            start = pos + 1;
        }
        pos++;
    }
    parts.emplace_back(s.substr(start));
    return parts;
}

std::string joinWith(const std::vector<std::string>& parts, char delim) {
    if (parts.empty()) return {};
    std::string result;
    result.reserve(std::accumulate(parts.begin(), parts.end(), size_t(0), 
        [delim](size_t acc, const std::string& p) { return acc + p.size() + 1; }) - 1);
    for (size_t i = 0; i < parts.size(); ++i) {
        if (i > 0) result += delim;
        result += parts[i];
    }
    return result;
}

size_t ifind(std::string_view haystack, std::string_view needle) {
    if (needle.empty()) return 0;
    auto it = std::search(
        haystack.begin(), haystack.end(),
        needle.begin(), needle.end(),
        [](char a, char b) { return std::tolower(static_cast<unsigned char>(a)) == 
                                  std::tolower(static_cast<unsigned char>(b)); }
    );
    if (it == haystack.end()) return std::string_view::npos;
    return static_cast<size_t>(it - haystack.begin());
}

std::string normalizeNewlines(std::string_view s) {
    std::string result;
    result.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '\r') {
            if (i + 1 < s.size() && s[i + 1] == '\n') {
                result += '\n';
                ++i;
            } else {
                result += '\n';
            }
        } else {
            result += s[i];
        }
    }
    return result;
}

std::string trimTrailingWhitespace(std::string_view s) {
    std::string result;
    result.reserve(s.size());
    size_t lineStart = 0;
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '\n') {
            // Trim trailing whitespace from this line
            size_t lineEnd = i;
            while (lineEnd > lineStart && 
                   (s[lineEnd - 1] == ' ' || s[lineEnd - 1] == '\t')) {
                --lineEnd;
            }
            result.append(s.substr(lineStart, lineEnd - lineStart));
            result += '\n';
            lineStart = i + 1;
        }
    }
    // Last line (no trailing newline)
    if (lineStart < s.size()) {
        size_t lineEnd = s.size();
        while (lineEnd > lineStart && 
               (s[lineEnd - 1] == ' ' || s[lineEnd - 1] == '\t')) {
            --lineEnd;
        }
        result.append(s.substr(lineStart, lineEnd - lineStart));
    }
    return result;
}

uint32_t hashString(std::string_view s) {
    uint32_t hash = 5381;
    for (unsigned char c : s) {
        hash = ((hash << 5) + hash) + static_cast<uint32_t>(c);
    }
    return hash;
}

uint32_t hashRange(std::string_view content, int lineStart, int lineEnd) {
    uint32_t hash = 5381;
    int currentLine = 1;
    size_t i = 0;
    while (i < content.size() && currentLine <= lineEnd) {
        if (currentLine >= lineStart && currentLine <= lineEnd) {
            // Hash the content of this line
            size_t lineEndPos = content.find('\n', i);
            if (lineEndPos == std::string_view::npos) lineEndPos = content.size();
            for (size_t j = i; j < lineEndPos; ++j) {
                hash = ((hash << 5) + hash) + static_cast<uint32_t>(content[j]);
            }
        }
        // Skip to next line
        if (content[i] == '\n') ++currentLine;
        ++i;
    }
    return hash;
}

size_t countOccurrences(std::string_view haystack, std::string_view needle) {
    if (needle.empty()) return 0;
    size_t count = 0;
    size_t pos = 0;
    while (pos < haystack.size()) {
        auto found = haystack.find(needle, pos);
        if (found == std::string_view::npos) break;
        ++count;
        pos = found + needle.size();
    }
    return count;
}

bool startsWithCI(std::string_view s, std::string_view prefix) {
    if (prefix.size() > s.size()) return false;
    return std::equal(prefix.begin(), prefix.end(), s.begin(),
        [](char a, char b) { 
            return std::tolower(static_cast<unsigned char>(a)) == 
                   std::tolower(static_cast<unsigned char>(b)); 
        });
}

bool endsWithCI(std::string_view s, std::string_view prefix) {
    if (prefix.size() > s.size()) return false;
    return std::equal(prefix.rbegin(), prefix.rend(), s.rbegin(),
        [](char a, char b) { 
            return std::tolower(static_cast<unsigned char>(a)) == 
                   std::tolower(static_cast<unsigned char>(b)); 
        });
}

std::string toLower(std::string_view s) {
    std::string result;
    result.reserve(s.size());
    for (unsigned char c : s) {
        result += static_cast<char>(std::tolower(c));
    }
    return result;
}

std::string escapeJson(std::string_view s) {
    std::string result;
    result.reserve(s.size() * 2);
    for (char c : s) {
        switch (c) {
            case '\"': result += "\\\""; break;
            case '\\': result += "\\\\"; break;
            case '\n': result += "\\n"; break;
            case '\r': result += "\\r"; break;
            case '\t': result += "\\t"; break;
            case '\b': result += "\\b"; break;
            case '\f': result += "\\f"; break;
            default: result += c;
        }
    }
    return result;
}

int parseInt(std::string_view s, int defaultValue) {
    if (s.empty()) return defaultValue;
    size_t idx = 0;
    try {
        size_t pos = 0;
        int value = std::stoi(std::string(s), &pos);
        if (pos == s.size()) return value;
    } catch (...) {}
    return defaultValue;
}

} // namespace oculus
