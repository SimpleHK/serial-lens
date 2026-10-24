# One unified Tag model consumed by highlight and filter

Highlighting and filtering both operate on the same named Tag rules (pattern + color + enabled state) instead of two independent rule systems. A tag is defined once and every consumer inherits it; the single-axis enable toggle governs a tag's participation in both features at once, keeping the UI and the mental model small.
