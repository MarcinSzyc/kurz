//! Draws the ring gauge shown in the menu bar.

use std::f64::consts::TAU;

/// Pixel size of the icon: 18pt at 2x, the usual menu bar icon size.
pub const SIZE: u32 = 36;
const OUTER: f64 = 15.5;
const INNER: f64 = 10.5;
/// Samples per pixel side, for anti-aliased edges.
const SAMPLES: u32 = 4;

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

    /// Normal is drawn as a template image, which macOS tints to match the menu bar.
    pub fn is_template(self) -> bool {
        self == Level::Normal
    }

    fn colors(self) -> ([u8; 3], [u8; 3]) {
        const TRACK: [u8; 3] = [142, 142, 147];
        match self {
            Level::Normal => ([0, 0, 0], [0, 0, 0]),
            Level::Warning => ([255, 159, 10], TRACK),
            Level::Critical => ([255, 69, 58], TRACK),
        }
    }
}

/// RGBA pixels of a ring filled clockwise from the top by `fraction` (0..=1).
pub fn render(fraction: f64, level: Level) -> Vec<u8> {
    let fraction = fraction.clamp(0.0, 1.0);
    let (fill, track) = level.colors();
    let track_alpha = if level.is_template() { 0.35 } else { 0.55 };
    let center = SIZE as f64 / 2.0;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let (mut filled, mut empty) = (0u32, 0u32);
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let dx = x as f64 + (sx as f64 + 0.5) / SAMPLES as f64 - center;
                    let dy = y as f64 + (sy as f64 + 0.5) / SAMPLES as f64 - center;
                    let r = dx.hypot(dy);
                    if !(INNER..=OUTER).contains(&r) {
                        continue;
                    }
                    // Angle clockwise from 12 o'clock, in 0..TAU.
                    let angle = dx.atan2(-dy).rem_euclid(TAU);
                    if angle <= fraction * TAU {
                        filled += 1;
                    } else {
                        empty += 1;
                    }
                }
            }
            let total = (SAMPLES * SAMPLES) as f64;
            let fill_a = filled as f64 / total;
            let track_a = empty as f64 / total * track_alpha;
            let alpha = fill_a + track_a;
            if alpha == 0.0 {
                continue;
            }
            let i = ((y * SIZE + x) * 4) as usize;
            for c in 0..3 {
                rgba[i + c] = ((fill[c] as f64 * fill_a + track[c] as f64 * track_a) / alpha).round() as u8;
            }
            rgba[i + 3] = (alpha * 255.0).round() as u8;
        }
    }
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque_pixels(rgba: &[u8]) -> usize {
        rgba.chunks(4).filter(|p| p[3] > 200).count()
    }

    #[test]
    fn picks_level_by_thresholds() {
        assert_eq!(Level::of(79.9, 80, 90), Level::Normal);
        assert_eq!(Level::of(80.0, 80, 90), Level::Warning);
        assert_eq!(Level::of(95.0, 80, 90), Level::Critical);
    }

    #[test]
    fn fills_more_of_the_ring_as_the_disk_fills() {
        let empty = opaque_pixels(&render(0.0, Level::Normal));
        let half = opaque_pixels(&render(0.5, Level::Normal));
        let full = opaque_pixels(&render(1.0, Level::Normal));
        assert_eq!(empty, 0);
        assert!(half > 0 && full > half * 3 / 2, "{empty} {half} {full}");
    }

    #[test]
    fn half_gauge_fills_the_right_side() {
        let rgba = render(0.5, Level::Warning);
        let pixel = |x: u32, y: u32| &rgba[((y * SIZE + x) * 4) as usize..][..4];
        let mid = SIZE / 2;
        // The ring passes 13px right and left of the center.
        assert_eq!(pixel(mid + 13, mid), &[255, 159, 10, 255]);
        assert_ne!(pixel(mid - 13, mid)[..3], [255, 159, 10]);
        assert_eq!(pixel(mid, mid)[3], 0, "center stays transparent");
    }
}
