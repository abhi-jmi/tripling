#!/usr/bin/env bash
# Uses an already authenticated GitHub CLI; no personal access token is stored.
set -euo pipefail
: "${AWS_DEPLOY_ROLE_ARN:?Provide DeploymentRoleArn from the GitHub OIDC stack.}"
[[ $AWS_DEPLOY_ROLE_ARN =~ ^arn:aws:iam::[0-9]{12}:role/.+ ]] || { echo 'Invalid deployment role ARN.' >&2;exit 1; }
repo=${TRIPLING_GITHUB_REPO:-abhi-jmi/tripling}
command -v gh >/dev/null || { echo 'Install and authenticate GitHub CLI first.' >&2;exit 1; }
gh variable set AWS_REGION --repo "$repo" --body "${AWS_REGION:-ap-south-1}"
gh variable set AWS_SERVICE_STACK --repo "$repo" --body "${AWS_SERVICE_STACK:-tripling-service}"
gh variable set AWS_DEPLOY_ROLE_ARN --repo "$repo" --body "$AWS_DEPLOY_ROLE_ARN"
echo 'Repository deployment variables configured. Run the main-branch Test and deploy Tripling workflow when ready.'
