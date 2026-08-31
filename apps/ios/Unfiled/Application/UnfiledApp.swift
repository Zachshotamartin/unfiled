import SwiftUI

@main
@MainActor
struct UnfiledApp: App {
    @StateObject private var model = AppModel()

    init() {
        let navigation = UINavigationBarAppearance()
        navigation.configureWithOpaqueBackground()
        navigation.backgroundColor = UIColor(red: 11 / 255, green: 12 / 255, blue: 14 / 255, alpha: 1)
        navigation.titleTextAttributes = [.foregroundColor: UIColor(red: 242 / 255, green: 239 / 255, blue: 232 / 255, alpha: 1)]
        navigation.largeTitleTextAttributes = navigation.titleTextAttributes
        UINavigationBar.appearance().standardAppearance = navigation
        UINavigationBar.appearance().scrollEdgeAppearance = navigation
        UINavigationBar.appearance().compactAppearance = navigation
    }

    var body: some Scene {
        WindowGroup {
            AppRootView(model: model)
                .task { await model.bootstrap() }
        }
    }
}
