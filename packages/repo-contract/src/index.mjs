import { createHash } from "node:crypto";
import { constants as fsConstants, existsSync } from "node:fs";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { parseDocument } from "yaml";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const DEFAULT_MANIFEST_PATH = ".seorilabs/app.yaml";
const BUNDLED_CONTRACTS_ROOT = resolve(PACKAGE_ROOT, ".generated/contracts");
const WORKSPACE_CONTRACTS_ROOT = resolve(PACKAGE_ROOT, "../../contracts");
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "../..");
const IS_SOURCE_WORKSPACE =
  existsSync(resolve(WORKSPACE_ROOT, "package.json")) &&
  existsSync(resolve(WORKSPACE_CONTRACTS_ROOT, "app.schema.json"));
const DEFAULT_CONTRACTS_ROOT = IS_SOURCE_WORKSPACE
  ? WORKSPACE_CONTRACTS_ROOT
  : BUNDLED_CONTRACTS_ROOT;
const BUNDLED_PROFILES_ROOT = resolve(PACKAGE_ROOT, ".generated/profiles");
const WORKSPACE_PROFILES_ROOT = resolve(PACKAGE_ROOT, "../../profiles");

export const DEFAULT_SCHEMA_PATH = resolve(
  DEFAULT_CONTRACTS_ROOT,
  "app.schema.json",
);
export const DEFAULT_PROFILES_ROOT = IS_SOURCE_WORKSPACE
  ? WORKSPACE_PROFILES_ROOT
  : BUNDLED_PROFILES_ROOT;

const MARKET_SCHEMA_BY_KEY = Object.freeze({
  googlePlay: "google-play.schema.json",
  appleAppStore: "app-store.schema.json",
  appsInToss: "apps-in-toss.schema.json",
});

const FORBIDDEN_CREDENTIAL_FIELDS = new Set([
  "apikey",
  "accesstoken",
  "certificatebase64",
  "clientsecret",
  "credentialvalue",
  "credentialsjson",
  "keypassword",
  "keystorebase64",
  "password",
  "passphrase",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretvalue",
  "serviceaccountjson",
  "storepassword",
  "token",
]);

const SENSITIVE_LITERAL_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /["']private_key["']\s*:/u,
];

const AJV_MESSAGE_BY_KEYWORD = Object.freeze({
  additionalProperties: "허용되지 않은 항목입니다.",
  anyOf: "허용된 구조 중 하나와 일치해야 합니다.",
  const: "조직 계약에 고정된 값과 일치해야 합니다.",
  contains: "필수 항목 조합을 충족하지 않습니다.",
  dependentRequired: "연관된 필수 항목이 없습니다.",
  enum: "허용된 값이 아닙니다.",
  if: "조건부 계약을 충족하지 않습니다.",
  maxItems: "허용된 항목 수를 초과했습니다.",
  maxLength: "허용된 길이를 초과했습니다.",
  minItems: "필수 항목 수를 충족하지 않습니다.",
  minLength: "필수 길이를 충족하지 않습니다.",
  minimum: "허용된 최솟값보다 작습니다.",
  not: "금지된 구조입니다.",
  oneOf: "정확히 하나의 허용 구조와 일치해야 합니다.",
  pattern: "필수 형식을 충족하지 않습니다.",
  patternProperties: "속성 이름이 필수 형식을 충족하지 않습니다.",
  propertyNames: "허용되지 않은 속성 이름입니다.",
  required: "필수 항목이 없습니다.",
  type: "필수 자료형과 다릅니다.",
  uniqueItems: "중복 항목이 있습니다.",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeJsonPathKey(key) {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)) {
    return `.${key}`;
  }
  return `[${JSON.stringify(key)}]`;
}

function appendJsonPath(path, segment) {
  const rawSegment = String(segment);
  const safeSegment = SENSITIVE_LITERAL_PATTERNS.some((pattern) =>
    pattern.test(rawSegment)
  )
    ? "<redacted>"
    : rawSegment;
  if (typeof segment === "number" || /^\d+$/u.test(safeSegment)) {
    return `${path}[${segment}]`;
  }
  return `${path}${escapeJsonPathKey(safeSegment)}`;
}

function pointerToJsonPath(pointer) {
  if (!pointer) {
    return "$";
  }

  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((path, segment) => appendJsonPath(path, segment), "$");
}

function redactSensitiveText(value) {
  const text = String(value);
  return SENSITIVE_LITERAL_PATTERNS.some((pattern) => pattern.test(text))
    ? "<redacted>"
    : text;
}

function makeDiagnostic({ code, document, path = "$", message }) {
  return Object.freeze({
    code,
    document: redactSensitiveText(document),
    path: redactSensitiveText(path),
    message: redactSensitiveText(message),
  });
}

function sortDiagnostics(diagnostics) {
  const compare = (left, right) => {
    if (left === right) {
      return 0;
    }
    return left < right ? -1 : 1;
  };
  return diagnostics.toSorted((left, right) => {
    return (
      compare(left.document, right.document) ||
      compare(left.path, right.path) ||
      compare(left.code, right.code) ||
      compare(left.message, right.message)
    );
  });
}

export function formatDiagnostic(diagnostic) {
  return `오류 [${diagnostic.code}] ${diagnostic.document} ${diagnostic.path}: ${diagnostic.message}`;
}

function parseYaml(text, document) {
  let parsed;
  try {
    parsed = parseDocument(text, {
      maxAliasCount: 50,
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch {
    return {
      diagnostic: makeDiagnostic({
        code: "PARSE_YAML",
        document,
        message: "YAML 문서를 해석할 수 없습니다.",
      }),
    };
  }

  if (parsed.errors.length > 0) {
    const position = parsed.errors[0]?.linePos?.[0];
    const location = position
      ? ` (${position.line}행 ${position.col}열)`
      : "";
    return {
      diagnostic: makeDiagnostic({
        code: "PARSE_YAML",
        document,
        message: `YAML 문서를 해석할 수 없습니다.${location}`,
      }),
    };
  }

  try {
    return { value: parsed.toJS({ maxAliasCount: 50 }) };
  } catch {
    return {
      diagnostic: makeDiagnostic({
        code: "PARSE_YAML",
        document,
        message: "YAML 문서를 해석할 수 없습니다.",
      }),
    };
  }
}

function parseJson(text, document) {
  try {
    return { value: JSON.parse(text) };
  } catch {
    return {
      diagnostic: makeDiagnostic({
        code: "PARSE_JSON",
        document,
        message: "JSON 문서를 해석할 수 없습니다.",
      }),
    };
  }
}

async function readDocument(absolutePath, document) {
  let text;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    return {
      diagnostic: makeDiagnostic({
        code: error?.code === "ENOENT" ? "FILE_MISSING" : "FILE_UNREADABLE",
        document,
        message:
          error?.code === "ENOENT"
            ? "필수 파일이 없습니다."
            : "파일을 읽을 수 없습니다.",
      }),
    };
  }

  return document.endsWith(".json")
    ? parseJson(text, document)
    : parseYaml(text, document);
}

function createAjv(schema) {
  const options = {
    allErrors: true,
    messages: false,
    strict: true,
    validateFormats: false,
  };
  return schema?.$schema?.includes("2020-12")
    ? new Ajv2020(options)
    : new Ajv(options);
}

function schemaDiagnostics({ schema, value, document }) {
  let validate;
  try {
    validate = createAjv(schema).compile(schema);
  } catch {
    return [
      makeDiagnostic({
        code: "CONTRACT_SCHEMA_INVALID",
        document,
        message: "계약 스키마 자체가 유효하지 않습니다.",
      }),
    ];
  }

  if (validate(value)) {
    return [];
  }

  return (validate.errors ?? []).map((error) => {
    let path = pointerToJsonPath(error.instancePath);
    if (error.keyword === "required" && error.params?.missingProperty) {
      path = appendJsonPath(path, error.params.missingProperty);
    } else if (
      error.keyword === "additionalProperties" &&
      error.params?.additionalProperty
    ) {
      path = appendJsonPath(path, error.params.additionalProperty);
    } else if (error.keyword === "propertyNames" && error.params?.propertyName) {
      path = appendJsonPath(path, error.params.propertyName);
    }

    return makeDiagnostic({
      code: `SCHEMA_${error.keyword.toUpperCase()}`,
      document,
      path,
      message:
        AJV_MESSAGE_BY_KEYWORD[error.keyword] ??
        "계약 스키마를 충족하지 않습니다.",
    });
  });
}

function normalizedFieldName(field) {
  return field.replaceAll(/[^A-Za-z0-9]/gu, "").toLowerCase();
}

function looksLikeCredentialValueField(field, credentialDocument) {
  const normalized = normalizedFieldName(field);
  if (FORBIDDEN_CREDENTIAL_FIELDS.has(normalized)) {
    return true;
  }
  if (credentialDocument && ["data", "stringdata", "value", "values"].includes(normalized)) {
    return true;
  }
  return /(?:secret|token|password|passphrase|privatekey|apikey|certificate|keystore).*(?:base64|content|json|pem|raw|value)$/u.test(
    normalized,
  );
}

function findCredentialMaterial(
  value,
  { document, path = "$", credentialDocument = false },
) {
  const diagnostics = [];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      diagnostics.push(
        ...findCredentialMaterial(item, {
          document,
          path: appendJsonPath(path, index),
          credentialDocument,
        }),
      );
    }
    return diagnostics;
  }

  if (!isRecord(value)) {
    if (
      typeof value === "string" &&
      SENSITIVE_LITERAL_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      diagnostics.push(
        makeDiagnostic({
          code: "CREDENTIAL_LITERAL_FORBIDDEN",
          document,
          path,
          message: "자격증명 값으로 보이는 문자열을 저장할 수 없습니다.",
        }),
      );
    }
    return diagnostics;
  }

  for (const [field, nestedValue] of Object.entries(value)) {
    const nestedPath = appendJsonPath(path, field);
    if (looksLikeCredentialValueField(field, credentialDocument)) {
      diagnostics.push(
        makeDiagnostic({
          code: "CREDENTIAL_VALUE_FIELD_FORBIDDEN",
          document,
          path: nestedPath,
          message: "자격증명 값 필드는 저장할 수 없습니다. 논리 ID나 Secret 이름만 사용하세요.",
        }),
      );
    }
    diagnostics.push(
      ...findCredentialMaterial(nestedValue, {
        document,
        path: nestedPath,
        credentialDocument,
      }),
    );
  }
  return diagnostics;
}

function credentialConsumerSemanticDiagnostics(value, document, expectedAppId) {
  if (!Array.isArray(value?.consumers)) {
    return [];
  }

  const diagnostics = [];
  const consumerIds = new Set();
  const bindingTargets = new Set();
  for (const [consumerIndex, consumer] of value.consumers.entries()) {
    if (!isRecord(consumer)) {
      continue;
    }
    if (typeof consumer.id === "string") {
      if (consumerIds.has(consumer.id)) {
        diagnostics.push(
          makeDiagnostic({
            code: "CREDENTIAL_CONSUMER_ID_DUPLICATE",
            document,
            path: appendJsonPath(
              appendJsonPath("$.consumers", consumerIndex),
              "id",
            ),
            message: "자격증명 consumer ID가 중복되었습니다.",
          }),
        );
      }
      consumerIds.add(consumer.id);
    }

    const credentialIdParts = typeof consumer.logicalCredentialId === "string"
      ? consumer.logicalCredentialId.split("/")
      : [];
    if (
      consumer.scope === "app" &&
      typeof expectedAppId === "string" &&
      (credentialIdParts[0] !== "app" ||
        credentialIdParts[1] !== expectedAppId)
    ) {
      diagnostics.push(
        makeDiagnostic({
          code: "CREDENTIAL_APP_SCOPE_MISMATCH",
          document,
          path: appendJsonPath(
            appendJsonPath("$.consumers", consumerIndex),
            "logicalCredentialId",
          ),
          message: "앱 전용 자격증명 ID는 manifest의 appId namespace에 속해야 합니다.",
        }),
      );
    }

    if (!Array.isArray(consumer.bindings)) {
      continue;
    }
    for (const [bindingIndex, binding] of consumer.bindings.entries()) {
      if (!isRecord(binding)) {
        continue;
      }
      const tupleParts = [
        binding.target,
        binding.environment ?? "",
        binding.namespace ?? "",
        binding.name,
      ];
      if (!tupleParts.every((part) => typeof part === "string")) {
        continue;
      }
      const tuple = tupleParts.join("\0");
      if (bindingTargets.has(tuple)) {
        diagnostics.push(
          makeDiagnostic({
            code: "CREDENTIAL_BINDING_DUPLICATE",
            document,
            path: appendJsonPath(
              appendJsonPath(
                appendJsonPath("$.consumers", consumerIndex),
                "bindings",
              ),
              bindingIndex,
            ),
            message: "동일한 실행 자격증명 binding이 중복되었습니다.",
          }),
        );
      }
      bindingTargets.add(tuple);
    }
  }
  return diagnostics;
}

function canonicalCommandsFromSchema(schema) {
  const commandProperties =
    schema?.properties?.quality?.properties?.commands?.properties;
  if (!isRecord(commandProperties)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(commandProperties)
      .filter(([, definition]) => typeof definition?.const === "string")
      .map(([key, definition]) => [key, definition.const]),
  );
}

function semanticDiagnostics(manifest, schema, document) {
  if (!isRecord(manifest)) {
    return [];
  }

  const diagnostics = [];
  const defaultBranch = manifest.repository?.defaultBranch;
  if (defaultBranch !== undefined && defaultBranch !== "main") {
    diagnostics.push(
      makeDiagnostic({
        code: "DEFAULT_BRANCH_NOT_MAIN",
        document,
        path: "$.repository.defaultBranch",
        message: "기본 브랜치는 main이어야 합니다.",
      }),
    );
  }

  for (const [key, expected] of Object.entries(canonicalCommandsFromSchema(schema))) {
    const actual = manifest.quality?.commands?.[key];
    if (actual !== undefined && actual !== expected) {
      diagnostics.push(
        makeDiagnostic({
          code: "CANONICAL_COMMAND_MISMATCH",
          document,
          path: appendJsonPath("$.quality.commands", key),
          message: "표준 품질 명령과 일치해야 합니다.",
        }),
      );
    }
  }

  if (Array.isArray(manifest.exceptions)) {
    const exceptionIds = new Set();
    for (const [index, exception] of manifest.exceptions.entries()) {
      if (!isRecord(exception) || typeof exception.id !== "string") {
        continue;
      }
      if (exceptionIds.has(exception.id)) {
        diagnostics.push(
          makeDiagnostic({
            code: "EXCEPTION_ID_DUPLICATE",
            document,
            path: appendJsonPath(
              appendJsonPath("$.exceptions", index),
              "id",
            ),
            message: "예외 ID가 중복되었습니다.",
          }),
        );
      }
      exceptionIds.add(exception.id);
    }
  }

  return diagnostics;
}

function isInsideRepository(repositoryRoot, targetPath) {
  const fromRoot = relative(repositoryRoot, targetPath);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}

async function resolveRepositoryReference({
  repoRoot,
  reference,
  document,
  path,
  expectedType,
  forbidSymlink = false,
}) {
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.includes("\0") ||
    isAbsolute(reference)
  ) {
    return {
      diagnostic: makeDiagnostic({
        code: "FILE_REFERENCE_INVALID",
        document,
        path,
        message: "저장소 내부의 상대 경로만 사용할 수 있습니다.",
      }),
    };
  }

  const absolutePath = resolve(repoRoot, reference);
  if (!isInsideRepository(repoRoot, absolutePath)) {
    return {
      diagnostic: makeDiagnostic({
        code: "FILE_REFERENCE_OUTSIDE_REPOSITORY",
        document,
        path,
        message: "저장소 밖의 경로를 참조할 수 없습니다.",
      }),
    };
  }

  let targetStat;
  try {
    await access(absolutePath, fsConstants.R_OK);
    if (forbidSymlink && await hasSymlinkComponent(repoRoot, absolutePath)) {
      return {
        diagnostic: makeDiagnostic({
          code: "FILE_SYMLINK_FORBIDDEN",
          document,
          path,
          message: "이 경로에는 symlink를 사용할 수 없습니다.",
        }),
      };
    }
    targetStat = await stat(absolutePath);
    const resolvedRealPath = await realpath(absolutePath);
    const repositoryRealPath = await realpath(repoRoot);
    if (!isInsideRepository(repositoryRealPath, resolvedRealPath)) {
      return {
        diagnostic: makeDiagnostic({
          code: "FILE_REFERENCE_OUTSIDE_REPOSITORY",
          document,
          path,
          message: "저장소 밖의 경로를 참조할 수 없습니다.",
        }),
      };
    }
  } catch (error) {
    return {
      diagnostic: makeDiagnostic({
        code: error?.code === "ENOENT" ? "FILE_MISSING" : "FILE_UNREADABLE",
        document,
        path,
        message:
          error?.code === "ENOENT"
            ? "참조한 파일이 없습니다."
            : "참조한 파일을 읽을 수 없습니다.",
      }),
    };
  }

  if (
    (expectedType === "file" && !targetStat.isFile()) ||
    (expectedType === "directory" && !targetStat.isDirectory())
  ) {
    return {
      diagnostic: makeDiagnostic({
        code: "FILE_TYPE_MISMATCH",
        document,
        path,
        message:
          expectedType === "directory"
            ? "참조 경로는 디렉터리여야 합니다."
            : "참조 경로는 파일이어야 합니다.",
      }),
    };
  }

  return { absolutePath, reference };
}

async function hasSymlinkComponent(repoRoot, absolutePath) {
  const referenceParts = relative(repoRoot, absolutePath)
    .split(sep)
    .filter(Boolean);
  let currentPath = resolve(repoRoot);
  for (const part of referenceParts) {
    currentPath = resolve(currentPath, part);
    if ((await lstat(currentPath)).isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

async function loadSchema(schemaPath, document) {
  const result = await readDocument(schemaPath, document);
  if (result.diagnostic) {
    return result;
  }
  if (!isRecord(result.value)) {
    return {
      diagnostic: makeDiagnostic({
        code: "CONTRACT_SCHEMA_INVALID",
        document,
        message: "계약 스키마 자체가 유효하지 않습니다.",
      }),
    };
  }
  return result;
}

async function validateReferencedDocument({
  repoRoot,
  reference,
  referencePath,
  schemaPath,
  schemaDocument,
  referencedDocument,
  expectedAppId,
  diagnostics,
  credentialDocument = false,
  repositoryDirectoryFields = [],
}) {
  const resolved = await resolveRepositoryReference({
    repoRoot,
    reference,
    document: DEFAULT_MANIFEST_PATH,
    path: referencePath,
    expectedType: "file",
  });
  if (resolved.diagnostic) {
    diagnostics.push(resolved.diagnostic);
    return;
  }

  const document = referencedDocument;
  const parsed = await readDocument(resolved.absolutePath, document);
  if (parsed.diagnostic) {
    diagnostics.push(parsed.diagnostic);
    return;
  }

  diagnostics.push(
    ...findCredentialMaterial(parsed.value, {
      document,
      credentialDocument,
    }),
  );
  if (credentialDocument) {
    diagnostics.push(
      ...credentialConsumerSemanticDiagnostics(
        parsed.value,
        document,
        expectedAppId,
      ),
    );
  }
  if (
    typeof expectedAppId === "string" &&
    typeof parsed.value?.appId === "string" &&
    parsed.value.appId !== expectedAppId
  ) {
    diagnostics.push(
      makeDiagnostic({
        code: "REFERENCED_APP_ID_MISMATCH",
        document,
        path: "$.appId",
        message: "참조 문서의 appId가 앱 계약의 app.id와 일치하지 않습니다.",
      }),
    );
  }

  const loadedSchema = await loadSchema(schemaPath, schemaDocument);
  if (loadedSchema.diagnostic) {
    diagnostics.push(loadedSchema.diagnostic);
    return;
  }
  diagnostics.push(
    ...schemaDiagnostics({
      schema: loadedSchema.value,
      value: parsed.value,
      document,
    }),
  );

  for (const field of repositoryDirectoryFields) {
    const directoryReference = parsed.value?.listing?.[field];
    if (typeof directoryReference !== "string") {
      continue;
    }
    const directory = await resolveRepositoryReference({
      repoRoot,
      reference: directoryReference,
      document,
      path: appendJsonPath("$.listing", field),
      expectedType: "directory",
    });
    if (directory.diagnostic) {
      diagnostics.push(directory.diagnostic);
    }
  }
}

async function checkProfileRequiredFiles({
  manifest,
  repoRoot,
  profilesRoot,
  diagnostics,
}) {
  const profileName = manifest?.app?.profile;
  if (typeof profileName !== "string") {
    return;
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(profileName)) {
    diagnostics.push(
      makeDiagnostic({
        code: "PROFILE_NAME_INVALID",
        document: DEFAULT_MANIFEST_PATH,
        path: "$.app.profile",
        message: "프로필 이름 형식이 올바르지 않습니다.",
      }),
    );
    return;
  }

  const profileDocument = `profiles/${profileName}.yaml`;
  const profile = await readDocument(
    resolve(profilesRoot, `${profileName}.yaml`),
    profileDocument,
  );
  if (profile.diagnostic) {
    diagnostics.push(
      makeDiagnostic({
        code: "PROFILE_MISSING",
        document: DEFAULT_MANIFEST_PATH,
        path: "$.app.profile",
        message: "선택한 조직 프로필을 찾거나 읽을 수 없습니다.",
      }),
    );
    return;
  }

  const requiredFiles = profile.value?.requiredFiles;
  if (!Array.isArray(requiredFiles)) {
    diagnostics.push(
      makeDiagnostic({
        code: "PROFILE_INVALID",
        document: profileDocument,
        path: "$.requiredFiles",
        message: "프로필의 필수 파일 목록이 올바르지 않습니다.",
      }),
    );
    return;
  }

  for (const [index, requiredFile] of requiredFiles.entries()) {
    const result = await resolveRepositoryReference({
      repoRoot,
      reference: requiredFile,
      document: profileDocument,
      path: appendJsonPath("$.requiredFiles", index),
      expectedType: "file",
    });
    if (result.diagnostic) {
      diagnostics.push(result.diagnostic);
      diagnostics.push(
        makeDiagnostic({
          code: "PROFILE_REQUIRED_FILE_MISSING",
          document: profileDocument,
          path: appendJsonPath("$.requiredFiles", index),
          message: "선택한 프로필의 필수 파일 계약을 충족하지 않습니다.",
        }),
      );
    }
  }

  const marketRequirements = profile.value?.marketRequirements;
  if (!isRecord(marketRequirements)) {
    return;
  }
  for (const [marketKey, marketRequirement] of Object.entries(marketRequirements)) {
    if (manifest.markets?.[marketKey]?.enabled !== true) {
      continue;
    }
    const marketRequiredFiles = marketRequirement?.requiredFiles;
    if (!Array.isArray(marketRequiredFiles)) {
      continue;
    }
    for (const [index, requiredFile] of marketRequiredFiles.entries()) {
      const result = await resolveRepositoryReference({
        repoRoot,
        reference: requiredFile,
        document: profileDocument,
        path: appendJsonPath(
          appendJsonPath(
            appendJsonPath("$.marketRequirements", marketKey),
            "requiredFiles",
          ),
          index,
        ),
        expectedType: "file",
      });
      if (result.diagnostic) {
        diagnostics.push(result.diagnostic);
        diagnostics.push(
          makeDiagnostic({
            code: "PROFILE_MARKET_REQUIRED_FILE_MISSING",
            document: profileDocument,
            path: appendJsonPath(
              appendJsonPath(
                appendJsonPath("$.marketRequirements", marketKey),
                "requiredFiles",
              ),
              index,
            ),
            message: "활성 마켓의 프로필 필수 파일 계약을 충족하지 않습니다.",
          }),
        );
      }
    }
  }
}

async function readPackageJson(repoRoot, diagnostics) {
  const parsed = await readDocument(resolve(repoRoot, "package.json"), "package.json");
  if (parsed.diagnostic) {
    diagnostics.push(parsed.diagnostic);
    return undefined;
  }
  if (!isRecord(parsed.value)) {
    diagnostics.push(
      makeDiagnostic({
        code: "PACKAGE_JSON_INVALID",
        document: "package.json",
        message: "package.json 최상위 값은 객체여야 합니다.",
      }),
    );
    return undefined;
  }
  return parsed.value;
}

function checkPackageScripts(manifest, packageJson, diagnostics) {
  if (!packageJson || !isRecord(manifest.quality?.commands)) {
    return;
  }
  for (const invocation of Object.values(manifest.quality.commands)) {
    const scriptName = typeof invocation === "string" &&
        invocation.startsWith("pnpm ")
      ? invocation.slice("pnpm ".length)
      : undefined;
    if (!scriptName) {
      continue;
    }
    const script = packageJson.scripts?.[scriptName];
    if (typeof script !== "string" || script.trim().length === 0) {
      diagnostics.push(
        makeDiagnostic({
          code: "CANONICAL_SCRIPT_MISSING",
          document: "package.json",
          path: appendJsonPath("$.scripts", scriptName),
          message: "표준 품질 스크립트가 없습니다.",
        }),
      );
    }
  }
}

function exactPnpmLockResolution(
  lockfile,
  importer,
  packageName,
  expectedVersion,
) {
  const roots = [
    lockfile?.importers?.[importer],
    importer === "." ? lockfile : undefined,
  ].filter(isRecord);
  for (const root of roots) {
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ]) {
      const entry = root[section]?.[packageName];
      if (entry === undefined) {
        continue;
      }
      const specifier = isRecord(entry) ? entry.specifier : undefined;
      const resolvedVersion = isRecord(entry) ? entry.version : entry;
      return (
        (specifier === undefined || specifier === expectedVersion) &&
        typeof resolvedVersion === "string" &&
        (resolvedVersion === expectedVersion ||
          (resolvedVersion.startsWith(`${expectedVersion}(`) &&
            resolvedVersion.endsWith(")")))
      );
    }
  }
  return false;
}

function lockImporterHasPackage(importer, packageName) {
  if (!isRecord(importer)) {
    return false;
  }
  return ["dependencies", "devDependencies", "optionalDependencies"].some(
    (section) => isRecord(importer[section]) &&
      Object.hasOwn(importer[section], packageName),
  );
}

function isSha512Integrity(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) {
    return false;
  }
  const encodedDigest = value.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedDigest)) {
    return false;
  }
  const digest = Buffer.from(encodedDigest, "base64");
  return digest.length === 64 && digest.toString("base64") === encodedDigest;
}

function pnpmPackageProvenance(
  lockfile,
  packageName,
  expectedVersion,
) {
  const packages = isRecord(lockfile?.packages) ? lockfile.packages : {};
  const packageKey = `${packageName}@${expectedVersion}`;
  const entries = Object.entries(packages).filter(([key]) =>
    key === packageKey ||
    (key.startsWith(`${packageKey}(`) && key.endsWith(")"))
  );
  if (entries.length === 0) {
    return { code: "SDK_LOCKFILE_PACKAGE_MISSING" };
  }

  for (const [, entry] of entries) {
    const integrity = entry?.resolution?.integrity;
    if (!isSha512Integrity(integrity)) {
      return { code: "SDK_LOCKFILE_INTEGRITY_INVALID" };
    }
    const tarball = entry?.resolution?.tarball;
    if (typeof tarball !== "string") {
      return { code: "SDK_LOCKFILE_TARBALL_INVALID" };
    }
    try {
      const url = new URL(tarball);
      const expectedPathPrefix =
        `/download/${packageName}/${expectedVersion}/`;
      const packageVersionId = url.pathname.slice(expectedPathPrefix.length);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "npm.pkg.github.com" ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        url.search !== "" ||
        url.hash !== "" ||
        !url.pathname.startsWith(expectedPathPrefix) ||
        !/^[A-Za-z0-9._~-]+$/u.test(packageVersionId)
      ) {
        return { code: "SDK_LOCKFILE_TARBALL_INVALID" };
      }
    } catch {
      return { code: "SDK_LOCKFILE_TARBALL_INVALID" };
    }
  }
  return undefined;
}

const GODOT_PROVENANCE_FILES = new Set(["SOURCE", "VERSION", "CHECKSUM"]);
const GODOT_CHECKSUM_EXCLUDED_FILES = new Set(["CHECKSUM"]);
const VENDORED_TREE_HASH_DOMAIN = Buffer.from(
  "seorilabs-vendored-tree-v1\0",
  "utf8",
);

async function collectVendoredTreeFiles(sdkRoot, currentRoot = sdkRoot) {
  const collected = [];
  const entries = (await readdir(currentRoot, { withFileTypes: true }))
    .toSorted((left, right) => {
      return Buffer.compare(
        Buffer.from(left.name, "utf8"),
        Buffer.from(right.name, "utf8"),
      );
    });
  for (const entry of entries) {
    if (
      currentRoot === sdkRoot &&
      entry.isFile() &&
      GODOT_CHECKSUM_EXCLUDED_FILES.has(entry.name)
    ) {
      continue;
    }
    const absolutePath = resolve(currentRoot, entry.name);
    if (entry.isDirectory()) {
      collected.push(...await collectVendoredTreeFiles(sdkRoot, absolutePath));
      continue;
    }
    if (!entry.isFile()) {
      const error = new Error("vendored SDK에는 일반 파일과 디렉터리만 허용됩니다.");
      error.code = "SDK_TREE_ENTRY_INVALID";
      throw error;
    }
    collected.push({
      absolutePath,
      relativePath: relative(sdkRoot, absolutePath).replaceAll("\\", "/"),
    });
  }
  return collected;
}

function updateHashWithLength(hash, content) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(content.length));
  hash.update(length);
  hash.update(content);
}

export async function computeVendoredTreeChecksum(sdkRoot) {
  const files = (await collectVendoredTreeFiles(sdkRoot)).toSorted(
    (left, right) => {
      return Buffer.compare(
        Buffer.from(left.relativePath, "utf8"),
        Buffer.from(right.relativePath, "utf8"),
      );
    },
  );
  const hash = createHash("sha256");
  hash.update(VENDORED_TREE_HASH_DOMAIN);
  for (const file of files) {
    updateHashWithLength(hash, Buffer.from(file.relativePath, "utf8"));
    updateHashWithLength(hash, await readFile(file.absolutePath));
  }
  const payloadFileCount = files.filter((file) => {
    return !GODOT_PROVENANCE_FILES.has(file.relativePath);
  }).length;
  return { checksum: hash.digest("hex"), fileCount: payloadFileCount };
}

function sdkPackageVersion(packageJson, packageName) {
  return (
    packageJson.dependencies?.[packageName] ??
    packageJson.devDependencies?.[packageName] ??
    packageJson.optionalDependencies?.[packageName]
  );
}

function normalizedImporterForPackage(lockfileReference, packageJsonReference) {
  const lockfileRoot = dirname(lockfileReference);
  const packageRoot = dirname(packageJsonReference);
  const importer = relative(lockfileRoot, packageRoot).replaceAll("\\", "/");
  return importer || ".";
}

async function checkReactNativeSdkConsumers({
  manifest,
  lockfile,
  lockfileReference,
  repoRoot,
  diagnostics,
}) {
  if (!Array.isArray(manifest.sdk.consumers)) {
    return;
  }

  const packageJsonPaths = new Set();
  const importers = new Set();
  for (const [index, consumer] of manifest.sdk.consumers.entries()) {
    if (!isRecord(consumer)) {
      continue;
    }
    const consumerPath = appendJsonPath("$.sdk.consumers", index);
    const packageJsonReference = consumer.packageJson;
    const importer = consumer.lockfileImporter;
    if (
      typeof packageJsonReference !== "string" ||
      typeof importer !== "string"
    ) {
      continue;
    }

    const duplicatePackage = packageJsonPaths.has(packageJsonReference);
    const duplicateImporter = importers.has(importer);
    if (duplicatePackage || duplicateImporter) {
      diagnostics.push(
        makeDiagnostic({
          code: "SDK_CONSUMER_DUPLICATE",
          document: DEFAULT_MANIFEST_PATH,
          path: consumerPath,
          message: "SDK consumer의 package.json 또는 lockfile importer가 중복되었습니다.",
        }),
      );
    }
    packageJsonPaths.add(packageJsonReference);
    importers.add(importer);

    if (
      importer !== normalizedImporterForPackage(
        lockfileReference,
        packageJsonReference,
      )
    ) {
      diagnostics.push(
        makeDiagnostic({
          code: "SDK_CONSUMER_IMPORTER_MISMATCH",
          document: DEFAULT_MANIFEST_PATH,
          path: appendJsonPath(consumerPath, "lockfileImporter"),
          message: "lockfile importer는 consumer package.json 디렉터리와 일치해야 합니다.",
        }),
      );
    }

    const resolvedPackageJson = await resolveRepositoryReference({
      repoRoot,
      reference: packageJsonReference,
      document: DEFAULT_MANIFEST_PATH,
      path: appendJsonPath(consumerPath, "packageJson"),
      expectedType: "file",
    });
    if (resolvedPackageJson.diagnostic) {
      diagnostics.push(resolvedPackageJson.diagnostic);
      continue;
    }
    const packageJson = await readDocument(
      resolvedPackageJson.absolutePath,
      packageJsonReference,
    );
    if (packageJson.diagnostic) {
      diagnostics.push(packageJson.diagnostic);
      continue;
    }
    if (!isRecord(packageJson.value)) {
      diagnostics.push(
        makeDiagnostic({
          code: "PACKAGE_JSON_INVALID",
          document: packageJsonReference,
          message: "SDK consumer package.json 최상위 값은 객체여야 합니다.",
        }),
      );
      continue;
    }

    if (
      sdkPackageVersion(packageJson.value, manifest.sdk.package) !==
      manifest.sdk.version
    ) {
      diagnostics.push(
        makeDiagnostic({
          code: "SDK_PACKAGE_VERSION_MISMATCH",
          document: packageJsonReference,
          path: "$.dependencies",
          message: "SDK consumer가 선언한 정확한 package 버전을 사용하지 않습니다.",
        }),
      );
    }
    if (
      !exactPnpmLockResolution(
        lockfile,
        importer,
        manifest.sdk.package,
        manifest.sdk.version,
      )
    ) {
      diagnostics.push(
        makeDiagnostic({
          code: "SDK_LOCKFILE_RESOLUTION_MISMATCH",
          document: lockfileReference,
          path: appendJsonPath("$.importers", importer),
          message: "SDK consumer의 lockfile resolution이 정확한 버전과 일치하지 않습니다.",
        }),
      );
    }
  }

  const lockfileImporters = isRecord(lockfile?.importers)
    ? lockfile.importers
    : {};
  const actualSdkImporters = new Set(
    Object.entries(lockfileImporters)
      .filter(([, importer]) =>
        lockImporterHasPackage(importer, manifest.sdk.package)
      )
      .map(([importer]) => importer),
  );
  if (lockImporterHasPackage(lockfile, manifest.sdk.package)) {
    actualSdkImporters.add(".");
  }
  for (const importer of actualSdkImporters) {
    if (!importers.has(importer)) {
      diagnostics.push(
        makeDiagnostic({
          code: "SDK_CONSUMER_UNDECLARED_IMPORTER",
          document: lockfileReference,
          path: appendJsonPath("$.importers", importer),
          message: "공통 SDK를 사용하는 lockfile importer가 sdk.consumers에 선언되지 않았습니다.",
        }),
      );
    }
  }

  const provenanceError = pnpmPackageProvenance(
    lockfile,
    manifest.sdk.package,
    manifest.sdk.version,
  );
  if (provenanceError) {
    const messageByCode = {
      SDK_LOCKFILE_PACKAGE_MISSING:
        "공통 SDK의 package resolution이 lockfile에 없습니다.",
      SDK_LOCKFILE_INTEGRITY_INVALID:
        "공통 SDK package resolution에는 SHA-512 integrity가 필요합니다.",
      SDK_LOCKFILE_TARBALL_INVALID:
        "공통 SDK tarball은 Seorilabs GitHub Packages의 고정 버전을 가리켜야 합니다.",
    };
    diagnostics.push(
      makeDiagnostic({
        code: provenanceError.code,
        document: lockfileReference,
        path: appendJsonPath(
          "$.packages",
          `${manifest.sdk.package}@${manifest.sdk.version}`,
        ),
        message: messageByCode[provenanceError.code],
      }),
    );
  }
}

function godotSourceState(source, version) {
  if (typeof source !== "string" || typeof version !== "string") {
    return "invalid";
  }
  const tagMatch = source.match(
    /^https:\/\/github\.com\/seorilabs\/platform\/releases\/tag\/v([^/?#]+)$/u,
  );
  const downloadMatch = source.match(
    /^https:\/\/github\.com\/seorilabs\/platform\/releases\/download\/v([^/?#]+)\/[^/?#]+$/u,
  );
  const sourceVersion = tagMatch?.[1] ?? downloadMatch?.[1];
  if (sourceVersion === undefined) {
    return "invalid";
  }
  return sourceVersion === version ? "valid" : "version-mismatch";
}

async function checkGodotSdkIntegrity({
  resolvedReferences,
  versionPattern,
  diagnostics,
}) {
  const sdkRoot = resolvedReferences.get("$.sdk.root")?.absolutePath;
  const sourcePath = resolvedReferences.get(
    "$.sdk.provenance.source",
  )?.absolutePath;
  const versionPath = resolvedReferences.get(
    "$.sdk.provenance.version",
  )?.absolutePath;
  const checksumPath = resolvedReferences.get(
    "$.sdk.provenance.checksum",
  )?.absolutePath;
  if (!sdkRoot || !sourcePath || !versionPath || !checksumPath) {
    return;
  }

  let source;
  let version;
  let declaredChecksum;
  try {
    [source, version, declaredChecksum] = (
      await Promise.all([
        readFile(sourcePath, "utf8"),
        readFile(versionPath, "utf8"),
        readFile(checksumPath, "utf8"),
      ])
    ).map((value) => value.trim());
  } catch {
    diagnostics.push(
      makeDiagnostic({
        code: "SDK_PROVENANCE_UNREADABLE",
        document: DEFAULT_MANIFEST_PATH,
        path: "$.sdk.provenance",
        message: "SDK 출처 파일을 읽을 수 없습니다.",
      }),
    );
    return;
  }

  const sourceFormatInvalid =
    source.length === 0 ||
    source.length > 512 ||
    /[\r\n]/u.test(source) ||
    SENSITIVE_LITERAL_PATTERNS.some((pattern) => pattern.test(source));
  const sourceState = sourceFormatInvalid
    ? "invalid"
    : godotSourceState(source, version);
  if (sourceState === "invalid") {
    diagnostics.push(
      makeDiagnostic({
        code: "SDK_SOURCE_INVALID",
        document: "SDK SOURCE",
        message: "SOURCE는 Seorilabs platform의 고정된 GitHub release URL이어야 합니다.",
      }),
    );
  } else if (sourceState === "version-mismatch") {
    diagnostics.push(
      makeDiagnostic({
        code: "SDK_SOURCE_VERSION_MISMATCH",
        document: "SDK SOURCE",
        message: "SOURCE release tag와 VERSION이 일치해야 합니다.",
      }),
    );
  }

  let versionMatches = false;
  try {
    versionMatches =
      typeof versionPattern === "string" &&
      new RegExp(versionPattern, "u").test(version);
  } catch {
    versionMatches = false;
  }
  if (!versionMatches) {
    diagnostics.push(
      makeDiagnostic({
        code: "SDK_VERSION_INVALID",
        document: "SDK VERSION",
        message: "VERSION은 조직 계약의 정확한 SemVer여야 합니다.",
      }),
    );
  }

  if (!/^[0-9a-f]{64}$/u.test(declaredChecksum)) {
    diagnostics.push(
      makeDiagnostic({
        code: "SDK_CHECKSUM_INVALID",
        document: "SDK CHECKSUM",
        message: "CHECKSUM은 소문자 SHA-256이어야 합니다.",
      }),
    );
    return;
  }

  try {
    const actual = await computeVendoredTreeChecksum(sdkRoot);
    if (actual.fileCount === 0) {
      diagnostics.push(
        makeDiagnostic({
          code: "SDK_TREE_EMPTY",
          document: DEFAULT_MANIFEST_PATH,
          path: "$.sdk.root",
          message: "vendored SDK에는 provenance 외 파일이 하나 이상 있어야 합니다.",
        }),
      );
    } else if (actual.checksum !== declaredChecksum) {
      diagnostics.push(
        makeDiagnostic({
          code: "SDK_CHECKSUM_MISMATCH",
          document: "SDK CHECKSUM",
          message: "CHECKSUM이 vendored SDK tree의 결정적 해시와 일치하지 않습니다.",
        }),
      );
    }
  } catch (error) {
    const invalidEntry = error?.code === "SDK_TREE_ENTRY_INVALID";
    diagnostics.push(
      makeDiagnostic({
        code: invalidEntry
          ? "SDK_TREE_ENTRY_INVALID"
          : "SDK_TREE_UNREADABLE",
        document: DEFAULT_MANIFEST_PATH,
        path: "$.sdk.root",
        message: invalidEntry
          ? "vendored SDK tree에 symlink 또는 특수 파일을 둘 수 없습니다."
          : "vendored SDK tree를 안전하게 읽을 수 없습니다.",
      }),
    );
  }
}

async function checkSdkReferences(
  manifest,
  schema,
  repoRoot,
  diagnostics,
) {
  if (manifest.sdk?.distribution === "package") {
    const lockfile = await resolveRepositoryReference({
      repoRoot,
      reference: manifest.sdk.lockfile,
      document: DEFAULT_MANIFEST_PATH,
      path: "$.sdk.lockfile",
      expectedType: "file",
    });
    if (lockfile.diagnostic) {
      diagnostics.push(lockfile.diagnostic);
    } else {
      const parsedLockfile = await readDocument(
        lockfile.absolutePath,
        manifest.sdk.lockfile,
      );
      if (parsedLockfile.diagnostic) {
        diagnostics.push(parsedLockfile.diagnostic);
      } else {
        await checkReactNativeSdkConsumers({
          manifest,
          lockfile: parsedLockfile.value,
          lockfileReference: lockfile.reference,
          repoRoot,
          diagnostics,
        });
      }
    }
    return;
  }

  if (manifest.sdk?.distribution !== "vendored") {
    return;
  }
  const sdkRoot = manifest.sdk.root;
  const references = [
    ["$.sdk.root", manifest.sdk.root, "directory"],
    ["$.sdk.provenance.source", manifest.sdk.provenance?.source, "file"],
    ["$.sdk.provenance.version", manifest.sdk.provenance?.version, "file"],
    ["$.sdk.provenance.checksum", manifest.sdk.provenance?.checksum, "file"],
  ];
  const resolvedReferences = new Map();
  for (const [path, reference, expectedType] of references) {
    if (typeof reference !== "string") {
      continue;
    }
    if (
      path.startsWith("$.sdk.provenance.") &&
      typeof sdkRoot === "string" &&
      dirname(resolve(repoRoot, reference)) !== resolve(repoRoot, sdkRoot)
    ) {
      diagnostics.push(
        makeDiagnostic({
          code: "SDK_PROVENANCE_OUTSIDE_ROOT",
          document: DEFAULT_MANIFEST_PATH,
          path,
          message: "SDK 출처 파일은 vendored SDK 루트 바로 아래에 있어야 합니다.",
        }),
      );
    }
    const result = await resolveRepositoryReference({
      repoRoot,
      reference,
      document: DEFAULT_MANIFEST_PATH,
      path,
      expectedType,
      forbidSymlink: true,
    });
    if (result.diagnostic) {
      diagnostics.push(result.diagnostic);
    } else {
      resolvedReferences.set(path, result);
    }
  }
  await checkGodotSdkIntegrity({
    resolvedReferences,
    versionPattern: schema?.$defs?.exactSemver?.pattern,
    diagnostics,
  });
}

async function checkOperationsManifest(manifest, repoRoot, diagnostics) {
  if (typeof manifest.operationsManifest !== "string") {
    return;
  }
  const resolved = await resolveRepositoryReference({
    repoRoot,
    reference: manifest.operationsManifest,
    document: DEFAULT_MANIFEST_PATH,
    path: "$.operationsManifest",
    expectedType: "file",
  });
  if (resolved.diagnostic) {
    diagnostics.push(resolved.diagnostic);
    return;
  }
  const parsed = await readDocument(resolved.absolutePath, "operations manifest");
  if (parsed.diagnostic) {
    diagnostics.push(parsed.diagnostic);
    return;
  }
  diagnostics.push(
    ...findCredentialMaterial(parsed.value, {
      document: "operations manifest",
    }),
  );
}

async function checkReferencedContracts({
  manifest,
  repoRoot,
  contractRoot,
  diagnostics,
}) {
  const consumersManifest = manifest.credentials?.consumersManifest;
  if (typeof consumersManifest === "string") {
    await validateReferencedDocument({
      repoRoot,
      reference: consumersManifest,
      referencePath: "$.credentials.consumersManifest",
      schemaPath: resolve(contractRoot, "credential-consumer.schema.json"),
      schemaDocument: "contracts/credential-consumer.schema.json",
      referencedDocument: "credentials manifest",
      expectedAppId: manifest.app?.id,
      diagnostics,
      credentialDocument: true,
    });
  }

  for (const [marketKey, schemaFile] of Object.entries(MARKET_SCHEMA_BY_KEY)) {
    const marketManifest = manifest.markets?.[marketKey]?.manifest;
    if (typeof marketManifest !== "string") {
      continue;
    }
    await validateReferencedDocument({
      repoRoot,
      reference: marketManifest,
      referencePath: appendJsonPath(`$.markets.${marketKey}`, "manifest"),
      schemaPath: resolve(contractRoot, "markets", schemaFile),
      schemaDocument: `contracts/markets/${schemaFile}`,
      referencedDocument: `${marketKey} manifest`,
      expectedAppId: manifest.app?.id,
      diagnostics,
      repositoryDirectoryFields: ["metadataDirectory", "assetsDirectory"],
    });
  }
}

// Cloud Build 무료 한도(2,500 build-min/월)는 e2-standard-2 기본 풀에만 적용된다.
// E2_HIGHCPU_8 이나 N1_HIGHCPU_32 로 올리면 1분부터 과금되므로 상향을 계약으로 막는다.
// 기본값 변경으로 과금되지 않도록 모든 설정이 E2_STANDARD_2 를 명시해야 한다.
const ALLOWED_CLOUD_BUILD_MACHINE_TYPE = "E2_STANDARD_2";
const CLOUD_BUILD_FILE_PATTERN = /(^|\/)(cloudbuild[^/]*\.ya?ml|[^/]+\.cloudbuild\.ya?ml)$/;
const CLOUD_BUILD_SCAN_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "vendor",
]);

async function collectCloudBuildConfigPaths(repoRoot) {
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (CLOUD_BUILD_SCAN_SKIP_DIRS.has(entry.name)) continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(repoRoot, absolute).split(sep).join("/");
      if (CLOUD_BUILD_FILE_PATTERN.test(relativePath)) {
        found.push(relativePath);
      }
    }
  };
  await walk(repoRoot);
  return found.sort();
}

export async function collectCloudBuildMachineTypeDiagnostics(repoRoot) {
  const normalizedRepoRoot = resolve(repoRoot);
  const diagnostics = [];
  const paths = await collectCloudBuildConfigPaths(normalizedRepoRoot);
  for (const relativePath of paths) {
    const parsed = await readDocument(
      resolve(normalizedRepoRoot, relativePath),
      relativePath,
    );
    if (parsed.diagnostic) {
      diagnostics.push(parsed.diagnostic);
      continue;
    }
    const machineType = isRecord(parsed.value)
      ? isRecord(parsed.value.options)
        ? parsed.value.options.machineType
        : undefined
      : undefined;
    if (machineType === ALLOWED_CLOUD_BUILD_MACHINE_TYPE) continue;
    const actualMachineType =
      machineType === undefined || machineType === null
        ? "생략됨"
        : String(machineType);
    diagnostics.push(
      makeDiagnostic({
        code: "CLOUD_BUILD_MACHINE_TYPE",
        document: relativePath,
        path: "$.options.machineType",
        message:
          `Cloud Build machineType 은 ${ALLOWED_CLOUD_BUILD_MACHINE_TYPE} 을 명시해야 합니다. ` +
          `현재 값 ${actualMachineType} 은 기본값 변경 시 무료 한도(2,500 build-min/월)를 벗어나 과금될 수 있습니다.`,
      }),
    );
  }
  return diagnostics;
}

export async function validateRepository({
  repoRoot = process.cwd(),
  schemaPath = DEFAULT_SCHEMA_PATH,
  profilesRoot = DEFAULT_PROFILES_ROOT,
} = {}) {
  const normalizedRepoRoot = resolve(repoRoot);
  const diagnostics = [];
  const manifestAbsolutePath = resolve(
    normalizedRepoRoot,
    DEFAULT_MANIFEST_PATH,
  );

  const [manifestResult, schemaResult] = await Promise.all([
    readDocument(manifestAbsolutePath, DEFAULT_MANIFEST_PATH),
    loadSchema(schemaPath, "contracts/app.schema.json"),
  ]);
  if (manifestResult.diagnostic) {
    diagnostics.push(manifestResult.diagnostic);
  }
  if (schemaResult.diagnostic) {
    diagnostics.push(schemaResult.diagnostic);
  }
  if (manifestResult.diagnostic || schemaResult.diagnostic) {
    const sorted = sortDiagnostics(diagnostics);
    return { ok: false, diagnostics: sorted };
  }

  const manifest = manifestResult.value;
  diagnostics.push(
    ...schemaDiagnostics({
      schema: schemaResult.value,
      value: manifest,
      document: DEFAULT_MANIFEST_PATH,
    }),
    ...semanticDiagnostics(
      manifest,
      schemaResult.value,
      DEFAULT_MANIFEST_PATH,
    ),
    ...findCredentialMaterial(manifest, {
      document: DEFAULT_MANIFEST_PATH,
    }),
  );

  if (isRecord(manifest)) {
    await checkProfileRequiredFiles({
      manifest,
      repoRoot: normalizedRepoRoot,
      profilesRoot,
      diagnostics,
    });

    const packageJson = await readPackageJson(normalizedRepoRoot, diagnostics);
    checkPackageScripts(manifest, packageJson, diagnostics);
    await checkSdkReferences(
      manifest,
      schemaResult.value,
      normalizedRepoRoot,
      diagnostics,
    );
    await checkOperationsManifest(manifest, normalizedRepoRoot, diagnostics);
    await checkReferencedContracts({
      manifest,
      repoRoot: normalizedRepoRoot,
      contractRoot: dirname(schemaPath),
      diagnostics,
    });
  }

  diagnostics.push(
    ...(await collectCloudBuildMachineTypeDiagnostics(normalizedRepoRoot)),
  );

  const sorted = sortDiagnostics(diagnostics);
  return { ok: sorted.length === 0, diagnostics: sorted };
}
