# Implement the @microsoft/vscode-serial-monitor-api contract

The existing ecosystem integrates with serial monitoring through `@microsoft/vscode-serial-monitor-api` (`startMonitoringPort`, `startMonitoringTCPConnection`, `Port`, and the settings types). We implement that same contract, vendoring its type definitions, so dependent extensions work against ours unchanged. UI features (tags, filter, scroll lock) live outside this API surface and are not constrained by it.
