# Privacy policy

_Last updated: 29 September 2026_

Clicksheet is a Chrome extension that captures screenshots of a browser journey and turns them into a single contact-sheet image. It is designed to work entirely on your own computer.

## Summary

Clicksheet does not collect, transmit, sell, or share any of your data. It has no servers, no accounts, no analytics, and no tracking. Everything it captures stays on your device, in a folder you choose, and exports are saved to your Downloads folder or that folder.

## What Clicksheet handles

When you use Clicksheet on a page, it handles:

- **Screenshots** of the visible page, captured only when you are recording a Journey or press **Capture**.
- **Page details** for each screenshot: the page title, the site (for example `https://app.example.com`) and path, the time it was captured, and for the element you clicked, its position, its accessible name, its role (such as button or link) and its tag. Query strings, fragments and anything typed into fields are never recorded.
- **Journey details** you enter, such as Journey names, descriptions, and redaction boxes. The name and description are printed at the top of every contact sheet you export.
- **Widget preferences**, such as where you placed the floating widget and whether it is expanded.

Password fields are masked before a screenshot is saved. You can also draw redaction boxes over anything else before exporting.

## Exports

Each export is a contact-sheet image plus a context file (JSON) that lists every step's page title, site, path, capture time, and clicked element's name, role and tag. **Copy context** puts the same JSON on your clipboard. If a redaction box covers the element you clicked, or the screenshot was redacted and Clicksheet cannot tell where, the element's name is left out of the context file and of the caption on the image, which then reads just "Click". The widget labels that step the same way. Page text is never used as an element's role.

## Where it is stored

- Journeys and screenshots are saved as files in a local folder that you pick.
- Exports are saved where you choose in Settings: `Downloads/Clicksheet/` (the default), or an `exports` folder inside the folder you picked. Clicksheet cannot read or write anywhere else on your disk.
- Clicksheet remembers which folder you picked, in the extension's own browser storage.
- Widget preferences and temporary tab state are kept in Chrome's extension storage on your device.

Nothing is uploaded. Clicksheet makes no network requests to any server. Contact sheets and context files leave your device only when you copy or save one and choose to share it yourself.

## Permissions

- **activeTab**: gives Clicksheet access to a tab only after you click its toolbar icon or use one of its shortcuts on that tab. It has no standing access to your browsing.
- **scripting**: lets Clicksheet show its widget and record clicks on the tab you activated.
- **storage**: saves widget preferences, your export location, and temporary tab state on your device.
- **downloads**: saves exports into your Downloads folder, and powers **Show in folder**. Chrome describes this as "Manage your downloads"; Clicksheet only touches the files it saves.
- **downloads.open**: lets **Open** open an export you just saved, and only when you click it.

## Deleting your data

Delete the Journey folder you chose to remove all captured screenshots, and `Downloads/Clicksheet/` to remove exports saved there. Uninstalling the extension removes its browser storage.

## Changes

If this policy changes, the updated version will be published here with a new date.

## Contact

Questions or concerns: open an issue at <https://github.com/simplybenuk/clicksheet/issues>.
