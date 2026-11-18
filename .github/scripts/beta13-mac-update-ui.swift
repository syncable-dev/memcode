import Cocoa
import ApplicationServices
import Foundation

let args = CommandLine.arguments
let root = AXUIElementCreateApplication(pid_t(Int32(args[1])!))
func get(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}
func findButtons() -> [(AXUIElement, String, String)] {
    var queue: [(AXUIElement, Int)] = [(root, 0)]
    var result: [(AXUIElement, String, String)] = []
    var visited: Set<CFHashCode> = []
    while !queue.isEmpty && visited.count < 3000 {
        let (element, depth) = queue.removeLast()
        guard depth < 45, visited.insert(CFHash(element)).inserted else { continue }
        let role = get(element,"AXRole") as? String ?? ""
        let label = ["AXTitle","AXDescription","AXValue","AXHelp"].compactMap { get(element,$0) as? String }.joined(separator:" ")
        if !label.isEmpty { result.append((element,role,label)) }
        for child in (get(element,"AXChildren") as? [AXUIElement]) ?? [] { queue.append((child,depth+1)) }
    }
    return result
}
var settingsClicked = false
var checkClicked = false
var versionSeen = false
var readySeen = false
let trusted = AXIsProcessTrusted()
if trusted {
    _ = AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    let end = Date().addingTimeInterval(40)
    while Date() < end && !versionSeen {
        let elements=findButtons()
        for (element,role,label) in elements {
            let lower = label.lowercased()
            if settingsClicked && lower.contains("0.4.0-beta.13") { versionSeen = true }
            if settingsClicked && lower.contains("install and restart") { readySeen = true }
            if role == "AXButton" {
                if !settingsClicked && lower.contains("skip for now") { _ = AXUIElementPerformAction(element,kAXPressAction as CFString) }
                else if !settingsClicked && lower.hasPrefix("settings") {
                    settingsClicked = AXUIElementPerformAction(element,kAXPressAction as CFString) == .success
                }
                else if settingsClicked && !checkClicked && lower.contains("check for updates") {
                    checkClicked = AXUIElementPerformAction(element,kAXPressAction as CFString) == .success
                }
            }
        }
        Thread.sleep(forTimeInterval:0.5)
    }
}
let result: [String:Any] = ["accessibilityTrusted":trusted,"settingsClicked":settingsClicked,"checkForUpdatesClicked":checkClicked,"settingsShowsBeta13":versionSeen,"settingsShowsInstallAndRestart":readySeen]
try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted]).write(to:URL(fileURLWithPath:args[2]))
