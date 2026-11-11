import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../../", import.meta.url));
for (const mode of ["success", "transfer-failure", "deploy-failure"])
  await test(`guarded MongoDB cutover: ${mode}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "tripling-cutover-"));
    try {
      await mkdir(join(dir, "bin"));
      await mkdir(join(dir, "scripts"));
      await cp(
        join(root, "scripts/cutover-mongodb-aws.sh"),
        join(dir, "scripts/cutover-mongodb-aws.sh"),
      );
      await writeFile(
        join(dir, "bin", "git"),
        '#!/usr/bin/env bash\nif [[ "$1" == rev-parse ]]; then printf "%040d" 1; fi\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(dir, "bin", "docker"),
        "#!/usr/bin/env bash\nexit 0\n",
        { mode: 0o755 },
      );
      await writeFile(
        join(dir, "bin", "node"),
        '#!/usr/bin/env bash\necho smoke >> "$CUTOVER_DIR/calls"\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(dir, "scripts", "preflight-mongodb-aws.sh"),
        '#!/usr/bin/env bash\necho preflight >> "$CUTOVER_DIR/calls"\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(dir, "scripts", "deploy-aws.sh"),
        '#!/usr/bin/env bash\necho deploy >> "$CUTOVER_DIR/calls"\nif [[ "$CUTOVER_MODE" == deploy-failure ]]; then exit 1; fi\ntouch "$CUTOVER_DIR/deployed"\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(dir, "bin", "aws"),
        `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path'),a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],op=a.slice(0,2).join(' '),dir=process.env.CUTOVER_DIR,mode=process.env.CUTOVER_MODE;
const out=v=>process.stdout.write(typeof v==='string'?v:JSON.stringify(v));fs.appendFileSync(p.join(dir,'calls'),a.join(' ')+'\\n');
if(op==='sts get-caller-identity')out('669991883783');
else if(op==='cloudformation describe-stacks'){
 if(get('--stack-name')==='tripling-foundation')out('669991883783.dkr.ecr.ap-southeast-2.amazonaws.com/tripling');
 else {const worker=get('--stack-name')==='tripling-mongodb-preflight',values=worker?{TaskDefinitionArn:'worker-definition',LogGroupName:'worker-logs'}:{ClusterArn:'cluster-arn',ServiceArn:'service-arn',ClusterName:'cluster-name',ServiceName:'service-name',WebsiteUrl:'https://tripling.example'};out({Stacks:[{Parameters:[{ParameterKey:'FoundationStack',ParameterValue:'tripling-foundation'}],Outputs:Object.entries(values).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]});}
}else if(op==='ecs describe-services')out(a.includes('--query')?(fs.existsSync(p.join(dir,'deployed'))?'new-task':'old-task'):{services:[{desiredCount:1,runningCount:1,pendingCount:0,taskDefinition:'old-task',networkConfiguration:{awsvpcConfiguration:{assignPublicIp:'DISABLED',subnets:['private'],securityGroups:['existing']}}}]});
else if(op==='application-autoscaling describe-scalable-targets')out({ScalableTargets:[{MinCapacity:1,MaxCapacity:3,SuspendedState:{DynamicScalingInSuspended:false,DynamicScalingOutSuspended:false,ScheduledScalingSuspended:false}}]});
else if(op==='cloudformation list-stack-resources')out({StackResourceSummaries:[{LogicalResourceId:'HttpsListener',PhysicalResourceId:'https-listener'}]});
else if(op==='elbv2 describe-listeners')out({Listeners:[{DefaultActions:[{Type:'forward',TargetGroupArn:'target'}]}]});
else if(op==='elbv2 describe-rules')out({Rules:[{IsDefault:true}]});
else if(op==='elbv2 create-rule')out({Rules:[{RuleArn:get('--priority')==='1'?'health-rule':'maintenance-rule'}]});
else if(op==='ecr describe-images')out({imageDetails:[{}]});
else if(op==='ecs run-task'){const v=JSON.parse(fs.readFileSync(get('--overrides').slice(7),'utf8')).containerOverrides[0].command[0];fs.writeFileSync(p.join(dir,'worker-mode'),v);out({failures:[],tasks:[{taskArn:'arn:aws:ecs:ap-southeast-2:669991883783:task/cluster/worker'}]});}
else if(op==='ecs describe-tasks')out({tasks:[{stopCode:'EssentialContainerExited',containers:[{name:'tripling',exitCode:mode==='transfer-failure'?1:0}]}]});
else if(op==='ecs describe-task-definition')out({taskDefinition:{containerDefinitions:[{name:'tripling',environment:[{name:'APP_VERSION',value:'1'.padStart(40,'0')},{name:'MONGODB_SECRET_ARN',value:process.env.TRIPLING_MONGODB_SECRET_ARN},{name:'MONGODB_DATABASE',value:'tripling'}]}]}});
else if(['ecs wait','ecs update-service','ecs stop-task','application-autoscaling register-scalable-target','elbv2 delete-rule','logs get-log-events'].includes(op))out({});
else {console.error('Unexpected operation '+op);process.exit(1);}
`,
        { mode: 0o755 },
      );
      const r = spawnSync("bash", ["scripts/cutover-mongodb-aws.sh"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20000,
        env: {
          ...process.env,
          PATH: join(dir, "bin") + ":" + process.env.PATH,
          CUTOVER_DIR: dir,
          CUTOVER_MODE: mode,
          TRIPLING_DEPLOY_APPROVED: "yes",
          TRIPLING_MONGODB_CUTOVER_APPROVED: "yes",
          TRIPLING_DOWNTIME_APPROVED: "yes",
          TRIPLING_CERTIFICATE_ARN: "existing-cert",
          TRIPLING_MONGODB_SECRET_ARN:
            "arn:aws:secretsmanager:ap-southeast-2:669991883783:secret:mongo-test",
        },
      });
      assert.equal(r.status, mode === "success" ? 0 : 1, r.stderr);
      const calls = await readFile(join(dir, "calls"), "utf8"),
        state = JSON.parse(
          await readFile(join(dir, "work/mongodb-cutover/state.json"), "utf8"),
        );
      assert(!calls.includes("cloudformation delete-stack"));
      assert(!calls.includes("rds delete"));
      assert(!calls.includes("elbv2 modify-listener"));
      if (mode === "success") {
        assert.equal(state.phase, "complete");
        assert.match(r.stdout, /MONGODB_CUTOVER_COMPLETE/);
        assert(
          calls.indexOf("preflight") < calls.indexOf("ecs update-service"),
        );
        assert(
          calls.lastIndexOf("elbv2 delete-rule --rule-arn maintenance-rule") >
            calls.indexOf("deploy"),
        );
        assert(
          calls.includes(
            "ecs describe-task-definition --task-definition new-task",
          ),
        );
      }
      if (mode === "transfer-failure") {
        assert.equal(state.phase, "source_restored");
        assert(!calls.includes("\ndeploy\n"));
        assert(calls.includes("elbv2 delete-rule --rule-arn maintenance-rule"));
      }
      if (mode === "deploy-failure") {
        assert.equal(state.phase, "deploying");
        assert(
          !calls.includes("elbv2 delete-rule --rule-arn maintenance-rule"),
        );
        assert.match(r.stderr, /rollback was NOT attempted/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
