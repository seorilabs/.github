import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'yaml';

test('opt-in rendering validates X11 before the long caller checks',()=>{
  const w=parse(readFileSync(new URL('../.github/workflows/godot-checks.yml',import.meta.url),'utf8'));
  assert.equal(w.on.workflow_call.inputs.with_rendering.default,false);
  const steps=w.jobs.compile.steps;
  const setup=steps.find(s=>s.name==='Prepare actual rendering runtime');
  assert.ok(setup);
  for(const dependency of ['libxcursor1','libxrandr2','libxi6','libxinerama1','libglx-mesa0']) assert.ok(setup.run.includes(dependency));
  const index=steps.findIndex(s=>s.name==='Verify rendering runtime before long checks');
  assert.ok(index>steps.findIndex(s=>s.name==='Import project'));
  assert.ok(index<steps.findIndex(s=>s.name==='Run checks (custom)'));
  const smoke=steps[index];assert.equal(smoke.if,'inputs.with_rendering');
  assert.match(smoke.run,/xvfb-run -a godot --display-driver x11/u);
  assert.match(smoke.run,/SCRIPT ERROR\|ERROR:/u);
});
