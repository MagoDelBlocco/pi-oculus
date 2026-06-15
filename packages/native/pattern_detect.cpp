#include "pattern_detect.h"
#include <algorithm>
#include <cctype>
#include <cstring>

namespace oculus {
namespace pattern {

namespace {

constexpr size_t kSnippetClip = 80;

inline bool isIdentChar(char c) {
    return std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '$';
}

bool isWordMatch(std::string_view src, size_t pos, size_t len) {
    if (pos > 0 && isIdentChar(src[pos - 1])) return false;
    size_t end = pos + len;
    if (end < src.size() && isIdentChar(src[end])) return false;
    return true;
}

// True when the identifier at `pos` is being called as a method (i.e. preceded
// by `.`, including chains like `obj?.eval(x)`). Used to filter false positives
// for global-only names — `eval`, `alert`, `console` — when they appear as
// method calls on user objects.
bool isMethodCall(std::string_view src, size_t pos) {
    if (pos == 0) return false;
    if (src[pos - 1] == '.') return true;
    if (pos >= 2 && src[pos - 1] == '.' && src[pos - 2] == '?') return true;
    return false;
}

void lineCol(std::string_view src, size_t pos, int& line, int& col) {
    line = 1;
    col = 1;
    for (size_t i = 0; i < pos && i < src.size(); ++i) {
        if (src[i] == '\n') {
            ++line;
            col = 1;
        } else {
            ++col;
        }
    }
}

std::string clipSnippet(std::string_view src, size_t pos, size_t len) {
    if (pos >= src.size()) return {};
    size_t available = std::min(len, src.size() - pos);
    size_t clip = std::min(available, kSnippetClip);
    for (size_t i = 0; i < clip; ++i) {
        if (src[pos + i] == '\n') { clip = i; break; }
    }
    return std::string(src.substr(pos, clip));
}

PatternHit makeHit(std::string_view src, size_t pos, size_t len,
                   std::string pattern) {
    PatternHit hit;
    lineCol(src, pos, hit.line, hit.column);
    hit.pattern = std::move(pattern);
    hit.snippet = clipSnippet(src, pos, len);
    return hit;
}

size_t skipWs(std::string_view src, size_t i) {
    while (i < src.size() && std::isspace(static_cast<unsigned char>(src[i]))) ++i;
    return i;
}

size_t findCloseParen(std::string_view src, size_t pos) {
    if (pos >= src.size() || src[pos] != '(') return std::string::npos;
    int depth = 0;
    for (size_t i = pos; i < src.size(); ++i) {
        if (src[i] == '(') ++depth;
        else if (src[i] == ')') {
            --depth;
            if (depth == 0) return i;
        }
    }
    return std::string::npos;
}

inline bool inSkip(const std::vector<bool>& mask, size_t pos) {
    return pos < mask.size() && mask[pos];
}

/* ----------------------- per-pattern scanners ----------------------- */

std::vector<PatternHit> findEval(std::string_view src, const std::vector<bool>& skip) {
    std::vector<PatternHit> hits;
    std::string_view needle = "eval";
    size_t pos = 0;
    while ((pos = src.find(needle, pos)) != std::string_view::npos) {
        if (inSkip(skip, pos) || !isWordMatch(src, pos, needle.size()) ||
            isMethodCall(src, pos)) {
            pos += needle.size();
            continue;
        }
        size_t after = skipWs(src, pos + needle.size());
        if (after < src.size() && src[after] == '(') {
            hits.push_back(makeHit(src, pos, after - pos + 1, "eval"));
        }
        pos += needle.size();
    }
    return hits;
}

std::vector<PatternHit> findDebugger(std::string_view src, const std::vector<bool>& skip) {
    std::vector<PatternHit> hits;
    std::string_view needle = "debugger";
    size_t pos = 0;
    while ((pos = src.find(needle, pos)) != std::string_view::npos) {
        if (!inSkip(skip, pos) && isWordMatch(src, pos, needle.size())) {
            hits.push_back(makeHit(src, pos, needle.size(), "debugger"));
        }
        pos += needle.size();
    }
    return hits;
}

std::vector<PatternHit> findConsoleLog(std::string_view src, const std::vector<bool>& skip) {
    std::vector<PatternHit> hits;
    const char* methods[] = {"log", "warn", "error", "info", "debug"};
    std::string_view needle = "console";
    size_t pos = 0;
    while ((pos = src.find(needle, pos)) != std::string_view::npos) {
        if (inSkip(skip, pos) || !isWordMatch(src, pos, needle.size())) {
            pos += needle.size();
            continue;
        }
        size_t after = pos + needle.size();
        if (after >= src.size() || src[after] != '.') { pos = after; continue; }
        ++after;
        bool matched = false;
        for (const char* m : methods) {
            size_t mlen = std::strlen(m);
            if (after + mlen <= src.size() &&
                src.compare(after, mlen, m) == 0 &&
                (after + mlen == src.size() || !isIdentChar(src[after + mlen]))) {
                size_t parenPos = skipWs(src, after + mlen);
                if (parenPos < src.size() && src[parenPos] == '(') {
                    hits.push_back(makeHit(src, pos, parenPos - pos + 1, "console-log"));
                    matched = true;
                    break;
                }
            }
        }
        pos = after + (matched ? 4 : 1);
    }
    return hits;
}

std::vector<PatternHit> findEmptyCatch(std::string_view src, const std::vector<bool>& skip) {
    std::vector<PatternHit> hits;
    std::string_view needle = "catch";
    size_t pos = 0;
    while ((pos = src.find(needle, pos)) != std::string_view::npos) {
        if (inSkip(skip, pos) || !isWordMatch(src, pos, needle.size())) {
            pos += needle.size();
            continue;
        }
        size_t after = skipWs(src, pos + needle.size());
        if (after < src.size() && src[after] == '(') {
            size_t close = findCloseParen(src, after);
            if (close == std::string_view::npos) { pos = after; continue; }
            after = skipWs(src, close + 1);
        }
        if (after >= src.size() || src[after] != '{') { pos = after; continue; }
        size_t body = after + 1;
        int depth = 1;
        bool hasCode = false;
        while (body < src.size() && depth > 0) {
            char c = src[body];
            if (!inSkip(skip, body)) {
                if (c == '{') ++depth;
                else if (c == '}') { --depth; if (depth == 0) break; }
                else if (!std::isspace(static_cast<unsigned char>(c))) hasCode = true;
            }
            ++body;
        }
        if (!hasCode) {
            hits.push_back(makeHit(src, pos, body - pos + 1, "empty-catch"));
        }
        pos = (body < src.size()) ? body + 1 : src.size();
    }
    return hits;
}

std::vector<PatternHit> findHardcodedSecrets(std::string_view src, const std::vector<bool>& skip) {
    std::vector<PatternHit> hits;
    const char* triggers[] = {
        "api_key", "apikey", "secret", "password", "passwd",
        "auth_token", "access_token", "private_key",
    };
    auto isAlphaUnderscore = [](char c) {
        return std::isalpha(static_cast<unsigned char>(c)) || c == '_';
    };
    auto matchTrigger = [&](size_t pos, size_t& tlen) -> bool {
        for (const char* t : triggers) {
            size_t l = std::strlen(t);
            if (pos + l > src.size()) continue;
            bool ok = true;
            for (size_t k = 0; k < l; ++k) {
                char a = std::tolower(static_cast<unsigned char>(src[pos + k]));
                if (a != t[k]) { ok = false; break; }
            }
            if (!ok) continue;
            if (pos > 0 && isAlphaUnderscore(src[pos - 1])) continue;
            tlen = l;
            return true;
        }
        return false;
    };
    size_t i = 0;
    while (i < src.size()) {
        if (inSkip(skip, i)) { ++i; continue; }
        size_t tlen = 0;
        if (!matchTrigger(i, tlen)) { ++i; continue; }
        size_t after = skipWs(src, i + tlen);
        if (after >= src.size() || (src[after] != '=' && src[after] != ':')) {
            i += tlen;
            continue;
        }
        ++after;
        after = skipWs(src, after);
        if (after >= src.size()) break;
        char quote = src[after];
        if (quote != '"' && quote != '\'' && quote != '`') { i += tlen; continue; }
        size_t close = after + 1;
        while (close < src.size() && src[close] != quote) {
            if (src[close] == '\\' && close + 1 < src.size()) close += 2;
            else ++close;
        }
        size_t litLen = (close > after + 1) ? close - after - 1 : 0;
        if (litLen >= 8) {
            hits.push_back(makeHit(src, i, close - i + 1, "hardcoded-secret"));
        }
        i = (close < src.size()) ? close + 1 : src.size();
    }
    return hits;
}

std::vector<PatternHit> findAlert(std::string_view src, const std::vector<bool>& skip) {
    std::vector<PatternHit> hits;
    std::string_view needle = "alert";
    size_t pos = 0;
    while ((pos = src.find(needle, pos)) != std::string_view::npos) {
        if (inSkip(skip, pos) || !isWordMatch(src, pos, needle.size()) ||
            isMethodCall(src, pos)) {
            pos += needle.size();
            continue;
        }
        size_t after = skipWs(src, pos + needle.size());
        if (after < src.size() && src[after] == '(') {
            hits.push_back(makeHit(src, pos, after - pos + 1, "alert"));
        }
        pos += needle.size();
    }
    return hits;
}

} // namespace

/* ----------------------- public surface ----------------------- */

std::vector<bool> BuildSkipMask(std::string_view src) {
    std::vector<bool> mask(src.size(), false);
    enum class State { Code, LineComment, BlockComment, SingleStr, DoubleStr, BacktickStr };
    State state = State::Code;
    size_t i = 0;
    while (i < src.size()) {
        char c = src[i];
        switch (state) {
            case State::Code:
                if (c == '/' && i + 1 < src.size() && src[i + 1] == '/') {
                    state = State::LineComment;
                    mask[i] = true; mask[i + 1] = true;
                    i += 2; continue;
                }
                if (c == '/' && i + 1 < src.size() && src[i + 1] == '*') {
                    state = State::BlockComment;
                    mask[i] = true; mask[i + 1] = true;
                    i += 2; continue;
                }
                if (c == '\'') { state = State::SingleStr; mask[i] = true; ++i; continue; }
                if (c == '"')  { state = State::DoubleStr; mask[i] = true; ++i; continue; }
                if (c == '`')  { state = State::BacktickStr; mask[i] = true; ++i; continue; }
                break;
            case State::LineComment:
                mask[i] = true;
                if (c == '\n') state = State::Code;
                break;
            case State::BlockComment:
                mask[i] = true;
                if (c == '*' && i + 1 < src.size() && src[i + 1] == '/') {
                    mask[i + 1] = true;
                    state = State::Code;
                    i += 2; continue;
                }
                break;
            case State::SingleStr:
                mask[i] = true;
                if (c == '\\' && i + 1 < src.size()) { mask[i + 1] = true; i += 2; continue; }
                if (c == '\'') state = State::Code;
                break;
            case State::DoubleStr:
                mask[i] = true;
                if (c == '\\' && i + 1 < src.size()) { mask[i + 1] = true; i += 2; continue; }
                if (c == '"') state = State::Code;
                break;
            case State::BacktickStr:
                mask[i] = true;
                if (c == '\\' && i + 1 < src.size()) { mask[i + 1] = true; i += 2; continue; }
                if (c == '`') state = State::Code;
                break;
        }
        ++i;
    }
    return mask;
}

std::vector<PatternHit> DetectPatternsWithMask(
    std::string_view src,
    const std::vector<bool>& skip) {
    std::vector<PatternHit> all;
    auto append = [&](std::vector<PatternHit> v) {
        for (auto& h : v) all.push_back(std::move(h));
    };
    append(findEval(src, skip));
    append(findDebugger(src, skip));
    append(findConsoleLog(src, skip));
    append(findEmptyCatch(src, skip));
    append(findHardcodedSecrets(src, skip));
    append(findAlert(src, skip));
    std::sort(all.begin(), all.end(),
        [](const PatternHit& a, const PatternHit& b) {
            if (a.line != b.line) return a.line < b.line;
            return a.column < b.column;
        });
    return all;
}

std::vector<PatternHit> DetectPatterns(std::string_view src) {
    return DetectPatternsWithMask(src, BuildSkipMask(src));
}

std::vector<PatternHit> FindEval(std::string_view src) { return findEval(src, BuildSkipMask(src)); }
std::vector<PatternHit> FindDebugger(std::string_view src) { return findDebugger(src, BuildSkipMask(src)); }
std::vector<PatternHit> FindConsoleLog(std::string_view src) { return findConsoleLog(src, BuildSkipMask(src)); }
std::vector<PatternHit> FindEmptyCatch(std::string_view src) { return findEmptyCatch(src, BuildSkipMask(src)); }
std::vector<PatternHit> FindHardcodedSecrets(std::string_view src) { return findHardcodedSecrets(src, BuildSkipMask(src)); }
std::vector<PatternHit> FindAlert(std::string_view src) { return findAlert(src, BuildSkipMask(src)); }

} // namespace pattern
} // namespace oculus
