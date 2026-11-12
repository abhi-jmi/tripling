#!/usr/bin/env bash
# One-time infrastructure/bootstrap or explicit infrastructure updates; CI handles later application releases.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ${TRIPLING_DEPLOY_APPROVED:-} != yes ]]; then
  echo 'This creates billable AWS resources. Review infra/ and set TRIPLING_DEPLOY_APPROVED=yes only when ready.' >&2
  exit 1
fi
region=${AWS_REGION:-ap-southeast-2}
: "${TRIPLING_MONGODB_SECRET_ARN:?Set the Secrets Manager ARN for the verified Atlas target. PostgreSQL settings cannot run this release.}"
[[ ${TRIPLING_MONGODB_CUTOVER_APPROVED:-} == yes ]] || { echo 'Verify the data import and Atlas access first, then set TRIPLING_MONGODB_CUTOVER_APPROVED=yes. Existing PostgreSQL is retained.' >&2; exit 1; }
export LEGAL_OPERATOR_NAME="${LEGAL_OPERATOR_NAME:-Tripling}"
expected_account="${TRIPLING_AWS_ACCOUNT_ID:-669991883783}"
export LEGAL_CONTACT_EMAIL="${LEGAL_CONTACT_EMAIL:-abhishek@tripling.in}"
export LEGAL_JURISDICTION="${LEGAL_JURISDICTION:-Chandigarh, India}"
foundation=${TRIPLING_FOUNDATION_STACK:-tripling-foundation}
service=${TRIPLING_SERVICE_STACK:-tripling-service}
: "${TRIPLING_CERTIFICATE_ARN:?Provide an issued ACM certificate ARN in the deployment region.}"
export TRIPLING_DOMAIN="${TRIPLING_DOMAIN:-tripling.in}"
for tool in aws docker git; do command -v "$tool" >/dev/null || { echo "Install $tool first." >&2; exit 1; }; done
if [[ -n $(git status --porcelain) ]]; then echo 'Commit all changes before deployment so image tags identify exact source.' >&2; exit 1; fi
image_tag=$(git rev-parse HEAD)
actual_account=$(aws sts get-caller-identity --query Account --output text --region "$region")
if [[ "$actual_account" != "$expected_account" ]]; then
  echo "Refusing deployment: signed in to AWS account $actual_account; expected $expected_account." >&2
  exit 1
fi
# Omit optional parameters to preserve existing stack settings on subsequent runs.
source scripts/foundation-template.sh
foundation_template=$(select_foundation_template "$foundation" "$region")
foundation_options=()
if [[ "$foundation_template" == infra/foundation.yaml ]]; then foundation_options+=("MultiAZ=${TRIPLING_MULTI_AZ:-false}" "BackupRetentionDays=${TRIPLING_BACKUP_RETENTION_DAYS:-1}"); fi
if [[ -n ${TRIPLING_GOOGLE_SECRET_ARN:-} || -n ${TRIPLING_MONGODB_SECRET_ARN:-} ]]; then foundation_options+=(InternetEgress=true); elif [[ -n ${TRIPLING_INTERNET_EGRESS:-} ]]; then foundation_options+=("InternetEgress=$TRIPLING_INTERNET_EGRESS"); fi
aws cloudformation deploy --template-file "$foundation_template" --stack-name "$foundation" --region "$region" --parameter-overrides "${foundation_options[@]}" --no-fail-on-empty-changeset
repository=$(aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue | [0]" --output text)
registry=${repository%%/*}
repository_name=${repository#*/}
aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"
if ! aws ecr describe-images --region "$region" --repository-name "$repository_name" --image-ids imageTag="$image_tag" >/dev/null 2>&1; then
  build_args=(--platform linux/amd64 -t "$repository:$image_tag")
  if [[ -n ${CODEX_PROXY_CERT:-} ]]; then build_args+=(--secret "id=proxy_ca,src=$CODEX_PROXY_CERT"); fi
  docker build "${build_args[@]}" .
  docker push "$repository:$image_tag"
fi
service_options=()
if [[ -n ${TRIPLING_ADMIN_USER_IDS+x} ]]; then service_options+=("AdminUserIds=$TRIPLING_ADMIN_USER_IDS"); fi
if [[ -n ${TRIPLING_VERIFICATION_KEY_SECRET_ARN+x} ]]; then service_options+=("VerificationKeySecretArn=$TRIPLING_VERIFICATION_KEY_SECRET_ARN"); fi
if [[ "$foundation_template" == infra/foundation.yaml ]]; then
  legacy_secret=$(aws cloudformation describe-stacks --stack-name "$foundation" --region "$region" --query "Stacks[0].Outputs[?OutputKey=='DatabaseSecretArn'].OutputValue | [0]" --output text --no-cli-pager)
  [[ "$legacy_secret" == arn:*:secretsmanager:* ]] || { echo 'Legacy rollback secret could not be resolved.' >&2; exit 1; }
  service_options+=("LegacyDatabaseSecretArn=$legacy_secret")
fi
if [[ -n ${TRIPLING_PLACES_SECRET_ARN+x} ]]; then service_options+=("GooglePlacesSecretArn=$TRIPLING_PLACES_SECRET_ARN"); fi
if [[ -n ${TRIPLING_GOOGLE_SECRET_ARN+x} ]]; then service_options+=("GoogleOAuthSecretArn=$TRIPLING_GOOGLE_SECRET_ARN"); fi
aws cloudformation deploy --template-file infra/service.yaml --stack-name "$service" --region "$region" --capabilities CAPABILITY_IAM --parameter-overrides FoundationStack="$foundation" MongoDBSecretArn="$TRIPLING_MONGODB_SECRET_ARN" MongoDBDatabase="${TRIPLING_MONGODB_DATABASE:-tripling}" ImageTag="$image_tag" CertificateArn="$TRIPLING_CERTIFICATE_ARN" DomainName="$TRIPLING_DOMAIN" "LegalOperatorName=$LEGAL_OPERATOR_NAME" "LegalContactEmail=$LEGAL_CONTACT_EMAIL" "LegalJurisdiction=$LEGAL_JURISDICTION" "${service_options[@]}" --no-fail-on-empty-changeset
aws cloudformation describe-stacks --stack-name "$service" --region "$region" --query "Stacks[0].Outputs" --output table --no-cli-pager
echo 'Finish DNS setup using DnsTarget, then verify /healthz and signup/login over HTTPS.'
