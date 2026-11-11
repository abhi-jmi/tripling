#!/usr/bin/env bash
# Finish a verified cutover that stopped while ALB maintenance was being removed.
# No import, image build, stack deployment or PostgreSQL rollback is performed.
set -euo pipefail
export AWS_PAGER=""
cd "$(dirname "$0")/.."
[[ ${TRIPLING_DEPLOY_APPROVED:-} == yes ]] || { echo 'Set TRIPLING_DEPLOY_APPROVED=yes to reopen the verified MongoDB service.' >&2; exit 1; }
: "${TRIPLING_MONGODB_SECRET_ARN:?Provide the existing MongoDB secret ARN.}"
for tool in aws jq node; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
region=${AWS_REGION:-ap-southeast-2}
expected=${TRIPLING_AWS_ACCOUNT_ID:-669991883783}
[[ $(aws sts get-caller-identity --region "$region" --query Account --output text) == "$expected" ]] || { echo 'AWS account mismatch.' >&2; exit 1; }
state_dir=work/mongodb-cutover
jq -e '.phase=="opening" or .phase=="complete"' "$state_dir/state.json" >/dev/null || { echo 'Only a previously verified opening/complete cutover can be reopened.' >&2; exit 1; }
jq -e '.tasks[0]|.stopCode=="EssentialContainerExited" and any(.containers[];.name=="tripling" and .exitCode==0)' "$state_dir/worker-result.json" >/dev/null || { echo 'Saved final database verification did not succeed.' >&2; exit 1; }
umask 077
aws cloudformation describe-stacks --stack-name "${TRIPLING_SERVICE_STACK:-tripling-service}" --region "$region" > "$state_dir/reopen-stack.json"
output(){ jq -er --arg key "$1" '.Stacks[0].Outputs[]|select(.OutputKey==$key)|.OutputValue' "$state_dir/reopen-stack.json"; }
cluster=$(output ClusterArn);service=$(output ServiceArn);website=$(output WebsiteUrl)
[[ "$cluster" == "$(jq -r '.cluster' "$state_dir/state.json")" && "$service" == "$(jq -r '.service' "$state_dir/state.json")" ]] || { echo 'Saved and current service identities differ.' >&2; exit 1; }
jq -e --arg secret "$TRIPLING_MONGODB_SECRET_ARN" '.Stacks[0].Parameters|any(.ParameterKey=="MongoDBSecretArn" and .ParameterValue==$secret)' "$state_dir/reopen-stack.json" >/dev/null || { echo 'The service is not configured for the expected MongoDB secret.' >&2; exit 1; }
expected_version=$(jq -er '.taskDefinition.containerDefinitions[]|select(.name=="tripling")|.environment[]|select(.name=="APP_VERSION")|.value' "$state_dir/new-task.json")
[[ "$expected_version" =~ ^[a-f0-9]{40}$ ]] || { echo 'Saved application version is invalid.' >&2; exit 1; }
aws ecs wait services-stable --cluster "$cluster" --services "$service" --region "$region"
aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" > "$state_dir/reopen-service.json"
jq -e '.services[0]|.desiredCount>0 and .runningCount>=.desiredCount and any(.deployments[];.status=="PRIMARY" and .rolloutState=="COMPLETED")' "$state_dir/reopen-service.json" >/dev/null || { echo 'The application service is not healthy/stable.' >&2; exit 1; }
current_task=$(jq -er '.services[0].taskDefinition' "$state_dir/reopen-service.json")
aws ecs describe-task-definition --task-definition "$current_task" --region "$region" > "$state_dir/reopen-task.json"
jq -e --arg version "$expected_version" --arg secret "$TRIPLING_MONGODB_SECRET_ARN" '.taskDefinition.containerDefinitions[]|select(.name=="tripling")|.environment|any(.name=="APP_VERSION" and .value==$version) and any(.name=="MONGODB_SECRET_ARN" and .value==$secret)' "$state_dir/reopen-task.json" >/dev/null || { echo 'Current task differs from the verified MongoDB release.' >&2; exit 1; }
aws cloudformation list-stack-resources --stack-name "${TRIPLING_SERVICE_STACK:-tripling-service}" --region "$region" > "$state_dir/reopen-resources.json"
listener=$(jq -er '.StackResourceSummaries[]|select(.LogicalResourceId=="HttpsListener")|.PhysicalResourceId' "$state_dir/reopen-resources.json")
[[ "$listener" == "$(jq -r '.listener' "$state_dir/state.json")" ]] || { echo 'Listener identity changed; manual review required.' >&2; exit 1; }
target=$(jq -er '.StackResourceSummaries[]|select(.LogicalResourceId=="TargetGroup")|.PhysicalResourceId' "$state_dir/reopen-resources.json")
aws elbv2 describe-target-health --target-group-arn "$target" --region "$region" > "$state_dir/reopen-targets.json"
jq -e 'any(.TargetHealthDescriptions[];.TargetHealth.State=="healthy")' "$state_dir/reopen-targets.json" >/dev/null || { echo 'No healthy application target; maintenance retained.' >&2; exit 1; }
aws elbv2 describe-rules --listener-arn "$listener" --region "$region" > "$state_dir/reopen-rules.json"
maintenance=$(jq -r '.Rules[]|select(.Priority=="2")|.RuleArn' "$state_dir/reopen-rules.json")
if [[ -n "$maintenance" ]]; then
  jq -e '.Rules[]|select(.Priority=="2")|any(.Conditions[];.Field=="path-pattern" and ((.PathPatternConfig.Values//.Values)==["/*"])) and (.Actions|length==1) and .Actions[0].Type=="fixed-response" and .Actions[0].FixedResponseConfig.StatusCode=="503" and .Actions[0].FixedResponseConfig.MessageBody=="Tripling is temporarily unavailable for maintenance. Please try again shortly."' "$state_dir/reopen-rules.json" >/dev/null || { echo 'Priority 2 is not the dedicated maintenance rule; nothing removed.' >&2; exit 1; }
fi
health=$(jq -r '.Rules[]|select(.Priority=="1")|.RuleArn' "$state_dir/reopen-rules.json")
if [[ -n "$health" ]]; then
  jq -e --arg target "$target" '.Rules[]|select(.Priority=="1")|any(.Conditions[];.Field=="path-pattern" and ((.PathPatternConfig.Values//.Values)==["/healthz"])) and .Actions[0].Type=="forward" and .Actions[0].TargetGroupArn==$target' "$state_dir/reopen-rules.json" >/dev/null || { echo 'Priority 1 is not the dedicated health rule; manual review required.' >&2; exit 1; }
fi
opening=false
cleanup(){
 code=$?
 if [[ $code != 0 && "$opening" == true ]]; then
  aws elbv2 create-rule --listener-arn "$listener" --priority 2 --conditions '[{"Field":"path-pattern","Values":["/*"]}]' --actions "file://$state_dir/maintenance-actions.json" --region "$region" > "$state_dir/reopen-maintenance.json" 2>/dev/null || true
  echo 'Checks failed; maintenance retained/reapplied. MongoDB data was not changed or rolled back. Keep the saved state.' >&2
 fi
}
trap cleanup EXIT
opening=true
if [[ -n "$maintenance" ]]; then aws elbv2 delete-rule --rule-arn "$maintenance" --region "$region"; fi
if [[ -n "$health" ]]; then aws elbv2 delete-rule --rule-arn "$health" --region "$region"; fi
SMOKE_503_ATTEMPTS=30 SMOKE_503_DELAY_MS=2000 APP_ORIGIN="$website" EXPECTED_VERSION="$expected_version" node scripts/smoke-deployment.mjs
scaling_id=$(jq -er '.scalingId' "$state_dir/state.json")
aws application-autoscaling register-scalable-target --service-namespace ecs --scalable-dimension ecs:service:DesiredCount --resource-id "$scaling_id" --min-capacity "$(jq -r '.ScalableTargets[0].MinCapacity' "$state_dir/scaling.json")" --max-capacity "$(jq -r '.ScalableTargets[0].MaxCapacity' "$state_dir/scaling.json")" --suspended-state "file://$state_dir/scaling-state.json" --region "$region" >/dev/null
jq '.phase="complete"|.temporaryHealthRule=""|.maintenanceRule=""' "$state_dir/state.json" > "$state_dir/state.next"
mv "$state_dir/state.next" "$state_dir/state.json"
opening=false
printf '%s\n' 'MONGODB_CUTOVER_COMPLETE: MongoDB application health, version, API and policies passed. The website is reopened; PostgreSQL is retained.'
