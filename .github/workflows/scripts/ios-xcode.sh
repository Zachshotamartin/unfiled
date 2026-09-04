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
# The iPhone the tests run on, named rather than "whichever iPhone this image happens to list
# first": a refreshed runner image must change a value in this file, not the device under test.
# It is the same model the live phone gate pins (scripts/operations/live-gate/run.sh).
readonly DEFAULT_TEST_SIMULATOR="iPhone 17 Pro"
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

require_text_absent() {
  local file="$1"
  local forbidden="$2"
  local label="$3"

  if grep -Fq -- "${forbidden}" "${file}"; then
    printf 'Generated project inspection failed (%s): forbidden value found in %s\n' \
      "${label}" "${file}" >&2
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
  require_text "${project_file}" 'productType = "com.apple.product-type.bundle.unit-test";' \
    'unit-test target'
  require_text_count \
    "${project_file}" \
    'isa = PBXResourcesBuildPhase;' \
    '1' \
    'application resource phase'
  require_text "${project_file}" 'ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon;' \
    'application icon catalog'
  require_text "${project_file}" 'PrivacyInfo.xcprivacy in Resources' \
    'packaged privacy manifests'
  require_text_absent \
    "${project_file}" \
    'com.apple.product-type.app-extension' \
    'no app extension is embedded'
  require_text "${project_file}" 'IPHONEOS_DEPLOYMENT_TARGET = 17.0;' \
    'iOS 17 deployment floor'
  require_text_count \
    "${project_file}" \
    'TARGETED_DEVICE_FAMILY = 1;' \
    '9' \
    'all project and target configurations are iPhone-only'
  require_text_absent \
    "${project_file}" \
    'TARGETED_DEVICE_FAMILY = "1,2";' \
    'no target configuration silently re-enables iPad'
  require_text "${project_file}" \
    'repositoryURL = "https://github.com/sqlcipher/GRDB.swift";' \
    'SQLCipher GRDB package source'
  require_text "${project_file}" 'productName = GRDB;' 'GRDB target linkage'
  require_text "${project_file}" 'Development.xcconfig' 'Development configuration'
  require_text "${project_file}" 'Preview.xcconfig' 'Preview configuration'
  require_text "${project_file}" 'Production.xcconfig' 'Production configuration'
  require_text_absent "${IOS_DIRECTORY}/Unfiled/Supporting/Unfiled.entitlements" \
    'application-groups' 'no App Group entitlement remains'

  printf 'Generated iOS targets, identifiers, entitlements, and package verified.\n'
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

simulator_identifier_for() {
  local simulator_name="$1"

  xcrun simctl list devices available |
    sed -n "s/^[[:space:]]*${simulator_name} (\([0-9A-F-]\{36\}\)) (.*/\1/p" |
    head -n 1
}

simulator_runtime_for() {
  local simulator_identifier="$1"

  # simctl groups devices under a `-- iOS 26.0 --` heading, and the heading above a device is the
  # runtime it boots. Naming it means a refreshed runner image changes a value this script prints
  # rather than changing what the tests ran against without saying so.
  xcrun simctl list devices available |
    sed -n "1,/${simulator_identifier}/p" |
    grep -E '^-- .* --$' |
    tail -n 1 |
    sed -E 's/^-- (.*) --$/\1/'
}

test_destination() {
  if [[ -n "${UNFILED_IOS_TEST_DESTINATION:-}" ]]; then
    printf '%s\n' "${UNFILED_IOS_TEST_DESTINATION}"
    return
  fi

  require_command xcrun

  local simulator_name="${UNFILED_IOS_TEST_SIMULATOR:-${DEFAULT_TEST_SIMULATOR}}"
  local simulator_identifier
  simulator_identifier="$(simulator_identifier_for "${simulator_name}")"

  if [[ -z "${simulator_identifier}" ]]; then
    printf 'The pinned iPhone simulator is unavailable: %s\n' "${simulator_name}" >&2
    printf 'Available simulators:\n' >&2
    xcrun simctl list devices available >&2
    printf '%s\n' \
      'Set UNFILED_IOS_TEST_SIMULATOR to one of the above, or UNFILED_IOS_TEST_DESTINATION to a full xcodebuild destination.' >&2
    exit 1
  fi

  printf 'iOS tests will run on %s (%s), runtime %s.\n' \
    "${simulator_name}" "${simulator_identifier}" \
    "$(simulator_runtime_for "${simulator_identifier}")" >&2

  printf 'platform=iOS Simulator,id=%s\n' "${simulator_identifier}"
}

# How long the simulator gets to finish booting before the lane gives up on it.
readonly SIMULATOR_BOOT_TIMEOUT_SECONDS="${UNFILED_IOS_BOOT_TIMEOUT_SECONDS:-240}"
# How long the test run gets. A hung CoreSimulator does not fail xcodebuild, it just stops
# answering, so without this the lane sits in silence until the job's own 40-minute timeout kills
# it with no evidence of where it stopped.
readonly TEST_TIMEOUT_SECONDS="${UNFILED_IOS_TEST_TIMEOUT_SECONDS:-1500}"

# Boots the destination device and waits for the boot to finish, so a wedged CoreSimulator is a
# fast, named failure instead of an xcodebuild that waits forever. xcodebuild boots the device
# itself otherwise, and gives no sign it is doing so: the last line of a hung run is the app
# target's own "Touch ... Unfiled.app", which reads as a build that stopped rather than a
# simulator that never came up.
boot_simulator() {
  local udid="$1"

  printf 'Booting the destination simulator (%s), up to %ss.\n' "${udid}" \
    "${SIMULATOR_BOOT_TIMEOUT_SECONDS}" >&2
  if ! run_with_deadline "${SIMULATOR_BOOT_TIMEOUT_SECONDS}" \
    xcrun simctl bootstatus "${udid}" -b; then
    printf 'The simulator never finished booting. CoreSimulator state:\n' >&2
    xcrun simctl list devices >&2 || true
    return 1
  fi
}

# Runs a command with a deadline. macOS ships no coreutils `timeout`, so this is the portable
# equivalent: the child runs in the background and is killed if it outlives the deadline.
# How often the wait prints a line saying it is still alive and what the device is doing.
readonly HEARTBEAT_SECONDS="${UNFILED_IOS_HEARTBEAT_SECONDS:-30}"
# The device the heartbeat reports on, when this script chose one.
HEARTBEAT_UDID=""

# What the destination device is doing right now, as CoreSimulator sees it: Booted, Booting,
# Shutdown, or unknown. This is the difference between "the tests are running" and "the device
# never came up", which is invisible from xcodebuild's own output.
simulator_state() {
  [[ -n "${HEARTBEAT_UDID}" ]] || return 0

  local state
  state="$(xcrun simctl list devices 2>/dev/null |
    grep -F "${HEARTBEAT_UDID}" |
    sed -E 's/.*\(([A-Za-z ]+)\)[^(]*$/\1/' |
    head -n 1)"
  printf '%s' "${state:-unknown}"
}

# Runs a command with a deadline, printing a line every HEARTBEAT_SECONDS so a long step is
# visibly alive. xcodebuild goes silent from the app target's "Touch ... Unfiled.app" until the
# tests report, which covers the test-bundle compile, the device boot, the install and the run --
# minutes with no output at all, indistinguishable from a hang. The heartbeat names the elapsed
# time and the device state, so a reader can tell which of those is happening.
run_with_deadline() {
  local deadline="$1"
  shift

  "$@" &
  local child=$!
  local waited=0

  while kill -0 "${child}" 2>/dev/null; do
    if ((waited >= deadline)); then
      printf 'Timed out after %ss: %s\n' "${deadline}" "$*" >&2
      printf 'Booted devices at the timeout:\n' >&2
      xcrun simctl list devices booted >&2 || true
      printf 'Simulator and Xcode processes still running:\n' >&2
      pgrep -fl 'xcodebuild|CoreSimulator|simctl|testmanagerd' >&2 || true
      kill -TERM "${child}" 2>/dev/null || true
      sleep 5
      kill -KILL "${child}" 2>/dev/null || true
      wait "${child}" 2>/dev/null || true
      return 124
    fi
    sleep 5
    waited=$((waited + 5))
    if ((waited % HEARTBEAT_SECONDS == 0)); then
      if [[ -n "${HEARTBEAT_UDID}" ]]; then
        printf '  ... still running: %ss elapsed of %ss, simulator is %s\n' \
          "${waited}" "${deadline}" "$(simulator_state)" >&2
      else
        printf '  ... still running: %ss elapsed of %ss\n' "${waited}" "${deadline}" >&2
      fi
    fi
  done

  wait "${child}"
}

test_in_simulator() {
  require_command xcodebuild
  require_project

  local destination
  destination="$(test_destination)"

  # The destination names a device by id whenever this script chose it, so it can be booted first.
  # An explicit UNFILED_IOS_TEST_DESTINATION is used verbatim and left to xcodebuild.
  local udid="${destination#platform=iOS Simulator,id=}"
  if [[ "${udid}" != "${destination}" ]]; then
    HEARTBEAT_UDID="${udid}"
    boot_simulator "${udid}"
  fi

  # xcodebuild refuses to write a result bundle over one that already exists, which would turn a
  # second run on the same machine into an error about the bundle rather than a test result.
  rm -rf "${IOS_BUILD_ROOT}/test-results.xcresult"

  run_with_deadline "${TEST_TIMEOUT_SECONDS}" \
    xcodebuild \
    -project "${XCODE_PROJECT}" \
    -scheme "${XCODE_SCHEME}" \
    -configuration Debug \
    -sdk iphonesimulator \
    -destination "${destination}" \
    -derivedDataPath "${DERIVED_DATA_PATH}" \
    -clonedSourcePackagesDirPath "${PACKAGE_CACHE_PATH}" \
    -parallel-testing-enabled NO \
    -resultBundlePath "${IOS_BUILD_ROOT}/test-results.xcresult" \
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
      # No separate build step: `test` compiles the application and the test bundle for the
      # simulator it runs on, so building the same sources again for the generic destination cost
      # a second full compile and covered nothing the test build does not.
      generate_project
      inspect_project
      resolve_packages
      test_in_simulator
      ;;
    *)
      usage
      exit 64
      ;;
  esac
}

main "$@"
