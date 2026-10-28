import test from 'node:test';import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join } from 'node:path';
import { ControlJournal } from './journal.js';import { watchdogDecision } from './watchdog.js';
test('restart persists uncertain actions and interrupted tasks; maintenance needs explicit review',t=>{
 const dir=mkdtempSync(join(tmpdir(),'woc-journal-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'journal.json');
 let j=new ControlJournal(file);const task=j.start('a','task','Task',{epoch:'epoch'}), action=j.start('a','action','Keyboard',{parent:task});
 j.start('a','maintenance','upgrade');j=new ControlJournal(file);
 assert.equal(j.get(task)?.state,'interrupted');assert.equal(j.get(action)?.state,'uncertain');assert.ok(j.unresolved('a'));
 j.resolve('a');assert.equal(j.unresolved('a'),undefined);assert.equal(new ControlJournal(file).get(action)?.state,'uncertain');
 assert.equal(readFileSync(file,'utf8').includes('token'),false);
});
test('soft watchdog defers to an active Agent without viewers; hard still fences',()=>{
 assert.equal(watchdogDecision(1600,1500,2500,true),'skip');assert.equal(watchdogDecision(1600,1500,2500,false),'soft');
 assert.equal(watchdogDecision(2600,1500,2500,true),'hard');assert.equal(watchdogDecision(1600,0,0,false),'skip');
});
