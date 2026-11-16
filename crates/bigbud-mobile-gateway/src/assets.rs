//! Serves the built mobile web app (`VITE_MOBILE_BASE=/mobile/`) from a fixed
//! directory. Paths are restricted to a conservative character set, resolved
//! with symlinks and required to stay under the canonical root. Files stream
//! through a fixed buffer, so memory stays bounded regardless of file size.

use std::io;
use std::path::{Path, PathBuf};

use bytes::Bytes;
use http_body_util::{BodyExt, StreamBody};
use hyper::body::Frame;
use hyper::header::{self, HeaderValue};
use hyper::{Response, StatusCode};
use tokio::io::AsyncReadExt;

use crate::body::{GatewayBody, empty, status_response};

const INDEX_FILE: &str = "index.html";
const STREAM_CHUNK: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetResolution {
    File { path: PathBuf, spa_fallback: bool },
    NotFound,
    Invalid,
}

fn is_safe_relative(relative: &str) -> bool {
    relative.len() <= 512
        && relative.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'/' | b'@' | b'~')
        })
        // Rejects `.`, `..` and hidden files such as `.env` in one rule.
        && relative.split('/').all(|segment| !segment.starts_with('.'))
}

/// Maps a request-relative path onto a file inside `root`.
pub fn resolve(root: &Path, relative: &str) -> AssetResolution {
    if !is_safe_relative(relative) {
        return AssetResolution::Invalid;
    }
    let Ok(canonical_root) = root.canonicalize() else {
        return AssetResolution::NotFound;
    };
    let last_segment = relative.rsplit('/').next().unwrap_or_default();
    // Extensionless paths are client-side routes such as `/mobile/pair/<id>`.
    let spa_route = relative.is_empty() || !last_segment.contains('.');
    let candidate = if spa_route {
        canonical_root.join(INDEX_FILE)
    } else {
        canonical_root.join(relative)
    };
    match candidate.canonicalize() {
        Ok(path) if path.starts_with(&canonical_root) && path.is_file() => AssetResolution::File {
            path,
            spa_fallback: spa_route,
        },
        Ok(_) => AssetResolution::Invalid,
        Err(_) => AssetResolution::NotFound,
    }
}

pub fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("webp") => "image/webp",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Only Vite's content-hashed output under the request-relative `assets/`
/// folder is immutable; everything else must revalidate after updates.
fn cache_control(relative: &str, spa_fallback: bool) -> &'static str {
    if spa_fallback || !relative.starts_with("assets/") {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    }
}

/// Builds the asset response. Files stream in fixed chunks, so memory per
/// response stays bounded regardless of file size.
pub async fn serve(
    root: Option<PathBuf>,
    relative: String,
    head_only: bool,
    max_bytes: u64,
) -> Response<GatewayBody> {
    let Some(root) = root else {
        return status_response(StatusCode::NOT_FOUND);
    };
    // Path canonicalisation touches the filesystem; keep it off the reactor.
    let lookup = {
        let relative = relative.clone();
        tokio::task::spawn_blocking(move || resolve(&root, &relative)).await
    };
    let (path, spa_fallback) = match lookup {
        Ok(AssetResolution::File { path, spa_fallback }) => (path, spa_fallback),
        Ok(AssetResolution::NotFound) => return status_response(StatusCode::NOT_FOUND),
        Ok(AssetResolution::Invalid) => return status_response(StatusCode::BAD_REQUEST),
        Err(_) => return status_response(StatusCode::INTERNAL_SERVER_ERROR),
    };
    let opened = match tokio::fs::File::open(&path).await {
        Ok(file) => file.metadata().await.map(|metadata| (file, metadata.len())),
        Err(error) => Err(error),
    };
    let Ok((file, length)) = opened else {
        return status_response(StatusCode::NOT_FOUND);
    };
    if length > max_bytes {
        return status_response(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let body = if head_only {
        empty()
    } else {
        stream_file(file, length)
    };
    let mut response = Response::new(body);
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type(&path)),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control(&relative, spa_fallback)),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

fn stream_file(file: tokio::fs::File, length: u64) -> GatewayBody {
    let chunks = futures_util::stream::unfold((file, length), |(mut file, remaining)| async move {
        if remaining == 0 {
            return None;
        }
        let mut buffer = vec![0_u8; STREAM_CHUNK];
        match file.read(&mut buffer).await {
            // The file shrank after metadata: end with an error, never a silent short body.
            Ok(0) => Some((
                Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
                (file, 0),
            )),
            Ok(read) => {
                buffer.truncate(read);
                let next = remaining.saturating_sub(u64::try_from(read).unwrap_or(u64::MAX));
                Some((Ok(Frame::data(Bytes::from(buffer))), (file, next)))
            }
            Err(error) => Some((Err(error), (file, 0))),
        }
    });
    StreamBody::new(chunks).boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "bigbud-mobile-gateway-assets-{}-{unique}",
            std::process::id()
        ));
        // Clear leftovers from an earlier aborted run with the same pid.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<html>").unwrap();
        std::fs::write(dir.join("assets/app-1.js"), "x").unwrap();
        dir
    }

    #[test]
    fn resolves_files_and_spa_routes_inside_root() {
        let root = fixture();
        assert!(matches!(
            resolve(&root, "assets/app-1.js"),
            AssetResolution::File {
                spa_fallback: false,
                ..
            }
        ));
        assert!(matches!(
            resolve(&root, "pair/abc"),
            AssetResolution::File {
                spa_fallback: true,
                ..
            }
        ));
        assert!(matches!(
            resolve(&root, ""),
            AssetResolution::File {
                spa_fallback: true,
                ..
            }
        ));
        assert_eq!(
            resolve(&root, "assets/missing.js"),
            AssetResolution::NotFound
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_traversal_hidden_files_and_odd_characters() {
        let root = fixture();
        for relative in [
            "../secret.txt",
            "assets/../../x.js",
            ".env",
            "a b.js",
            "a%2e.js",
            "x\\y.js",
        ] {
            assert_eq!(
                resolve(&root, relative),
                AssetResolution::Invalid,
                "{relative}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_escape_the_root() {
        let root = fixture();
        let outside = root.with_extension("outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("assets/leak.txt")).unwrap();
        assert_eq!(resolve(&root, "assets/leak.txt"), AssetResolution::Invalid);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_file(outside).unwrap();
    }

    #[test]
    fn caches_by_request_path_not_by_where_the_root_lives() {
        assert_eq!(cache_control("index.html", false), "no-cache");
        assert_eq!(cache_control("sw.js", false), "no-cache");
        assert_eq!(cache_control("pair/x", true), "no-cache");
        assert_eq!(
            cache_control("assets/app-1.js", false),
            "public, max-age=31536000, immutable"
        );
    }

    #[tokio::test]
    async fn serves_with_cache_headers_and_reports_missing_root() {
        let root = fixture();
        let script = serve(Some(root.clone()), "assets/app-1.js".into(), false, 1024).await;
        assert_eq!(script.status(), StatusCode::OK);
        assert!(
            script.headers()[header::CACHE_CONTROL]
                .to_str()
                .unwrap()
                .contains("immutable")
        );
        let body = script.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"x");

        let index = serve(Some(root.clone()), "pair/x".into(), true, 1024).await;
        assert_eq!(index.headers()[header::CACHE_CONTROL], "no-cache");
        assert!(
            index
                .into_body()
                .collect()
                .await
                .unwrap()
                .to_bytes()
                .is_empty()
        );

        let too_big = serve(Some(root.clone()), "assets/app-1.js".into(), false, 0).await;
        assert_eq!(too_big.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            serve(None, String::new(), false, 1024).await.status(),
            StatusCode::NOT_FOUND
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
