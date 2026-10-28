# Project sessions in channels

This flow is available in builds containing the channel project-picker change.
A previously installed build will continue to use its existing New Session behavior until updated.

## Telegram

1. Add/open the project in eLLMsha Desktop so it has a registered project workspace.
2. Connect your bot and complete pairing in Settings → Remote → Channels → Telegram.
3. In the bot chat, send `/new` (or `/project`), or press **New Session**.
4. Choose **SequelCare**, another project, or **Temporary chat (no project)**.
5. Wait for the confirmation containing the chosen project, then send your task.
6. Use `/status` to check the session workspace.

Opening the picker does not replace your current session. Selection starts a fresh
conversation on the next message; it does not move or erase the old conversation.
The selected workspace stays attached to that channel user/chat until another
selection. A different group or DM has its own session.

Project sessions go through the same conversation creation and runtime context
path as desktop project chats, including project identity and memory scope.
The assistant/model still comes from that channel's settings. Natural-language
requests to “switch to SequelCare” are not a replacement for choosing a project.

Only the channel owner's standard projects are listed, with pagination. The backend
rechecks ownership and folder availability when a button is selected and when the
backing conversation is created. Callback payloads contain project IDs, never
filesystem paths. A missing/unavailable selection leaves the current session intact.

The shared New Session button flow also applies to the built-in Lark, DingTalk and
WeChat adapters. Live verification against those messaging services is separate
from local integration tests.
