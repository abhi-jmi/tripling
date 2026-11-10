#!/usr/bin/env bash
# Run by the OIDC-authenticated GitHub deployment job after tests pass.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${AWS_REGION:?Set AWS_REGION.}"
service_stack=${AWS_SERVICE_STACK:-tripling-service}
release_sha=${GITHUB_SHA:-$(git rev-parse HEAD)}
[[ $release_sha =~ ^[a-f0-9]{40}$ ]] || { echo 'Release must identify an exact Git commit.' >&2; exit 1; }
[[ $(git rev-parse HEAD) == "$release_sha" ]] || { echo 'Checkout does not match the requested release.' >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'Release checkout must be clean.' >&2; exit 1; }
for tool in aws docker jq; do command -v "$tool" >/dev/null || { echo "Missing $tool." >&2; exit 1; }; done
expected_account="${AWS_ACCOUNT_ID:-669991883783}"
actual_account=$(aws sts get-caller-identity --query Account --output text --region "$AWS_REGION")
[[ "$actual_account" == "$expected_account" ]] || { echo "AWS account mismatch: expected $expected_account, received $actual_account." >&2; exit 1; }
release_tmp=$(mktemp -d)
trap 'rm -rf "$release_tmp"' EXIT
aws cloudformation describe-stacks --stack-name "$service_stack" --region "$AWS_REGION" --output json > "$release_tmp/stack.json"
output(){ jq -er --arg key "$1" '.Stacks[0].Outputs[]|select(.OutputKey==$key)|.OutputValue' "$release_tmp/stack.json"; }
foundation=$(jq -er '.Stacks[0].Parameters[] | select(.ParameterKey=="FoundationStack") | .ParameterValue' "$release_tmp/stack.json")
aws cloudformation describe-stacks --stack-name "$foundation" --region "$AWS_REGION" --output json > "$release_tmp/foundation.json"
repository=$(jq -er '.Stacks[0].Outputs[]|select(.OutputKey=="RepositoryUri")|.OutputValue' "$release_tmp/foundation.json")
cluster=$(output ClusterArn)
service=$(output ServiceArn)
website=$(output WebsiteUrl)
registry=${repository%%/*}
repository_name=${repository#*/}
[[ $repository =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/ ]] || { echo 'Unexpected image repository.' >&2; exit 1; }
[[ $website == https://* ]] || { echo 'Production website must use HTTPS.' >&2; exit 1; }
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$registry"
# Retry-safe immutable tags: distinguish a missing image from access/network failures.
if ! aws ecr describe-images --repository-name "$repository_name" --image-ids imageTag="$release_sha" --region "$AWS_REGION" > "$release_tmp/image.json" 2> "$release_tmp/image-error"; then
  if ! grep -q 'ImageNotFoundException' "$release_tmp/image-error"; then cat "$release_tmp/image-error" >&2; exit 1; fi
  docker build --platform linux/amd64 --label "org.opencontainers.image.revision=$release_sha" -t "$repository:$release_sha" .
  docker push "$repository:$release_sha"
fi
aws ecs describe-services --cluster "$cluster" --services "$service" --region "$AWS_REGION" > "$release_tmp/service-before.json"
old_task=$(jq -er '.services[0].taskDefinition' "$release_tmp/service-before.json")
aws ecs describe-task-definition --task-definition "$old_task" --region "$AWS_REGION" > "$release_tmp/task-before.json"
image_digest=$(aws ecr describe-images --repository-name "$repository_name" --image-ids imageTag="$release_sha" --region "$AWS_REGION" --query 'imageDetails[0].imageDigest' --output text)
[[ $image_digest =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Image digest was not resolved.' >&2; exit 1; }
# Deploy by digest, keeping all existing network, secret, and role configuration.
jq --arg image "$repository@$image_digest" --arg version "$release_sha" '.taskDefinition | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt) | .containerDefinitions |= map(if .name=="tripling" then .image=$image | .environment=((.environment//[]|map(select(.name!="APP_VERSION")))+[{name:"APP_VERSION",value:$version}]) else . end)' "$release_tmp/task-before.json" > "$release_tmp/task-next.json"
new_task=$(aws ecs register-task-definition --cli-input-json "file://$release_tmp/task-next.json" --region "$AWS_REGION" --query 'taskDefinition.taskDefinitionArn' --output text)
rollback(){
  echo 'Release failed; restoring the previous task definition.' >&2
  aws ecs update-service --cluster "$cluster" --service "$service" --task-definition "$old_task" --region "$AWS_REGION" >/dev/null || return
  aws ecs wait services-stable --cluster "$cluster" --services "$service" --region "$AWS_REGION" || true
}
# ECS circuit breaker also protects deployments that cannot become healthy.
if ! aws ecs update-service --cluster "$cluster" --service "$service" --task-definition "$new_task" --region "$AWS_REGION" >/dev/null; then rollback;exit 1; fi
if ! aws ecs wait services-stable --cluster "$cluster" --services "$service" --region "$AWS_REGION"; then rollback; exit 1; fi
aws ecs describe-services --cluster "$cluster" --services "$service" --region "$AWS_REGION" > "$release_tmp/service-after.json"
if ! jq -e --arg task "$new_task" '.services[0] | .taskDefinition==$task and .runningCount>=.desiredCount and any(.deployments[]; .status=="PRIMARY" and .taskDefinition==$task and .rolloutState=="COMPLETED")' "$release_tmp/service-after.json" >/dev/null; then
  echo 'ECS did not complete the requested release; it may have rolled back.' >&2
  rollback;exit 1
fi
if ! APP_ORIGIN="$website" EXPECTED_VERSION="$release_sha" node scripts/smoke-deployment.mjs; then rollback;exit 1; fi
if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
  { echo '### Tripling deployment verified'; echo; echo "- URL: $website"; echo "- Commit: $release_sha"; echo "- Image digest: $image_digest"; echo '- Health, PostgreSQL-backed API, anonymous session, and published legal pages passed smoke checks.'; } >> "$GITHUB_STEP_SUMMARY"
fi
echo "Deployment verified: $website ($release_sha)"
