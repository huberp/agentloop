---
name: cmake-workflow
description: CMake-specific build, test, and packaging patterns including preset-based workflows
version: 1.0.0
slot: section
---

## CMake Workflow Guidelines

### Project layout conventions

- Source lives in `src/`; headers in `include/`; tests in `tests/` or `test/`.
- Out-of-source builds go in `build/` (excluded from version control via `.gitignore`).
- `CMakeLists.txt` at the repository root is the entry point; each subdirectory may have its own `CMakeLists.txt`.

### Preset-based workflow (preferred when `CMakePresets.json` exists)

```bash
# Configure
cmake --preset <preset-name>          # e.g. linux-release, debug, ci

# Build
cmake --build --preset <build-preset> [--parallel $(nproc)]

# Test
ctest --preset <test-preset> [--output-on-failure]
```

List available presets:
```bash
cmake --list-presets          # configure presets
cmake --build --list-presets  # build presets
ctest --list-presets          # test presets
```

### Classic out-of-source workflow (no presets)

```bash
# Configure (Release build, Ninja generator recommended)
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release

# Build (parallel)
cmake --build build --parallel $(nproc)

# Test
cd build && ctest --output-on-failure
```

### Dependency management

- **Submodules**: always run `git submodule update --init --recursive` before configuring.
- **find_package**: ensure system libraries are installed (e.g. `sudo apt install libssl-dev`).
- **FetchContent / CPM.cmake**: dependencies are downloaded during configure; verify internet access or a local cache is available.
- **vcpkg / Conan**: run `vcpkg install` or `conan install .` before `cmake -S . -B build`.

### Install-step dependencies pattern

When a project ships a dependency-installation script (e.g. `scripts/install-linux-deps.sh`), run it *before* the CMake configure step:

```bash
sudo bash scripts/install-linux-deps.sh
git submodule update --init --recursive
cmake --preset <preset>
cmake --build --preset <build-preset> --parallel $(nproc)
```

### Common CMake variables

| Variable | Purpose |
|---|---|
| `CMAKE_BUILD_TYPE` | `Debug`, `Release`, `RelWithDebInfo`, `MinSizeRel` |
| `CMAKE_INSTALL_PREFIX` | Install destination (default `/usr/local`) |
| `CMAKE_TOOLCHAIN_FILE` | Cross-compile or vcpkg toolchain |
| `BUILD_SHARED_LIBS` | `ON` to build shared libraries by default |
| `CMAKE_EXPORT_COMPILE_COMMANDS` | `ON` to generate `compile_commands.json` for tooling |

### Diagnosing build failures

1. Check the **configure step** output first — missing dependencies abort here.
2. Look for the **first** error in compiler output; subsequent errors are often cascading.
3. Enable verbose output to see exact compiler flags: `cmake --build build --verbose` or `VERBOSE=1 make`.
4. Use `--fresh` flag to force a clean reconfigure: `cmake --fresh --preset <preset>`.
