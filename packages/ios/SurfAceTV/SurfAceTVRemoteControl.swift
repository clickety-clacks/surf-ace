import SwiftUI
import UIKit

/// A modal Remote editing control. Directional presses edit the cursor/preview
/// instead of also navigating focus to another button. Menu always leaves it.
struct SurfAceTVRemoteControl: UIViewRepresentable {
    let title: String
    let move: (MoveCommandDirection) -> Void
    let select: () -> Void
    let done: () -> Void
    let back: () -> Void

    func makeUIView(context: Context) -> Control { Control() }
    func updateUIView(_ view: Control, context: Context) {
        view.label.text = title
        view.accessibilityLabel = title
        view.move = move; view.select = select; view.done = done; view.back = back
    }

    final class Control: UIView {
        let label = UILabel()
        var move: ((MoveCommandDirection) -> Void)?
        var select: (() -> Void)?
        var done: (() -> Void)?
        var back: (() -> Void)?
        private var capturesDirections = false
        override init(frame: CGRect) {
            super.init(frame: frame)
            layer.cornerRadius = 18
            label.font = .systemFont(ofSize: 26)
            label.textAlignment = .center
            label.numberOfLines = 2
            addSubview(label)
            isAccessibilityElement = true
            accessibilityTraits = .button
            backgroundColor = .darkGray
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override var canBecomeFocused: Bool { true }
        override var intrinsicContentSize: CGSize { CGSize(width: 650, height: 80) }
        override func layoutSubviews() { super.layoutSubviews(); label.frame = bounds.insetBy(dx: 16, dy: 8) }
        override func shouldUpdateFocus(in context: UIFocusUpdateContext) -> Bool {
            // The editing mode has explicit Menu/Done exits. Retain directional
            // input here while those presses change the draft, not UI focus.
            if capturesDirections && context.previouslyFocusedView === self && context.nextFocusedView !== self { return false }
            return super.shouldUpdateFocus(in: context)
        }
        override func didUpdateFocus(in context: UIFocusUpdateContext, with coordinator: UIFocusAnimationCoordinator) {
            super.didUpdateFocus(in: context, with: coordinator)
            backgroundColor = isFocused ? .white : .darkGray
            label.textColor = isFocused ? .black : .white
        }
        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            for press in presses {
                if !capturesDirections && [.upArrow, .downArrow, .leftArrow, .rightArrow].contains(press.type) {
                    super.pressesBegan([press], with: event)
                    continue
                }
                switch press.type {
                case .upArrow: move?(.up)
                case .downArrow: move?(.down)
                case .leftArrow: move?(.left)
                case .rightArrow: move?(.right)
                case .select:
                    capturesDirections = true
                    accessibilityHint = "Arrows edit. Menu exits; Play/Pause finishes."
                    select?()
                case .playPause: done?()
                case .menu: back?()
                default: super.pressesBegan([press], with: event)
                }
            }
        }
        override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            let captured: [UIPress.PressType] = capturesDirections
                ? [.upArrow, .downArrow, .leftArrow, .rightArrow, .select, .playPause, .menu]
                : [.select, .playPause, .menu]
            let remaining = presses.filter { !captured.contains($0.type) }
            if !remaining.isEmpty { super.pressesEnded(Set(remaining), with: event) }
        }
    }
}
