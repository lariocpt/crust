// Entry point for the mongo-bundled binaries (crust-<platform>-<arch>-mongo).
// Identical to src/index.ts except that the mongodb driver is compiled in:
// mongo-bundled registers it, then the normal CLI runs.
import "./mongo-bundled";
import "./index";
