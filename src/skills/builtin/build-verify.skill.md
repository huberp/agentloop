---
name: build-verify
description: Workflow guidance for verifying that a project compiles and links correctly
version: 1.0.0
slot: section
---

## Build Verification Workflow

The goal of this workflow is to confirm the project compiles cleanly and to surface any errors with actionable context.

### Step sequence

1. **Identify the build system** — inspect the workspace root for `CMakeLists.txt`, `Cargo.toml`, `package.json`, `build.gradle`, or `pom.xml` to determine which build tool to invoke.
2. **Install / update dependencies** — run the dependency installation step *before* building:
   - CMake: `git submodule update --init --recursive` (if submodules present)
   - Node: `npm ci` or `yarn install --frozen-lockfile`
   - Rust: `cargo fetch`
   - Gradle: `./gradlew dependencies` (optional)
3. **Configure the build** (if required):
   - CMake: `cmake -S . -B build [-DCMAKE_BUILD_TYPE=Release]` or `cmake --preset <preset>`
   - Gradle: no separate configure step
4. **Compile**:
   - CMake: `cmake --build build [--parallel $(nproc)]` or `cmake --build --preset <preset>`
   - Node: `npm run build`
   - Rust: `cargo build [--release]`
   - Gradle: `./gradlew assemble` (compile only, no tests)
   - Maven: `mvn package -DskipTests`
5. **Report** — emit a structured summary: overall status (success/failure), number of errors and warnings, and the first 20 lines of compiler output for failures.

### Error triage heuristics

- **Linker errors** (`undefined reference`, `unresolved symbol`): check `CMakeLists.txt` for missing `target_link_libraries` entries; for Gradle check `dependencies` block.
- **Missing headers / imports**: confirm that all required packages are declared in the manifest and that dependency installation succeeded in step 2.
- **Type / compilation errors** in generated code: regenerate protobuf, Thrift, or OpenAPI sources before building.
- **Out-of-date build cache**: perform a clean build (`rm -rf build && cmake …` or `cargo clean && cargo build`) to rule out stale artifacts.

### Parallel build flag

When invoking multi-core builds, pass a parallelism flag to keep wall-clock time low:
- CMake/Ninja: `--parallel $(nproc)` or `-j$(nproc)`
- Maven: `-T 1C` (one thread per CPU core)
- Gradle: `--parallel`
