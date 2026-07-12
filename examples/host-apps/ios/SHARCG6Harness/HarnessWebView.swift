import Darwin
import SwiftUI
import WebKit

struct HarnessWebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(context.coordinator, name: "sharcHarness")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "sharcHarness" else { return }
            emit(message.body)

            if let dict = message.body as? [String: Any],
               let type = dict["type"] as? String,
               type == "summary" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    exit(0)
                }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            emitFailure("navigation-failed", error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            emitFailure("provisional-navigation-failed", error)
        }

        private func emitFailure(_ kind: String, _ error: Error) {
            emit([
                "type": "summary",
                "status": "failed",
                "reason": "\(kind): \(error.localizedDescription)"
            ])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                exit(1)
            }
        }

        private func emit(_ value: Any) {
            guard JSONSerialization.isValidJSONObject(value),
                  let data = try? JSONSerialization.data(withJSONObject: value, options: []),
                  let line = String(data: data, encoding: .utf8) else {
                return
            }
            FileHandle.standardOutput.write(Data((line + "\n").utf8))
        }
    }
}
