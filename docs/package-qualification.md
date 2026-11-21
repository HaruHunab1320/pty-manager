# Package release qualification

Source tests and loading a local build do not establish that the published package can start a terminal in another application. Qualify the exact archive outside the repository before publishing.

```sh
pnpm test
pnpm type-check
pnpm test:dist
npm pack --pack-destination /absolute/path/to/evidence --json
pnpm qualify:package --tarball /absolute/path/to/evidence/pty-manager-1.12.2.tgz --receipt /absolute/path/to/evidence/macos.json
```

`qualify:package` installs the archive into a disposable consumer with a new npm cache and an empty operator configuration. It does not pass operator secrets to npm or the test shell. It resolves both CommonJS and ESM exports from that consumer, runs native PTY spawn/output/input/resize/natural-exit, force-stop and manager-shutdown checks, and verifies the created PIDs have exited. The parent records child/descendant PIDs from the OS process tree and verifies the smoke's IPC-reported PTY PID belongs to that tree. On timeout, SIGTERM or SIGINT it terminates descendants before their Node parent, allowing native children to be reaped. Cleanup is bounded and independently verified; it does not depend on the interrupted child's `finally` block. A receipt reports `cleanup: incomplete` and failure if cleanup cannot be verified, retaining its scratch directory for diagnosis. Scratch files are removed only after verified process cleanup. Missing archives fail with a receipt before scratch allocation. The archive and requested receipt remain as evidence artifacts.

Run the controlled failure cases against the same exact archive (the test command also repeats the successful CJS/ESM checks):

```sh
PTY_QUALIFICATION_TARBALL=/absolute/path/to/evidence/pty-manager-1.12.2.tgz \
PTY_QUALIFICATION_EVIDENCE=/absolute/path/to/evidence/cleanup-tests \
node --test tests/package-qualification/cleanup.test.mjs
```

These tests exercise a missing archive, a deadline while a real PTY is open, and SIGTERM of the qualifier after a real PTY is ready. They assert the expected failure/cancellation, zero remaining owned PIDs, and no leftover consumer directories. `--control timeout` and `--control cancel` are deliberate negative-test hooks, never release passes.

Run the same command inside the exact Linux image intended by the consumer. Mount this repository read-only for the qualification script and mount only the evidence directory writable; do not mount the host Docker socket or home directory. Give any container a unique run-owned name/label and remove it on success, failure and cancellation. Record the image digest, architecture, Node version and npm dependency integrity from the JSON receipt. A macOS pass is not a Linux pass.

`node-pty` may compile its native module on Linux. A bare `node:bookworm-slim` image is insufficient: install Python3, make and g++ in the build environment, as Lookout's investigator Dockerfile does. This qualification harness additionally requires `ps` (`procps` on Debian) to track descendant ownership; it is not a package runtime dependency. If that image includes Node headers under `/usr/local`, pass `--node-headers /usr/local` to avoid downloading a different headers artifact, or set `PTY_QUALIFICATION_NODE_HEADERS=/usr/local` for the test command. Runtime images should receive the native module built for the same platform and Node version.

For a registry release, install the published version in a fresh consumer and repeat the smoke checks or download that exact registry archive and run this qualifier. Compare the registry integrity with the qualified archive. Preserve missing-platform or registry-access failures as explicit gates rather than declaring the whole package ready.

The existing `tests/build-output/module-formats.test.mjs` covers the ESM `__dirname` regression. The isolated consumer smoke intentionally uses real terminal processes, not mocked `node-pty`.
