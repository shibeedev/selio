import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const DatabaseSync: typeof import("node:sqlite").DatabaseSync = require("node:sqlite").DatabaseSync;
