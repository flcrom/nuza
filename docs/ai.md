# AI in nuza

nuza still works with no account, and there is nothing to sign up for. The AI
panel (⌘L, Ctrl+L elsewhere) hands your question to an AI agent that is
already on your computer, on your own plan. nuza runs no model, holds no key
and has no server.

Nothing runs until you turn an agent on in **Settings → AI** and agree to a
one-time notice saying what it will be sent.

## The agents

| Agent              | Install                                                                           | Sign in                                     |
| ------------------ | --------------------------------------------------------------------------------- | ------------------------------------------- |
| **Claude Code**    | `npm install -g @anthropic-ai/claude-code` (needs Node.js 22 or newer)            | Run `claude` once in a terminal and sign in |
| **Codex**          | `npm install -g @openai/codex` (needs Node.js 22 or newer)                        | Run `codex login`                           |
| **OpenCode**       | `curl -fsSL https://opencode.ai/install \| bash`, or `npm install -g opencode-ai` | Run `opencode auth login`                   |
| **Something else** | Any program that speaks the Agent Client Protocol (ACP) over its input and output | However that program does it                |

OpenCode's free models sometimes refuse to answer anywhere but inside OpenCode itself. If it says so, sign in to a provider with `opencode auth login`.

For Claude Code and Codex, nuza starts a small adapter that lets them speak ACP,
at a pinned version, with `npx`. The first start downloads it and can take a
few minutes; after that it starts in seconds.

To get going:

1. Install one of the agents above and sign in to it.
2. In nuza, open **Settings → AI** and press **Use** next to it.
3. Agree to the notice, open a note, and press ⌘L.

## What it is sent

Only when you ask something, and only to the agent you turned on:

- **Your question**, or the request a writing action makes (Rephrase,
  Proofread, …), which is shown on your message.
- **The note you are asking about**: its title and text, with your selection
  marked. A long note is trimmed to the part around your selection; with
  **Send only the selection** on, only the selected text goes.
- **Your instructions** (Settings → AI → How it replies) and **your memory for
  this folder** (`/remember`, or Settings → AI → Memory), with every question.
- **The conversation so far**, when the agent starts a new session, so it can
  pick up where you left off.
- With **Let the agent search this vault** on: the notes it looks up, through
  nuza's read-only search. It can search, list and read notes. It cannot write
  them, and it cannot see anything outside the vault.

The agent passes all of this to its own provider, on your account, under that
provider's terms. nuza keeps the conversation and your memory on this computer
only. You can clear the conversation in Settings at any time.

## What it cannot do

Changes to a note come back as **suggestions** that you accept or reject one by
one. Accepting one is an ordinary edit, and ⌘Z undoes it.

Every time the agent asks to run a command, write or delete a file, or look
something up on the web, nuza says no, and says so in the panel. Web lookups
can be allowed per vault in Settings and are off by default.

That rests on two layers, and the second does not depend on the agent
cooperating:

1. **Permissions.** nuza offers the agent no file or terminal access at all, and
   turns down every request to act, except reading the vault through its own
   read-only tools.
2. **The fence.** The operating system runs the agent where:
   - it cannot write anywhere except its own sign-in and cache folders and a
     scratch folder;
   - it cannot read your home folder, so not your vault, not `~/.ssh`, and not
     another vault.

   It can still reach the network, because it needs to reach its provider.

| Platform | Fence                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| macOS    | Seatbelt (`sandbox-exec`)                                                                                         |
| Linux    | Landlock, on Linux 5.13 or newer with Landlock turned on. Without it, nuza says so in Settings and in the notice. |
| Windows  | None. The notice says so: _"This computer can't fence it in, so it runs with your own permissions."_              |

## The risks that remain

Two, stated plainly:

1. **Persuasion.** A note can carry text written to steer the agent: a pasted
   web page, or a document someone sent you. The agent cannot act on it beyond
   what is described above. But it can still give you a misleading answer, or
   suggest an edit that does something you didn't intend. Read suggestions
   before accepting them.
2. **Sending things out through a web lookup.** If you allow web lookups for a
   vault, the agent can fetch web addresses. A steered agent could put text from
   the note it was sent into such an address. Leave web lookups off for vaults
   that hold anything private.

## Turning it off

Settings → AI → **Turn off**. The agent is stopped: no process, no open port,
no listener. Your notes are untouched either way.
