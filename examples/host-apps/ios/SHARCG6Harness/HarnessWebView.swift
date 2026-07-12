import Darwin
import SwiftUI
import UIKit
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
        context.coordinator.attach(webView)
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        private weak var webView: WKWebView?
        private var observers: [NSObjectProtocol] = []

        func attach(_ webView: WKWebView) {
            self.webView = webView
            installLifecycleObservers()
        }

        deinit {
            for observer in observers {
                NotificationCenter.default.removeObserver(observer)
            }
        }

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

        private func installLifecycleObservers() {
            guard observers.isEmpty else { return }
            let center = NotificationCenter.default
            observers.append(center.addObserver(
                forName: UIApplication.willResignActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.pushHostLifecycle("passive")
            })
            observers.append(center.addObserver(
                forName: UIApplication.didEnterBackgroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.pushHostLifecycle("hidden")
                self?.pushHostExposure(0)
                self?.pushHostLifecycle("frozen")
            })
            observers.append(center.addObserver(
                forName: UIApplication.willEnterForegroundNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.pushHostLifecycle("passive")
            })
            observers.append(center.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.pushHostLifecycle("active")
                self?.pushHostExposure(100)
                for delay in [0.25, 0.75, 1.25] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
                        self?.pushHostLifecycle("active")
                        self?.pushHostExposure(100)
                    }
                }
            })
        }

        private func pushHostLifecycle(_ state: String) {
            evaluateHarnessJavaScript("__sharcHarnessSetHostLifecycle", argument: jsonString(state))
        }

        private func pushHostExposure(_ percent: Int) {
            evaluateHarnessJavaScript("__sharcHarnessSetHostExposure", argument: "\(percent)")
        }

        private func evaluateHarnessJavaScript(_ functionName: String, argument: String) {
            let source = """
            (function () {
              if (typeof window.\(functionName) !== 'function') return;
              try { window.\(functionName)(\(argument)); } catch (e) {}
            })();
            """
            webView?.evaluateJavaScript(source, completionHandler: nil)
        }

        private func jsonString(_ value: String) -> String {
            guard let data = try? JSONSerialization.data(withJSONObject: [value], options: []),
                  let text = String(data: data, encoding: .utf8),
                  text.count >= 2 else {
                return "\"\""
            }
            return String(text.dropFirst().dropLast())
        }
    }
}
