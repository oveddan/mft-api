# README images

Media for the narrative section of `README.md`. Add the Markdown reference to
`README.md` only in the same commit that makes the asset available — a reference to a
missing file renders as a broken-image icon on GitHub.

## In the README

| Asset | What it is |
| --- | --- |
| Hero: [`twister-chat-demo.gif`](https://media.danoved.xyz/mft-api/81fcec7/95b57ab0/twister-chat-demo.gif), linking to [`twister-chat-demo.mp4`](https://media.danoved.xyz/mft-api/81fcec7/f9be148f/twister-chat-demo.mp4) | A 21-second split screen: the chat on the left asks for new colors, and the physical knobs change on the right. Covers both the hero shot and the chat-to-knobs demo. |
| [`twister-map.png`](https://media.danoved.xyz/mft-api/2d1eada/4e228abf/twister-map.png) | Bank 1 of the Treetop Live Twister map, the page the agent keeps of what every encoder drives. Rendered from the map artifact with headless Chrome at 2x; cropped to the title, bank tabs, and grid. Ends "What this changes". |

The hero is hosted on R2, not committed: the source is 107 MB, over GitHub's 100 MB
file limit. GitHub also won't play an externally hosted video inline in a README, so
the README shows an autoplaying GIF (640px, 6 fps, 64 colors, 4.7 MB — kept under the
size GitHub's image proxy accepts) that links to a 1280px H.264 MP4 (3 MB). The
source video is not committed.

## TODO

- [ ] **`before-after.png`** — goes at the end of "The problem". Left: the stock editor
      with one knob selected, showing what clicking through 16 knobs looks like. Right:
      the sentence that replaces it. The stock-editor screenshot alone would also work.

The Chromatik mapping chat is in the README as fenced text under "Examples", so it no
longer needs a screenshot.

Check each capture for anything that shouldn't be public — file paths, window titles,
other projects, names in a chat.
