import SwiftUI

@main
@MainActor
struct UnfiledApp: App {
    @StateObject private var model = AppModel()

    init() {
        let navigation = UINavigationBarAppearance()
        navigation.configureWithOpaqueBackground()
        navigation.backgroundColor = UIColor(red: 243 / 255, green: 244 / 255, blue: 246 / 255, alpha: 1)
        navigation.titleTextAttributes = [.foregroundColor: UIColor(red: 20 / 255, green: 23 / 255, blue: 27 / 255, alpha: 1)]
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
