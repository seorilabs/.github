import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {parseAabRuntimeSettings} from '../scripts/release/tag-version-authority.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/betta-first-aab-manifest.json',import.meta.url))),bytes=Buffer.from(fixture.rawBase64,'base64');
test('actual Godot AAB launcher alias inherits portrait from its target activity',()=>{
 assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.manifestSha256);
 assert.deepEqual(parseAabRuntimeSettings(bytes),{minSdk:26,targetSdk:36,launchOrientation:'portrait'});
});
test('a launcher alias cannot resolve to an absent target',()=>{
 const changed=Buffer.from(bytes),target=Buffer.from('com.godot.game.GodotApp'),missing=Buffer.from('com.godot.game.MissingX');
 assert.equal(target.length,missing.length);
 const position=changed.indexOf(target,changed.indexOf(Buffer.from('targetActivity')));assert.ok(position>0);missing.copy(changed,position);
 assert.throws(()=>parseAabRuntimeSettings(changed),/AAB_ALIAS_TARGET_REQUIRED/u);
});
