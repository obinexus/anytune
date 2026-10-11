# AnyTune's recorder (anytune-recording/1 and its recording.* Polycall operations).
#
#   anytune_recorder_core   static: the format, the JSON reader, the operations — linked into the Android JNI bridge (apps/android) and the tests
#   anytune_recorder        a Polycall operation plugin (MODULE): `polycall start --load anytune_recorder.dll`
#   recorder_test           the C unit tests (ctest)
#
# POLYCALL_INCLUDE_DIR names Polycall's public headers; POLYCALL_STATIC_LIBRARY, when given, is linked into the plugin (as Polycall's own plugins link
# libpolycall statically), so the plugin resolves polycall_runtime_register on its own. Both are staged by tools/native/stage.ts.
cmake_minimum_required(VERSION 3.20)
project(anytune_recorder VERSION 1.0.0 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
set(CMAKE_C_VISIBILITY_PRESET hidden)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux" OR ANDROID)
  add_compile_definitions(_POSIX_C_SOURCE=200809L _DEFAULT_SOURCE)
endif()

set(POLYCALL_INCLUDE_DIR "" CACHE PATH "Polycall's public headers (polycall_runtime.h)")
set(POLYCALL_STATIC_LIBRARY "" CACHE FILEPATH "libpolycall.a, linked into the plugin")
if(NOT EXISTS "${POLYCALL_INCLUDE_DIR}/polycall_runtime.h")
  message(FATAL_ERROR "POLYCALL_INCLUDE_DIR (${POLYCALL_INCLUDE_DIR}) has no polycall_runtime.h: stage Polycall first (npm run native:stage)")
endif()

if(CMAKE_C_COMPILER_ID MATCHES "GNU|Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion -Werror)
endif()

add_library(anytune_recorder_core STATIC src/json_reader.c src/recording_format.c src/platform.c src/ops.c)
target_include_directories(anytune_recorder_core PUBLIC include "${POLYCALL_INCLUDE_DIR}" PRIVATE src)
set_target_properties(anytune_recorder_core PROPERTIES POSITION_INDEPENDENT_CODE ON)
if(WIN32)
  target_link_libraries(anytune_recorder_core PUBLIC bcrypt)
endif()

if(POLYCALL_STATIC_LIBRARY)
  add_library(anytune_recorder MODULE src/plugin.c)
  target_link_libraries(anytune_recorder PRIVATE anytune_recorder_core "${POLYCALL_STATIC_LIBRARY}")
  if(WIN32)
    target_link_libraries(anytune_recorder PRIVATE ws2_32 shell32)
  endif()
  set_target_properties(anytune_recorder PROPERTIES PREFIX "")
endif()

option(ANYTUNE_RECORDER_TESTS "Build the recorder's C tests" ON)
if(ANYTUNE_RECORDER_TESTS AND POLYCALL_STATIC_LIBRARY)
  enable_testing()
  add_executable(recorder_test tests/recorder_test.c)
  target_include_directories(recorder_test PRIVATE src)
  target_link_libraries(recorder_test PRIVATE anytune_recorder_core "${POLYCALL_STATIC_LIBRARY}")
  if(WIN32)
    target_link_libraries(recorder_test PRIVATE ws2_32 shell32)
  endif()
  add_test(NAME recorder_test COMMAND recorder_test "${CMAKE_CURRENT_BINARY_DIR}/test-recordings")
endif()
