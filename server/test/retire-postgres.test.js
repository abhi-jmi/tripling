import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,cp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
for(const mode of ['read-only','success','postgres-service','unrelated-change','imported-host','smoke-failure'])test(`PostgreSQL retirement: ${mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tripling-retire-'));
 try{
  for(const p of ['scripts','infra','bin'])await mkdir(join(dir,p));
  await cp(new URL('../../scripts/retire-postgres-aws.sh',import.meta.url),join(dir,'scripts/retire-postgres-aws.sh'));
  await cp(new URL('../../infra/foundation.yaml',import.meta.url),join(dir,'infra/foundation.yaml'));
  const mock=`#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2),op=a.slice(0,2).join(' '),get=k=>a[a.indexOf(k)+1],mode=${JSON.stringify(mode)};fs.appendFileSync('calls',op+'\\n');let v={};
if(op==='sts get-caller-identity')v='669991883783';
else if(op==='cloudformation describe-stacks')v={Stacks:[get('--stack-name')==='tripling-service'?{Parameters:mode==='postgres-service'?[]:[{ParameterKey:'MongoDBSecretArn',ParameterValue:'arn:secret'}],Outputs:Object.entries({ClusterArn:'cluster',ServiceArn:'service',WebsiteUrl:'https://tripling.in'}).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}:{StackStatus:'UPDATE_COMPLETE',Parameters:[{ParameterKey:'InternetEgress',ParameterValue:'true'}]}]};
else if(op==='ecs describe-services')v={services:[{desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:'task',deployments:[{status:'PRIMARY',rolloutState:'COMPLETED'}]}]};
else if(op==='ecs describe-task-definition')v={taskDefinition:{containerDefinitions:[{name:'tripling',environment:[{name:'MONGODB_SECRET_ARN',value:'arn:secret'},{name:'APP_VERSION',value:'a'.repeat(40)}]}]}};
else if(op==='cloudformation list-stack-resources')v={StackResourceSummaries:[{LogicalResourceId:'Database',ResourceType:'AWS::RDS::DBInstance',ResourceStatus:'CREATE_COMPLETE',PhysicalResourceId:'tripling-db'}]};
else if(op==='rds describe-db-instances')v={DBInstances:[{Engine:'postgres',DBInstanceStatus:'available',DBName:'tripling',ReadReplicaDBInstanceIdentifiers:[]}]};
else if(op==='cloudformation list-imports')v={Imports:mode==='imported-host'?['other-stack']:[]};
else if(op==='cloudformation describe-change-set')v={Changes:get('--change-set-name').includes('unprotect')?[{Type:'Resource',ResourceChange:{LogicalResourceId:mode==='unrelated-change'?'VPC':'Database',Action:'Modify',Replacement:'False',Details:[{Target:{Attribute:'Properties',Name:'DeletionProtection'}}]}}]:['Database','DatabaseSubnets','DatabaseSecurityGroup'].map(LogicalResourceId=>({Type:'Resource',ResourceChange:{LogicalResourceId,Action:'Remove'}}))};
process.stdout.write(typeof v==='string'?v:JSON.stringify(v));`;
  await writeFile(join(dir,'bin/aws'),mock,{mode:0o755});
  await writeFile(join(dir,'bin/node'),`#!/bin/sh\nexit ${mode==='smoke-failure'?1:0}\n`,{mode:0o755});
  const result=spawnSync('bash',['scripts/retire-postgres-aws.sh'],{cwd:dir,encoding:'utf8',env:{...process.env,PATH:join(dir,'bin')+':'+process.env.PATH,TRIPLING_RETIRE_POSTGRES_APPROVED:mode==='read-only'?'':'yes'}});
  const calls=await readFile(join(dir,'calls'),'utf8');
  assert.equal(result.status,['read-only','success'].includes(mode)?0:1,result.stderr);
  assert(!calls.includes('rds delete-db-instance'));assert(!calls.includes('ecs update-service'));
  assert.equal(calls.includes('cloudformation execute-change-set'),mode==='success');
  if(mode==='success'){
   assert.equal(calls.split('cloudformation execute-change-set').length-1,2);
   const params=JSON.parse(await readFile(join(dir,'work/postgres-retirement/parameters.json')));
   assert(params.some(p=>p.ParameterKey==='InternetEgress'&&p.UsePreviousValue===true));
   assert(params.some(p=>p.ParameterKey==='LegacyPostgresEnabled'&&p.ParameterValue==='false'));
   assert.match(result.stdout,/POSTGRES_RETIRED/);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('legacy RDS snapshot policy survives conditional retirement',async()=>{
 const template=await readFile(new URL('../../infra/foundation.yaml',import.meta.url),'utf8');
 assert.match(template,/Database:\n    Type: AWS::RDS::DBInstance\n    Condition: EnableLegacyPostgres\n    DeletionPolicy: Snapshot/);
 assert.match(template,/DeletionProtection: !If \[ProtectLegacyPostgres, true, false\]/);
 const select=await readFile(new URL('../../scripts/foundation-template.sh',import.meta.url),'utf8');
 assert.match(select,/OutputKey=='DatabaseSecretArn'/);
});
