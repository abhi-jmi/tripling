#!/usr/bin/env bash
# Explicit maintenance + verified data copy + application cutover. The RDS source
# is never modified/deleted. Never roll back to PostgreSQL after MongoDB serves traffic.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ ${TRIPLING_DEPLOY_APPROVED:-} == yes && ${TRIPLING_MONGODB_CUTOVER_APPROVED:-} == yes && ${TRIPLING_DOWNTIME_APPROVED:-} == yes ]] || { echo 'Cutover requires TRIPLING_DEPLOY_APPROVED=yes, TRIPLING_MONGODB_CUTOVER_APPROVED=yes and TRIPLING_DOWNTIME_APPROVED=yes. This temporarily closes the website.' >&2; exit 1; }
: "${TRIPLING_MONGODB_SECRET_ARN:?Provide the MongoDB secret ARN.}"
: "${TRIPLING_CERTIFICATE_ARN:?Provide the existing ACM certificate ARN.}"
for tool in aws docker git jq node; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
[[ -z $(git status --porcelain) ]] || { echo 'Checkout must be clean.' >&2; exit 1; }
region=${AWS_REGION:-ap-southeast-2}
export AWS_REGION="$region" AWS_DEFAULT_REGION="$region"
expected=${TRIPLING_AWS_ACCOUNT_ID:-669991883783}
[[ $(aws sts get-caller-identity --region "$region" --query Account --output text) == "$expected" ]] || { echo 'AWS account mismatch.' >&2; exit 1; }
[[ "$TRIPLING_MONGODB_SECRET_ARN" == arn:aws:secretsmanager:"$region":"$expected":secret:* ]] || { echo 'Secret account/region mismatch.' >&2; exit 1; }
service_stack=${TRIPLING_SERVICE_STACK:-tripling-service}
check_stack=${TRIPLING_MONGODB_PREFLIGHT_STACK:-tripling-mongodb-preflight}
state_dir=work/mongodb-cutover
[[ ! -e "$state_dir/state.json" ]] || { echo 'A cutover state already exists at work/mongodb-cutover/state.json. Inspect it before any retry; do not erase it or rerun blindly.' >&2; exit 1; }
umask 077
mkdir -p "$state_dir"
phase=preparing
task=''
listener=''
rule=''
maintenance_rule=''
cluster=''
service=''
scaling_id=''
save_phase(){
  if [[ -f "$state_dir/state.json" ]]; then jq --arg phase "$phase" --arg rule "$rule" --arg maintenance "$maintenance_rule" '.phase=$phase|.temporaryHealthRule=$rule|.maintenanceRule=$maintenance' "$state_dir/state.json" > "$state_dir/state.next"; mv "$state_dir/state.next" "$state_dir/state.json"; fi
}
restore_scaling(){
 aws application-autoscaling register-scalable-target --service-namespace ecs --scalable-dimension ecs:service:DesiredCount --resource-id "$scaling_id" --min-capacity "$(jq -r '.ScalableTargets[0].MinCapacity' "$state_dir/scaling.json")" --max-capacity "$(jq -r '.ScalableTargets[0].MaxCapacity' "$state_dir/scaling.json")" --suspended-state "file://$state_dir/scaling-state.json" --region "$region" >/dev/null
}
cleanup(){
 result=$?
 if [[ $result != 0 ]]; then
   if [[ -n "$task" ]]; then aws ecs stop-task --cluster "$cluster" --task "$task" --region "$region" --reason 'Migration workflow interrupted' >/dev/null 2>&1 || true; fi
   if [[ "$phase" == pausing || "$phase" == paused || "$phase" == transferred ]]; then
     echo 'Failure before application deployment; attempting to restore the unchanged PostgreSQL application.' >&2
     current_task=$(aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" --query 'services[0].taskDefinition' --output text 2>/dev/null) || current_task=''
     if [[ "$current_task" == "$old_task" ]] && aws ecs update-service --cluster "$cluster" --service "$service" --desired-count "$old_desired" --region "$region" >/dev/null && aws ecs wait services-stable --cluster "$cluster" --services "$service" --region "$region"; then
       restore_scaling || true
       if [[ -n "$maintenance_rule" ]]; then aws elbv2 delete-rule --rule-arn "$maintenance_rule" --region "$region" >/dev/null || true; fi
       if [[ -n "$rule" ]]; then aws elbv2 delete-rule --rule-arn "$rule" --region "$region" >/dev/null || true; fi
       phase=source_restored
     fi
   elif [[ "$phase" == deploying || "$phase" == verifying || "$phase" == opening ]]; then
     echo 'The MongoDB application may have been deployed. PostgreSQL rollback was NOT attempted; maintenance is retained for investigation.' >&2
     aws elbv2 create-rule --listener-arn "$listener" --priority 2 --conditions '[{"Field":"path-pattern","Values":["/*"]}]' --actions "file://$state_dir/maintenance-actions.json" --region "$region" >/dev/null 2>&1 || true
   fi
   save_phase || true
   echo "Cutover stopped in phase $phase. Keep $state_dir and both databases. If PostgreSQL traffic resumed, staged MongoDB data must be reassessed before another migration." >&2
 fi
}
trap cleanup EXIT
aws cloudformation describe-stacks --stack-name "$service_stack" --region "$region" > "$state_dir/service-stack.json"
output(){ jq -er --arg key "$1" '.Stacks[0].Outputs[]|select(.OutputKey==$key)|.OutputValue' "$state_dir/service-stack.json"; }
# This entrypoint is only for the first PostgreSQL-to-MongoDB switch.
jq -e '[.Stacks[0].Parameters[]|select(.ParameterKey=="MongoDBSecretArn" and (.ParameterValue|length)>0)]|length==0' "$state_dir/service-stack.json" >/dev/null || { echo 'Service is already configured for MongoDB; use the ordinary release process.' >&2; exit 1; }
cluster=$(output ClusterArn); service=$(output ServiceArn); website=$(output WebsiteUrl)
[[ "$website" == https://* ]] || { echo 'An HTTPS website is required.' >&2; exit 1; }
foundation=$(jq -er '.Stacks[0].Parameters[]|select(.ParameterKey=="FoundationStack")|.ParameterValue' "$state_dir/service-stack.json")
aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" > "$state_dir/service-before.json"
old_desired=$(jq -er '.services[0].desiredCount|select(.>0)' "$state_dir/service-before.json")
old_task=$(jq -er '.services[0].taskDefinition' "$state_dir/service-before.json")
jq -e '.services[0] | .pendingCount==0 and .runningCount==.desiredCount' "$state_dir/service-before.json" >/dev/null || { echo 'Wait until the existing service is stable before cutover.' >&2; exit 1; }
jq '{awsvpcConfiguration:.services[0].networkConfiguration.awsvpcConfiguration}' "$state_dir/service-before.json" > "$state_dir/network.json"
scaling_id="service/$(output ClusterName)/$(output ServiceName)"
aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids "$scaling_id" --scalable-dimension ecs:service:DesiredCount --region "$region" > "$state_dir/scaling.json"
jq -e '.ScalableTargets|length==1' "$state_dir/scaling.json" >/dev/null || { echo 'Expected one existing scaling target.' >&2; exit 1; }
jq '.ScalableTargets[0].SuspendedState // {DynamicScalingInSuspended:false,DynamicScalingOutSuspended:false,ScheduledScalingSuspended:false}' "$state_dir/scaling.json" > "$state_dir/scaling-state.json"
aws cloudformation list-stack-resources --stack-name "$service_stack" --region "$region" > "$state_dir/resources.json"
listener=$(jq -er '.StackResourceSummaries[]|select(.LogicalResourceId=="HttpsListener")|.PhysicalResourceId' "$state_dir/resources.json")
aws elbv2 describe-listeners --listener-arns "$listener" --region "$region" > "$state_dir/listener.json"
jq -e '.Listeners[0].DefaultActions | length==1 and .[0].Type=="forward"' "$state_dir/listener.json" >/dev/null || { echo 'Expected an ordinary forward listener.' >&2; exit 1; }
jq '.Listeners[0].DefaultActions' "$state_dir/listener.json" > "$state_dir/listener-actions.json"
aws elbv2 describe-rules --listener-arn "$listener" --region "$region" > "$state_dir/rules.json"
jq -e '[.Rules[]|select(.IsDefault==false)]|length==0' "$state_dir/rules.json" >/dev/null || { echo 'Custom listener rules need a reviewed maintenance plan.' >&2; exit 1; }
printf '%s' '[{"Type":"fixed-response","FixedResponseConfig":{"StatusCode":"503","ContentType":"text/plain","MessageBody":"Tripling is temporarily unavailable for maintenance. Please try again shortly."}}]' > "$state_dir/maintenance-actions.json"
jq -n --arg cluster "$cluster" --arg service "$service" --arg task "$old_task" --arg listener "$listener" --arg scaling "$scaling_id" --argjson desired "$old_desired" '{phase:"preparing",cluster:$cluster,service:$service,originalTaskDefinition:$task,originalDesiredCount:$desired,listener:$listener,scalingId:$scaling}' > "$state_dir/state.json"
echo 'Preparing migration task and checking data before maintenance.'
bash scripts/preflight-mongodb-aws.sh
# Build the application image before stopping writers.
repository=$(aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue | [0]" --output text)
sha=$(git rev-parse HEAD)
if ! aws ecr describe-images --repository-name "${repository#*/}" --image-ids imageTag="$sha" --region "$region" > "$state_dir/app-image.json" 2> "$state_dir/app-image-error"; then
  if ! grep -q ImageNotFoundException "$state_dir/app-image-error"; then cat "$state_dir/app-image-error" >&2; exit 1; fi
  args=(--platform linux/amd64 -t "$repository:$sha");if [[ -n ${CODEX_PROXY_CERT:-} ]]; then args+=(--secret "id=proxy_ca,src=$CODEX_PROXY_CERT");fi
  docker build "${args[@]}" .; docker push "$repository:$sha"
fi
aws cloudformation describe-stacks --stack-name "$check_stack" --region "$region" > "$state_dir/worker-stack.json"
worker_definition=$(jq -er '.Stacks[0].Outputs[]|select(.OutputKey=="TaskDefinitionArn")|.OutputValue' "$state_dir/worker-stack.json")
worker_logs=$(jq -er '.Stacks[0].Outputs[]|select(.OutputKey=="LogGroupName")|.OutputValue' "$state_dir/worker-stack.json")
run_worker(){
 local mode=$1
 jq -n --arg mode "$mode" '{containerOverrides:[{name:"tripling",command:[$mode],environment:[{name:"TRIPLING_WRITES_PAUSED",value:"yes"},{name:"TRIPLING_DATA_MIGRATION_APPROVED",value:"yes"}]}]}' > "$state_dir/overrides.json"
 aws ecs run-task --cluster "$cluster" --task-definition "$worker_definition" --launch-type FARGATE --network-configuration "file://$state_dir/network.json" --overrides "file://$state_dir/overrides.json" --region "$region" > "$state_dir/worker-run.json"
 jq -e '(.failures|length)==0 and (.tasks|length)==1' "$state_dir/worker-run.json" >/dev/null || { jq '{failures}' "$state_dir/worker-run.json" >&2; return 1; }
 task=$(jq -er '.tasks[0].taskArn' "$state_dir/worker-run.json")
 echo "Migration worker $mode started: $task"
 aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task" --region "$region"
 aws ecs describe-tasks --cluster "$cluster" --tasks "$task" --region "$region" > "$state_dir/worker-result.json"
 aws logs get-log-events --log-group-name "$worker_logs" --log-stream-name "check/tripling/${task##*/}" --region "$region" --query 'events[].message' --output text --no-cli-pager || true
 jq -e '.tasks[0]|.stopCode=="EssentialContainerExited" and any(.containers[];.name=="tripling" and .exitCode==0)' "$state_dir/worker-result.json" >/dev/null || { jq '.tasks[0]|{stopCode,stoppedReason,containers:[.containers[]|{name,exitCode,reason}]}' "$state_dir/worker-result.json" >&2; return 1; }
 task=''
}
# Keep /healthz GET available for a read-only version check; all public writes
# are blocked until CloudFormation, ECS, and record verification succeed.
aws elbv2 create-rule --listener-arn "$listener" --priority 1 --conditions '[{"Field":"path-pattern","Values":["/healthz"]},{"Field":"http-request-method","HttpRequestMethodConfig":{"Values":["GET"]}}]' --actions "file://$state_dir/listener-actions.json" --region "$region" > "$state_dir/health-rule.json"
rule=$(jq -er '.Rules[0].RuleArn' "$state_dir/health-rule.json")
phase=pausing; save_phase
aws elbv2 create-rule --listener-arn "$listener" --priority 2 --conditions '[{"Field":"path-pattern","Values":["/*"]}]' --actions "file://$state_dir/maintenance-actions.json" --region "$region" > "$state_dir/maintenance-rule.json"
maintenance_rule=$(jq -er '.Rules[0].RuleArn' "$state_dir/maintenance-rule.json");save_phase
aws application-autoscaling register-scalable-target --service-namespace ecs --resource-id "$scaling_id" --scalable-dimension ecs:service:DesiredCount --suspended-state '{"DynamicScalingInSuspended":true,"DynamicScalingOutSuspended":true,"ScheduledScalingSuspended":true}' --region "$region" >/dev/null
aws ecs update-service --cluster "$cluster" --service "$service" --desired-count 0 --region "$region" >/dev/null
aws ecs wait services-stable --cluster "$cluster" --services "$service" --region "$region"
phase=paused;save_phase
run_worker transfer
phase=transferred;save_phase
phase=deploying;save_phase
bash scripts/deploy-aws.sh
new_task=$(aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" --query 'services[0].taskDefinition' --output text)
aws ecs describe-task-definition --task-definition "$new_task" --region "$region" > "$state_dir/new-task.json"
jq -e --arg sha "$sha" --arg secret "$TRIPLING_MONGODB_SECRET_ARN" --arg db "${TRIPLING_MONGODB_DATABASE:-tripling}" '.taskDefinition.containerDefinitions[]|select(.name=="tripling")|.environment|any(.name=="APP_VERSION" and .value==$sha) and any(.name=="MONGODB_SECRET_ARN" and .value==$secret) and any(.name=="MONGODB_DATABASE" and .value==$db)' "$state_dir/new-task.json" >/dev/null || { echo 'The expected MongoDB task is not running.' >&2; exit 1; }
# Explicitly start the verified MongoDB task even if CloudFormation preserved
# the manually paused desired count of zero during its task-definition update.
aws ecs update-service --cluster "$cluster" --service "$service" --desired-count "$old_desired" --region "$region" >/dev/null
aws ecs wait services-stable --cluster "$cluster" --services "$service" --region "$region"
# The only temporary public route is a credential-free GET healthcheck.
APP_ORIGIN="$website" EXPECTED_VERSION="$sha" node --input-type=module -e 'const r=await fetch(new URL("/healthz",process.env.APP_ORIGIN),{signal:AbortSignal.timeout(15000)});const b=await r.json();if(!r.ok||b.status!=="ok"||b.version!==process.env.EXPECTED_VERSION)throw Error("New MongoDB application health/version did not match");console.log("NEW_APPLICATION_HEALTH_OK");'
phase=verifying;save_phase
run_worker verify
phase=opening;save_phase
aws elbv2 delete-rule --rule-arn "$maintenance_rule" --region "$region";maintenance_rule=''
aws elbv2 delete-rule --rule-arn "$rule" --region "$region";rule=''
aws ecs update-service --cluster "$cluster" --service "$service" --desired-count "$old_desired" --region "$region" >/dev/null
restore_scaling
APP_ORIGIN="$website" EXPECTED_VERSION="$sha" node scripts/smoke-deployment.mjs
phase=complete;save_phase
printf '%s\n' 'MONGODB_CUTOVER_COMPLETE: The website is using MongoDB. Original PostgreSQL is retained; old sessions require sign-in again.'
