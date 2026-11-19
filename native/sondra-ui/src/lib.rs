//! Sondra's look for GPUI. The palette, the type and the radii are the web app's own (`DESIGN.md`,
//! `src/styles/theme.css`); the components are drawn from them and every one of them is readable to a
//! screen reader (`sondra-a11y`) — a control without a name and a role is not finished.

pub mod fonts;
pub mod theme;
pub mod ui;

pub use theme::{family, radius, size, Colors, Mode, DARK, LIGHT};
pub use ui::{Button, Chip, Notice, NoticeKind, Tab, Tile, Ui};
