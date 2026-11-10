#!/usr/bin/env bash
# Certificate-independent first phase. Creates billable database/network resources.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ${TRIPLING_DEPLOY_APPROVED:-} != yes ]]; then
  echo 'This creates billable RDS, network and endpoint resources. Set TRIPLING_DEPLOY_APPROVED=yes when ready to create them.' >&2
  exit 1
fi
command -v aws >/dev/null || { echo 'AWS CLI is required.' >&2; exit 1; }
region=${AWS_REGION:-ap-southeast-2}
expected_account=${TRIPLING_AWS_ACCOUNT_ID:-669991883783}
foundation=${TRIPLING_FOUNDATION_STACK:-tripling-foundation}
actual_account=$(aws sts get-caller-identity --query Account --output text --region "$region")
[[ "$actual_account" == "$expected_account" ]] || { echo "AWS account mismatch: expected $expected_account, received $actual_account." >&2; exit 1; }
# Omit optional parameters to preserve existing stack settings on subsequent runs.
foundation_options=()
if [[ -n ${TRIPLING_GOOGLE_SECRET_ARN:-} ]]; then foundation_options+=(InternetEgress=true); elif [[ -n ${TRIPLING_INTERNET_EGRESS:-} ]]; then foundation_options+=("InternetEgress=$TRIPLING_INTERNET_EGRESS"); fi
aws cloudformation deploy --template-file infra/foundation.yaml --stack-name "$foundation" --region "$region" --parameter-overrides MultiAZ="${TRIPLING_MULTI_AZ:-false}" BackupRetentionDays="${TRIPLING_BACKUP_RETENTION_DAYS:-1}" "${foundation_options[@]}" --no-fail-on-empty-changeset
aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query 'Stacks[0].{Name:StackName,Status:StackStatus}' --output table --no-cli-pager
echo 'Foundation provisioning completed. The HTTPS application still needs an ISSUED certificate and the service deployment.'
