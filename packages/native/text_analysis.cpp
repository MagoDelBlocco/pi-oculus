#include "text_analysis.h"
#include "pattern_detect.h"   // BuildSkipMask
#include <cctype>
#include <cmath>
#include <cstring>
#include <unordered_map>

namespace oculus {
namespace text {

namespace {

inline bool isIdentChar(char c) {
    return std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '$';
}

inline bool isWordMatch(std::string_view src, size_t pos, size_t len) {
    if (pos > 0 && isIdentChar(src[pos - 1])) return false;
    size_t end = pos + len;
    if (end < src.size() && isIdentChar(src[end])) return false;
    return true;
}

inline bool masked(const std::vector<bool>& m, size_t i) {
    return i < m.size() && m[i];
}

int countKeywordHits(std::string_view src, const std::vector<bool>& skip,
                     const char* kw, int* nesting = nullptr) {
    size_t len = std::strlen(kw);
    int total = 0;
    size_t pos = 0;
    while ((pos = src.find(kw, pos)) != std::string_view::npos) {
        if (!masked(skip, pos) && isWordMatch(src, pos, len)) {
            total += nesting ? (1 + *nesting) : 1;
        }
        pos += len;
    }
    return total;
}

} // namespace

int CyclomaticComplexityWithMask(std::string_view src, const std::vector<bool>& skip) {
    int complexity = 1;

    for (const char* kw : {"if", "while", "for", "case"}) {
        complexity += countKeywordHits(src, skip, kw);
    }

    // Logical operators don't have a "keyword" form, but we still skip strings/comments.
    auto countLogical = [&](std::string_view needle) {
        int count = 0;
        size_t pos = 0;
        while ((pos = src.find(needle, pos)) != std::string_view::npos) {
            if (!masked(skip, pos)) ++count;
            pos += needle.size();
        }
        return count;
    };
    complexity += countLogical("&&");
    complexity += countLogical("||");

    size_t pos = 0;
    while ((pos = src.find('?', pos)) != std::string_view::npos) {
        if (!masked(skip, pos)) {
            // Skip optional-chaining (`?.`) and nullish-coalescing (`??`,
            // both halves) — neither introduces a branch. What remains is the
            // ternary `?`.
            char next = (pos + 1 < src.size()) ? src[pos + 1] : '\0';
            char prev = (pos > 0) ? src[pos - 1] : '\0';
            if (next != '.' && next != '?' && prev != '?') ++complexity;
        }
        ++pos;
    }

    return complexity;
}

int CyclomaticComplexity(std::string_view src) {
    return CyclomaticComplexityWithMask(src, oculus::pattern::BuildSkipMask(src));
}

int CognitiveComplexityWithMask(std::string_view src, const std::vector<bool>& skip) {
    // Two-pass: first compute brace-nesting at every position, then weight keyword
    // hits by that nesting. This is what the original code intended but conflated.
    int complexity = 0;
    int nesting = 0;

    // We walk source once, tracking nesting and looking for keywords simultaneously.
    auto matchKw = [&](size_t pos) -> int {
        for (const char* kw : {"if", "while", "for", "case"}) {
            size_t len = std::strlen(kw);
            if (pos + len > src.size()) continue;
            if (src.compare(pos, len, kw) != 0) continue;
            if (!isWordMatch(src, pos, len)) continue;
            return static_cast<int>(len);
        }
        return 0;
    };

    for (size_t i = 0; i < src.size(); ) {
        if (masked(skip, i)) { ++i; continue; }
        char c = src[i];
        if (c == '{') { ++nesting; ++i; continue; }
        if (c == '}') { if (nesting > 0) --nesting; ++i; continue; }
        int klen = matchKw(i);
        if (klen > 0) {
            complexity += 1 + nesting;
            i += klen;
        } else {
            ++i;
        }
    }
    return complexity;
}

int CognitiveComplexity(std::string_view src) {
    return CognitiveComplexityWithMask(src, oculus::pattern::BuildSkipMask(src));
}

int MaxNestingDepthWithMask(std::string_view src, const std::vector<bool>& skip) {
    // Only structural nesting: braces. Parens / brackets are expression depth
    // (`arr.map(x => f(g(h(x))))` is not "deeply nested code" in any useful sense).
    int maxDepth = 0;
    int currentDepth = 0;
    for (size_t i = 0; i < src.size(); ++i) {
        if (masked(skip, i)) continue;
        char c = src[i];
        if (c == '{') {
            ++currentDepth;
            if (currentDepth > maxDepth) maxDepth = currentDepth;
        } else if (c == '}') {
            if (currentDepth > 0) --currentDepth;
        }
    }
    return maxDepth;
}

int MaxNestingDepth(std::string_view src) {
    return MaxNestingDepthWithMask(src, oculus::pattern::BuildSkipMask(src));
}

double CodeEntropy(std::string_view source) {
    if (source.empty()) return 0.0;

    std::unordered_map<char, int> freq;
    int total = 0;

    for (unsigned char c : source) {
        if (!std::isspace(c)) {
            freq[c]++;
            total++;
        }
    }

    if (total == 0) return 0.0;

    double entropy = 0.0;
    for (const auto& [_, count] : freq) {
        double p = static_cast<double>(count) / total;
        entropy -= p * std::log2(p);
    }

    return entropy;
}

int LinesOfCode(std::string_view source) {
    // A line is "code" iff it contains at least one non-whitespace character
    // that the skip-mask doesn't mark as part of a comment or string-delimiter.
    // String contents themselves DO count — `const s = "x";` is one line of code.
    const std::vector<bool> skip = oculus::pattern::BuildSkipMask(source);
    int lines = 0;
    bool hasCode = false;
    for (size_t i = 0; i <= source.size(); ++i) {
        const bool eol = (i == source.size()) || source[i] == '\n';
        if (!eol) {
            const bool isWs = std::isspace(static_cast<unsigned char>(source[i]));
            const bool isComment = masked(skip, i) &&
                source[i] != '\'' && source[i] != '"' && source[i] != '`';
            // String contents are also masked but represent real code, so we
            // only treat block/line-comment positions as non-code. A practical
            // proxy: if the position is masked AND the character is NOT a
            // quote, treat it as comment territory. String INTERIORS are
            // masked too, but they're real code — so we keep them by relying
            // on the quote chars themselves to bump hasCode for that line.
            if (!isWs && !isComment) hasCode = true;
        } else {
            if (hasCode) ++lines;
            hasCode = false;
        }
    }
    return lines;
}

} // namespace text
} // namespace oculus
