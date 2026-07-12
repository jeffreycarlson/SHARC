import SwiftUI

@main
struct SHARCG6HarnessApp: App {
    var body: some Scene {
        WindowGroup {
            HarnessWebView(url: HarnessConfiguration.urlFromArguments())
        }
    }
}

enum HarnessConfiguration {
    static func urlFromArguments() -> URL {
        let args = ProcessInfo.processInfo.arguments
        if let index = args.firstIndex(of: "--harness-url"),
           args.indices.contains(index + 1),
           let url = URL(string: args[index + 1]) {
            return url
        }
        return URL(string: "http://localhost:18865/examples/host-apps/ios/harness/index.html?creativeOrigin=http://localhost:18867")!
    }
}
