import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);

test("재사용 workflow가 참조하는 secret을 명시적으로 선언한다", async () => {
  const workflowNames = (await readdir(workflowDirectory)).filter((name) =>
    name.endsWith(".yml"),
  );

  for (const workflowName of workflowNames) {
    const source = await readFile(new URL(workflowName, workflowDirectory), "utf8");
    const workflow = parse(source);
    const workflowCall = workflow?.on?.workflow_call;
    if (!workflowCall) {
      continue;
    }

    assert.doesNotMatch(
      source,
      /\bsecrets:\s*inherit\b/,
      `${workflowName}: secrets: inherit는 허용하지 않는다`,
    );

    const declared = new Set(Object.keys(workflowCall.secrets ?? {}));
    const referenced = new Set(
      [...source.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)\b/g)].map(
        (match) => match[1],
      ),
    );
    const missing = [...referenced].filter((name) => !declared.has(name)).sort();

    assert.deepEqual(
      missing,
      [],
      `${workflowName}: on.workflow_call.secrets에 선언되지 않은 secret 참조`,
    );
  }
});
