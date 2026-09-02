#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(cd "${SCRIPT_DIRECTORY}/../../.." && pwd)"
readonly REPOSITORY_ROOT
readonly IOS_DIRECTORY="${REPOSITORY_ROOT}/apps/ios"
readonly XCODE_PROJECT="${IOS_DIRECTORY}/Unfiled.xcodeproj"
readonly XCODE_SCHEME="Unfiled"
readonly EXPECTED_APP_BUNDLE_ID="com.zachshotamartin.unfiled"
readonly EXPECTED_WIDGET_BUNDLE_ID="com.zachshotamartin.unfiled.quickcapture"
readonly EXPECTED_APP_GROUP="group.com.zachshotamartin.unfiled"
readonly EXPECTED_API_BASE_URL="https://unfiled-web.vercel.app/api/v1"
readonly EXPECTED_URL_SCHEME="unfiled"

usage() {
  printf 'Usage: %s {archive-preflight|inspect-unsigned|inspect-signed} [archive-path]\n' \
    "${0##*/}" >&2
}

fail() {
  printf 'Native release evidence failed: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_file() {
  [[ -f "$1" ]] || fail "required file is missing: $1"
}

require_directory() {
  [[ -d "$1" ]] || fail "required directory is missing: $1"
}

require_equal() {
  local actual="$1"
  local expected="$2"
  local label="$3"

  [[ "${actual}" == "${expected}" ]] ||
    fail "${label}: expected '${expected}', found '${actual}'"
}

plist_raw() {
  local file="$1"
  local key="$2"

  plutil -extract "${key}" raw -o - "${file}" 2>/dev/null ||
    fail "missing or invalid plist key '${key}' in ${file}"
}

plist_json() {
  local file="$1"
  local key="$2"

  plutil -extract "${key}" json -o - "${file}" 2>/dev/null ||
    fail "missing or invalid plist key '${key}' in ${file}"
}

archive_paths() {
  local archive_path="$1"

  require_directory "${archive_path}"
  require_file "${archive_path}/Info.plist"

  local applications_directory="${archive_path}/Products/Applications"
  require_directory "${applications_directory}"

  local app_count
  app_count="$(find "${applications_directory}" -mindepth 1 -maxdepth 1 -type d -name '*.app' | wc -l | tr -d ' ')"
  require_equal "${app_count}" '1' 'application count'

  readonly ARCHIVE_APP="${applications_directory}/Unfiled.app"
  readonly ARCHIVE_WIDGET="${ARCHIVE_APP}/PlugIns/QuickCaptureWidget.appex"
  require_directory "${ARCHIVE_APP}"
  require_directory "${ARCHIVE_WIDGET}"

  local extension_count
  extension_count="$(find "${ARCHIVE_APP}/PlugIns" -mindepth 1 -maxdepth 1 -type d -name '*.appex' | wc -l | tr -d ' ')"
  require_equal "${extension_count}" '1' 'embedded extension count'
}

inspect_common_payload() {
  local archive_path="$1"
  archive_paths "${archive_path}"

  local app_plist="${ARCHIVE_APP}/Info.plist"
  local widget_plist="${ARCHIVE_WIDGET}/Info.plist"
  require_file "${app_plist}"
  require_file "${widget_plist}"
  require_file "${ARCHIVE_APP}/Assets.car"
  require_file "${ARCHIVE_APP}/AppIcon60x60@2x.png"
  require_file "${ARCHIVE_APP}/PrivacyInfo.xcprivacy"
  require_file "${ARCHIVE_WIDGET}/PrivacyInfo.xcprivacy"
  require_directory "${ARCHIVE_WIDGET}/Metadata.appintents"
  require_file "${ARCHIVE_APP}/Frameworks/SQLCipher.framework/SQLCipher"
  require_file "${archive_path}/dSYMs/Unfiled.app.dSYM/Contents/Resources/DWARF/Unfiled"
  require_file \
    "${archive_path}/dSYMs/QuickCaptureWidget.appex.dSYM/Contents/Resources/DWARF/QuickCaptureWidget"
  require_file \
    "${archive_path}/dSYMs/SQLCipher.framework.dSYM/Contents/Resources/DWARF/SQLCipher"

  plutil -lint "${app_plist}" "${widget_plist}" \
    "${ARCHIVE_APP}/PrivacyInfo.xcprivacy" \
    "${ARCHIVE_WIDGET}/PrivacyInfo.xcprivacy" >/dev/null

  local app_privacy_manifest="${ARCHIVE_APP}/PrivacyInfo.xcprivacy"
  local widget_privacy_manifest="${ARCHIVE_WIDGET}/PrivacyInfo.xcprivacy"
  require_equal \
    "$(plist_raw "${app_privacy_manifest}" NSPrivacyCollectedDataTypes)" \
    '4' \
    'application privacy-manifest collected-data count'
  require_equal \
    "$(plist_raw "${widget_privacy_manifest}" NSPrivacyCollectedDataTypes)" \
    '0' \
    'widget privacy-manifest collected-data count'

  local expected_collected_data_types=(
    'NSPrivacyCollectedDataTypeEmailAddress'
    'NSPrivacyCollectedDataTypeUserID'
    'NSPrivacyCollectedDataTypeDeviceID'
    'NSPrivacyCollectedDataTypeOtherUserContent'
  )
  local privacy_index
  for privacy_index in "${!expected_collected_data_types[@]}"; do
    require_equal \
      "$(plist_raw \
        "${app_privacy_manifest}" \
        "NSPrivacyCollectedDataTypes.${privacy_index}.NSPrivacyCollectedDataType")" \
      "${expected_collected_data_types[${privacy_index}]}" \
      "application privacy-manifest data type ${privacy_index}"
    require_equal \
      "$(plist_raw \
        "${app_privacy_manifest}" \
        "NSPrivacyCollectedDataTypes.${privacy_index}.NSPrivacyCollectedDataTypeLinked")" \
      'true' \
      "application privacy-manifest linked flag ${privacy_index}"
    require_equal \
      "$(plist_raw \
        "${app_privacy_manifest}" \
        "NSPrivacyCollectedDataTypes.${privacy_index}.NSPrivacyCollectedDataTypeTracking")" \
      'false' \
      "application privacy-manifest tracking flag ${privacy_index}"
  done

  require_equal \
    "$(plist_raw "${app_plist}" CFBundleIdentifier)" \
    "${EXPECTED_APP_BUNDLE_ID}" \
    'application bundle identifier'
  require_equal \
    "$(plist_raw "${widget_plist}" CFBundleIdentifier)" \
    "${EXPECTED_WIDGET_BUNDLE_ID}" \
    'widget bundle identifier'
  require_equal \
    "$(plist_raw "${widget_plist}" NSExtension.NSExtensionPointIdentifier)" \
    'com.apple.widgetkit-extension' \
    'widget extension point'
  require_equal \
    "$(plist_raw "${app_plist}" UnfiledAppGroupIdentifier)" \
    "${EXPECTED_APP_GROUP}" \
    'application App Group configuration'
  require_equal \
    "$(plist_raw "${widget_plist}" UnfiledAppGroupIdentifier)" \
    "${EXPECTED_APP_GROUP}" \
    'widget App Group configuration'
  require_equal \
    "$(plist_raw "${app_plist}" UnfiledAPIBaseURL)" \
    "${EXPECTED_API_BASE_URL}" \
    'Production API origin'
  require_equal \
    "$(plist_json "${app_plist}" CFBundleURLTypes.0.CFBundleURLSchemes)" \
    "[\"${EXPECTED_URL_SCHEME}\"]" \
    'Production URL scheme'
  require_equal "$(plist_json "${app_plist}" UIDeviceFamily)" '[1]' 'iPhone-only app family'
  require_equal "$(plist_json "${widget_plist}" UIDeviceFamily)" '[1]' 'iPhone-only widget family'
  require_equal "$(plist_raw "${app_plist}" MinimumOSVersion)" '17.0' 'minimum iOS version'
  require_equal \
    "$(plist_raw "${app_plist}" ITSAppUsesNonExemptEncryption)" \
    'false' \
    'export-compliance declaration'

  local marketing_version
  local build_version
  marketing_version="$(plist_raw "${app_plist}" CFBundleShortVersionString)"
  build_version="$(plist_raw "${app_plist}" CFBundleVersion)"
  [[ "${marketing_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail "marketing version is not semantic: ${marketing_version}"
  [[ "${build_version}" =~ ^[1-9][0-9]*$ ]] ||
    fail "build version must be a positive integer: ${build_version}"

  require_equal "$(lipo -archs "${ARCHIVE_APP}/Unfiled")" 'arm64' 'application architecture'
  require_equal \
    "$(lipo -archs "${ARCHIVE_WIDGET}/QuickCaptureWidget")" \
    'arm64' \
    'widget architecture'

  printf 'Archive payload verified: Production app %s (%s), iPhone-only, one widget.\n' \
    "${marketing_version}" "${build_version}"
}

extract_entitlements() {
  local executable="$1"
  local output="$2"

  codesign -d --entitlements :- "${executable}" >"${output}" 2>/dev/null ||
    fail "could not extract signed entitlements from ${executable}"
  plutil -lint "${output}" >/dev/null || fail "invalid signed entitlements: ${executable}"
}

verify_signed_target() {
  local target_path="$1"
  local expected_bundle_id="$2"
  local entitlements_path="$3"
  local profile_path="${target_path}/embedded.mobileprovision"

  codesign --verify --strict --verbose=2 "${target_path}" >/dev/null 2>&1 ||
    fail "code signature verification failed: ${target_path}"
  require_file "${profile_path}"
  extract_entitlements "${target_path}" "${entitlements_path}"

  local team_identifier
  team_identifier="$(plist_raw "${entitlements_path}" com.apple.developer.team-identifier)"
  [[ -n "${team_identifier}" ]] || fail "empty Apple team identifier: ${target_path}"
  require_equal \
    "$(plist_raw "${entitlements_path}" application-identifier)" \
    "${team_identifier}.${expected_bundle_id}" \
    'signed application identifier'
  require_equal \
    "$(plist_json "${entitlements_path}" com.apple.security.application-groups)" \
    "[\"${EXPECTED_APP_GROUP}\"]" \
    'signed App Group entitlement'

  local profile_application_identifier
  local profile_app_groups
  profile_application_identifier="$({
    security cms -D -i "${profile_path}" 2>/dev/null |
      plutil -extract Entitlements.application-identifier raw -o - - 2>/dev/null
  })" || fail "could not read the provisioning-profile application identifier: ${target_path}"
  profile_app_groups="$({
    security cms -D -i "${profile_path}" 2>/dev/null |
      plutil -extract Entitlements.com.apple.security.application-groups json -o - - 2>/dev/null
  })" || fail "could not read the provisioning-profile App Group: ${target_path}"
  require_equal \
    "${profile_application_identifier}" \
    "${team_identifier}.${expected_bundle_id}" \
    'profile application identifier'
  require_equal \
    "${profile_app_groups}" \
    "[\"${EXPECTED_APP_GROUP}\"]" \
    'profile App Group entitlement'
}

inspect_unsigned() {
  local archive_path="$1"
  inspect_common_payload "${archive_path}"

  require_equal \
    "$(plist_raw "${archive_path}/Info.plist" ApplicationProperties.SigningIdentity)" \
    '' \
    'unsigned preflight signing identity'
  require_equal \
    "$(plist_raw "${archive_path}/Info.plist" ApplicationProperties.Team)" \
    '' \
    'unsigned preflight team'
  [[ ! -f "${ARCHIVE_APP}/embedded.mobileprovision" ]] ||
    fail 'unsigned preflight unexpectedly contains an application provisioning profile'
  [[ ! -f "${ARCHIVE_WIDGET}/embedded.mobileprovision" ]] ||
    fail 'unsigned preflight unexpectedly contains a widget provisioning profile'

  printf 'Unsigned archive boundary verified; this is packaging evidence, not signing evidence.\n'
}

inspect_signed() {
  local archive_path="$1"
  inspect_common_payload "${archive_path}"

  require_command codesign
  require_command security
  local evidence_directory
  evidence_directory="$(mktemp -d /tmp/unfiled-ios-signed-evidence.XXXXXX)"

  verify_signed_target \
    "${ARCHIVE_APP}" \
    "${EXPECTED_APP_BUNDLE_ID}" \
    "${evidence_directory}/app-entitlements.plist"
  verify_signed_target \
    "${ARCHIVE_WIDGET}" \
    "${EXPECTED_WIDGET_BUNDLE_ID}" \
    "${evidence_directory}/widget-entitlements.plist"
  codesign --verify --deep --strict --verbose=2 "${ARCHIVE_APP}" >/dev/null 2>&1 ||
    fail 'deep signature verification failed for the archived application'

  local app_team
  local widget_team
  app_team="$(plist_raw "${evidence_directory}/app-entitlements.plist" com.apple.developer.team-identifier)"
  widget_team="$(plist_raw "${evidence_directory}/widget-entitlements.plist" com.apple.developer.team-identifier)"
  require_equal "${widget_team}" "${app_team}" 'application and widget signing team'
  require_equal \
    "$(plist_json "${evidence_directory}/app-entitlements.plist" keychain-access-groups)" \
    "[\"${app_team}.${EXPECTED_APP_BUNDLE_ID}\"]" \
    'application Keychain access group'

  printf 'Signed archive verified: exact identifiers, matching team/App Group, profiles, and signatures.\n'
  printf 'Entitlement evidence was written to %s (contains no private key material).\n' \
    "${evidence_directory}"
}

archive_preflight() {
  require_command xcodebuild
  require_file "${XCODE_PROJECT}/project.pbxproj"

  local build_root
  build_root="$(mktemp -d /tmp/unfiled-ios-release-preflight.XXXXXX)"
  local archive_path="${build_root}/Unfiled.xcarchive"
  local archive_log="${build_root}/archive.log"
  local package_cache="${UNFILED_IOS_PACKAGE_CACHE_PATH:-${TMPDIR:-/tmp}/unfiled-ios-${UID}-${REPOSITORY_ROOT##*/}/source-packages}"

  if ! xcodebuild \
    -project "${XCODE_PROJECT}" \
    -scheme "${XCODE_SCHEME}" \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "${archive_path}" \
    -derivedDataPath "${build_root}/DerivedData" \
    -clonedSourcePackagesDirPath "${package_cache}" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY= \
    archive >"${archive_log}" 2>&1; then
    tail -n 80 "${archive_log}" >&2
    fail 'unsigned Release archive failed'
  fi

  inspect_unsigned "${archive_path}"
  printf 'Unsigned Release archive: %s\n' "${archive_path}"
  printf 'Build log: %s\n' "${archive_log}"
}

main() {
  require_command plutil
  require_command find
  require_command lipo

  local operation="${1:-}"
  case "${operation}" in
    archive-preflight)
      [[ "$#" == '1' ]] || { usage; exit 64; }
      archive_preflight
      ;;
    inspect-unsigned)
      [[ "$#" == '2' ]] || { usage; exit 64; }
      inspect_unsigned "$2"
      ;;
    inspect-signed)
      [[ "$#" == '2' ]] || { usage; exit 64; }
      inspect_signed "$2"
      ;;
    *)
      usage
      exit 64
      ;;
  esac
}

main "$@"
