// Compiled ONLY into the -mongo variant binaries. The static import makes
// `bun build --compile` bundle the driver into the binary (build-time
// resolution — the only path that works in a compiled binary, measured
// 2026-11-12); the registration runs before index.ts evaluates because static
// imports are fully evaluated in order before the importing module's body.
import { MongoClient } from "mongodb";
import { setBundledMongo } from "./builtinFns/mongo";

setBundledMongo({ MongoClient });
