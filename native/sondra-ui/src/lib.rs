//! Sondra's look for GPUI. The palette, the type and the radii are the web app's own (`DESIGN.md`,
//! `src/styles/theme.css`); the components are drawn from them and every one of them is readable to a
//! screen reader (`sondra-a11y`) — a control without a name and a role is not finished.

pub mod dialog;
pub mod fonts;
pub mod icons;
pub mod menu;
pub mod motion;
pub mod slider;
pub mod text_field;
pub mod theme;
pub mod ui;

pub use dialog::Dialog;
pub use icons::{action_icon, panel_icon, ui_icon, Assets};
pub use menu::MenuItem;
pub use text_field::{bind_keys, FieldEvent, TextField};
pub use theme::{family, radius, size, Colors, Mode, DARK, LIGHT};
pub use slider::Slider;
pub use ui::{float_shadow, Button, Chip, Notice, NoticeKind, RackItem, Tab, Tile, Ui};
