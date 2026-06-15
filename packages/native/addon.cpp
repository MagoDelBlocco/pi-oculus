#include <napi.h>
#include "helpers.h"
#include "read_guard.h"
#include "diagnostic_engine.h"
#include "text_analysis.h"
#include "pattern_detect.h"
#include "analysis.h"

using namespace oculus;
using namespace oculus::read_guard;
using namespace oculus::diagnostic;
using namespace oculus::text;
using namespace oculus::pattern;
using oculus::analysis::AnalyzeFile;
using oculus::analysis::FileMetrics;

// Module initialization
Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Read-guard exports
    exports.Set("matchOldText", Napi::Function::New(env, 
        [](const Napi::CallbackInfo& info) {
            std::string content = info[0].As<Napi::String>().Utf8Value();
            std::string oldText = info[1].As<Napi::String>().Utf8Value();
            return Napi::Number::New(info.Env(), static_cast<double>(MatchOldText(content, oldText)));
        }
    ));
    exports.Set("correctIndentation", Napi::Function::New(env, 
        [](const Napi::CallbackInfo& info) {
            std::string text = info[0].As<Napi::String>().Utf8Value();
            std::string fileContent = info[1].As<Napi::String>().Utf8Value();
            return Napi::String::New(info.Env(), CorrectIndentation(text, fileContent));
        }
    ));
    exports.Set("computeHash", Napi::Function::New(env, ComputeHash));
    exports.Set("countMatches", Napi::Function::New(env, CountMatches));
    exports.Set("findMatchRange", Napi::Function::New(env, FindMatchRange));

    // Diagnostic engine exports
    exports.Set("scoreDiagnostic", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            DiagnosticInput diag;
            diag.id = info[0].As<Napi::String>().Utf8Value();
            diag.filePath = info[1].As<Napi::String>().Utf8Value();
            diag.line = info[2].As<Napi::Number>().Int32Value();
            diag.column = info[3].As<Napi::Number>().Int32Value();
            diag.severity = info[4].As<Napi::String>().Utf8Value();
            diag.rule = info[5].As<Napi::String>().Utf8Value();
            diag.message = info[6].As<Napi::String>().Utf8Value();
            diag.source = info[7].As<Napi::String>().Utf8Value();
            diag.hasFix = info[8].As<Napi::Boolean>().Value();
            diag.fixCount = info[9].As<Napi::Number>().Int32Value();
            diag.blastRadius = info[10].As<Napi::Number>().Int32Value();
            diag.age = info[11].As<Napi::Number>().Int32Value();
            diag.touchedStart = info.Length() > 12 ? info[12].As<Napi::Number>().Int32Value() : -1;
            diag.touchedEnd   = info.Length() > 13 ? info[13].As<Napi::Number>().Int32Value() : -1;
            if (info.Length() > 14 && info[14].IsArray()) {
                Napi::Array arr = info[14].As<Napi::Array>();
                diag.touchedLines.reserve(arr.Length());
                for (uint32_t i = 0; i < arr.Length(); ++i) {
                    Napi::Value v = arr.Get(i);
                    if (v.IsNumber()) {
                        diag.touchedLines.push_back(v.As<Napi::Number>().Int32Value());
                    }
                }
            }
            return Napi::Number::New(info.Env(), ScoreDiagnostic(diag));
        }
    ));
    exports.Set("scoreBatch", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            Napi::Array arr = info[0].As<Napi::Array>();
            std::vector<DiagnosticInput> diagnostics;
            diagnostics.reserve(arr.Length());

            auto readIntField = [](const Napi::Object& obj, const char* name, int dflt) -> int {
                Napi::Value v = obj.Get(name);
                if (v.IsNumber()) return v.As<Napi::Number>().Int32Value();
                return dflt;
            };

            for (uint32_t i = 0; i < arr.Length(); i++) {
                Napi::Object obj = arr.Get(i).As<Napi::Object>();
                DiagnosticInput diag;
                diag.id = obj.Get("id").As<Napi::String>().Utf8Value();
                diag.filePath = obj.Get("filePath").As<Napi::String>().Utf8Value();
                diag.line = obj.Get("line").As<Napi::Number>().Int32Value();
                diag.column = obj.Get("column").As<Napi::Number>().Int32Value();
                diag.severity = obj.Get("severity").As<Napi::String>().Utf8Value();
                diag.rule = obj.Get("rule").As<Napi::String>().Utf8Value();
                diag.message = obj.Get("message").As<Napi::String>().Utf8Value();
                diag.source = obj.Get("source").As<Napi::String>().Utf8Value();
                diag.hasFix = obj.Get("hasFix").As<Napi::Boolean>().Value();
                diag.fixCount = obj.Get("fixCount").As<Napi::Number>().Int32Value();
                diag.blastRadius = obj.Get("blastRadius").As<Napi::Number>().Int32Value();
                diag.age = obj.Get("age").As<Napi::Number>().Int32Value();
                diag.touchedStart = readIntField(obj, "touchedStart", -1);
                diag.touchedEnd   = readIntField(obj, "touchedEnd",   -1);
                Napi::Value lines = obj.Get("touchedLines");
                if (lines.IsArray()) {
                    Napi::Array arr = lines.As<Napi::Array>();
                    diag.touchedLines.reserve(arr.Length());
                    for (uint32_t j = 0; j < arr.Length(); ++j) {
                        Napi::Value v = arr.Get(j);
                        if (v.IsNumber()) {
                            diag.touchedLines.push_back(v.As<Napi::Number>().Int32Value());
                        }
                    }
                }
                diagnostics.push_back(diag);
            }

            auto results = ScoreBatch(diagnostics);
            Napi::Array result = Napi::Array::New(info.Env(), results.size());
            for (size_t i = 0; i < results.size(); i++) {
                Napi::Object pair = Napi::Object::New(info.Env());
                pair.Set("id", Napi::String::New(info.Env(), results[i].first));
                pair.Set("score", Napi::Number::New(info.Env(), results[i].second));
                result[i] = pair;
            }
            return result;
        }
    ));
    exports.Set("classifySeverity", Napi::Function::New(env, 
        [](const Napi::CallbackInfo& info) {
            std::string severity = info[0].As<Napi::String>().Utf8Value();
            return Napi::Number::New(info.Env(), static_cast<double>(SeverityWeight(severity)));
        }
    ));

    // Text analysis exports
    exports.Set("cyclomaticComplexity", Napi::Function::New(env, 
        [](const Napi::CallbackInfo& info) {
            std::string source = info[0].As<Napi::String>().Utf8Value();
            return Napi::Number::New(info.Env(), static_cast<double>(CyclomaticComplexity(source)));
        }
    ));
    exports.Set("cognitiveComplexity", Napi::Function::New(env, 
        [](const Napi::CallbackInfo& info) {
            std::string source = info[0].As<Napi::String>().Utf8Value();
            return Napi::Number::New(info.Env(), static_cast<double>(CognitiveComplexity(source)));
        }
    ));
    exports.Set("maxNestingDepth", Napi::Function::New(env, 
        [](const Napi::CallbackInfo& info) {
            std::string source = info[0].As<Napi::String>().Utf8Value();
            return Napi::Number::New(info.Env(), static_cast<double>(MaxNestingDepth(source)));
        }
    ));
    exports.Set("codeEntropy", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            std::string source = info[0].As<Napi::String>().Utf8Value();
            return Napi::Number::New(info.Env(), CodeEntropy(source));
        }
    ));
    exports.Set("linesOfCode", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            std::string source = info[0].As<Napi::String>().Utf8Value();
            return Napi::Number::New(info.Env(), static_cast<double>(LinesOfCode(source)));
        }
    ));

    // Fused single-pass analysis: one N-API crossing covers metrics + patterns.
    exports.Set("analyzeFile", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) -> Napi::Value {
            Napi::Env env = info.Env();
            std::string source = info[0].As<Napi::String>().Utf8Value();
            FileMetrics m = AnalyzeFile(source);

            Napi::Object out = Napi::Object::New(env);
            out.Set("cyclomatic", Napi::Number::New(env, m.cyclomatic));
            out.Set("cognitive", Napi::Number::New(env, m.cognitive));
            out.Set("maxNesting", Napi::Number::New(env, m.maxNesting));
            out.Set("linesOfCode", Napi::Number::New(env, m.linesOfCode));
            out.Set("entropy", Napi::Number::New(env, m.entropy));

            Napi::Array patterns = Napi::Array::New(env, m.patterns.size());
            for (size_t i = 0; i < m.patterns.size(); ++i) {
                const auto& h = m.patterns[i];
                Napi::Object obj = Napi::Object::New(env);
                obj.Set("line", Napi::Number::New(env, h.line));
                obj.Set("column", Napi::Number::New(env, h.column));
                obj.Set("pattern", Napi::String::New(env, h.pattern));
                obj.Set("snippet", Napi::String::New(env, h.snippet));
                patterns[i] = obj;
            }
            out.Set("patterns", patterns);
            return out;
        }
    ));

    // Pattern detection (single-pass scanner)
    auto patternHitsToJs = [](Napi::Env env, const std::vector<PatternHit>& hits) {
        Napi::Array arr = Napi::Array::New(env, hits.size());
        for (size_t i = 0; i < hits.size(); ++i) {
            Napi::Object obj = Napi::Object::New(env);
            obj.Set("line", Napi::Number::New(env, hits[i].line));
            obj.Set("column", Napi::Number::New(env, hits[i].column));
            obj.Set("pattern", Napi::String::New(env, hits[i].pattern));
            obj.Set("snippet", Napi::String::New(env, hits[i].snippet));
            arr[i] = obj;
        }
        return arr;
    };
    exports.Set("detectPatterns", Napi::Function::New(env,
        [patternHitsToJs](const Napi::CallbackInfo& info) -> Napi::Value {
            std::string source = info[0].As<Napi::String>().Utf8Value();
            return patternHitsToJs(info.Env(), DetectPatterns(source));
        }
    ));

    // Severity bucketing (used by report builder)
    exports.Set("countSeverities", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) -> Napi::Value {
            Napi::Array arr = info[0].As<Napi::Array>();
            int error = 0, warning = 0, infoC = 0, hint = 0;
            for (uint32_t i = 0; i < arr.Length(); ++i) {
                std::string s = arr.Get(i).As<Napi::String>().Utf8Value();
                if (s == "error") ++error;
                else if (s == "warning") ++warning;
                else if (s == "info") ++infoC;
                else if (s == "hint") ++hint;
            }
            Napi::Object out = Napi::Object::New(info.Env());
            out.Set("error", Napi::Number::New(info.Env(), error));
            out.Set("warning", Napi::Number::New(info.Env(), warning));
            out.Set("info", Napi::Number::New(info.Env(), infoC));
            out.Set("hint", Napi::Number::New(info.Env(), hint));
            return out;
        }
    ));

    // Utility exports
    exports.Set("normalizeNewlines", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            std::string s = info[0].As<Napi::String>().Utf8Value();
            return Napi::String::New(info.Env(), normalizeNewlines(s));
        }
    ));
    exports.Set("trimTrailingWhitespace", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            std::string s = info[0].As<Napi::String>().Utf8Value();
            return Napi::String::New(info.Env(), trimTrailingWhitespace(s));
        }
    ));
    exports.Set("hashString", Napi::Function::New(env,
        [](const Napi::CallbackInfo& info) {
            std::string s = info[0].As<Napi::String>().Utf8Value();
            return Napi::Number::New(info.Env(), static_cast<double>(hashString(s)));
        }
    ));

    return exports;
}

NODE_API_MODULE(oculus, Init)
