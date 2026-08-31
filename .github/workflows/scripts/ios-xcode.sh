#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIRECTORY
REPOSITORY_ROOT="$(cd "${SCRIPT_DIRECTORY}/../../.." && pwd)"
readonly REPOSITORY_ROOT
readonly IOS_DIRECTORY="${REPOSITORY_ROOT}/apps/ios"
readonly PROJECT_MANIFEST="${IOS_DIRECTORY}/project.yml"
readonly XCODE_PROJECT="${IOS_DIRECTORY}/Unfiled.xcodeproj"
readonly XCODE_SCHEME="Unfiled Development"
readonly REQUIRED_XCODEGEN_VERSION="2.46.0"
readonly IOS_BUILD_ROOT="${UNFILED_IOS_BUILD_ROOT:-${TMPDIR:-/tmp}/unfiled-ios-${UID}-${REPOSITORY_ROOT##*/}}"
readonly DERIVED_DATA_PATH="${UNFILED_IOS_DERIVED_DATA_PATH:-${IOS_BUILD_ROOT}/derived-data}"
readonly PACKAGE_CACHE_PATH="${UNFILED_IOS_PACKAGE_CACHE_PATH:-${IOS_BUILD_ROOT}/source-packages}"

usage() {
  printf 'Usage: %s {generate|inspect|resolve|build|test|ci}\n' "${0##*/}" >&2
}

require_command() {
  local command_name="$1"

  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "${command_name}" >&2
    exit 1
  fi
}

require_manifest() {
  if [[ ! -f "${PROJECT_MANIFEST}" ]]; then
    printf 'XcodeGen manifest is missing: %s\n' "${PROJECT_MANIFEST}" >&2
    exit 1
  fi
}

require_xcodegen_version() {
  local actual_version
  actual_version="$(xcodegen --version)"

  if [[ "${actual_version}" != "Version: ${REQUIRED_XCODEGEN_VERSION}" ]]; then
    printf 'XcodeGen %s is required for deterministic project output; found: %s\n' \
      "${REQUIRED_XCODEGEN_VERSION}" "${actual_version}" >&2
    exit 1
  fi
}

require_project() {
  if [[ ! -f "${XCODE_PROJECT}/project.pbxproj" ]]; then
    printf 'Generated Xcode project is missing; run the generate command first: %s\n' \
      "${XCODE_PROJECT}" >&2
    exit 1
  fi
}

require_text() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if ! grep -Fq -- "${expected}" "${file}"; then
    printf 'Generated project inspection failed (%s): %s\n' "${label}" "${file}" >&2
    exit 1
  fi
}

require_text_count() {
  local file="$1"
  local expected="$2"
  local required_count="$3"
  local label="$4"
  local actual_count
  actual_count="$(grep -Fc -- "${expected}" "${file}" || true)"

  if [[ "${actual_count}" != "${required_count}" ]]; then
    printf 'Generated project inspection failed (%s): expected %s, found %s\n' \
      "${label}" "${required_count}" "${actual_count}" >&2
    exit 1
  fi
}

generate_project() {
  require_command xcodegen
  require_xcodegen_version
  require_manifest

  xcodegen generate --spec "${PROJECT_MANIFEST}" --project "${IOS_DIRECTORY}"

  if [[ ! -f "${XCODE_PROJECT}/project.pbxproj" ]]; then
    printf 'XcodeGen did not create the expected project: %s\n' "${XCODE_PROJECT}" >&2
    exit 1
  fi
}

inspect_project() {
  require_project

  local project_file="${XCODE_PROJECT}/project.pbxproj"
  require_text "${project_file}" 'productType = "com.apple.product-type.application";' \
    'application target'
  require_text "${project_file}" 'productType = "com.apple.product-type.app-extension";' \
    'WidgetKit extension target'
  require_text "${project_file}" 'productType = "com.apple.product-type.bundle.unit-test";' \
    'unit-test target'
  require_text_count \
    "${project_file}" \
    'isa = PBXResourcesBuildPhase;' \
    '2' \
    'application and widget resource phases'
  require_text "${project_file}" 'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;' \
    'application icon catalog'
  require_text "${project_file}" 'PrivacyInfo.xcprivacy in Resources' \
    'packaged privacy manifests'
  require_text_count \
    "${project_file}" \
    'QuickCaptureWidget.appex in Embed Foundation Extensions */ = {isa = PBXBuildFile;' \
    '1' \
    'single embedded widget product'
  require_text "${project_file}" 'IPHONEOS_DEPLOYMENT_TARGET = 17.0;' \
    'iOS 17 deployment floor'
  require_text "${project_file}" \
    "PRODUCT_BUNDLE_IDENTIFIER = \"\$(UNFILED_APP_BUNDLE_IDENTIFIER).quickcapture\";" \
    'derived widget bundle identifier'
  require_text "${project_file}" \
    'repositoryURL = "https://github.com/sqlcipher/GRDB.swift";' \
    'SQLCipher GRDB package source'
  require_text "${project_file}" 'productName = GRDB;' 'GRDB target linkage'
  require_text "${project_file}" 'Development.xcconfig' 'Development configuration'
  require_text "${project_file}" 'Preview.xcconfig' 'Preview configuration'
  require_text "${project_file}" 'Production.xcconfig' 'Production configuration'
  require_text "${IOS_DIRECTORY}/Unfiled/Supporting/Unfiled.entitlements" \
    "\$(UNFILED_APP_GROUP_IDENTIFIER)" 'application App Group'
  require_text \
    "${IOS_DIRECTORY}/QuickCaptureWidget/Supporting/QuickCaptureWidget.entitlements" \
    "\$(UNFILED_APP_GROUP_IDENTIFIER)" 'widget App Group'
  require_text "${IOS_DIRECTORY}/QuickCaptureWidget/Supporting/Info.plist" \
    'com.apple.widgetkit-extension' 'WidgetKit extension point'
  require_text "${IOS_DIRECTORY}/QuickCaptureWidget/QuickCaptureWidget.swift" \
    'Button(intent: OpenQuickCaptureIntent())' 'App Intent action'
  require_text "${IOS_DIRECTORY}/QuickCaptureWidget/QuickCaptureWidget.swift" \
    '.accessoryCircular' 'circular Lock Screen family'
  require_text "${IOS_DIRECTORY}/QuickCaptureWidget/QuickCaptureWidget.swift" \
    '.accessoryRectangular' 'rectangular Lock Screen family'

  printf 'Generated iOS targets, identifiers, entitlements, package, and widget surface verified.\n'
}

resolve_packages() {
  require_command xcodebuild
  require_project

  xcodebuild \
    -resolvePackageDependencies \
    -project "${XCODE_PROJECT}" \
    -scheme "${XCODE_SCHEME}" \
    -clonedSourcePackagesDirPath "${PACKAGE_CACHE_PATH}"
}

build_for_simulator() {
  require_command xcodebuild
  require_project

  xcodebuild \
    -project "${XCODE_PROJECT}" \
    -scheme "${XCODE_SCHEME}" \
    -configuration Debug \
    -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    -clonedSourcePackagesDirPath "${PACKAGE_CACHE_PATH}" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY= \
    build
}

test_destination() {
  if [[ -n "${UNFILED_IOS_TEST_DESTINATION:-}" ]]; then
    printf '%s\n' "${UNFILED_IOS_TEST_DESTINATION}"
    return
  fi

  require_command xcrun

  local simulator_identifier
  simulator_identifier="$(
    xcrun simctl list devices available |
      awk -F '[()]' '/^[[:space:]]+iPhone/ && !found { print $2; found = 1 }'
  )"

  if [[ -z "${simulator_identifier}" ]]; then
    printf '%s\n' \
      'No available iPhone simulator was found. Set UNFILED_IOS_TEST_DESTINATION explicitly.' >&2
    exit 1
  fi

  printf 'platform=iOS Simulator,id=%s\n' "${simulator_identifier}"
}

test_in_simulator() {
  require_command xcodebuild
  require_project

  local destination
  destination="$(test_destination)"

  xcodebuild \
    -project "${XCODE_PROJECT}" \
    -scheme "${XCODE_SCHEME}" \
    -configuration Debug \
    -sdk iphonesimulator \
    -destination "${destination}" \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    -clonedSourcePackagesDirPath "${PACKAGE_CACHE_PATH}" \
    -parallel-testing-enabled NO \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY= \
    test
}

main() {
  local operation="${1:-}"

  case "${operation}" in
    generate)
      generate_project
      ;;
    inspect)
      inspect_project
      ;;
    resolve)
      resolve_packages
      ;;
    build)
      build_for_simulator
      ;;
    test)
      test_in_simulator
      ;;
    ci)
      generate_project
      inspect_project
      resolve_packages
      build_for_simulator
      test_in_simulator
      ;;
    *)
      usage
      exit 64
      ;;
  esac
}

main "$@"
