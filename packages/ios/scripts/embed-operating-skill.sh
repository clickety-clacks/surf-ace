#!/bin/sh
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_token() {
  name=$1
  value=$2
  case "$value" in
    ''|*[!A-Za-z0-9._+/-]*) fail "invalid or missing iOS skill build field: $name" ;;
  esac
}

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "no SHA-256 utility is available"
  fi
}

project_dir=${PROJECT_DIR:?PROJECT_DIR is required}
target_build_dir=${TARGET_BUILD_DIR:?TARGET_BUILD_DIR is required}
resources_path=${UNLOCALIZED_RESOURCES_FOLDER_PATH:?UNLOCALIZED_RESOURCES_FOLDER_PATH is required}
app_version=${MARKETING_VERSION:?MARKETING_VERSION is required}
app_build_number=${CURRENT_PROJECT_VERSION:?CURRENT_PROJECT_VERSION is required}
skill_source="$project_dir/../../integrations/tightbeam/skills/surf-ace/SKILL.md"
resource_dir="$target_build_dir/$resources_path/SurfAceOperatingSkill"
skill_output="$resource_dir/SKILL.md"
manifest_output="$resource_dir/manifest.json"

require_token MARKETING_VERSION "$app_version"
require_token CURRENT_PROJECT_VERSION "$app_build_number"
[ -f "$skill_source" ] || fail "canonical Surf Ace operating skill is missing"

cloud_build_id=
cloud_build_number=
cloud_commit=
cloud_workflow_id=
cloud_start_condition=
cloud_branch=
cloud_git_ref=
cloud_scheme=
cloud_platform=
cloud_action=

case "${CI_XCODE_CLOUD:-}" in
  TRUE|True|true)
    cloud_build_id=${CI_BUILD_ID:-}
    cloud_build_number=${CI_BUILD_NUMBER:-}
    cloud_commit=${CI_COMMIT:-}
    cloud_workflow_id=${CI_WORKFLOW_ID:-}
    cloud_start_condition=${CI_START_CONDITION:-}
    cloud_branch=${CI_BRANCH:-}
    cloud_git_ref=${CI_GIT_REF:-}
    cloud_scheme=${CI_XCODE_SCHEME:-}
    cloud_platform=${CI_PRODUCT_PLATFORM:-}
    cloud_action=${CI_XCODEBUILD_ACTION:-}

    require_token CI_BUILD_ID "$cloud_build_id"
    require_token CI_BUILD_NUMBER "$cloud_build_number"
    require_token CI_COMMIT "$cloud_commit"
    require_token CI_WORKFLOW_ID "$cloud_workflow_id"
    require_token CI_START_CONDITION "$cloud_start_condition"
    require_token CI_XCODE_SCHEME "$cloud_scheme"
    require_token CI_PRODUCT_PLATFORM "$cloud_platform"
    require_token CI_XCODEBUILD_ACTION "$cloud_action"
    if [ -n "$cloud_branch" ]; then require_token CI_BRANCH "$cloud_branch"; fi
    if [ -n "$cloud_git_ref" ]; then require_token CI_GIT_REF "$cloud_git_ref"; fi
    [ "$cloud_platform" = "iOS" ] || fail "Surf Ace operating skill bundle requires an iOS Xcode Cloud build"
    [ "$cloud_scheme" = "SurfAce" ] || fail "Surf Ace operating skill bundle requires the SurfAce scheme"
    ;;
esac

mkdir -p "$resource_dir"
skill_tmp="$skill_output.tmp"
manifest_tmp="$manifest_output.tmp"
trap 'rm -f "$skill_tmp" "$manifest_tmp"' EXIT HUP INT TERM
cp "$skill_source" "$skill_tmp"
source_sha=$(hash_file "$skill_source")
embedded_sha=$(hash_file "$skill_tmp")
case "$source_sha$embedded_sha" in
  *[!0-9a-f]*|'') fail "could not calculate the Surf Ace operating skill SHA-256" ;;
esac
[ "${#source_sha}" -eq 64 ] || fail "could not calculate the Surf Ace operating skill SHA-256"
[ "$source_sha" = "$embedded_sha" ] || fail "embedded Surf Ace operating skill hash differs from source"

cat > "$manifest_tmp" <<EOF
{
  "appVersion": "$app_version",
  "appBuildNumber": "$app_build_number",
  "operatingSkill": {
    "asset": "SurfAceOperatingSkill/SKILL.md",
    "clientPlatforms": ["ios"],
    "publication": "app-bundle",
    "sha256": "$embedded_sha",
    "sourcePath": "integrations/tightbeam/skills/surf-ace/SKILL.md",
    "version": "$app_version"
  },
  "xcodeCloudBuildId": "$cloud_build_id",
  "xcodeCloudBuildNumber": "$cloud_build_number",
  "xcodeCloudCommit": "$cloud_commit",
  "xcodeCloudWorkflowId": "$cloud_workflow_id",
  "xcodeCloudStartCondition": "$cloud_start_condition",
  "xcodeCloudBranch": "$cloud_branch",
  "xcodeCloudGitRef": "$cloud_git_ref",
  "xcodeCloudScheme": "$cloud_scheme",
  "xcodeCloudPlatform": "$cloud_platform",
  "xcodeCloudAction": "$cloud_action"
}
EOF

mv "$skill_tmp" "$skill_output"
mv "$manifest_tmp" "$manifest_output"
