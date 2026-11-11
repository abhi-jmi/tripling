#!/usr/bin/env bash
# Creates a separate read-only PostgreSQL/MongoDB transfer preflight task.
# Never calls update-service, migrate(), or any database write operation.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ ${TRIPLING_DEPLOY_APPROVED:-} == yes ]] || { echo 'This creates a separate billable Fargate preflight task. Set TRIPLING_DEPLOY_APPROVED=yes to run it.' >&2; exit 1; }
: "${TRIPLING_MONGODB_SECRET_ARN:?Set the MongoDB secret ARN, never the URI/password.}"
region=${AWS_REGION:-ap-southeast-2}
expected=${TRIPLING_AWS_ACCOUNT_ID:-669991883783}
service_stack=${TRIPLING_SERVICE_STACK:-tripling-service}
check_stack=${TRIPLING_MONGODB_PREFLIGHT_STACK:-tripling-mongodb-preflight}
for tool in aws docker git jq; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
[[ -z $(git status --porcelain) ]] || { echo 'Commit or resolve local changes before building a traceable image.' >&2; exit 1; }
actual=$(aws sts get-caller-identity --region "$region" --query Account --output text)
[[ "$actual" == "$expected" ]] || { echo 'AWS account mismatch; no resources changed.' >&2; exit 1; }
[[ "$TRIPLING_MONGODB_SECRET_ARN" == arn:aws:secretsmanager:"$region":"$expected":secret:* ]] || { echo 'The secret must be in the selected account and region.' >&2; exit 1; }
check_tmp=$(mktemp -d)
task=''
cleanup(){
  result=$?
  if [[ $result != 0 && -n "$task" ]]; then aws ecs stop-task --cluster "$cluster" --task "$task" --region "$region" --reason 'Connectivity check interrupted or failed' >/dev/null 2>&1 || true; fi
  rm -rf "$check_tmp"
}
trap cleanup EXIT
aws cloudformation describe-stacks --stack-name "$service_stack" --region "$region" --output json > "$check_tmp/service.json"
output(){ jq -er --arg key "$1" '.Stacks[0].Outputs[]|select(.OutputKey==$key)|.OutputValue' "$check_tmp/service.json"; }
cluster=$(output ClusterArn)
service=$(output ServiceArn)
foundation=$(jq -er '.Stacks[0].Parameters[]|select(.ParameterKey=="FoundationStack")|.ParameterValue' "$check_tmp/service.json")
repository=$(aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue | [0]" --output text)
[[ "$repository" == "$expected.dkr.ecr.$region.amazonaws.com/"* ]] || { echo 'Unexpected repository.' >&2; exit 1; }
aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" > "$check_tmp/network-source.json"
jq -e '.services[0].networkConfiguration.awsvpcConfiguration | (.subnets|length)>0 and (.securityGroups|length)>0 and .assignPublicIp=="DISABLED"' "$check_tmp/network-source.json" >/dev/null || { echo 'Expected private Fargate service networking was not found.' >&2; exit 1; }
jq '{awsvpcConfiguration:.services[0].networkConfiguration.awsvpcConfiguration}' "$check_tmp/network-source.json" > "$check_tmp/network.json"
tag="mongodb-preflight-$(git rev-parse HEAD)"
repository_name=${repository#*/}
source_host=$(aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query "Stacks[0].Outputs[?OutputKey=='DatabaseHost'].OutputValue | [0]" --output text --no-cli-pager)
source_secret=$(aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query "Stacks[0].Outputs[?OutputKey=='DatabaseSecretArn'].OutputValue | [0]" --output text --no-cli-pager)
[[ "$source_host" != None && -n "$source_host" && "$source_secret" == arn:aws:secretsmanager:"$region":"$expected":secret:* ]] || { echo 'The legacy source database configuration was not found.' >&2; exit 1; }
aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "${repository%%/*}"
if ! aws ecr describe-images --region "$region" --repository-name "$repository_name" --image-ids imageTag="$tag" > "$check_tmp/image.json" 2> "$check_tmp/image-error"; then
  if ! grep -q 'ImageNotFoundException' "$check_tmp/image-error"; then cat "$check_tmp/image-error" >&2; exit 1; fi
  build_args=(-f Dockerfile.migration --platform linux/amd64 -t "$repository:$tag")
  if [[ -n ${CODEX_PROXY_CERT:-} ]]; then build_args+=(--secret "id=proxy_ca,src=$CODEX_PROXY_CERT"); fi
  docker build "${build_args[@]}" .
  docker push "$repository:$tag"
fi
digest=$(aws ecr describe-images --region "$region" --repository-name "$repository_name" --image-ids imageTag="$tag" --query 'imageDetails[0].imageDigest' --output text)
[[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Image digest unavailable.' >&2; exit 1; }
aws cloudformation deploy --stack-name "$check_stack" --region "$region" --template-file infra/mongodb-preflight.yaml --capabilities CAPABILITY_IAM --parameter-overrides ImageUri="$repository@$digest" RepositoryArn="arn:aws:ecr:$region:$expected:repository/$repository_name" MongoDBSecretArn="$TRIPLING_MONGODB_SECRET_ARN" MongoDBDatabase="${TRIPLING_MONGODB_DATABASE:-tripling}" SourceDatabaseHost="$source_host" SourceDatabaseSecretArn="$source_secret" --no-fail-on-empty-changeset
aws cloudformation describe-stacks --stack-name "$check_stack" --region "$region" > "$check_tmp/check.json"
task_definition=$(jq -er '.Stacks[0].Outputs[]|select(.OutputKey=="TaskDefinitionArn")|.OutputValue' "$check_tmp/check.json")
log_group=$(jq -er '.Stacks[0].Outputs[]|select(.OutputKey=="LogGroupName")|.OutputValue' "$check_tmp/check.json")
aws ecs run-task --cluster "$cluster" --task-definition "$task_definition" --launch-type FARGATE --network-configuration "file://$check_tmp/network.json" --region "$region" > "$check_tmp/run.json"
jq -e '(.failures|length)==0 and (.tasks|length)==1' "$check_tmp/run.json" >/dev/null || { jq '{failures}' "$check_tmp/run.json" >&2; exit 1; }
task=$(jq -er '.tasks[0].taskArn' "$check_tmp/run.json")
echo "Read-only migration preflight started: $task"
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task" --region "$region"
aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --region "$region" > "$check_tmp/result.json"
# Only the sanitized probe output is logged; no secret is printed or passed in argv.
aws logs get-log-events --log-group-name "$log_group" --log-stream-name "check/tripling/${task##*/}" --region "$region" --query 'events[].message' --output text --no-cli-pager || true
if ! jq -e '.tasks[0] | .stopCode=="EssentialContainerExited" and any(.containers[]; .name=="tripling" and .exitCode==0)' "$check_tmp/result.json" >/dev/null; then
  jq '.tasks[0]|{stopCode,stoppedReason,containers:[.containers[]|{name,exitCode,reason}]}' "$check_tmp/result.json" >&2
  exit 1
fi
echo 'Migration preflight passed. No records were changed/transferred and the website remains on PostgreSQL.'
