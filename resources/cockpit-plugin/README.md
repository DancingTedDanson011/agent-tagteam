# CLI Organizer cockpit observation plugin

This optional plugin reports local lifecycle events. It never approves tools, returns decisions, starts CLI Organizer, or changes Claude settings. The writer needs `node` on PATH and uses only Node builtins.

For a temporary local test, explicitly launch Claude yourself with the plugin directory:

```text
claude --plugin-dir "<absolute-path-to-cockpit-plugin>"
```

The app does not execute this command. Use Claude's plugin controls yourself for any persistent installation or removal. Restart the test session without the flag to stop the temporary plugin.

The writer stores sanitized events in `~/.cli-organizer/cockpit-spool` using completed JSON files. The app acknowledges its own files only after committing observations. Events are retained while the app is closed; a full spool leaves a backpressure marker. No network listener is used.

Hook payload tests in this repository are synthetic. They do not prove the behavior of real permission prompts, plan approval, question dialogs, or interactions with other installed hooks; those remain explicit manual acceptance checks.

The configuration follows the official [hook reference](https://code.claude.com/docs/en/hooks), including exec-form paths rooted at `CLAUDE_PLUGIN_ROOT` and asynchronous command handlers. Async handlers cannot control the agent's decisions. See the official [plugin reference](https://code.claude.com/docs/en/plugins-reference) for installation options.
