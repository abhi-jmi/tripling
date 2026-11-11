#!/usr/bin/env bash
# Existing PostgreSQL resources remain in their original template until retired
# deliberately. New Atlas installations never provision a redundant RDS database.
select_foundation_template(){
  local foundation_name=$1 foundation_region=$2 prior_database result_file
  result_file=$(mktemp)
  if prior_database=$(aws cloudformation describe-stacks --stack-name "$foundation_name" --region "$foundation_region" --query "Stacks[0].Outputs[?OutputKey=='DatabaseHost'].OutputValue | [0]" --output text --no-cli-pager 2>"$result_file"); then
    rm -f "$result_file"
    if [[ "$prior_database" != None && -n "$prior_database" ]]; then printf '%s' infra/foundation.yaml; else printf '%s' infra/foundation-mongodb.yaml; fi
  elif grep -q 'ValidationError.*does not exist' "$result_file"; then
    rm -f "$result_file"
    printf '%s' infra/foundation-mongodb.yaml
  else
    cat "$result_file" >&2
    rm -f "$result_file"
    return 1
  fi
}
