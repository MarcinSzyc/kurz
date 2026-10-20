//! Scans a folder from the command line and prints timing and the largest entries.
//! Usage: cargo run --release --example scan -- <path>

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use kurz_lib::recommend;
use kurz_lib::scanner::{self, Progress};

fn main() {
    let root = PathBuf::from(std::env::args().nth(1).expect("usage: scan <path>"));
    let progress = Progress::default();
    let started = Instant::now();
    let tree = scanner::scan(&root, &AtomicBool::new(false), &progress).unwrap().unwrap();
    println!(
        "{} in {:.2?}: {} files, {} dirs, {} errors",
        human(tree.size),
        started.elapsed(),
        progress.files.load(Ordering::Relaxed),
        progress.dirs.load(Ordering::Relaxed),
        progress.errors.load(Ordering::Relaxed),
    );
    for child in tree.children.iter().take(10) {
        println!("{:>10}  {}", human(child.size), child.name);
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let started = Instant::now();
    let items = recommend::recommend(&tree, &root, now);
    println!("\n{} recommendations in {:.2?}:", items.len(), started.elapsed());
    for item in &items {
        println!("{:>10}  {:<12} {} — {}", human(item.size), format!("{:?}", item.risk), item.label, item.location);
    }
}

fn human(bytes: u64) -> String {
    format!("{:.1} GB", bytes as f64 / 1e9)
}
