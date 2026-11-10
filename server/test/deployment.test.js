import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("../../", import.meta.url));
const oldTask =
  "arn:aws:ecs:ap-south-1:123456789012:task-definition/tripling-service-app:1";
const newTask =
  "arn:aws:ecs:ap-south-1:123456789012:task-definition/tripling-service-app:2";
async function releaseFixture(mode) {
  const directory = await mkdtemp(join(tmpdir(), "tripling-release-test-"));
  const bin = join(directory, "bin");
  await mkdir(bin);
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "log"));
  await cp(
    join(source, "scripts/deploy-release.sh"),
    join(directory, "scripts/deploy-release.sh"),
  );
  await cp(
    join(source, "scripts/smoke-deployment.mjs"),
    join(directory, "scripts/smoke-deployment.mjs"),
  );
  const aws = `#!${process.execPath}
const fs=require('node:fs'),p=require('node:path');const args=process.argv.slice(2),dir=process.env.MOCK_LOG_DIR;const get=k=>args[args.indexOf(k)+1];const operation=args.slice(0,2).join(' ');fs.appendFileSync(p.join(dir,'calls'),operation+'\\n');const old=${JSON.stringify(oldTask)},next=${JSON.stringify(newTask)},mode=process.env.MOCK_MODE;
const output=v=>process.stdout.write(typeof v==='string'?v:JSON.stringify(v));
if(operation==='sts get-caller-identity')output(mode==='wrong-account'?'999999999999':'123456789012');
else if(operation==='cloudformation describe-stacks'){
 const foundation=get('--stack-name')==='tripling-foundation';
 output({Stacks:[{Parameters:[{ParameterKey:'FoundationStack',ParameterValue:'tripling-foundation'}],Outputs:(foundation?{RepositoryUri:'123456789012.dkr.ecr.ap-south-1.amazonaws.com/tripling'}:{ClusterArn:'arn:aws:ecs:ap-south-1:123456789012:cluster/tripling',ServiceArn:'arn:aws:ecs:ap-south-1:123456789012:service/tripling/app',WebsiteUrl:'https://tripling.in'}),}].map(stack=>({...stack,Outputs:Object.entries(stack.Outputs).map(([OutputKey,OutputValue])=>({OutputKey,OutputValue}))}))});
}else if(operation==='ecr get-login-password')output('mock-password');
else if(operation==='ecr describe-images'){
 if(mode==='denied'){console.error('AccessDeniedException');process.exit(254);}
 if(!args.includes('--query')&&!fs.existsSync(p.join(dir,'checked-image'))){fs.writeFileSync(p.join(dir,'checked-image'),'yes');console.error('ImageNotFoundException');process.exit(254);}
 output(args.includes('--query')?'sha256:'+'a'.repeat(64):{imageDetails:[{imageDigest:'sha256:'+'a'.repeat(64)}]});
}else if(operation==='ecs describe-services'){
 const current=fs.existsSync(p.join(dir,'current'))?fs.readFileSync(p.join(dir,'current'),'utf8'):old;
 output({services:[{taskDefinition:current,runningCount:1,desiredCount:1,deployments:[{status:'PRIMARY',taskDefinition:current,rolloutState:'COMPLETED'}]}]});
}else if(operation==='ecs describe-task-definition')output({taskDefinition:{taskDefinitionArn:old,revision:1,status:'ACTIVE',family:'tripling-service-app',executionRoleArn:'execution',taskRoleArn:'runtime',networkMode:'awsvpc',cpu:'512',memory:'1024',requiresCompatibilities:['FARGATE'],containerDefinitions:[{name:'tripling',image:'old-image',environment:[{name:'NODE_ENV',value:'production'},{name:'APP_VERSION',value:'old'}]}]}});
else if(operation==='ecs register-task-definition'){
 const input=fs.readFileSync(get('--cli-input-json').replace('file://',''),'utf8');fs.writeFileSync(p.join(dir,'registered-task.json'),input);output(next);
}else if(operation==='ecs update-service'){fs.writeFileSync(p.join(dir,'current'),get('--task-definition'));output({});}
else if(operation==='ecs wait'){
 if(mode==='wait-failure'&&!fs.existsSync(p.join(dir,'wait-failed'))){fs.writeFileSync(p.join(dir,'wait-failed'),'yes');process.exit(255);}
}else{console.error('Unmocked AWS call: '+operation);process.exit(99);}
`;
  await writeFile(join(bin, "aws"), aws, { mode: 0o755 });
  await writeFile(
    join(bin, "docker"),
    '#!/usr/bin/env bash\nset -e\necho "docker $1" >> "$MOCK_LOG_DIR/calls"\nif [[ $1 == login ]]; then cat >/dev/null; fi\n',
    { mode: 0o755 },
  );
  // This stub prevents all production network traffic from release-control tests.
  await writeFile(
    join(bin, "node"),
    '#!/usr/bin/env bash\necho "smoke-check" >> "$MOCK_LOG_DIR/calls"\n[[ $MOCK_MODE != smoke-failure ]]\n',
    { mode: 0o755 },
  );
  const git = (args) => {
    const r = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["add", "."]);
  git(["commit", "-m", "Test release fixture"]);
  const sha = git(["rev-parse", "HEAD"]);
  const result = spawnSync("bash", ["scripts/deploy-release.sh"], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_LOG_DIR: join(directory, "log"),
      MOCK_MODE: mode,
      AWS_REGION: "ap-south-1",
      AWS_ACCOUNT_ID: "123456789012",
      GITHUB_SHA: sha,
      GITHUB_STEP_SUMMARY: join(directory, "log", "summary"),
    },
    timeout: 30000,
  });
  return {
    directory,
    sha,
    result,
    async read(name) {
      return readFile(join(directory, "log", name), "utf8");
    },
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
for (const [mode, success] of [
  ["success", true],
  ["denied", false],
  ["wrong-account", false],
  ["wait-failure", false],
  ["smoke-failure", false],
]) {
  await test(`deployment control: ${mode}`, async () => {
    const f = await releaseFixture(mode);
    try {
      assert.equal(f.result.status, success ? 0 : 1, f.result.stderr);
      const calls = await f.read("calls");
      if (mode === "denied" || mode === "wrong-account") {
        assert(!calls.includes("docker build"));
        assert(!calls.includes("ecs update-service"));
        return;
      }
      const registered = JSON.parse(await f.read("registered-task.json"));
      assert.equal(
        registered.containerDefinitions[0].image,
        "123456789012.dkr.ecr.ap-south-1.amazonaws.com/tripling@sha256:" +
          "a".repeat(64),
      );
      assert.equal(
        registered.containerDefinitions[0].environment.find(
          (v) => v.name === "APP_VERSION",
        ).value,
        f.sha,
      );
      assert(!registered.taskDefinitionArn);
      assert.equal(registered.taskRoleArn, "runtime");
      assert.equal(await f.read("current"), success ? newTask : oldTask);
      if (success) {
        assert((await f.read("summary")).includes(f.sha));
        assert(calls.includes("smoke-check"));
      } else
        assert(
          f.result.stderr.includes("restoring the previous task definition"),
        );
    } finally {
      await f.cleanup();
    }
  });
}

for (const mode of ["matching", "wrong-version", "draft-policy"]) {
  await test(`production smoke validation: ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "tripling-smoke-test-"));
    try {
      const mock = join(directory, "fetch.mjs");
      await writeFile(
        mock,
        `globalThis.fetch=async(url,options)=>{if(options.method&&options.method!=='GET')throw Error('Smoke checks must not write data');const path=new URL(url).pathname;const mode=process.env.MOCK_MODE;const version=mode==='wrong-version'?'old-version':process.env.EXPECTED_VERSION;let value;if(path==='/healthz')value={status:'ok',version};else if(path==='/api/auth/session')value={user:null};else if(path==='/api/bootstrap')value={user:null,trips:[]};else if(path==='/api/legal')value={documents:{terms:{published:mode!=='draft-policy',version:'policy-v1'},privacy:{published:true,version:'policy-v1'}}};else if(path==='/terms'||path==='/privacy')return new Response('Published policy-v1',{status:200});else throw Error('Unexpected URL');return new Response(JSON.stringify(value),{status:200});};`,
      );
      const result = spawnSync(
        process.execPath,
        ["--import", mock, join(source, "scripts/smoke-deployment.mjs")],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            APP_ORIGIN: "https://tripling.in",
            EXPECTED_VERSION: "a".repeat(40),
            MOCK_MODE: mode,
          },
        },
      );
      assert.equal(result.status, mode === "matching" ? 0 : 1, result.stderr);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
