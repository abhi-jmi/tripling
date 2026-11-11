#!/usr/bin/env bash
# Certificate-independent networking update; existing legacy database resources are retained.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ${TRIPLING_DEPLOY_APPROVED:-} != yes ]]; then
  echo 'This updates billable network/endpoint resources and preserves existing database resources. Set TRIPLING_DEPLOY_APPROVED=yes when ready.' >&2
  exit 1
fi
command -v aws >/dev/null || { echo 'AWS CLI is required.' >&2; exit 1; }
region=${AWS_REGION:-ap-southeast-2}
expected_account=${TRIPLING_AWS_ACCOUNT_ID:-669991883783}
foundation=${TRIPLING_FOUNDATION_STACK:-tripling-foundation}
actual_account=$(aws sts get-caller-identity --query Account --output text --region "$region")
[[ "$actual_account" == "$expected_account" ]] || { echo "AWS account mismatch: expected $expected_account, received $actual_account." >&2; exit 1; }
# Omit optional parameters to preserve existing stack settings on subsequent runs.
source scripts/foundation-template.sh
foundation_template=$(select_foundation_template "$foundation" "$region")
foundation_options=()
if [[ "$foundation_template" == infra/foundation.yaml ]]; then foundation_options+=("MultiAZ=${TRIPLING_MULTI_AZ:-false}" "BackupRetentionDays=${TRIPLING_BACKUP_RETENTION_DAYS:-1}"); fi
if [[ -n ${TRIPLING_GOOGLE_SECRET_ARN:-} || -n ${TRIPLING_MONGODB_SECRET_ARN:-} ]]; then foundation_options+=(InternetEgress=true); elif [[ -n ${TRIPLING_INTERNET_EGRESS:-} ]]; then foundation_options+=("InternetEgress=$TRIPLING_INTERNET_EGRESS"); fi
aws cloudformation deploy --template-file "$foundation_template" --stack-name "$foundation" --region "$region" --parameter-overrides "${foundation_options[@]}" --no-fail-on-empty-changeset
aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query 'Stacks[0].{Name:StackName,Status:StackStatus}' --output table --no-cli-pager
aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query "Stacks[0].Outputs[?OutputKey=='InternetEgressIp'].OutputValue | [0]" --output text --no-cli-pager
echo 'Foundation ready; existing legacy resources are retained. Verify Atlas access and data import before switching the service.'
