# Filtering is display-layer over a bounded ring buffer

Filters change line visibility only — no data is discarded at filter time — while the receive buffer is a ring capped at 10,000 lines by default (configurable; oldest dropped). Memory stays bounded, and toggling a filter recovers any line still within the buffer; older lines are gone regardless of filters.
