---
version: 1
slug: "native-sondra-app-src-shell-rs"
primary_target: "native/sondra-app/src/shell.rs"
related_targets: ["native/sondra-ui/src/theme.rs","native/sondra-ui/src/ui.rs"]
---

# Native Sondra — the window (shell, start, every page)

Scope: the native Rust/GPUI app (`native/sondra-app`, `native/sondra-ui`). Mode: **Operate**. The website keeps its own world; this brief does not touch it.

Audience and job: musicians, producers and series fans on a Windows desktop, often evenings, often a dim room. They bring a file, a folder or a series and want a result or the next episode. Constraint from the user (20.11.2026): a complete redesign of look AND structure; colours roughly as before (Waldschwarz, forest ink, mint); **dark is the default**, light stays selectable. Complaints answered: it read like a website, flat and pale, cluttered, wrong type and proportions.

Physical scene: a desk in a dim room, a film or a mix on the other half of the screen — the room is dark, only the work is lit. Hence dark first.

## Direction contract

THESIS: Sondra is the projection booth behind the screen. The room is dark; only what is being worked on is lit — the plate („Leinwand“) the page sits on. Refuses the category default of a web page with a header and a row of tabs, and refuses the neon-on-black streaming clone.

OWN-WORLD: Waldschwarz room in three steps (room < rack < plate); the plate one step lighter, 16 px rounded, a hairline catch-light on its top edge and the one shadow of the window. Mint (#a6ecb9) is the projector's light: it marks what can be done and the selected place, nowhere decorative. Typewritten reel labels: values, file names and times in Courier Prime, right-aligned, tabular. UI face a compact grotesque at desktop sizes (13–14 px), page titles large — rank by scale contrast alone. Exactly one reversed plate (filled mint) per screen: the page's primary action. No filmstrip, sprocket or marquee ornament — costume is banned.

STORY: the visitor sees where they are (the rack on the left, the chosen place lit), what this page is (a large title on the plate) and the one thing to do (the mint plate, top right of the page or in its way-in). Everything else is quieter and reachable.

FIRST VIEWPORT: left the rack (232 px, room ground): wordmark, the six tasks with icons, then the three tool groups as headed lists — every tool one click away, no dropdown menus; at the foot the session, Drive, theme and version. Right the plate, inset 8 px from the window, its page header (title 28 px, actions right), content below at desktop density. Start: a way-in band (heading, one sentence, „Datei auswählen“ as the reversed plate, drop anywhere), „Heute weiterschauen“, then the tools as compact rows of tiles.

FORM: candidate 7 of 7 on my ordered list (Vorführkabine, after NLE workspace, studio console, Fluent native, groovebox device, Nagra field recorder, Braun hi-fi); seed key 84432017. Raises — from the timetable rack: one reversed plate per screen; from the high-density site: desktop density, no web padding inflation; from the type specimen: hierarchy by scale contrast; from the j-card: running times right-aligned, tabular; from the circle catalog: grids repack in whole cells, state is a mark on the cell. Signature interaction: **Saallicht** — while a film plays, the rack and page chrome dim and come back on pointer or focus. Changeover cue marks announce „Nächste Folge“ in the picture's corner.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
