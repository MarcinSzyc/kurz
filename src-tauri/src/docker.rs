//! What's inside Docker's disk image: images, containers, volumes and build cache, read from the
//! Docker Engine API over its socket, and removed through the same API (never by deleting files,
//! which would corrupt Docker). Asks for one kind at a time (`/system/df?type=…`), which keeps
//! working while builds are pruning their cache, unlike asking for everything at once.

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Image,
    Container,
    Volume,
    BuildCache,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: Kind,
    /// What the API removes it by.
    pub id: String,
    pub name: String,
    /// e.g. the image a container runs, or "anonymous" for a volume.
    pub detail: String,
    /// Bytes removing it frees (for containers, their writable layer).
    pub size: u64,
    /// Unix seconds.
    pub created: i64,
    /// Running, or used by a container: Docker won't remove it.
    pub in_use: bool,
    /// The docker compose project it belongs to.
    pub project: Option<String>,
    /// A volume Docker named itself (`docker run -v /path` without a name).
    pub anonymous: bool,
}

/// Everything but volumes, which take Docker much longer to measure and come separately.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub images: Vec<Item>,
    pub containers: Vec<Item>,
    /// The whole build cache as one item; Docker prunes it as a whole.
    pub build_cache: Option<Item>,
}

/// Where Docker Desktop (and Colima, Rancher, OrbStack-compatible setups) put the socket.
fn socket(home: &Path) -> Option<PathBuf> {
    [home.join(".docker/run/docker.sock"), PathBuf::from("/var/run/docker.sock"), home.join(".colima/default/docker.sock")]
        .into_iter()
        .find(|p| p.exists())
}

/// One HTTP/1.0 request over the socket; the daemon closes the connection after the body.
fn request(sock: &Path, method: &str, path: &str) -> io::Result<(u16, String)> {
    let mut stream = UnixStream::connect(sock)?;
    stream.set_read_timeout(Some(TIMEOUT))?;
    // Unversioned paths use the daemon's own API version; `type=` needs 1.42 or later.
    write!(stream, "{method} {path} HTTP/1.0\r\nHost: docker\r\nContent-Length: 0\r\n\r\n")?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or_else(|| io::Error::other("Bad response from Docker"))?;
    let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).ok_or_else(|| io::Error::other("Bad response from Docker"))?;
    Ok((status, body.to_string()))
}

fn get_json(sock: &Path, path: &str) -> io::Result<Value> {
    let (status, body) = request(sock, "GET", path)?;
    let value: Value = serde_json::from_str(&body).map_err(io::Error::other)?;
    if status >= 400 {
        return Err(io::Error::other(value["message"].as_str().unwrap_or("Docker returned an error").to_string()));
    }
    Ok(value)
}

fn project(v: &Value) -> Option<String> {
    v["Labels"]["com.docker.compose.project"].as_str().map(str::to_string)
}

fn rfc3339(s: &str) -> i64 {
    // "2026-09-08T15:27:07Z" or with fractions: date and time are enough here.
    let (date, time) = s.split_once('T').unwrap_or(("", ""));
    let d: Vec<i64> = date.split('-').filter_map(|x| x.parse().ok()).collect();
    let t: Vec<i64> = time.get(..8).unwrap_or("").split(':').filter_map(|x| x.parse().ok()).collect();
    if d.len() != 3 || t.len() != 3 {
        return 0;
    }
    let (y, m) = if d[1] <= 2 { (d[0] - 1, d[1] + 9) } else { (d[0], d[1] - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + (153 * m + 2) / 5 + d[2] - 1;
    (era * 146_097 + doe - 719_468) * 86_400 + t[0] * 3600 + t[1] * 60 + t[2]
}

fn short(id: &str) -> String {
    id.trim_start_matches("sha256:").chars().take(12).collect()
}

fn images(v: &Value) -> Vec<Item> {
    v["Images"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|i| {
            let tag = i["RepoTags"].as_array().and_then(|t| t.first()).and_then(Value::as_str).filter(|t| *t != "<none>:<none>");
            let used_by = i["Containers"].as_i64().unwrap_or(0);
            Item {
                kind: Kind::Image,
                id: i["Id"].as_str().unwrap_or_default().to_string(),
                name: tag.map_or_else(|| format!("<untagged> {}", short(i["Id"].as_str().unwrap_or_default())), str::to_string),
                detail: match used_by {
                    0 => "not used by any container".to_string(),
                    1 => "used by 1 container".to_string(),
                    n => format!("used by {n} containers"),
                },
                size: i["Size"].as_u64().unwrap_or(0),
                created: i["Created"].as_i64().unwrap_or(0),
                in_use: used_by > 0,
                project: project(i),
                anonymous: false,
            }
        })
        .collect()
}

fn containers(v: &Value) -> Vec<Item> {
    v["Containers"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let state = c["State"].as_str().unwrap_or_default();
            Item {
                kind: Kind::Container,
                id: c["Id"].as_str().unwrap_or_default().to_string(),
                name: c["Names"]
                    .as_array()
                    .and_then(|n| n.first())
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim_start_matches('/')
                    .to_string(),
                detail: format!("{} · {}", c["Image"].as_str().unwrap_or_default(), c["Status"].as_str().unwrap_or(state)),
                size: c["SizeRw"].as_u64().unwrap_or(0),
                created: c["Created"].as_i64().unwrap_or(0),
                in_use: matches!(state, "running" | "paused" | "restarting"),
                project: project(c),
                anonymous: false,
            }
        })
        .collect()
}

fn volumes(v: &Value) -> Vec<Item> {
    v["Volumes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|vol| {
            let name = vol["Name"].as_str().unwrap_or_default().to_string();
            let anonymous = vol["Labels"].get("com.docker.volume.anonymous").is_some()
                || (name.len() == 64 && name.chars().all(|c| c.is_ascii_hexdigit()));
            let refs = vol["UsageData"]["RefCount"].as_i64().unwrap_or(0);
            Item {
                kind: Kind::Volume,
                id: name.clone(),
                name: if anonymous { format!("anonymous {}", &name[..name.len().min(12)]) } else { name },
                detail: match (refs, anonymous) {
                    (0, true) => "anonymous, not attached".to_string(),
                    (0, false) => "not attached to a container".to_string(),
                    (n, _) => format!("attached to {n} container{}", if n == 1 { "" } else { "s" }),
                },
                size: vol["UsageData"]["Size"].as_i64().unwrap_or(0).max(0) as u64,
                created: rfc3339(vol["CreatedAt"].as_str().unwrap_or_default()),
                in_use: refs > 0,
                project: project(vol),
                anonymous,
            }
        })
        .collect()
}

fn build_cache(v: &Value) -> Option<Item> {
    let records = v["BuildCache"].as_array()?;
    if records.is_empty() {
        return None;
    }
    // What a full prune frees: everything not in use by a running build.
    let free: u64 = records.iter().filter(|r| !r["InUse"].as_bool().unwrap_or(false)).map(|r| r["Size"].as_u64().unwrap_or(0)).sum();
    let newest = records.iter().filter_map(|r| r["LastUsedAt"].as_str().map(rfc3339)).max().unwrap_or(0);
    Some(Item {
        kind: Kind::BuildCache,
        id: "build-cache".into(),
        name: "Build cache".into(),
        detail: format!("{} entries from docker build", records.len()),
        size: free,
        created: newest,
        in_use: false,
        project: None,
        anonymous: false,
    })
}

fn not_running(e: String) -> String {
    if e.contains("refused") || e.contains("No such file") { "Docker isn't running. Start it to see what's inside.".to_string() } else { e }
}

fn df(home: &Path, kind: &str) -> Result<Value, String> {
    let sock = socket(home).ok_or("Docker isn't installed or has never run")?;
    get_json(&sock, &format!("/system/df?type={kind}")).map_err(|e| not_running(e.to_string()))
}

/// Images, containers and the build cache, largest first, asked for at the same time.
pub fn report(home: &Path) -> Result<Report, String> {
    let (images_v, containers_v, cache_v) = std::thread::scope(|s| {
        let i = s.spawn(|| df(home, "image"));
        let c = s.spawn(|| df(home, "container"));
        let b = s.spawn(|| df(home, "build-cache"));
        (i.join().unwrap(), c.join().unwrap(), b.join().unwrap())
    });
    let mut images = images(&images_v?);
    let mut containers = containers(&containers_v?);
    // The build cache can fail while a build prunes it; the rest is still worth showing.
    let build_cache = cache_v.ok().as_ref().and_then(build_cache);
    for list in [&mut images, &mut containers] {
        list.sort_by_key(|i| std::cmp::Reverse(i.size));
    }
    Ok(Report { images, containers, build_cache })
}

/// Volumes with their sizes, largest first. Slow: Docker measures every volume.
pub fn volumes_report(home: &Path) -> Result<Vec<Item>, String> {
    let mut list = volumes(&df(home, "volume")?);
    list.sort_by_key(|i| std::cmp::Reverse(i.size));
    Ok(list)
}

/// Removes one item through the Docker API. Returns the bytes Docker reports it freed, if any.
pub fn remove(home: &Path, kind: Kind, id: &str) -> Result<Option<u64>, String> {
    let sock = socket(home).ok_or("Docker isn't running")?;
    // Ids come from Docker itself; still, keep them to the characters Docker uses.
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '.' | '-')) {
        return Err("Unexpected id".into());
    }
    let (method, path) = match kind {
        Kind::Image => ("DELETE", format!("/images/{id}")),
        Kind::Container => ("DELETE", format!("/containers/{id}")),
        Kind::Volume => ("DELETE", format!("/volumes/{id}")),
        Kind::BuildCache => ("POST", "/build/prune?all=1".to_string()),
    };
    let (status, body) = request(&sock, method, &path).map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if status >= 400 {
        return Err(value["message"].as_str().unwrap_or("Docker refused").to_string());
    }
    Ok(value["SpaceReclaimed"].as_u64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_images_and_marks_used_ones() {
        let v = json!({"Images": [
            {"Id": "sha256:aaaaaaaaaaaaaaaa", "RepoTags": ["postgres:16"], "Size": 400, "Created": 10, "Containers": 2},
            {"Id": "sha256:bbbbbbbbbbbbbbbb", "RepoTags": ["<none>:<none>"], "Size": 900, "Created": 20, "Containers": 0}
        ]});
        let list = images(&v);
        assert_eq!((list[0].name.as_str(), list[0].in_use, list[0].detail.as_str()), ("postgres:16", true, "used by 2 containers"));
        assert_eq!(list[1].name, "<untagged> bbbbbbbbbbbb");
        assert!(!list[1].in_use);
    }

    #[test]
    fn counts_a_containers_own_layer_and_locks_running_ones() {
        let v = json!({"Containers": [
            {"Id": "c1", "Names": ["/web-1"], "Image": "web", "State": "running", "Status": "Up 2 hours", "SizeRw": 5, "Created": 1,
             "Labels": {"com.docker.compose.project": "shop"}},
            {"Id": "c2", "Names": ["/old"], "Image": "web", "State": "exited", "Status": "Exited (0)", "SizeRw": 7, "Created": 1}
        ]});
        let list = containers(&v);
        assert_eq!((list[0].name.as_str(), list[0].in_use, list[0].project.as_deref()), ("web-1", true, Some("shop")));
        assert_eq!((list[1].size, list[1].in_use), (7, false));
    }

    #[test]
    fn reads_volume_sizes_and_attachment() {
        let v = json!({"Volumes": [
            {"Name": "shop_db", "CreatedAt": "2026-09-08T15:27:07Z", "Labels": {"com.docker.compose.project": "shop"}, "UsageData": {"RefCount": 0, "Size": 516}},
            {"Name": "5afeed182c138a0424e60f16a11e92eba9988f9fc9ecdc264fcd1c9fbb5e379a", "CreatedAt": "", "Labels": {"com.docker.volume.anonymous": ""}, "UsageData": {"RefCount": 1, "Size": -1}}
        ]});
        let list = volumes(&v);
        assert_eq!((list[0].size, list[0].in_use, list[0].detail.as_str()), (516, false, "not attached to a container"));
        assert_eq!(list[0].created, 1_788_881_227);
        assert_eq!(list[1].name, "anonymous 5afeed182c13");
        assert!(list[1].anonymous && !list[0].anonymous);
        assert_eq!((list[1].size, list[1].in_use), (0, true));
    }

    #[test]
    fn sums_the_build_cache_not_in_use() {
        let v = json!({"BuildCache": [
            {"Size": 10, "InUse": false, "LastUsedAt": "2026-10-21T14:30:04.023Z"},
            {"Size": 5, "InUse": true, "LastUsedAt": "2026-10-20T14:30:04Z"}
        ]});
        let cache = build_cache(&v).unwrap();
        assert_eq!((cache.size, cache.detail.as_str()), (10, "2 entries from docker build"));
        assert!(build_cache(&json!({"BuildCache": []})).is_none());
    }

    #[test]
    fn refuses_odd_ids() {
        let tmp = tempfile::tempdir().unwrap();
        // No socket in a temp home: fails before any request, as does a bad id with a socket.
        assert!(remove(tmp.path(), Kind::Image, "../../etc").is_err());
    }
}
