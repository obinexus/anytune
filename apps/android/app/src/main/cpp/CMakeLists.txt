# The Android app's native code: AnyTune's JNI bridge (anytune_bridge.c) and AnyTune's recorder module (native/recorder, compiled from its sources), linked
# against the Polycall library staged for this ABI (native/android/<abi>/libpolycall.so — built from the pinned commit by tools/native/stage.ts, never by
# this build, so that the APK carries the verified bytes: npm run native:verify -- --apk <apk>).
cmake_minimum_required(VERSION 3.22.1)
project(anytune_android C)

set(ANYTUNE_ROOT "" CACHE PATH "the AnyTune checkout (Gradle passes it)")
set(POLYCALL_INCLUDE_DIR "${ANYTUNE_ROOT}/native/include/polycall")
set(POLYCALL_SHARED "${ANYTUNE_ROOT}/native/android/${ANDROID_ABI}/libpolycall.so")
if(NOT EXISTS "${POLYCALL_SHARED}" OR NOT EXISTS "${POLYCALL_INCLUDE_DIR}/polycall.h")
  message(FATAL_ERROR "Polycall is not staged for ${ANDROID_ABI} (${POLYCALL_SHARED}): run `npm run native:stage` in ${ANYTUNE_ROOT}")
endif()

add_library(polycall SHARED IMPORTED)
set_target_properties(polycall PROPERTIES IMPORTED_LOCATION "${POLYCALL_SHARED}" INTERFACE_INCLUDE_DIRECTORIES "${POLYCALL_INCLUDE_DIR}")

set(ANYTUNE_RECORDER_TESTS OFF CACHE BOOL "" FORCE)
# as cache entries: the recorder's CMakeLists declares them with set(CACHE), which (policy CMP0126 OLD at its 3.20 minimum) would drop a plain variable
set(POLYCALL_INCLUDE_DIR "${POLYCALL_INCLUDE_DIR}" CACHE PATH "" FORCE)
set(POLYCALL_STATIC_LIBRARY "" CACHE FILEPATH "" FORCE)
add_subdirectory("${ANYTUNE_ROOT}/native/recorder" "${CMAKE_BINARY_DIR}/recorder")

add_library(anytune_bridge SHARED anytune_bridge.c)
target_link_libraries(anytune_bridge PRIVATE anytune_recorder_core polycall log)
target_compile_options(anytune_bridge PRIVATE -Wall -Wextra -Werror)
# Android 15+ devices may use 16 KB pages: every loadable segment is aligned to them (as libpolycall.so is)
target_link_options(anytune_bridge PRIVATE "-Wl,-z,max-page-size=16384")
