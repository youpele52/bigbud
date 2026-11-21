//! The query responder answers exactly the queries the host owns (plan §8.9, F8).

use std::sync::Mutex;

use super::{ReplySink, Responder, parse_color};
use crate::terminal_screen::{DetectedQuery, ReplyContext};

#[derive(Default)]
struct Replies(Mutex<Vec<Vec<u8>>>);

impl ReplySink for Replies {
    fn write_reply(&self, bytes: &[u8]) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(bytes.to_vec());
    }
}

impl Replies {
    fn count(&self) -> usize {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

const DSR: DetectedQuery = DetectedQuery::DeviceStatus;

#[test]
fn an_attached_renderer_answers_everything_and_the_host_stays_silent() {
    let replies = Replies::default();
    let mut responder = Responder::default();
    responder.observe(&replies, 1, &[DSR, DetectedQuery::PrimaryDeviceAttributes]);
    assert_eq!(replies.count(), 0);
}

#[test]
fn detached_host_answers_only_queries_after_the_acknowledged_sequence() {
    let replies = Replies::default();
    let mut responder = Responder::default();
    // Applied while attached: sequences 3 and 5. The view parsed through 4.
    responder.observe(&replies, 3, &[DSR]);
    responder.observe(&replies, 5, &[DSR]);
    responder.detach(&replies, 4);
    // Only sequence 5 belonged to nobody yet (F8: already applied after `acked`).
    assert_eq!(replies.count(), 1);
    responder.observe(&replies, 6, &[DSR]);
    assert_eq!(replies.count(), 2);
    // A repeated detach push never answers the same query twice.
    responder.detach(&replies, 4);
    assert_eq!(replies.count(), 2);
}

#[test]
fn snapshot_attach_cuts_at_through_sequence_without_losing_or_duplicating() {
    let replies = Replies::default();
    let mut responder = Responder::default();
    responder.detach(&replies, 0);
    responder.observe(&replies, 1, &[DSR]);
    assert_eq!(replies.count(), 1);
    responder.begin_attach();
    // While the fence is pending, nothing is answered yet.
    responder.observe(&replies, 2, &[DSR]);
    responder.observe(&replies, 3, &[DSR]);
    assert_eq!(replies.count(), 1);
    // The snapshot covers through 2: the host answers 2, the view answers 3.
    responder.finish_attach(&replies, Some(2));
    assert_eq!(replies.count(), 2);
    responder.observe(&replies, 4, &[DSR]);
    assert_eq!(replies.count(), 2, "after the cut the view answers");
}

#[test]
fn a_failed_attach_fence_keeps_the_host_answering() {
    let replies = Replies::default();
    let mut responder = Responder::default();
    responder.detach(&replies, 0);
    responder.begin_attach();
    responder.observe(&replies, 1, &[DSR]);
    responder.finish_attach(&replies, None);
    assert_eq!(replies.count(), 1);
    responder.observe(&replies, 2, &[DSR]);
    assert_eq!(replies.count(), 2);
}

#[test]
fn colour_queries_need_a_pushed_theme_and_stop_after_close() {
    let replies = Replies::default();
    let mut responder = Responder::default();
    responder.detach(&replies, 0);
    responder.observe(&replies, 1, &[DetectedQuery::BackgroundColor]);
    assert_eq!(replies.count(), 0, "no theme, no answer");
    responder.set_theme(ReplyContext {
        foreground: parse_color("#ffffff"),
        background: parse_color("#1e1e1e"),
    });
    responder.observe(&replies, 2, &[DetectedQuery::BackgroundColor]);
    assert_eq!(
        replies
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last()
            .cloned(),
        Some(b"\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\".to_vec())
    );
    responder.stop();
    responder.observe(&replies, 3, &[DSR]);
    assert_eq!(replies.count(), 1);
}

#[test]
fn theme_colours_parse_hex_and_xterm_forms() {
    assert_eq!(parse_color("#fff"), Some([255, 255, 255]));
    assert_eq!(parse_color("#102030"), Some([0x10, 0x20, 0x30]));
    assert_eq!(parse_color("rgb:ffff/8080/0"), Some([255, 128, 0]));
    assert_eq!(parse_color(""), None);
    assert_eq!(parse_color("#12"), None);
    assert_eq!(parse_color("red"), None);
    assert_eq!(parse_color("rgb:1/2"), None);
}
