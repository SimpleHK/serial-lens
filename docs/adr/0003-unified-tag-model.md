# One unified Tag model consumed by highlight and filter

Highlighting and filtering both operate on the same named Tag rules (pattern + color + highlight/filter state) instead of two independent rule systems. A tag is defined once and every consumer inherits it; the single-axis enable toggle originally governed a tag's participation in both features at once, keeping the UI and the mental model small.

Superseded in part (user request, post-MVP): the single toggle split into two independent per-tag flags — `highlight` and `filter` — so a tag can color lines without participating in filtering or vice versa. The unified rule source (one Tag, two consumers) is unchanged; chips expose the two flags as H/F segments.
