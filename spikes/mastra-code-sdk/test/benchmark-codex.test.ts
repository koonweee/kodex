import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexBenchmarkRuntime } from '../src/benchmark-codex.js';

test('Codex benchmark counts cumulative usage differences and handles completion before start acknowledgment', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kodex-bench-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'fake-codex.mjs');
  await writeFile(binary, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
let calls=0;
const write=x=>process.stdout.write(JSON.stringify(x)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const x=JSON.parse(line),p=x.params;
 if(x.id===undefined)return;
 const reply=result=>write({id:x.id,result});
 if(x.method==='account/read')return reply({account:{type:'chatgpt'}});
 if(x.method==='thread/start')return reply({model:p.model,thread:{id:'test-thread'}});
 if(x.method==='turn/start'){
  calls++;const turnId='turn-'+calls,base={threadId:p.threadId,turnId};
  write({method:'thread/tokenUsage/updated',params:{...base,tokenUsage:{total:{inputTokens:calls*100,outputTokens:calls*10,cachedInputTokens:calls*40,reasoningOutputTokens:calls*2}}}});
  write({method:'item/started',params:{...base,item:{id:'tool',type:'commandExecution'}}});
  write({method:'item/agentMessage/delta',params:{...base,itemId:'answer-'+calls,delta:'ANSWER'}});
  write({method:'item/completed',params:{...base,item:{id:'answer-'+calls,type:'agentMessage',text:'ANSWER'}}});
  write({method:'turn/completed',params:{threadId:p.threadId,turn:{id:turnId,status:'completed',error:null}}});
  return reply({turn:{id:turnId}});
 }
 reply({});
});
`, { mode: 0o700 });
  const runtime = await createCodexBenchmarkRuntime({ binary, home: root, projectPaths: [root], runtimeRoot: join(root, 'runtime'), model: 'test-model', effort: 'low', chatsPerProject: 1, prompts: ['first', 'second'], activeChats: 1 });
  try {
    const { turns } = await runtime.run();
    assert.equal(turns.length, 2);
    for (const row of turns) {
      assert.equal(row.inputTokens, 100);
      assert.equal(row.outputTokens, 10);
      assert.equal(row.cachedInputTokens, 40);
      assert.equal(row.reasoningTokens, 2);
      assert.equal(row.completed, true);
      assert.equal(row.errors, false);
      assert.equal(row.answer, 'ANSWER');
      assert.equal(row.toolCalls, 1);
      assert.ok(row.firstTextMs !== null && row.firstTextMs >= 0 && row.firstTextMs <= row.totalMs);
    }
  } finally { await runtime.dispose(); }
});
