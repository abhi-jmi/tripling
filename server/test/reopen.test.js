import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,cp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
for (const mode of ['success','unhealthy','unrelated-rule','smoke-failure']) test(`verified cutover reopen: ${mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tripling-reopen-'));
 try {
  for(const path of ['scripts','bin','work/mongodb-cutover'])await mkdir(join(dir,path),{recursive:true});
  await cp(new URL('../../scripts/reopen-mongodb-aws.sh',import.meta.url),join(dir,'scripts/reopen-mongodb-aws.sh'));
  const state=join(dir,'work/mongodb-cutover');
  const save=(name,value)=>writeFile(join(state,name),JSON.stringify(value));
  const task={taskDefinition:{containerDefinitions:[{name:'tripling',environment:[{name:'APP_VERSION',value:'a'.repeat(40)},{name:'MONGODB_SECRET_ARN',value:'secret'}]}]}};
  await save('state.json',{phase:'opening',cluster:'cluster',service:'service',listener:'listener',scalingId:'scaling'});
  await save('worker-result.json',{tasks:[{stopCode:'EssentialContainerExited',containers:[{name:'tripling',exitCode:0}]}]});
  await save('new-task.json',task);await save('scaling.json',{ScalableTargets:[{MinCapacity:1,MaxCapacity:2}]});
  await save('scaling-state.json',{});await save('maintenance-actions.json',[]);
  const mock=`#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2),op=a.slice(0,2).join(' ');fs.appendFileSync('calls',op+'\\n');const mode=${JSON.stringify(mode)};let v={};
if(op==='sts get-caller-identity')v='669991883783';
else if(op==='cloudformation describe-stacks')v={Stacks:[{Parameters:[{ParameterKey:'MongoDBSecretArn',ParameterValue:'secret'}],Outputs:Object.entries({ClusterArn:'cluster',ServiceArn:'service',WebsiteUrl:'https://tripling.in'}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]};
else if(op==='ecs describe-services')v={services:[{desiredCount:1,runningCount:1,taskDefinition:'task',deployments:[{status:'PRIMARY',rolloutState:'COMPLETED'}]}]};
else if(op==='ecs describe-task-definition')v=${JSON.stringify(task)};
else if(op==='cloudformation list-stack-resources')v={StackResourceSummaries:[{LogicalResourceId:'HttpsListener',PhysicalResourceId:'listener'},{LogicalResourceId:'TargetGroup',PhysicalResourceId:'target'}]};
else if(op==='elbv2 describe-target-health')v={TargetHealthDescriptions:[{TargetHealth:{State:mode==='unhealthy'?'unhealthy':'healthy'}}]};
else if(op==='elbv2 describe-rules')v={Rules:[{Priority:'2',RuleArn:'maintenance',Conditions:[{Field:'path-pattern',Values:['/*']}],Actions:[{Type:'fixed-response',FixedResponseConfig:{StatusCode:'503',MessageBody:mode==='unrelated-rule'?'other':'Tripling is temporarily unavailable for maintenance. Please try again shortly.'}}]}]};
process.stdout.write(typeof v==='string'?v:JSON.stringify(v));`;
  await writeFile(join(dir,'bin/aws'),mock,{mode:0o755});
  await writeFile(join(dir,'bin/node'),`#!/bin/sh\nexit ${mode==='smoke-failure'?1:0}\n`,{mode:0o755});
  const result=spawnSync('bash',['scripts/reopen-mongodb-aws.sh'],{cwd:dir,encoding:'utf8',env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,TRIPLING_DEPLOY_APPROVED:'yes',TRIPLING_MONGODB_SECRET_ARN:'secret'}});
  const calls=await readFile(join(dir,'calls'),'utf8');
  assert.equal(result.status,mode==='success'?0:1,result.stderr);
  assert(!calls.includes('ecs update-service'));assert(!calls.includes('cloudformation deploy'));
  if(mode==='success'){assert(calls.includes('elbv2 delete-rule'));assert.equal(JSON.parse(await readFile(join(state,'state.json'))).phase,'complete');}
  if(['unhealthy','unrelated-rule'].includes(mode))assert(!calls.includes('elbv2 delete-rule'));
  if(mode==='smoke-failure')assert(calls.includes('elbv2 create-rule'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
