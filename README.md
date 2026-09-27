# Clicksheet

**Turn browser journeys into visual context for coding agents.**

Clicksheet is an open-source browser extension that records a user journey and turns it into a single visual contact sheet.

Hit record. Use the website normally. Stop recording.

Clicksheet captures the journey, highlights what you interacted with, and produces one image showing the sequence from start to finish.

Give that image to a coding agent.

## Why?

Coding agents can increasingly understand and change entire codebases. But explaining how an existing interface works is still surprisingly awkward.

You can:

- describe the journey in a prompt
- attach a collection of screenshots
- record a video
- point the agent at the application and hope it figures it out

Or you could give it one image showing the whole journey.

That's what Clicksheet is for.

## How it works

Imagine recording this journey:

```text
01 /dashboard
   CLICK "Settings"
        ↓
02 /settings
   CLICK "Users"
        ↓
03 /settings/users
   CLICK "Add user"
        ↓
04 /settings/users/new
```

Clicksheet turns it into a visual contact sheet containing each state in sequence, with the relevant interaction highlighted.

You can then give it to an agent with a prompt like:

> Here is the current user journey. Change the implementation so step 3 is removed and users go directly from Settings to Add User.

The image provides the agent with the visual state, sequence and interaction context.

## MVP

Keep it simple.

1. Install the Chrome extension.
2. Press **Record**.
3. Use the website normally.
4. Clicksheet captures interactions and resulting states.
5. Press **Stop**.
6. Clicksheet generates a numbered contact sheet.
7. Copy or save it and give it to an agent.

The first version needs:

- Chrome extension
- Start/stop recording
- Capture page state before an interaction
- Highlight the interaction target
- Capture the resulting state
- Number each step
- Generate one high-resolution contact sheet
- Copy/save the resulting image
- Redact password fields
- Simple manual blur/redaction before export

No AI needs to run inside Clicksheet.

**Clicksheet creates context for AI.**

## Principles

### Agent first

The primary output is context that a multimodal coding agent can understand.

It should still be useful to humans, but agents are the design target.

### Local first

Screenshots can contain sensitive information.

Capture, processing and export should happen locally wherever possible.

### One portable artifact

The useful thing Clicksheet produces is not a recording session or proprietary project file.

It's an image.

Paste it into a conversation. Attach it to an issue. Put it in a spec. Commit it to a repository.

### No AI for the sake of AI

If browser APIs can reliably capture something, use browser APIs.

Clicksheet shouldn't need an LLM to make a contact sheet for an LLM.

### Build in the open

Clicksheet is open source from day one.

The idea, experiments, mistakes and development will happen here.

## What could come later?

The contact sheet is the starting point.

Possible directions include:

- Markdown journey export
- Machine-readable journey data
- DOM and accessibility metadata
- Keyboard and form interactions
- Notes attached to steps
- Full-page captures
- Different contact-sheet layouts
- Select/remove steps before export
- Before/after journey comparison
- Automatic sensitive-data detection
- MCP integration
- Direct coding-agent integrations

But first: make the contact sheet useful.

## The experiment

Clicksheet starts with one question:

> **Can a single visual journey give a coding agent better product context than separate screenshots and written instructions?**

Let's find out.

## Status

🚧 **Early experiment.** The MVP flow works end to end in Chrome but has not been through human testing yet.

To try it:

1. Run `npm run build`.
2. Open `chrome://extensions`, turn on Developer mode, and load the `dist/` folder as an unpacked extension.
3. Run `npm run fixture` and open the printed URL, or open any `http(s)` page.
4. Click the Clicksheet icon. A floating widget appears in the bottom-right corner; drag it by its grip to move it, use the arrow button to expand or collapse it, and press Alt+Shift+K to hide or show it. In the expanded panel, choose **Storage** and pick a local folder for your Journeys.
5. Create a Journey, press **Record**, and use the page. Clicks that change the page are captured automatically. **Capture** adds the current state at any time. Press Alt+Shift+S instead to keep a hover or focus state that moving to the toolbar would end.
6. Press **Stop**, tidy the screenshots (delete, drag to reorder, **Redact…**), then use **Export** to copy or download the contact sheet.

If a keyboard shortcut does not work, open **Settings** in the widget: it shows which shortcuts Chrome has assigned and links to the page where you can set them.

Run `npm test` for the syntax check, build, and unit tests.

The optional browser suite, `npm run test:browser`, needs playwright-core and a Chromium build (set `CLICKSHEET_PLAYWRIGHT` and `CLICKSHEET_CHROMIUM` if Node cannot find them). It loads a test-only copy of the extension with broad host access, because automation cannot click the toolbar icon.

Issues, ideas and contributions are welcome.

## Licence

MIT
