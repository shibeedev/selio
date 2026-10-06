#!/usr/bin/env node
// Copies the monad-testnet deployment into the indexer (Part 10 §10.1 K.2):
//   node scripts/sync-deployment.mjs          writes abis/, the "# deployment.<key>" values of config.yaml
//                                             and src/deployment.ts
//   node scripts/sync-deployment.mjs --check  writes nothing; exits 1 listing every difference, missing
//                                             event, placeholder and explicit signature that does not match
//                                             the pinned EventsLib.sol sources
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const indexerDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = join(indexerDir, "..");
const contractsDir = join(repoDir, "contracts");

const DEPLOYMENT_FILE = join(contractsDir, "deployments", "monad-testnet.json");
const ABIS = [
  { artifact: join(contractsDir, "out", "MorphoVaultExitMarket.sol", "MorphoVaultExitMarket.json"), file: join(indexerDir, "abis", "MorphoVaultExitMarket.json"), contract: "SelioMarket" },
  { artifact: join(contractsDir, "out", "SelioVault.sol", "SelioVault.json"), file: join(indexerDir, "abis", "SelioVault.json"), contract: "SelioVault" },
];
const EVENTS_LIBS = {
  EarnVault: join(contractsDir, "lib", "vault-v2", "src", "libraries", "EventsLib.sol"),
  Morpho: join(contractsDir, "lib", "vault-v2", "lib", "morpho-blue", "src", "libraries", "EventsLib.sol"),
};
const CONFIG_FILE = join(indexerDir, "config.yaml");
const DEPLOYMENT_TS = join(indexerDir, "src", "deployment.ts");

const ADDRESS_KEYS = ["market", "selioVault", "earnVault", "morpho", "adapter", "underlying", "collateral"];
const ID_KEYS = ["earnMarketId", "flashMarketId"];
// Placeholders kept until the first deployment: small addresses (0x00…01) and ids, and start block 0.
const PLACEHOLDER = /^0x0+[0-9a-f]{0,2}$/;

const show = (path) => relative(repoDir, path).replaceAll("\\", "/");
const read = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const check = process.argv.includes("--check");
const problems = [];

/** Step 1: the deployment values the indexer needs, lowercased; null when the file is unusable. */
function loadDeployment() {
  if (!existsSync(DEPLOYMENT_FILE)) {
    problems.push(`${show(DEPLOYMENT_FILE)} does not exist (deploy Selio to monad-testnet first)`);
    return null;
  }
  let raw;
  try {
    raw = JSON.parse(read(DEPLOYMENT_FILE));
  } catch (error) {
    problems.push(`${show(DEPLOYMENT_FILE)} is not valid JSON: ${error.message}`);
    return null;
  }
  const before = problems.length;
  if (raw.network !== "monad-testnet") problems.push(`deployment network is ${JSON.stringify(raw.network)}, expected "monad-testnet"`);
  if (raw.chainId !== 10143) problems.push(`deployment chainId is ${JSON.stringify(raw.chainId)}, expected 10143`);
  if (raw.venue !== "morpho") problems.push(`deployment venue is ${JSON.stringify(raw.venue)}, expected "morpho"`);
  if (!Number.isSafeInteger(raw.deployBlock) || raw.deployBlock < 0) {
    problems.push(`deployment deployBlock is ${JSON.stringify(raw.deployBlock)}, expected a block number`);
  }
  for (const key of ADDRESS_KEYS) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(raw[key]))) problems.push(`deployment ${key} is ${JSON.stringify(raw[key])}, expected an address`);
  }
  for (const key of ID_KEYS) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(raw[key]))) problems.push(`deployment ${key} is ${JSON.stringify(raw[key])}, expected a bytes32 market id`);
  }
  if (problems.length > before) return null;
  const values = { chainId: raw.chainId, deployBlock: raw.deployBlock };
  for (const key of [...ADDRESS_KEYS, ...ID_KEYS]) values[key] = raw[key].toLowerCase();
  return values;
}

/** Step 2: the abi array of each forge artifact, as written to abis/. */
function loadAbis() {
  return ABIS.map(({ artifact, file, contract }) => {
    if (!existsSync(artifact)) {
      problems.push(`${show(artifact)} does not exist (run forge build in contracts/ first)`);
      return { file, contract, text: null };
    }
    const abi = JSON.parse(read(artifact)).abi;
    if (!Array.isArray(abi)) {
      problems.push(`${show(artifact)} has no abi array`);
      return { file, contract, text: null };
    }
    return { file, contract, text: `${JSON.stringify(abi, null, 2)}\n` };
  });
}

/** Step 3: config.yaml with every "# deployment.<key>" line set to that key's value. */
function syncedConfig(text, deployment) {
  return text.replace(/^(\s*(?:- )?\w+:\s*)(\S+)(\s+# deployment\.(\w+))$/gm, (line, head, _value, tail, key) => {
    if (!(key in deployment)) {
      problems.push(`config.yaml refers to deployment.${key}, which the deployment does not provide`);
      return line;
    }
    const value = key === "deployBlock" ? String(deployment.deployBlock) : `"${deployment[key]}"`;
    return `${head}${value}${tail}`;
  });
}

/** Step 4: src/deployment.ts. */
function deploymentTs(d) {
  const lines = Object.entries(d).map(([key, value]) => `  ${key}: ${typeof value === "number" ? value : `"${value}"`},`);
  return [
    "// Written by scripts/sync-deployment.mjs from contracts/deployments/monad-testnet.json. Do not edit by hand.",
    '// Before the first monad-testnet deployment the values are placeholders; "pnpm check" fails while any remains.',
    "export const DEPLOYMENT = {",
    ...lines,
    "} as const;",
    "",
  ].join("\n");
}

/** The events listed under each contract of config.yaml (names, or explicit signatures). */
function configEvents(text) {
  const section = text.slice(text.indexOf("\ncontracts:"), text.indexOf("\nchains:"));
  const events = {};
  let contract;
  for (const line of section.split("\n")) {
    const name = line.match(/^ {2}- name: (\w+)\s*$/);
    if (name) events[(contract = name[1])] = [];
    const event = line.match(/^\s+- event: (?:"([^"]+)"|(\S+))\s*$/);
    if (event && contract) events[contract].push(event[1] ?? event[2]);
  }
  return events;
}

/** `Name(type [indexed] name, …)` with single spaces; Morpho's `Id` is written as bytes32. */
function normalizeSignature(name, params) {
  const list = params
    .split(",")
    .map((param) => param.trim().replace(/\s+/g, " ").replace(/^Id /, "bytes32 "))
    .filter(Boolean);
  return `${name}(${list.join(", ")})`;
}

function solidityEvents(path) {
  const code = read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return new Set([...code.matchAll(/\bevent\s+(\w+)\s*\(([^)]*)\)\s*;/g)].map((m) => normalizeSignature(m[1], m[2])));
}

function compare(path, expected, source) {
  if (!existsSync(path)) problems.push(`${show(path)} is missing`);
  else if (read(path) !== expected) problems.push(`${show(path)} differs from ${source}; run pnpm sync`);
}

const deployment = loadDeployment();
const abis = loadAbis();
const configText = read(CONFIG_FILE);

if (check) {
  if (deployment) {
    compare(CONFIG_FILE, syncedConfig(configText, deployment), show(DEPLOYMENT_FILE));
    compare(DEPLOYMENT_TS, deploymentTs(deployment), show(DEPLOYMENT_FILE));
  }
  for (const [i, { file, text }] of abis.entries()) if (text !== null) compare(file, text, show(ABIS[i].artifact));

  const events = configEvents(configText);
  for (const { file, contract } of ABIS) {
    const names = new Set(JSON.parse(read(file)).filter((item) => item.type === "event").map((item) => item.name));
    for (const name of events[contract] ?? []) {
      if (!names.has(name)) problems.push(`${contract}.${name} is not an event of ${show(file)}`);
    }
  }
  for (const [contract, path] of Object.entries(EVENTS_LIBS)) {
    if (!existsSync(path)) {
      problems.push(`${show(path)} does not exist (git submodule update --init --recursive)`);
      continue;
    }
    const declared = solidityEvents(path);
    for (const signature of events[contract] ?? []) {
      const match = signature.match(/^(\w+)\((.*)\)$/);
      if (!match || !declared.has(normalizeSignature(match[1], match[2]))) {
        problems.push(`${contract} event "${signature}" does not match an event of ${show(path)}`);
      }
    }
  }

  for (const line of configText.split("\n").filter((l) => l.includes("# deployment."))) {
    const value = line.replace(/#.*$/, "").split(":").slice(1).join(":").trim().replaceAll('"', "");
    if (value === "0" || PLACEHOLDER.test(value)) problems.push(`${show(CONFIG_FILE)} still has a placeholder: ${line.trim()}`);
  }
  for (const [, key, value] of read(DEPLOYMENT_TS).matchAll(/^\s+(\w+): "?([^",]+)"?,$/gm)) {
    if (key !== "chainId" && (value === "0" || PLACEHOLDER.test(value))) {
      problems.push(`${show(DEPLOYMENT_TS)} still has a placeholder: ${key} ${value}`);
    }
  }

  if (problems.length > 0) {
    console.error(`The indexer is not in sync with ${show(DEPLOYMENT_FILE)}:`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log(`The indexer is in sync with ${show(DEPLOYMENT_FILE)}.`);
} else {
  const config = deployment ? syncedConfig(configText, deployment) : configText;
  if (problems.length > 0 || !deployment) {
    console.error("Nothing was written:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  for (const { file, text } of abis) writeFileSync(file, text);
  writeFileSync(CONFIG_FILE, config);
  writeFileSync(DEPLOYMENT_TS, deploymentTs(deployment));
  console.log(`Synced from ${show(DEPLOYMENT_FILE)} (deploy block ${deployment.deployBlock}):`);
  for (const path of [...abis.map((a) => a.file), CONFIG_FILE, DEPLOYMENT_TS]) console.log(`- ${show(path)}`);
}
