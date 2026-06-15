#include "read_guard.h"
#include <napi.h>
#include <sstream>
#include <cstdint>

namespace oculus {
namespace read_guard {

int MatchOldText(const std::string& content, const std::string& oldText) {
    if (oldText.empty()) return 0;
    
    std::string normalizedContent = normalizeNewlines(content);
    std::string normalizedOldText = normalizeNewlines(oldText);
    
    // Trim trailing whitespace from oldText for matching (handles formatter stripping)
    normalizedOldText = trimTrailingWhitespace(normalizedOldText);
    
    return countOccurrences(normalizedContent, normalizedOldText);
}

std::string NormalizeForMatch(std::string_view s) {
    return trimTrailingWhitespace(normalizeNewlines(s));
}

std::string CorrectIndentation(const std::string& text, const std::string& fileContent) {
    std::string normalizedContent = normalizeNewlines(fileContent);
    std::string normalizedText = normalizeNewlines(text);
    
    // If text already matches exactly, no correction needed
    if (normalizedContent.find(normalizedText) != std::string::npos) {
        return {};
    }
    
    // Detect file's indentation style from first few lines
    char fileIndentChar = ' '; // default to spaces
    int fileIndentSize = 2;
    
    size_t firstNonBlank = normalizedContent.find_first_not_of(" \t\r\n");
    if (firstNonBlank != std::string::npos) {
        // Check if line starts with tabs or spaces
        size_t lineStart = normalizedContent.rfind('\n', firstNonBlank);
        std::string indent;
        if (lineStart == std::string::npos) {
            indent = normalizedContent.substr(0, firstNonBlank);
        } else {
            indent = normalizedContent.substr(lineStart + 1,
                firstNonBlank - (lineStart + 1));
        }
        if (!indent.empty()) {
            if (indent[0] == '\t') {
                fileIndentChar = '\t';
                fileIndentSize = 1;
            } else {
                fileIndentChar = ' ';
                // Count leading spaces
                fileIndentSize = indent.size();
            }
        }
    }
    
    // Detect text's indentation style
    char textIndentChar = ' ';
    int textIndentSize = 2;
    
    size_t textFirstNonBlank = normalizedText.find_first_not_of(" \t\r\n");
    if (textFirstNonBlank != std::string::npos) {
        size_t textLineStart = normalizedText.rfind('\n', textFirstNonBlank);
        std::string indent;
        if (textLineStart == std::string::npos) {
            indent = normalizedText.substr(0, textFirstNonBlank);
        } else {
            indent = normalizedText.substr(textLineStart + 1,
                textFirstNonBlank - (textLineStart + 1));
        }
        if (!indent.empty()) {
            if (indent[0] == '\t') {
                textIndentChar = '\t';
                textIndentSize = 1;
            } else {
                textIndentChar = ' ';
                // Count leading spaces
                textIndentSize = indent.size();
            }
        }
    }
    
    // If same style, no correction needed
    if (textIndentChar == fileIndentChar && textIndentSize == fileIndentSize) {
        return {};
    }
    
    // Convert text indentation to match file's style
    std::string result;
    result.reserve(normalizedText.size());
    bool atLineStart = true;
    
    for (char c : normalizedText) {
        if (atLineStart && (c == ' ' || c == '\t')) {
            // Skip original indentation, will add file-style indentation at first non-blank
            continue;
        } else {
            if (atLineStart) {
                // First non-blank character on line - add file-style indentation
                if (fileIndentChar == '\t') {
                    result += '\t';
                } else {
                    result.append(fileIndentSize, ' ');
                }
                atLineStart = false;
            }
            if (c == '\n') {
                atLineStart = true;
            }
            result += c;
        }
    }
    
    return result;
}

Napi::Value ComputeHash(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected (content, lineStart, lineEnd)").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string content = info[0].As<Napi::String>().Utf8Value();
    int lineStart = info[1].As<Napi::Number>().Int32Value();
    int lineEnd = info[2].As<Napi::Number>().Int32Value();
    
    uint32_t hash = hashRange(content, lineStart, lineEnd);
    return Napi::Number::New(env, static_cast<double>(hash));
}

Napi::Value CountMatches(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected (content, oldText)").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string content = info[0].As<Napi::String>().Utf8Value();
    std::string oldText = info[1].As<Napi::String>().Utf8Value();
    
    int count = MatchOldText(content, oldText);
    return Napi::Number::New(env, static_cast<double>(count));
}

Napi::Value FindMatchRange(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2) {
        Napi::TypeError::New(env, "Expected (content, oldText)").ThrowAsJavaScriptException();
        return env.Null();
    }
    
    std::string content = info[0].As<Napi::String>().Utf8Value();
    std::string oldText = info[1].As<Napi::String>().Utf8Value();
    
    std::string normalizedContent = normalizeNewlines(content);
    std::string normalizedOldText = normalizeNewlines(oldText);
    normalizedOldText = trimTrailingWhitespace(normalizedOldText);
    
    size_t pos = normalizedContent.find(normalizedOldText);
    if (pos == std::string::npos) {
        return Napi::Array::New(env, 0);
    }
    
    // Count lines before match
    int startLine = 1;
    for (size_t i = 0; i < pos; ++i) {
        if (normalizedContent[i] == '\n') ++startLine;
    }
    
    // Count lines in match
    int endLine = startLine;
    for (size_t i = pos; i < pos + normalizedOldText.size(); ++i) {
        if (normalizedContent[i] == '\n') ++endLine;
    }
    
    Napi::Array result = Napi::Array::New(env, 2);
    result.Set(static_cast<uint32_t>(0), Napi::Number::New(env, static_cast<double>(startLine)));
    result.Set(static_cast<uint32_t>(1), Napi::Number::New(env, static_cast<double>(endLine)));
    return result;
}

bool IsInRange(int lineStart, int lineEnd, const std::vector<std::pair<int, int>>& readRanges) {
    for (const auto& range : readRanges) {
        if (lineStart >= range.first && lineEnd <= range.second) {
            return true;
        }
    }
    return false;
}

} // namespace read_guard
} // namespace oculus
