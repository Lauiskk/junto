{
  "targets": [
    {
      "target_name": "junto_audio",
      "sources": ["src/addon.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["-lmmdevapi.lib", "-lole32.lib", "-luser32.lib", "-lwinmm.lib"],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }]
      ]
    }
  ]
}
