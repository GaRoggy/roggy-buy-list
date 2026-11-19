import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {recordCompletedJob} from '../completion-history.mjs';
test('completed monitor jobs hand off one atomic, correctly labelled result without provider secrets',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'layne-completion-test-'));
 try{
  assert.equal(await recordCompletedJob({id:'fixture:job',attempts:1},{kind:'calendar',secret:'private'},4,120,{directory:folder}),true);
  const files=await readdir(folder);assert.equal(files.length,1);assert.match(files[0],/^completion-.*\.json$/);
  const value=JSON.parse(await readFile(join(folder,files[0]),'utf8'));assert.equal(value.reason,'automated');assert.equal(value.details.records_processed,4);assert.ok(!JSON.stringify(value).includes('private'));
 }finally{assert.ok(resolve(folder).startsWith(resolve(join(tmpdir(),'layne-completion-test-'))));await rm(folder,{recursive:true,force:true});}
});
