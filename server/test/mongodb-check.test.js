import test from "node:test";
import assert from "node:assert/strict";
import { checkMongoConnection } from "../check-mongodb.js";
import { mkdtemp, writeFile, mkdir, cp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
await test("MongoDB probe calls only ping and a projected read", async () => {
  const calls = [];
  await checkMongoConnection({
    ping: async () => calls.push("ping"),
    one: async (name, query, options) => {
      calls.push("read");
      assert.equal(name, "trips");
      assert.deepEqual(query, {});
      assert.deepEqual(options, { projection: { _id: 1 }, maxTimeMS: 10000 });
    },
  });
  assert.deepEqual(calls, ["ping", "read"]);
});
for (const mode of ["success", "failure", "wrong-account"])
  await test(`AWS MongoDB probe control: ${mode}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "tripling-mongo-check-"));
    try {
      await mkdir(join(dir, "bin"));
      await mkdir(join(dir, "scripts"));
      await cp(
        join(root, "scripts/check-mongodb-aws.sh"),
        join(dir, "scripts/check-mongodb-aws.sh"),
      );
      await writeFile(
        join(dir, "bin", "git"),
        '#!/usr/bin/env bash\nif [[ "$1" == rev-parse ]]; then printf "%040d" 1; fi\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(dir, "bin", "docker"),
        "#!/usr/bin/env bash\ncat >/dev/null\n",
        { mode: 0o755 },
      );
      await writeFile(
        join(dir, "bin", "aws"),
        `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],op=a.slice(0,2).join(' '),mode=process.env.PROBE_MODE;
fs.appendFileSync(path.join(process.env.PROBE_DIR,'calls'),op+'\\n');
const out=x=>process.stdout.write(typeof x==='string'?x:JSON.stringify(x));
if(op==='sts get-caller-identity')out(mode==='wrong-account'?'999999999999':'669991883783');
else if(op==='cloudformation describe-stacks'){
 const name=get('--stack-name');if(name==='tripling-foundation')out('669991883783.dkr.ecr.ap-southeast-2.amazonaws.com/tripling');else{const values=name==='tripling-mongodb-check'?{TaskDefinitionArn:'probe-task',LogGroupName:'probe-logs'}:{ClusterArn:'existing-cluster',ServiceArn:'existing-service'};out({Stacks:[{Parameters:[{ParameterKey:'FoundationStack',ParameterValue:'tripling-foundation'}],Outputs:Object.entries(values).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}]});}
}else if(op==='ecs describe-services')out({services:[{networkConfiguration:{awsvpcConfiguration:{subnets:['private-subnet'],securityGroups:['existing-group'],assignPublicIp:'DISABLED'}}}]});
else if(op==='ecr get-login-password')out('mock-token');
else if(op==='ecr describe-images')out(get('--query')==='imageDetails[0].imageDigest'?'sha256:'+'a'.repeat(64):{imageDetails:[{}]});
else if(op==='ecs run-task') {fs.copyFileSync(get('--network-configuration').slice(7),path.join(process.env.PROBE_DIR,'network.json'));out({tasks:[{taskArn:'arn:aws:ecs:ap-southeast-2:669991883783:task/cluster/probe'}],failures:[]});}
else if(op==='ecs describe-tasks')out({tasks:[{stopCode:'EssentialContainerExited',containers:[{name:'tripling',exitCode:mode==='failure'?1:0}]}]});
else if(op==='logs get-log-events')out(mode==='failure'?'MONGODB_CONNECTION_FAILED: 18':'MONGODB_CONNECTION_OK');
else if(['cloudformation deploy','ecs wait','ecs stop-task'].includes(op))out({});
else {console.error('Unexpected AWS operation '+op);process.exit(1);}
`,
        { mode: 0o755 },
      );
      const r = spawnSync("bash", ["scripts/check-mongodb-aws.sh"], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: join(dir, "bin") + ":" + process.env.PATH,
          PROBE_DIR: dir,
          PROBE_MODE: mode,
          TRIPLING_DEPLOY_APPROVED: "yes",
          TRIPLING_MONGODB_SECRET_ARN:
            "arn:aws:secretsmanager:ap-southeast-2:669991883783:secret:tripling/mongodb-test",
        },
        timeout: 10000,
      });
      assert.equal(r.status, mode === "success" ? 0 : 1, r.stderr);
      const calls = await readFile(join(dir, "calls"), "utf8");
      assert(!calls.includes("ecs update-service"));
      assert(!calls.includes("get-secret-value"));
      assert(!calls.includes("cloudformation delete-stack"));
      if (mode === "success") {
        assert.match(r.stdout, /MongoDB connectivity verified/);
        const network = JSON.parse(
          await readFile(join(dir, "network.json"), "utf8"),
        );
        assert.deepEqual(network.awsvpcConfiguration, {
          subnets: ["private-subnet"],
          securityGroups: ["existing-group"],
          assignPublicIp: "DISABLED",
        });
      }
      if (mode === "failure") assert(calls.includes("ecs stop-task"));
      if (mode === "wrong-account")
        assert.equal(calls.trim(), "sts get-caller-identity");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
