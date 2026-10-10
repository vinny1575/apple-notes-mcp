import AppKit
import ApplicationServices

private struct Response: Error { let data: [String: Any] }
private func execute(_ input: String) throws {
  func reply(_ data: [String: Any]) throws -> Never { throw Response(data: data) }
  func refuse(_ reason: String) throws -> Never { try reply(["ok": false, "reason": reason]) }
  guard let data = input.data(using: .utf8),
    let p = try JSONSerialization.jsonObject(with: data) as? [String: Any],
    let id = p["id"] as? String, id.hasPrefix("x-coredata://"), let text = p["text"] as? String,
    let item = p["item"] as? String, let start = p["start"] as? Int, start >= 0,
    let title = p["title"] as? String
  else { try refuse("invalid_payload") }
  guard AXIsProcessTrusted() else {
    try reply([
      "ok": false, "reason": "accessibility",
      "error": "Grant Hermes Python under System Settings > Privacy & Security > Accessibility",
    ])
  }
  let fd = open(
    NSHomeDirectory() + "/.hermes/apple-notes-checklist.lock", O_CREAT | O_RDWR | O_NOFOLLOW,
    S_IRUSR | S_IWUSR)
  guard fd >= 0 else { try refuse("busy") }
  defer { close(fd) }
  guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { try refuse("busy") }
  let previous = NSWorkspace.shared.frontmostApplication
  defer { if let previous = previous { _ = previous.activate(options: []) } }
  guard
    id.range(of: "^x-coredata://[0-9A-Fa-f-]+/ICNote/p[0-9]+$", options: .regularExpression) != nil
  else { try refuse("invalid_payload") }
  var scriptError: NSDictionary?
  guard let script = NSAppleScript(source: "tell application \"Notes\" to show note id \"\(id)\"")
  else { try refuse("missing") }
  _ = script.executeAndReturnError(&scriptError)
  guard scriptError == nil else { try refuse("show_note_failed") }
  let deadline = ProcessInfo.processInfo.systemUptime + 4
  func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    AXUIElementSetMessagingTimeout(el, 0.15)
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
  }
  func editors(_ el: AXUIElement, _ depth: Int = 0) -> [AXUIElement] {
    guard depth < 12, ProcessInfo.processInfo.systemUptime < deadline else { return [] }
    let role = attr(el, kAXRoleAttribute) as? String ?? ""
    if role == "AXTextArea" { return [el] }
    if ["AXTable", "AXOutline"].contains(role) { return [] }
    return (attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? []).flatMap {
      editors($0, depth + 1)
    }
  }
  var notes: NSRunningApplication?
  repeat {
    notes = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Notes").first
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  } while notes == nil && ProcessInfo.processInfo.systemUptime < deadline
  guard let notes = notes else { try refuse("missing") }
  _ = notes.activate(options: [])
  let app = AXUIElementCreateApplication(notes.processIdentifier)
  func dismissAutoSortPrompt() {
    guard let focused = attr(app, kAXFocusedUIElementAttribute),
      let role = attr(focused as! AXUIElement, kAXRoleAttribute) as? String, role == "AXSheet"
    else { return }
    let sheet = focused as! AXUIElement
    let children = attr(sheet, kAXChildrenAttribute) as? [AXUIElement] ?? []
    let exactPrompt = children.contains {
      attr($0, kAXValueAttribute) as? String
        == "Would you like to enable automatic sorting of checked items?"
    }
    let buttons = children.filter {
      attr($0, kAXRoleAttribute) as? String == "AXButton"
        && attr($0, kAXTitleAttribute) as? String == "Not Now"
    }
    // Decline only this known sorting prompt. Never approve permissions or
    // other dialogs; sorting would move sibling items and violate preservation.
    if exactPrompt && buttons.count == 1 {
      _ = AXUIElementPerformAction(buttons[0], kAXPressAction as CFString)
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
  }
  dismissAutoSortPrompt()

  _ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  var editor: AXUIElement?
  var targetWindow: AXUIElement?
  repeat {
    var matches: [(AXUIElement, AXUIElement)] = []
    for window in attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
      for found in editors(window) {
        if let value = attr(found, kAXValueAttribute) as? String, value == text,
          value.components(separatedBy: "\n").first == title
        {
          matches.append((found, window))
        }
      }
    }
    if matches.count > 1 { try refuse("ambiguous") }
    if matches.count == 1 {
      editor = matches[0].0
      targetWindow = matches[0].1
    }
    if editor == nil { RunLoop.current.run(until: Date().addingTimeInterval(0.1)) }
  } while editor == nil && ProcessInfo.processInfo.systemUptime < deadline
  guard let editor = editor, let targetWindow = targetWindow else {
    try refuse("wrong_note_or_changed_text")
  }
  _ = AXUIElementSetAttributeValue(targetWindow, kAXMainAttribute as CFString, kCFBooleanTrue)
  _ = AXUIElementPerformAction(targetWindow, kAXRaiseAction as CFString)
  _ = notes.activate(options: [])
  _ = AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  RunLoop.current.run(until: Date().addingTimeInterval(0.2))
  let ns = text as NSString
  guard start < ns.length, ns.substring(from: start).components(separatedBy: "\n").first == item,
    start == 0 || ns.substring(with: NSRange(location: start - 1, length: 1)) == "\n"
  else { try refuse("ambiguous") }
  let saved = attr(editor, kAXSelectedTextRangeAttribute)
  defer {
    if let saved = saved {
      _ = AXUIElementSetAttributeValue(editor, kAXSelectedTextRangeAttribute as CFString, saved)
    }
  }
  let focusResult = AXUIElementSetAttributeValue(
    editor, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  guard focusResult == .success else { try refuse("editor_focus_lost") }
  _ = AXUIElementSetAttributeValue(app, kAXFocusedUIElementAttribute as CFString, editor)
  RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  guard let focusedEditor = attr(app, kAXFocusedUIElementAttribute), CFEqual(focusedEditor, editor)
  else { try refuse("editor_focus_lost") }
  var range = CFRange(location: start + min(1, (item as NSString).length), length: 0)
  guard let selection = AXValueCreate(.cfRange, &range),
    AXUIElementSetAttributeValue(editor, kAXSelectedTextRangeAttribute as CFString, selection)
      == .success,
    let actual = attr(editor, kAXSelectedTextRangeAttribute),
    CFGetTypeID(actual) == AXValueGetTypeID()
  else { try refuse("selection") }
  var read = CFRange(location: -1, length: -1)
  guard AXValueGetValue(actual as! AXValue, .cfRange, &read), read.location == range.location,
    read.length == 0,
    attr(editor, kAXValueAttribute) as? String == text
  else { try refuse("selection") }
  func focused() -> Bool {
    guard let focused = attr(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute) else {
      return false
    }
    var pid: pid_t = 0
    return AXUIElementGetPid(focused as! AXUIElement, &pid) == .success
      && pid == notes.processIdentifier
  }
  guard focused() else { try refuse("focus_lost") }
  if p["dryRun"] as? Bool == true { try reply(["ok": true, "dryRun": true]) }
  // Only the Notes Mark Checked shortcut. Never character input, select-all,
  // clipboard operations, or AXPress on menu-bar items (which can block Notes).
  guard let source = CGEventSource(stateID: .hidSystemState),
    let down = CGEvent(keyboardEventSource: source, virtualKey: 32, keyDown: true),
    let up = CGEvent(keyboardEventSource: source, virtualKey: 32, keyDown: false)
  else { try refuse("event") }
  down.flags = [.maskShift, .maskCommand]
  up.flags = [.maskShift, .maskCommand]
  guard focused() else { try refuse("focus_lost") }
  down.postToPid(notes.processIdentifier)
  up.postToPid(notes.processIdentifier)
  RunLoop.current.run(until: Date().addingTimeInterval(0.15))
  dismissAutoSortPrompt()
  try reply(["ok": true, "submitted": true])  // Caller verifies stored native state.
}
@_cdecl("notes_toggle") public func notesToggle(_ input: UnsafePointer<CChar>)
  -> UnsafeMutablePointer<CChar>?
{
  let result: [String: Any]
  do {
    try execute(String(cString: input))
    result = ["ok": false]
  } catch let response as Response { result = response.data } catch {
    result = ["ok": false, "reason": "native", "error": String(describing: error)]
  }
  guard let data = try? JSONSerialization.data(withJSONObject: result),
    let text = String(data: data, encoding: .utf8)
  else { return nil }
  return strdup(text)
}
@_cdecl("notes_free") public func notesFree(_ value: UnsafeMutablePointer<CChar>?) { free(value) }
