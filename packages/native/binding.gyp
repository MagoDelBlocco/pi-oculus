{
  "targets": [
    {
      "target_name": "oculus",
      "sources": [
        "addon.cpp",
        "helpers.cpp",
        "read_guard.cpp",
        "diagnostic_engine.cpp",
        "text_analysis.cpp",
        "pattern_detect.cpp",
        "analysis.cpp"
      ],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!@(node -p \"require('node-addon-api').gyp\")"],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++20"],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
            "CLANG_CXX_LIBRARY": "libc++"
          }
        }],
        ["OS=='linux'", {
          "cflags_cc": ["-std=c++20"]
        }]
      ]
    }
  ]
}
