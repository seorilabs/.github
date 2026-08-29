#!/usr/bin/env node

import { createPublicKey } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createWorkflowBundle, validateWorkflowBundle } from "./fleet.mjs";
import {
  createFleetMigrationPlan,
  loadTrustedFleetMigrationChainHeadBinding,
  loadTrustedFleetMigrationHistoricalInventoryBinding,
  loadTrustedFleetMigrationInventoryBinding,
  validateFleetMigrationPlan,
} from "./fleet-migration.mjs";

function parseOptions(argv) {
  const options = Object.create(null);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z][a-z0-9-]*$/u.test(name ?? "") || value === undefined) {
      throw new Error("OPTION_INVALID");
    }
    const key = name.slice(2);
    if (Object.hasOwn(options, key)) throw new Error("OPTION_INVALID");
    options[key] = value;
  }
  return options;
}

function requireOption(options, name, errorCode) {
  if (options[name] === undefined) throw new Error(errorCode);
  return options[name];
}

async function loadEd25519PublicKey(path, errorPrefix) {
  const encodedKey = await readFile(path, "utf8");
  if (/PRIVATE KEY/u.test(encodedKey)) {
    throw new Error(`${errorPrefix}_PUBLIC_KEY_REQUIRED`);
  }
  let publicKey;
  try {
    publicKey = createPublicKey(encodedKey);
  } catch {
    throw new Error(`${errorPrefix}_PUBLIC_KEY_INVALID`);
  }
  if (
    publicKey.type !== "public" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error(`${errorPrefix}_PUBLIC_KEY_INVALID`);
  }
  return publicKey;
}

async function loadInventoryTrustRoots(options) {
  if (
    options["trusted-key-id"] === undefined ||
    options["trusted-public-key"] === undefined
  ) {
    throw new Error("MIGRATION_TRUST_ROOT_REQUIRED");
  }
  const publicKey = await loadEd25519PublicKey(
    options["trusted-public-key"],
    "MIGRATION",
  );
  const trustedInventoryKeys = new Map([
    [options["trusted-key-id"], publicKey],
  ]);
  return trustedInventoryKeys;
}

async function loadPriorMigrationInput(
  inventory,
  options,
  trustedInventoryKeys,
  trustedStateAuthorityReadback,
  now,
) {
  if (inventory.lineage.mode === "BOOTSTRAP") {
    if (
      options["prior-inventory"] !== undefined ||
      options["chain-head"] !== undefined ||
      options["trusted-chain-head-key-id"] !== undefined ||
      options["trusted-chain-head-public-key"] !== undefined
    ) {
      throw new Error("MIGRATION_WAVE_INPUT_NOT_ALLOWED");
    }
    return {};
  }
  if (options["prior-inventory"] === undefined) {
    throw new Error("MIGRATION_PRIOR_INVENTORY_REQUIRED");
  }
  const priorInventory = JSON.parse(
    await readFile(options["prior-inventory"], "utf8"),
  );
  const trustedPriorInventoryBinding =
    loadTrustedFleetMigrationHistoricalInventoryBinding({
      inventory: priorInventory,
      trustedInventoryKeys,
      now,
    });
  if (
    options["chain-head"] === undefined ||
    options["trusted-chain-head-key-id"] === undefined ||
    options["trusted-chain-head-public-key"] === undefined
  ) {
    throw new Error("MIGRATION_CHAIN_HEAD_REQUIRED");
  }
  const chainHead = JSON.parse(await readFile(options["chain-head"], "utf8"));
  const chainHeadPublicKey = await loadEd25519PublicKey(
    options["trusted-chain-head-public-key"],
    "MIGRATION_CHAIN_HEAD",
  );
  const trustedChainHeadKeys = new Map([
    [options["trusted-chain-head-key-id"], chainHeadPublicKey],
  ]);
  const trustedChainHeadBinding =
    await loadTrustedFleetMigrationChainHeadBinding({
      chainHead,
      trustedChainHeadKeys,
      trustedInventoryKeys,
      trustedStateAuthorityReadback,
      now,
    });
  return {
    priorInventory,
    trustedPriorInventoryBinding,
    chainHead,
    trustedChainHeadBinding,
  };
}

function migrationPlanOptions(trustedInventoryBinding, priorInput, now) {
  return {
    trustedInventoryBinding,
    ...priorInput,
    now,
  };
}

function loadCurrentInventoryBinding(
  inventory,
  trustedInventoryKeys,
  priorInput,
  now,
) {
  return loadTrustedFleetMigrationInventoryBinding({
    inventory,
    trustedInventoryKeys,
    ...priorInput,
    now,
  });
}

async function emit(content, outputPath, stdout) {
  if (outputPath) {
    await writeFile(outputPath, content, { encoding: "utf8", mode: 0o644 });
  } else {
    stdout.write(content);
  }
}

export async function runFleetCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  clock = () => Date.now(),
  trustedStateAuthorityReadback,
} = {}) {
  const [command, ...optionArgs] = argv;
  let options;
  try {
    options = parseOptions(optionArgs);
  } catch {
    stderr.write("오류 [OPTION_INVALID] 옵션은 --이름 값 형식이어야 합니다.\n");
    return 2;
  }

  try {
    if (command === "bundle") {
      const platformRelease = options["platform-release"]
        ? JSON.parse(await readFile(options["platform-release"], "utf8"))
        : undefined;
      const bundle = await createWorkflowBundle({
        sourceSha: options["source-sha"],
        platformRelease,
      });
      await emit(
        `${JSON.stringify(bundle, null, 2)}\n`,
        options.output,
        stdout,
      );
      return 0;
    }

    if (command === "validate-bundle") {
      const bundle = JSON.parse(await readFile(options.bundle, "utf8"));
      const result = await validateWorkflowBundle(bundle);
      if (!result.ok) {
        for (const diagnostic of result.diagnostics) {
          stderr.write(`오류 [${diagnostic}] WorkflowBundle 검증 실패\n`);
        }
        return 1;
      }
      stdout.write("WorkflowBundle 검증 통과\n");
      return 0;
    }

    if (command === "plan-migration") {
      if (options.output !== undefined) {
        throw new Error("MIGRATION_STDOUT_ONLY");
      }
      const inventoryPath = requireOption(
        options,
        "inventory",
        "MIGRATION_INVENTORY_REQUIRED",
      );
      const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
      const now = clock();
      const trustedInventoryKeys = await loadInventoryTrustRoots(options);
      const priorInput = await loadPriorMigrationInput(
        inventory,
        options,
        trustedInventoryKeys,
        trustedStateAuthorityReadback,
        now,
      );
      const trustedInventoryBinding = loadCurrentInventoryBinding(
        inventory,
        trustedInventoryKeys,
        priorInput,
        now,
      );
      const plan = createFleetMigrationPlan(
        inventory,
        migrationPlanOptions(trustedInventoryBinding, priorInput, now),
      );
      stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }

    if (command === "validate-migration-plan") {
      const planPath = requireOption(
        options,
        "plan",
        "MIGRATION_PLAN_REQUIRED",
      );
      const inventoryPath = requireOption(
        options,
        "inventory",
        "MIGRATION_INVENTORY_REQUIRED",
      );
      const plan = JSON.parse(await readFile(planPath, "utf8"));
      const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
      const now = clock();
      const trustedInventoryKeys = await loadInventoryTrustRoots(options);
      const priorInput = await loadPriorMigrationInput(
        inventory,
        options,
        trustedInventoryKeys,
        trustedStateAuthorityReadback,
        now,
      );
      const trustedInventoryBinding = loadCurrentInventoryBinding(
        inventory,
        trustedInventoryKeys,
        priorInput,
        now,
      );
      const result = validateFleetMigrationPlan(plan, {
        inventory,
        ...migrationPlanOptions(trustedInventoryBinding, priorInput, now),
      });
      if (!result.ok) {
        for (const diagnostic of result.diagnostics) {
          stderr.write(`오류 [${diagnostic}] Fleet migration plan 검증 실패\n`);
        }
        return 1;
      }
      stdout.write("Fleet migration plan 검증 통과\n");
      return 0;
    }
  } catch (error) {
    const code = String(error?.message ?? "FLEET_CONTRACT_FAILED").split(
      ":",
    )[0];
    stderr.write(`오류 [${code}] fleet 계약 작업을 완료할 수 없습니다.\n`);
    return 1;
  }

  stderr.write(
    "사용법: fleet-contract bundle|validate-bundle|plan-migration|validate-migration-plan [옵션]\n",
  );
  return 2;
}

let isEntrypoint = false;
try {
  isEntrypoint =
    Boolean(process.argv[1]) &&
    realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
} catch {
  isEntrypoint = false;
}

if (isEntrypoint) {
  process.exitCode = await runFleetCli();
}
