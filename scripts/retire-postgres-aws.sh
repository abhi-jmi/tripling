#!/usr/bin/env bash
# Remove only legacy RDS resources through CloudFormation, keeping a final snapshot.
set -euo pipefail
export AWS_PAGER=""
cd "$(dirname "$0")/.."
for tool in aws jq node; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
region=${AWS_REGION:-ap-southeast-2}
account=${TRIPLING_AWS_ACCOUNT_ID:-669991883783}
foundation=${TRIPLING_FOUNDATION_STACK:-tripling-foundation}
service_stack=${TRIPLING_SERVICE_STACK:-tripling-service}
[[ $(aws sts get-caller-identity --region "$region" --query Account --output text) == "$account" ]] || { echo 'AWS account mismatch.' >&2; exit 1; }
state_dir=work/postgres-retirement
umask 077
mkdir -p "$state_dir"
aws cloudformation describe-stacks --stack-name "$service_stack" --region "$region" > "$state_dir/service.json"
jq -e '.Stacks[0].Parameters|any(.ParameterKey=="MongoDBSecretArn" and (.ParameterValue|startswith("arn:")))' "$state_dir/service.json" >/dev/null || { echo 'MongoDB service configuration is missing; no changes made.' >&2; exit 1; }
output(){ jq -er --arg key "$1" '.Stacks[0].Outputs[]|select(.OutputKey==$key)|.OutputValue' "$state_dir/service.json"; }
cluster=$(output ClusterArn);service=$(output ServiceArn);website=$(output WebsiteUrl)
aws ecs describe-services --cluster "$cluster" --services "$service" --region "$region" > "$state_dir/service-status.json"
jq -e '.services[0]|.desiredCount>0 and .runningCount>=.desiredCount and .pendingCount==0 and (.deployments|length==1) and any(.deployments[];.status=="PRIMARY" and .rolloutState=="COMPLETED")' "$state_dir/service-status.json" >/dev/null || { echo 'Service is not stable; no changes made.' >&2; exit 1; }
task=$(jq -er '.services[0].taskDefinition' "$state_dir/service-status.json")
aws ecs describe-task-definition --task-definition "$task" --region "$region" > "$state_dir/task.json"
secret=$(jq -er '.Stacks[0].Parameters[]|select(.ParameterKey=="MongoDBSecretArn")|.ParameterValue' "$state_dir/service.json")
jq -e --arg secret "$secret" '.taskDefinition.containerDefinitions[]|select(.name=="tripling")|(.environment|any(.name=="MONGODB_SECRET_ARN" and .value==$secret)) and ([.environment[]|select(.name=="DATABASE_SECRET_ARN" or .name=="DATABASE_URL" or .name=="PGHOST")]|length==0)' "$state_dir/task.json" >/dev/null || { echo 'Current task is not exclusively configured for MongoDB; no changes made.' >&2; exit 1; }
version=$(jq -er '.taskDefinition.containerDefinitions[]|select(.name=="tripling")|.environment[]|select(.name=="APP_VERSION")|.value' "$state_dir/task.json")
APP_ORIGIN="$website" EXPECTED_VERSION="$version" node scripts/smoke-deployment.mjs
aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" > "$state_dir/foundation.json"
jq -e '.Stacks[0].StackStatus|IN("CREATE_COMPLETE","UPDATE_COMPLETE","UPDATE_ROLLBACK_COMPLETE")' "$state_dir/foundation.json" >/dev/null || { echo 'Foundation is not stable; no changes made.' >&2; exit 1; }
aws cloudformation list-stack-resources --stack-name "$foundation" --region "$region" > "$state_dir/resources.json"
database=$(jq -r '[.StackResourceSummaries[]|select(.LogicalResourceId=="Database" and .ResourceType=="AWS::RDS::DBInstance" and .ResourceStatus!="DELETE_COMPLETE")|.PhysicalResourceId][0]//empty' "$state_dir/resources.json")
if [[ -z "$database" ]]; then
 jq -e '.Stacks[0].Parameters|any(.ParameterKey=="LegacyPostgresEnabled" and .ParameterValue=="false")' "$state_dir/foundation.json" >/dev/null || { echo 'No managed legacy database found; manual review required.' >&2; exit 1; }
 echo 'POSTGRES_ALREADY_RETIRED: MongoDB HTTPS checks passed; no changes made.';exit 0
fi
aws rds describe-db-instances --db-instance-identifier "$database" --region "$region" > "$state_dir/database.json"
jq -e '.DBInstances[0].Engine=="postgres" and .DBInstances[0].DBInstanceStatus=="available" and .DBInstances[0].DBName=="tripling" and (.DBInstances[0].ReadReplicaDBInstanceIdentifiers|length==0)' "$state_dir/database.json" >/dev/null || { echo 'Unexpected database configuration/state; no changes made.' >&2; exit 1; }
aws cloudformation list-imports --export-name "$foundation-DatabaseHost" --region "$region" > "$state_dir/imports.json"
jq -e '.Imports|length==0' "$state_dir/imports.json" >/dev/null || { echo 'Another stack imports the PostgreSQL hostname; no changes made.' >&2; exit 1; }
printf 'Ready to retire RDS instance %s in %s. A final snapshot and legacy credentials will be retained. Network and MongoDB resources stay in place.\n' "$database" "$region"
[[ ${TRIPLING_RETIRE_POSTGRES_APPROVED:-} == yes ]] || { echo 'Read-only checks passed. Run with TRIPLING_RETIRE_POSTGRES_APPROVED=yes to execute.';exit 0; }
# Only execute changesets that touch the expected PostgreSQL resources, with no replacements.
update_foundation(){
 local phase=$1 enabled=$2 name
 name="retire-postgres-$phase-$(date +%s)"
 aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" > "$state_dir/current.json"
 jq --arg enabled "$enabled" '[.Stacks[0].Parameters[]|select(.ParameterKey!="LegacyPostgresEnabled" and .ParameterKey!="LegacyPostgresDeletionProtection")|{ParameterKey,UsePreviousValue:true}]+[{ParameterKey:"LegacyPostgresEnabled",ParameterValue:$enabled},{ParameterKey:"LegacyPostgresDeletionProtection",ParameterValue:"false"}]' "$state_dir/current.json" > "$state_dir/parameters.json"
 aws cloudformation create-change-set --stack-name "$foundation" --change-set-name "$name" --change-set-type UPDATE --template-body file://infra/foundation.yaml --parameters "file://$state_dir/parameters.json" --region "$region" > "$state_dir/$phase-create.json"
 aws cloudformation wait change-set-create-complete --stack-name "$foundation" --change-set-name "$name" --region "$region"
 aws cloudformation describe-change-set --stack-name "$foundation" --change-set-name "$name" --region "$region" > "$state_dir/$phase-changes.json"
 if [[ "$phase" == unprotect ]]; then
  jq -e '(.Changes|length>0) and all(.Changes[];.Type=="Resource" and .ResourceChange.LogicalResourceId=="Database" and .ResourceChange.Action=="Modify" and .ResourceChange.Replacement=="False" and (.ResourceChange.Details|length>0) and all(.ResourceChange.Details[];.Target.Attribute=="Properties" and .Target.Name=="DeletionProtection"))' "$state_dir/$phase-changes.json" >/dev/null || { echo 'Unexpected protection changeset; not executed.' >&2;exit 1; }
 else
  jq -e 'any(.Changes[];.ResourceChange.LogicalResourceId=="Database" and .ResourceChange.Action=="Remove") and all(.Changes[];.Type=="Resource" and (.ResourceChange.LogicalResourceId|IN("Database","DatabaseSubnets","DatabaseSecurityGroup")) and .ResourceChange.Action=="Remove")' "$state_dir/$phase-changes.json" >/dev/null || { echo 'Unexpected retirement changeset; not executed.' >&2;exit 1; }
 fi
 aws cloudformation execute-change-set --stack-name "$foundation" --change-set-name "$name" --region "$region"
 aws cloudformation wait stack-update-complete --stack-name "$foundation" --region "$region"
}
if ! jq -e '.Stacks[0].Parameters|any(.ParameterKey=="LegacyPostgresDeletionProtection" and .ParameterValue=="false")' "$state_dir/foundation.json" >/dev/null; then update_foundation unprotect true; fi
update_foundation remove false
APP_ORIGIN="$website" EXPECTED_VERSION="$version" node scripts/smoke-deployment.mjs
aws rds describe-db-snapshots --db-instance-identifier "$database" --snapshot-type manual --region "$region" --query 'DBSnapshots[].[DBSnapshotIdentifier,Status,SnapshotCreateTime]' --output table --no-cli-pager
echo 'POSTGRES_RETIRED: Legacy RDS removed through CloudFormation; MongoDB HTTPS checks passed. Final snapshot and legacy credentials are retained and may incur storage charges.'
