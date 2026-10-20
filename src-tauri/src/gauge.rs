//! Draws the menu bar icon: a disk gauge in one of four styles (see design/menu-bar.html).

use serde::{Deserialize, Serialize};

/// Pixels per point: menu bar icons are drawn at 2x.
const SCALE: f64 = 2.0;
/// Icon height in points, the usual menu bar size.
const HEIGHT_PT: f64 = 18.0;
/// Samples per pixel side, for anti-aliased edges.
const SAMPLES: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Style {
    /// A horizontal bar, like the battery icon.
    Bar,
    /// A vertical bar that fills from the bottom.
    #[default]
    Tank,
    /// Three slabs that light up one by one.
    Slabs,
    /// The app icon, with a colored dot once the disk is getting full.
    Sprite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Normal,
    Warning,
    Critical,
}

impl Level {
    pub fn of(used_percent: f64, warn_at: u8, critical_at: u8) -> Self {
        if used_percent >= critical_at as f64 {
            Level::Critical
        } else if used_percent >= warn_at as f64 {
            Level::Warning
        } else {
            Level::Normal
        }
    }
}

pub struct Icon {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    /// Template images are tinted by macOS to match the menu bar.
    pub template: bool,
}

type Rgb = [f64; 3];
const BLACK: Rgb = [0.0, 0.0, 0.0];
/// Amber and coral from the design, between its light and dark variants.
const AMBER: Rgb = [232.0, 169.0, 60.0];
const CORAL: Rgb = [232.0, 112.0, 95.0];
const GREY: Rgb = [142.0, 142.0, 147.0];

#[derive(Default)]
struct Canvas {
    w: u32,
    h: u32,
    /// Premultiplied RGBA, 0..1.
    px: Vec<[f64; 4]>,
}

impl Canvas {
    fn new(width_pt: f64) -> Self {
        let (w, h) = ((width_pt * SCALE).round() as u32, (HEIGHT_PT * SCALE) as u32);
        Canvas { w, h, px: vec![[0.0; 4]; (w * h) as usize] }
    }

    /// Paints `color` at `alpha` wherever `inside(x, y)` holds, coordinates in points.
    fn fill(&mut self, color: Rgb, alpha: f64, inside: impl Fn(f64, f64) -> bool) {
        for y in 0..self.h {
            for x in 0..self.w {
                let mut hits = 0;
                for sy in 0..SAMPLES {
                    for sx in 0..SAMPLES {
                        let px = (x as f64 + (sx as f64 + 0.5) / SAMPLES as f64) / SCALE;
                        let py = (y as f64 + (sy as f64 + 0.5) / SAMPLES as f64) / SCALE;
                        hits += inside(px, py) as u32;
                    }
                }
                if hits == 0 {
                    continue;
                }
                let a = alpha * hits as f64 / (SAMPLES * SAMPLES) as f64;
                let p = &mut self.px[(y * self.w + x) as usize];
                for c in 0..3 {
                    p[c] = color[c] / 255.0 * a + p[c] * (1.0 - a);
                }
                p[3] = a + p[3] * (1.0 - a);
            }
        }
    }

    fn into_rgba(self) -> Vec<u8> {
        self.px
            .iter()
            .flat_map(|p| {
                let a = p[3];
                let un = |c: f64| if a > 0.0 { (c / a * 255.0).round().clamp(0.0, 255.0) as u8 } else { 0 };
                [un(p[0]), un(p[1]), un(p[2]), (a * 255.0).round() as u8]
            })
            .collect()
    }
}

/// A rounded rectangle, in points.
fn rrect(x: f64, y: f64, w: f64, h: f64, r: f64) -> impl Fn(f64, f64) -> bool {
    // A small fill can be thinner than two radii.
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    move |px, py| {
        if px < x || px > x + w || py < y || py > y + h {
            return false;
        }
        let cx = px.clamp(x + r, x + w - r);
        let cy = py.clamp(y + r, y + h - r);
        (px - cx).powi(2) + (py - cy).powi(2) <= r * r
    }
}

/// The outline of a rounded rectangle, `t` points thick.
fn outline(x: f64, y: f64, w: f64, h: f64, r: f64, t: f64) -> impl Fn(f64, f64) -> bool {
    let outer = rrect(x, y, w, h, r);
    let inner = rrect(x + t, y + t, w - 2.0 * t, h - 2.0 * t, (r - t).max(0.0));
    move |px, py| outer(px, py) && !inner(px, py)
}

/// The app icon, 32x32 pixels, for the Sprite style.
fn app_icon() -> Option<(Vec<u8>, u32)> {
    let decoder = png::Decoder::new(std::io::Cursor::new(include_bytes!("../icons/32x32.png").as_slice()));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    (info.color_type == png::ColorType::Rgba && info.width == 32).then(|| (buf[..info.buffer_size()].to_vec(), 32))
}

/// The icon for a disk `used_percent` full.
pub fn render(style: Style, used_percent: f64, level: Level) -> Icon {
    let p = used_percent.clamp(0.0, 100.0);
    let template = level == Level::Normal && style != Style::Sprite;
    let color = match level {
        Level::Normal => BLACK,
        Level::Warning => AMBER,
        Level::Critical => CORAL,
    };
    // Unlit parts: faint in a template (macOS tints them), grey once colored.
    let (dim, dim_alpha) = if template { (BLACK, 0.22) } else { (GREY, 0.5) };
    let fill = p.max(8.0) / 100.0;
    let mid = HEIGHT_PT / 2.0;

    let c = match style {
        Style::Bar => {
            let mut c = Canvas::new(22.0);
            let (x, y, w, h) = (0.0, mid - 5.5, 22.0, 11.0);
            c.fill(color, 1.0, outline(x, y, w, h, 3.5, 1.5));
            c.fill(color, 1.0, rrect(x + 3.0, y + 3.0, (w - 6.0) * fill, h - 6.0, 1.5));
            c
        }
        Style::Tank => {
            let mut c = Canvas::new(11.0);
            let (x, y, w, h) = (0.0, mid - 7.5, 11.0, 15.0);
            c.fill(color, 1.0, outline(x, y, w, h, 3.0, 1.5));
            let inner_h = h - 6.0;
            let level_h = inner_h * fill;
            c.fill(color, 1.0, rrect(x + 3.0, y + 3.0 + inner_h - level_h, w - 6.0, level_h, 1.0));
            c
        }
        Style::Slabs => {
            let mut c = Canvas::new(14.0);
            let lit = (p / 34.0).ceil() as usize;
            // Bottom slab first, as in the design.
            for i in 0..3 {
                let y = mid + 2.0 - i as f64 * 5.0;
                let (col, a) = if i < lit { (color, 1.0) } else { (dim, dim_alpha) };
                c.fill(col, a, rrect(0.0, y, 14.0, 3.5, 1.5));
            }
            c
        }
        Style::Sprite => {
            let mut c = Canvas::new(19.0);
            if let Some((icon, size)) = app_icon() {
                // A 16pt icon: 32px is exactly 16pt at 2x.
                let top = ((HEIGHT_PT - 16.0) / 2.0 * SCALE) as u32;
                for y in 0..size {
                    for x in 0..size {
                        let s = ((y * size + x) * 4) as usize;
                        let a = icon[s + 3] as f64 / 255.0;
                        let rgb = |i: usize| icon[s + i] as f64 / 255.0 * a;
                        c.px[((y + top) * c.w + x) as usize] = [rgb(0), rgb(1), rgb(2), a];
                    }
                }
            }
            if level != Level::Normal {
                // The dot overlaps the icon's bottom-right corner, as in the design.
                let (cx, cy) = (15.0, mid + 7.0);
                c.fill([40.0, 40.0, 38.0], 1.0, move |x, y| (x - cx).powi(2) + (y - cy).powi(2) <= 5.5 * 5.5);
                c.fill(color, 1.0, move |x, y| (x - cx).powi(2) + (y - cy).powi(2) <= 4.0 * 4.0);
            }
            c
        }
    };
    let (width, height) = (c.w, c.h);
    Icon { rgba: c.into_rgba(), width, height, template }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque(icon: &Icon) -> usize {
        icon.rgba.chunks(4).filter(|p| p[3] > 200).count()
    }

    fn pixel(icon: &Icon, x_pt: f64, y_pt: f64) -> [u8; 4] {
        let (x, y) = ((x_pt * SCALE) as u32, (y_pt * SCALE) as u32);
        let i = ((y * icon.width + x) * 4) as usize;
        icon.rgba[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn picks_level_by_thresholds() {
        assert_eq!(Level::of(79.9, 80, 95), Level::Normal);
        assert_eq!(Level::of(80.0, 80, 95), Level::Warning);
        assert_eq!(Level::of(96.0, 80, 95), Level::Critical);
    }

    #[test]
    fn sizes_follow_the_design() {
        for (style, width_pt) in [(Style::Bar, 22.0), (Style::Tank, 11.0), (Style::Slabs, 14.0), (Style::Sprite, 19.0)] {
            let icon = render(style, 50.0, Level::Normal);
            assert_eq!((icon.width, icon.height), ((width_pt * SCALE) as u32, 36), "{style:?}");
            assert_eq!(icon.rgba.len(), (icon.width * icon.height * 4) as usize);
        }
    }

    #[test]
    fn fills_more_as_the_disk_fills() {
        for style in [Style::Bar, Style::Tank, Style::Slabs] {
            let low = opaque(&render(style, 20.0, Level::Normal));
            let high = opaque(&render(style, 90.0, Level::Normal));
            assert!(high > low, "{style:?}: {low} vs {high}");
        }
    }

    #[test]
    fn tank_fills_from_the_bottom() {
        let icon = render(Style::Tank, 40.0, Level::Warning);
        // Just above the bottom inner edge is filled; just below the top inner edge is not.
        assert_eq!(pixel(&icon, 5.5, 9.0 + 7.5 - 3.5), [232, 169, 60, 255]);
        assert_eq!(pixel(&icon, 5.5, 9.0 - 7.5 + 3.5)[3], 0);
    }

    #[test]
    fn only_normal_gauges_are_templates() {
        assert!(render(Style::Bar, 50.0, Level::Normal).template);
        assert!(!render(Style::Bar, 85.0, Level::Warning).template);
        assert!(!render(Style::Sprite, 50.0, Level::Normal).template, "the sprite keeps its colors");
    }

    #[test]
    fn sprite_shows_a_dot_only_when_filling_up() {
        assert!(app_icon().is_some(), "the bundled icon decodes");
        let calm = render(Style::Sprite, 50.0, Level::Normal);
        let full = render(Style::Sprite, 97.0, Level::Critical);
        let dot = pixel(&full, 15.0, 16.0);
        assert_eq!(dot, [232, 112, 95, 255]);
        assert_ne!(pixel(&calm, 15.0, 16.0), dot);
    }

    /// Writes every style at each level side by side to `$KURZ_ICON_SHEET`, to eyeball them.
    /// Run with: KURZ_ICON_SHEET=/tmp/icons.png cargo test icon_sheet -- --ignored
    #[test]
    #[ignore]
    fn icon_sheet() {
        let Ok(path) = std::env::var("KURZ_ICON_SHEET") else { return };
        let icons: Vec<Vec<Icon>> = [Style::Bar, Style::Tank, Style::Slabs, Style::Sprite]
            .iter()
            .map(|&s| vec![render(s, 58.0, Level::Normal), render(s, 88.0, Level::Warning), render(s, 97.0, Level::Critical)])
            .collect();
        let (cell_w, cell_h, pad) = (56u32, 44u32, 4u32);
        let (w, h) = (cell_w * 3, cell_h * 4);
        // Light grey background, so template (black) icons show.
        let mut sheet = vec![230u8; (w * h * 4) as usize];
        for (row, styles) in icons.iter().enumerate() {
            for (col, icon) in styles.iter().enumerate() {
                for y in 0..icon.height {
                    for x in 0..icon.width {
                        let s = ((y * icon.width + x) * 4) as usize;
                        let (dx, dy) = (col as u32 * cell_w + pad + x, row as u32 * cell_h + pad + y);
                        let d = ((dy * w + dx) * 4) as usize;
                        let a = icon.rgba[s + 3] as f64 / 255.0;
                        for c in 0..3 {
                            sheet[d + c] = (icon.rgba[s + c] as f64 * a + sheet[d + c] as f64 * (1.0 - a)) as u8;
                        }
                        sheet[d + 3] = 255;
                    }
                }
            }
        }
        let file = std::fs::File::create(path).unwrap();
        let mut enc = png::Encoder::new(file, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.write_header().unwrap().write_image_data(&sheet).unwrap();
    }
}
