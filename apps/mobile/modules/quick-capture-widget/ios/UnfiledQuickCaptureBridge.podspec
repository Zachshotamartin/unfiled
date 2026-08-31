require "json"

package = JSON.parse(File.read(File.join(__dir__, "..", "package.json")))

Pod::Spec.new do |spec|
  # Keep the native bridge's Swift module distinct from the WidgetKit
  # extension target. Sharing `QuickCaptureWidget` makes Swift resolve the
  # extension module when Expo's generated provider imports this pod.
  spec.name = "UnfiledQuickCaptureBridge"
  spec.version = package["version"]
  spec.summary = "Narrow App Group bridge for the Unfiled quick-capture widget"
  spec.description = "Writes only a pending count and requests WidgetKit timeline reloads."
  spec.license = { :type => "UNLICENSED" }
  spec.author = "Unfiled"
  spec.homepage = "https://example.invalid/unfiled"
  spec.platforms = { :ios => "17.0" }
  spec.source = { :path => "." }
  spec.static_framework = true
  spec.swift_version = "5.9"
  spec.source_files = "**/*.{h,m,mm,swift}"
  spec.frameworks = "WidgetKit"
  spec.dependency "ExpoModulesCore"
end
