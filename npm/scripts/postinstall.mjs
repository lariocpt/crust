// crust — npm postinstall.
//
// A fast path, not the mechanism. npm 12 blocks install scripts by default, so bin/crust
// fetches the binary lazily on first use and this script only front-loads that work for
// environments where scripts still run. All the logic lives in lib/install.mjs so the two
// entry points cannot drift apart.
//
// It must never fail the install. A postinstall that exits non-zero aborts the whole
// `npm install`, and "you are not on the LAN right now" is not a reason to refuse to install
// a package whose launcher can recover later.
import { ensureBinary, APPS_URL_EFFECTIVE } from "../lib/install.mjs";

const say = (m) => console.log(`[crust] ${m}`);
const warn = (m) => console.warn(`[crust] ${m}`);

try {
  await ensureBinary({ log: say, warn });
} catch (e) {
  warn(e.message);
  warn(`the binary is hosted on the LAN at ${APPS_URL_EFFECTIVE}; it will be fetched on first run instead.`);
}
process.exit(0);
